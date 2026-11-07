// Comic explosions (the C4, HE grenades): a starburst fireball facing the camera (three
// flat layers, red-orange spikes around an orange ring and a yellow core, their outlines
// cycling between shapes so the ink boils) and white smoke puffs blowing outward and
// rising. Drawn into the G-buffer like any model, so they get ink and dots: the fire is
// emissive (flat, bold line), the smoke shaded by the map light. Visual only; started by
// main's explosion(). The bomb's is bigger and lasts longer: a skirt of smoke rolling out
// along the ground and a column rising out of it. They run on the effects' clock (clock.fx:
// slowed for the bomb, client/bombfx.js). Fixed pools: nothing allocates per frame.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import { clock } from '../clock.js';

const MAX_BLASTS = 6; // at once; the oldest is reused
const RADIUS = 220; // fireball radius of a full-size blast (the C4), units
const FIRE_LIFE = 0.75; // s
const SMOKE_LIFE = 2.6;
const PUFFS = 10;
// The bomb's: its fireball this much bigger, its fire and smoke this long, puffs thrown out
// (PUFFS), rolling out along the ground (SKIRT) and rising in a column (COLUMN).
const BOMB_SCALE = 1.5;
const BOMB_FIRE = 1.5;
const BOMB_SMOKE = 5;
const SKIRT = 12;
const COLUMN = 7;
const MAX_PUFFS = PUFFS + SKIRT + COLUMN;
const P_BURST = 0, P_SKIRT = 1, P_COLUMN = 2;
const FRAMES = 3; // starburst outlines per layer, cycled
const FRAME_TIME = 0.07;
// Fire layers, back to front: color (emissive: drawn x1.25), radius share, when it starts
// shrinking (s), lift toward the camera (share of the radius).
const LAYERS = [
  { color: [0.78, 0.22, 0.06], r: 1, shrink: 0.5, lift: 0 },
  { color: [0.8, 0.5, 0.08], r: 0.72, shrink: 0.36, lift: 0.06 },
  { color: [0.8, 0.76, 0.36], r: 0.42, shrink: 0.22, lift: 0.12 },
];
const SMOKE = [0.94, 0.93, 0.89];
const SMOKE_LIGHT = 1.35; // smoke is lit at least this much (the map's full light is about 1.1)
const SPHERE = [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1]];

// A seeded random stream in [0, 1) (Park-Miller): the same shapes every load.
export function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// A starburst of radius 1 in the x-z plane, thin along y: jagged spikes of uneven length.
export function buildBurst(color, seed) {
  const rnd = rng(seed), n = 11 + Math.floor(rnd() * 4), pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i + (rnd() - 0.5) * 0.5) / (n * 2) * Math.PI * 2;
    const r = i % 2 ? 0.5 + rnd() * 0.12 : 0.8 + rnd() * 0.22;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return new MeshBuilder().color(color).extrude(pts, 0.04).build();
}

