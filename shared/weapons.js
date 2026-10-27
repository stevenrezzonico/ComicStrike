// CS:GO weapon simulation shared by client (prediction) and server (authority).
// Mirrors CS:GO's structure: accuracy penalty with recovery, movement/air inaccuracy,
// per-bullet spread seeded by the command number, and aim punch driven by a
// per-weapon recoil pattern. Timing is in ticks, so fire rates quantize to 64 Hz
// exactly like CS:GO on 64-tick servers.

import { TICK_DT, IN_ATTACK, IN_ATTACK2, IN_RELOAD, IN_SPEED } from './constants.js';
import {
  MOVE, eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_EVENTS, PS_LAND_SPEED,
  FL_ONGROUND, FL_DUCKING, FL_ONLADDER, EV_LAND,
} from './pmove.js';

// CS:GO recoil convars.
export const RECOIL = {
  scale: 2, // weapon_recoil_scale: bullets follow aim punch * 2
  viewTracking: 0.45, // view_recoil_tracking: the camera shows 45% of that
  decayExp: 8, // weapon_recoil_decay2_exp
  decayLin: 18, // weapon_recoil_decay2_lin (degrees/s)
  velDecay: 4.5, // weapon_recoil_vel_decay
  patternLength: 64,
  smoothing: 0.7, // full-auto pattern: lerp toward each new random kick
  varianceRamp: 4, // shots before the angle variance reaches full strength
};

export const SLOT_PRIMARY = 0;
export const SLOT_SECONDARY = 1;
export const SLOT_KNIFE = 2;
export const NUM_SLOTS = 4;

const mr = (x) => x * 0.001; // milliradians -> radians

// Weapon data. Values approximate CS:GO's weapon scripts (from memory, not the
// game files): treat them as a starting point and replace with real data when
// available. Angles in radians unless noted; recoil angles/magnitudes in degrees.
export const WEAPONS = [
  null, // id 0: no weapon
  {
    name: 'knife', label: 'Knife', slot: SLOT_KNIFE, melee: true,
    cycle: 0.4, cycle2: 1.0, damage: 40, damage2: 65, range: 48, range2: 32,
    maxSpeed: 250, deployTime: 1.0, price: 0, killAward: 1500,
  },
  {
    name: 'glock', label: 'Glock-18', slot: SLOT_SECONDARY, auto: false,
    cycle: 0.15, damage: 30, armorRatio: 0.94, penetration: 1, range: 4096, rangeModifier: 0.85,
    headshotMult: 4, maxSpeed: 240, clip: 20, reserve: 120, reloadTime: 2.27, deployTime: 1.0,
    price: 200, killAward: 300,
    spread: mr(2.0), inaccuracyStand: mr(8.4), inaccuracyCrouch: mr(6.3), inaccuracyMove: mr(13.3),
    inaccuracyJump: 0.437, inaccuracyLand: 0.03, inaccuracyLadder: 0.1, inaccuracyFire: mr(56),
    recoveryStand: 0.38, recoveryCrouch: 0.33,
    recoilAngle: 0, recoilAngleVariance: 20, recoilMagnitude: 18, recoilMagnitudeVariance: 0, recoilSeed: 6,
  },
  {
    name: 'usp_silencer', label: 'USP-S', slot: SLOT_SECONDARY, auto: false,
    cycle: 0.17, damage: 35, armorRatio: 1.01, penetration: 1, range: 4096, rangeModifier: 0.99,
    headshotMult: 4, maxSpeed: 240, clip: 12, reserve: 24, reloadTime: 2.17, deployTime: 1.0,
    price: 200, killAward: 300,
    spread: mr(2.0), inaccuracyStand: mr(4.9), inaccuracyCrouch: mr(3.1), inaccuracyMove: mr(12.8),
    inaccuracyJump: 0.3, inaccuracyLand: 0.04, inaccuracyLadder: 0.1, inaccuracyFire: mr(52),
    recoveryStand: 0.42, recoveryCrouch: 0.35,
    recoilAngle: 0, recoilAngleVariance: 25, recoilMagnitude: 23, recoilMagnitudeVariance: 0, recoilSeed: 17,
  },
  {
    name: 'ak47', label: 'AK-47', slot: SLOT_PRIMARY, auto: true,
    cycle: 0.1, damage: 36, armorRatio: 1.55, penetration: 2, range: 8192, rangeModifier: 0.98,
    headshotMult: 4, maxSpeed: 215, clip: 30, reserve: 90, reloadTime: 2.43, deployTime: 1.0,
    price: 2700, killAward: 300,
    spread: mr(0.6), inaccuracyStand: mr(6.41), inaccuracyCrouch: mr(4.81), inaccuracyMove: mr(175.06),
    inaccuracyJump: 0.4, inaccuracyLand: 0.242, inaccuracyLadder: 0.14, inaccuracyFire: mr(7.8),
    recoveryStand: 0.428, recoveryCrouch: 0.305,
    recoilAngle: 0, recoilAngleVariance: 70, recoilMagnitude: 30, recoilMagnitudeVariance: 0, recoilSeed: 223,
  },
  {
    name: 'm4a1', label: 'M4A4', slot: SLOT_PRIMARY, auto: true,
    cycle: 0.09, damage: 33, armorRatio: 1.4, penetration: 2, range: 8192, rangeModifier: 0.97,
    headshotMult: 4, maxSpeed: 225, clip: 30, reserve: 90, reloadTime: 3.07, deployTime: 1.0,
    price: 3100, killAward: 300,
    spread: mr(0.6), inaccuracyStand: mr(4.9), inaccuracyCrouch: mr(3.7), inaccuracyMove: mr(139.5),
    inaccuracyJump: 0.4, inaccuracyLand: 0.18, inaccuracyLadder: 0.12, inaccuracyFire: mr(7.0),
    recoveryStand: 0.386, recoveryCrouch: 0.275,
    recoilAngle: 0, recoilAngleVariance: 70, recoilMagnitude: 23, recoilMagnitudeVariance: 0, recoilSeed: 38965,
  },
];

