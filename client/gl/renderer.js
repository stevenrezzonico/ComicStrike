// WebGL2 renderer: one VBO + one index buffer for the whole map, drawn comic style.
// A frame: begin() binds the G-buffer (client/gl/gbuffer.js); render() draws the opaque
// world, sky brushes, sky fill, overlays (decals, debris, players) and see-through faces
// (as a dot screen) into it; the first-person view goes in after a depth clear; then
// composite() prints the whole frame to the canvas in one pass (ink lines, halftone).

import {
  WORLD_VS, WORLD_FS, WORLD_SOLID_FS, SKY_MESH_VS, SKY_FILL_VS, SKY_FS, COMPOSITE_VS, COMPOSITE_FS, COMPOSITE_FAST_FS,
} from './shaders.js';
import { VERTEX_STRIDE } from '../mapmesh.js';
import { program } from './program.js';
import { GBuffer } from './gbuffer.js';
import { mapLight } from './skinned.js';
import { GpuTimer, PASS } from './gputimer.js';
import { FlashLights } from './flashes.js';
import { Afterimage } from './afterimage.js';
import { WorldVis } from './worldvis.js';

// The light that prints fully lit: this share of the map's lit lightmap texels is at or
// below it (sunlit ground and walls on outdoor maps, lamp pools indoors).
const LIGHT_FULL_SHARE = 0.75;
const COMPOSITE_UNIFORMS = ['u_albedo', 'u_normal', 'u_depth', 'u_res', 'u_line', 'u_dot', 'u_zoom', 'u_bands',
  'u_lift', 'u_style', 'u_calm', 'u_soft'];

