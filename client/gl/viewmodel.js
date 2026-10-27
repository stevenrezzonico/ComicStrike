// First-person weapon models built from boxes (zero assets), drawn in eye space with
// their own projection after the world. All weapons live in one static VBO.

import { program } from './program.js';
import { VIEWMODEL_VS, VIEWMODEL_FS } from './shaders.js';
import { perspective } from './mat4.js';
import { WEAPONS, SLOT_SECONDARY } from '../../shared/weapons.js';

const METAL = [0.2, 0.2, 0.22];
const BLACK = [0.1, 0.1, 0.11];
const STEEL = [0.68, 0.7, 0.74];
const WOOD = [0.46, 0.27, 0.12];
const POLYMER = [0.16, 0.16, 0.15];
const GLOVE = [0.13, 0.12, 0.1];
const SLEEVE = [0.34, 0.31, 0.22];
const FLASH = [1.0, 0.75, 0.3];
const C4_TAN = [0.52, 0.47, 0.3];
const LED = [0.9, 0.08, 0.05];

// No two boxes may share a face plane where they overlap (z-fighting).
// Boxes in weapon space (x forward, y left, z up, inches): [cx, cy, cz, sx, sy, sz, color, pitchDeg].
const HANDS_RIFLE = [
  [10.5, -0.3, -3.6, 3.2, 2.4, 3.0, GLOVE, 15],
  [20, 0.2, -1.7, 4.2, 2.8, 2.2, GLOVE, 0],
  [12, 4.5, -6.5, 14, 3.2, 3.2, SLEEVE, -20],
];
const HANDS_PISTOL = [
  [9.5, -0.3, -3.0, 3.0, 2.4, 3.4, GLOVE, 15],
  [10, 1.0, -3.4, 3.0, 2.0, 2.8, GLOVE, 15],
  [4, 2.5, -7, 10, 3.2, 3.2, SLEEVE, -25],
];

const MODELS = {
  ak47: {
    offset: [0, -6, -6.5], muzzle: [32.5, 0, 0.6],
    boxes: [
      [14, 0, 0, 10, 1.6, 2.2, METAL], [25, 0, 0.5, 14, 0.6, 0.6, METAL], [21, 0, 1.3, 7, 0.7, 0.6, METAL],
      [20, 0, 0, 6, 1.8, 1.8, WOOD], [15, 0, -3.2, 2, 1.2, 5, METAL, -15], [4.5, 0, -0.6, 7, 1.4, 2.4, WOOD],
      [10.5, 0, -2.6, 1.4, 1.2, 3.2, WOOD, 15], [31, 0, 1.4, 0.4, 0.3, 1, METAL], ...HANDS_RIFLE,
    ],
  },
  m4a1: {
    offset: [0, -6, -6.5], muzzle: [32.5, 0, 0.4],
    boxes: [
      [14, 0, 0, 10, 1.6, 2.4, BLACK], [13, 0, 2.0, 6, 0.8, 1.2, BLACK], [25, 0, 0.4, 14, 0.6, 0.6, METAL],
      [20, 0, 0.15, 6, 2.0, 2.0, POLYMER], [15, 0, -3, 1.8, 1.2, 4.2, BLACK, -5], [4.5, 0, -0.4, 7, 1.4, 2.2, POLYMER],
      [10.5, 0, -2.6, 1.4, 1.2, 3.2, POLYMER, 15], ...HANDS_RIFLE,
    ],
  },
  glock: {
    offset: [5, -4.5, -4.2], muzzle: [15.7, 0, 0],
    boxes: [
      [12, 0, 0, 7, 1.1, 1.3, BLACK], [11.6, 0, -0.9, 6, 1.0, 0.8, POLYMER], [9.5, 0, -2.6, 1.6, 1.0, 3.2, POLYMER, 15],
      ...HANDS_PISTOL,
    ],
  },
  usp_silencer: {
    offset: [5, -4.5, -4.2], muzzle: [21.7, 0, 0.2],
    boxes: [
      [12, 0, 0, 7, 1.1, 1.3, METAL], [11.6, 0, -0.9, 6, 1.0, 0.8, POLYMER], [9.5, 0, -2.6, 1.6, 1.0, 3.2, POLYMER, 15],
      [18.6, 0, 0.2, 6, 1.0, 1.0, BLACK], ...HANDS_PISTOL,
    ],
  },
  c4: {
    offset: [3, -3.5, -6], muzzle: null,
    boxes: [
      [12, 0, 0, 7, 4.6, 3, C4_TAN], [12.6, 0, 1.8, 3.8, 3.2, 0.5, BLACK], [10, 1.6, 1.8, 0.5, 0.5, 0.5, LED],
      [8.3, -0.6, -0.25, 2.4, 2.6, 3.3, GLOVE], [15.8, 0.4, -0.4, 2.2, 2.6, 3.0, GLOVE],
      [2, 2.5, -4.5, 10, 3.2, 3.2, SLEEVE, -25],
    ],
  },
  knife: {
    offset: [7, -5.5, -4.5], muzzle: null,
    boxes: [
      [8, 0, -1, 3.5, 1, 1.2, BLACK], [10.05, 0, -0.8, 0.5, 1.2, 2, METAL], [14, 0, -0.6, 7, 0.3, 1.4, STEEL],
      [8, -0.2, -1.2, 3.4, 2.4, 2.6, GLOVE], [2, 2.5, -4, 10, 3.2, 3.2, SLEEVE, -25],
    ],
  },
};

