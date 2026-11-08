// Thrown grenades and what they leave behind, CS:GO style: the throw (CBaseCSGrenade::
// ThrowGrenade), the toss with bounces (Source's fly-gravity movement and
// ResolveFlyCollisionCustom), fuses, and the effects: HE blast, flashbang, smoke cloud,
// molotov / incendiary fire, decoy. The server runs it (offline, the client does);
// clients draw the lists it keeps (S2C_GRENADES). Preallocated, nothing per tick.
//
// Values marked (approx.) are not in CS:GO's game files (they live in code, particle
// systems or animations) and are estimates.

import { TICK_DT } from './constants.js';
import { Trace, traceHull, pointContents, HULL_POINT } from './trace.js';
import { isLiquid } from './bsp.js';
import { WEAPONS, throwStrength } from './weapons.js';

export const MAX_GRENADES = 32; // in flight (the oldest goes)
export const MAX_EFFECTS = 24;

export const GRENADE_GRAVITY = 800 * 0.4; // sv_gravity times the grenades' gravity scale
export const ELASTICITY = 0.45;
export const FUSE = 1.5; // HE and flashbang
export const FIRE_FUSE = 2.0; // molotov_throw_detonate_time: bursts in the air then
// In water (or slime, lava) a grenade's velocity halves every 0.1 s (HL's CGrenade::TumbleThink),
// per tick here: it sinks at ~49 u/s.
const WATER_DRAG = Math.pow(0.5, TICK_DT / 0.1);
export const FIRE_SLOPE = 0.866; // weapon_molotov_maxdetonateslope 30 degrees: steeper bounces
export const HE_DAMAGE = 99;
export const HE_RADIUS = 350;
export const FLASH_TIME = 4.87; // longest blindness (s)
export const FLASH_RANGE = 1500; // (approx.)
export const SMOKE_TIME = 18;
export const SMOKE_RADIUS = 144; // a cloud's radius once grown
export const SMOKE_GROW = 1; // seconds to grow (approx.)
export const SMOKE_FADE = 3; // shrinking away at the end (approx.)
const DEPTH_AT = new Float64Array(3); // smokeDepth's point (see smokeDepthAt)
export const FIRE_TIME = 7; // inferno_flame_lifetime
export const FIRE_RADIUS = 130; // the spread fire's reach (approx.: CS:GO's spreads irregularly)
export const FIRE_GROW = 1.5; // seconds to spread (approx.)
export const FIRE_DPS = 40; // inferno_damage, per second
export const DECOY_TIME = 15; // (approx.)

// Effect kinds.
export const FX_HE = 1;
export const FX_FLASH = 2;
export const FX_SMOKE = 3;
export const FX_FIRE = 4;
export const FX_DECOY = 5;
export const FX_FIZZLE = 6; // a molotov burst in the air or in smoke
export const FX_BLAST = 7; // an exploding breakable (its weapon byte: the magnitude, at most 255)
const FX_LIFE = [0, 1, 0.5, SMOKE_TIME, FIRE_TIME, DECOY_TIME, 0.6, 1];

// Smoke radius `age` seconds after it popped: grows, holds, shrinks away.
export function smokeRadius(age) {
  if (age < 0 || age > SMOKE_TIME) return 0;
  const grow = Math.min(1, age / SMOKE_GROW), fade = Math.min(1, (SMOKE_TIME - age) / SMOKE_FADE);
  return SMOKE_RADIUS * Math.sqrt(grow) * Math.sqrt(fade);
}

