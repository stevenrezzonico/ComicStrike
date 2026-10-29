// Player models on the player skeleton (client/anim/skeleton.js), built in the bind
// T-pose, in comic form: a torso, arms and legs swept as single smooth tubes whose
// vertices blend between two bones (the spine bends, elbows and knees fold without
// seams), rounded heads with eyes, clothes in a few flat colors with crease marks.
// Proportions follow the hit boxes (shared/hitgroups.js): head 59..69, chest 41..59 and
// 22 wide, stomach 31..42, legs 0..31. The gun in hand is drawn separately
// (client/models/guns.js).

import { MeshBuilder, FINISH, finish } from '../gl/meshkit.js';
import { PLAYER_SKELETON as S } from '../anim/skeleton.js';

// How a weapon is held (client/anim/playeranim.js).
export const HOLD_RIFLE = 0;
export const HOLD_PISTOL = 1;
export const HOLD_KNIFE = 2;
export const HOLD_C4 = 3;
export const HOLD_TIED = 4; // hostages: hands tied behind the back

const SKIN = [0.78, 0.6, 0.47];
const BLACK = [0.1, 0.1, 0.11];
const EYE = [0.08, 0.07, 0.07];

// Phoenix (the concept's T): a red patterned shemagh over the head and face, olive jacket
// under a chest rig, tan cargo trousers, a red shoulder patch.
const T_LOOK = {
  head: finish([0.56, 0.2, 0.14], FINISH.PATTERN), jacket: [0.37, 0.39, 0.25], shirt: [0.37, 0.39, 0.25],
  vest: [0.24, 0.23, 0.15], pants: [0.6, 0.52, 0.37], gloves: [0.16, 0.13, 0.11], boots: [0.25, 0.18, 0.12],
  belt: [0.2, 0.16, 0.12], patch: [0.72, 0.16, 0.1],
};
// SAS-style CT: navy uniform, a dark plate carrier with pouches, black balaclava, knee pads;
// the helmet only with ANIM_HELMET.
const CT_LOOK = {
  head: BLACK, jacket: [0.23, 0.27, 0.36], shirt: [0.23, 0.27, 0.36], pants: [0.24, 0.28, 0.37],
  gloves: BLACK, boots: BLACK, belt: [0.15, 0.15, 0.16], vest: [0.13, 0.14, 0.17], pads: [0.14, 0.15, 0.17],
  helmet: [0.2, 0.23, 0.22], cap: [0.15, 0.15, 0.17],
};
// Hostage: a civilian in a light blue shirt and grey trousers, bare-headed.
const H_LOOK = {
  head: SKIN, jacket: [0.56, 0.64, 0.74], shirt: [0.56, 0.64, 0.74], pants: [0.3, 0.3, 0.33], gloves: SKIN,
  boots: [0.22, 0.16, 0.11], belt: [0.18, 0.13, 0.09], cap: [0.22, 0.16, 0.1],
};
export const LOOKS = { T: T_LOOK, CT: CT_LOOK, H: H_LOOK };
export { SKIN };

const B = (name) => S.bone(name);
const bind = (name) => {
  const i = S.bone(name);
  return [S.bind[i * 3], S.bind[i * 3 + 1], S.bind[i * 3 + 2]];
};
const shade = (c, k) => {
  const s = c.map((v) => Math.min(1, v * k));
  if (c.finish !== undefined) s.finish = c.finish;
  return s;
};

// Skinning along one coordinate: stops [[coordinate, bone], ...] in increasing order; a
// vertex blends linearly between the two stops around it.
function chain(axis, stops, abs = false) {
  const bones = stops.map(([, n]) => B(n));
  return (q) => {
    const c = abs ? Math.abs(q[axis]) : q[axis];
    if (c <= stops[0][0]) return [bones[0], bones[0], 0];
    for (let i = 0; i + 1 < stops.length; i++) {
      if (c <= stops[i + 1][0]) return [bones[i], bones[i + 1], (c - stops[i][0]) / (stops[i + 1][0] - stops[i][0])];
    }
    return [bones.at(-1), bones.at(-1), 0];
  };
}
const TORSO = chain(2, [[36, 'pelvis'], [40, 'spine_0'], [44.5, 'spine_1'], [49, 'spine_2'], [53.5, 'spine_3'],
  [59.5, 'neck_0']]);