export const WEAPON_ID = Object.fromEntries(WEAPONS.map((w, i) => [w ? w.name : 'none', i]));

// --- Deterministic randomness ---------------------------------------------

export function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

let rngState = 0;
function seedRandom(seed) {
  rngState = seed >>> 0;
}
function random() { // mulberry32
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Recoil pattern: per shot index, the aim-punch velocity kick (pitch, yaw) in deg/s.
// Same shape as CS:GO's GenerateRecoilPattern (seeded angle/magnitude jitter,
// smoothed for automatic weapons).
function buildRecoilPattern(w) {
  const n = RECOIL.patternLength;
  const out = new Float32Array(n * 2);
  seedRandom(w.recoilSeed);
  let angle = 0, mag = 0;
  for (let j = 0; j < n; j++) {
    const ramp = Math.min(1, j / RECOIL.varianceRamp);
    const angleNew = w.recoilAngle + (random() * 2 - 1) * w.recoilAngleVariance * ramp;
    const magNew = w.recoilMagnitude + (random() * 2 - 1) * w.recoilMagnitudeVariance;
    if (w.auto && j > 0) {
      angle += (angleNew - angle) * RECOIL.smoothing;
      mag += (magNew - mag) * RECOIL.smoothing;
    } else {
      angle = angleNew;
      mag = magNew;
    }
    const a = angle * Math.PI / 180;
    out[j * 2] = -Math.cos(a) * mag; // pitch: negative kicks the view up
    out[j * 2 + 1] = -Math.sin(a) * mag;
  }
  return out;
}
for (const w of WEAPONS) if (w && !w.melee) w.recoilPattern = buildRecoilPattern(w);

// --- Weapon state ---------------------------------------------------------

export const WS_ACTIVE = 0; // active slot
export const WS_LAST_SLOT = 1;
export const WS_NEXT_ATTACK = 2; // seconds
export const WS_NEXT_ATTACK2 = 3;
export const WS_RELOAD_END = 4; // 0 when not reloading
export const WS_DEPLOY_END = 5;
export const WS_PENALTY = 6; // accuracy penalty (radians)
export const WS_RECOIL_INDEX = 7;
export const WS_PUNCH = 8; // 8..9 aim punch (pitch, yaw) degrees
export const WS_PUNCH_VEL = 10; // 10..11
export const WS_LAST_SHOT = 12;
export const WS_OLD_BUTTONS = 13;
export const WS_EVENTS = 14; // output: WEV_* bits this tick
export const WS_SLOTS = 16; // per slot: weapon id, clip, reserve
export const WS_SIZE = WS_SLOTS + NUM_SLOTS * 3;

export const WEV_FIRE = 1;
export const WEV_RELOAD = 2;
export const WEV_RELOADED = 4;
export const WEV_DEPLOY = 8;
export const WEV_DRYFIRE = 16;
export const WEV_MELEE = 32;
export const WEV_MELEE2 = 64;

export function createWeaponState() {
  return { f: new Float64Array(WS_SIZE) };
}

export function copyWeaponState(dst, src) {
  dst.f.set(src.f);
}

export function giveWeapon(ws, id) {
  const w = WEAPONS[id];
  const o = WS_SLOTS + w.slot * 3;
  ws.f[o] = id;
  ws.f[o + 1] = w.melee ? 0 : w.clip;
  ws.f[o + 2] = w.melee ? 0 : w.reserve;
}

export function activeWeapon(ws) {
  return WEAPONS[ws.f[WS_SLOTS + ws.f[WS_ACTIVE] * 3]] || null;
}

// Bullets / swings produced by one tick (preallocated, reused).
export class ShotList {
  constructor(capacity = 16) {
    this.count = 0;
    this.origin = new Float64Array(capacity * 3);
    this.dir = new Float64Array(capacity * 3);
    this.range = new Float64Array(capacity);
    this.weapon = new Int32Array(capacity);
  }

  push(ox, oy, oz, dx, dy, dz, range, weapon) {
    const i = this.count++;
    this.origin[i * 3] = ox; this.origin[i * 3 + 1] = oy; this.origin[i * 3 + 2] = oz;
    this.dir[i * 3] = dx; this.dir[i * 3 + 1] = dy; this.dir[i * 3 + 2] = dz;
    this.range[i] = range;
    this.weapon[i] = weapon;
  }
}

// Current inaccuracy (radians, cone radius) as CS:GO's GetInaccuracy: accuracy
// penalty plus movement and airborne terms.
export function getInaccuracy(ws, ps, buttons) {
  const w = activeWeapon(ws);
  if (!w || w.melee) return 0;
  let inacc = ws.f[WS_PENALTY];

  const speed = Math.hypot(ps.f[PS_VEL], ps.f[PS_VEL + 1]);
  const lo = w.maxSpeed * MOVE.duckModifier;
  const hi = w.maxSpeed * 0.95;
  let s = (speed - lo) / (hi - lo);
  if (s > 0) {
    if (s > 1) s = 1;
    if (!(buttons & IN_SPEED)) s = Math.pow(s, 0.25); // above walk speed it ramps fast
    inacc += s * w.inaccuracyMove;
  }

  const flags = ps.i[PS_FLAGS];
  if (!(flags & FL_ONGROUND) && !(flags & FL_ONLADDER)) {
    const sqrtMax = Math.sqrt(MOVE.jumpImpulse);
    const t = (Math.sqrt(Math.abs(ps.f[PS_VEL + 2])) - sqrtMax * 0.25) / (sqrtMax * 0.75);
    inacc += Math.min(Math.max(t, 0), 2) * w.inaccuracyJump;
  }
  return inacc < 1 ? inacc : 1;
}

function updateAccuracyPenalty(ws, ps, w) {
  const f = ws.f;
  const flags = ps.i[PS_FLAGS];
  const ducked = (flags & FL_DUCKING) !== 0;
  let target;
  if (flags & FL_ONLADDER) target = w.inaccuracyLadder;
  else if (ducked) target = w.inaccuracyCrouch;
  else target = w.inaccuracyStand;

  if (target > f[WS_PENALTY]) {
    f[WS_PENALTY] = target;
  } else {
    const decay = Math.log(10) / (ducked ? w.recoveryCrouch : w.recoveryStand);
    f[WS_PENALTY] = target + (f[WS_PENALTY] - target) * Math.exp(-TICK_DT * decay);
  }
  if (ps.i[PS_EVENTS] & EV_LAND) {
    f[WS_PENALTY] += w.inaccuracyLand * Math.min(ps.f[PS_LAND_SPEED] / 600, 1);
  }
}

// CS:GO DecayAimPunchAngle: exponential + linear decay, then half-step velocity integration.
function decayPunch(f) {
  const dt = TICK_DT;
  const k = Math.exp(-RECOIL.decayExp * dt);
  let p = f[WS_PUNCH] * k, y = f[WS_PUNCH + 1] * k;
  const m = Math.hypot(p, y);
  const lin = RECOIL.decayLin * dt;
  if (m > lin) {
    const s = 1 - lin / m;
    p *= s;
    y *= s;
  } else {
    p = y = 0;
  }
  let vp = f[WS_PUNCH_VEL], vy = f[WS_PUNCH_VEL + 1];
  p += vp * dt * 0.5;
  y += vy * dt * 0.5;
  const kv = Math.exp(-RECOIL.velDecay * dt);
  vp *= kv;
  vy *= kv;
  p += vp * dt * 0.5;
  y += vy * dt * 0.5;
  f[WS_PUNCH] = p; f[WS_PUNCH + 1] = y;
  f[WS_PUNCH_VEL] = vp; f[WS_PUNCH_VEL + 1] = vy;
}

function startReload(f, w, time, o) {
  if (f[WS_RELOAD_END] > 0 || f[o + 1] >= w.clip || f[o + 2] <= 0) return false;
  f[WS_RELOAD_END] = time + w.reloadTime;
  f[WS_EVENTS] |= WEV_RELOAD;
  return true;
}

const DEG = Math.PI / 180;

// One weapon tick. select = slot to switch to, or -1. tick = command number
// (also the spread seed, like CS:GO's usercmd random_seed).
export function weaponTick(ws, ps, buttons, select, pitch, yaw, tick, shots) {
  const f = ws.f;
  const time = tick * TICK_DT;
  f[WS_EVENTS] = 0;
  shots.count = 0;

  if (select >= 0 && select < NUM_SLOTS && select !== f[WS_ACTIVE] && f[WS_SLOTS + select * 3] > 0) {
    f[WS_LAST_SLOT] = f[WS_ACTIVE];
    f[WS_ACTIVE] = select;
    const nw = activeWeapon(ws);
    f[WS_DEPLOY_END] = time + nw.deployTime;
    f[WS_NEXT_ATTACK] = f[WS_NEXT_ATTACK2] = f[WS_DEPLOY_END];
    f[WS_RELOAD_END] = 0;
    f[WS_RECOIL_INDEX] = 0;
    f[WS_PENALTY] = nw.melee ? 0 : nw.inaccuracyStand;
    f[WS_EVENTS] |= WEV_DEPLOY;
  }

  const w = activeWeapon(ws);
  decayPunch(f);
  if (!w) {
    f[WS_OLD_BUTTONS] = buttons;
    return;
  }
  const o = WS_SLOTS + f[WS_ACTIVE] * 3;

  // Finish a reload.
  if (f[WS_RELOAD_END] > 0 && time >= f[WS_RELOAD_END]) {
    const take = Math.min(w.clip - f[o + 1], f[o + 2]);
    f[o + 1] += take;
    f[o + 2] -= take;
    f[WS_RELOAD_END] = 0;
    f[WS_EVENTS] |= WEV_RELOADED;
  }

  if (!w.melee) updateAccuracyPenalty(ws, ps, w);

  const oldButtons = f[WS_OLD_BUTTONS];
  const pressed = (buttons & IN_ATTACK) && !(oldButtons & IN_ATTACK);
  const ready = time >= f[WS_DEPLOY_END];

  if (!w.melee && ready && (buttons & IN_RELOAD)) startReload(f, w, time, o);

  // Eye position and view axes (with aim punch for guns).
  const eyeX = ps.f[PS_ORIGIN], eyeY = ps.f[PS_ORIGIN + 1], eyeZ = ps.f[PS_ORIGIN + 2] + eyeOffset(ps);

  if (w.melee) {
    const primary = (buttons & IN_ATTACK) && time >= f[WS_NEXT_ATTACK];
    const secondary = !primary && (buttons & IN_ATTACK2) && time >= f[WS_NEXT_ATTACK2];
    if (primary || secondary) {
      const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG);
      const sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
      shots.push(eyeX, eyeY, eyeZ, cp * cy, cp * sy, -sp, primary ? w.range : w.range2, f[o]);
      const cycle = primary ? w.cycle : w.cycle2;
      f[WS_NEXT_ATTACK] = f[WS_NEXT_ATTACK2] = time + cycle;
      f[WS_EVENTS] |= primary ? WEV_MELEE : WEV_MELEE2;
    }
  } else if ((buttons & IN_ATTACK) && ready && f[WS_RELOAD_END] === 0 && time >= f[WS_NEXT_ATTACK] &&
    (w.auto || pressed)) {
    if (f[o + 1] <= 0) {
      if (!startReload(f, w, time, o)) {
        f[WS_EVENTS] |= WEV_DRYFIRE;
        f[WS_NEXT_ATTACK] = time + 0.2;
      }
    } else {
      fire(ws, ps, w, o, buttons, pitch, yaw, tick, time, eyeX, eyeY, eyeZ, shots);
    }
  }

  // Recoil index unwinds at the rate it builds up once we stop firing.
  if (!w.melee && time - f[WS_LAST_SHOT] > w.cycle && f[WS_RECOIL_INDEX] > 0) {
    f[WS_RECOIL_INDEX] = Math.max(0, f[WS_RECOIL_INDEX] - TICK_DT / w.cycle);
  }
  f[WS_OLD_BUTTONS] = buttons;
}