// A smoke cloud's shape: the one the client draws (client/gl/grenadefx.js buildSmokeCloud)
// and the one the rules test (inSmoke, smokeDepth, smokeBetween), so a cloud blocks the
// sight it is drawn over and no other. A unit sphere bulged out by SMOKE_LOBES lobes
// (centers on a golden spiral from a little under the equator to the top, each with its
// own height and width, the lowest higher and wider: a skirt), squashed to SMOKE_SQUASH and
// cut flat at SMOKE_FLOOR, which rests where the grenade lies; it turns, breathes and
// grows as smokePose says. Before, the rules used an ellipsoid 144 wide and 96 tall
// centered on the grenade, half of it under the floor: at a standing eye's height it
// reached 107 units out where the cloud is drawn 131-181 out, and above 96 nothing. In
// that band the view was inside the drawn shell with no fog and saw everything in the
// cloud, and the bots saw through it.
export const SMOKE_LOBES = 22;
export const SMOKE_SHAPES = 3; // an effect's id picks one (smokeLobesOf)
export const SMOKE_SQUASH = 0.6; // height over width
export const SMOKE_FLOOR = -0.36; // the flat underside, in sphere radii under the cloud's middle
const SMOKE_SKIRT = 1.4; // the lowest lobes this much higher and wider
const SMOKE_SIZE = 0.9; // the sphere's radius over smokeRadius
// The view fogs over from SMOKE_MARGIN units outside a cloud and is all smoke from SMOKE_FULL
// out (smokeDepth), both along the line from the cloud's middle: beside a lobe its surface
// is up to ~2.3 times nearer than that says, and the view must be all smoke before the near
// plane (4 units) cuts into the cloud, which would open its inside to view.
export const SMOKE_MARGIN = 26;
export const SMOKE_FULL = 10;
const SMOKE_STEP = 4; // smokeBetween tests points this far apart along a line through a cloud
const LOBE = 6; // numbers a lobe: its center's direction x, y, z, height, half width (radians), its cosine
// A cloud posed (smokePose) and a point in it (cloudDepth): the middle x, y, z, the turn,
// its cosine and sine, the scale (0: not drawn), the point's depth, the point x, y, z, and
// smokeDepthAt's deepest so far. Numbers cross the calls here (doubles passed or returned
// are boxed in V8's Maglev tier).
const SP = new Float64Array(12);
const DIR = new Float64Array(4); // reachAlong's direction and its reach

