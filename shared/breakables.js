// GoldSrc func_breakable: brush entities with health that shatter when damaged.
// Each breakable gets a slot (1..MAX_BREAKABLES, 0 = not breakable) assigned in BSP
// entity order, so the client mesh and the simulation agree without sharing objects.
// State is flat typed arrays, run identically by client and server. What a break sets
// off (its target, its explosion: `explodemagnitude`) is the game's (server/game.js,
// the sandbox), which hears of every break through its slot.

import { entityModelIndex } from './bsp.js';
import { ENT_SOLID, ENT_NONE, HULL_POINT, Trace, traceHull } from './trace.js';

export const SF_BREAK_TRIGGER_ONLY = 1; // only a trigger breaks it (CS bomb-site crates)
export const SF_BREAK_TOUCH = 2; // running into it breaks it (by speed: CBreakable::BreakTouch)
export const SF_BREAK_PRESSURE = 4; // standing on it breaks it, after its delay (de_survivor's ice)
export const SF_BREAK_CROWBAR = 256; // one melee hit breaks it

// "material" key values (HL SDK Materials enum). Missing key means glass.
export const MAT_GLASS = 0;
export const MAT_WOOD = 1;
export const MAT_METAL = 2;
export const MAT_FLESH = 3;
export const MAT_CINDER = 4;
export const MAT_CEILING_TILE = 5;
export const MAT_COMPUTER = 6;
export const MAT_UNBREAKABLE_GLASS = 7;
export const MAT_ROCKS = 8;

export const MAX_BREAKABLES = 255; // slots fit in one vertex byte

// An exploding breakable's blast (env_explosion -> RadiusDamage): `explodemagnitude` of
// damage at its center, falling off in a straight line to nothing at EXPLODE_RANGE times
// that, blocked by walls.
export const EXPLODE_RANGE = 2.5;

// bsp.entities indices of the breakables, in slot order (slot = position + 1).
export function breakableEntities(bsp) {
  const out = [];
  bsp.entities.forEach((e, i) => {
    if (e.classname === 'func_breakable' && entityModelIndex(e) > 0 && out.length < MAX_BREAKABLES) out.push(i);
  });
  return out;
}

// HL RadiusDamage's falloff: `damage` at the blast, nothing at `radius`.
export function blastDamage(damage, radius, dist) {
  return dist >= radius ? 0 : damage - dist * (damage / radius);
}

export class Breakables {
  constructor(bsp, world) {
    const list = breakableEntities(bsp);
    const n = list.length + 1; // slot 0 unused
    this.count = list.length;
    this.ent = new Int32Array(n).fill(-1); // collision entity per slot
    this.maxHealth = new Float32Array(n);
    this.health = new Float32Array(n);
    this.material = new Uint8Array(n);
    this.flags = new Int32Array(n);
    this.broken = new Uint8Array(n);
    this.magnitude = new Float32Array(n); // explodemagnitude: its blast's damage (0: none)
    this.delay = new Float32Array(n); // seconds before its target fires
    this.name = ['']; // targetname per slot
    this.target = [''];
    this.kill = ['']; // killtarget
    this.mins = new Float32Array(n * 3); // world-space bounds
    this.maxs = new Float32Array(n * 3);
    this.slotOfEnt = new Uint8Array(world.ents.length);

    const entOfBsp = new Map();
    world.ents.forEach((e, i) => entOfBsp.set(e.bspEntity, i));
    list.forEach((bi, k) => {
      const slot = k + 1;
      const e = bsp.entities[bi];
      this.name.push(e.targetname || '');
      this.target.push(e.target || '');
      this.kill.push(e.killtarget || '');
      const ent = entOfBsp.get(bi);
      if (ent === undefined) return;
      const ce = world.ents[ent];
      this.ent[slot] = ent;
      this.slotOfEnt[ent] = slot;
      ce.slot = slot;
      this.maxHealth[slot] = +(e.health || 0);
      this.material[slot] = +(e.material || MAT_GLASS);
      this.flags[slot] = +(e.spawnflags || 0);
      this.magnitude[slot] = Math.max(0, +(e.explodemagnitude || 0));
      this.delay[slot] = Math.max(0, +(e.delay || 0));
      for (let a = 0; a < 3; a++) {
        const o = a === 0 ? ce.ox : a === 1 ? ce.oy : ce.oz;
        this.mins[slot * 3 + a] = ce.mins[a] + o;
        this.maxs[slot * 3 + a] = ce.maxs[a] + o;
      }
    });
    this.reset(world);
  }