const FACES = [ // normal, then 4 corners as +-1 signs on (x, y, z)
  [1, 0, 0, [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
  [-1, 0, 0, [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]]],
  [0, 1, 0, [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]]],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  [0, 0, 1, [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]],
  [0, 0, -1, [[1, 1, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1]]],
];

// Appends a box as 36 vertices (pos, normal, color) converted to GL eye space.
function pushBox(out, [cx, cy, cz, sx, sy, sz, col, pitchDeg = 0], offset) {
  const a = pitchDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  // Pitch about the weapon's y axis (nose down for positive angles).
  const rot = (x, z) => [x * ca + z * sa, -x * sa + z * ca];
  for (const [nx, ny, nz, corners] of FACES) {
    const [rnx, rnz] = rot(nx, nz);
    const verts = corners.map(([ux, uy, uz]) => {
      const [rx, rz] = rot(ux * sx * 0.5, uz * sz * 0.5);
      return [cx + rx + offset[0], cy + uy * sy * 0.5 + offset[1], cz + rz + offset[2]];
    });
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const [x, y, z] = verts[k];
      // weapon (fwd, left, up) -> eye (right, up, back)
      out.push(-y, z, -x, -ny, rnz, -rnx, col[0], col[1], col[2]);
    }
  }
}

export class Viewmodel {
  constructor(gl) {
    this.gl = gl;
    this.prog = program(gl, VIEWMODEL_VS, VIEWMODEL_FS, ['u_proj', 'u_model', 'u_light', 'u_emissive']);
    this.proj = new Float32Array(16);
    this.model = new Float32Array(16);
    this.ranges = new Int32Array(WEAPONS.length * 4); // first, count, flashFirst, flashCount

    const verts = [];
    WEAPONS.forEach((w, id) => {
      // Guns without their own boxes yet borrow a pistol or rifle model.
      const m = w && (MODELS[w.name] || MODELS[w.slot === SLOT_SECONDARY ? 'glock' : 'm4a1']);
      if (!m) return;
      this.ranges[id * 4] = verts.length / 9;
      for (const b of m.boxes) pushBox(verts, b, m.offset);
      this.ranges[id * 4 + 1] = verts.length / 9 - this.ranges[id * 4];
      if (m.muzzle) {
        const [mx, my, mz] = m.muzzle;
        this.ranges[id * 4 + 2] = verts.length / 9;
        pushBox(verts, [mx + 1.5, my, mz, 3, 0.2, 1.8, FLASH], m.offset);
        pushBox(verts, [mx + 1.5, my, mz, 3, 1.8, 0.2, FLASH], m.offset);
        this.ranges[id * 4 + 3] = verts.length / 9 - this.ranges[id * 4 + 2];
      }
    });

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 36, i * 12);
    }
    gl.bindVertexArray(null);
  }

  // anim: { x, y, z (eye-space offset), pitch, yaw, roll (degrees, about the grip), flash (bool) }
  draw(weaponId, aspect, anim, light) {
    const count = this.ranges[weaponId * 4 + 1];
    if (!count) return;
    const gl = this.gl;
    perspective(this.proj, 54 * Math.PI / 180, aspect, 1, 128);
    this.buildModel(anim);

    gl.clear(gl.DEPTH_BUFFER_BIT); // never clip into walls
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_proj, false, this.proj);
    gl.uniformMatrix4fv(this.prog.loc.u_model, false, this.model);
    gl.uniform1f(this.prog.loc.u_light, light);
    gl.uniform1f(this.prog.loc.u_emissive, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, this.ranges[weaponId * 4], count);

    if (anim.flash && this.ranges[weaponId * 4 + 3]) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.uniform1f(this.prog.loc.u_emissive, 1);
      gl.drawArrays(gl.TRIANGLES, this.ranges[weaponId * 4 + 2], this.ranges[weaponId * 4 + 3]);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
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
