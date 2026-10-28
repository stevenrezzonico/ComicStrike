// Fits the first-person hands to each gun (the finger curls of client/models/arms.js):
// each hand curls around the part it holds at rest (viewanim's heldParts), widened step
// by step while any of its finger or thumb joints still lies inside the gun. Run once per
// gun at load (client/gl/gunmeshes.js); test/viewanim.test.js checks every gun.

import { ViewAnimator, heldParts } from './viewanim.js';
import { ARMS_SKELETON as A } from './skeleton.js';
import * as Q from './quat.js';
import { fingerJoints, FLAT_CURL } from '../models/arms.js';
import { WEAPONS, createWeaponState, giveWeapon, WS_ACTIVE, WS_DEPLOY_END } from '../../shared/weapons.js';

const STEP = 1.1; // curl growth along the hand per try
const STEP_ACROSS = 1.03; // and across it
const TRIES = 14;

// A built mesh as solid parts: its closed shells (triangles joined by shared corners),
// each with its bounding box, for inside tests.
export class Solid {
  constructor(built) {
    const p = built.positions, parent = new Int32Array(built.count), first = new Map();
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let v = 0; v < built.count; v++) {
      const k = `${Math.round(p[v * 3] * 1e3)},${Math.round(p[v * 3 + 1] * 1e3)},${Math.round(p[v * 3 + 2] * 1e3)}`;
      parent[v] = first.has(k) ? first.get(k) : v;
      if (!first.has(k)) first.set(k, v);
    }
    for (let t = 0; t < built.count; t += 3) {
      const a = find(t);
      parent[find(t + 1)] = a;
      parent[find(t + 2)] = a;
    }
    const shells = new Map();
    for (let t = 0; t < built.count; t += 3) {
      const r = find(t);
      if (!shells.has(r)) shells.set(r, { tris: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
      const s = shells.get(r);
      s.tris.push(t);
      for (let v = t; v < t + 3; v++) {
        for (let c = 0; c < 3; c++) {
          s.lo[c] = Math.min(s.lo[c], p[v * 3 + c]);
          s.hi[c] = Math.max(s.hi[c], p[v * 3 + c]);
        }
      }
    }
    this.p = p;
    this.shells = [...shells.values()];
  }

  // Inside any shell: its winding number (the triangles' solid angles over 4 pi) is 1.
  inside(q) {
    const p = this.p;
    for (const s of this.shells) {
      if (q[0] < s.lo[0] || q[1] < s.lo[1] || q[2] < s.lo[2] || q[0] > s.hi[0] || q[1] > s.hi[1] || q[2] > s.hi[2]) continue;
      let w = 0;
      for (const t of s.tris) {
        const o = t * 3;
        const ax = p[o] - q[0], ay = p[o + 1] - q[1], az = p[o + 2] - q[2];
        const bx = p[o + 3] - q[0], by = p[o + 4] - q[1], bz = p[o + 5] - q[2];
        const cx = p[o + 6] - q[0], cy = p[o + 7] - q[1], cz = p[o + 8] - q[2];
        const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz);
        const lc = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
        w += 2 * Math.atan2(det, la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb +
          (bx * cx + by * cy + bz * cz) * la);
      }
      if (Math.abs(w) > 2 * Math.PI) return true;
    }
    return false;
  }
}

// Both hands at rest holding weapon `id` (pts: its buildGun points).
export function restPose(id, pts) {
  const w = WEAPONS[id], ws = createWeaponState(), va = new ViewAnimator();
  giveWeapon(ws, id);
  ws.f[WS_ACTIVE] = w.slot;
  ws.f[WS_DEPLOY_END] = 1;
  va.update(id, ws, 10, pts);
  return va;
}

// Gun-frame points along hand s's fingers and thumb (0 left, 1 right) holding `curl`,
// the hand posed by va (the left one on the second pistol of a dual hold).
export function handJoints(va, s, curl) {
  const j = fingerJoints(curl), local = [];
  for (const f of j.fingers) {
    for (let k = 1; k < 4; k++) local.push(f[k], [0, 1, 2].map((i) => (f[k][i] + f[k - 1][i]) / 2));
  }
  local.push(j.thumb[1], j.thumb[2]);
  const h = A.bone(s ? 'hand_R' : 'hand_L'), p = va.pose, gun = s === 0 && va.dual ? va.gun2 : va.gun;
  const v = new Float32Array(6);
  return local.map(([x, y, z]) => {
    v[0] = x;
    v[1] = s ? y : -y; // the left hand is the right one mirrored
    v[2] = z;
    Q.rotate(v, 3, p.wrot, h * 4, v, 0);
    const d = [0, 1, 2].map((i) => p.wpos[h * 3 + i] + v[3 + i] - gun[12 + i]);
    return [0, 1, 2].map((i) => gun[i * 4] * d[0] + gun[i * 4 + 1] * d[1] + gun[i * 4 + 2] * d[2]);
  });
}

// Gun-frame point q in hand s's frame (the left hand mirrored to a right one).
function toHand(va, s, q) {
  const h = A.bone(s ? 'hand_R' : 'hand_L'), p = va.pose, gun = s === 0 && va.dual ? va.gun2 : va.gun;
  const v = new Float32Array(6), inv = new Float32Array(4);
  for (let i = 0; i < 3; i++) v[i] = gun[i] * q[0] + gun[4 + i] * q[1] + gun[8 + i] * q[2] + gun[12 + i] - p.wpos[h * 3 + i];
  Q.conj(inv, 0, p.wrot, h * 4);
  Q.rotate(v, 3, inv, 0, v, 0);
  return [v[3], s ? v[4] : -v[4], v[5]];
}

// The curl around a held part (heldParts) for hand s at its rest pose: the part's axis
// where it crosses the hand's middle plane, how fast it slides along the hand from finger
// to finger, and its section stretched by the slant.
function curlAround(va, s, part) {
  const a = toHand(va, s, part.at), b = toHand(va, s, part.at.map((x, i) => x + part.dir[i]));
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dz = Math.max(Math.abs(d[2]), 0.35) * (d[2] < 0 ? -1 : 1), t = -a[2] / dz;
  return { cx: a[0] + d[0] * t, cy: a[1] + d[1] * t, slope: d[0] / dz, r: part.r, rx: (part.rx ?? part.r) / Math.abs(dz),
    thumb: part.thumb || (part.r <= 0.8 ? 'side' : 'near') };
}

// [left, right] curls for weapon `id` fitted to its model (gun: buildGun's result): around
// the parts the hands hold, widened where a joint would still end up inside the gun.
export function fitHands(id, gun) {
  const pts = { ...gun, mesh: null }, va = restPose(id, pts), solid = new Solid(gun.mesh);
  return heldParts(id, pts).map((part, s) => {
    if (!part) return FLAT_CURL;
    // Mostly wider along the hand (a trigger guard, a magazine ahead of the grip), little
    // across it, so the fingers keep touching the sides.
    const c = curlAround(va, s, part);
    let curl = c;
    for (let k = 1; k <= TRIES; k++) {
      if (!handJoints(va, s, curl).some((q) => solid.inside(q))) return curl;
      const along = STEP ** Math.min(k, TRIES / 2), across = STEP_ACROSS ** k;
      curl = { ...c, r: c.r * across, rx: c.rx * along * across };
    }
    return curl;
  });
}
