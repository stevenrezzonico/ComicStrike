// GoldSrc movers and map logic: func_door (sliding), func_door_rotating and func_button
// (HL SDK doors.cpp / buttons.cpp semantics), plus the entity I/O that drives them:
// trigger_multiple, trigger_once, trigger_relay, multi_manager, trigger_auto.
//
// A mover's motion is a pure function of its replicated state (`from` position 0..1 at
// tick `t0`, moving `dir` -1 / 0 / +1, swing `sign` for rotating doors), so the client
// places doors for any tick exactly like the server (prediction stays bit-exact); the
// decisions (touch, use, triggers, timers, blocking) are made by whoever runs the game
// (the server; the sandbox for itself). Each mover gets a world vertex slot after the
// breakables' (shared/breakables.js), so the client draws it moved and turned within the
// single world draw call.

import { TICK_RATE } from './constants.js';
import { CONTENTS_EMPTY, entityModelIndex, parseVec3 } from './bsp.js';
import { ENT_NONE, HULL_STAND, HULL_DUCK, rotationFromAngles, entityContents, hullFits } from './trace.js';
import { PS_ORIGIN, PS_FLAGS, PS_GROUNDENT, FL_DUCKING } from './pmove.js';

export const MAX_MOVERS = 64;

export const MOVER_DOOR = 0;
export const MOVER_ROTATING = 1;
export const MOVER_BUTTON = 2;

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
// trigger_* spawnflags.
const SF_TRIGGER_NOCLIENTS = 2;

const USE_RADIUS = 64; // PLAYER_SEARCH_RADIUS
const USE_DOT = 0.7; // VIEW_FIELD_NARROW

const CLASS = { func_door: MOVER_DOOR, func_door_rotating: MOVER_ROTATING, func_button: MOVER_BUTTON };

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

