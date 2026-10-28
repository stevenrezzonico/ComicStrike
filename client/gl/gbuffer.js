// The G-buffer every scene shader draws into (GBUFFER in client/gl/shaders.js), read
// back by the composite pass: three RGBA8 targets plus a depth renderbuffer, sized like
// the canvas.
//   0: albedo rgb, light
//   1: normal xyz, object id
//   2: linear depth (24 bits), G_ flags

import { G_FLAGS } from './shaders.js';

const CLEAR_ALBEDO = new Float32Array([0, 0, 0, 1]);
const CLEAR_NORMAL = new Float32Array([0.5, 0.5, 1, 0]);
const CLEAR_DEPTH = new Float32Array([1, 1, 1, G_FLAGS.SKY / 255]); // the far plane, sky
const CLEAR_Z = new Float32Array([1]);

export class GBuffer {
  constructor(gl) {
    this.gl = gl;
    this.fb = gl.createFramebuffer();
    this.tex = [null, null, null];
    this.z = null;
    this.width = 0;
    this.height = 0;
    this.all = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2];
    this.albedoOnly = [gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE];
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
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Binds it for drawing and clears it to sky at the far plane.
  begin() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearBufferfv(gl.COLOR, 0, CLEAR_ALBEDO);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR_NORMAL);
    gl.clearBufferfv(gl.COLOR, 2, CLEAR_DEPTH);
    gl.clearBufferfv(gl.DEPTH, 0, CLEAR_Z);
  }

  // Draws that only paint the albedo (decals): the other targets stay as they are.
  albedo(only) {
    const gl = this.gl;
    gl.drawBuffers(only ? this.albedoOnly : this.all);
    gl.colorMask(true, true, true, !only); // keep the light in alpha
  }

  // Textures on units 0..2 for the composite.
  bindTextures() {
    const gl = this.gl;
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
    }
  }
}
