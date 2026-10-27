// Other players as procedural boxes (body hull + head), one instanced draw using the
// debris cube shader. Placeholder until Phase 7's player models.

import { program } from './program.js';
import { DEBRIS_VS, DEBRIS_FS } from './shaders.js';
import { FL_DUCKING } from '../../shared/pmove.js';
import { TEAM_CT } from '../../shared/player.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_YAW, E_FLAGS, E_TEAM, E_FIELDS, dequantizeYaw,
} from '../../shared/protocol.js';

const I = 12; // instance floats: pos, scale, rot, color
const T_COLOR = [0.72, 0.58, 0.36];
const CT_COLOR = [0.34, 0.45, 0.66];

export class Players {
  constructor(gl) {
    this.gl = gl;
    this.count = 0;
    this.inst = new Float32Array(MAX_PLAYERS * 2 * I);
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
      if (id === self || !ents[r + E_ACTIVE]) continue;
      const ducked = (ents[r + E_FLAGS] & FL_DUCKING) !== 0;
      const h = ducked ? 36 : 72; // hull height; origin is the hull center
      const yaw = dequantizeYaw(ents[r + E_YAW]) * Math.PI / 180;
      const col = ents[r + E_TEAM] === TEAM_CT ? CT_COLOR : T_COLOR;
      // Body: slightly narrower than the 32-unit hull, below the head.
      n = this.box(d, n, ents[r + E_X], ents[r + E_Y], ents[r + E_Z] - 5, 24, 16, h - 10, yaw, col, 1);
      n = this.box(d, n, ents[r + E_X], ents[r + E_Y], ents[r + E_Z] + h / 2 - 5, 10, 10, 10, yaw, col, 1.25);
    }
    this.count = n;
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
