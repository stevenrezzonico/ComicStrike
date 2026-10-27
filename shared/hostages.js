// Hostages, CS:GO style (the carried hostages of the 2017 rework): two per round at
// random hostage_entity spots; a CT holds use on one to pick it up, carries it on his
// shoulder (slower) and wins the round by bringing it into a rescue zone; the carrier
// drops it where he dies. Hostages can be shot (money penalties). Rescue zones are
// func_hostage_rescue brushes, else info_hostage_rescue points, else the CT spawns.
// The server owns them; clients get the list (S2C_HOSTAGES).
//
// Values marked (approx.) are estimates of CS:GO behavior not found in its data files.

import { entityModelIndex, parseVec3 } from './bsp.js';

export const MAX_HOSTAGES = 4;
export const HOSTAGES_PER_ROUND = 2; // mp_hostages_max
export const HOSTAGE_HEALTH = 100;
export const PICKUP_TIME = 2; // seconds holding use (approx.)
export const CARRY_SPEED = 200; // the carrier's speed cap (approx.)
export const HOSTAGE_USE_RANGE = 96; // eye to hostage (approx., like +use on weapons)
export const HOSTAGE_USE_CONE = 0.7;
const RESCUE_RADIUS = 256; // around an info_hostage_rescue or CT spawn (approx.)

// States.
export const HS_IDLE = 1; // standing at its spot, or where it was dropped
export const HS_CARRIED = 2;
export const HS_RESCUED = 3;
export const HS_DEAD = 4;

export class RescueZones {
  // ctSpawns: [[x, y, z, yaw], ...] for maps with no rescue entities.
  constructor(bsp, ctSpawns = []) {
    this.boxes = []; // [minx, miny, minz, maxx, maxy, maxz]
    const o = new Float32Array(3), f = bsp.modelsF;
    for (const e of bsp.entities) {
      if (e.classname !== 'func_hostage_rescue') continue;
      const m = entityModelIndex(e);
      if (m <= 0) continue;
      parseVec3(e.origin, o);
      this.boxes.push([f[m * 16] + o[0], f[m * 16 + 1] + o[1], f[m * 16 + 2] + o[2], f[m * 16 + 3] + o[0],
        f[m * 16 + 4] + o[1], f[m * 16 + 5] + o[2]]);
    }
    if (this.boxes.length) return;
    const points = bsp.entities.filter((e) => e.classname === 'info_hostage_rescue').map((e) => {
      parseVec3(e.origin, o);
      return [o[0], o[1], o[2]];
    });
    const r = RESCUE_RADIUS;
    for (const [x, y, z] of points.length ? points : ctSpawns) this.boxes.push([x - r, y - r, z - r, x + r, y + r, z + r]);
  }

  contains(x, y, z) {
    for (const b of this.boxes) if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]) return true;
    return false;
  }
}

export class Hostages {
  constructor(bsp = null) {
    this.spots = []; // [x, y, z, yaw] from hostage_entity
    if (bsp) {
      const o = new Float32Array(3);
      for (const e of bsp.entities) {
        if (e.classname !== 'hostage_entity') continue;
        parseVec3(e.origin, o);
        const yaw = e.angles ? +e.angles.trim().split(/\s+/)[1] || 0 : +(e.angle || 0);
        this.spots.push([o[0], o[1], o[2], yaw]);
      }
    }
    this.count = 0;
    this.state = new Uint8Array(MAX_HOSTAGES);
    this.carrier = new Int8Array(MAX_HOSTAGES).fill(-1);
    this.health = new Float32Array(MAX_HOSTAGES);
    this.x = new Float32Array(MAX_HOSTAGES); // feet
    this.y = new Float32Array(MAX_HOSTAGES);
    this.z = new Float32Array(MAX_HOSTAGES);
    this.yaw = new Float32Array(MAX_HOSTAGES);
    this.touched = new Uint8Array(MAX_HOSTAGES); // picked up once this round (the money for it is paid)
  }

  // New round: `n` of the spots, chosen with `random` (0..1); floor(x, y, z) drops them
  // to the ground.
  reset(n, random, floor) {
    const free = this.spots.map((_, i) => i);
    this.count = Math.min(n, free.length, MAX_HOSTAGES);
    for (let k = 0; k < this.count; k++) {
      const i = free.splice(Math.floor(random() * free.length), 1)[0];
      const [x, y, z, yaw] = this.spots[i];
      this.place(k, x, y, floor(x, y, z + 8), yaw);
      this.health[k] = HOSTAGE_HEALTH;
      this.touched[k] = 0;
    }
  }

  place(k, x, y, z, yaw) {
    this.state[k] = HS_IDLE;
    this.carrier[k] = -1;
    this.x[k] = x;
    this.y[k] = y;
    this.z[k] = z;
    this.yaw[k] = yaw;
  }

  // The hostage player `id` carries, or -1.
  carriedBy(id) {
    for (let k = 0; k < this.count; k++) if (this.state[k] === HS_CARRIED && this.carrier[k] === id) return k;
    return -1;
  }

  // The idle hostage in front of an eye within reach, or -1.
  inReach(ex, ey, ez, pitch, yaw) {
    const cp = Math.cos(pitch * Math.PI / 180), dx = cp * Math.cos(yaw * Math.PI / 180);
    const dy = cp * Math.sin(yaw * Math.PI / 180), dz = -Math.sin(pitch * Math.PI / 180);
    let best = -1, bestD = HOSTAGE_USE_RANGE;
    for (let k = 0; k < this.count; k++) {
      if (this.state[k] !== HS_IDLE) continue;
      const vx = this.x[k] - ex, vy = this.y[k] - ey, vz = this.z[k] + 36 - ez, d = Math.hypot(vx, vy, vz);
      if (d >= bestD || (vx * dx + vy * dy + vz * dz) / Math.max(d, 1) < HOSTAGE_USE_CONE) continue;
      best = k;
      bestD = d;
    }
    return best;
  }
}
