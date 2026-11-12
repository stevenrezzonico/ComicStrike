// CS:GO's team id over teammates' heads (cl_teamid_overhead): a small triangle pointing
// down at each living teammate's head, in the team's color with an ink rim, the same size on
// the screen at any distance, drawn over the printed frame like the crosshair (so through
// walls, as CS:GO's). Instanced: one triangle a teammate, its screen place and color.

import { program } from './program.js';

export const MAX_MARKS = 32;
const HALF_PX = 7; // the triangle's half width at 1080 lines
const RIM_PX = 1.5;
// The triangle in units of its half width, from its tip (pointing down at the head): the
// base 1.6 above. Its incircle (radius INR, center INY above the tip) scales it outward
// so the rim pass is every edge pushed out by the same pixels.
const INR = 0.554, INY = 1.046;

const VS = `#version 300 es
in vec2 a_at; // the tip, canvas pixels from the bottom left
in vec3 a_color;
uniform vec2 u_screen;
uniform float u_size;
uniform float u_grow;
out vec3 v_color;
void main() {
  vec2 c = gl_VertexID == 0 ? vec2(-1.0, 1.6) : gl_VertexID == 1 ? vec2(1.0, 1.6) : vec2(0.0);
  vec2 inc = vec2(0.0, ${INY}) * u_size;
  float k = (${INR} * u_size + u_grow) / (${INR} * u_size);
  vec2 px = a_at + inc + (c * u_size - inc) * k;
  v_color = a_color;
  gl_Position = vec4(px / u_screen * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 v_color;
uniform vec4 u_ink; // w 1: the rim pass, in this color
out vec4 o_color;
void main() {
  o_color = vec4(u_ink.w > 0.5 ? u_ink.rgb : v_color, 0.92);
}`;

export class TeamMarks {
  constructor(gl) {
    this.gl = gl;
    this.prog = program(gl, VS, FS, ['u_screen', 'u_size', 'u_grow', 'u_ink']);
    this.inst = new Float32Array(MAX_MARKS * 5); // x, y, r, g, b
    this.count = 0;
    this.ink = new Float32Array([0.09, 0.075, 0.06, 1]);
    this.noInk = new Float32Array(4);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    const at = gl.getAttribLocation(this.prog.p, 'a_at'), color = gl.getAttribLocation(this.prog.p, 'a_color');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(at, 1);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 20, 8);
    gl.vertexAttribDivisor(color, 1);
    gl.bindVertexArray(null);
  }

  // A mark for this frame: the world point p ([x, y, z]: doubles as arguments were heap
  // numbers) above a head, seen through viewProj on a canvas of w x h pixels; false
  // (nothing added) behind the camera or off the screen.
  add(viewProj, p, w, h, color) {
    const m = viewProj, x = p[0], y = p[1], z = p[2];
    const W = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (W < 1 || this.count === MAX_MARKS) return false;
    const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / W * 0.5 + 0.5) * w;
    const sy = ((m[1] * x + m[5] * y + m[9] * z + m[13]) / W * 0.5 + 0.5) * h;
    if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 40) return false;
    const o = this.count++ * 5;
    this.inst[o] = sx;
    this.inst[o + 1] = sy;
    this.inst[o + 2] = color[0];
    this.inst[o + 3] = color[1];
    this.inst[o + 4] = color[2];
    return true;
  }

  // One draw, off the screen: the program's first draw at map load, not in a game. On the
  // canvas, where the marks print: the map load warms with the G-buffer bound, whose three
  // draw buffers this one-output shader cannot feed (GL_INVALID_OPERATION, nothing warmed).
  warm() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.inst[0] = this.inst[1] = -1000;
    this.count = 1;
    this.draw(64, 64);
  }

  // The marks added since the last draw, onto the canvas (w x h), then none.
  draw(w, h) {
    const n = this.count;
    this.count = 0;
    if (!n) return;
    const gl = this.gl, l = this.prog.loc, size = Math.max(4, HALF_PX * h / 1080);
    gl.useProgram(this.prog.p);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, n * 5);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(l.u_screen, w, h);
    gl.uniform1f(l.u_size, size);
    gl.uniform1f(l.u_grow, Math.max(1, RIM_PX * h / 1080)); // the ink rim
    gl.uniform4fv(l.u_ink, this.ink);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, n);
    gl.uniform1f(l.u_grow, 0); // the team's color
    gl.uniform4fv(l.u_ink, this.noInk);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, n);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}
