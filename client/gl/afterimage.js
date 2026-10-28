// The flashbang's afterimage: the printed frame of the moment it went off, kept on the GPU
// and drawn over the following frames, fading with the flash. Copying the canvas into a
// texture stays on the GPU; drawing it into a 2D canvas (the old way) made the CPU wait for
// the frame to finish, a hitch of ~20 ms just as the flashbang popped.

import { program } from './program.js';
import { COMPOSITE_VS, AFTERIMAGE_FS } from './shaders.js';

const UNIT = 3; // texture unit (the G-buffer's are 0-2)

export class Afterimage {
  constructor(gl) {
    this.gl = gl;
    this.prog = program(gl, COMPOSITE_VS, AFTERIMAGE_FS, ['u_img', 'u_alpha']);
    this.tex = gl.createTexture();
    this.width = 0;
    this.height = 0;
    this.vao = gl.createVertexArray();
  }

  // Keeps the canvas as it is now (call with the canvas bound, after composite()).
  capture(width, height) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      // RGB: the canvas has no alpha, and a copy may not add channels its source lacks.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Copies and draws once, invisibly (at map load): the first use of each costs the driver a
  // setup that dropped a frame just as the first flashbang popped.
  warm(width, height) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.capture(width, height);
    this.draw(1e-6, width, height);
  }

  // Draws the kept frame over the canvas at `alpha` (canvas bound; nothing if never captured
  // at this size: the window changed meanwhile).
  draw(alpha, width, height) {
    if (alpha <= 0 || width !== this.width || height !== this.height) return;
    const gl = this.gl;
    gl.useProgram(this.prog.p);
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.prog.loc.u_img, UNIT);
    gl.uniform1f(this.prog.loc.u_alpha, alpha);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
  }
}
