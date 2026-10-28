// Contact shadows: a soft-edged disc on the floor under each standing character, drawn into
// the G-buffer before the characters themselves. It only multiplies the albedo target's
// light (alpha) down, so the composite prints it as shade dots, like the map's own shadows,
// and grounds a figure that would otherwise float on a flat-lit floor. One instanced draw.

import { program } from './program.js';
import { SHADOW_VS, SHADOW_FS } from './shaders.js';

const F = 5; // floats per disc: x, y, floor height, radius, darkness

export class FloorShadows {
  constructor(gl, capacity = 64) {
    this.gl = gl;
    this.capacity = capacity;
    this.count = 0;
    this.data = new Float32Array(capacity * F);
    this.prog = program(gl, SHADOW_VS, SHADOW_FS, ['u_viewProj']);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, F * 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, F * 4, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  // A disc of radius r on the floor at height z under (x, y), taking `dark` of the light
  // at its middle. Call between draws.
  add(x, y, z, r, dark) {
    if (this.count === this.capacity) return;
    const d = this.data, o = this.count++ * F;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = r;
    d[o + 4] = dark;
  }

  // Multiplies the light under the discs added since the last draw, then forgets them.
  draw(viewProj, gbuf) {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * F);
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gbuf.albedo(true);
    gl.colorMask(false, false, false, true); // the light only
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA); // light *= 1 - a
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gbuf.albedo(false);
    this.count = 0;
  }
}
