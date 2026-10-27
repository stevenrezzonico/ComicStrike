// Other players drawn as their hitboxes (what you see is what you can hit), plus the
// bomb when it lies on the ground: one instanced draw using the debris cube shader.
// Placeholder until Phase 7's models.

import { program } from './program.js';
import { DEBRIS_VS, DEBRIS_FS } from './shaders.js';
import { TEAM_CT } from '../../shared/player.js';
import { BOX_DATA, BOX_STRIDE, HITGROUP_HEAD, feetOffset, crouchScale } from '../../shared/hitgroups.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_YAW, E_FLAGS, E_DUCK, E_HEALTH, E_TEAM, E_FIELDS, dequantizeYaw,
} from '../../shared/protocol.js';

const I = 12; // instance floats: pos, scale, rot, color
const T_COLOR = [0.72, 0.58, 0.36];
const CT_COLOR = [0.34, 0.45, 0.66];
const EXTRA_BOXES = 8; // the bomb
// C4 boxes [forward, left, bottom, size x, y, z, color]: explosive brick, keypad, LED.
const C4_BOXES = [
  [0, 0, 0, 12, 7, 3.5, [0.52, 0.47, 0.3]],
  [1, 0, 3.5, 5, 4, 0.8, [0.08, 0.08, 0.09]],
  [-4, 2, 3.5, 1, 1, 1, null],
];
const LED_ON = [1.6, 0.1, 0.05];
const LED_OFF = [0.35, 0.05, 0.03];

export class Players {
  constructor(gl) {
    this.gl = gl;
    this.count = 0;
    this.inst = new Float32Array((MAX_PLAYERS * (BOX_DATA.length / BOX_STRIDE) + EXTRA_BOXES) * I);
    this.prog = program(gl, DEBRIS_VS, DEBRIS_FS, ['u_viewProj']);

    const cube = [];
    for (const [n, u, v] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) {
      for (const s of [-1, 1]) {
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
          const p = [0, 0, 0], nrm = [0, 0, 0];
          p[n] = s * 0.5;
          p[u] = a * 0.5;
          p[v] = b * 0.5;
          nrm[n] = s;
          cube.push(...p, ...nrm);
        }
      }
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cube), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    for (let a = 0; a < 4; a++) {
      gl.enableVertexAttribArray(2 + a);
      gl.vertexAttribPointer(2 + a, 3, gl.FLOAT, false, I * 4, a * 12);
      gl.vertexAttribDivisor(2 + a, 1);
    }
    gl.bindVertexArray(null);
  }

  // Builds instances from snapshot rows `ents` (slot base `row0`), skipping `self`.
  update(ents, row0, self) {
    const d = this.inst;
    let n = 0;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const r = row0 + id * E_FIELDS;
      if (id === self || !ents[r + E_ACTIVE] || !ents[r + E_HEALTH]) continue; // the dead vanish
      const yawDeg = dequantizeYaw(ents[r + E_YAW]);
      const yaw = yawDeg * Math.PI / 180, c = Math.cos(yaw), sn = Math.sin(yaw);
      const col = ents[r + E_TEAM] === TEAM_CT ? CT_COLOR : T_COLOR;
      const feet = ents[r + E_Z] - feetOffset(ents[r + E_FLAGS]);
      const s = crouchScale(ents[r + E_DUCK] / 255);
      for (let b = 0; b < BOX_DATA.length; b += BOX_STRIDE) {
        const fx = BOX_DATA[b + 1], fy = BOX_DATA[b + 2]; // forward / left offsets in the yaw frame
        n = this.box(d, n, ents[r + E_X] + fx * c - fy * sn, ents[r + E_Y] + fx * sn + fy * c,
          feet + BOX_DATA[b + 3] * s, BOX_DATA[b + 4] * 2, BOX_DATA[b + 5] * 2, BOX_DATA[b + 6] * 2 * s, yaw, col,
          BOX_DATA[b] === HITGROUP_HEAD ? 1.25 : 1);
      }
    }
    this.count = n;
  }

  // Adds the bomb lying at (x, y, z = floor) after the players (call after update).
  addBomb(x, y, z, yaw, led) {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    for (const [fx, fy, fz, sx, sy, sz, col] of C4_BOXES) {
      this.count = this.box(this.inst, this.count, x + fx * c - fy * sn, y + fx * sn + fy * c, z + fz + sz / 2, sx, sy,
        sz, yaw, col || (led ? LED_ON : LED_OFF), 1);
    }
  }

  box(d, n, x, y, z, sx, sy, sz, yaw, col, bright) {
    const p = n * I;
    d[p] = x; d[p + 1] = y; d[p + 2] = z;
    d[p + 3] = sx; d[p + 4] = sy; d[p + 5] = sz;
    d[p + 6] = 0; d[p + 7] = 0; d[p + 8] = yaw;
    d[p + 9] = col[0] * bright; d[p + 10] = col[1] * bright; d[p + 11] = col[2] * bright;
    return n + 1;
  }

  draw(viewProj) {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, this.count * I);
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.count);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
}
