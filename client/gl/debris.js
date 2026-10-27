// Debris from broken func_breakables: procedural chunks shaped by material (wood
// splinters, glass shards, metal plates...), simulated with gravity and point traces
// against the world, drawn as one instanced cube draw. All storage is preallocated.

import { program } from './program.js';
import { DEBRIS_VS, DEBRIS_FS } from './shaders.js';
import { Trace, traceHull, HULL_POINT } from '../../shared/trace.js';
import {
  MAT_GLASS, MAT_WOOD, MAT_METAL, MAT_FLESH, MAT_CINDER, MAT_CEILING_TILE, MAT_COMPUTER, MAT_UNBREAKABLE_GLASS,
} from '../../shared/breakables.js';

const GRAVITY = 800;
const BOUNCE = 0.35; // fraction of normal speed kept on impact
const FRICTION = 0.6; // tangential speed kept on impact
const FADE_TIME = 1.0; // chunks shrink away over their last second

// Simulation stride: pos 0..2, vel 3..5, rot 6..8, spin 9..11, scale 12..14, color 15..17, life 18, rest 19
const S = 20;
// Instance stride: pos, scale, rot, color
const I = 12;

const CUBE = (() => {
  const faces = [ // normal, then the two in-face axes
    [1, 0, 0, 0, 1, 0, 0, 0, 1], [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 0, 0, 1, 1, 0, 0], [0, -1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0], [0, 0, -1, 0, 1, 0, 1, 0, 0],
  ];
  const out = [];
  for (const [nx, ny, nz, ux, uy, uz, vx, vy, vz] of faces) {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
      out.push((nx + ux * su + vx * sv) * 0.5, (ny + uy * su + vy * sv) * 0.5, (nz + uz * su + vz * sv) * 0.5, nx, ny, nz);
    }
  }
  return new Float32Array(out);
})();

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

export class Debris {
  constructor(gl, capacity = 384) {
    this.gl = gl;
    this.capacity = capacity;
    this.count = 0;
    this.sim = new Float32Array(capacity * S);
    this.inst = new Float32Array(capacity * I);
    this.trace = new Trace();
    this.prog = program(gl, DEBRIS_VS, DEBRIS_FS, ['u_viewProj']);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const cube = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cube);
    gl.bufferData(gl.ARRAY_BUFFER, CUBE, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    for (let a = 0; a < 4; a++) {
      gl.enableVertexAttribArray(2 + a);
      gl.vertexAttribPointer(2 + a, 3, gl.FLOAT, false, I * 4, a * 12);
      gl.vertexAttribDivisor(2 + a, 1);
    }
    gl.bindVertexArray(null);
  }

  clear() {
    this.count = 0;
  }

  // Bursts a broken breakable occupying [mins, maxs] (world space) into chunks.
  // r, g, b: its average albedo (0..255); material: MAT_* of the breakable.
  burst(mins, maxs, o, material, r, g, b) {
    const sx = maxs[o] - mins[o], sy = maxs[o + 1] - mins[o + 1], sz = maxs[o + 2] - mins[o + 2];
    const cx = mins[o] + sx / 2, cy = mins[o + 1] + sy / 2, cz = mins[o + 2] + sz / 2;
    const glassy = material === MAT_GLASS || material === MAT_UNBREAKABLE_GLASS;
    // Thin panes (glass) scale with area, solid boxes with volume.
    const size = glassy ? Math.sqrt(sx * sy + sy * sz + sx * sz) / 12 : Math.cbrt(sx * sy * sz) / 6;
    const n = Math.min(Math.max(Math.round(size * (glassy ? 2 : 3)), 6), 28);
    const tint = glassy ? 0.5 : 0;
    for (let k = 0; k < n && this.count < this.capacity; k++) {
      const s = this.sim;
      const o2 = this.count++ * S;
      s[o2] = cx + rand(-0.4, 0.4) * sx;
      s[o2 + 1] = cy + rand(-0.4, 0.4) * sy;
      s[o2 + 2] = cz + rand(-0.4, 0.4) * sz;
      // Outward from the center, plus a pop upward.
      const dx = s[o2] - cx, dy = s[o2 + 1] - cy, dz = s[o2 + 2] - cz;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const speed = rand(60, glassy ? 220 : 170);
      s[o2 + 3] = dx / dl * speed + rand(-30, 30);
      s[o2 + 4] = dy / dl * speed + rand(-30, 30);
      s[o2 + 5] = Math.max(dz / dl * speed, 0) + rand(60, 200);
      for (let a = 0; a < 3; a++) {
        s[o2 + 6 + a] = rand(0, 6.283);
        s[o2 + 9 + a] = rand(-12, 12);
      }
      chunkShape(material, s, o2 + 12);
      const shade = rand(0.8, 1.15);
      s[o2 + 15] = Math.min((r / 255 * (1 - tint) + tint * 0.85) * shade, 1);
      s[o2 + 16] = Math.min((g / 255 * (1 - tint) + tint * 0.95) * shade, 1);
      s[o2 + 17] = Math.min((b / 255 * (1 - tint) + tint * 1.0) * shade, 1);
      s[o2 + 18] = rand(5, 9);
      s[o2 + 19] = 0;
    }
  }