const ARM = chain(1, [[3.5, 'spine_3'], [6.5, 'clavicle_L'], [9.5, 'arm_upper_L'], [17.5, 'arm_upper_L'],
  [21.5, 'arm_lower_L'], [29.5, 'arm_lower_L'], [31.5, 'hand_L']], true);
const LEG = chain(2, [[2.5, 'ankle_L'], [5.5, 'leg_lower_L'], [18, 'leg_lower_L'], [22, 'leg_upper_L'],
  [33, 'leg_upper_L'], [38, 'pelvis']]);

// A crease mark: a thin lens of a darker shade on the surface, its outline a stroke.
function fold(b, at, pitch, yaw, roll, len) {
  b.push().translate(...at).rotate(pitch, yaw, roll).scale(len, 0.13, 0.13).sphere(1, 6, 3).pop();
}

// Torso sections up the spine (width a across, depth b forward), as rounded boxes.
const TORSO_SECTIONS = [[33.5, 6.4, 4.3], [37, 7.4, 4.8], [41, 6.9, 4.5], [46, 7.6, 4.8], [51, 8.8, 5.4],
  [55, 9.2, 5.2], [58, 8, 4.4], [59.8, 3.4, 2.9]];
const torsoAt = (grow = 0, from = 0, to = TORSO_SECTIONS.length) => TORSO_SECTIONS.slice(from, to)
  .map(([z, a, bb]) => ({ at: [0, 0, z], a: a + grow, b: bb + grow, n: 3 }));

