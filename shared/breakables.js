// GoldSrc func_breakable: brush entities with health that shatter when damaged.
// Each breakable gets a slot (1..MAX_BREAKABLES, 0 = not breakable) assigned in BSP
// entity order, so the client mesh and the simulation agree without sharing objects.
// State is flat typed arrays, run identically by client and server.

import { entityModelIndex } from './bsp.js';
import { ENT_SOLID, ENT_NONE } from './trace.js';

export const SF_BREAK_TRIGGER_ONLY = 1; // only a trigger breaks it (CS bomb-site crates)
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

// bsp.entities indices of the breakables, in slot order (slot = position + 1).
export function breakableEntities(bsp) {
  const out = [];
  bsp.entities.forEach((e, i) => {
    if (e.classname === 'func_breakable' && entityModelIndex(e) > 0 && out.length < MAX_BREAKABLES) out.push(i);
  });
  return out;
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
    this.mins = new Float32Array(n * 3); // world-space bounds
    this.maxs = new Float32Array(n * 3);
    this.slotOfEnt = new Uint8Array(world.ents.length);

    const entOfBsp = new Map();
    world.ents.forEach((e, i) => entOfBsp.set(e.bspEntity, i));
    list.forEach((bi, k) => {
      const slot = k + 1;
      const e = bsp.entities[bi];
      const ent = entOfBsp.get(bi);
      if (ent === undefined) return;
      const ce = world.ents[ent];
      this.ent[slot] = ent;
      this.slotOfEnt[ent] = slot;
      this.maxHealth[slot] = +(e.health || 0);
      this.material[slot] = +(e.material || MAT_GLASS);
      this.flags[slot] = +(e.spawnflags || 0);
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

  canTakeDamage(slot) {
    return slot > 0 && !this.broken[slot] && this.ent[slot] >= 0 &&
      !(this.flags[slot] & SF_BREAK_TRIGGER_ONLY) && this.material[slot] !== MAT_UNBREAKABLE_GLASS;
  }

  // Damages the breakable behind collision entity `ent`. Returns its slot if this
  // broke it, else 0. A broken breakable stops colliding at once.
  damage(world, ent, amount, melee = false) {
    const slot = ent > 0 && ent < this.slotOfEnt.length ? this.slotOfEnt[ent] : 0;
    if (!this.canTakeDamage(slot)) return 0;
    if (melee && (this.flags[slot] & SF_BREAK_CROWBAR)) this.health[slot] = 0;
    else this.health[slot] -= amount;
    if (this.health[slot] > 0) return 0;
    this.health[slot] = 0;
    this.broken[slot] = 1;
    world.ents[ent].kind = ENT_NONE;
    return slot;
  }
}