// Deterministic 0..1 noise (the clouds' lobes and turns; the client's fires use it too).
export function hash01(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// The lobes of the cloud built with `seed` (LOBE numbers each).
export function smokeLobes(seed) {
  const l = new Float64Array(SMOKE_LOBES * LOBE);
  for (let i = 0; i < SMOKE_LOBES; i++) {
    const e = Math.asin(-0.2 + 1.2 * (i + 0.5) / SMOKE_LOBES), a = i * 2.39996 + seed * 1.7;
    const skirt = e < 15 * Math.PI / 180 ? SMOKE_SKIRT : 1, o = i * LOBE;
    l[o] = Math.cos(e) * Math.cos(a);
    l[o + 1] = Math.cos(e) * Math.sin(a);
    l[o + 2] = Math.sin(e);
    l[o + 3] = (0.18 + 0.17 * hash01(seed * 7.3 + i * 2.1)) * skirt;
    l[o + 4] = (18 + 10 * hash01(seed * 3.1 + i * 5.7)) * skirt * Math.PI / 180;
    l[o + 5] = Math.cos(l[o + 4]);
  }
  return l;
}

// How far the cloud of `lobes` reaches along the unit direction d[0..2], in sphere radii
// before its squash, into d[3].
export function reachAlong(lobes, d) {
  d[3] = 1;
  for (let o = 0; o < lobes.length; o += LOBE) {
    const c = d[0] * lobes[o] + d[1] * lobes[o + 1] + d[2] * lobes[o + 2];
    if (c <= lobes[o + 5]) continue; // outside this lobe
    const q = Math.cos(Math.PI * Math.acos(Math.min(1, c)) / (2 * lobes[o + 4]));
    d[3] += lobes[o + 3] * q * q;
  }
}

// The farthest the cloud of `lobes` reaches from its middle, squashed, in sphere radii,
// with a margin for the directions between the samples (smokeBetween's bound).
function farthest(lobes) {
  let far = 0;
  for (let i = 0; i <= 64; i++) {
    for (let j = 0; j < 128; j++) {
      const e = (i / 64 - 0.5) * Math.PI, a = j / 128 * 2 * Math.PI;
      DIR[0] = Math.cos(e) * Math.cos(a);
      DIR[1] = Math.cos(e) * Math.sin(a);
      DIR[2] = Math.sin(e);
      reachAlong(lobes, DIR);
      far = Math.max(far, DIR[3] * Math.hypot(DIR[0], DIR[1], DIR[2] * SMOKE_SQUASH));
    }
  }
  return far * 1.05;
}

// The client's cloud meshes are built with seeds 1..SMOKE_SHAPES, effect id % SMOKE_SHAPES
// picking one.
const CLOUDS = Array.from({ length: SMOKE_SHAPES }, (_, i) => smokeLobes(i + 1));
const CLOUD_FAR = CLOUDS.map(farthest);
export const smokeLobesOf = (id) => CLOUDS[id % SMOKE_SHAPES];

// Where smoke effect `id`, `age` seconds old and resting at pos[o..o+2], is drawn, into P:
// its middle x, y, z, its turn (radians), the turn's cosine and sine, and its scale (the
// sphere's radius in units; 0 while too small to draw). It bulges out as it pops, breathes
// and turns slowly.
export function smokePose(P, id, age, pos, o) {
  const R = smokeRadius(age);
  if (R < 1) {
    P[6] = 0;
    return;
  }
  const pop = 1 + Math.sin(Math.min(1, age / 1.2) * Math.PI) * 0.18;
  const s = R * SMOKE_SIZE * pop * (1 + 0.03 * Math.sin(age * 1.9 + id));
  P[0] = pos[o];
  P[1] = pos[o + 1];
  P[2] = pos[o + 2] - SMOKE_FLOOR * s;
  P[3] = hash01(id) * 6.283 + age * 0.04;
  P[4] = Math.cos(P[3]);
  P[5] = Math.sin(P[3]);
  P[6] = s;
}

// How far the point SP[8..10] is inside the cloud of `lobes` posed in SP, in units, into
// SP[7]: along the line from the cloud's middle, or up from its flat base; below 0 outside.
function cloudDepth(lobes) {
  const s = SP[6], wx = SP[8] - SP[0], wy = SP[9] - SP[1];
  const ux = (SP[4] * wx + SP[5] * wy) / s, uy = (SP[4] * wy - SP[5] * wx) / s, uz = (SP[10] - SP[2]) / s;
  const vz = uz / SMOKE_SQUASH, len = Math.sqrt(ux * ux + uy * uy + vz * vz);
  const base = (uz - SMOKE_FLOOR) * s;
  if (len < 1e-9) {
    SP[7] = base;
    return;
  }
  DIR[0] = ux / len;
  DIR[1] = uy / len;
  DIR[2] = vz / len;
  reachAlong(lobes, DIR);
  const along = Math.sqrt(DIR[0] * DIR[0] + DIR[1] * DIR[1] + DIR[2] * DIR[2] * SMOKE_SQUASH * SMOKE_SQUASH);
  SP[7] = Math.min((DIR[3] - len) * s * along, base);
}

// Fire radius `age` seconds after it caught.
export function fireRadius(age) {
  return age < 0 || age > FIRE_TIME ? 0 : FIRE_RADIUS * Math.min(1, 0.35 + 0.65 * age / FIRE_GROW);
}

// Blindness from a flashbang (approx. of CS:GO's PercentageOfFlashForPlayer): full
// facing it, less from the side, a little behind; fading with distance. Returns
// seconds (0: not flashed). `facing`: cosine between the view and the flash.
export function flashDuration(dist, facing) {
  if (dist > FLASH_RANGE) return 0;
  const angle = facing >= 0.5 ? 1 : facing <= -0.3 ? 0.3 : 0.3 + (facing + 0.3) / 0.8 * 0.7;
  const near = dist < 300 ? 1 : Math.max(0, 1 - (dist - 300) / (FLASH_RANGE - 300));
  const t = FLASH_TIME * angle * near;
  return t < 0.25 ? 0 : t;
}

// HE damage at `dist` from the feet (CS:GO RadiusDamage: a gaussian, sigma = radius / 3,
// nothing beyond).
export function heDamage(dist) {
  if (dist > HE_RADIUS) return 0;
  const sigma = HE_RADIUS / 3;
  return HE_DAMAGE * Math.exp(-(dist * dist) / (2 * sigma * sigma));
}

const DEG = Math.PI / 180;
const BURN_TICKS = 16;
const tr = new Trace();
const v3 = new Float64Array(3);

export class Grenades {
  constructor() {
    this.nextId = 1;
    // In flight / rolling.
    this.count = 0;
    this.id = new Uint16Array(MAX_GRENADES);
    this.weapon = new Uint8Array(MAX_GRENADES);
    this.owner = new Int8Array(MAX_GRENADES);
    this.team = new Uint8Array(MAX_GRENADES);
    this.pos = new Float64Array(MAX_GRENADES * 3);
    this.vel = new Float64Array(MAX_GRENADES * 3);
    this.age = new Float64Array(MAX_GRENADES); // seconds since the throw
    this.resting = new Uint8Array(MAX_GRENADES);
    // Effects.
    this.fxCount = 0;
    this.fxId = new Uint16Array(MAX_EFFECTS);
    this.fxKind = new Uint8Array(MAX_EFFECTS);
    this.fxWeapon = new Uint8Array(MAX_EFFECTS);
    this.fxOwner = new Int8Array(MAX_EFFECTS);
    this.fxTeam = new Uint8Array(MAX_EFFECTS);
    this.fxPos = new Float64Array(MAX_EFFECTS * 3);
    this.fxAge = new Float64Array(MAX_EFFECTS);
  }

  clear() {
    this.count = this.fxCount = 0;
  }

  takeId() {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) & 0xffff || 1;
    return id;
  }

  // CS:GO's throw: the view pitch is flattened toward 10 degrees up, the speed grows the
  // higher the throw (at most 750), scaled by the strength (left click 1, both 0.5,
  // right 0); it leaves 16 units ahead of the eye (lower for weaker throws) and carries
  // 1.25 times the thrower's velocity.
  throw(world, weapon, owner, team, ex, ey, ez, pitch, yaw, vx, vy, vz, code) {
    if (this.count === MAX_GRENADES) this.remove(0);
    const strength = throwStrength(code);
    const p = -10 + pitch * (80 / 90);
    let speed = Math.min((90 - p) * 6, 750);
    speed *= strength * 0.7 + 0.3;
    const cp = Math.cos(p * DEG), fx = cp * Math.cos(yaw * DEG), fy = cp * Math.sin(yaw * DEG), fz = -Math.sin(p * DEG);
    const sz = ez + strength * 12 - 12;
    traceHull(world, HULL_POINT, ex, ey, sz, ex + fx * 16, ey + fy * 16, sz + fz * 16, tr);
    const k = this.count++, o = k * 3;
    this.id[k] = this.takeId();
    this.weapon[k] = weapon;
    this.owner[k] = owner;
    this.team[k] = team;
    this.pos[o] = tr.endx - fx * (tr.fraction < 1 ? 2 : 0);
    this.pos[o + 1] = tr.endy - fy * (tr.fraction < 1 ? 2 : 0);
    this.pos[o + 2] = tr.endz - fz * (tr.fraction < 1 ? 2 : 0);
    this.vel[o] = fx * speed + vx * 1.25;
    this.vel[o + 1] = fy * speed + vy * 1.25;
    this.vel[o + 2] = fz * speed + vz * 1.25;
    this.age[k] = 0;
    this.resting[k] = 0;
    return k;
  }

  remove(k) {
    for (const a of [this.id, this.weapon, this.owner, this.team, this.age, this.resting]) a.copyWithin(k, k + 1, this.count);
    this.pos.copyWithin(k * 3, (k + 1) * 3, this.count * 3);
    this.vel.copyWithin(k * 3, (k + 1) * 3, this.count * 3);
    this.count--;
  }

  // A thrower who left: his grenades and fires go on credited to nobody (-1), else to
  // whoever takes his slot next (bots fill it within a fraction of a second).
  forget(owner) {
    for (let k = 0; k < this.count; k++) if (this.owner[k] === owner) this.owner[k] = -1;
    for (let k = 0; k < this.fxCount; k++) if (this.fxOwner[k] === owner) this.fxOwner[k] = -1;
  }

  addEffect(kind, weapon, owner, team, x, y, z) {
    if (this.fxCount === MAX_EFFECTS) this.removeEffect(0);
    const k = this.fxCount++;
    this.fxId[k] = this.takeId();
    this.fxKind[k] = kind;
    this.fxWeapon[k] = weapon;
    this.fxOwner[k] = owner;
    this.fxTeam[k] = team;
    this.fxPos[k * 3] = x;
    this.fxPos[k * 3 + 1] = y;
    this.fxPos[k * 3 + 2] = z;
    this.fxAge[k] = 0;
    return k;
  }

  removeEffect(k) {
    for (const a of [this.fxId, this.fxKind, this.fxWeapon, this.fxOwner, this.fxTeam, this.fxAge]) {
      a.copyWithin(k, k + 1, this.fxCount);
    }
    this.fxPos.copyWithin(k * 3, (k + 1) * 3, this.fxCount * 3);
    this.fxCount--;
  }

  // Effect k's cloud posed into SP (smokePose); false while it is too small to draw.
  cloud(k) {
    smokePose(SP, this.fxId[k], this.fxAge[k], this.fxPos, k * 3);
    return SP[6] > 0;
  }

  // Is (x, y, z) inside a smoke cloud as it is drawn.
  inSmoke(x, y, z) {
    for (let k = 0; k < this.fxCount; k++) {
      if (this.fxKind[k] !== FX_SMOKE || !this.cloud(k)) continue;
      SP[8] = x;
      SP[9] = y;
      SP[10] = z;
      cloudDepth(smokeLobesOf(this.fxId[k]));
      if (SP[7] >= 0) return true;
    }
    return false;
  }

  // How far into a smoke cloud (x, y, z) is, for the print's fog: 0 from SMOKE_MARGIN
  // outside its drawn surface, 1 from SMOKE_FULL outside and inside it, so the view never
  // shows the cloud's inside (its inner faces are drawn and would frame everything in it).
  smokeDepth(x, y, z) {
    const p = DEPTH_AT;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    return this.smokeDepthAt(p);
  }

  // smokeDepth of the point in p (x, y, z): the client asks every frame, and its three
  // doubles were boxed as arguments.
  smokeDepthAt(p) {
    SP[11] = -SMOKE_MARGIN;
    for (let k = 0; k < this.fxCount; k++) {
      if (this.fxKind[k] !== FX_SMOKE || !this.cloud(k)) continue;
      SP[8] = p[0];
      SP[9] = p[1];
      SP[10] = p[2];
      cloudDepth(smokeLobesOf(this.fxId[k]));
      SP[11] = Math.max(SP[11], SP[7]);
    }
    return Math.min(1, (SP[11] + SMOKE_MARGIN) / (SMOKE_MARGIN - SMOKE_FULL));
  }

  // Does a smoke cloud as drawn cut the line between two points? The stretch of the line
  // within reach of a cloud's middle is tested every SMOKE_STEP units.
  smokeBetween(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len2 = dx * dx + dy * dy + dz * dz, len = Math.sqrt(len2);
    for (let k = 0; k < this.fxCount; k++) {
      if (this.fxKind[k] !== FX_SMOKE || !this.cloud(k)) continue;
      const shape = this.fxId[k] % SMOKE_SHAPES, far = CLOUD_FAR[shape] * SP[6];
      const cx = SP[0] - x0, cy = SP[1] - y0, cz = SP[2] - z0;
      const t = len2 > 0 ? (cx * dx + cy * dy + cz * dz) / len2 : 0; // the nearest point, unclamped
      const ex = cx - dx * t, ey = cy - dy * t, ez = cz - dz * t, miss = far * far - (ex * ex + ey * ey + ez * ez);
      if (miss <= 0) continue;
      const half = len > 0 ? Math.sqrt(miss) / len : 1, t0 = Math.max(0, t - half), t1 = Math.min(1, t + half);
      if (t0 > t1) continue;
      const n = Math.ceil((t1 - t0) * len / SMOKE_STEP);
      for (let i = 0; i <= n; i++) {
        const u = n > 0 ? t0 + (t1 - t0) * i / n : t0;
        SP[8] = x0 + dx * u;
        SP[9] = y0 + dy * u;
        SP[10] = z0 + dz * u;
        cloudDepth(CLOUDS[shape]);
        if (SP[7] >= 0) return true;
      }
    }
    return false;
  }

  // One tick. `targets` (see GrenadeTargets) takes damage and flashes.
  update(world, targets) {
    const dt = TICK_DT;
    for (let k = 0; k < this.count; k++) {
      this.age[k] += dt;
      const kind = WEAPONS[this.weapon[k]].grenade;
      const landed = this.move(world, k, kind === 'fire');
      const o = k * 3, x = this.pos[o], y = this.pos[o + 1];
      let z = this.pos[o + 2], go = false;
      if (kind === 'he' || kind === 'flash') go = this.age[k] >= FUSE;
      else if (kind === 'smoke' || kind === 'decoy') {
        // CS:GO checks every 0.2 s whether it stopped.
        go = this.resting[k] === 1 && Math.round(this.age[k] / dt) % Math.round(0.2 / dt) === 0;
        // A smoke touching a fire goes off at once, in the air too, and puts it out (CS:GO's:
        // one at your own feet saves you from a molotov); its cloud sits on the fire's floor.
        if (!go && kind === 'smoke') {
          for (let f = 0; f < this.fxCount && !go; f++) {
            if (this.fxKind[f] === FX_FIRE && this.inFire(f, x, y, z)) {
              go = true;
              z = this.fxPos[f * 3 + 2];
            }
          }
        }
      } else if (kind === 'fire') go = landed || this.age[k] >= FIRE_FUSE;
      if (!go) continue;
      this.detonate(world, k, kind, x, y, z, landed, targets);
      this.remove(k);
      k--;
    }
    for (let k = 0; k < this.fxCount; k++) {
      this.fxAge[k] += dt;
      if (this.fxAge[k] >= FX_LIFE[this.fxKind[k]]) {
        this.removeEffect(k);
        k--;
        continue;
      }
      if (this.fxKind[k] === FX_FIRE) this.burn(k, targets);
    }
  }

  // Fly-gravity movement with half the gravity before and after the move; a hit
  // reflects the velocity and keeps ELASTICITY of it; on a floor, slow enough stops it; in a
  // liquid it drags (WATER_DRAG). Returns true when a fire grenade struck a floor or a
  // liquid (it bursts there: in a liquid it fizzles, CS:GO's).
  move(world, k, fire) {
    if (this.resting[k]) return false;
    const o = k * 3, P = this.pos, V = this.vel, dt = TICK_DT;
    const x = P[o], y = P[o + 1], z = P[o + 2];
    if (world.liquids && isLiquid(pointContents(world, x, y, z))) {
      if (fire) return true;
      V[o] *= WATER_DRAG;
      V[o + 1] *= WATER_DRAG;
      V[o + 2] *= WATER_DRAG;
    }
    V[o + 2] -= GRENADE_GRAVITY * dt * 0.5;
    traceHull(world, HULL_POINT, x, y, z, x + V[o] * dt, y + V[o + 1] * dt, z + V[o + 2] * dt, tr);
    if (tr.startsolid) {
      V[o] = V[o + 1] = V[o + 2] = 0;
      this.resting[k] = 1;
      return false;
    }
    P[o] = tr.endx + tr.nx * (tr.fraction < 1 ? 1 : 0);
    P[o + 1] = tr.endy + tr.ny * (tr.fraction < 1 ? 1 : 0);
    P[o + 2] = tr.endz + tr.nz * (tr.fraction < 1 ? 1 : 0);
    if (tr.fraction < 1) {
      if (fire && tr.nz >= FIRE_SLOPE) return true;
      const back = (V[o] * tr.nx + V[o + 1] * tr.ny + V[o + 2] * tr.nz) * 2;
      for (let c = 0; c < 3; c++) V[o + c] = (V[o + c] - back * (c === 0 ? tr.nx : c === 1 ? tr.ny : tr.nz)) * ELASTICITY;
      if (tr.nz > 0.7 && V[o] * V[o] + V[o + 1] * V[o + 1] + V[o + 2] * V[o + 2] < 30 * 30) {
        V[o] = V[o + 1] = V[o + 2] = 0;
        this.resting[k] = 1;
        return false;
      }
    }
    V[o + 2] -= GRENADE_GRAVITY * dt * 0.5;
    return false;
  }

  detonate(world, k, kind, x, y, z, landed, targets) {
    const weapon = this.weapon[k], owner = this.owner[k], team = this.team[k];
    if (kind === 'he') {
      this.addEffect(FX_HE, weapon, owner, team, x, y, z);
      if (targets.blast) targets.blast(x, y, z + 1, HE_DAMAGE, HE_RADIUS, weapon, owner, team); // breakables
      for (let i = 0; i < targets.count; i++) {
        if (!targets.alive(i)) continue;
        // Measured to the feet (CS:GO's player origin): one at a target's feet does 98 (a
        // hull's half width away), as CS:GO's does; to the hull center it was ~95.
        targets.feet(i, v3);
        const d = heDamage(Math.hypot(v3[0] - x, v3[1] - y, v3[2] - z));
        if (d <= 0) continue;
        targets.center(i, v3);
        if (!this.visible(world, x, y, z + 1, v3)) continue;
        targets.hurt(i, d, weapon, owner, team, x, y, z);
      }
    } else if (kind === 'flash') {
      this.addEffect(FX_FLASH, weapon, owner, team, x, y, z);
      for (let i = 0; i < targets.count; i++) {
        if (!targets.alive(i)) continue;
        targets.eye(i, v3);
        const dx = x - v3[0], dy = y - v3[1], dz = z - v3[2], dist = Math.hypot(dx, dy, dz) || 1;
        if (!this.visible(world, x, y, z, v3) || this.smokeBetween(x, y, z, v3[0], v3[1], v3[2])) continue;
        const pitch = targets.pitch(i) * DEG, yaw = targets.yaw(i) * DEG, cp = Math.cos(pitch);
        const facing = (cp * Math.cos(yaw) * dx + cp * Math.sin(yaw) * dy - Math.sin(pitch) * dz) / dist;
        const t = flashDuration(dist, facing);
        if (t > 0) targets.flash(i, t, owner);
      }
    } else if (kind === 'smoke') {
      this.addEffect(FX_SMOKE, weapon, owner, team, x, y, z);
      for (let f = 0; f < this.fxCount; f++) { // smoke puts out fires it covers
        if (this.fxKind[f] !== FX_FIRE) continue;
        const o = f * 3;
        if (Math.hypot(this.fxPos[o] - x, this.fxPos[o + 1] - y) < FIRE_RADIUS + 40 && Math.abs(this.fxPos[o + 2] - z) < 96) {
          this.removeEffect(f);
          f--;
        }
      }
    } else if (kind === 'decoy') {
      this.addEffect(FX_DECOY, weapon, owner, team, x, y, z);
    } else if (kind === 'fire') {
      // Burst in the air: catches on a floor close below, else fizzles. Smoke or a liquid
      // douses it.
      let fz = z;
      if (!landed) {
        traceHull(world, HULL_POINT, x, y, z, x, y, z - 128, tr);
        fz = tr.fraction < 1 && tr.nz >= FIRE_SLOPE ? tr.endz : NaN;
      }
      const doused = Number.isNaN(fz) || this.inSmoke(x, y, fz + 8) ||
        isLiquid(pointContents(world, x, y, fz)) || isLiquid(pointContents(world, x, y, fz + 1));
      if (doused) this.addEffect(FX_FIZZLE, weapon, owner, team, x, y, z);
      else this.addEffect(FX_FIRE, weapon, owner, team, x, y, fz);
    }
  }

  // Is (x, y, z) in fire k's reach: within its radius, from 24 under its floor to 48 over.
  inFire(k, x, y, z) {
    const o = k * 3, fz = this.fxPos[o + 2];
    return Math.hypot(x - this.fxPos[o], y - this.fxPos[o + 1]) <= fireRadius(this.fxAge[k]) && z >= fz - 24 && z <= fz + 48;
  }

  // Nothing solid between (x, y, z) and point p.
  visible(world, x, y, z, p) {
    traceHull(world, HULL_POINT, x, y, z, p[0], p[1], p[2], tr);
    return tr.fraction >= 1;
  }

  // A fire hurts whoever stands in it: FIRE_DPS, a quarter every 0.25 s (damage is whole
  // points, CS:GO truncates).
  burn(k, targets) {
    if (Math.round(this.fxAge[k] / TICK_DT) % BURN_TICKS !== 0) return;
    const o = k * 3, x = this.fxPos[o], y = this.fxPos[o + 1], z = this.fxPos[o + 2];
    for (let i = 0; i < targets.count; i++) {
      if (!targets.alive(i)) continue;
      targets.feet(i, v3);
      if (!this.inFire(k, v3[0], v3[1], v3[2])) continue;
      targets.hurt(i, FIRE_DPS * BURN_TICKS * TICK_DT, this.fxWeapon[k], this.fxOwner[k], this.fxTeam[k], x, y, z);
    }
  }
}

// What grenades act on (the server's players, or the offline player): implement
//   count, alive(i), center(i, out) (hull center), eye(i, out), feet(i, out),
//   pitch(i), yaw(i), hurt(i, damage, weapon, ownerId, ownerTeam), flash(i, seconds, ownerId).
