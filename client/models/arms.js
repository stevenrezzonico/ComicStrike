// First-person arms on the view arm rig (client/anim/skeleton.js ARMS_SKELETON), built
// in its bind pose: arms pointing forward, palms facing in. Sleeves and gloves in the
// team's colors (client/models/players.js): the T's leather sleeves and fingerless
// gloves, the CT's navy sleeves and black gloves. The hands are shaped around a grip:
// palm, fingers curled over the front to the far side, thumb along the top. A held
// object's center sits HAND_GRIP ahead of the wrist and HAND_GRIP_IN in from the palm's
// axis (client/anim/viewanim.js places hands by these).

import { MeshBuilder } from '../gl/meshkit.js';
import { ARMS_SKELETON as A } from '../anim/skeleton.js';
import { LOOKS, SKIN } from './players.js';

export const HAND_GRIP = 1.8;
export const HAND_GRIP_IN = 1.25;

const bind = (name) => {
  const i = A.bone(name);
  return [A.bind[i * 3], A.bind[i * 3 + 1], A.bind[i * 3 + 2]];
};

// team: 'T' or 'CT'.
export function buildArms(team) {
  const L = LOOKS[team];
  const fingers = team === 'T' ? SKIN : L.gloves;
  const b = new MeshBuilder().bevel(0.3);
  b.mirror((m) => {
    // The right arm (y < 0); the mirror makes the left.
    const [sx, sy, sz] = bind('arm_upper_R'), [ex] = bind('arm_lower_R'), [hx] = bind('hand_R');
    m.color(L.jacket).bone(A.bone('arm_upper_R')).push().translate(sx - 2, sy, sz).rotate(90)
      .capsule(2.6, ex - sx + 3, 12, 2).pop();
    m.bone(A.bone('arm_lower_R')).push().translate(ex - 0.5, sy, sz).rotate(90)
      .lathe([[2.3, 0], [1.85, hx - ex - 1.4]], 12).pop();
    m.color(L.gloves).push().translate(hx - 2.1, sy, sz).rotate(90).lathe([[1.9, 0], [1.75, 2.6]], 12).pop(); // cuff
    // Hand, palm toward +y.
    m.bone(A.bone('hand_R')).push().translate(hx, sy, sz);
    m.box(3.6, 1.1, 3.1, 1.8, 0, 0); // palm and back
    m.color(fingers).box(1.1, 2.3, 2.9, 3.85, 0.85, -0.05); // fingers over the front
    m.box(2.6, 0.75, 2.7, 2.9, 2.35, -0.15); // finger tips on the far side
    m.box(2.5, 0.8, 0.85, 2.2, 1.5, 1.6); // thumb along the top
    m.pop();
  }, 1, A.mirror);
  return b.build();
}
