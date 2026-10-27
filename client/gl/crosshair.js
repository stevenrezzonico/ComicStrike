// CS:GO-style dynamic crosshair drawn on the GPU from uniforms (no geometry buffers).

import { program } from './program.js';
import { CROSSHAIR_VS, CROSSHAIR_FS } from './shaders.js';

export class Crosshair {
  constructor(gl) {
    this.gl = gl;
    this.prog = program(gl, CROSSHAIR_VS, CROSSHAIR_FS, ['u_screen', 'u_gap', 'u_len', 'u_thick', 'u_color']);
    this.vao = gl.createVertexArray();
    this.length = 6;
    this.thickness = 2;
    this.color = new Float32Array([0.3, 1.0, 0.3, 0.9]); // cl_crosshaircolor 1 (green)
    this.outline = new Float32Array([0, 0, 0, 0.6]);
  }

  // gap in pixels from the center to the inner end of each arm.
  draw(width, height, gap) {
    const gl = this.gl;
    const l = this.prog.loc;
    gl.useProgram(this.prog.p);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(l.u_screen, width, height);
    const g = Math.round(gap);
    // Outline pass, then the colored arms on top.
    gl.uniform1f(l.u_gap, g - 1);
    gl.uniform1f(l.u_len, this.length + 2);
    gl.uniform1f(l.u_thick, this.thickness + 2);
    gl.uniform4fv(l.u_color, this.outline);
    gl.drawArrays(gl.TRIANGLES, 0, 24);
    gl.uniform1f(l.u_gap, g);
    gl.uniform1f(l.u_len, this.length);
    gl.uniform1f(l.u_thick, this.thickness);
    gl.uniform4fv(l.u_color, this.color);
    gl.drawArrays(gl.TRIANGLES, 0, 24);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}
