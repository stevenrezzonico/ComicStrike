// Grenades in the world (shared/grenades.js lists, from the server or the offline
// simulation): flying grenades as their models, spinning, interpolated between the two
// newest lists; smoke clouds as a billowing cluster of smooth puffs around a core (they
// bulge out as it pops, churn and swell slowly, drop away one by one at the end), fires
// as a patch of flickering comic flame tongues facing the camera with rising embers,
// flashbang pops as glowing balls (HE blasts are client/gl/blast.js). Opaque and
// depth-tested, so a smoke cloud hides what is behind it. One draw call per grenade,
// effect, puff or flame layer; nothing allocates per frame.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight, eyeOf } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import { buildBurst } from './blast.js';
import {
  Grenades, smokeRadius, fireRadius, FX_FLASH, FX_SMOKE, FX_FIRE, FX_FIZZLE, MAX_GRENADES, MAX_EFFECTS, SMOKE_TIME,
  FIRE_TIME,
} from '../../shared/grenades.js';

const SPHERE = [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1]];

// Smoke: a core and SMOKE_PUFFS puffs per cloud, each its own draw (they churn). Puffs
// are smooth balls of one blue-grey (a darker ring along the ground), half sunk into the
// core so the outline scallops, lit at least SMOKE_LIGHT so their dots stay on the shadow
// side.
const SMOKE_PUFFS = 24;
const SMOKE_LIGHT = 1.35;
const SMOKE_COLORS = [[0.7, 0.75, 0.82], [0.56, 0.62, 0.72]]; // the cloud, its ground ring

function buildSmokePuff(color) {
  return new MeshBuilder().color(color).sphere(1, 14, 7).build();
}

// Deterministic 0..1 noise for a puff layout (no allocation).
function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Fire: one blazing mass per patch: BASE_FLAMES wide low flames round its edge and
// TALL_FLAMES tall ones in the middle, each three flat emissive layers standing up and
// turned to face the camera (built in draw, from the eye): a red outer flame, an orange
// one, a big yellow core low in it; their outlines cycle between FLAME_FRAMES shapes so
// the ink boils. Above it a column of dark smoke puffs billows up (SMOKE_COLUMN, starting
// over head height), and EMBERS (small spark bursts, also facing the camera) rise.
const BASE_FLAMES = 10;
const TALL_FLAMES = 6;
const FLAME_FRAMES = 3;
const FLAME_TIME = 0.09; // s per outline
const EMBERS = 6;
const SMOKE_COLUMN = 14;
const COLUMN_SMOKE = [[0.3, 0.29, 0.3], [0.37, 0.36, 0.37]];
const CRACKLE_EVERY = 1.3; // s between CRACKLE! words (onCrackle)
const FLAME_LAYERS = [
  { color: [0.82, 0.2, 0.05], w: 1, h: 1, lift: 0 },
  { color: [0.82, 0.45, 0.06], w: 0.84, h: 0.8, lift: 0.05 },
  { color: [0.85, 0.78, 0.36], w: 0.64, h: 0.56, lift: 0.1 },
];
const PER_EFFECT = Math.max(SMOKE_PUFFS + 1, (BASE_FLAMES + TALL_FLAMES) * FLAME_LAYERS.length + EMBERS + SMOKE_COLUMN);
const DRAWS = MAX_GRENADES + MAX_EFFECTS * PER_EFFECT;

// Park-Miller, so the shapes are the same every load.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// A flame of width 1 and height 1 in the x-z plane (base at z = 0), thin along y: a round
// base, bulging sides with a lick each, and a crown of three licking tips (the middle one
// tallest), swaying.
export function buildFlame(color, seed) {
  const rnd = rng(seed), j = () => rnd() - 0.5, sway = j() * 0.3;
  const at = (x, z) => [x + sway * z * z, z];
  const pts = [];
  for (let k = 0; k <= 6; k++) { // the base, left to right
    const a = Math.PI * k / 6;
    pts.push(at(-0.5 * Math.cos(a), -0.08 * Math.sin(a)));
  }
  pts.push(at(0.52, 0.12), at(0.5 + j() * 0.06, 0.28), at(0.62 + j() * 0.1, 0.42), at(0.4, 0.45)); // right side, a lick
  pts.push(at(0.36 + j() * 0.06, 0.74 + j() * 0.1), at(0.18, 0.5 + j() * 0.06), at(0.04 + j() * 0.08, 1), // the crown
    at(-0.14, 0.54 + j() * 0.06), at(-0.34 + j() * 0.06, 0.8 + j() * 0.1));
  pts.push(at(-0.4, 0.46), at(-0.58 + j() * 0.08, 0.36), at(-0.48, 0.26), at(-0.52, 0.12)); // left side, a lick
  return new MeshBuilder().color(color).extrude(pts, 0.05).build();
}

