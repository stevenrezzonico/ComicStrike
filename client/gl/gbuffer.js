// The G-buffer every scene shader draws into (GBUFFER in client/gl/shaders.js), read
// back by the composite pass: three color targets plus a depth renderbuffer, at the
// render resolution (the canvas's, or less: the print reads it per canvas pixel).
//   0: albedo rgb, light (RGBA8; filtered: at a lower render scale the print reads it
//      between texels)
//   1: normal xyz, object id (RGBA8)
//   2: DEPTH_NEAR / linear depth, G_ flags (RG16F: the print reads the depth of a dozen
//      neighbors a pixel, and a float is read as it is; packed into 24 bits of an RGBA8
//      it cost a third of the print pass to decode). Where half-float targets are
//      missing (EXT_color_buffer_half_float), the shaders pack it (DEPTH_PACKED).
// The color targets are never cleared: every pixel is written each frame (the world,
// else the sky fill at the far plane), and clearing them cost a fifth of the GPU frame.

import { shaderDefines } from './program.js';

const CLEAR_Z = new Float32Array([1]);

export class GBuffer {
  constructor(gl) {
    this.gl = gl;
    this.fb = gl.createFramebuffer();
    this.inkFb = gl.createFramebuffer();
    this.ink = null;
    this.tex = [null, null, null];
    this.z = null;
    this.width = 0;
    this.height = 0;
    this.all = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2];
    this.albedoOnly = [gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE];
    this.packed = !gl.getExtension('EXT_color_buffer_half_float');
    if (this.packed) shaderDefines.prefix += '#define DEPTH_PACKED\n';
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    for (let i = 0; i < 3; i++) {
      if (this.tex[i]) gl.deleteTexture(this.tex[i]);
      const t = this.tex[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, i === 2 && !this.packed ? gl.RG16F : gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, i === 0 ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, i === 0 ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    }
    if (this.z) gl.deleteRenderbuffer(this.z);
    this.z = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.z);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.z);
    gl.drawBuffers(this.all);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`G-buffer incomplete (0x${status.toString(16)})`);
    // The ink pass's target (INK_FS): the line coverage per texel, filtered when the
    // composite reads it at another resolution.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.inkFb);
    if (this.ink) gl.deleteTexture(this.ink);
    const ink = this.ink = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ink);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ink, 0);
    const inkStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (inkStatus !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`ink target incomplete (0x${inkStatus.toString(16)})`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Binds the ink target for the ink pass (no depth test: a fullscreen triangle).
  beginInk() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.inkFb);
    gl.viewport(0, 0, this.width, this.height);
  }

  // Binds it for drawing and clears the depth (the color targets get overwritten whole).
  begin() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearBufferfv(gl.DEPTH, 0, CLEAR_Z);
  }

  // Draws that only paint the albedo (decals): the other targets stay as they are.
  albedo(only) {
    const gl = this.gl;
    gl.drawBuffers(only ? this.albedoOnly : this.all);
    gl.colorMask(true, true, true, !only); // keep the light in alpha
  }

  // Textures on units 0..2 (the targets) and 3 (the ink) for the ink pass and the composite.
  bindTextures() {
    const gl = this.gl;
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ink);
  }
}