  // A short burst of n small chunks at a point (blood hits).
  puff(x, y, z, r, g, b, n) {
    for (let k = 0; k < n && this.count < this.capacity; k++) {
      const s = this.sim;
      const o = this.count++ * S;
      s[o] = x;
      s[o + 1] = y;
      s[o + 2] = z;
      s[o + 3] = rand(-90, 90);
      s[o + 4] = rand(-90, 90);
      s[o + 5] = rand(0, 140);
      for (let a = 0; a < 3; a++) {
        s[o + 6 + a] = rand(0, 6.283);
        s[o + 9 + a] = rand(-8, 8);
        s[o + 12 + a] = rand(0.8, 2);
      }
      const shade = rand(0.7, 1.1);
      s[o + 15] = r * shade;
      s[o + 16] = g * shade;
      s[o + 17] = b * shade;
      s[o + 18] = rand(0.6, 1.1);
      s[o + 19] = 0;
    }
  }

  update(dt, world) {
    const s = this.sim, t = this.trace;
    for (let i = 0; i < this.count; i++) {
      const o = i * S;
      s[o + 18] -= dt;
      if (s[o + 18] <= 0) { // dead: move the last chunk into this slot
        this.count--;
        s.copyWithin(o, this.count * S, this.count * S + S);
        i--;
        continue;
      }
      if (s[o + 19]) continue; // resting

      s[o + 5] -= GRAVITY * dt;
      const ex = s[o] + s[o + 3] * dt, ey = s[o + 1] + s[o + 4] * dt, ez = s[o + 2] + s[o + 5] * dt;
      traceHull(world, HULL_POINT, s[o], s[o + 1], s[o + 2], ex, ey, ez, t);
      if (t.fraction < 1 && !t.startsolid) {
        s[o] = t.endx + t.nx * 0.5;
        s[o + 1] = t.endy + t.ny * 0.5;
        s[o + 2] = t.endz + t.nz * 0.5;
        const vn = s[o + 3] * t.nx + s[o + 4] * t.ny + s[o + 5] * t.nz;
        for (let a = 0; a < 3; a++) {
          const n = a === 0 ? t.nx : a === 1 ? t.ny : t.nz;
          s[o + 3 + a] = (s[o + 3 + a] - vn * n) * FRICTION - vn * n * BOUNCE;
          s[o + 9 + a] *= 0.5;
        }
        // Settled on a floor: stop simulating it.
        if (t.nz > 0.7 && Math.hypot(s[o + 3], s[o + 4], s[o + 5]) < 40) {
          s[o + 19] = 1;
          s[o + 6] = Math.round(s[o + 6] / Math.PI) * Math.PI; // lie flat
          s[o + 7] = Math.round(s[o + 7] / Math.PI) * Math.PI;
        }
      } else if (t.startsolid) {
        s[o + 19] = 1; // spawned inside a wall: leave it be
      } else {
        s[o] = ex;
        s[o + 1] = ey;
        s[o + 2] = ez;
      }
      s[o + 6] += s[o + 9] * dt;
      s[o + 7] += s[o + 10] * dt;
      s[o + 8] += s[o + 11] * dt;
    }
  }

  draw(viewProj) {
    if (this.count === 0) return;
    const s = this.sim, d = this.inst;
    for (let i = 0; i < this.count; i++) {
      const o = i * S, p = i * I;
      const k = Math.min(s[o + 18] / FADE_TIME, 1);
      d[p] = s[o];
      d[p + 1] = s[o + 1];
      d[p + 2] = s[o + 2];
      d[p + 3] = s[o + 12] * k;
      d[p + 4] = s[o + 13] * k;
      d[p + 5] = s[o + 14] * k;
      d[p + 6] = s[o + 6];
      d[p + 7] = s[o + 7];
      d[p + 8] = s[o + 8];
      d[p + 9] = s[o + 15];
      d[p + 10] = s[o + 16];
      d[p + 11] = s[o + 17];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, this.count * I);
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.count);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
}

// Chunk dimensions (units) by material: what GoldSrc's gib models looked like.
function chunkShape(material, s, o) {
  switch (material) {
    case MAT_WOOD: // splinters and plank pieces
      s[o] = rand(5, 16); s[o + 1] = rand(1.2, 3); s[o + 2] = rand(0.6, 2);
      break;
    case MAT_GLASS:
    case MAT_UNBREAKABLE_GLASS: // flat shards
      s[o] = rand(2, 7); s[o + 1] = rand(2, 7); s[o + 2] = 0.25;
      break;
    case MAT_METAL: // bent plates
      s[o] = rand(4, 10); s[o + 1] = rand(3, 8); s[o + 2] = 0.6;
      break;
    case MAT_CEILING_TILE:
      s[o] = rand(5, 10); s[o + 1] = rand(5, 10); s[o + 2] = 1;
      break;
    case MAT_COMPUTER:
    case MAT_FLESH:
      s[o] = rand(2, 5); s[o + 1] = rand(2, 5); s[o + 2] = rand(2, 5);
      break;
    case MAT_CINDER:
    default: // cinder block, rocks
      s[o] = rand(3, 7); s[o + 1] = rand(3, 7); s[o + 2] = rand(3, 7);
  }
}