// bsp.entities indices of the movers, in mover order (world vertex slot = slotBase + 1 +
// position): every func_door, func_door_rotating and func_button with a brush model.
export function moverEntities(bsp, slotBase) {
  const out = [];
  bsp.entities.forEach((e, bi) => {
    if (CLASS[e.classname] !== undefined && entityModelIndex(e) > 0 && out.length < MAX_MOVERS &&
      slotBase + out.length < 255) out.push(bi);
  });
  return out;
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
    this.flags = new Int32Array(n);
    this.ent = new Int32Array(n); // collision entity
    this.rate = new Float64Array(n); // position change per tick (0..1 over the travel)
    this.travel = new Float64Array(n); // units, or degrees for rotating doors (0: never moves)
    this.wait = new Float64Array(n); // seconds at the top before returning, -1 = stays
    this.base = new Float64Array(n * 3); // spawn origin (the hinge of a rotating door)
    this.off0 = new Float64Array(n * 3); // sliding: offset from the spawn origin at 0 and 1
    this.off1 = new Float64Array(n * 3);
    this.axis = new Uint8Array(n); // rotating: angle turned (0 pitch, 1 yaw, 2 roll)
    this.ang = new Float64Array(n * 3); // rotating: angles at 0, and added at 1 (before sign)
    this.ang0 = new Float64Array(n);
    this.ang1 = new Float64Array(n);
    this.name = []; // targetname ('' = none)
    this.target = [];
    this.mins = new Float64Array(n * 3); // world bounds at spawn (use search)
    this.maxs = new Float64Array(n * 3);
    // Replicated state.
    this.from = new Float32Array(n);
    this.dir = new Int8Array(n);
    this.sign = new Int8Array(n).fill(1);
    this.t0 = new Int32Array(n);
    // Game state (whoever runs the logic).
    this.next = new Int32Array(n); // tick of the scheduled return, 0 = none
    this.activator = new Array(n).fill(null); // who started it ({ x, y, z, yaw }), for its targets
    // Applied transforms.
    this.applied = new Float64Array(n).fill(NaN); // position the collision entity is at
    this.rot = []; // per mover: Float64Array(9), for rotating doors
    this.matrix = new Float32Array(MAX_MOVERS * 12); // 3x4 rows per mover, for the world shader

    list.forEach((bi, k) => {
      const e = bsp.entities[bi], ce = world.ents[entOfBsp.get(bi)];
      const kind = this.kind[k] = CLASS[e.classname];
      const flags = this.flags[k] = +(e.spawnflags || 0);
      this.ent[k] = entOfBsp.get(bi);
      ce.slot = slotBase + 1 + k;
      if (kind !== MOVER_BUTTON && (flags & SF_DOOR_PASSABLE)) ce.kind = ENT_NONE;
      this.name.push(e.targetname || '');
      this.target.push(e.target || '');
      this.base.set([ce.ox, ce.oy, ce.oz], k * 3);
      for (let a = 0; a < 3; a++) {
        this.mins[k * 3 + a] = ce.mins[a] + this.base[k * 3 + a];
        this.maxs[k * 3 + a] = ce.maxs[a] + this.base[k * 3 + a];
      }
      let speed = +(e.speed || 0), wait = +(e.wait || 0), dist;
      if (kind === MOVER_ROTATING) {
        speed = speed || 100;
        const a = new Float64Array(3);
        if (e.angles) parseVec3(e.angles, a);
        this.ang.set(a, k * 3);
        const ax = this.axis[k] = flags & SF_DOOR_ROTATE_Z ? 2 : flags & SF_DOOR_ROTATE_X ? 0 : 1;
        const d = (flags & SF_DOOR_ROTATE_BACKWARDS ? -1 : 1) * +(e.distance || 0);
        // CRotDoor::Spawn: angle1 = angles, angle2 = angles + movedir * distance; start
        // open swaps them.
        this.ang0[k] = flags & SF_DOOR_START_OPEN ? a[ax] + d : a[ax];
        this.ang1[k] = flags & SF_DOOR_START_OPEN ? a[ax] : a[ax] + d;
        dist = Math.abs(d);
        this.rot.push(new Float64Array(9));
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
      this.rate[k] = dist > 0 ? speed / dist / TICK_RATE : 1;
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
    this.next.fill(0);
    this.applied.fill(NaN);
    this.apply(world, 0);
  }

  // Position 0..1 of mover k at `tick`.
  frac(k, tick) {
    const f = this.from[k] + this.dir[k] * (tick - this.t0[k]) * this.rate[k];
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  atBottom(k) {
    return this.from[k] === 0 && this.dir[k] === 0;
  }

  atTop(k) {
    return this.from[k] === 1 && this.dir[k] === 0;
  }

  // World vertex slot of mover k (byte 39 of the world mesh).
  slot(k) {
    return this.slotBase + 1 + k;
  }

  // Puts every mover's collision entity (and render matrix) where it is at `tick`.
  apply(world, tick) {
    for (let k = 0; k < this.count; k++) this.place(world, k, this.frac(k, tick));
  }

  place(world, k, f) {
    if (this.applied[k] === f) return;
    this.applied[k] = f;
    const b = k * 3, m = this.matrix, o = k * 12;
    if (this.kind[k] === MOVER_ROTATING) {
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
        const d = this.off0[b + r] + (this.off1[b + r] - this.off0[b + r]) * f;
        m[o + r * 4] = r === 0 ? 1 : 0;
        m[o + r * 4 + 1] = r === 1 ? 1 : 0;
        m[o + r * 4 + 2] = r === 2 ? 1 : 0;
        m[o + r * 4 + 3] = d;
      }
      world.setTransform(this.ent[k], this.base[b] + m[o + 3], this.base[b + 1] + m[o + 7], this.base[b + 2] + m[o + 11],
        null);
    }
  }

  // Sets mover k's replicated state (the client applying a snapshot). Returns true if
  // it changed.
  setState(k, from, dir, sign, t0) {
    if (this.from[k] === from && this.dir[k] === dir && this.sign[k] === sign && this.t0[k] === t0) return false;
    this.from[k] = from;
    this.dir[k] = dir;
    this.sign[k] = sign;
    this.t0[k] = t0;
    this.applied[k] = NaN;
    return true;
  }

  // --- Game logic (server, sandbox) -------------------------------------------------

  // One tick: arrivals and timed returns (firing targets through `fire(name, act)`),
  // then every moving mover moves, pushing `bodies` (PlayerStates of living players)
  // out of its way or riding on it; a mover that cannot push someone is blocked (doors
  // with a wait go back, as in GoldSrc). Leaves every mover placed for `tick`.
  update(world, tick, bodies, fire) {
    for (let k = 0; k < this.count; k++) {
      const f = this.frac(k, tick);
      if (this.dir[k] > 0 && f >= 1) this.hitTop(k, tick, fire);
      else if (this.dir[k] < 0 && f <= 0) this.hitBottom(k, tick, fire);
      else if (this.next[k] && tick >= this.next[k]) {
        this.next[k] = 0;
        if (this.atTop(k)) this.goDown(k, tick);
      }
      this.move(world, k, tick, bodies);
    }
  }

  move(world, k, tick, bodies) {
    const before = this.applied[k], f = this.frac(k, tick);
    if (before === f || before !== before) {
      this.place(world, k, f);
      return;
    }
    const e = world.ents[this.ent[k]], ent = this.ent[k];
    const ox = e.ox, oy = e.oy, oz = e.oz;
    const R0 = e.rot ? Float64Array.from(e.rot) : null;
    this.place(world, k, f);
    if (e.kind === ENT_NONE) return; // passable
    const R1 = e.rot;
    let pushed = 0;
    for (const ps of bodies) {
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
        return;
      }
      if (pushed === MAX_PUSHED) break;
    }
  }

  // CBaseDoor::Blocked: doors that return go the other way; the others wait where they
  // are (the next tick tries again).
  blocked(world, k, tick, f) {
    this.from[k] = f;
    this.t0[k] = tick;
    if (this.kind[k] !== MOVER_BUTTON && this.wait[k] >= 0) this.dir[k] = -this.dir[k];
    this.place(world, k, this.frac(k, tick));
  }

  hitTop(k, tick, fire) {
    this.from[k] = 1;
    this.dir[k] = 0;
    this.t0[k] = tick;
    this.next[k] = 0;
    const wait = this.wait[k];
    if (this.kind[k] === MOVER_BUTTON) {
      // TriggerAndWait: fire, then come back unless the button stays pushed.
      if (wait !== -1 && !(this.flags[k] & SF_BUTTON_TOGGLE)) this.next[k] = tick + Math.max(1, Math.round(wait * TICK_RATE));
    } else if (!(this.flags[k] & SF_DOOR_NO_AUTO_RETURN) && wait >= 0) {
      this.next[k] = tick + Math.max(1, Math.round(wait * TICK_RATE));
    }
    if (this.target[k]) fire(this.target[k], this.activator[k]);
  }

  hitBottom(k, tick, fire) {
    this.from[k] = 0;
    this.dir[k] = 0;
    this.t0[k] = tick;
    this.next[k] = 0;
    if (this.kind[k] !== MOVER_BUTTON && this.target[k]) fire(this.target[k], this.activator[k]);
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
    if (this.kind[k] !== MOVER_BUTTON && (this.flags[k] & SF_DOOR_NO_AUTO_RETURN) && this.atTop(k)) this.goDown(k, tick);
    else this.goUp(k, tick, act);
  }

  // Someone used mover k (a player's +use, or a target fired by the map).
  use(k, tick, act) {
    if (this.kind[k] === MOVER_BUTTON) {
      if (this.dir[k] !== 0) return;
      if (this.atTop(k)) {
        if (this.flags[k] & SF_BUTTON_TOGGLE) this.goDown(k, tick);
        return;
      }
      this.goUp(k, tick, act);
      return;
    }
    if (this.atBottom(k) || ((this.flags[k] & SF_DOOR_NO_AUTO_RETURN) && this.atTop(k))) this.activate(k, tick, act);
  }

  // A player ran into mover k (DoorTouch): doors without a name open, named ones are
  // locked (a button or trigger opens them); touch-only buttons press.
  touch(k, tick, act) {
    if (this.kind[k] === MOVER_BUTTON) {
      if ((this.flags[k] & SF_BUTTON_TOUCH_ONLY) && this.atBottom(k)) this.goUp(k, tick, act);
      return;
    }
    if ((this.flags[k] & SF_DOOR_USE_ONLY) || this.name[k]) return;
    if (this.atBottom(k) || ((this.flags[k] & SF_DOOR_NO_AUTO_RETURN) && this.atTop(k))) this.activate(k, tick, act);
  }

  // Mover behind collision entity `ent`, or -1.
  ofEnt(ent) {
    for (let k = 0; k < this.count; k++) if (this.ent[k] === ent) return k;
    return -1;
  }

  // Whether a player's +use can work mover k (use-only doors, buttons that are not
  // touch-only: their ObjectCaps).
  usable(k) {
    return this.kind[k] === MOVER_BUTTON ? !(this.flags[k] & SF_BUTTON_TOUCH_ONLY) : (this.flags[k] & SF_DOOR_USE_ONLY) !== 0;
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
  // and doors whose name a trigger fires (`named`: MapLogic.named; not button doors).
  opens(k, named) {
    if (this.kind[k] === MOVER_BUTTON || this.travel[k] < 16) return false;
    if (this.flags[k] & SF_DOOR_USE_ONLY) return true;
    return this.name[k] ? named.has(this.name[k]) : true;
  }

}

const MAX_PUSHED = 32;
const pushBuf = new Float64Array(MAX_PUSHED * 4);
const pushPs = new Array(MAX_PUSHED);

// The map's entity I/O: triggers that fire names when players stand in them, relays and
// multi_managers that pass names on (after delays), trigger_auto at each round start.
// Firing a name uses every mover with that targetname. Other entities are ignored.
export class MapLogic {
  constructor(bsp, doors) {
    this.doors = doors;
    this.triggers = []; // { mins, maxs, target, delay, wait, once, next, done }
    this.relays = new Map(); // targetname -> [{ target, delay }]
    this.autos = []; // { target, delay }
    this.queue = []; // { tick, name, act }
    this.named = new Set(); // names something fires on its own (triggers players walk into, relays, autos)
    this.pressed = new Set(); // names only buttons and doors fire
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
    const relay = (name, target, delay) => {
      if (!name || !target) return;
      if (!this.relays.has(name)) this.relays.set(name, []);
      this.relays.get(name).push({ target, delay });
      this.named.add(target);
    };
    for (const e of bsp.entities) {
      const cls = e.classname, delay = +(e.delay || 0);
      if ((cls === 'trigger_multiple' || cls === 'trigger_once') && e.target &&
        !(+(e.spawnflags || 0) & SF_TRIGGER_NOCLIENTS)) {
        const b = box(e);
        if (!b) continue;
        this.triggers.push({ ...b, target: e.target, delay, wait: +(e.wait || 0) || 0.2, once: cls === 'trigger_once',
          next: 0, done: false });
        this.named.add(e.target);
      } else if (cls === 'trigger_relay') {
        relay(e.targetname, e.target, delay);
      } else if (cls === 'multi_manager') {
        for (const key of Object.keys(e)) {
          if (MM_KEYS.has(key)) continue;
          relay(e.targetname, key.replace(/#\d+$/, ''), +e[key] || 0);
        }
      } else if (cls === 'trigger_auto' && e.target) {
        this.autos.push({ target: e.target, delay });
        this.named.add(e.target);
      } else if ((cls === 'func_button' || cls.startsWith('func_door')) && e.target) {
        this.pressed.add(e.target);
      }
    }
  }

  // Round start: triggers rearm, trigger_auto fires.
  reset(tick) {
    this.queue.length = 0;
    for (const t of this.triggers) {
      t.next = 0;
      t.done = false;
    }
    for (const a of this.autos) this.fireAt(tick, a.target, null, a.delay);
  }

  fireAt(tick, name, act, delay) {
    if (delay > 0) {
      this.queue.push({ tick: tick + Math.max(1, Math.round(delay * TICK_RATE)), name, act });
      return;
    }
    const d = this.doors;
    for (let k = 0; k < d.count; k++) if (d.name[k] === name) d.use(k, tick, act);
    const r = this.relays.get(name);
    if (r) for (const { target, delay: dl } of r) this.fireAt(tick, target, act, dl);
  }

  // Delayed fires due by `tick`, then the triggers the players stand in. `players`:
  // [{ x, y, z, yaw }] of living players (hull centers).
  update(tick, players) {
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      if (q.tick > tick) continue;
      this.queue.splice(i--, 1);
      this.fireAt(tick, q.name, q.act, 0);
    }
    for (const t of this.triggers) {
      if (t.done || tick < t.next) continue;
      for (const p of players) {
        if (p.x + 16 <= t.mins[0] || p.x - 16 >= t.maxs[0] || p.y + 16 <= t.mins[1] || p.y - 16 >= t.maxs[1] ||
          p.z + 36 <= t.mins[2] || p.z - 36 >= t.maxs[2]) continue;
        this.fireAt(tick, t.target, p, t.delay);
        if (t.once) t.done = true;
        else t.next = tick + Math.max(1, Math.round(t.wait * TICK_RATE));
        break;
      }
    }
  }
}

const MM_KEYS = new Set(['classname', 'targetname', 'origin', 'spawnflags', 'wait', 'delay', 'angles', 'target']);
