// Player models on the player skeleton (client/anim/skeleton.js), built in the bind
// T-pose: CS:GO's default looks in flat cartoon form, a few colors each. Proportions
// follow the hit boxes (shared/hitgroups.js): head 59..69, chest 41..59 and 22 wide,
// stomach 31..42, legs 0..31. The gun in hand is drawn separately (client/models/guns.js).

import { MeshBuilder } from '../gl/meshkit.js';
import { PLAYER_SKELETON as S } from '../anim/skeleton.js';

// How a weapon is held (client/anim/playeranim.js).
export const HOLD_RIFLE = 0;
export const HOLD_PISTOL = 1;
export const HOLD_KNIFE = 2;
export const HOLD_C4 = 3;

const SKIN = [0.78, 0.6, 0.47];
const BLACK = [0.1, 0.1, 0.11];

// Phoenix Connexion: balaclava, dark leather jacket, khaki cargo trousers.
const T_LOOK = {
  head: [0.13, 0.13, 0.14], jacket: [0.3, 0.22, 0.17], shirt: [0.42, 0.36, 0.28], pants: [0.45, 0.4, 0.29],
  gloves: [0.16, 0.13, 0.11], boots: [0.17, 0.14, 0.12], belt: [0.2, 0.16, 0.12],
};
// SAS-style CT: navy uniform, olive vest, black gloves and boots.
const CT_LOOK = {
  head: SKIN, jacket: [0.23, 0.27, 0.35], shirt: [0.23, 0.27, 0.35], pants: [0.25, 0.29, 0.36],
  gloves: BLACK, boots: BLACK, belt: [0.17, 0.18, 0.15], vest: [0.31, 0.33, 0.24], pads: [0.15, 0.16, 0.17],
  helmet: [0.2, 0.23, 0.22], cap: [0.15, 0.15, 0.17],
};

const bind = (name) => {
  const i = S.bone(name);
  return [S.bind[i * 3], S.bind[i * 3 + 1], S.bind[i * 3 + 2]];
};

// team: 'T' or 'CT'; helmet: CTs show a helmet only when they own one.
export function buildPlayer(team, helmet = false) {
  const L = team === 'CT' ? CT_LOOK : T_LOOK;
  const b = new MeshBuilder();
  const at = (name) => b.bone(S.bone(name));

  // Hips, belly, chest, shoulders.
  at('pelvis').color(L.pants).push().translate(0, 0, 36.5).slab(9, 15, 7, 3).pop();
  b.color(L.belt).push().translate(0, 0, 40.4).slab(9.6, 15.6, 1.6, 3).pop();
  at('spine_0').color(L.shirt).push().translate(0, 0, 43.5).slab(8.6, 14.5, 5, 3).pop();
  at('spine_2').color(L.jacket).push().translate(0, 0, 50).slab(10, 17, 9, 3.5).pop();
  at('spine_3').push().translate(0, 0, 56).slab(9.5, 18.5, 4.2, 3.5).pop();
  if (team === 'CT') {
    at('spine_2').color(L.vest).push().translate(0.3, 0, 49.5).slab(11.4, 17.6, 11, 3.5).pop();
    b.push().translate(5.6, 0, 46).box(1.4, 9, 3.6).pop(); // magazine pouches
    at('spine_3').push().translate(0, 0, 56.2).slab(10.2, 15, 3, 3).pop();
  } else {
    b.color(L.jacket).push().translate(4.8, 0, 52).box(0.8, 3, 9).pop(); // jacket zip panel
  }

  // Neck and head.
  at('neck_0').color(L.head).push().translate(0, 0, 58).lathe([[2.1, 0], [2.1, 3]], 6).pop();
  at('head_0').push().translate(1, 0, 0)
    .lathe([[0, 59.6], [3.2, 60.4], [4.1, 62.8], [4.1, 66.3], [2.8, 68.6], [0, 69.3]], 8).pop();
  if (team === 'T') {
    b.color(SKIN).push().translate(4.7, 0, 64.8).box(1, 5.4, 1.7).pop(); // the balaclava's eye slit
  } else if (helmet) {
    b.color(L.helmet).push().translate(1, 0, 0)
      .lathe([[4.7, 64.4], [4.8, 66.4], [3.9, 68.7], [2.2, 69.8], [0, 70.3]], 8).pop();
    b.color(BLACK).push().translate(4.9, 0, 64.9).box(1, 6.6, 1.6).pop(); // goggles
  } else {
    b.color(L.cap).push().translate(1, 0, 0).lathe([[4.3, 65.8], [3.6, 68.6], [2, 69.6], [0, 69.9]], 8).pop();
  }

  b.mirror((m) => {
    // Arms (T-pose along +y).
    const [, sy, sz] = bind('arm_upper_L'), [, ey] = bind('arm_lower_L'), [, hy] = bind('hand_L');
    m.color(L.jacket).bone(S.bone('arm_upper_L')).push().translate(0, sy - 1.5, sz).rotate(0, 0, -90)
      .capsule(2.6, ey - sy + 2.5, 6, 1).pop();
    m.bone(S.bone('arm_lower_L')).push().translate(0, ey - 1, sz).rotate(0, 0, -90).capsule(2.2, hy - ey + 1, 6, 1).pop();
    m.color(L.gloves).bone(S.bone('hand_L')).push().translate(0, hy + 1.6, sz).box(3, 3.4, 3.2).pop();
    // Legs.
    const [, ly, lz] = bind('leg_upper_L'), [, , kz] = bind('leg_lower_L'), [, , az] = bind('ankle_L');
    m.color(L.pants).bone(S.bone('leg_upper_L')).push().translate(0, ly, kz - 1).capsule(3.5, lz - kz + 2.5, 6, 1).pop();
    m.bone(S.bone('leg_lower_L')).push().translate(0, ly, az + 1).capsule(2.9, kz - az + 0.5, 6, 1).pop();
    if (team === 'CT') m.color(L.pads).push().translate(2.6, ly, kz).box(1.6, 4.4, 4.4).pop();
    if (team === 'T') m.color(L.pants).push().translate(0, ly + 3.4, 27).box(4, 1.6, 5).pop(); // cargo pocket
    m.color(L.boots).bone(S.bone('ankle_L')).push().translate(1.8, ly, 2.6).slab(9, 4.4, 5.2, 1.6).pop();
  }, 1, S.mirror);
  return b.build();
}
