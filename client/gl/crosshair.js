// CS:GO crosshair drawn on the GPU from uniforms (no geometry buffers), configured by
// the cl_crosshair* cvars: style (0/2/3/5 dynamic, 1/4 static), size, gap, thickness,
// dot, outline, T style, color and alpha. Sizes scale with screen height like CS:GO's
// (units of 1/480 of the height); the exact pixel rounding is an approximation.

import { program } from './program.js';
import { CROSSHAIR_VS, CROSSHAIR_FS } from './shaders.js';

// cl_crosshaircolor 0..4 (5 = cl_crosshaircolor_r/g/b).
const COLORS = [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]];
const STATIC_STYLES = new Set([1, 4]);

export class Crosshair {
  // cv: { name: Cvar } for crosshair, cl_crosshair*.
  constructor(gl, cv) {
    this.gl = gl;
    this.cv = cv;
    this.prog = program(gl, CROSSHAIR_VS, CROSSHAIR_FS, ['u_screen', 'u_gap', 'u_len', 'u_thick', 'u_color', 'u_parts']);
    this.vao = gl.createVertexArray();
    this.color = new Float32Array(4);
    this.outline = new Float32Array([0, 0, 0, 1]);
  }

  // spreadGap: pixels from the center to the edge of the current bullet cone (dynamic styles).
  draw(width, height, spreadGap) {
    const cv = this.cv;
    if (!cv.crosshair.bool) return;
    const s = height / 480;
    const style = cv.cl_crosshairstyle.number;
    let gap = (4 + cv.cl_crosshairgap.number) * s * 0.5;
    if (!STATIC_STYLES.has(style)) gap += spreadGap;
    const len = Math.max(1, Math.round(cv.cl_crosshairsize.number * s));
    const thick = Math.max(1, Math.round(cv.cl_crosshairthickness.number * s));
    const c = cv.cl_crosshaircolor.number === 5
      ? [cv.cl_crosshaircolor_r.number, cv.cl_crosshaircolor_g.number, cv.cl_crosshaircolor_b.number]
      : COLORS[cv.cl_crosshaircolor.number] || COLORS[1];
    const alpha = cv.cl_crosshairusealpha.bool ? cv.cl_crosshairalpha.number / 255 : 200 / 255;
    this.color.set([c[0] / 255, c[1] / 255, c[2] / 255, alpha]);
    this.outline[3] = alpha;
    // Parts: bit 0..3 right, left, bottom, top arm; bit 4 the dot.
    let parts = cv.cl_crosshair_t.bool ? 7 : 15;
    if (cv.cl_crosshairdot.bool) parts |= 16;

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
    const g = Math.round(gap);
    if (cv.cl_crosshair_drawoutline.bool) { // outline pass: every part grown by the outline thickness
      const o = Math.max(0, Math.round(cv.cl_crosshair_outlinethickness.number));
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
