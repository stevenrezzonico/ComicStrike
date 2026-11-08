// Grenades in the world (shared/grenades.js lists, from the server or the offline
// simulation): flying grenades as their models, spinning, interpolated between the two
// newest lists; smoke clouds as one lumpy comic cloud (it bulges out as it pops, turns
// and breathes slowly, shrinks away at the end), fires as a pool of flame on the floor
// with flickering comic tongues facing the camera rising out of it, a column of dark
// smoke and embers, flashbang pops as white-yellow starbursts (HE blasts are
// client/gl/blast.js). Opaque and depth-tested, so a smoke cloud hides what is behind
// it. One draw call per grenade, effect, cloud, puff, pool or tongue; nothing allocates
// per frame.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight, eyeOf } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import { buildBurst, rng } from './blast.js';
import {
  Grenades, fireRadius, FX_FLASH, FX_SMOKE, FX_FIRE, FX_FIZZLE, MAX_GRENADES, MAX_EFFECTS, FIRE_TIME,
  SMOKE_SHAPES, SMOKE_SQUASH, SMOKE_FLOOR, hash01 as hash, smokeLobes, reachAlong, smokePose,
} from '../../shared/grenades.js';

const SPHERE = [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1]];

// Smoke: one draw per cloud, the shared cloud shape (shared/grenades.js smokeLobes,
// smokePose: the rules test the same shape) warped out of a sphere, squashed and flat
// underneath where it spreads over the floor (the lowest lobes bulge out as a skirt, so it
// pools like CS:GO's); one primitive with smooth normals, so the ink draws one scalloped
// outline round it and only short lines in the valleys between lobes up close (before: a
// core and 24 puffs, each its own draw with its own ink id, which printed as a pile of
// outlined balls). A light warm grey like CS:GO's, lit at least SMOKE_LIGHT so the dots
// stay on its underside. SMOKE_SHAPES clouds are built at load; an effect's id picks one.
const SMOKE_LIGHT = 1.6;
const SMOKE_COLOR = [0.86, 0.86, 0.84];

// `round`: a puff of a fire's column, a lumpy ball with no squash or flat underside.
export function buildSmokeCloud(color, seed, round = false) {
  const lobes = smokeLobes(seed), d = new Float64Array(4);
  const warp = (q) => {
    const l = Math.hypot(q[0], q[1], q[2]) || 1;
    d[0] = q[0] / l;
    d[1] = q[1] / l;
    d[2] = q[2] / l;
    reachAlong(lobes, d);
    const r = d[3];
    return round ? [d[0] * r, d[1] * r, d[2] * r * 0.85] : [d[0] * r, d[1] * r, Math.max(SMOKE_FLOOR, d[2] * r * SMOKE_SQUASH)];
  };
  return new MeshBuilder().color(color).warp(warp).sphere(1, 40, 20).warp().build();
}

// Fire: one blazing mass per patch, after the concept: a pool of flame lying on the floor
// (buildPool: a flat lumpy disc, orange with a yellow middle, breathing) with BASE_FLAMES
// wide low tongues rising round its edge and TALL_FLAMES tall ones in its middle, each a
// flat emissive billboard standing up and turned to face the camera (built in draw, from
// the eye). A tongue is one mesh of three nested outlines (buildFlame: a red tongue, an
// orange one, a yellow core low in it, the inner ones a hair nearer the camera), so the
// ink outlines its silhouette only and the colors inside print flat (before, three draws
// with their own ids and a lift apiece: three outlines, a paper cut-out); FLAME_FRAMES
// shapes cycle every FLAME_TIME so the ink boils. Above it a column of dark lumpy smoke
// puffs billows up (SMOKE_COLUMN, the smoke cloud's shape in a dark grey), and EMBERS
// (small spark bursts, also facing the camera) rise. While it burns a fire holds a warm
// flickering light on the world round it (onBurn: client/gl/flashes.js hold).
const BASE_FLAMES = 10;
const TALL_FLAMES = 6;
const FLAME_FRAMES = 3;
const FLAME_TIME = 0.09; // s per outline
const FLAME_THIN = 0.012; // a tongue's thickness in its own units (width 1); its layers step this much nearer
const FLAME_LAYERS = [ // outer to inner: color, width and height, base height
  { color: [0.82, 0.2, 0.05], w: 1, h: 1, z: 0 },
  { color: [0.86, 0.47, 0.06], w: 0.78, h: 0.76, z: 0.02 },
  { color: [0.92, 0.82, 0.38], w: 0.52, h: 0.46, z: 0.03 },
];
const ARC = 4; // points per arc of a tongue's outline
const POOL = [[0.84, 0.3, 0.05], [0.92, 0.78, 0.32]]; // the pool's rim, its middle
const POOL_SHAPES = 2;
const EMBERS = 10;
const SMOKE_COLUMN = 8;
const COLUMN_SMOKE = [0.52, 0.5, 0.5];
const COLUMN_LIGHT = 1.0; // the column is lit at least this much (darker it printed as black rock)
const CRACKLE_EVERY = 1.3; // s between CRACKLE! words (onCrackle)
const PER_EFFECT = BASE_FLAMES + TALL_FLAMES + 1 + EMBERS + SMOKE_COLUMN;
const DRAWS = MAX_GRENADES + MAX_EFFECTS * PER_EFFECT;

