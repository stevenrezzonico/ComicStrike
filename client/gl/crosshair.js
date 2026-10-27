// CS:GO crosshair drawn on the GPU from uniforms (no geometry buffers), configured by
// the cl_crosshair* cvars: style (0/2/3/5 dynamic, 1/4 static), size, gap, thickness,
// dot, outline, T style, color and alpha. Sizes scale with screen height like CS:GO's
// (units of 1/480 of the height); the exact pixel rounding is an approximation.

import { program } from './program.js';
import { CROSSHAIR_VS, CROSSHAIR_FS } from './shaders.js';

// cl_crosshaircolor 0..4 (5 = cl_crosshaircolor_r/g/b).
const COLORS = [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]];
const STATIC_STYLES = new Set([1, 4]);

// The crosshair's pixel sizes and color from the cvars, into `out` (no allocation).
// outline: thickness in pixels, -1 for none; parts: bit 0..3 right, left, bottom, top
// arm, bit 4 the dot.
export function crosshairLayout(cv, height, spreadGap, out) {
  const s = height / 480;
  let gap = (4 + cv.cl_crosshairgap.number) * s * 0.5;
  if (!STATIC_STYLES.has(cv.cl_crosshairstyle.number)) gap += spreadGap;
  out.gap = Math.round(gap);
  out.len = Math.max(1, Math.round(cv.cl_crosshairsize.number * s));
  out.thick = Math.max(1, Math.round(cv.cl_crosshairthickness.number * s));
  const custom = cv.cl_crosshaircolor.number === 5;
  const c = COLORS[cv.cl_crosshaircolor.number] || COLORS[1];
  out.r = custom ? cv.cl_crosshaircolor_r.number : c[0];
  out.g = custom ? cv.cl_crosshaircolor_g.number : c[1];
  out.b = custom ? cv.cl_crosshaircolor_b.number : c[2];
  out.alpha = cv.cl_crosshairusealpha.bool ? cv.cl_crosshairalpha.number / 255 : 200 / 255;
  out.outline = cv.cl_crosshair_drawoutline.bool ? Math.max(0, Math.round(cv.cl_crosshair_outlinethickness.number)) : -1;
  out.parts = (cv.cl_crosshair_t.bool ? 7 : 15) | (cv.cl_crosshairdot.bool ? 16 : 0);
  return out;
}

// The same crosshair on a 2D canvas (the settings preview), centered like the shader
// places it (CROSSHAIR_VS).
export function drawCrosshair2d(ctx, cv, width, height, scaleHeight, spreadGap = 0) {
  if (!cv.crosshair.bool) return;
  const L = crosshairLayout(cv, scaleHeight, spreadGap, {});
  const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
  const pass = (gap, len, thick, style) => {
    ctx.fillStyle = style;
    const h0 = -Math.floor(thick / 2);
    // Canvas y grows down; the shader's grows up (part 2 bottom, part 3 top).
    const rects = [[gap, h0, len, thick], [-gap - len, h0, len, thick], [h0, gap, thick, len],
      [h0, -gap - len, thick, len], [h0, h0, thick, thick]];
    for (let p = 0; p < 5; p++) {
      if (!(L.parts & (1 << p))) continue;
      const [x, y, w, h] = rects[p];
      ctx.fillRect(cx + x, cy + y, w, h);
    }
  };
  if (L.outline >= 0) {
    const o = L.outline;
    pass(L.gap - o, L.len + 2 * o, L.thick + 2 * o, `rgba(0,0,0,${L.alpha})`);
  }
  pass(L.gap, L.len, L.thick, `rgba(${L.r},${L.g},${L.b},${L.alpha})`);
}

export class Crosshair {
  // cv: { name: Cvar } for crosshair, cl_crosshair*.
  constructor(gl, cv) {
    this.gl = gl;
    this.cv = cv;
    this.prog = program(gl, CROSSHAIR_VS, CROSSHAIR_FS, ['u_screen', 'u_gap', 'u_len', 'u_thick', 'u_color', 'u_parts']);
    this.vao = gl.createVertexArray();
    this.color = new Float32Array(4);
    this.outline = new Float32Array([0, 0, 0, 1]);
    this.layout = {};
  }

  // spreadGap: pixels from the center to the edge of the current bullet cone (dynamic styles).
  draw(width, height, spreadGap) {
    const cv = this.cv;
    if (!cv.crosshair.bool) return;
    const L = crosshairLayout(cv, height, spreadGap, this.layout);
    const { gap: g, len, thick, parts } = L;
    this.color[0] = L.r / 255;
    this.color[1] = L.g / 255;
    this.color[2] = L.b / 255;
    this.color[3] = this.outline[3] = L.alpha;

    const gl = this.gl;
    const l = this.prog.loc;
    gl.useProgram(this.prog.p);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(l.u_screen, width, height);
    gl.uniform1i(l.u_parts, parts);
    if (L.outline >= 0) { // outline pass: every part grown by the outline thickness
      const o = L.outline;
      gl.uniform1f(l.u_gap, g - o);
      gl.uniform1f(l.u_len, len + 2 * o);
      gl.uniform1f(l.u_thick, thick + 2 * o);
      gl.uniform4fv(l.u_color, this.outline);
      gl.drawArrays(gl.TRIANGLES, 0, 30);
    }
    gl.uniform1f(l.u_gap, g);
    gl.uniform1f(l.u_len, len);
    gl.uniform1f(l.u_thick, thick);
    gl.uniform4fv(l.u_color, this.color);
    gl.drawArrays(gl.TRIANGLES, 0, 30);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}