function buildBall(color) {
  return new MeshBuilder().color(color).lathe(SPHERE, 8).build();
}

export class GrenadeFx {
  // guns: GunMeshes (grenade models).
  constructor(gl, guns) {
    this.gl = gl;
    this.guns = guns;
    this.renderer = new SkinnedRenderer(gl);
    this.puffs = SMOKE_COLORS.map((c) => new SkinnedMesh(gl, buildSmokePuff(c)));
    this.flames = FLAME_LAYERS.map((l, i) =>
      Array.from({ length: FLAME_FRAMES }, (_, f) => new SkinnedMesh(gl, buildFlame(l.color, 211 + i * 37 + f * 11))));
    this.spark = new SkinnedMesh(gl, buildBurst([0.8, 0.7, 0.25], 57));
    this.columnPuffs = COLUMN_SMOKE.map((c) => new SkinnedMesh(gl, buildSmokePuff(c)));
    this.crackled = new Map(); // fire id -> the last CRACKLE! beat
    this.onCrackle = null; // (x, y, z) now and then while a fire burns
    this.pop = new SkinnedMesh(gl, buildBall([0.62, 0.62, 0.6]));
    this.fizzle = new SkinnedMesh(gl, buildBall([0.5, 0.5, 0.48]));
    this.cur = new Grenades(); // newest list
    this.prev = new Grenades(); // the one before, for interpolation
    this.curTick = 0;
    this.prevTick = 0;
    this.version = 0; // bumps on push
    // Per frame: what to draw.
    this.n = 0;
    this.mesh = new Array(DRAWS).fill(null);
    this.model = Array.from({ length: DRAWS }, () => new Float32Array(16));
    this.light = Array.from({ length: DRAWS }, () => new Float32Array(3));
    this.emissive = new Uint8Array(DRAWS);
    // Draws turned to face the camera in draw(): width, height, lift toward the camera.
    this.face = new Uint8Array(DRAWS);
    this.faceSize = new Float32Array(DRAWS * 3);
    this.faceBase = new Float32Array(DRAWS * 3);
    this.eye = new Float32Array(3);
    this.lightOf = new Map(); // effect id -> map light at it (looked up once)
    this.seen = new Set(); // effect ids already announced
    this.onEffect = null; // (kind, weapon, x, y, z) for each new effect: sounds, debris
    this.onBounce = null; // (x, y, z) when a grenade bounces off a floor
    this.fall = new Map(); // grenade id -> its last height change (bounce detection)
    this.lm = new Float32Array(3);
  }

  clear() {
    this.cur.clear();
    this.prev.clear();
    this.seen.clear();
    this.lightOf.clear();
    this.crackled.clear();
  }

