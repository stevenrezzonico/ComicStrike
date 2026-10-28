// Weapons lying on the ground (dropped with G, on death, or when a purchase replaces
// them), as flat preallocated arrays. The server owns them (server/game.js) and sends
// the list in S2C_ITEMS; the client draws them (client/gl/playermodels.js). The C4 is
// not an item: it has its own bomb state (shared/bomb.js).
//
// A dropped weapon is thrown: it flies from the thrower's eye (G) or chest (dying,
// buying over it) with gravity, bounces off walls keeping a little of its speed, slides
// to a stop on floors (update, every tick), and can only be picked up once it lies still.

import { traceHull, Trace, HULL_POINT } from './trace.js';
import { TICK_DT, TICK_RATE } from './constants.js';

export const MAX_ITEMS = 48; // the oldest goes when a new one needs room
export const THROW_SPEED = 300; // G: units/s along the view (approx. of CS:GO's)
export const LET_GO_SPEED = 60; // dying or buying over it: it falls just ahead
const ITEM_GRAVITY = 800; // sv_gravity: guns fall like players
const ELASTICITY = 0.3; // speed kept off a bounce (approx.)
const FLOOR_FRICTION = 0.6; // sliding speed kept at each floor contact (approx.)
const REST_SPEED = 40; // slower than this on a floor: it lies still
const MAX_FLIGHT = 3 * TICK_RATE; // ticks; then it stays where it is
const DEG = Math.PI / 180;
const tr = new Trace();

export class Items {
  constructor() {
    this.count = 0;
    this.id = new Uint16Array(MAX_ITEMS); // unique per drop (wraps), for clients to track
    this.weapon = new Uint8Array(MAX_ITEMS);
    this.clip = new Uint16Array(MAX_ITEMS);
    this.reserve = new Uint16Array(MAX_ITEMS);
    this.x = new Float32Array(MAX_ITEMS);
    this.y = new Float32Array(MAX_ITEMS);
    this.z = new Float32Array(MAX_ITEMS); // the floor under it (in flight: where it is)
    this.yaw = new Float32Array(MAX_ITEMS); // degrees
    this.pickupTick = new Int32Array(MAX_ITEMS); // no pickup before this server tick
    this.flying = new Uint8Array(MAX_ITEMS); // 1 while in the air or sliding
    this.age = new Uint16Array(MAX_ITEMS); // ticks since it was thrown
    this.owner = new Int8Array(MAX_ITEMS); // who threw it (-1: nobody)
    this.vel = new Float32Array(MAX_ITEMS * 3);
    this.nextId = 1;
  }

  clear() {
    this.count = 0;
  }

  // Adds a weapon lying still; returns its index.
  add(weapon, clip, reserve, x, y, z, yaw, pickupTick = 0) {
    if (this.count === MAX_ITEMS) this.remove(0);
    const i = this.count++;
    this.id[i] = this.nextId;
    this.nextId = (this.nextId + 1) & 0xffff || 1;
    this.weapon[i] = weapon;
    this.clip[i] = clip;
    this.reserve[i] = reserve;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.yaw[i] = yaw;
    this.pickupTick[i] = pickupTick;
    this.flying[i] = 0;
    this.age[i] = 0;
    this.owner[i] = -1;
    this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    return i;
  }

  // Throws a weapon from (ex, ey, ez): along the view flattened toward 12 degrees up at
  // `speed`, plus the thrower's velocity (vx, vy, vz), leaving 16 units ahead (short of a
  // wall). update() flies it. Returns its index.
  throw(world, weapon, clip, reserve, owner, ex, ey, ez, pitch, yaw, speed, vx, vy, vz, pickupTick = 0) {
    const p = Math.max(-60, Math.min(60, pitch)) * 0.5 - 12;
    const cp = Math.cos(p * DEG), fx = cp * Math.cos(yaw * DEG), fy = cp * Math.sin(yaw * DEG), fz = -Math.sin(p * DEG);
    traceHull(world, HULL_POINT, ex, ey, ez, ex + fx * 16, ey + fy * 16, ez + fz * 16, tr);
    const back = tr.fraction < 1 ? 2 : 0;
    const i = this.add(weapon, clip, reserve, tr.endx - fx * back, tr.endy - fy * back, tr.endz - fz * back, yaw + 90,
      pickupTick);
    this.flying[i] = 1;
    this.owner[i] = owner;
    const o = i * 3;
    this.vel[o] = fx * speed + vx;
    this.vel[o + 1] = fy * speed + vy;
    this.vel[o + 2] = fz * speed + vz;
    return i;
  }

  // One tick of flight for every flying weapon (gravity half before and half after the
  // move, like grenades). Returns true if any flew this tick (its last tick included).
  update(world) {
    let any = false;
    const V = this.vel, dt = TICK_DT;
    for (let i = 0; i < this.count; i++) {
      if (!this.flying[i]) continue;
      any = true;
      this.age[i]++;
      const o = i * 3, x = this.x[i], y = this.y[i], z = this.z[i];
      V[o + 2] -= ITEM_GRAVITY * dt * 0.5;
      traceHull(world, HULL_POINT, x, y, z, x + V[o] * dt, y + V[o + 1] * dt, z + V[o + 2] * dt, tr);
      if (tr.startsolid || this.age[i] >= MAX_FLIGHT) {
        this.flying[i] = 0;
        continue;
      }
      const hit = tr.fraction < 1;
      this.x[i] = tr.endx + (hit ? tr.nx : 0);
      this.y[i] = tr.endy + (hit ? tr.ny : 0);
      this.z[i] = tr.endz + (hit ? tr.nz : 0);
      if (hit) {
        const back = (V[o] * tr.nx + V[o + 1] * tr.ny + V[o + 2] * tr.nz) * 2;
        V[o] = (V[o] - back * tr.nx) * ELASTICITY;
        V[o + 1] = (V[o + 1] - back * tr.ny) * ELASTICITY;
        V[o + 2] = (V[o + 2] - back * tr.nz) * ELASTICITY;
        if (tr.nz > 0.7) { // a floor: it slides, then lies on it
          V[o] *= FLOOR_FRICTION;
          V[o + 1] *= FLOOR_FRICTION;
          if (V[o] * V[o] + V[o + 1] * V[o + 1] + V[o + 2] * V[o + 2] < REST_SPEED * REST_SPEED) {
            this.z[i] = tr.endz;
            this.flying[i] = 0;
            continue;
          }
        }
      }
      V[o + 2] -= ITEM_GRAVITY * dt * 0.5;
    }
    return any;
  }

  // Removes item i, keeping the rest in drop order (oldest first).
  remove(i) {
    for (
      const a of [this.id, this.weapon, this.clip, this.reserve, this.x, this.y, this.z, this.yaw, this.pickupTick,
        this.flying, this.age, this.owner]
    ) {
      a.copyWithin(i, i + 1, this.count);
    }
    this.vel.copyWithin(i * 3, (i + 1) * 3, this.count * 3);
    this.count--;
  }
}
