// GoldSrc movers and map logic: func_door (sliding), func_door_rotating, func_button and
// func_rot_button, func_plat (a lift), func_train (along path_corners), momentary_door
// driven by momentary_rot_button (HL SDK doors.cpp / buttons.cpp / plats.cpp semantics),
// plus the entity I/O that drives them: trigger_multiple, trigger_once, trigger_relay,
// multi_manager, trigger_auto, multisource (a `master` that locks movers and triggers)
// and `killtarget` (removes the named entities).
//
// A mover's motion is a pure function of its replicated state (`from` position 0..1 at
// tick `t0`, moving `dir` -1 / 0 / +1, swing `sign` for rotating doors (the return rate
// for a wheel), the train's `leg` and a momentary door's `goal`), so the client places
// movers for any tick exactly like the server (prediction stays bit-exact); the decisions
// (touch, use, triggers, timers, blocking) are made by whoever runs the game (the server;
// the sandbox for itself). Each mover gets a world vertex slot after the breakables'
// (shared/breakables.js), so the client draws it moved and turned within the single world
// draw call; a killtargeted one is hidden through the same mask as a broken breakable.

import { TICK_RATE } from './constants.js';
import { CONTENTS_EMPTY, entityModelIndex, parseVec3 } from './bsp.js';
import { ENT_NONE, ENT_SOLID, HULL_STAND, HULL_DUCK, rotationFromAngles, entityContents, hullFits } from './trace.js';
import { PS_ORIGIN, PS_FLAGS, PS_GROUNDENT, FL_DUCKING } from './pmove.js';

export const MAX_MOVERS = 64;

export const MOVER_DOOR = 0;
export const MOVER_ROTATING = 1; // func_door_rotating
export const MOVER_BUTTON = 2; // func_button, func_rot_button (turns)
export const MOVER_TRAIN = 3;
export const MOVER_PLAT = 4;
export const MOVER_MOMENTARY = 5; // momentary_door: moves to the fraction its wheel is at
export const MOVER_WHEEL = 6; // momentary_rot_button: turns while +use is held

// func_door / func_door_rotating spawnflags (HL SDK doors.h).
const SF_DOOR_START_OPEN = 1;
const SF_DOOR_ROTATE_BACKWARDS = 2;
const SF_DOOR_PASSABLE = 8;
const SF_DOOR_ONEWAY = 16;
const SF_DOOR_NO_AUTO_RETURN = 32;
const SF_DOOR_ROTATE_Z = 64;
const SF_DOOR_ROTATE_X = 128;
const SF_DOOR_USE_ONLY = 256;
// func_button spawnflags.
const SF_BUTTON_DONTMOVE = 1;
const SF_BUTTON_TOGGLE = 32;
const SF_BUTTON_TOUCH_ONLY = 256;
const SF_ROTBUTTON_NOTSOLID = 1;
// func_train spawnflags.
const SF_TRAIN_PASSABLE = 8;
// func_plat spawnflags.
const SF_PLAT_TOGGLE = 1;
// momentary_rot_button spawnflags.
const SF_WHEEL_NOTSOLID = 1;
const SF_WHEEL_AUTO_RETURN = 16;
// path_corner spawnflags (the HL SDK's trains.h; 2 was read as fire once before).
const SF_CORNER_WAITFORTRIG = 1; // the train waits here until triggered (as wait -1)
const SF_CORNER_TELEPORT = 2; // the train gets here at once (the leg into it takes a tick)
const SF_CORNER_FIREONCE = 4;
// trigger_* spawnflags.
const SF_TRIGGER_NOCLIENTS = 2;

const USE_RADIUS = 64; // PLAYER_SEARCH_RADIUS
const USE_DOT = 0.7; // VIEW_FIELD_NARROW
const PLAT_RETURN = 3; // seconds a lift waits at the top (CFuncPlat::HitTop)
const PLAT_TOUCHED = 1; // seconds after someone touched its column at the top

export const BLAST = { armorRatio: 1, flinchLarge: 0, flinchSmall: 0 }; // crush and explosion damage

const CLASS = {
  func_door: MOVER_DOOR, func_door_rotating: MOVER_ROTATING, func_button: MOVER_BUTTON, func_rot_button: MOVER_BUTTON,
  func_train: MOVER_TRAIN, func_plat: MOVER_PLAT, momentary_door: MOVER_MOMENTARY, momentary_rot_button: MOVER_WHEEL,
};
const TURNS = new Set(['func_door_rotating', 'func_rot_button', 'momentary_rot_button']);

