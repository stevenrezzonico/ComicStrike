// First-person arms on the view arm rig (client/anim/skeleton.js ARMS_SKELETON), built
// in its bind pose: arms pointing forward, palms facing in. Sleeves and gloves in the
// team's colors (client/models/players.js): the T's jacket sleeves and fingerless
// gloves, the CT's navy sleeves and black gloves. Sleeves taper to the wrist with a
// rolled end and a few fold marks (buildArms). Hands are their own meshes (buildHand),
// shaped around what they hold: a rounded palm, four jointed fingers curled from the
// knuckles around the front of the held object to its far side, the thumb along it; the
// curl is fitted to the object (a pistol grip, a handguard, the other hand), so fingers
// never pass through it. A held object's center sits HAND_GRIP ahead of the wrist and
// HAND_GRIP_IN in from the palm's axis (client/anim/viewanim.js places hands by these).

import { MeshBuilder, FINISH, finish } from '../gl/meshkit.js';
import { ARMS_SKELETON as A } from '../anim/skeleton.js';
import { LOOKS, SKIN } from './players.js';

export const HAND_GRIP = 1.8;
export const HAND_GRIP_IN = 1.25;

// Curls: the held object's section in each finger's plane, in the hand frame (x from the
// wrist along the hand, y toward the object, z up): an oval centered `cy` in from the
// palm's axis and cx ahead of the wrist (default HAND_GRIP), sliding `slope` along x per
// unit of z (an object lying across the hand at a slant), half-size r across (y) and rx
// along the hand (x, default r); r 0 is a flat hand. The thumb runs along the far side
// of a thin object (a grip), the near side of a big one, or forward along the near side
// (`thumb`: 'side' / 'near' / 'forward'; by r when unset). client/anim/handfit.js fits them to
// each gun.
export const GRIP_CURL = { cy: HAND_GRIP_IN, r: 0.6, rx: 0.85 }; // a pistol grip (deeper than wide)
export const FLAT_CURL = { cy: 0, r: 0, rx: 0 };

// Each finger: its height, thickness and length share. Joints: the knuckle, then three
// segments (the first reaching the curl, the others along it).
const FINGERS = [[1.0, 0.36, 1], [0.33, 0.37, 1.04], [-0.33, 0.35, 0.97], [-0.95, 0.31, 0.84]];
const KNUCKLE = [3.35, 0.2];
const SEGMENTS = [1.15, 0.95]; // middle and outer joint lengths (the index finger)
const CLEARANCE = 0.08; // between a finger's surface and the object

const bind = (name) => {
  const i = A.bone(name);
  return [A.bind[i * 3], A.bind[i * 3 + 1], A.bind[i * 3 + 2]];
};

// A lighter or darker print of a color (folds, the rolled sleeve end): its own ink outline.
const shade = (c, k) => c.map((v) => Math.min(1, v * k));

// The finger and thumb joints of a right hand holding `curl`, in the hand frame:
// { fingers: [[knuckle, a, b, tip] per finger], thumb: [base, mid, tip], radius per finger }.
export function fingerJoints(curl) {
  const fingers = FINGERS.map(([z, r, k]) => {
    if (!curl.r) {
      return [[KNUCKLE[0], KNUCKLE[1], z], [KNUCKLE[0] + 1.2 * k, 0.25, z], [KNUCKLE[0] + 2.35 * k, 0.3, z],
        [KNUCKLE[0] + 3.2 * k, 0.32, z]];
    }
    const cx = (curl.cx ?? HAND_GRIP) + (curl.slope || 0) * z, cy = curl.cy;
    const ry = curl.r + r + CLEARANCE, rx = (curl.rx ?? curl.r) + r + CLEARANCE;
    // Around the object from a little past the knuckle's side, as far as the joints reach.
    const a0 = Math.atan2((KNUCKLE[1] - cy) / ry, (KNUCKLE[0] - cx) / rx) + 40 * Math.PI / 180;
    const rad = (rx + ry) / 2, a1 = a0 + SEGMENTS[0] * k / rad, a2 = a1 + SEGMENTS[1] * k / rad;
    const at = (a) => [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, z];
    return [[KNUCKLE[0], KNUCKLE[1], z], at(a0), at(a1), at(a2)];
  });
  let thumb;
  const side = curl.thumb ? curl.thumb === 'side' : curl.r <= 0.8;
  if (curl.thumb === 'forward') thumb = [[0.9, 0.45, 1.2], [2.1, 0.85, 1.55], [3.3, 0.95, 1.5]]; // along the near side
  else if (!curl.r) thumb = [[0.9, 0.45, 1.2], [1.9, 0.9, 1.9], [2.8, 1.0, 2.2]];
  else if (side) { // along the far side, above the fingers (a grip: the frame's side)
    const y = curl.cy + curl.r + 0.42;
    thumb = [[0.9, 0.45, 1.2], [2.0, y, 1.5], [3.1, y + 0.05, 1.45]];
  } else { // up the near side of a big object and forward along it (+z: toward a muzzle)
    const rad = (curl.rx ?? curl.r) + 0.45, ry = curl.r + 0.45, cy = curl.cy;
    const cx = (z) => (curl.cx ?? HAND_GRIP) + (curl.slope || 0) * z;
    thumb = [[0.9, 0.45, 1.2], [cx(2.1) - rad * 0.86, cy + ry * 0.12, 2.1], [cx(3.3) - rad * 0.78, cy + ry * 0.36, 3.3]];
  }
  return { fingers, thumb, radius: FINGERS.map((f) => f[1]) };
}

