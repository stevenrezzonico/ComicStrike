// Grenades in the world (shared/grenades.js lists, from the server or the offline
// simulation): flying grenades as their models, spinning, interpolated between the two
// newest lists; smoke clouds as one cluster of flat-shaded puffs, fires as a patch of
// flame cones, flashbang pops as glowing balls (HE blasts are client/gl/blast.js).
// Opaque and depth-tested, so a smoke cloud hides what is behind it. One draw call per
// grenade or effect.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import {
  Grenades, smokeRadius, fireRadius, FX_FLASH, FX_SMOKE, FX_FIRE, FX_FIZZLE, MAX_GRENADES, MAX_EFFECTS,
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

// A smoke cloud of radius 1: puffs filling a squat dome, two greys.
function buildCloud() {
  const b = new MeshBuilder();
  b.color([0.7, 0.7, 0.68]).push().translate(0, 0, 0.42).scale(0.66, 0.66, 0.5).lathe(SPHERE, 8).pop(); // no gaps
  scatter(14, 7).forEach(([a, r, h, s], i) => {
    const ang = a * Math.PI * 2, d = Math.sqrt(r) * 0.6, size = 0.32 + s * 0.22;
    b.color(i % 3 ? [0.74, 0.74, 0.72] : [0.62, 0.63, 0.62]).push()
      .translate(Math.cos(ang) * d, Math.sin(ang) * d, 0.25 + h * 0.4).scale(size).lathe(SPHERE, 6).pop();
  });
  return b.build();
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
    this.cloud = new SkinnedMesh(gl, buildCloud());
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
    this.mesh = new Array(MAX_GRENADES + MAX_EFFECTS).fill(null);
    this.model = Array.from({ length: MAX_GRENADES + MAX_EFFECTS }, () => new Float32Array(16));
    this.light = Array.from({ length: MAX_GRENADES + MAX_EFFECTS }, () => new Float32Array(3));
    this.emissive = new Uint8Array(MAX_GRENADES + MAX_EFFECTS);
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
        mesh = this.cloud;
        sx = sz = smokeRadius(age);
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
      let light = this.lightOf.get(c.fxId[k]);
      if (!light) {
        light = new Float32Array([1, 1, 1]);
        if (surfaces && surfaces.lightAt(this.lm, x, y, z + 8)) modelLight(light, this.lm);
        this.lightOf.set(c.fxId[k], light);
      }
      this.light[n].set(light);
      n++;
    }
    this.n = n;
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
