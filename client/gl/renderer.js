// WebGL2 renderer: one VBO + one index buffer for the whole map.
// Opaque world = 1 draw call, translucent range = 1 draw call, sky = 1 draw call.

import { WORLD_VS, WORLD_FS, SKY_VS, SKY_FS } from './shaders.js';
import { VERTEX_STRIDE } from '../mapmesh.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed:\n${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl, vs, fs, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed:\n${gl.getProgramInfoLog(p)}`);
  }
  const loc = {};
  for (const u of uniforms) loc[u] = gl.getUniformLocation(p, u);
  return { p, loc };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.world = program(gl, WORLD_VS, WORLD_FS, ['u_viewProj', 'u_lightmap', 'u_eye', 'u_time', 'u_fogColor']);
    this.sky = program(gl, SKY_VS, SKY_FS, ['u_invViewProj', 'u_horizon', 'u_zenith', 'u_time']);
    this.skyVao = gl.createVertexArray();
    this.vao = null;
    this.opaqueCount = 0;
    this.transCount = 0;
    this.horizon = new Float32Array([0.78, 0.74, 0.66]);
    this.zenith = new Float32Array([0.36, 0.52, 0.74]);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CW); // GoldSrc faces wind clockwise seen from the front
    gl.clearColor(0, 0, 0, 1);
  }

  loadMap(mesh) {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    const S = VERTEX_STRIDE;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.BYTE, true, S, 28);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, S, 32);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribIPointer(5, 4, gl.UNSIGNED_BYTE, S, 36);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    const lm = mesh.lightmap;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lm.width, lm.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lm.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.vao = vao;
    this.lightmapTex = tex;
    this.opaqueCount = mesh.opaqueCount;
    this.transCount = mesh.transCount;
  }

  resize(scale = 1) {
    const c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth * scale));
    const h = Math.max(1, Math.round(c.clientHeight * scale));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    return w / h;
  }

  render(viewProj, invViewProj, eye, time) {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.vao) {
      const w = this.world;
      gl.useProgram(w.p);
      gl.uniformMatrix4fv(w.loc.u_viewProj, false, viewProj);
      gl.uniform3fv(w.loc.u_eye, eye);
      gl.uniform1f(w.loc.u_time, time);
      gl.uniform3fv(w.loc.u_fogColor, this.horizon);
      gl.uniform1i(w.loc.u_lightmap, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lightmapTex);
      gl.bindVertexArray(this.vao);
      gl.drawElements(gl.TRIANGLES, this.opaqueCount, gl.UNSIGNED_INT, 0);

      if (this.transCount > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.drawElements(gl.TRIANGLES, this.transCount, gl.UNSIGNED_INT, this.opaqueCount * 4);
        gl.enable(gl.CULL_FACE);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    }

    // Sky last: depth LEQUAL against the cleared far plane fills only empty pixels.
    const s = this.sky;
    gl.useProgram(s.p);
    gl.uniformMatrix4fv(s.loc.u_invViewProj, false, invViewProj);
    gl.uniform3fv(s.loc.u_horizon, this.horizon);
    gl.uniform3fv(s.loc.u_zenith, this.zenith);
    gl.uniform1f(s.loc.u_time, time);
    gl.bindVertexArray(this.skyVao);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE); // fullscreen triangle winds CCW
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.bindVertexArray(null);
  }
}
