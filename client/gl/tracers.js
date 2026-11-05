// Bullet tracers: a thin yellow streak running from the muzzle to where the bullet hit,
// TRACER_LEN long at TRACER_SPEED, drawn with the practice arcs' screen-space line shader
// (TRAIL_VS: a quad a segment) but behind what is nearer, with a thin ink rim of its own
// (TRAIL_FS: the ink pass's outline was thicker than the streak). A pool of MAX_TRACERS,
// the oldest replaced; nothing allocated per frame.

import { program } from './program.js';
import { TRAIL_VS, TRAIL_FS } from './shaders.js';

const MAX_TRACERS = 32;
const TRACER_SPEED = 6000; // units a second (approx.)
const TRACER_LEN = 150;
const LINE_PX = 5; // at 1080 lines, the rim included
const RIM_PX = 1; // at 1080 lines
const COLOR = [1, 0.84, 0.3];
const F = 7; // ax, ay, az, bx, by, bz, start time

export class Tracers {
  constructor(gl) {
    this.gl = gl;
    this.now = 0; // seconds
    this.screen = new Float32Array(2); // canvas pixels
    this.t = new Float32Array(MAX_TRACERS * F).fill(-1e9);
    this.next = 0;
    this.seg = new Float32Array(MAX_TRACERS * 9);
    this.prog = program(gl, TRAIL_VS, TRAIL_FS, ['u_viewProj', 'u_screen', 'u_width', 'u_rim']);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.seg.byteLength, gl.DYNAMIC_DRAW);
    for (let a = 0; a < 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 36, a * 12);
      gl.vertexAttribDivisor(a, 1);
    }
    gl.bindVertexArray(null);
  }

  // A tracer from (ax, ay, az) to (bx, by, bz), starting now.
  add(ax, ay, az, bx, by, bz) {
    const t = this.t, o = this.next * F;
    this.next = (this.next + 1) % MAX_TRACERS;
    t[o] = ax;
    t[o + 1] = ay;
    t[o + 2] = az;
    t[o + 3] = bx;
    t[o + 4] = by;
    t[o + 5] = bz;
    t[o + 6] = this.now;
  }

  clear() {
    this.t.fill(-1e9);
  }

  // One draw clipped away (map load: see CLIP_ALL).
  warm(clipAll) {
    this.add(0, 0, 0, 100, 0, 0);
    this.draw(clipAll);
    this.clear();
  }

  draw(viewProj) {
    const t = this.t, s = this.seg;
    let n = 0;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const o = i * F, dx = t[o + 3] - t[o], dy = t[o + 4] - t[o + 1], dz = t[o + 5] - t[o + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz), head = (this.now - t[o + 6]) * TRACER_SPEED;
      if (!(len > 0) || head < 0 || head - TRACER_LEN >= len) continue;
      const k1 = Math.min(head, len) / len, k0 = Math.max(head - TRACER_LEN, 0) / len, q = n++ * 9;
      s[q] = t[o] + dx * k0;
      s[q + 1] = t[o + 1] + dy * k0;
      s[q + 2] = t[o + 2] + dz * k0;
      s[q + 3] = t[o] + dx * k1;
      s[q + 4] = t[o + 1] + dy * k1;
      s[q + 5] = t[o + 2] + dz * k1;
      s[q + 6] = COLOR[0];
      s[q + 7] = COLOR[1];
      s[q + 8] = COLOR[2];
    }
    if (!n) return;
    const gl = this.gl;
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gl.uniform2fv(this.prog.loc.u_screen, this.screen);
    gl.uniform1f(this.prog.loc.u_width, Math.max(3, LINE_PX * this.screen[1] / 1080));
    gl.uniform1f(this.prog.loc.u_rim, Math.max(0.6, RIM_PX * this.screen[1] / 1080));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, s, 0, n * 9);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
}
