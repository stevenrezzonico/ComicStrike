// Grenades in the world (shared/grenades.js lists, from the server or the offline
// simulation): flying grenades as their models, spinning, interpolated between the two
// newest lists; smoke clouds as a billowing cluster of smooth puffs around a core (they
// bulge out as it pops, churn and swell slowly, drop away one by one at the end), fires
// as a patch of flame cones, flashbang pops as glowing balls (HE blasts are
// client/gl/blast.js). Opaque and depth-tested, so a smoke cloud hides what is behind it.
// One draw call per grenade, effect or puff; nothing allocates per frame.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import {
  Grenades, smokeRadius, fireRadius, FX_FLASH, FX_SMOKE, FX_FIRE, FX_FIZZLE, MAX_GRENADES, MAX_EFFECTS, SMOKE_TIME,
} from '../../shared/grenades.js';

const SPHERE = [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1]];

// Deterministic scatter for the meshes.
function scatter(n, seed) {
  const out = [];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) out.push([rnd(), rnd(), rnd(), rnd()]);
  return out;
}

// Smoke: a core and SMOKE_PUFFS puffs per cloud, each its own draw (they churn). Puffs
// are smooth balls of one blue-grey (a darker ring along the ground), half sunk into the
// core so the outline scallops, lit at least SMOKE_LIGHT so their dots stay on the shadow
// side.
const SMOKE_PUFFS = 24;
const SMOKE_LIGHT = 1.35;
const SMOKE_COLORS = [[0.7, 0.75, 0.82], [0.56, 0.62, 0.72]]; // the cloud, its ground ring
const DRAWS = MAX_GRENADES + MAX_EFFECTS * (SMOKE_PUFFS + 1);

function buildSmokePuff(color) {
  return new MeshBuilder().color(color).sphere(1, 14, 7).build();
}

// Deterministic 0..1 noise for a puff layout (no allocation).
function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// A fire patch of radius 1: flame cones, taller in the middle. Drawn emissive (colors
// times 1.6): deep orange, yellow cores.
function buildFire() {
  const b = new MeshBuilder();
  scatter(26, 11).forEach(([a, r, h], i) => {
    const ang = a * Math.PI * 2, d = Math.sqrt(r) * 0.92, tall = (1.15 - d) * (0.45 + h * 0.55);
    b.color(i % 3 ? [0.62, 0.22, 0.04] : [0.62, 0.48, 0.1]).push().translate(Math.cos(ang) * d, Math.sin(ang) * d, 0)
      .lathe([[0.09, 0], [0.06, tall * 0.55], [0, tall]], 4).pop();
  });
  return b.build();
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
    this.fire = new SkinnedMesh(gl, buildFire());
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
    }
  }

  // Builds this frame's draws at render tick `t` (fractional server ticks).
  update(t, surfaces) {
    const c = this.cur, p = this.prev, span = this.curTick - this.prevTick;
    const a = span > 0 ? Math.min(Math.max((t - this.prevTick) / span, 0), 1.5) : 1;
    let n = 0;
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
        mesh = this.fire;
        sx = fireRadius(age);
        sz = 46 * (0.85 + 0.15 * Math.sin(age * 23 + k)); // flicker
        glow = 1;
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

  draw(viewProj) {
    if (!this.n) return;
    const r = this.renderer;
    r.begin(viewProj);
    for (let i = 0; i < this.n; i++) r.draw(this.mesh[i], this.model[i], IDENTITY_SKIN, this.light[i], this.emissive[i]);
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