export class Renderer {
  // lowLatency (r_lowlatency): a desynchronized canvas, presented without the browser's
  // compositor where the browser allows it (Chrome on Windows): a frame less between the
  // mouse and the screen, but the display may scan out while the print is still being
  // written (a tear during fast turns). Off by default. (Before the deferred print,
  // when every pass drew into the canvas, its half-drawn frames flickered.)
  constructor(canvas, lowLatency = false) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false, // the G-buffer has its own; the canvas only gets the composite
      stencil: false,
      powerPreference: 'high-performance',
      desynchronized: lowLatency,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.gbuf = new GBuffer(gl); // first: it sets the shader defines (DEPTH_PACKED)
    const worldUniforms = ['u_viewProj', 'u_lightmap', 'u_time', 'u_zoom', 'u_dot', 'u_lightFull', 'u_broken',
      'u_moverBase', 'u_movers', 'u_flash', 'u_flashK', 'u_flashN'];
    this.flashes = new FlashLights(); // muzzle flashes and explosions lighting the world
    // The opaque bulk with a shader that never discards; alpha-tested and see-through faces
    // with the one that does.
    this.solid = program(gl, WORLD_VS, WORLD_SOLID_FS, worldUniforms);
    this.world = program(gl, WORLD_VS, WORLD_FS, worldUniforms);
    this.broken = new Uint32Array(8); // bit per breakable slot
    this.movers = null; // shared/doors.js Doors: slots above slotBase are drawn moved
    const skyUniforms = ['u_eye', 'u_horizon', 'u_time'];
    this.skyMesh = program(gl, SKY_MESH_VS, SKY_FS, ['u_viewProj', ...skyUniforms]);
    this.skyFill = program(gl, SKY_FILL_VS, SKY_FS, ['u_invViewProj', ...skyUniforms]);
    this.compFull = this.comp = program(gl, COMPOSITE_VS, COMPOSITE_FS, COMPOSITE_UNIFORMS);
    this.compFast = null; // r_inkfast's, built when first asked for
    this.afterimage = new Afterimage(gl); // the flashbang's frozen frame
    this.timer = new GpuTimer(gl); // GPU time per pass (cl_showfps 3)
    this.emptyVao = gl.createVertexArray();
    this.vao = null;
    this.opaqueCount = 0;
    this.cutoutCount = 0;
    this.skyCount = 0;
    this.transCount = 0;
    this.horizon = new Float32Array([0.76, 0.89, 0.93]);
    // The print (client/settings.js r_* cvars): comic or plain, ink line width and dot
    // size relative to the screen height, light bands.
    // calm: the radius (px) of the dot-free zone round the screen center (the crosshair);
    // soft: soft shade dots (r_halftone_style 1).
    this.style = { comic: true, ink: 1, dots: 1, bands: 0, lift: 0.3, calm: 0, soft: false, fast: false };
    this.novis = false; // r_novis: draw the whole world (no visibility culling)
    this.zoom = 1; // 90 / fov
    // The canvas's size on the page, kept by a ResizeObserver: reading clientWidth every
    // frame forces a layout whenever the DOM changed since the last one (a kill notice, a
    // console line written while the ticks ran).
    this.cssWidth = canvas.clientWidth;
    this.cssHeight = canvas.clientHeight;
    new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      this.cssWidth = r.width;
      this.cssHeight = r.height;
    }).observe(canvas);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CW); // GoldSrc faces wind clockwise seen from the front
  }

  // bsp: for the visible-world culling (WorldVis; without it everything is drawn).
  loadMap(mesh, bsp = null) {
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

    // The map's ranges, then two regions taking the visible world's indices in turns
    // (WorldVis): one is written while the GPU may still read last frame's.
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, (mesh.indices.length + 2 * mesh.worldOpaqueCount) * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, mesh.indices);
    gl.bindVertexArray(null);
    this.visBase = mesh.indices.length;
    this.worldOpaque = mesh.worldOpaqueCount;
    this.visTurn = 0;
    this.vis = bsp ? new WorldVis(bsp, mesh) : null;

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
    this.cutoutCount = mesh.cutoutCount;
    this.skyCount = mesh.skyCount;
    this.transCount = mesh.transCount;
    mapLight.full = fullLight(lm.data);
    this.afterimage.warm(this.canvas.width, this.canvas.height);
  }

  // Hides (or restores) a breakable's faces without touching the vertex buffer.
  setBroken(slot, broken) {
    const bit = 1 << (slot & 31);
    if (broken) this.broken[slot >> 5] |= bit;
    else this.broken[slot >> 5] &= ~bit;
  }

  clearBroken() {
    this.broken.fill(0);
  }

  // Doors and buttons (shared/doors.js): their slots take its matrices every frame.
  setMovers(doors) {
    this.movers = doors && doors.count ? doors : null;
  }

  // scale: render resolution relative to the page (mat_viewportscale).
  resize(scale = 1) {
    const c = this.canvas;
    const w = Math.max(1, Math.round(this.cssWidth * scale));
    const h = Math.max(1, Math.round(this.cssHeight * scale));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.gbuf.resize(w, h);
    return w / h;
  }

  // Halftone cell in pixels (0: flat tones), from the screen height like the ink.
  dotSize() {
    return this.style.dots > 0 ? Math.max(3, this.canvas.height / 165) * this.style.dots : 0;
  }

  setWorldUniforms(w, viewProj, time) {
    const gl = this.gl;
    gl.useProgram(w.p);
    gl.uniformMatrix4fv(w.loc.u_viewProj, false, viewProj);
    gl.uniform1f(w.loc.u_time, time);
    gl.uniform1f(w.loc.u_zoom, this.zoom);
    gl.uniform1f(w.loc.u_dot, this.dotSize());
    gl.uniform1f(w.loc.u_lightFull, mapLight.full);
    gl.uniform1i(w.loc.u_lightmap, 0);
    gl.uniform4uiv(w.loc.u_broken, this.broken);
    gl.uniform1ui(w.loc.u_moverBase, this.movers ? this.movers.slotBase : 255);
    if (this.movers) gl.uniform4fv(w.loc.u_movers, this.movers.matrix);
    const f = this.flashes;
    gl.uniform1i(w.loc.u_flashN, f.count);
    if (f.count) {
      gl.uniform4fv(w.loc.u_flash, f.pos);
      gl.uniform1fv(w.loc.u_flashK, f.k);
    }
  }

  setSkyUniforms(s, eye, time) {
    const gl = this.gl;
    gl.useProgram(s.p);
    gl.uniform3fv(s.loc.u_eye, eye);
    gl.uniform3fv(s.loc.u_horizon, this.horizon);
    gl.uniform1f(s.loc.u_time, time);
  }

  // Starts a frame in the G-buffer.
  begin() {
    this.timer.mark(PASS.CLEAR);
    this.gbuf.begin();
  }

  // overlays: objects with draw(viewProj) (decals, debris, players), drawn after the
  // sky and before see-through surfaces; their GPU time counts under their 'pass' (PASS.EFFECTS
  // by default).
  render(viewProj, invViewProj, eye, time, overlays = null) {
    const gl = this.gl;
    const w = this.world;
    const t = this.timer;
    this.flashes.update(time);
    if (this.vao) {
      t.mark(PASS.WORLD);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lightmapTex);
      gl.bindVertexArray(this.vao);
      this.setWorldUniforms(this.solid, viewProj, time);
      // The visible world nearest first (r_novis 0), then the brush entities' opaque faces.
      const n = this.vis && !this.novis ? this.vis.update(eye, viewProj) : -1;
      if (n < 0) gl.drawElements(gl.TRIANGLES, this.opaqueCount, gl.UNSIGNED_INT, 0);
      else {
        const at = this.visBase + this.visTurn * this.worldOpaque;
        this.visTurn ^= 1;
        if (n > 0) {
          gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, at * 4, this.vis.out, 0, n);
          gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, at * 4);
        }
        const rest = this.opaqueCount - this.worldOpaque;
        if (rest > 0) gl.drawElements(gl.TRIANGLES, rest, gl.UNSIGNED_INT, this.worldOpaque * 4);
      }
      // Set either way: see-through faces draw with it too.
      this.setWorldUniforms(w, viewProj, time);
      if (this.cutoutCount > 0) gl.drawElements(gl.TRIANGLES, this.cutoutCount, gl.UNSIGNED_INT, this.opaqueCount * 4);

      // Sky brushes write depth like walls, so nothing behind them shows through.
      if (this.skyCount > 0) {
        t.mark(PASS.SKY);
        this.setSkyUniforms(this.skyMesh, eye, time);
        gl.uniformMatrix4fv(this.skyMesh.loc.u_viewProj, false, viewProj);
        gl.drawElements(gl.TRIANGLES, this.skyCount, gl.UNSIGNED_INT, (this.opaqueCount + this.cutoutCount) * 4);
      }
    }

    // Fill whatever nothing covered (cracks, outside the map): depth LEQUAL on the far plane.
    t.mark(PASS.SKY);
    this.setSkyUniforms(this.skyFill, eye, time);
    gl.uniformMatrix4fv(this.skyFill.loc.u_invViewProj, false, invViewProj);
    gl.bindVertexArray(this.emptyVao);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE); // fullscreen triangle winds CCW
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);

    if (overlays) {
      for (let i = 0; i < overlays.length; i++) {
        const o = overlays[i];
        t.mark(o.pass ?? PASS.EFFECTS);
        o.draw(viewProj, this.gbuf);
      }
    }

    // Glass and water: opaque dots of a screen (WORLD_FS), so no sorting or blending.
    if (this.vao && this.transCount > 0) {
      t.mark(PASS.GLASS);
      gl.useProgram(w.p);
      gl.bindVertexArray(this.vao);
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, this.transCount, gl.UNSIGNED_INT,
        (this.opaqueCount + this.cutoutCount + this.skyCount) * 4);
      gl.enable(gl.CULL_FACE);
    }
    gl.bindVertexArray(null);
  }

  // Prints the G-buffer to the canvas. Leaves the canvas bound (crosshair after it).
  composite() {
    const gl = this.gl, st = this.style;
    const h = this.canvas.height;
    this.timer.mark(PASS.PRINT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    if (st.fast && !this.compFast) this.compFast = program(gl, COMPOSITE_VS, COMPOSITE_FAST_FS, COMPOSITE_UNIFORMS);
    this.comp = st.fast ? this.compFast : this.compFull;
    const c = this.comp.loc;
    gl.useProgram(this.comp.p);
    this.gbuf.bindTextures();
    gl.uniform1i(c.u_albedo, 0);
    gl.uniform1i(c.u_normal, 1);
    gl.uniform1i(c.u_depth, 2);
    gl.uniform2f(c.u_res, this.canvas.width, h);
    gl.uniform1f(c.u_line, st.ink > 0 ? Math.max(1, Math.round(h / 540 * st.ink)) : 0);
    gl.uniform1f(c.u_dot, this.dotSize());
    gl.uniform1f(c.u_zoom, this.zoom);
    gl.uniform1f(c.u_bands, st.bands);
    gl.uniform1f(c.u_lift, st.lift);
    gl.uniform1i(c.u_style, st.comic ? 1 : 0);
    gl.uniform3f(c.u_calm, this.canvas.width / 2, h / 2, st.calm);
    gl.uniform1f(c.u_soft, st.soft ? 1 : 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
  }
}

// The lifted light (WORLD_FS: pow(lm, 0.6) * 1.45) below which LIGHT_FULL_SHARE of the
// lightmap's lit texels fall, from a histogram of their brightness.
export function fullLight(rgba) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) continue; // atlas gaps
    const l = Math.round(0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2]);
    if (l === 0) continue;
    hist[l]++;
    n++;
  }
  let b = 1;
  for (let seen = 0; b < 255; b++) {
    seen += hist[b];
    if (seen >= n * LIGHT_FULL_SHARE) break;
  }
  return n ? Math.max(0.5, Math.pow(b / 255, 0.6) * 1.45) : 1.25;
}