// A rounded segment from a to b (points [x, y, z]), radius r: a finger joint.
function segment(m, a, b, r, caps = 1) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const yaw = Math.atan2(dy, dx) * 180 / Math.PI, pitch = 90 - Math.asin(dz / len) * 180 / Math.PI;
  return m.push().translate(...a).rotate(pitch, yaw).translate(0, 0, -r * 0.6).capsule(r, len + r * 1.2, 8, caps).pop();
}

// Sleeves of both arms. team: 'T' or 'CT'.
export function buildArms(team) {
  const L = LOOKS[team];
  const b = new MeshBuilder().bevel(0.3);
  b.mirror((m) => {
    // The right arm (y < 0); the mirror makes the left.
    const [sx, sy, sz] = bind('arm_upper_R'), [ex] = bind('arm_lower_R'), [hx] = bind('hand_R');
    m.color(L.jacket).bone(A.bone('arm_upper_R')).push().translate(sx - 2, sy, sz).rotate(90)
      .capsule(2.6, ex - sx + 3, 12, 2).pop();
    // Forearm: a sleeve bulging below the elbow, tapering to a rolled end at the wrist.
    const fl = hx - ex - 1.4;
    m.bone(A.bone('arm_lower_R')).push().translate(ex - 0.5, sy, sz).rotate(90)
      .lathe([[2.35, 0], [2.5, fl * 0.3], [2.15, fl * 0.75], [1.95, fl]], 12).pop();
    m.color(shade(L.jacket, 1.18)).push().translate(ex - 0.5 + fl - 1.1, sy, sz).rotate(90)
      .lathe([[1.98, 0], [2.2, 0.3], [2.2, 0.9], [1.95, 1.2]], 12).pop();
    // Fold marks: thin lens shapes on the sleeve's top and outer side, below the elbow;
    // their outlines print as crease strokes.
    m.color(shade(L.jacket, 0.78));
    for (const [at, roll, tilt, s] of [[2.2, 15, 25, 1.5], [4.2, 70, -20, 1.3], [6.4, -25, 30, 1.1]]) {
      m.push().translate(ex + at, sy, sz).rotate(0, 0, roll).translate(0, 0, 2.3).rotate(0, tilt, 0)
        .scale(s, 0.12, 0.12).sphere(1, 6, 3).pop();
    }
    // Glove cuff over the wrist.
    m.color(L.gloves).push().translate(hx - 2.1, sy, sz).rotate(90).lathe([[1.85, 0], [1.98, 0.4], [1.78, 2.6]], 12).pop();
  }, 1, A.mirror);
  return b.build();
}

// One hand holding `curl` (GRIP_CURL, FLAT_CURL or a fitted one), on its hand bone; left:
// the left hand (the right one mirrored). team: 'T' or 'CT'.
export function buildHand(team, curl = GRIP_CURL, left = false) {
  const L = LOOKS[team];
  const skin = finish(SKIN, FINISH.SKIN);
  const fingers = team === 'T' ? skin : L.gloves;
  const b = new MeshBuilder().bevel(0.3);
  if (left) {
    b.scale(1, -1, 1);
    b.boneMap = A.mirror;
  }
  const [hx, sy, sz] = bind('hand_R');
  b.color(L.gloves).bone(A.bone('hand_R')).push().translate(hx, sy, sz);
  // Palm toward +y.
  b.rbox(3.6, 1.15, 3.0, 0.5, 1.75, -0.05, -0.05);
  if (team === 'T') b.color(shade(L.gloves, 1.45)).rbox(0.7, 1.25, 3.1, 0.25, 0.7, -0.05, -0.05, 1); // strap
  else b.color(shade(L.gloves, 1.6)).rbox(1.6, 0.4, 2.2, 0.18, 2.3, -0.62, -0.05, 1); // knuckle pad
  const j = fingerJoints(curl);
  j.fingers.forEach((p, i) => {
    const r = j.radius[i];
    b.color(L.gloves);
    segment(b, p[0], p[1], r);
    b.color(fingers);
    segment(b, p[1], p[2], r * 0.95);
    segment(b, p[2], p[3], r * 0.88, 2);
  });
  b.color(L.gloves);
  segment(b, j.thumb[0], j.thumb[1], 0.42);
  b.color(fingers);
  segment(b, j.thumb[1], j.thumb[2], 0.37, 2);
  b.pop();
  return b.build();
}