// A smoke puff of radius about 1: three overlapping balls.
export function buildPuff(seed) {
  const rnd = rng(seed), b = new MeshBuilder().color(SMOKE);
  b.push().scale(0.8).lathe(SPHERE, 7).pop();
  for (let i = 0; i < 2; i++) {
    const a = rnd() * Math.PI * 2;
    b.push().translate(Math.cos(a) * 0.45, Math.sin(a) * 0.45, (rnd() - 0.3) * 0.4).scale(0.5 + rnd() * 0.15)
      .lathe(SPHERE, 6).pop();
  }
  return b.build();
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Blasts {
  // view: the camera's view matrix (read every draw: the fire faces the camera).
  constructor(gl, view) {
    this.view = view;
    this.renderer = new SkinnedRenderer(gl);
    this.burst = LAYERS.map((l, i) =>
      Array.from({ length: FRAMES }, (_, f) => new SkinnedMesh(gl, buildBurst(l.color, 101 + i * 31 + f * 7))));
    this.puff = [new SkinnedMesh(gl, buildPuff(3)), new SkinnedMesh(gl, buildPuff(17))];
    this.start = new Float64Array(MAX_BLASTS).fill(-1e9);
    this.pos = new Float32Array(MAX_BLASTS * 3);
    this.radius = new Float32Array(MAX_BLASTS);
    this.spin = new Float32Array(MAX_BLASTS);
    this.light = Array.from({ length: MAX_BLASTS }, () => new Float32Array([1, 1, 1]));
    this.dir = new Float32Array(MAX_BLASTS * MAX_PUFFS * 3); // puff directions
    this.size = new Float32Array(MAX_BLASTS * MAX_PUFFS);
    this.kind = new Uint8Array(MAX_BLASTS * MAX_PUFFS); // P_BURST, P_SKIRT, P_COLUMN
    this.puffs = new Uint8Array(MAX_BLASTS);
    this.fireLife = new Float32Array(MAX_BLASTS);
    this.smokeLife = new Float32Array(MAX_BLASTS);
    this.next = 0;
    this.time = 0;
    this.m = new Float32Array(16);
    this.lm = new Float32Array(3);
    this.pp = new Float64Array(4);
  }

  // A blast at (x, y, z), size 1 = the C4's fire; surfaces: SurfaceMap for the light there;
  // bomb: the bomb's (bigger, longer, a skirt and a column).
  add(x, y, z, size = 1, surfaces = null, bomb = false) {
    const k = this.next;
    this.next = (k + 1) % MAX_BLASTS;
    this.start[k] = clock.fx;
    this.pos[k * 3] = x;
    this.pos[k * 3 + 1] = y;
    this.pos[k * 3 + 2] = z;
    this.radius[k] = RADIUS * size * (bomb ? BOMB_SCALE : 1);
    this.fireLife[k] = bomb ? BOMB_FIRE : FIRE_LIFE;
    this.smokeLife[k] = bomb ? BOMB_SMOKE : SMOKE_LIFE;
    this.puffs[k] = bomb ? MAX_PUFFS : PUFFS;
    this.spin[k] = Math.random() * Math.PI * 2;
    if (surfaces && surfaces.lightAt(this.lm, x, y, z + 16)) modelLight(this.light[k], this.lm);
    else this.light[k].fill(1);
    // White smoke: dots only on its shadow side, even in a dim spot.
    for (let c = 0; c < 3; c++) this.light[k][c] = Math.max(this.light[k][c], SMOKE_LIGHT);
    for (let i = 0; i < this.puffs[k]; i++) { // outward, mostly sideways and up
      const kind = i < PUFFS ? P_BURST : i < PUFFS + SKIRT ? P_SKIRT : P_COLUMN;
      const n = kind === P_BURST ? PUFFS : SKIRT, j = kind === P_SKIRT ? i - PUFFS : i;
      const a = (j + Math.random() * 0.6) / n * Math.PI * 2;
      const up = kind === P_SKIRT ? 0.02 + Math.random() * 0.06 : 0.05 + Math.random() * 0.35;
      const h = Math.sqrt(1 - up * up), q = k * MAX_PUFFS + i, o = q * 3;
      this.kind[q] = kind;
      this.dir[o] = Math.cos(a) * h;
      this.dir[o + 1] = Math.sin(a) * h;
      this.dir[o + 2] = up;
      this.size[q] = kind === P_COLUMN ? 0.9 + (i - PUFFS - SKIRT) * 0.18 + Math.random() * 0.2 : 0.8 + Math.random() * 0.45;
    }
  }

  clear() {
    this.start.fill(-1e9);
  }

  draw(viewProj) {
    this.time = clock.fx; // (as add() stamps them)
    let begun = false;
    const r = this.renderer, v = this.view, m = this.m;
    // Camera axes in the world: right, up, and toward the camera.
    const rx = v[0], ry = v[4], rz = v[8], ux = v[1], uy = v[5], uz = v[9], bx = v[2], by = v[6], bz = v[10];
    for (let k = 0; k < MAX_BLASTS; k++) {
      const t = this.time - this.start[k], life = this.smokeLife[k], fireLife = this.fireLife[k];
      if (t < 0 || t > life) continue;
      if (!begun) {
        r.begin(viewProj);
        begun = true;
      }
      const R = this.radius[k], x = this.pos[k * 3], y = this.pos[k * 3 + 1], z = this.pos[k * 3 + 2] + R * 0.3;
      if (t < fireLife) {
        // Pops past full size, settles, then each layer shrinks away (the core first).
        const pop = t < 0.1 ? t / 0.1 * 1.15 : t < 0.2 ? 1.15 - (t - 0.1) * 1.5 : 1, stretch = fireLife / FIRE_LIFE;
        const a = this.spin[k] + t * 0.6, c = Math.cos(a), s = Math.sin(a);
        const frame = Math.floor(t / FRAME_TIME) % FRAMES;
        for (let l = 0; l < LAYERS.length; l++) {
          const L = LAYERS[l], sc = R * L.r * pop * (1 - smooth(L.shrink * stretch, fireLife, t));
          if (sc < 1) continue;
          // Columns: x along the turned right axis, y away from the camera (keeps the
          // winding), z along the turned up axis; lifted toward the camera per layer.
          m[0] = (rx * c + ux * s) * sc; m[1] = (ry * c + uy * s) * sc; m[2] = (rz * c + uz * s) * sc; m[3] = 0;
          m[4] = -bx * R; m[5] = -by * R; m[6] = -bz * R; m[7] = 0;
          m[8] = (ux * c - rx * s) * sc; m[9] = (uy * c - ry * s) * sc; m[10] = (uz * c - rz * s) * sc; m[11] = 0;
          m[12] = x + bx * R * L.lift; m[13] = y + by * R * L.lift; m[14] = z + bz * R * L.lift; m[15] = 1;
          r.draw(this.burst[l][frame], m, IDENTITY_SKIN, this.light[k], 1);
        }
      }
      // Smoke: thrown out fast, slowing, rising; grows, then shrinks away at the end. The
      // bomb's skirt rolls out farther along the ground, growing; its column rises out of
      // the fire, each puff after the last, the top ones bigger (the cap).
      const out = R * 1.1 * (1 - Math.exp(-t * 3)), rise = 25 * t, roll = R * 2.1 * (1 - Math.exp(-t * 1.4));
      const grow = 0.35 + 0.65 * Math.min(1, t / 0.35), fade = 1 - smooth(life - 0.9, life, t);
      for (let i = 0; i < this.puffs[k]; i++) {
        const q = k * MAX_PUFFS + i, o = q * 3, kind = this.kind[q];
        // (the puff's size and place picked by kind into P: doubles through branches box)
        const P = this.pp;
        P[0] = R * 0.26 * this.size[q] * grow * fade;
        if (kind === P_BURST) {
          P[1] = x + this.dir[o] * out;
          P[2] = y + this.dir[o + 1] * out;
          P[3] = z - R * 0.15 + this.dir[o + 2] * out + rise;
        } else if (kind === P_SKIRT) {
          P[0] *= 0.5 + 0.3 * Math.min(1, t / 2);
          P[1] = x + this.dir[o] * roll;
          P[2] = y + this.dir[o + 1] * roll;
          P[3] = z - R * 0.3 + P[0] * 0.5 + this.dir[o + 2] * roll;
        } else {
          const c = i - PUFFS - SKIRT, u = t - 0.12 * c, spread = R * 0.12 * c * (c > COLUMN - 3 ? 1 : 0.2);
          if (u <= 0) continue;
          P[0] *= Math.min(1, u / 0.5);
          P[1] = x + this.dir[o] * spread;
          P[2] = y + this.dir[o + 1] * spread;
          P[3] = z + R * (0.5 + 0.55 * c) * (1 - Math.exp(-u * 0.9));
        }
        if (P[0] < 1) continue;
        m.fill(0);
        m[0] = m[5] = m[10] = P[0];
        m[15] = 1;
        m[12] = P[1];
        m[13] = P[2];
        m[14] = P[3];
        r.draw(this.puff[i & 1], m, IDENTITY_SKIN, this.light[k], 0);
      }
    }
    if (begun) r.end();
  }
}