  // A new list for server tick `tick` (copied).
  push(g, tick) {
    for (let k = 0; k < g.count; k++) { // falling, then rising again: a bounce
      const j = indexOf(this.cur.id, this.cur.count, g.id[k]);
      if (j < 0) continue;
      const dz = g.pos[k * 3 + 2] - this.cur.pos[j * 3 + 2], before = this.fall.get(g.id[k]) ?? 0;
      if (before < -0.5 && dz > 0.2 && this.onBounce) this.onBounce(g.pos[k * 3], g.pos[k * 3 + 1], g.pos[k * 3 + 2]);
      this.fall.set(g.id[k], dz);
    }
    if (this.fall.size > 64) this.fall.clear();
    copyGrenades(this.prev, this.cur);
    this.prevTick = this.curTick;
    copyGrenades(this.cur, g);
    this.curTick = tick;
    this.version++;
    for (let k = 0; k < g.fxCount; k++) {
      const id = g.fxId[k];
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.onEffect) this.onEffect(g.fxKind[k], g.fxWeapon[k], g.fxPos[k * 3], g.fxPos[k * 3 + 1], g.fxPos[k * 3 + 2]);
    }
    if (this.seen.size > 256) { // forget ids no longer listed
      const live = new Set(Array.from(g.fxId.subarray(0, g.fxCount)));
      for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);
      for (const id of this.lightOf.keys()) if (!live.has(id)) this.lightOf.delete(id);
      for (const id of this.crackled.keys()) if (!live.has(id)) this.crackled.delete(id);
    }
  }

  // Builds this frame's draws at render tick `t` (fractional server ticks).
  update(t, surfaces) {
    const c = this.cur, p = this.prev, span = this.curTick - this.prevTick;
    const a = span > 0 ? Math.min(Math.max((t - this.prevTick) / span, 0), 1.5) : 1;
    let n = 0;
    this.face.fill(0);
    for (let k = 0; k < c.count; k++) {
      const mesh = this.guns.mesh[c.weapon[k]];
      if (!mesh) continue;
      let x = c.pos[k * 3], y = c.pos[k * 3 + 1], z = c.pos[k * 3 + 2];
      const j = indexOf(p.id, p.count, c.id[k]);
      if (j >= 0) {
        x = p.pos[j * 3] + (x - p.pos[j * 3]) * a;
        y = p.pos[j * 3 + 1] + (y - p.pos[j * 3 + 1]) * a;
        z = p.pos[j * 3 + 2] + (z - p.pos[j * 3 + 2]) * a;
      }
      const spin = j >= 0 && Math.hypot(c.pos[k * 3] - p.pos[j * 3], c.pos[k * 3 + 2] - p.pos[j * 3 + 2]) > 0.05
        ? t * 0.6 + c.id[k] : c.id[k];
      place(this.model[n], x, y, z, spin, 1, 1, 1);
      this.mesh[n] = mesh;
      this.emissive[n] = 0;
      if (surfaces && surfaces.lightAt(this.lm, x, y, z + 4)) modelLight(this.light[n], this.lm);
      else this.light[n].fill(1);
      n++;
    }
    const ahead = (t - this.curTick) / 64; // seconds since the newest list
    for (let k = 0; k < c.fxCount; k++) {
      const kind = c.fxKind[k], age = c.fxAge[k] + ahead;
      const x = c.fxPos[k * 3], y = c.fxPos[k * 3 + 1], z = c.fxPos[k * 3 + 2];
      let mesh = null, sx = 1, sz = 1, glow = 0;
      if (kind === FX_SMOKE) {
        n = this.smoke(n, c.fxId[k], age, x, y, z, this.lightAt(c.fxId[k], x, y, z, surfaces));
        continue;
      } else if (kind === FX_FIRE) {
        n = this.fire(n, c.fxId[k], age, x, y, z, this.lightAt(c.fxId[k], x, y, z, surfaces));
        continue;
      } else if (kind === FX_FLASH) {
        mesh = this.pop;
        sx = sz = 40 * Math.max(0, 1 - age / 0.2);
        glow = 1;
      } else if (kind === FX_FIZZLE) {
        mesh = this.fizzle;
        sx = sz = 30 * Math.max(0, 1 - age / 0.6);
      }
      if (!mesh || sx <= 0.5) continue;
      place(this.model[n], x, y, z, k * 1.7, sx, sx, sz);
      this.mesh[n] = mesh;
      this.emissive[n] = glow;
      this.light[n].set(this.lightAt(c.fxId[k], x, y, z, surfaces));
      n++;
    }
    this.n = n;
  }

  // The map light at effect `id` (looked up once).
  lightAt(id, x, y, z, surfaces) {
    let light = this.lightOf.get(id);
    if (!light) {
      light = new Float32Array([1, 1, 1]);
      if (surfaces && surfaces.lightAt(this.lm, x, y, z + 8)) modelLight(light, this.lm);
      this.lightOf.set(id, light);
    }
    return light;
  }

  // The draws of smoke cloud `id`, `age` seconds old, resting at (x, y, z), from draw n;
  // returns the next free draw. A core (a squat dome) keeps it opaque; the puffs sit half
  // sunk in its surface, spread evenly over it (a golden spiral up from the ground), bulge
  // out as it pops, drift round and swell, and drop away one by one in the last seconds
  // while the core shrinks with the cloud (smokeRadius).
  smoke(n, id, age, x, y, z, mapLight) {
    const R = smokeRadius(age);
    if (R < 1) return n;
    const pop = 1 + Math.sin(Math.min(1, age / 1.2) * Math.PI) * 0.18; // bulge while popping
    const rx = R * 0.66, rz = R * 0.52, cz = R * 0.3, turn = hash(id) * 6.283;
    for (let i = 0; i <= SMOKE_PUFFS; i++) {
      let px = 0, py = 0, pz = cz, sx = rx, sz = rz, ground = false;
      if (i < SMOKE_PUFFS) {
        const u = (i + 0.5) / SMOKE_PUFFS, e = Math.asin(u * 0.96) + 0.03 * Math.sin(age * 0.7 + i);
        const a = i * 2.39996 + turn + age * 0.05 * (i & 1 ? 1 : -1);
        // Gone one by one near the end.
        const drop = SMOKE_TIME - 3 + 2.4 * hash(id * 9.1 + i * 3.7);
        const s = R * (0.2 + 0.1 * hash(id * 5.7 + i * 2.3)) * (1 + 0.08 * Math.sin(age * 1.1 + i * 1.9)) *
          Math.max(0, Math.min(1, (drop + 0.6 - age) / 0.6));
        if (s < 1) continue;
        px = Math.cos(e) * Math.cos(a) * rx * 0.92 * pop;
        py = Math.cos(e) * Math.sin(a) * rx * 0.92 * pop;
        pz = cz + Math.sin(e) * rz * 0.92 * pop;
        sx = sz = s;
        ground = e < 0.35;
      }
      place(this.model[n], x + px, y + py, z + pz, i * 0.7, sx, sx, sz);
      this.mesh[n] = this.puffs[ground ? 1 : 0];
      this.emissive[n] = 0;
      for (let c = 0; c < 3; c++) this.light[n][c] = Math.max(mapLight[c], SMOKE_LIGHT);
      n++;
    }
    return n;
  }

  // The draws of fire `id`, `age` seconds old, centered at (x, y, z), from draw n: a ring
  // of wide low flames round the patch's edge and tall ones in its middle (flickering, each
  // outline cycling), three layers each; a column of dark smoke puffs billowing up from
  // over head height; rising embers. All shrink away in the last 0.8 s. Calls onCrackle
  // now and then while it burns.
  fire(n, id, age, x, y, z, mapLight) {
    const R = fireRadius(age), out = Math.max(0, Math.min(1, (FIRE_TIME - age) / 0.8));
    if (R < 1 || out <= 0) return n;
    const turn = hash(id) * 6.283, grow = Math.min(1, age / 0.4);
    const beat = Math.floor((age + hash(id * 1.9) * CRACKLE_EVERY) / CRACKLE_EVERY);
    if (age > 0.6 && out > 0.5 && this.crackled.get(id) !== beat) {
      this.crackled.set(id, beat);
      const a = turn + beat * 2.4;
      if (this.onCrackle) this.onCrackle(x + Math.cos(a) * R * 0.8, y + Math.sin(a) * R * 0.8, z + 30);
    }
    for (let i = 0; i < BASE_FLAMES + TALL_FLAMES; i++) {
      const tall = i >= BASE_FLAMES, k = tall ? i - BASE_FLAMES : i;
      const a = tall ? k * 2.39996 + turn : (k + 0.5 * hash(id * 3.1 + k)) / BASE_FLAMES * 6.283 + turn;
      const d = tall ? Math.sqrt(hash(id * 7.3 + k)) * 0.42 : 0.6 + 0.32 * hash(id * 6.7 + k);
      const flicker = 0.84 + 0.16 * Math.sin(age * 11 + i * 2.3);
      const tallest = tall ? (82 + 40 * hash(id * 4.1 + k)) * (1 - 0.45 * d) : 32 + 16 * hash(id * 4.7 + k);
      const h = tallest * grow * out * flicker;
      if (h < 2) continue;
      const w = h * (tall ? 1.05 : 1.6), frame = Math.floor(age / FLAME_TIME + i * 1.7) % FLAME_FRAMES;
      const px = x + Math.cos(a) * d * R, py = y + Math.sin(a) * d * R;
      for (let l = 0; l < FLAME_LAYERS.length; l++) {
        const L = FLAME_LAYERS[l];
        this.mesh[n] = this.flames[l][frame];
        this.emissive[n] = 1;
        this.face[n] = 1;
        this.faceSize[n * 3] = w * L.w;
        this.faceSize[n * 3 + 1] = h * L.h;
        this.faceSize[n * 3 + 2] = w * L.lift;
        this.faceBase[n * 3] = px;
        this.faceBase[n * 3 + 1] = py;
        this.faceBase[n * 3 + 2] = z;
        n++;
      }
    }
    for (let e = 0; e < EMBERS; e++) { // little sparks rising off the flames, shrinking
      const rise = (age * 0.9 + hash(id * 2.9 + e)) % 1, a = e * 2.1 + turn + rise * 2;
      const d = hash(id * 5.3 + e) * 0.7 * R, s = 6 * (1 - rise) * out;
      if (s < 1.5) continue;
      this.mesh[n] = this.spark;
      this.emissive[n] = 1;
      this.face[n] = 1;
      this.faceSize[n * 3] = this.faceSize[n * 3 + 1] = s;
      this.faceSize[n * 3 + 2] = 0;
      this.faceBase[n * 3] = x + Math.cos(a) * d;
      this.faceBase[n * 3 + 1] = y + Math.sin(a) * d;
      this.faceBase[n * 3 + 2] = z + 30 + rise * 100;
      n++;
    }
    // Smoke column: puffs born over the flames, growing as they rise and drift, fading out
    // at the top (only those already risen since it caught).
    const drift = turn * 3.1;
    for (let i = 0; i < SMOKE_COLUMN; i++) {
      const rise = (age * 0.3 + i / SMOKE_COLUMN) % 1;
      if (rise > age * 0.3) continue;
      const s = (30 + 62 * rise) * (0.75 + 0.5 * hash(id * 2.3 + i)) *
        Math.sin(Math.min(1, rise / 0.15) * Math.PI / 2) *
        (1 - Math.max(0, (rise - 0.75) / 0.25)) * out * Math.min(1, R / 60);
      if (s < 2) continue;
      // Drifting downwind, each puff off to its own side so the column billows.
      const sway = rise * 50 + 8 * Math.sin(age * 0.8 + i), side = (hash(id * 1.3 + i) - 0.5) * s * 1.1;
      const sx = Math.cos(drift) * sway - Math.sin(drift) * side, sy = Math.sin(drift) * sway + Math.cos(drift) * side;
      place(this.model[n], x + sx, y + sy, z + 70 + rise * 270, i * 0.9, s, s, s * 0.85);
      this.mesh[n] = this.columnPuffs[i & 1];
      this.emissive[n] = 0;
      this.light[n].set(mapLight);
      n++;
    }
    return n;
  }

  draw(viewProj) {
    if (!this.n) return;
    const r = this.renderer;
    // Flames stand up and turn to the camera (thin side away), lifted toward it per layer.
    eyeOf(this.eye, viewProj);
    for (let i = 0; i < this.n; i++) {
      if (!this.face[i]) continue;
      const m = this.model[i], bx = this.faceBase[i * 3], by = this.faceBase[i * 3 + 1];
      const w = this.faceSize[i * 3], h = this.faceSize[i * 3 + 1], lift = this.faceSize[i * 3 + 2];
      let cx = this.eye[0] - bx, cy = this.eye[1] - by;
      const l = Math.sqrt(cx * cx + cy * cy) || 1;
      cx /= l;
      cy /= l;
      m.fill(0);
      m[0] = -cy * w; m[1] = cx * w;
      m[4] = -cx * w; m[5] = -cy * w;
      m[10] = h;
      m[12] = bx + cx * lift; m[13] = by + cy * lift; m[14] = this.faceBase[i * 3 + 2]; m[15] = 1;
    }
    r.begin(viewProj);
    for (let i = 0; i < this.n; i++) {
      r.draw(this.mesh[i], this.model[i], IDENTITY_SKIN, this.light[i], this.emissive[i]);
    }
    r.end();
  }
}

function indexOf(ids, count, id) {
  for (let i = 0; i < count; i++) if (ids[i] === id) return i;
  return -1;
}

// Yaw `spin` (radians) about z, scaled, at (x, y, z).
function place(m, x, y, z, spin, sx, sy, sz) {
  const c = Math.cos(spin), s = Math.sin(spin);
  m.fill(0);
  m[0] = c * sx; m[1] = s * sx;
  m[4] = -s * sy; m[5] = c * sy;
  m[10] = sz;
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
}

function copyGrenades(dst, src) {
  dst.count = src.count;
  dst.id.set(src.id);
  dst.weapon.set(src.weapon);
  dst.pos.set(src.pos);
  dst.fxCount = src.fxCount;
  dst.fxId.set(src.fxId);
  dst.fxKind.set(src.fxKind);
  dst.fxWeapon.set(src.fxWeapon);
  dst.fxPos.set(src.fxPos);
  dst.fxAge.set(src.fxAge);
}