// GoldSrc SetMovedir: the "angles" (or "angle") key as a direction; -1 up, -2 down.
function moveDir(e) {
  const a = new Float64Array(3);
  if (e.angles) parseVec3(e.angles, a);
  else if (e.angle) a[1] = +e.angle;
  if (a[0] === 0 && a[1] === -1 && a[2] === 0) return [0, 0, 1];
  if (a[0] === 0 && a[1] === -2 && a[2] === 0) return [0, 0, -1];
  const p = a[0] * Math.PI / 180, y = a[1] * Math.PI / 180;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

const ticksOf = (seconds) => Math.max(1, Math.round(seconds * TICK_RATE));

// bsp.entities indices of the movers, in mover order (world vertex slot = slotBase + 1 +
// position): every mover class above with a brush model.
export function moverEntities(bsp, slotBase) {
  const out = [];
  bsp.entities.forEach((e, bi) => {
    if (CLASS[e.classname] !== undefined && entityModelIndex(e) > 0 && out.length < MAX_MOVERS &&
      slotBase + out.length < 255) out.push(bi);
  });
  return out;
}

// bsp.entities indices of the other brush entities something killtargets (func_wall and
// the like): they get slots after the movers' (slotBase + 1 + position), so a
// killtarget can hide them.
export function killableEntities(bsp, slotBase) {
  const names = new Set();
  for (const e of bsp.entities) if (e.killtarget) names.add(e.killtarget);
  const out = [];
  if (!names.size) return out;
  const movers = new Set(moverEntities(bsp, 0));
  bsp.entities.forEach((e, bi) => {
    if (e.targetname && names.has(e.targetname) && entityModelIndex(e) > 0 && e.classname !== 'func_breakable' &&
      !movers.has(bi) && !e.classname.startsWith('trigger_') && slotBase + out.length < 255) out.push(bi);
  });
  return out;
}

// The brush entities a killtarget can remove that are neither movers nor breakables.
export class Killables {
  constructor(bsp, world, slotBase) {
    const list = killableEntities(bsp, slotBase);
    const entOfBsp = new Map();
    world.ents.forEach((e, i) => entOfBsp.set(e.bspEntity, i));
    this.count = list.length;
    this.slotBase = slotBase;
    this.bspEntity = Int32Array.from(list);
    this.ent = Int32Array.from(list, (bi) => entOfBsp.get(bi) ?? -1);
    this.kind = Int8Array.from(list, (bi) => (entOfBsp.has(bi) ? world.ents[entOfBsp.get(bi)].kind : ENT_NONE));
    this.name = list.map((bi) => bsp.entities[bi].targetname || '');
    this.dead = new Uint8Array(this.count);
    for (let k = 0; k < this.count; k++) if (this.ent[k] >= 0) world.ents[this.ent[k]].slot = slotBase + 1 + k;
  }

  slot(k) {
    return this.slotBase + 1 + k;
  }

  // Removes (or restores) killable k. Returns true if it changed.
  setDead(world, k, dead) {
    if ((this.dead[k] !== 0) === dead) return false;
    this.dead[k] = dead ? 1 : 0;
    if (this.ent[k] >= 0) world.ents[this.ent[k]].kind = dead ? ENT_NONE : this.kind[k];
    return true;
  }

  reset(world) {
    for (let k = 0; k < this.count; k++) this.setDead(world, k, false);
  }
}

export class Doors {
  // slotBase: world vertex slots below it belong to breakables.
  constructor(bsp, world, slotBase = 0) {
    const entOfBsp = new Map();
    world.ents.forEach((e, i) => entOfBsp.set(e.bspEntity, i));
    const list = moverEntities(bsp, slotBase); // every one is a collision entity (CollisionWorld.fromBSP)
    const n = this.count = list.length;
    this.slotBase = slotBase;
    this.bspEntity = Int32Array.from(list);
    this.kind = new Uint8Array(n);
    this.turns = new Uint8Array(n); // rotates about an axis (else slides)
    this.flags = new Int32Array(n);
    this.ent = new Int32Array(n); // collision entity
    this.solidKind = new Uint8Array(n); // the collision kind while alive (ENT_NONE: passable)
    this.rate = new Float64Array(n); // position change per tick (0..1 over the travel)
    this.returnRate = new Float64Array(n); // wheels: the rate back to 0 when let go (0: holds)
    this.travel = new Float64Array(n); // units, or degrees for turning movers (0: never moves)
    this.wait = new Float64Array(n); // seconds at the top before returning, -1 = stays
    this.dmg = new Float64Array(n); // damage to whoever blocks it
    this.base = new Float64Array(n * 3); // spawn origin (the hinge of a rotating door)
    this.off0 = new Float64Array(n * 3); // sliding: offset from the spawn origin at 0 and 1
    this.off1 = new Float64Array(n * 3);
    this.axis = new Uint8Array(n); // turning: angle turned (0 pitch, 1 yaw, 2 roll)
    this.ang = new Float64Array(n * 3); // turning: angles at 0, and added at 1 (before sign)
    this.ang0 = new Float64Array(n);
    this.ang1 = new Float64Array(n);
    this.name = []; // targetname ('' = none)
    this.target = [];
    this.kill = []; // killtarget
    this.master = []; // a multisource that must be on
    this.mins = new Float64Array(n * 3); // world bounds at spawn (use search)
    this.maxs = new Float64Array(n * 3);
    this.path = new Array(n).fill(null); // trains: { pos, next, wait, message, once, rate }
    this.center = new Float64Array(n * 3); // trains: the model's center at spawn (it rides the corners)
    this.byName = new Map(); // targetname -> [k]
    this.masters = null; // MapLogic's multisources (name -> { on })
    // Replicated state.
    this.from = new Float32Array(n);
    this.dir = new Int8Array(n);
    this.sign = new Int8Array(n).fill(1);
    this.t0 = new Int32Array(n);
    this.leg = new Uint8Array(n); // trains: the corner the leg starts at
    this.goal = new Float32Array(n); // momentary doors: the position moved toward
    // Game state (whoever runs the logic).
    this.next = new Int32Array(n); // tick of the scheduled return, 0 = none
    this.activator = new Array(n).fill(null); // who started it ({ x, y, z, yaw }), for its targets
    this.stopped = new Uint8Array(n); // trains: waiting for a trigger
    this.held = new Int32Array(n).fill(-1); // wheels: the last tick someone held +use on it
    this.pressDir = new Int8Array(n).fill(-1); // wheels: flipped at each new press (HL m_direction)
    this.sent = new Float32Array(n); // wheels: the last value pushed to its doors
    this.dead = new Uint8Array(n); // killtargeted: gone until the round restarts
    this.fired = new Set(); // "fire once" corner messages already fired
    // Applied transforms.
    this.applied = new Float64Array(n).fill(NaN); // position the collision entity is at
    this.rot = []; // per mover: Float64Array(9), for turning movers
    this.matrix = new Float32Array(MAX_MOVERS * 12); // 3x4 rows per mover, for the world shader

    const corners = new Map(); // path_corner targetname -> entity
    for (const e of bsp.entities) if (e.classname === 'path_corner' && e.targetname) corners.set(e.targetname, e);

    list.forEach((bi, k) => {
      const e = bsp.entities[bi], ce = world.ents[entOfBsp.get(bi)];
      const kind = this.kind[k] = CLASS[e.classname];
      const turns = this.turns[k] = TURNS.has(e.classname) ? 1 : 0;
      const flags = this.flags[k] = +(e.spawnflags || 0);
      this.ent[k] = entOfBsp.get(bi);
      ce.slot = slotBase + 1 + k;
      const passable = (kind === MOVER_DOOR || kind === MOVER_ROTATING || kind === MOVER_MOMENTARY) && (flags & SF_DOOR_PASSABLE) ||
        kind === MOVER_TRAIN && (flags & SF_TRAIN_PASSABLE) ||
        kind === MOVER_BUTTON && turns && (flags & SF_ROTBUTTON_NOTSOLID) ||
        kind === MOVER_WHEEL && (flags & SF_WHEEL_NOTSOLID);
      this.solidKind[k] = passable ? ENT_NONE : ENT_SOLID;
      if (passable) ce.kind = ENT_NONE;
      this.name.push(e.targetname || '');
      this.target.push(e.target || '');
      this.kill.push(e.killtarget || '');
      this.master.push(e.master || '');
      if (e.targetname) {
        if (!this.byName.has(e.targetname)) this.byName.set(e.targetname, []);
        this.byName.get(e.targetname).push(k);
      }
      this.base.set([ce.ox, ce.oy, ce.oz], k * 3);
      for (let a = 0; a < 3; a++) {
        this.mins[k * 3 + a] = ce.mins[a] + this.base[k * 3 + a];
        this.maxs[k * 3 + a] = ce.maxs[a] + this.base[k * 3 + a];
        this.center[k * 3 + a] = (ce.mins[a] + ce.maxs[a]) / 2 + this.base[k * 3 + a];
      }
      let speed = +(e.speed || 0), wait = +(e.wait || 0), dist;
      this.dmg[k] = +(e.dmg || 0);
      if (turns) {
        speed = speed || (kind === MOVER_BUTTON ? 40 : 100);
        if (kind === MOVER_BUTTON) wait = wait || 1;
        const a = new Float64Array(3);
        if (e.angles) parseVec3(e.angles, a);
        this.ang.set(a, k * 3);
        const ax = this.axis[k] = flags & SF_DOOR_ROTATE_Z ? 2 : flags & SF_DOOR_ROTATE_X ? 0 : 1;
        const d = (flags & SF_DOOR_ROTATE_BACKWARDS ? -1 : 1) * +(e.distance || 0);
        // CRotDoor::Spawn: angle1 = angles, angle2 = angles + movedir * distance; start
        // open swaps them.
        const open = kind === MOVER_ROTATING && (flags & SF_DOOR_START_OPEN);
        this.ang0[k] = open ? a[ax] + d : a[ax];
        this.ang1[k] = open ? a[ax] : a[ax] + d;
        dist = Math.abs(d);
        this.rot.push(new Float64Array(9));
        if (kind === MOVER_WHEEL) this.returnRate[k] = dist > 0 ? +(e.returnspeed || 0) / dist / TICK_RATE : 0;
      } else if (kind === MOVER_TRAIN) {
        speed = speed || 100;
        if (!this.dmg[k]) this.dmg[k] = 2;
        this.path[k] = trainPath(e, corners, speed);
        if (!this.path[k].count) this.path[k].pos.set(this.center.subarray(k * 3, k * 3 + 3)); // no corners: stays put
        this.stopped[k] = e.targetname ? 1 : 0; // CFuncTrain::Activate: a named train waits
        dist = 1;
        this.rot.push(null);
      } else if (kind === MOVER_PLAT) {
        speed = speed || 150;
        const height = +(e.height || 0) || ce.maxs[2] - ce.mins[2] - 8;
        // CFuncPlat: position1 is the spawn origin (the top), position2 `height` below it.
        // A lift rests at the bottom and its column calls it; a toggle plat starts at the
        // top and its targets send it either way.
        const toggle = (flags & SF_PLAT_TOGGLE) !== 0;
        this.off0[k * 3 + 2] = toggle ? 0 : -height;
        this.off1[k * 3 + 2] = toggle ? -height : 0;
        dist = height;
        wait = wait || PLAT_RETURN;
        this.rot.push(null);
      } else {
        const md = moveDir(e);
        const lip = +(e.lip || 0);
        if (kind === MOVER_BUTTON) {
          speed = speed || 40;
          wait = wait || 1;
        } else {
          speed = speed || 100;
        }
        // m_vecPosition2 = position1 + movedir * (|movedir . (size - 2)| - lip)
        let travel = Math.abs(md[0] * (ce.maxs[0] - ce.mins[0] - 2)) + Math.abs(md[1] * (ce.maxs[1] - ce.mins[1] - 2)) +
          Math.abs(md[2] * (ce.maxs[2] - ce.mins[2] - 2)) - lip;
        if (kind === MOVER_BUTTON && (flags & SF_BUTTON_DONTMOVE)) travel = 0;
        const open = kind === MOVER_DOOR && (flags & SF_DOOR_START_OPEN);
        for (let a = 0; a < 3; a++) {
          this.off0[k * 3 + a] = open ? md[a] * travel : 0;
          this.off1[k * 3 + a] = open ? 0 : md[a] * travel;
        }
        dist = Math.abs(travel);
        this.rot.push(null);
      }
      this.travel[k] = dist;
      this.rate[k] = kind === MOVER_TRAIN ? 0 : dist > 0 ? speed / dist / TICK_RATE : 1;
      this.wait[k] = wait;
    });
    this.reset(world);
  }

  // Everything back at rest (round restart).
  reset(world) {
    this.from.fill(0);
    this.dir.fill(0);
    this.sign.fill(1);
    this.t0.fill(0);
    this.leg.fill(0);
    this.goal.fill(0);
    this.next.fill(0);
    this.held.fill(-1);
    this.pressDir.fill(-1);
    this.sent.fill(0);
    this.fired.clear();
    for (let k = 0; k < this.count; k++) {
      this.stopped[k] = this.kind[k] === MOVER_TRAIN && this.name[k] ? 1 : 0;
      this.setDead(world, k, false);
    }
    this.applied.fill(NaN);
    this.apply(world, 0);
  }

  // Removes (killtarget) or restores mover k: no collision, hidden by its slot (the
  // breakable mask). Returns true if it changed.
  setDead(world, k, dead) {
    if ((this.dead[k] !== 0) === dead) return false;
    this.dead[k] = dead ? 1 : 0;
    world.ents[this.ent[k]].kind = dead ? ENT_NONE : this.solidKind[k];
    return true;
  }

  // The rate mover k moves at now (a train's by its leg, a wheel's back at its return rate).
  rateOf(k) {
    if (this.kind[k] === MOVER_TRAIN) return this.path[k].rate[this.leg[k]];
    if (this.kind[k] === MOVER_WHEEL && this.sign[k] < 0) return this.returnRate[k];
    return this.rate[k];
  }

  // Position 0..1 of mover k at `tick`.
  frac(k, tick) {
    let f = this.from[k] + this.dir[k] * (tick - this.t0[k]) * this.rateOf(k);
    if (this.kind[k] === MOVER_MOMENTARY) {
      const g = this.goal[k];
      f = this.dir[k] > 0 ? Math.min(f, g) : this.dir[k] < 0 ? Math.max(f, g) : f;
    }
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  atBottom(k) {
    return this.from[k] === 0 && this.dir[k] === 0;
  }

  atTop(k) {
    return this.from[k] === 1 && this.dir[k] === 0;
  }

  // At rest where it spawned: the state the clients assume when a snapshot leaves it out.
  idle(k) {
    return this.atBottom(k) && this.leg[k] === 0 && this.goal[k] === 0;
  }

  // World vertex slot of mover k (byte 39 of the world mesh).
  slot(k) {
    return this.slotBase + 1 + k;
  }

  // Puts every mover's collision entity (and render matrix) where it is at `tick`.
  apply(world, tick) {
    for (let k = 0; k < this.count; k++) this.place(world, k, this.frac(k, tick));
  }

  // The sliding offset of mover k from its spawn origin at position f.
  offset(k, f, r) {
    const b = k * 3;
    if (this.kind[k] === MOVER_TRAIN) {
      const p = this.path[k], a = this.leg[k], c = p.next[a];
      const from = p.pos[a * 3 + r], to = c >= 0 ? p.pos[c * 3 + r] : from;
      return from + (to - from) * f - this.center[b + r];
    }
    return this.off0[b + r] + (this.off1[b + r] - this.off0[b + r]) * f;
  }

  place(world, k, f) {
    const key = this.kind[k] === MOVER_TRAIN ? f + this.leg[k] * 2 : f; // a leg's end is the next one's start
    if (this.applied[k] === key) return;
    this.applied[k] = key;
    const b = k * 3, m = this.matrix, o = k * 12;
    if (this.turns[k]) {
      const ax = this.axis[k], a = this.ang;
      const turn = this.ang0[k] + (this.ang1[k] * this.sign[k] - this.ang0[k]) * f;
      const R = rotationFromAngles(ax === 0 ? turn : a[b], ax === 1 ? turn : a[b + 1], ax === 2 ? turn : a[b + 2],
        this.rot[k]);
      const ox = this.base[b], oy = this.base[b + 1], oz = this.base[b + 2];
      const still = R[0] === 1 && R[4] === 1 && R[8] === 1;
      world.setTransform(this.ent[k], ox, oy, oz, still ? null : R);
      // world = origin + R (p - origin): rows of R, translation origin - R origin.
      for (let r = 0; r < 3; r++) {
        m[o + r * 4] = R[r];
        m[o + r * 4 + 1] = R[3 + r];
        m[o + r * 4 + 2] = R[6 + r];
        m[o + r * 4 + 3] = this.base[b + r] - (R[r] * ox + R[3 + r] * oy + R[6 + r] * oz);
      }
    } else {
      for (let r = 0; r < 3; r++) {
        m[o + r * 4] = r === 0 ? 1 : 0;
        m[o + r * 4 + 1] = r === 1 ? 1 : 0;
        m[o + r * 4 + 2] = r === 2 ? 1 : 0;
        m[o + r * 4 + 3] = this.offset(k, f, r);
      }
      world.setTransform(this.ent[k], this.base[b] + m[o + 3], this.base[b + 1] + m[o + 7], this.base[b + 2] + m[o + 11],
        null);
    }
  }

  // Sets mover k's replicated state (the client applying a snapshot). Returns true if
  // it changed.
  setState(k, from, dir, sign, t0, leg = 0, goal = 0) {
    if (this.from[k] === from && this.dir[k] === dir && this.sign[k] === sign && this.t0[k] === t0 &&
      this.leg[k] === leg && this.goal[k] === goal) return false;
    this.from[k] = from;
    this.dir[k] = dir;
    this.sign[k] = sign;
    this.t0[k] = t0;
    this.leg[k] = leg;
    this.goal[k] = goal;
    this.applied[k] = NaN;
    return true;
  }

  // --- Game logic (server, sandbox) -------------------------------------------------

  // One tick: arrivals and timed returns (firing targets through `fire(name, act,
  // killtarget, source)`), wheels let go, lifts called by their columns, then every
  // moving mover moves, pushing `bodies` (PlayerStates of living players) out of its way
  // or riding on it; a mover that cannot push someone is blocked (doors with a wait go
  // back, as in GoldSrc) and hurts him by its dmg (`hurt(bodyIndex, damage)`). Leaves
  // every mover placed for `tick`.
  update(world, tick, bodies, fire, hurt = null) {
    for (let k = 0; k < this.count; k++) {
      if (this.dead[k]) continue;
      const kind = this.kind[k], f = this.frac(k, tick);
      if (kind === MOVER_TRAIN && !this.stopped[k] && this.dir[k] === 0 && !this.next[k]) this.trainGo(k, tick); // sets off
      if (kind === MOVER_WHEEL) this.wheelTick(k, tick, f);
      else if (kind === MOVER_MOMENTARY) {
        if ((this.dir[k] > 0 && f >= this.goal[k]) || (this.dir[k] < 0 && f <= this.goal[k])) {
          this.from[k] = f;
          this.dir[k] = 0;
          this.t0[k] = tick;
        }
      } else if (this.dir[k] > 0 && f >= 1) this.hitTop(k, tick, fire);
      else if (this.dir[k] < 0 && f <= 0) this.hitBottom(k, tick, fire);
      else if (this.next[k] && tick >= this.next[k]) {
        this.next[k] = 0;
        if (kind === MOVER_TRAIN) this.trainGo(k, tick);
        else if (this.atTop(k)) this.goDown(k, tick);
      }
      if (kind === MOVER_PLAT && !(this.flags[k] & SF_PLAT_TOGGLE)) this.platColumn(k, tick, bodies);
      this.move(world, k, tick, bodies, hurt);
    }
  }

  move(world, k, tick, bodies, hurt) {
    const before = this.applied[k], f = this.frac(k, tick);
    const key = this.kind[k] === MOVER_TRAIN ? f + this.leg[k] * 2 : f;
    if (before === key || before !== before) {
      this.place(world, k, f);
      return;
    }
    const e = world.ents[this.ent[k]], ent = this.ent[k];
    const ox = e.ox, oy = e.oy, oz = e.oz;
    let R0 = null;
    if (e.rot) {
      oldRot.set(e.rot);
      R0 = oldRot;
    }
    this.place(world, k, f);
    if (e.kind === ENT_NONE) return; // passable
    const R1 = e.rot;
    let pushed = 0;
    for (let bi = 0; bi < bodies.length; bi++) {
      const ps = bodies[bi];
      const p = ps.f, hull = ps.i[PS_FLAGS] & FL_DUCKING ? HULL_DUCK : HULL_STAND;
      const x = p[PS_ORIGIN], y = p[PS_ORIGIN + 1], z = p[PS_ORIGIN + 2];
      const riding = ps.i[PS_GROUNDENT] === ent;
      if (!riding && entityContents(world, ent, hull, x, y, z) === CONTENTS_EMPTY) continue;
      // Old model-space position, then the new world position (SV_PushMove / PushRotate).
      let lx = x - ox, ly = y - oy, lz = z - oz;
      if (R0) {
        const a = lx, b = ly, c = lz;
        lx = a * R0[0] + b * R0[1] + c * R0[2];
        ly = a * R0[3] + b * R0[4] + c * R0[5];
        lz = a * R0[6] + b * R0[7] + c * R0[8];
      }
      const nx = e.ox + (R1 ? R1[0] * lx + R1[3] * ly + R1[6] * lz : lx);
      const ny = e.oy + (R1 ? R1[1] * lx + R1[4] * ly + R1[7] * lz : ly);
      const nz = e.oz + (R1 ? R1[2] * lx + R1[5] * ly + R1[8] * lz : lz);
      pushBuf[pushed * 4] = x;
      pushBuf[pushed * 4 + 1] = y;
      pushBuf[pushed * 4 + 2] = z;
      pushPs[pushed++] = ps;
      p[PS_ORIGIN] = nx;
      p[PS_ORIGIN + 1] = ny;
      p[PS_ORIGIN + 2] = nz;
      if (!hullFits(world, hull, nx, ny, nz)) { // stuck: everything goes back, the mover is blocked
        for (let i = 0; i < pushed; i++) {
          const q = pushPs[i].f;
          q[PS_ORIGIN] = pushBuf[i * 4];
          q[PS_ORIGIN + 1] = pushBuf[i * 4 + 1];
          q[PS_ORIGIN + 2] = pushBuf[i * 4 + 2];
        }
        this.blocked(world, k, tick, before);
        if (hurt && this.dmg[k] > 0) hurt(bi, this.dmg[k]);
        return;
      }
      if (pushed === MAX_PUSHED) break;
    }
  }

  // CBaseDoor::Blocked: doors that return go the other way; the others wait where they
  // are (the next tick tries again).
  blocked(world, k, tick, applied) {
    const kind = this.kind[k];
    const f = kind === MOVER_TRAIN ? applied - this.leg[k] * 2 : applied;
    this.from[k] = f;
    this.t0[k] = tick;
    if ((kind === MOVER_DOOR || kind === MOVER_ROTATING || kind === MOVER_PLAT) && this.wait[k] >= 0) this.dir[k] = -this.dir[k];
    this.place(world, k, this.frac(k, tick));
  }

  hitTop(k, tick, fire) {
    this.from[k] = 1;
    this.dir[k] = 0;
    this.t0[k] = tick;
    this.next[k] = 0;
    const kind = this.kind[k], wait = this.wait[k];
    if (kind === MOVER_TRAIN) {
      this.trainArrive(k, tick, fire);
      return;
    }
    if (kind === MOVER_BUTTON) {
      // TriggerAndWait: fire, then come back unless the button stays pushed.
      if (wait !== -1 && !(this.flags[k] & SF_BUTTON_TOGGLE)) this.next[k] = tick + ticksOf(wait);
    } else if (kind === MOVER_PLAT) {
      if (!(this.flags[k] & SF_PLAT_TOGGLE)) this.next[k] = tick + ticksOf(wait);
    } else if (!(this.flags[k] & SF_DOOR_NO_AUTO_RETURN) && wait >= 0) {
      this.next[k] = tick + ticksOf(wait);
    }
    if (this.target[k] || this.kill[k]) fire(this.target[k], this.activator[k], this.kill[k], this.bspEntity[k]);
  }

  hitBottom(k, tick, fire) {
    this.from[k] = 0;
    this.dir[k] = 0;
    this.t0[k] = tick;
    this.next[k] = 0;
    const kind = this.kind[k];
    if ((kind === MOVER_DOOR || kind === MOVER_ROTATING) && (this.target[k] || this.kill[k])) {
      fire(this.target[k], this.activator[k], this.kill[k], this.bspEntity[k]);
    }
  }

  // DoorGoUp: a rotating door turning about z opens away from the activator (unless
  // one-way); a door already swinging one way keeps its side.
  goUp(k, tick, act) {
    const f = this.frac(k, tick);
    if (this.kind[k] === MOVER_ROTATING && f === 0) {
      let sign = 1;
      if (act && !(this.flags[k] & SF_DOOR_ONEWAY) && this.axis[k] === 1) {
        const vx = act.x - this.base[k * 3], vy = act.y - this.base[k * 3 + 1];
        const yr = act.yaw * Math.PI / 180;
        if (vx * Math.sin(yr) - vy * Math.cos(yr) < 0) sign = -1;
      }
      this.sign[k] = sign;
    }
    this.from[k] = f;
    this.dir[k] = 1;
    this.t0[k] = tick;
    this.next[k] = 0;
    this.activator[k] = act;
  }

  goDown(k, tick) {
    this.from[k] = this.frac(k, tick);
    this.dir[k] = -1;
    this.t0[k] = tick;
    this.next[k] = 0;
  }

  // DoorActivate (from a touch or a use): toggle doors close from the top, else open.
  activate(k, tick, act) {
    if (this.toggles(k) && this.atTop(k)) this.goDown(k, tick);
    else this.goUp(k, tick, act);
  }

  // Doors that stay where they are sent (no auto return), toggle plats.
  toggles(k) {
    const kind = this.kind[k];
    if (kind === MOVER_PLAT) return (this.flags[k] & SF_PLAT_TOGGLE) !== 0;
    return kind !== MOVER_BUTTON && (this.flags[k] & SF_DOOR_NO_AUTO_RETURN) !== 0;
  }

  // Its master (a multisource) is off: nothing moves it (IsLockedByMaster).
  locked(k) {
    const m = this.master[k];
    if (!m || !this.masters) return false;
    const ms = this.masters.get(m);
    return ms !== undefined && !ms.on;
  }

  // Someone used mover k (a player's +use, or a target fired by the map). `value`: a
  // momentary door's position (its wheel sends it).
  use(k, tick, act, value = 1) {
    if (this.dead[k] || this.locked(k)) return;
    const kind = this.kind[k];
    if (kind === MOVER_BUTTON) {
      if (this.dir[k] !== 0) return;
      if (this.atTop(k)) {
        if (this.flags[k] & SF_BUTTON_TOGGLE) this.goDown(k, tick);
        return;
      }
      this.goUp(k, tick, act);
      return;
    }
    if (kind === MOVER_TRAIN) {
      // CFuncTrain::Use: a stopped train goes on, a moving one stops where it is.
      if (this.stopped[k]) {
        this.stopped[k] = 0;
        this.trainGo(k, tick);
      } else {
        this.stopped[k] = 1;
        this.from[k] = this.frac(k, tick);
        this.dir[k] = 0;
        this.t0[k] = tick;
        this.next[k] = 0;
      }
      return;
    }
    if (kind === MOVER_MOMENTARY) {
      this.moveTo(k, tick, value);
      return;
    }
    if (kind === MOVER_WHEEL) {
      this.hold(k, tick);
      return;
    }
    if (kind === MOVER_PLAT && !(this.flags[k] & SF_PLAT_TOGGLE)) { // PlatUse: a lift sent down from the top
      if (this.atTop(k)) this.goDown(k, tick);
      return;
    }
    if (this.atBottom(k) || (this.toggles(k) && this.atTop(k))) this.activate(k, tick, act);
  }

  // A player ran into mover k (DoorTouch): doors without a name open, named ones are
  // locked (a button or trigger opens them); touch-only buttons press.
  touch(k, tick, act) {
    if (this.dead[k] || this.locked(k)) return;
    const kind = this.kind[k];
    if (kind === MOVER_BUTTON) {
      if ((this.flags[k] & SF_BUTTON_TOUCH_ONLY) && this.atBottom(k)) this.goUp(k, tick, act);
      return;
    }
    if (kind !== MOVER_DOOR && kind !== MOVER_ROTATING) return;
    if ((this.flags[k] & SF_DOOR_USE_ONLY) || this.name[k]) return;
    if (this.atBottom(k) || (this.toggles(k) && this.atTop(k))) this.activate(k, tick, act);
  }

  // --- Lifts, trains, wheels ------------------------------------------------------------

  // CPlatTrigger: the column a lift rises through (its bounds at the bottom, 8 up) calls
  // it up when someone stands in it, and holds a lift at the top down for a second more
  // (PLAT_TOUCHED) while someone is in the column.
  platColumn(k, tick, bodies) {
    const b = k * 3, h = this.travel[k];
    const z0 = this.maxs[b + 2] - 2 * h, z1 = this.maxs[b + 2] - h + 8;
    const bottom = this.atBottom(k), top = this.atTop(k);
    if ((!bottom && !top) || this.locked(k)) return;
    for (const ps of bodies) {
      const p = ps.f, feet = p[PS_ORIGIN + 2] - (ps.i[PS_FLAGS] & FL_DUCKING ? 18 : 36);
      if (p[PS_ORIGIN] + 16 <= this.mins[b] || p[PS_ORIGIN] - 16 >= this.maxs[b] || p[PS_ORIGIN + 1] + 16 <= this.mins[b + 1] ||
        p[PS_ORIGIN + 1] - 16 >= this.maxs[b + 1] || feet < z0 || feet > z1) continue;
      if (bottom) this.goUp(k, tick, null);
      else this.next[k] = Math.max(this.next[k], tick + ticksOf(PLAT_TOUCHED));
      return;
    }
  }

  // A train sets off along its leg (Next): from where it is toward the leg's end corner.
  trainGo(k, tick) {
    const p = this.path[k];
    if (p.next[this.leg[k]] < 0) { // the path ends here
      this.stopped[k] = 1;
      return;
    }
    this.from[k] = this.frac(k, tick);
    this.dir[k] = 1;
    this.t0[k] = tick;
    this.next[k] = 0;
  }

  // Arrived at the leg's end corner (Wait): the corner's message fires, the train waits
  // its `wait` (-1: until triggered), then goes on along the next leg.
  trainArrive(k, tick, fire) {
    const p = this.path[k], c = p.next[this.leg[k]];
    this.leg[k] = c;
    this.from[k] = 0;
    this.applied[k] = NaN; // the same place, keyed by the new leg
    if (p.message[c] && !this.fired.has(k * 256 + c)) {
      fire(p.message[c], this.activator[k], '', this.bspEntity[k]);
      if (p.once[c]) this.fired.add(k * 256 + c);
    }
    if (this.stopped[k] || p.next[c] < 0) {
      this.stopped[k] = 1;
      return;
    }
    if (p.wait[c] < 0) this.stopped[k] = 1;
    else if (p.wait[c] > 0) this.next[k] = tick + ticksOf(p.wait[c]);
    else this.trainGo(k, tick);
  }

  // A wheel being held this tick (CMomentaryRotButton::Use): a new press flips its
  // direction; it turns while held and stops at the ends.
  hold(k, tick) {
    if (this.held[k] < tick - 1) { // a new press
      this.pressDir[k] = -this.pressDir[k];
      const f = this.frac(k, tick);
      if ((this.pressDir[k] > 0 && f >= 1) || (this.pressDir[k] < 0 && f <= 0)) this.pressDir[k] = -this.pressDir[k];
    }
    this.held[k] = tick;
    const f = this.frac(k, tick);
    if ((this.pressDir[k] > 0 && f >= 1) || (this.pressDir[k] < 0 && f <= 0)) return; // at that end already
    if (this.dir[k] !== this.pressDir[k] || this.sign[k] < 0) {
      this.from[k] = f;
      this.dir[k] = this.pressDir[k];
      this.sign[k] = 1;
      this.t0[k] = tick;
    }
  }

  // Each tick: a wheel let go stops (or returns at its return speed with the auto return
  // flag), one at an end stops, and its position goes to its momentary doors (UpdateTarget).
  wheelTick(k, tick, f) {
    if (this.dir[k] !== 0) {
      const letGo = this.sign[k] > 0 && this.held[k] < tick - 1;
      const atEnd = (this.dir[k] > 0 && f >= 1) || (this.dir[k] < 0 && f <= 0);
      if (letGo || atEnd) {
        this.from[k] = f;
        this.dir[k] = 0;
        this.t0[k] = tick;
        this.sign[k] = 1;
        if (letGo && !atEnd && (this.flags[k] & SF_WHEEL_AUTO_RETURN) && this.returnRate[k] > 0 && f > 0) {
          this.dir[k] = -1;
          this.sign[k] = -1;
          this.pressDir[k] = -1;
        }
      }
    }
    const value = Math.fround(f);
    if (value !== this.sent[k] && this.target[k]) {
      this.sent[k] = value;
      const doors = this.byName.get(this.target[k]);
      if (doors) for (const d of doors) if (this.kind[d] === MOVER_MOMENTARY) this.moveTo(d, tick, value);
    }
  }

  // A momentary door sent to position `goal` at its speed (CMomentaryDoor::Use).
  moveTo(k, tick, goal) {
    const f = this.frac(k, tick);
    goal = Math.fround(goal < 0 ? 0 : goal > 1 ? 1 : goal);
    this.from[k] = f;
    this.t0[k] = tick;
    this.goal[k] = goal;
    this.dir[k] = goal > f ? 1 : goal < f ? -1 : 0;
  }

  // Mover behind collision entity `ent`, or -1.
  ofEnt(ent) {
    for (let k = 0; k < this.count; k++) if (this.ent[k] === ent) return k;
    return -1;
  }

  // Whether a player's +use can work mover k (use-only doors, buttons that are not
  // touch-only, wheels: their ObjectCaps).
  usable(k) {
    if (this.dead[k]) return false;
    const kind = this.kind[k];
    if (kind === MOVER_BUTTON) return !(this.flags[k] & SF_BUTTON_TOUCH_ONLY);
    if (kind === MOVER_WHEEL) return true;
    return (kind === MOVER_DOOR || kind === MOVER_ROTATING) && (this.flags[k] & SF_DOOR_USE_ONLY) !== 0;
  }

  // Held +use works mover k every tick (FCAP_CONTINUOUS_USE: wheels).
  continuous(k) {
    return this.kind[k] === MOVER_WHEEL;
  }

  // CBasePlayer::PlayerUse: the usable mover within 64 units of the player's origin
  // most in front of the view (its box clamped toward the eye), or -1.
  findUse(world, px, py, pz, ex, ey, ez, fx, fy, fz) {
    let best = -1, bestDot = USE_DOT;
    for (let k = 0; k < this.count; k++) {
      if (!this.usable(k)) continue;
      const e = world.ents[this.ent[k]];
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const v = a === 0 ? px : a === 1 ? py : pz;
        const lo = e.amin[a], hi = e.amax[a];
        const g = v < lo ? lo - v : v > hi ? v - hi : 0;
        d2 += g * g;
      }
      if (d2 > USE_RADIUS * USE_RADIUS) continue;
      let lx = (e.amin[0] + e.amax[0]) / 2 - ex, ly = (e.amin[1] + e.amax[1]) / 2 - ey, lz = (e.amin[2] + e.amax[2]) / 2 - ez;
      const hx = (e.amax[0] - e.amin[0]) / 2, hy = (e.amax[1] - e.amin[1]) / 2, hz = (e.amax[2] - e.amin[2]) / 2;
      lx = lx > hx ? lx - hx : lx < -hx ? lx + hx : 0;
      ly = ly > hy ? ly - hy : ly < -hy ? ly + hy : 0;
      lz = lz > hz ? lz - hz : lz < -hz ? lz + hz : 0;
      const len = Math.hypot(lx, ly, lz);
      const dot = len > 0 ? (lx * fx + ly * fy + lz * fz) / len : 0;
      if (dot > bestDot) {
        best = k;
        bestDot = dot;
      }
    }
    return best;
  }

  // Whether walking players open mover k: touch doors without a name, use-only doors,
  // and doors whose name a trigger fires (`named`: MapLogic.named), or, with `buttons`
  // (the names the usable buttons fire, `buttonTargets`), a button opens.
  opens(k, named, buttons = null) {
    const kind = this.kind[k];
    if ((kind !== MOVER_DOOR && kind !== MOVER_ROTATING) || this.travel[k] < 16) return false;
    if (this.flags[k] & SF_DOOR_USE_ONLY) return true;
    return this.name[k] ? named.has(this.name[k]) || (buttons !== null && buttons.has(this.name[k])) : true;
  }

  // The names fired by the buttons a player's +use works (func_button, func_rot_button).
  buttonTargets() {
    const out = new Set();
    for (let k = 0; k < this.count; k++) if (this.kind[k] === MOVER_BUTTON && this.usable(k) && this.target[k]) out.add(this.target[k]);
    return out;
  }

  // A usable button that fires `name`, or -1.
  buttonFor(name) {
    for (let k = 0; k < this.count; k++) if (this.kind[k] === MOVER_BUTTON && this.usable(k) && this.target[k] === name) return k;
    return -1;
  }

}

// A train's path: the chain of path_corners from its `target` (CFuncTrain::Activate puts
// the train's center on the first; each corner's `target` is the next, a loop or an end).
// rate[c]: position per tick along the leg out of corner c: a corner's own `speed`, else
// the train's (approx.: in GoldSrc a corner's speed lasts until another corner sets one,
// so a second lap could differ from the first; here every lap runs alike, so the clients
// need no history to place the train).
function trainPath(e, corners, speed) {
  const names = [], index = new Map();
  for (let name = e.target; name && corners.has(name) && !index.has(name) && names.length < 255; name = corners.get(name).target) {
    index.set(name, names.length);
    names.push(name);
  }
  const n = names.length;
  const pos = new Float64Array(Math.max(n, 1) * 3), next = new Int32Array(Math.max(n, 1)).fill(-1);
  const wait = new Float64Array(Math.max(n, 1)), rate = new Float64Array(Math.max(n, 1)), once = new Uint8Array(Math.max(n, 1));
  const message = [];
  const speeds = new Float64Array(Math.max(n, 1)), teleport = new Uint8Array(Math.max(n, 1));
  names.forEach((name, c) => {
    const pc = corners.get(name), flags = +(pc.spawnflags || 0);
    parseVec3(pc.origin || '', pos, c * 3);
    const nx = pc.target ? index.get(pc.target) : undefined;
    next[c] = nx === undefined ? -1 : nx;
    wait[c] = flags & SF_CORNER_WAITFORTRIG ? -1 : +(pc.wait || 0);
    speeds[c] = +(pc.speed || 0);
    once[c] = flags & SF_CORNER_FIREONCE ? 1 : 0;
    teleport[c] = flags & SF_CORNER_TELEPORT ? 1 : 0;
    message.push(pc.message || '');
  });
  for (let c = 0; c < n; c++) {
    const s = speeds[c] || speed;
    const d = next[c] >= 0 ? Math.hypot(pos[next[c] * 3] - pos[c * 3], pos[next[c] * 3 + 1] - pos[c * 3 + 1],
      pos[next[c] * 3 + 2] - pos[c * 3 + 2]) : 0;
    rate[c] = d > 0 && !teleport[next[c]] ? s / d / TICK_RATE : 1;
  }
  if (!n) message.push('');
  return { count: n, pos, next, wait, rate, once, message };
}

const MAX_PUSHED = 32;
// Entity I/O limits: names fired in one tick and delayed fires waiting. A map's logic can
// loop (a relay naming itself, a multi_manager firing itself twice with delays doubles
// the queue every tick): an uploaded map hung the whole server that way. Maps fire a few
// names a tick.
export const MAX_FIRES = 256;
export const MAX_QUEUED = 256;
const oldRot = new Float64Array(9); // a turning door's rotation before this tick's move
const pushBuf = new Float64Array(MAX_PUSHED * 4);
const pushPs = new Array(MAX_PUSHED);

// The map's entity I/O: triggers that fire names when players stand in them, relays and
// multi_managers that pass names on (after delays), trigger_auto at each round start,
// multisources that are on once every entity targeting them has fired (a `master` locks
// movers and triggers while off), killtargets that remove entities. Firing a name uses
// every mover with that targetname and breaks every breakable (through `onBreak(slot,
// act)`, the game's: it fires its target and sets off its explosion). Other entities are
// ignored.
export class MapLogic {
  constructor(bsp, doors, world = null, breakables = null, killables = null) {
    this.doors = doors;
    this.world = world;
    this.breakables = breakables;
    this.killables = killables;
    this.onBreak = null; // (slot, act) => ...
    this.triggers = []; // { mins, maxs, name, target, kill, master, delay, wait, once, next, done, src }
    this.relays = new Map(); // targetname -> [{ target, kill, delay, src }]
    this.autos = []; // { target, kill, delay, src }
    this.queue = []; // { tick, name, act, kill, src }
    this.fireTick = -1; // the tick `fires` counts for
    this.fires = 0;
    this.named = new Set(); // names something fires on its own (triggers players walk into, relays, autos)
    this.pressed = new Set(); // names only buttons and doors fire
    this.masters = new Map(); // multisource targetname -> { sources: [bsp entity], on: [bool], target, on }
    this.dead = new Set(); // bsp entity indices removed by a killtarget
    this.removed = new Uint32Array(8); // their world slots, as a mask like the breakables'
    this.breakableByName = new Map(); // targetname -> [slot]
    doors.masters = this.masters;
    const box = (e) => {
      const m = entityModelIndex(e);
      if (m <= 0) return null;
      const o = new Float64Array(3);
      if (e.origin) parseVec3(e.origin, o);
      const mf = bsp.modelsF;
      return {
        mins: [mf[m * 16] + o[0], mf[m * 16 + 1] + o[1], mf[m * 16 + 2] + o[2]],
        maxs: [mf[m * 16 + 3] + o[0], mf[m * 16 + 4] + o[1], mf[m * 16 + 5] + o[2]],
      };
    };
    const relay = (name, target, delay, kill, src) => {
      if (!name || (!target && !kill)) return;
      if (!this.relays.has(name)) this.relays.set(name, []);
      this.relays.get(name).push({ target, kill, delay, src });
      if (target) this.named.add(target);
    };
    bsp.entities.forEach((e, bi) => {
      const cls = e.classname, delay = +(e.delay || 0), kill = e.killtarget || '';
      if ((cls === 'trigger_multiple' || cls === 'trigger_once') && (e.target || kill) &&
        !(+(e.spawnflags || 0) & SF_TRIGGER_NOCLIENTS)) {
        const b = box(e);
        if (!b) return;
        this.triggers.push({ ...b, name: e.targetname || '', target: e.target || '', kill, master: e.master || '', delay,
          wait: +(e.wait || 0) || 0.2, once: cls === 'trigger_once', next: 0, done: false, src: bi });
        if (e.target) this.named.add(e.target);
      } else if (cls === 'trigger_relay') {
        relay(e.targetname, e.target || '', delay, kill, bi);
      } else if (cls === 'multi_manager') {
        for (const key of Object.keys(e)) {
          if (MM_KEYS.has(key)) continue;
          relay(e.targetname, key.replace(/#\d+$/, ''), +e[key] || 0, '', bi);
        }
      } else if (cls === 'trigger_auto' && (e.target || kill)) {
        this.autos.push({ target: e.target || '', kill, delay, src: bi });
        if (e.target) this.named.add(e.target);
      } else if (cls === 'multisource' && e.targetname) {
        this.masters.set(e.targetname, { sources: [], state: [], target: e.target || '', on: true });
      } else if ((cls === 'func_button' || cls === 'func_rot_button' || cls.startsWith('func_door')) && e.target) {
        this.pressed.add(e.target);
      }
    });
    // A multisource's inputs: every entity whose target is it (CMultiSource::Register).
    bsp.entities.forEach((e, bi) => {
      if (!e.target || !this.masters.has(e.target)) return;
      const ms = this.masters.get(e.target);
      ms.sources.push(bi);
      ms.state.push(false);
      ms.on = false;
    });
    if (breakables) {
      for (let s = 1; s <= breakables.count; s++) {
        const name = breakables.name[s];
        if (!name) continue;
        if (!this.breakableByName.has(name)) this.breakableByName.set(name, []);
        this.breakableByName.get(name).push(s);
      }
    }
  }

  // Round start: triggers rearm, multisources go off, the removed come back, trigger_auto
  // fires.
  reset(tick) {
    this.queue.length = 0;
    for (const t of this.triggers) {
      t.next = 0;
      t.done = false;
    }
    for (const ms of this.masters.values()) {
      ms.state.fill(false);
      ms.on = ms.sources.length === 0;
    }
    this.dead.clear();
    this.removed.fill(0);
    for (const a of this.autos) this.fireAt(tick, a.target, null, a.delay, a.src, a.kill);
  }

  // Fires `name` (every mover and breakable with that targetname, the relays passing it
  // on, a multisource's input) after `delay` seconds, from entity `src`, removing the
  // entities named `kill` first (SUB_UseTargets).
  // At most MAX_FIRES a tick and MAX_QUEUED waiting: past that, fires are dropped.
  fireAt(tick, name, act, delay, src = -1, kill = '') {
    if (tick !== this.fireTick) {
      this.fireTick = tick;
      this.fires = 0;
    }
    if (++this.fires > MAX_FIRES) return;
    if (delay > 0) {
      if (this.queue.length >= MAX_QUEUED) return;
      this.queue.push({ tick: tick + ticksOf(delay), name, act, kill, src });
      return;
    }
    if (kill) this.remove(kill);
    if (!name) return;
    const d = this.doors;
    for (let k = 0; k < d.count; k++) if (d.name[k] === name) d.use(k, tick, act);
    const slots = this.breakableByName.get(name);
    if (slots && this.onBreak) for (const s of slots) if (!this.breakables.broken[s]) this.onBreak(s, act);
    const r = this.relays.get(name);
    if (r) for (const q of r) if (!this.dead.has(q.src)) this.fireAt(tick, q.target, act, q.delay, q.src, q.kill);
    const ms = this.masters.get(name);
    if (ms && !ms.on) {
      const i = ms.sources.indexOf(src);
      if (i >= 0) {
        ms.state[i] = !ms.state[i];
        if (ms.state.every(Boolean)) {
          ms.on = true;
          if (ms.target) this.fireAt(tick, ms.target, act, 0, -1);
        }
      }
    }
  }

  // Whether the trigger's master lets it fire.
  unlocked(master) {
    if (!master) return true;
    const ms = this.masters.get(master);
    return ms === undefined || ms.on;
  }

  // killtarget: every entity named `name` is gone until the round restarts (UTIL_Remove).
  remove(name) {
    const d = this.doors;
    for (let k = 0; k < d.count; k++) {
      if (d.name[k] === name && !d.dead[k]) {
        d.setDead(this.world, k, true);
        this.mark(d.slot(k));
      }
    }
    const kb = this.killables;
    if (kb) {
      for (let k = 0; k < kb.count; k++) {
        if (kb.name[k] === name && !kb.dead[k]) {
          kb.setDead(this.world, k, true);
          this.mark(kb.slot(k));
        }
      }
    }
    const b = this.breakables, slots = this.breakableByName.get(name);
    if (b && slots) for (const s of slots) if (b.setBroken(this.world, s, true)) this.mark(s);
    for (const t of this.triggers) if (t.name === name) t.done = true;
    const relays = this.relays.get(name);
    if (relays) for (const q of relays) this.dead.add(q.src);
    const ms = this.masters.get(name);
    if (ms) ms.on = true; // no master left: nothing is locked (UTIL_IsMasterTriggered)
  }

  mark(slot) {
    this.removed[slot >> 5] |= 1 << (slot & 31);
  }

  // Delayed fires due by `tick`, then the triggers the players stand in. `players`:
  // [{ x, y, z, yaw }] of living players (hull centers).
  update(tick, players) {
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      if (q.tick > tick) continue;
      this.queue.splice(i--, 1);
      this.fireAt(tick, q.name, q.act, 0, q.src, q.kill);
    }
    for (const t of this.triggers) {
      if (t.done || tick < t.next || !this.unlocked(t.master)) continue;
      for (const p of players) {
        if (p.x + 16 <= t.mins[0] || p.x - 16 >= t.maxs[0] || p.y + 16 <= t.mins[1] || p.y - 16 >= t.maxs[1] ||
          p.z + 36 <= t.mins[2] || p.z - 36 >= t.maxs[2]) continue;
        this.fireAt(tick, t.target, p, t.delay, t.src, t.kill);
        if (t.once) t.done = true;
        else t.next = tick + ticksOf(t.wait);
        break;
      }
    }
  }
}

const MM_KEYS = new Set(['classname', 'targetname', 'origin', 'spawnflags', 'wait', 'delay', 'angles', 'target']);
