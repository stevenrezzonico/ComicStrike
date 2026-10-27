// First-person weapon: the gun model (client/gl/gunmeshes.js) placed in the hands,
// drawn in eye space with its own projection after the world, cartoon-shaded and lit
// by the map like everything else. The hands are simple boxes until the first-person
// arms (Phase 8f).

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import { perspective, multiply } from './mat4.js';
import { WEAPONS, SLOT_SECONDARY, SLOT_KNIFE, SLOT_C4 } from '../../shared/weapons.js';

const GLOVE = [0.13, 0.12, 0.1];
const SLEEVE = [0.34, 0.31, 0.22];

// Per hold, in weapon space (x forward, y left, z up, inches): where the weapon space
// sits relative to the eye (offset), where the gun's grip goes (grip) and the hand boxes
// [cx, cy, cz, sx, sy, sz, color, pitch].
const HOLDS = {
  rifle: {
    offset: [0, -6, -6.5], grip: [10.8, 0, -1.0],
    hands: [[10.5, -0.3, -3.6, 3.2, 2.4, 3.0, GLOVE, 15], [20, 0.2, -1.7, 4.2, 2.8, 2.2, GLOVE, 0],
      [12, 4.5, -6.5, 14, 3.2, 3.2, SLEEVE, -20]],
  },
  pistol: {
    offset: [5, -4.5, -4.2], grip: [9.9, 0, -1.0],
    hands: [[9.5, -0.3, -3.0, 3.0, 2.4, 3.4, GLOVE, 15], [10, 1.0, -3.4, 3.0, 2.0, 2.8, GLOVE, 15],
      [4, 2.5, -7, 10, 3.2, 3.2, SLEEVE, -25]],
  },
  knife: {
    offset: [7, -5.5, -4.5], grip: [7.4, 0, -1.0],
    hands: [[8, -0.2, -1.2, 3.4, 2.4, 2.6, GLOVE, 0], [2, 2.5, -4, 10, 3.2, 3.2, SLEEVE, -25]],
  },
  c4: {
    offset: [3, -3.5, -6], grip: [9, 0, 0],
    hands: [[8.3, -0.6, -0.25, 2.4, 2.6, 3.3, GLOVE, 0], [15.8, 0.4, -0.4, 2.2, 2.6, 3.0, GLOVE, 0],
      [2, 2.5, -4.5, 10, 3.2, 3.2, SLEEVE, -25]],
  },
};

function holdOf(w) {
  if (w.slot === SLOT_KNIFE) return 'knife';
  if (w.slot === SLOT_C4) return 'c4';
  return w.slot === SLOT_SECONDARY ? 'pistol' : 'rifle';
}

// Weapon space -> eye space (right, up, back) after a translation by t.
function place([tx, ty, tz]) {
  const m = new Float32Array(16);
  // x -> (0, 0, -1), y -> (-1, 0, 0), z -> (0, 1, 0)
  m[2] = -1;
  m[4] = -1;
  m[9] = 1;
  m[12] = -ty;
  m[13] = tz;
  m[14] = -tx;
  m[15] = 1;
  return m;
}

export class Viewmodel {
  // guns: GunMeshes.
  constructor(gl, guns) {
    this.gl = gl;
    this.guns = guns;
    this.renderer = new SkinnedRenderer(gl);
    this.proj = new Float32Array(16);
    this.fovY = 54 * Math.PI / 180;
    this.model = new Float32Array(16); // animation (eye space)
    this.tmp = new Float32Array(16);
    this.hands = {};
    this.handsAt = {};
    this.gunAt = {};
    for (const [name, h] of Object.entries(HOLDS)) {
      const b = new MeshBuilder();
      for (const [cx, cy, cz, sx, sy, sz, col, pitch] of h.hands) {
        b.color(col).push().translate(cx, cy, cz).rotate(pitch).box(sx, sy, sz).pop();
      }
      this.hands[name] = new SkinnedMesh(gl, b.build());
      this.handsAt[name] = place(h.offset);
      this.gunAt[name] = place([h.offset[0] + h.grip[0], h.offset[1] + h.grip[1], h.offset[2] + h.grip[2]]);
    }
    this.holdOf = WEAPONS.map((w) => (w ? holdOf(w) : null));
  }

  // anim: { x, y, z (eye-space offset), pitch, yaw, roll (degrees, about the grip), flash };
  // light: rgb from the map at the player.
  draw(weaponId, aspect, anim, light) {
    const hold = this.holdOf[weaponId], gun = this.guns.mesh[weaponId];
    if (!hold || !gun) return;
    const gl = this.gl, r = this.renderer;
    perspective(this.proj, this.fovY, aspect, 1, 128);
    this.buildModel(anim);

    gl.clear(gl.DEPTH_BUFFER_BIT); // never clip into walls
    r.begin(this.proj);
    r.draw(this.hands[hold], multiply(this.tmp, this.model, this.handsAt[hold]), IDENTITY_SKIN, light);
    multiply(this.tmp, this.model, this.gunAt[hold]);
    r.draw(gun, this.tmp, IDENTITY_SKIN, light);
    const flash = this.guns.flash[weaponId];
    if (anim.flash && flash) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      r.draw(flash, this.tmp, IDENTITY_SKIN, light, 1);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    r.end();
  }

  // Model matrix: rotate about a pivot near the grip, then translate.
  buildModel(a) {
    const DEG = Math.PI / 180;
    const cp = Math.cos(a.pitch * DEG), sp = Math.sin(a.pitch * DEG);
    const cy = Math.cos(a.yaw * DEG), sy = Math.sin(a.yaw * DEG);
    const cr = Math.cos(a.roll * DEG), sr = Math.sin(a.roll * DEG);
    // R = Ry(yaw) * Rx(pitch) * Rz(roll), column-major.
    const m = this.model;
    m[0] = cy * cr + sy * sp * sr; m[1] = cp * sr; m[2] = -sy * cr + cy * sp * sr; m[3] = 0;
    m[4] = -cy * sr + sy * sp * cr; m[5] = cp * cr; m[6] = sy * sr + cy * sp * cr; m[7] = 0;
    m[8] = sy * cp; m[9] = -sp; m[10] = cy * cp; m[11] = 0;
    const px = 6, py = -6, pz = -12; // pivot (eye space)
    m[12] = px - (m[0] * px + m[4] * py + m[8] * pz) + a.x;
    m[13] = py - (m[1] * px + m[5] * py + m[9] * pz) + a.y;
    m[14] = pz - (m[2] * px + m[6] * py + m[10] * pz) + a.z;
    m[15] = 1;
  }
}