function fire(ws, ps, w, o, buttons, pitch, yaw, tick, time, ex, ey, ez, shots) {
  const f = ws.f;
  f[o + 1] -= 1;
  const inacc = getInaccuracy(ws, ps, buttons); // before this shot's penalty: first shot is accurate

  const p = (pitch + f[WS_PUNCH] * RECOIL.scale) * DEG;
  const yw = (yaw + f[WS_PUNCH + 1] * RECOIL.scale) * DEG;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(yw), cy = Math.cos(yw);
  const fx = cp * cy, fy = cp * sy, fz = -sp; // forward
  const rx = sy, ry = -cy; // right
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx; // up = right x forward

  // CS:GO FX_FireBullets: inaccuracy and spread each add a random polar offset.
  seedRandom(hash32(tick + 1));
  const t0 = random() * 2 * Math.PI, r0 = random() * inacc;
  const t1 = random() * 2 * Math.PI, r1 = random() * w.spread;
  const x = r0 * Math.cos(t0) + r1 * Math.cos(t1);
  const y = r0 * Math.sin(t0) + r1 * Math.sin(t1);
  let dx = fx + x * rx + y * ux, dy = fy + x * ry + y * uy, dz = fz + y * uz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx /= len; dy /= len; dz /= len;
  shots.push(ex, ey, ez, dx, dy, dz, w.range, f[o]);

  f[WS_PENALTY] += w.inaccuracyFire;
  const idx = Math.min(Math.floor(f[WS_RECOIL_INDEX]), RECOIL.patternLength - 1);
  f[WS_PUNCH_VEL] += w.recoilPattern[idx * 2];
  f[WS_PUNCH_VEL + 1] += w.recoilPattern[idx * 2 + 1];
  f[WS_RECOIL_INDEX] += 1;
  f[WS_LAST_SHOT] = time;
  f[WS_NEXT_ATTACK] = time + w.cycle;
  f[WS_EVENTS] |= WEV_FIRE;
}

// View angle offset the camera shows from recoil (degrees): punch * scale * tracking.
export function viewPunchPitch(ws) {
  return ws.f[WS_PUNCH] * RECOIL.scale * RECOIL.viewTracking;
}
export function viewPunchYaw(ws) {
  return ws.f[WS_PUNCH + 1] * RECOIL.scale * RECOIL.viewTracking;
}
