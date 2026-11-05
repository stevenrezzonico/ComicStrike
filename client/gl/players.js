// Other players' hit boxes (cl_showhitboxes; models are client/gl/playermodels.js): one
// instanced draw using the debris cube shader.

import { program } from './program.js';
import { DEBRIS_VS, DEBRIS_FS } from './shaders.js';
import { cubeInstances, drawCubes } from './debris.js';
import { TEAM_CT } from '../../shared/player.js';
import { BOX_DATA, BOX_STRIDE, HITGROUP_HEAD, feetOffset, crouchScale } from '../../shared/hitgroups.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_YAW, E_FLAGS, E_DUCK, E_HEALTH, E_TEAM, E_FIELDS, dequantizeYaw,
} from '../../shared/protocol.js';

const I = 12; // instance floats: pos, scale, rot, color
const T_COLOR = [0.72, 0.58, 0.36];
const CT_COLOR = [0.34, 0.45, 0.66];

export class Players {
  constructor(gl) {
    this.gl = gl;
    this.count = 0;
    this.inst = new Float32Array(MAX_PLAYERS * (BOX_DATA.length / BOX_STRIDE) * I);
    this.prog = program(gl, DEBRIS_VS, DEBRIS_FS, ['u_viewProj']);
    ({ vao: this.vao, vbo: this.vbo } = cubeInstances(gl, this.inst.length / I));
  }

  // Builds instances from snapshot rows `ents` (slot base `row0`), skipping `self`; none
  // without `boxes`.
  update(ents, row0, self, boxes = true) {
    const d = this.inst;
    let n = 0;
    for (let id = 0; boxes && id < MAX_PLAYERS; id++) {
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

  box(d, n, x, y, z, sx, sy, sz, yaw, col, bright) {
    const p = n * I;
    d[p] = x; d[p + 1] = y; d[p + 2] = z;
    d[p + 3] = sx; d[p + 4] = sy; d[p + 5] = sz;
    d[p + 6] = 0; d[p + 7] = 0; d[p + 8] = yaw;
    d[p + 9] = col[0] * bright; d[p + 10] = col[1] * bright; d[p + 11] = col[2] * bright;
    return n + 1;
  }

  draw(viewProj) {
    if (this.count) drawCubes(this.gl, this.prog, this.vao, this.vbo, this.inst, this.count, viewProj);
  }
}
