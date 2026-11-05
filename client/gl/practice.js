// Practice marks of the demo mode and the sandbox, after CS:GO players' practice configs:
// `sv_grenade_trajectory` draws the arc of every grenade in flight as an inked line in its
// kind's color, kept TRAIL_KEEP seconds after it lands, with a ring where it landed;
// `sv_showimpacts` draws our own bullets' impacts (the predicted ones) as small red boxes
// for IMPACT_KEEP seconds. TrajectoryLog and ImpactLog keep the points (pure, tested);
// PracticeMarks draws them into the G-buffer as an overlay: the lines thin and flat with a
// thin rim of their own, on top of everything (through walls, as CS:GO's); the boxes with
// the debris cube shader.

import { program } from './program.js';
import { TRAIL_VS, TRAIL_FS, DEBRIS_VS, DEBRIS_FS } from './shaders.js';
import { cubeInstances, drawCubes } from './debris.js';
import { WEAPON_ID } from '../../shared/weapons.js';

export const TRAIL_KEEP = 3; // seconds a landed grenade's arc stays
export const TRAIL_POINTS = 512; // points kept per arc (a long one is thinned to fit)
export const IMPACT_KEEP = 2; // seconds an impact box stays
export const MAX_IMPACTS = 64;
const RING_R = 12, RING_SEGS = 16; // where a grenade landed
const MAX_SEGMENTS = 4096;
const LINE_PX = 4; // line width, canvas pixels at 1080 lines (scaled with the canvas height), the rim included
const RIM_PX = 1; // at 1080 lines
const BOX = 2.5; // impact box size (units)
const BOX_COLOR = [0.9, 0.16, 0.1];

// Line colors by grenade.
const COLORS = new Map([
  [WEAPON_ID.hegrenade, [0.88, 0.2, 0.14]],
  [WEAPON_ID.flashbang, [0.96, 0.95, 0.82]],
  [WEAPON_ID.smokegrenade, [0.62, 0.66, 0.72]],
  [WEAPON_ID.molotov, [1, 0.56, 0.1]],
  [WEAPON_ID.incgrenade, [1, 0.56, 0.1]],
  [WEAPON_ID.decoy, [0.36, 0.66, 0.3]],
]);
const DEFAULT_COLOR = [1, 0.82, 0.23];

// The arcs of the grenades: per grenade id its points, from each grenade list (the
// server's every tick, or the sandbox's own), until TRAIL_KEEP after it landed (came to
// rest, or left the list: popped, burst, gone).
export class TrajectoryLog {
  constructor() {
    this.trails = new Map(); // id -> { weapon, pts, n, landedAt (-1: flying) }
  }

  clear() {
    this.trails.clear();
  }

  // list: shared/grenades.js Grenades (count, id, weapon, pos, resting); now: seconds.
  record(list, now) {
    for (const t of this.trails.values()) t.seen = false;
    for (let k = 0; k < list.count; k++) {
      const id = list.id[k];
      let t = this.trails.get(id);
      if (!t) this.trails.set(id, t = { weapon: list.weapon[k], pts: new Float32Array(TRAIL_POINTS * 3), n: 0, landedAt: -1 });
      t.seen = true;
      if (t.landedAt >= 0) continue;
      const x = list.pos[k * 3], y = list.pos[k * 3 + 1], z = list.pos[k * 3 + 2], p = t.pts;
      const last = (t.n - 1) * 3;
      if (t.n === 0 || p[last] !== Math.fround(x) || p[last + 1] !== Math.fround(y) || p[last + 2] !== Math.fround(z)) {
        if (t.n === TRAIL_POINTS) { // full: keep every other point
          for (let i = 1; i < TRAIL_POINTS / 2; i++) p.copyWithin(i * 3, i * 6, i * 6 + 3);
          t.n = TRAIL_POINTS / 2;
        }
        p[t.n * 3] = x;
        p[t.n * 3 + 1] = y;
        p[t.n * 3 + 2] = z;
        t.n++;
      }
      if (list.resting[k]) t.landedAt = now;
    }
    for (const [id, t] of this.trails) {
      if (!t.seen && t.landedAt < 0) t.landedAt = now;
      if (t.landedAt >= 0 && now - t.landedAt > TRAIL_KEEP) this.trails.delete(id);
    }
  }

  // Drops arcs older than TRAIL_KEEP at `now` (no new list came: the last grenade gone).
  expire(now) {
    for (const [id, t] of this.trails) if (t.landedAt >= 0 && now - t.landedAt > TRAIL_KEEP) this.trails.delete(id);
  }
}

// Our impacts: a ring of the newest MAX_IMPACTS, each shown IMPACT_KEEP seconds.
export class ImpactLog {
  constructor() {
    this.pos = new Float32Array(MAX_IMPACTS * 3);
    this.at = new Float64Array(MAX_IMPACTS).fill(-Infinity);
    this.next = 0;
  }

  clear() {
    this.at.fill(-Infinity);
  }

  add(x, y, z, now) {
    const k = this.next;
    this.next = (k + 1) % MAX_IMPACTS;
    this.pos[k * 3] = x;
    this.pos[k * 3 + 1] = y;
    this.pos[k * 3 + 2] = z;
    this.at[k] = now;
  }