// A comic flame tongue of width 1 and height 1 in the x-z plane (base at z = 0), thin
// along y: the knots of its outline, counter-clockwise from the base's right corner, with
// the angle (degrees) the outline's tangents turn inward from the chords at each: a
// little at a tip (both curves hollow, so it stays sharp and they never cross), a lot in
// the hollow between two tips, outward (negative) where the flanks and the base bulge.
// A round base, a lick out of each flank, a crown of three tips (the middle one tallest).
const TONGUE = [
  [0.5, 0, -12], // the base's right corner
  [0.55, 0.22, -14], // the right flank, bulging out
  [0.66, 0.46, 10], // the right lick's tip
  [0.36, 0.52, 40], // the hollow back into the body
  [0.3, 0.78, 10], // the right crown tip
  [0.15, 0.56, 45], // the hollow between
  [0.03, 1, 10], // the top
  [-0.14, 0.6, 45],
  [-0.32, 0.84, 10], // the left crown tip
  [-0.42, 0.54, 40],
  [-0.62, 0.38, 10], // the left lick's tip
  [-0.52, 0.15, 30], // back in
  [-0.5, 0, -12], // the base's left corner
];

// A tongue: one mesh of FLAME_LAYERS nested outlines (red, orange, a yellow core low in
// it), the inner ones nearer the camera (-y) by their thickness, so from past arm's length
// the ink sees one silhouette and the inner colors print flat; the knots jittered by the
// seed and the whole swaying.
export function buildFlame(seed) {
  const rnd = rng(seed), j = () => rnd() - 0.5, sway = j() * 0.3;
  const knots = TONGUE.map(([x, z, turn], i) =>
    [i && i < TONGUE.length - 1 ? x + j() * 0.08 : x, z > 0.05 ? z + j() * 0.08 : z, turn * Math.PI / 180]);
  const pts = [];
  for (let i = 0; i < knots.length; i++) {
    const [x0, z0, a0] = knots[i], [x1, z1, a1] = knots[(i + 1) % knots.length];
    // A cubic arc leaving the knot along the chord turned inward (to the left of the
    // travel) by its angle and arriving at the next turned the other way, its control
    // points 0.4 of the chord along those tangents.
    const dx = x1 - x0, dz = z1 - z0, k = 0.4;
    const c1x = x0 + k * (dx * Math.cos(a0) - dz * Math.sin(a0)), c1z = z0 + k * (dz * Math.cos(a0) + dx * Math.sin(a0));
    const c2x = x1 - k * (dx * Math.cos(a1) + dz * Math.sin(a1)), c2z = z1 - k * (dz * Math.cos(a1) - dx * Math.sin(a1));
    for (let s = 0; s < ARC; s++) {
      const t = s / ARC, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      const x = b0 * x0 + b1 * c1x + b2 * c2x + b3 * x1, z = b0 * z0 + b1 * c1z + b2 * c2z + b3 * z1;
      pts.push([x + sway * z * z, z]);
    }
  }
  const b = new MeshBuilder();
  FLAME_LAYERS.forEach((L, l) => {
    b.color(L.color).push().translate(0, -l * FLAME_THIN, L.z).scale(L.w, 1, L.h).extrude(pts, FLAME_THIN).pop();
  });
  return b.build();
}