// team: 'T', 'CT' or 'H' (hostage); helmet: CTs show a helmet only when they own one.
// coarse: the far version (client/gl/playermodels.js past FAR_LOD): the same tubes and
// bones with fewer segments and without the small parts (crease marks, eyes, pouches,
// buckle, thumb), under 1,500 triangles; from a distance it prints the same silhouette.
export function buildPlayer(team, helmet = false, coarse = false) {
  const L = LOOKS[team] || T_LOOK;
  const b = new MeshBuilder().bevel(0.3);
  const fine = !coarse;
  const sg = (n) => (coarse ? Math.max(4, Math.round(n * 0.4)) : n); // segments

  // Torso: the trousers' hips, the jacket from the belt up, blended up the spine.
  b.skin(TORSO).color(L.pants).sweep(torsoAt(0, 0, 3), sg(16), [1, 0, 0]);
  b.color(L.jacket).sweep(torsoAt(-0.05, 2), sg(16), [1, 0, 0]);
  b.color(L.belt).sweep([{ at: [0, 0, 39.2], a: 7.25, b: 4.75, n: 3 }, { at: [0, 0, 40.6], a: 7.1, b: 4.65, n: 3 }], sg(16),
    [1, 0, 0], 'flat');
  if (fine) {
    b.color(shade(L.belt, 1.6)).rbox(0.5, 1.6, 1.2, 0.2, 4.8, 0, 39.9, 1); // buckle
    // Crease marks at the waist and the chest.
    b.color(shade(L.jacket, 0.75));
    fold(b, [5.2, -2.5, 43], 15, 0, 0, 1.6);
    fold(b, [5.0, 2.8, 44.5], -12, 0, 0, 1.4);
  }
  if (L.vest) { // chest rig / plate carrier over the jacket, pouches on the front
    b.color(L.vest).sweep(torsoAt(0.45, 2, 7), sg(16), [1, 0, 0], 'flat');
    if (fine) {
      b.color(shade(L.vest, 1.25));
      for (const y of [-3.2, 0, 3.2]) b.rbox(1.5, 2.6, 3.4, 0.5, 5.9, y, 46.5, 1);
      if (team === 'CT') b.rbox(1.2, 3, 2.2, 0.4, 5.9, -4.3, 52, 1); // radio pouch
      b.color(L.vest).rbox(2.2, 3, 1.2, 0.5, 0, 6, 58.2, 1).rbox(2.2, 3, 1.2, 0.5, 0, -6, 58.2, 1); // shoulder straps
    }
  } else if (fine) {
    b.color(shade(L.jacket, 1.12)).sweep([{ at: [0, 0, 57.8], a: 4.2, b: 3.4 }, { at: [0, 0, 59.4], a: 3.9, b: 3.1 }],
      12, [1, 0, 0], 'flat'); // shirt collar
  }
  b.skin();

  // Neck and head.
  b.bone(B('neck_0')).color(team === 'H' ? SKIN : L.head).push().translate(0.3, 0, 58).lathe([[2.2, 0], [2.0, 3.6]], sg(12)).pop();
  b.bone(B('head_0')).color(L.head).push().translate(1, 0, 0)
    .lathe([[0, 59.4], [2.6, 59.9], [3.7, 61.2], [4.2, 63.2], [4.2, 65.8], [3.6, 67.9], [2.3, 69.1], [0, 69.5]], sg(16)).pop();
  const eyes = (z) => {
    if (coarse) return;
    b.color(EYE);
    for (const y of [-1.1, 1.1]) b.push().translate(5.05, y, z).scale(0.3, 0.42, 0.55).sphere(1, 8, 4).pop();
  };
  if (team === 'H') { // bare head: hair, ears, nose
    b.color(L.cap).push().translate(0.8, 0, 0).lathe([[4.45, 64.4], [4.4, 66.4], [3.6, 68.6], [2.1, 69.7], [0, 70]], sg(16)).pop();
    if (fine) {
      b.color(SKIN);
      for (const y of [-4.1, 4.1]) b.push().translate(0.8, y, 64.3).scale(0.5, 0.35, 0.9).sphere(1, 8, 4).pop();
      b.push().translate(5.2, 0, 63.6).scale(0.55, 0.45, 0.75).sphere(1, 8, 4).pop();
    }
    eyes(65.1);
  } else { // a face cover with an eye slit
    b.color(SKIN).push().translate(4.55, 0, 64.9).scale(0.7, 2.7, 0.85).sphere(1, sg(12), coarse ? 3 : 6).pop();
    eyes(64.95);
    if (team === 'T') { // the shemagh: a muffle over the mouth, a tail down the back
      b.color(L.head).push().translate(4.2, 0, 61.8).scale(1.1, 3.2, 1.7).sphere(1, sg(12), coarse ? 3 : 6).pop();
      b.sweep([{ at: [-3.4, 0, 64], a: 2, b: 0.7 }, { at: [-4.1, 0, 60.5], a: 1.9, b: 0.7 }, { at: [-4.3, 0, 57.5], a: 1.5, b: 0.5 }],
        sg(8), [-1, 0, 0]);
    }
  }
  if (team === 'CT' && helmet) {
    b.color(L.helmet).push().translate(1, 0, 0).lathe([[4.75, 64.6], [4.85, 66.4], [3.95, 68.7], [2.2, 69.9], [0, 70.4]], sg(16)).pop();
    b.color(BLACK).rbox(1, 6.8, 1.5, 0.4, 5.15, 0, 65, 1); // goggles band
    if (fine) {
      b.color(finish([0.42, 0.6, 0.74], FINISH.METAL));
      for (const y of [-1.4, 1.4]) b.push().translate(5.6, y, 65).scale(0.2, 1.1, 0.6).sphere(1, 10, 4).pop();
    }
  } else if (team === 'CT') {
    b.color(L.cap).push().translate(1, 0, 0).lathe([[4.35, 65.8], [3.7, 68.6], [2, 69.6], [0, 69.9]], sg(16)).pop();
  }

  b.mirror((m) => {
    // Arms (T-pose along +y), one tube from the shoulder to the wrist.
    const [, sy, sz] = bind('arm_upper_L'), [, ey] = bind('arm_lower_L'), [, hy] = bind('hand_L');
    m.skin(ARM).color(L.jacket).sweep([{ at: [0, sy - 2, sz - 0.3], a: 3.1, b: 3.3 }, { at: [0, sy + 1.5, sz], a: 2.8, b: 2.9 },
      { at: [0, sy + 6.5, sz], a: 2.65, b: 2.75 }, { at: [0, ey, sz], a: 2.25, b: 2.35 }, { at: [0, ey + 3.5, sz], a: 2.4, b: 2.35 },
      { at: [0, hy - 2.2, sz], a: 1.85, b: 1.95 }], sg(12));
    if (fine) {
      m.color(shade(L.jacket, team === 'H' ? 1.08 : 1.18)).push().translate(0, hy - 3.2, sz).rotate(0, 0, -90)
        .lathe([[2.05, 0], [2.2, 0.3], [2.2, 1.0], [2.0, 1.3]], 12).pop(); // sleeve end
      if (L.patch) m.color(L.patch).push().translate(0, sy + 3.5, sz + 2.8).scale(1.4, 1.4, 0.35).sphere(1, 8, 4).pop();
      m.color(shade(L.jacket, 0.75));
      fold(m, [1.9, ey - 0.6, sz + 0.9], 0, 70, 30, 1.5); // the elbow's crease
      fold(m, [1.6, ey + 1.6, sz + 1.4], 0, 60, 20, 1.2);
    }
    m.color(L.gloves).push().translate(0, hy - 1.6, sz).rotate(0, 0, -90).lathe([[1.9, 0], [1.95, 0.4], [1.8, 1.8]], sg(12)).pop();
    m.skin();
    // A gloved fist and the thumb along it.
    m.bone(B('hand_L')).rbox(3.1, 3.5, 3.1, 1.05, 0, hy + 1.6, sz, 1);
    if (fine) m.push().translate(1.4, hy + 0.6, sz + 0.9).rotate(90, 70).capsule(0.6, 2.4, 8, 2).pop();

    // Legs, one tube from the hip to the ankle.
    const [, ly] = bind('leg_upper_L');
    m.skin(LEG).color(L.pants).sweep([{ at: [0, ly, 37.5], a: 4, b: 4.3 }, { at: [0.2, ly + 0.2, 31], a: 3.8, b: 4 },
      { at: [0.2, ly, 24], a: 3.3, b: 3.5 }, { at: [0.3, ly, 20], a: 2.95, b: 3.15 }, { at: [-0.1, ly, 15], a: 2.9, b: 3.2 },
      { at: [0, ly, 8], a: 2.4, b: 2.6 }, { at: [0, ly, 4.5], a: 2.25, b: 2.35 }], sg(12), [1, 0, 0]);
    if (fine) {
      m.color(shade(L.pants, 0.75));
      fold(m, [3.3, ly + 0.8, 33.5], 20, 0, 90, 1.6); // hip crease
      fold(m, [-2.9, ly, 21], 0, 90, 0, 1.4); // behind the knee
      fold(m, [3.0, ly - 0.6, 25], -25, 0, 90, 1.2);
      if (team === 'T') m.color(shade(L.pants, 0.88)).rbox(4, 1.6, 4.6, 0.6, 0, ly + 3.8, 27, 1); // cargo pocket
      if (L.pads) m.color(L.pads).rbox(1.6, 4.2, 4.2, 0.7, 3.1, ly, 20, 1); // knee pad
    }
    m.skin();
    // Boot: a shaft round the ankle, the foot, a thick sole.
    m.bone(B('ankle_L')).color(L.boots).push().translate(0, ly, 2).lathe([[2.5, 0], [2.4, 4.8]], sg(12)).pop();
    m.rbox(8.6, 4.4, 3.4, 1.3, 1.8, ly, 2.1, coarse ? 1 : 2);
    m.color(shade(L.boots, 0.55)).rbox(9.2, 4.7, 0.9, 0.35, 1.9, ly, 0.45, 1);
  }, 1, S.mirror);
  return b.build();
}
