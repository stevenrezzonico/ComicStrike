// Player hitboxes (CS:GO hit groups) and segment tests against them. Boxes are in
// the player's yaw frame, measured from the feet, and squash with the duck amount.
// The server fills HitTargets with lag-compensated positions; the client with what
// it draws.

import { FL_DUCKING } from './pmove.js';

export const HITGROUP_GENERIC = 0;
export const HITGROUP_HEAD = 1;
export const HITGROUP_CHEST = 2;
export const HITGROUP_STOMACH = 3;
export const HITGROUP_LEGS = 6;

// [group, center x (forward), y (left), z (up from feet), half extents x, y, z]
const BOXES = [
  [HITGROUP_HEAD, 1.5, 0, 64, 5, 4.5, 5],
  [HITGROUP_CHEST, 0, 0, 50, 7, 11, 9],
  [HITGROUP_STOMACH, 0, 0, 36.5, 6.5, 10, 5.5],
  [HITGROUP_LEGS, 0, 0, 15.5, 6, 9, 15.5],
];
export const BOX_DATA = new Float32Array(BOXES.flat());
export const BOX_STRIDE = 7;

// Feet height below the hull center, and the crouch squash factor for the boxes.
export const feetOffset = (flags) => ((flags & FL_DUCKING) ? 18 : 36);
export const crouchScale = (duck) => 1 - 0.5 * duck;

// CS:GO damage scale per hit group (the head uses the weapon's headshot multiplier).
export function hitgroupScale(group, weapon) {
  if (group === HITGROUP_HEAD) return weapon.headshotMult;
  if (group === HITGROUP_STOMACH) return 1.25;
  if (group === HITGROUP_LEGS) return 0.75;
  return 1;
}

// Ray vs axis-aligned box (slab test). Returns entry distance or Infinity.
function rayBox(ox, oy, oz, dx, dy, dz, cx, cy, cz, hx, hy, hz, maxDist) {
  let tmin = 0, tmax = maxDist;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox - cx : a === 1 ? oy - cy : oz - cz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const h = a === 0 ? hx : a === 1 ? hy : hz;
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return Infinity;
      continue;
    }
    let t1 = (-h - o) / d, t2 = (h - o) / d;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

export class HitTargets {
  constructor(capacity) {
    this.capacity = capacity;
    this.active = new Uint8Array(capacity);
    this.x = new Float32Array(capacity); // hull center
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.yaw = new Float32Array(capacity); // degrees
    this.flags = new Int32Array(capacity);
    this.duck = new Float32Array(capacity); // 0..1
    this.team = new Uint8Array(capacity);
    // Result of the last trace.
    this.dist = 0;
    this.group = HITGROUP_GENERIC;
  }

  clear() {
    this.active.fill(0);
  }

  set(id, x, y, z, yaw, flags, duck, team) {
    this.active[id] = 1;
    this.x[id] = x;
    this.y[id] = y;
    this.z[id] = z;
    this.yaw[id] = yaw;
    this.flags[id] = flags;
    this.duck[id] = duck;
    this.team[id] = team;
  }

  // Nearest player hit by the segment from o along unit d within maxDist, skipping
  // `skipId` and members of `skipTeam` (0 = nobody). Returns the id or -1; the
  // distance and hit group are left in this.dist / this.group.
  trace(ox, oy, oz, dx, dy, dz, maxDist, skipId, skipTeam) {
    let best = -1, bestDist = maxDist;
    for (let id = 0; id < this.capacity; id++) {
      if (!this.active[id] || id === skipId || (skipTeam && this.team[id] === skipTeam)) continue;
      const feet = this.z[id] - feetOffset(this.flags[id]);
      const s = crouchScale(this.duck[id]); // crouching squashes the boxes toward the feet
      // Broadphase against the hull.
      if (rayBox(ox, oy, oz, dx, dy, dz, this.x[id], this.y[id], feet + 36 * s, 16, 16, 36 * s, bestDist) === Infinity) {
        continue;
      }
      // Into the player's yaw frame (x forward, y left, z up from the feet).
      const a = -this.yaw[id] * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      const px = ox - this.x[id], py = oy - this.y[id];
      const lx = px * c - py * sn, ly = px * sn + py * c, lz = oz - feet;
      const ldx = dx * c - dy * sn, ldy = dx * sn + dy * c;
      for (let b = 0; b < BOX_DATA.length; b += BOX_STRIDE) {
        const t = rayBox(lx, ly, lz, ldx, ldy, dz, BOX_DATA[b + 1], BOX_DATA[b + 2], BOX_DATA[b + 3] * s,
          BOX_DATA[b + 4], BOX_DATA[b + 5], BOX_DATA[b + 6] * s, bestDist);
        if (t < bestDist) {
          bestDist = t;
          best = id;
          this.group = BOX_DATA[b];
        }
      }
    }
    this.dist = bestDist;
    return best;
  }
}