// The pool of flame on the floor: a flat lumpy disc of radius about 1 in the pool's rim
// color with a smaller one in its middle color a hair higher, one mesh, lying in the x-y
// plane; drawn on the floor scaled to the fire's radius.
export function buildPool(seed) {
  const b = new MeshBuilder();
  POOL.forEach((color, l) => {
    const p1 = seed * 2.1 + l * 1.3, p2 = seed * 0.7 + l * 2.9, lobes = 8 + l;
    const warp = (q) => {
      const a = Math.atan2(q[1], q[0]), s = 1 + 0.12 * Math.sin(lobes * a + p1) + 0.06 * Math.sin(3 * a + p2);
      return [q[0] * s, q[1] * s, q[2]];
    };
    b.color(color).warp(warp).push().translate(0, 0, l * 0.008).scale(l ? 0.58 : 1, l ? 0.58 : 1, 1)
      .lathe([[0, -0.003], [1, -0.003], [1, 0.003], [0, 0.003]], 36).pop().warp();
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
    this.clouds = Array.from({ length: SMOKE_SHAPES }, (_, i) => new SkinnedMesh(gl, buildSmokeCloud(SMOKE_COLOR, i + 1)));
    this.flames = Array.from({ length: FLAME_FRAMES }, (_, f) => new SkinnedMesh(gl, buildFlame(211 + f * 11)));
    this.pools = Array.from({ length: POOL_SHAPES }, (_, i) => new SkinnedMesh(gl, buildPool(i + 1)));
    this.spark = new SkinnedMesh(gl, buildBurst([0.8, 0.7, 0.25], 57));
    this.columnPuffs = [4, 5].map((seed) => new SkinnedMesh(gl, buildSmokeCloud(COLUMN_SMOKE, seed, true)));
    this.crackled = new Map(); // fire id -> the last CRACKLE! beat
    this.onCrackle = null; // (x, y, z) now and then while a fire burns
    this.onBurn = null; // (id, x, y, z, r, strength) every frame a fire burns: its light
    // A flashbang's pop: a yellow starburst with a white core, facing the camera.
    this.popStars = [new SkinnedMesh(gl, buildBurst([0.82, 0.74, 0.3], 5)),
      new SkinnedMesh(gl, buildBurst([0.8, 0.8, 0.78], 9))];
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
    this.pose = new Float64Array(7); // a cloud's (smokePose)
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
      let mesh = null, sx = 1, sz = 1;
      if (kind === FX_SMOKE) {
        n = this.smoke(n, c.fxId[k], age, c.fxPos, k * 3, this.lightAt(c.fxId[k], x, y, z, surfaces));
        continue;
      } else if (kind === FX_FIRE) {
        n = this.fire(n, c.fxId[k], age, x, y, z, this.lightAt(c.fxId[k], x, y, z, surfaces));
        continue;
      } else if (kind === FX_FLASH) { // grows in 60 ms, gone 0.3 s later
        const s = 75 * (age < 0.06 ? age / 0.06 : Math.max(0, 1 - (age - 0.06) / 0.3));
        if (s < 1) continue;
        for (let l = 0; l < 2; l++) {
          this.mesh[n] = this.popStars[l];
          this.emissive[n] = 1;
          this.face[n] = 1;
          this.faceSize[n * 3] = this.faceSize[n * 3 + 1] = s * (l ? 0.55 : 1);
          this.faceSize[n * 3 + 2] = l * s * 0.1;
          this.faceBase[n * 3] = x;
          this.faceBase[n * 3 + 1] = y;
          this.faceBase[n * 3 + 2] = z + 8;
          n++;
        }
        continue;
      } else if (kind === FX_FIZZLE) {
        mesh = this.fizzle;
        sx = sz = 30 * Math.max(0, 1 - age / 0.6);
      }
      if (!mesh || sx <= 0.5) continue;
      place(this.model[n], x, y, z, k * 1.7, sx, sx, sz);
      this.mesh[n] = mesh;
      this.emissive[n] = 0;
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

  // The draw of smoke cloud `id`, `age` seconds old, resting at pos[o..o+2], as draw n;
  // returns the next free draw. Placed by smokePose, as the rules place it.
  smoke(n, id, age, pos, o, mapLight) {
    const P = this.pose;
    smokePose(P, id, age, pos, o);
    if (!(P[6] > 0)) return n;
    place(this.model[n], P[0], P[1], P[2], P[3], P[6], P[6], P[6]);
    this.mesh[n] = this.clouds[id % SMOKE_SHAPES];
    this.emissive[n] = 0;
    for (let c = 0; c < 3; c++) this.light[n][c] = Math.max(mapLight[c], SMOKE_LIGHT);
    return n + 1;
  }

  // The draws of fire `id`, `age` seconds old, centered at (x, y, z), from draw n: the
  // pool on the floor, a ring of wide low tongues round its edge and tall ones in its
  // middle (flickering, each outline cycling), a column of dark smoke puffs billowing up
  // from over head height, rising embers. All shrink away in the last 0.8 s. Calls onBurn
  // for its light and onCrackle now and then while it burns.
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
    // Its light: warm, flickering, reaching past the tongues.
    const flare = 0.42 + 0.1 * Math.sin(age * 13 + id) + 0.05 * Math.sin(age * 31 + id * 0.7);
    if (this.onBurn) this.onBurn(id, x, y, z + 24, R * 2.2, flare * grow * out);
    // The pool: flat on the floor, breathing a little, turning slowly.
    const pulse = (1 + 0.04 * Math.sin(age * 9 + id)) * out;
    place(this.model[n], x, y, z + 1, turn + age * 0.05, R * pulse, R * pulse, R);
    this.mesh[n] = this.pools[id % POOL_SHAPES];
    this.emissive[n] = 1;
    n++;
    for (let i = 0; i < BASE_FLAMES + TALL_FLAMES; i++) {
      const tall = i >= BASE_FLAMES, k = tall ? i - BASE_FLAMES : i;
      const a = tall ? k * 2.39996 + turn : (k + 0.5 * hash(id * 3.1 + k)) / BASE_FLAMES * 6.283 + turn;
      const d = tall ? Math.sqrt(hash(id * 7.3 + k)) * 0.42 : 0.55 + 0.3 * hash(id * 6.7 + k);
      const flicker = 0.84 + 0.16 * Math.sin(age * 11 + i * 2.3);
      const tallest = tall ? (82 + 40 * hash(id * 4.1 + k)) * (1 - 0.45 * d) : 32 + 16 * hash(id * 4.7 + k);
      const h = tallest * grow * out * flicker;
      if (h < 2) continue;
      const w = h * (tall ? 1 : 1.5), frame = Math.floor(age / FLAME_TIME + i * 1.7) % FLAME_FRAMES;
      this.mesh[n] = this.flames[frame];
      this.emissive[n] = 1;
      this.face[n] = 1;
      this.faceSize[n * 3] = w;
      this.faceSize[n * 3 + 1] = h;
      this.faceSize[n * 3 + 2] = 0;
      this.faceBase[n * 3] = x + Math.cos(a) * d * R;
      this.faceBase[n * 3 + 1] = y + Math.sin(a) * d * R;
      this.faceBase[n * 3 + 2] = z - 1;
      n++;
    }
    const drift = turn * 3.1, dx = Math.cos(drift), dy = Math.sin(drift);
    for (let e = 0; e < EMBERS; e++) { // little sparks rising off the flames, shrinking, blown with the smoke
      const rise = (age * 1.1 + hash(id * 2.9 + e)) % 1, a = e * 2.1 + turn + rise * 2;
      const d = hash(id * 5.3 + e) * 0.7 * R, s = 8 * (1 - rise) * out;
      if (s < 2) continue;
      this.mesh[n] = this.spark;
      this.emissive[n] = 1;
      this.face[n] = 1;
      this.faceSize[n * 3] = this.faceSize[n * 3 + 1] = s;
      this.faceSize[n * 3 + 2] = 0;
      this.faceBase[n * 3] = x + Math.cos(a) * d + dx * rise * 30;
      this.faceBase[n * 3 + 1] = y + Math.sin(a) * d + dy * rise * 30;
      this.faceBase[n * 3 + 2] = z + 24 + rise * 120;
      n++;
    }
    // Smoke column: puffs born over the flames, growing as they rise and drift, fading out
    // at the top (only those already risen since it caught).
    for (let i = 0; i < SMOKE_COLUMN; i++) {
      const rise = (age * 0.3 + i / SMOKE_COLUMN) % 1;
      if (rise > age * 0.3) continue;
      const s = (16 + 44 * rise) * (0.8 + 0.4 * hash(id * 2.3 + i)) *
        Math.sin(Math.min(1, rise / 0.15) * Math.PI / 2) *
        (1 - Math.max(0, (rise - 0.75) / 0.25)) * out * Math.min(1, R / 60);
      if (s < 2) continue;
      // Drifting downwind, each puff off to its own side so the column billows.
      const sway = rise * 50 + 8 * Math.sin(age * 0.8 + i), side = (hash(id * 1.3 + i) - 0.5) * s * 1.2;
      place(this.model[n], x + dx * sway - dy * side, y + dy * sway + dx * side, z + 60 + rise * 270,
        i * 0.9 + age * 0.2, s, s, s);
      this.mesh[n] = this.columnPuffs[i & 1];
      this.emissive[n] = 0;
      for (let c = 0; c < 3; c++) this.light[n][c] = Math.max(mapLight[c], COLUMN_LIGHT);
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
    const gl = r.gl;
    for (let i = 0; i < this.n; i++) {
      // A cloud's inside is drawn too: with the camera in it the near plane cuts the shell,
      // and the culled back faces left a see-through band (the composite fogs the rest).
      const cloud = this.clouds.includes(this.mesh[i]);
      if (cloud) gl.disable(gl.CULL_FACE);
      r.draw(this.mesh[i], this.model[i], IDENTITY_SKIN, this.light[i], this.emissive[i]);
      if (cloud) gl.enable(gl.CULL_FACE);
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
