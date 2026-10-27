// Thrown grenades and what they leave behind, CS:GO style: the throw (CBaseCSGrenade::
// ThrowGrenade), the toss with bounces (Source's fly-gravity movement and
// ResolveFlyCollisionCustom), fuses, and the effects: HE blast, flashbang, smoke cloud,
// molotov / incendiary fire, decoy. The server runs it (offline, the client does);
// clients draw the lists it keeps (S2C_GRENADES). Preallocated, nothing per tick.
//
// Values marked (approx.) are not in CS:GO's game files (they live in code, particle
// systems or animations) and are estimates.

import { TICK_DT } from './constants.js';
import { Trace, traceHull, HULL_POINT } from './trace.js';
import { WEAPONS, throwStrength } from './weapons.js';

export const MAX_GRENADES = 32; // in flight (the oldest goes)
export const MAX_EFFECTS = 24;

export const GRENADE_GRAVITY = 800 * 0.4; // sv_gravity times the grenades' gravity scale
export const ELASTICITY = 0.45;
export const FUSE = 1.5; // HE and flashbang
export const FIRE_FUSE = 2.0; // molotov_throw_detonate_time: bursts in the air then
export const FIRE_SLOPE = 0.866; // weapon_molotov_maxdetonateslope 30 degrees: steeper bounces
export const HE_DAMAGE = 99;
export const HE_RADIUS = 350;
export const FLASH_TIME = 4.87; // longest blindness (s)
export const FLASH_RANGE = 1500; // (approx.)
export const SMOKE_TIME = 18;
export const SMOKE_RADIUS = 144; // a cloud's radius once grown
export const SMOKE_GROW = 1; // seconds to grow (approx.)
export const SMOKE_FADE = 3; // shrinking away at the end (approx.)
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
const FX_LIFE = [0, 1, 0.5, SMOKE_TIME, FIRE_TIME, DECOY_TIME, 0.6];

// Smoke radius `age` seconds after it popped: grows, holds, shrinks away.
export function smokeRadius(age) {
  if (age < 0 || age > SMOKE_TIME) return 0;
  const grow = Math.min(1, age / SMOKE_GROW), fade = Math.min(1, (SMOKE_TIME - age) / SMOKE_FADE);
  return SMOKE_RADIUS * Math.sqrt(grow) * Math.sqrt(fade);
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

// HE damage at `dist` (CS:GO RadiusDamage: a gaussian, sigma = radius / 3, nothing beyond).
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

  // Is (x, y, z) inside a smoke cloud.
  inSmoke(x, y, z) {
    for (let k = 0; k < this.fxCount; k++) {
      if (this.fxKind[k] !== FX_SMOKE) continue;
      const o = k * 3;
      if (Math.hypot(x - this.fxPos[o], y - this.fxPos[o + 1], (z - this.fxPos[o + 2]) * 1.5) < smokeRadius(this.fxAge[k])) {
        return true;
      }
    }
    return false;
  }

  // Does a smoke cloud cut the line between two points?
  smokeBetween(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = (z1 - z0) * 1.5, len2 = dx * dx + dy * dy + dz * dz;
    for (let k = 0; k < this.fxCount; k++) {
      if (this.fxKind[k] !== FX_SMOKE) continue;
      const o = k * 3, cx = this.fxPos[o] - x0, cy = this.fxPos[o + 1] - y0, cz = (this.fxPos[o + 2] - z0) * 1.5;
      const t = len2 > 0 ? Math.min(Math.max((cx * dx + cy * dy + cz * dz) / len2, 0), 1) : 0;
      if (Math.hypot(cx - dx * t, cy - dy * t, cz - dz * t) < smokeRadius(this.fxAge[k])) return true;
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
      const o = k * 3, x = this.pos[o], y = this.pos[o + 1], z = this.pos[o + 2];
      let go = false;
      if (kind === 'he' || kind === 'flash') go = this.age[k] >= FUSE;
      else if (kind === 'smoke' || kind === 'decoy') {
        // CS:GO checks every 0.2 s whether it stopped.
        go = this.resting[k] === 1 && Math.round(this.age[k] / dt) % Math.round(0.2 / dt) === 0;
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
  // reflects the velocity and keeps ELASTICITY of it; on a floor, slow enough stops it.
  // Returns true when a fire grenade struck a floor (it bursts there).
  move(world, k, fire) {
    if (this.resting[k]) return false;
    const o = k * 3, P = this.pos, V = this.vel, dt = TICK_DT;
    V[o + 2] -= GRENADE_GRAVITY * dt * 0.5;
    const x = P[o], y = P[o + 1], z = P[o + 2];
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
      for (let i = 0; i < targets.count; i++) {
        if (!targets.alive(i)) continue;
        targets.center(i, v3);
        const d = heDamage(Math.hypot(v3[0] - x, v3[1] - y, v3[2] - z));
        if (d <= 0 || !this.visible(world, x, y, z + 1, v3)) continue;
        targets.hurt(i, d, weapon, owner, team);
      }
    } else if (kind === 'flash') {
      this.addEffect(FX_FLASH, weapon, owner, team, x, y, z);
      for (let i = 0; i < targets.count; i++) {
        if (!targets.alive(i)) continue;
        targets.eye(i, v3);
        const dx = x - v3[0], dy = y - v3[1], dz = z - v3[2], dist = Math.hypot(dx, dy, dz) || 1;
        if (!this.visible(world, x, y, z, v3) || this.inSmoke((x + v3[0]) / 2, (y + v3[1]) / 2, (z + v3[2]) / 2)) continue;
        const pitch = targets.pitch(i) * DEG, yaw = targets.yaw(i) * DEG, cp = Math.cos(pitch);
        const facing = (cp * Math.cos(yaw) * dx + cp * Math.sin(yaw) * dy - Math.sin(pitch) * dz) / dist;
        const t = flashDuration(dist, facing);
        if (t > 0) targets.flash(i, t);
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
      // Burst in the air: catches on a floor close below, else fizzles. Smoke douses it.
      let fz = z;
      if (!landed) {
        traceHull(world, HULL_POINT, x, y, z, x, y, z - 128, tr);
        fz = tr.fraction < 1 && tr.nz >= FIRE_SLOPE ? tr.endz : NaN;
      }
      if (Number.isNaN(fz) || this.inSmoke(x, y, fz + 8)) this.addEffect(FX_FIZZLE, weapon, owner, team, x, y, z);
      else this.addEffect(FX_FIRE, weapon, owner, team, x, y, fz);
    }
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
    const r = fireRadius(this.fxAge[k]);
    for (let i = 0; i < targets.count; i++) {
      if (!targets.alive(i)) continue;
      targets.feet(i, v3);
      if (Math.hypot(v3[0] - x, v3[1] - y) > r || v3[2] < z - 24 || v3[2] > z + 48) continue;
      targets.hurt(i, FIRE_DPS * BURN_TICKS * TICK_DT, this.fxWeapon[k], this.fxOwner[k], this.fxTeam[k]);
    }
  }
}

// What grenades act on (the server's players, or the offline player): implement
//   count, alive(i), center(i, out) (hull center), eye(i, out), feet(i, out),
//   pitch(i), yaw(i), hurt(i, damage, weapon, ownerId, ownerTeam), flash(i, seconds).