  // Calls fn(x, y, z) for every impact still shown at `now`; returns how many.
  each(now, fn) {
    let n = 0;
    for (let k = 0; k < MAX_IMPACTS; k++) {
      if (now - this.at[k] > IMPACT_KEEP || now < this.at[k]) continue;
      fn(this.pos[k * 3], this.pos[k * 3 + 1], this.pos[k * 3 + 2]);
      n++;
    }
    return n;
  }
}

const I = 12; // impact box instance floats: pos, scale, rot, color

export class PracticeMarks {
  constructor(gl) {
    this.gl = gl;
    this.trails = new TrajectoryLog();
    this.impacts = new ImpactLog();
    this.showTrails = false; // sv_grenade_trajectory, in the demo or the sandbox
    this.showImpacts = false; // sv_showimpacts, likewise
    this.now = 0; // seconds
    this.screen = new Float32Array(2); // canvas pixels
    // Lines: one instance a segment (its two ends and color), a quad made in TRAIL_VS.
    this.seg = new Float32Array(MAX_SEGMENTS * 9);
    this.lineProg = program(gl, TRAIL_VS, TRAIL_FS, ['u_viewProj', 'u_screen', 'u_width', 'u_rim']);
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.seg.byteLength, gl.DYNAMIC_DRAW);
    for (let a = 0; a < 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 36, a * 12);
      gl.vertexAttribDivisor(a, 1);
    }
    // Boxes: a unit cube (debris shader), one instance an impact.
    this.inst = new Float32Array(MAX_IMPACTS * I);
    this.boxProg = program(gl, DEBRIS_VS, DEBRIS_FS, ['u_viewProj']);
    ({ vao: this.boxVao, vbo: this.boxVbo } = cubeInstances(gl, MAX_IMPACTS));
    this.addBox = (x, y, z) => {
      const d = this.inst, o = this.boxCount++ * I;
      d[o] = x; d[o + 1] = y; d[o + 2] = z;
      d[o + 3] = d[o + 4] = d[o + 5] = BOX;
      d[o + 6] = d[o + 7] = d[o + 8] = 0;
      d[o + 9] = BOX_COLOR[0]; d[o + 10] = BOX_COLOR[1]; d[o + 11] = BOX_COLOR[2];
    };
    this.boxCount = 0;
  }

  clear() {
    this.trails.clear();
    this.impacts.clear();
  }

  // The segments of every arc and landing ring into `seg`; returns how many.
  buildSegments() {
    const s = this.seg;
    let n = 0;
    const push = (ax, ay, az, bx, by, bz, c) => {
      if (n === MAX_SEGMENTS) return;
      const o = n++ * 9;
      s[o] = ax; s[o + 1] = ay; s[o + 2] = az;
      s[o + 3] = bx; s[o + 4] = by; s[o + 5] = bz;
      s[o + 6] = c[0]; s[o + 7] = c[1]; s[o + 8] = c[2];
    };
    for (const t of this.trails.trails.values()) {
      const c = COLORS.get(t.weapon) || DEFAULT_COLOR, p = t.pts;
      for (let i = 1; i < t.n; i++) push(p[i * 3 - 3], p[i * 3 - 2], p[i * 3 - 1], p[i * 3], p[i * 3 + 1], p[i * 3 + 2], c);
      if (t.landedAt >= 0 && t.n) {
        const x = p[t.n * 3 - 3], y = p[t.n * 3 - 2], z = p[t.n * 3 - 1];
        for (let k = 0; k < RING_SEGS; k++) {
          const a0 = k / RING_SEGS * Math.PI * 2, a1 = (k + 1) / RING_SEGS * Math.PI * 2;
          push(x + Math.cos(a0) * RING_R, y + Math.sin(a0) * RING_R, z, x + Math.cos(a1) * RING_R, y + Math.sin(a1) * RING_R, z, c);
        }
      }
    }
    return n;
  }

  // One draw of each, clipped away (map load: see CLIP_ALL).
  warm(clipAll) {
    const st = [this.showTrails, this.showImpacts];
    this.showTrails = this.showImpacts = true;
    this.impacts.add(0, 0, 0, this.now);
    this.trails.trails.set(-1, { weapon: 0, pts: new Float32Array([0, 0, 0, 1, 1, 1]), n: 2, landedAt: this.now });
    this.draw(clipAll);
    this.clear();
    [this.showTrails, this.showImpacts] = st;
  }

  draw(viewProj) {
    const gl = this.gl;
    if (this.showImpacts) {
      this.boxCount = 0;
      this.impacts.each(this.now, this.addBox);
      if (this.boxCount) drawCubes(gl, this.boxProg, this.boxVao, this.boxVbo, this.inst, this.boxCount, viewProj);
    }
    if (this.showTrails) {
      this.trails.expire(this.now);
      const n = this.buildSegments();
      if (n) {
        gl.useProgram(this.lineProg.p);
        gl.uniformMatrix4fv(this.lineProg.loc.u_viewProj, false, viewProj);
        gl.uniform2fv(this.lineProg.loc.u_screen, this.screen);
        gl.uniform1f(this.lineProg.loc.u_width, Math.max(2.5, LINE_PX * this.screen[1] / 1080));
        gl.uniform1f(this.lineProg.loc.u_rim, Math.max(0.6, RIM_PX * this.screen[1] / 1080));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.seg, 0, n * 9);
        gl.bindVertexArray(this.lineVao);
        gl.disable(gl.DEPTH_TEST); // on top of everything, through walls
        gl.disable(gl.CULL_FACE);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        gl.enable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);
      }
    }
    gl.bindVertexArray(null);
  }
}