  // Restores every breakable (round restart).
  reset(world) {
    for (let s = 1; s <= this.count; s++) {
      this.health[s] = this.maxHealth[s];
      this.broken[s] = 0;
      if (this.ent[s] >= 0) world.ents[this.ent[s]].kind = ENT_SOLID;
    }
  }

  // Forces a slot's state (applying the server's view). Returns true if it changed.
  setBroken(world, slot, broken) {
    if (slot < 1 || slot > this.count || (this.broken[slot] !== 0) === broken) return false;
    this.broken[slot] = broken ? 1 : 0;
    this.health[slot] = broken ? 0 : this.maxHealth[slot];
    if (this.ent[slot] >= 0) world.ents[this.ent[slot]].kind = broken ? ENT_NONE : ENT_SOLID;
    return true;
  }

  // The breakable slot behind collision entity `ent`, or 0.
  slotOf(ent) {
    return ent > 0 && ent < this.slotOfEnt.length ? this.slotOfEnt[ent] : 0;
  }

  canTakeDamage(slot) {
    return slot > 0 && !this.broken[slot] && this.ent[slot] >= 0 &&
      !(this.flags[slot] & SF_BREAK_TRIGGER_ONLY) && this.material[slot] !== MAT_UNBREAKABLE_GLASS;
  }

  // Damages the breakable behind collision entity `ent`. Returns its slot if this
  // broke it, else 0. A broken breakable stops colliding at once.
  damage(world, ent, amount, melee = false) {
    const slot = this.slotOf(ent);
    if (!this.canTakeDamage(slot)) return 0;
    return this.hurt(world, slot, amount, melee);
  }

  hurt(world, slot, amount, melee = false) {
    if (melee && (this.flags[slot] & SF_BREAK_CROWBAR)) this.health[slot] = 0;
    else this.health[slot] -= amount;
    if (this.health[slot] > 0) return 0;
    this.health[slot] = 0;
    this.broken[slot] = 1;
    world.ents[this.ent[slot]].kind = ENT_NONE;
    return slot;
  }

  // The center of slot s's bounds into out.
  center(s, out) {
    for (let a = 0; a < 3; a++) out[a] = (this.mins[s * 3 + a] + this.maxs[s * 3 + a]) / 2;
    return out;
  }

  // A blast at (x, y, z): every breakable in `radius` with nothing solid between the
  // blast and its center takes blastDamage (HL RadiusDamage; the ones only a trigger
  // breaks are left alone). The slots it broke are pushed to `out`; returns their number.
  blast(world, x, y, z, damage, radius, out) {
    let n = 0;
    for (let s = 1; s <= this.count; s++) {
      if (!this.canTakeDamage(s)) continue;
      this.center(s, blastCenter);
      const dist = Math.hypot(blastCenter[0] - x, blastCenter[1] - y, blastCenter[2] - z);
      const d = blastDamage(damage, radius, dist);
      if (d <= 0) continue;
      traceHull(world, HULL_POINT, x, y, z, blastCenter[0], blastCenter[1], blastCenter[2], blastTrace);
      if (blastTrace.fraction < 1 && blastTrace.ent !== this.ent[s]) continue; // a wall between
      if (this.hurt(world, s, d)) out.push(s), n++;
    }
    return n;
  }
}

const blastCenter = new Float64Array(3);
const blastTrace = new Trace();
