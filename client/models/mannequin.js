// Low-poly mannequin on the player skeleton: the mesh toolkit's first model, kept as a
// reference rig (bone placement, limb directions) for the real player models of 8d.

import { MeshBuilder } from '../gl/meshkit.js';
import { PLAYER_SKELETON } from '../anim/skeleton.js';

export function buildMannequin(body, skin = [0.78, 0.6, 0.48], dark = [0.16, 0.16, 0.17]) {
  const S = PLAYER_SKELETON;
  const b = new MeshBuilder();
  const at = (name) => {
    const i = S.bone(name);
    return [S.bind[i * 3], S.bind[i * 3 + 1], S.bind[i * 3 + 2]];
  };

  // Torso: pelvis and chest slabs, neck and head.
  b.color(dark).bone(S.bone('pelvis')).push().translate(0, 0, 37.5).slab(8, 13, 7, 2.5).pop();
  b.color(body).bone(S.bone('spine_1')).push().translate(0, 0, 47).slab(9, 14, 13, 3).pop();
  b.bone(S.bone('spine_3')).push().translate(0, 0, 56).slab(10, 16, 6, 3).pop();
  b.color(skin).bone(S.bone('neck_0')).push().translate(0, 0, 58.5).lathe([[1.8, 0], [1.8, 3.5]], 6).pop();
  b.bone(S.bone('head_0')).push().translate(0.6, 0, 61.5).lathe([[0, 0], [3, 0.8], [3.5, 4], [3, 7.5], [0, 8.6]], 8).pop();

  // Limbs, mirrored to the right side.
  b.mirror((m) => {
    const [, sy, sz] = at('arm_upper_L'), [, ey] = at('arm_lower_L'), [, hy] = at('hand_L');
    m.color(body).bone(S.bone('arm_upper_L')).push().translate(0, sy - 1, sz).rotate(0, 0, -90).capsule(2.3, ey - sy + 2, 6, 1).pop();
    m.bone(S.bone('arm_lower_L')).push().translate(0, ey - 1, sz).rotate(0, 0, -90).capsule(2, hy - ey + 1, 6, 1).pop();
    m.color(dark).bone(S.bone('hand_L')).push().translate(0, hy + 1.8, sz).box(2.2, 3.6, 3).pop();
    const [, ly, lz] = at('leg_upper_L'), [, , kz] = at('leg_lower_L'), [, , az] = at('ankle_L');
    m.color(dark).bone(S.bone('leg_upper_L')).push().translate(0, ly, kz - 1).capsule(3, lz - kz + 2, 6, 1).pop();
    m.bone(S.bone('leg_lower_L')).push().translate(0, ly, az).capsule(2.5, kz - az + 1, 6, 1).pop();
    m.bone(S.bone('ankle_L')).push().translate(2, ly, 1.75).slab(8, 3.6, 3.5, 1.2).pop();
  }, 1, S.mirror);
  return b.build();
}
