// CS:GO weapon simulation shared by client (prediction) and server (authority).
// Mirrors CS:GO's structure: accuracy penalty with recovery, movement/air inaccuracy,
// per-bullet spread seeded by the command number, and aim punch driven by each
// gun's recoil table, generated from CS:GO's game data exactly as the game does.
// Timing is in ticks, so fire rates quantize to 64 Hz exactly like CS:GO on 64-tick
// servers.

import { TICK_DT, IN_ATTACK, IN_ATTACK2, IN_RELOAD, IN_SPEED, IN_DROP } from './constants.js';
import {
  MOVE, eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_EVENTS, PS_LAND_SPEED,
  FL_ONGROUND, FL_DUCKING, FL_ONLADDER, EV_JUMP, EV_LAND,
} from './pmove.js';
import { CSGO_WEAPONS } from './weapondata.js';

// CS:GO recoil convars.
export const RECOIL = {
  scale: 2, // weapon_recoil_scale: bullets follow aim punch * 2
  viewTracking: 0.45, // view_recoil_tracking: the camera shows 45% of that
  decayExp: 8, // weapon_recoil_decay2_exp
  decayLin: 18, // weapon_recoil_decay2_lin (degrees/s)
  velDecay: 4.5, // weapon_recoil_vel_decay
  variance: 0.55, // weapon_recoil_variance: full-auto table lerps this far toward each new random kick
  suppressionShots: 4, // weapon_recoil_suppression_shots
  suppressionFactor: 0.75, // weapon_recoil_suppression_factor: first shot's kick scale, ramping to 1
  patternLength: 64,
};

export const SLOT_PRIMARY = 0;
export const SLOT_SECONDARY = 1;
export const SLOT_KNIFE = 2;
export const SLOT_GRENADE = 3;
export const SLOT_C4 = 4;
export const NUM_SLOTS = 5;

const mr = (x) => x * 0.001; // milliradians -> radians

// What items_game.txt lacks (it lives in model animations): HUD label, reload time
// (approximate), and whether the weapon spawns in its alt mode (silencer attached).
const EXTRA = {
  glock: ['Glock-18', 2.27], hkp2000: ['P2000', 2.2], usp_silencer: ['USP-S', 2.17, true],
  p250: ['P250', 2.2], elite: ['Dual Berettas', 3.77], fiveseven: ['Five-SeveN', 2.2], tec9: ['Tec-9', 2.5],
  cz75a: ['CZ75-Auto', 2.7], deagle: ['Desert Eagle', 2.2], revolver: ['R8 Revolver', 2.3],
  mac10: ['MAC-10', 2.6], mp9: ['MP9', 2.1], mp7: ['MP7', 3.1], mp5sd: ['MP5-SD', 2.97], ump45: ['UMP-45', 3.5],
  p90: ['P90', 3.3], bizon: ['PP-Bizon', 2.4],
  galilar: ['Galil AR', 3.0], famas: ['FAMAS', 3.3], ak47: ['AK-47', 2.43], m4a1: ['M4A4', 3.07],
  m4a1_silencer: ['M4A1-S', 3.07, true], sg556: ['SG 553', 2.8], aug: ['AUG', 3.8], ssg08: ['SSG 08', 3.7],
  awp: ['AWP', 3.67], g3sg1: ['G3SG1', 4.7], scar20: ['SCAR-20', 3.1],
  nova: ['Nova', 4.0], xm1014: ['XM1014', 3.0], sawedoff: ['Sawed-Off', 3.5], mag7: ['MAG-7', 2.5],
  m249: ['M249', 5.7], negev: ['Negev', 5.7],
};
// Shotguns loading shell by shell (CS:GO's Nova, XM1014, Sawed-Off): seconds before the
// first shell, then per shell (approximations of the animations); the MAG-7 uses a magazine.
const SHELL_RELOAD = { nova: [0.5, 0.5], xm1014: [0.5, 0.4], sawedoff: [0.5, 0.5] };
const PISTOLS = new Set(['glock', 'hkp2000', 'usp_silencer', 'p250', 'elite', 'fiveseven', 'tec9', 'cz75a',
  'deagle', 'revolver']);

// Stats that depend on the weapon's mode: CS:GO's "Alt" values (scoped, burst fire,
// silencer attached, the revolver's fanning). Inaccuracies become radians.
function modeStats(d, alt) {
  const m = (k) => (alt && d[k + 'Alt'] !== null ? d[k + 'Alt'] : d[k]);
  return {
    maxSpeed: m('maxPlayerSpeed'), spread: mr(m('spread')), inaccuracyStand: mr(m('inaccuracyStand')),
    inaccuracyCrouch: mr(m('inaccuracyCrouch')), inaccuracyMove: mr(m('inaccuracyMove')),
    inaccuracyJump: mr(m('inaccuracyJump')), inaccuracyLand: m('inaccuracyLand'),
    inaccuracyLadder: mr(m('inaccuracyLadder')), inaccuracyFire: mr(m('inaccuracyFire')),
    recoilAngle: m('recoilAngle'), recoilAngleVariance: m('recoilAngleVariance'),
    recoilMagnitude: m('recoilMagnitude'), recoilMagnitudeVariance: m('recoilMagnitudeVariance'),
  };
}

// Builds a weapon from CS:GO's game data; its top-level stats are the spawn mode's
// (`modes` holds both, see weaponStats).
function fromGameData(name) {
  const d = CSGO_WEAPONS[name];
  const [label, reloadTime, alt = false] = EXTRA[name];
  const [reloadStart, shellTime] = SHELL_RELOAD[name] || [0, 0];
  const modes = [modeStats(d, false), modeStats(d, true)];
  const altKind = d.zoomLevels > 0 ? 'scope' : d.hasSilencer ? 'silencer' : d.hasBurstMode ? 'burst'
    : d.isRevolver ? 'revolver' : null;
  return {
    name, label, slot: PISTOLS.has(name) ? SLOT_SECONDARY : SLOT_PRIMARY, auto: d.isFullAuto === 1,
    bullets: d.bullets, cycle: d.cycletime, damage: d.damage, armorRatio: d.armorRatio,
    penetration: d.penetration, range: d.range, rangeModifier: d.rangeModifier, headshotMult: d.headshotMultiplier,
    clip: d.primaryClipSize, reserve: d.primaryReserveAmmoMax,
    reloadTime: shellTime ? reloadStart + d.primaryClipSize * shellTime : reloadTime, reloadStart, shellTime,
    deployTime: 1.0, price: d.inGamePrice, killAward: d.killAward,
    ...modes[alt ? 1 : 0], modes, defaultAlt: alt, altKind, cycleAlt: d.cycletimeAlt,
    zoomLevels: d.zoomLevels, zoomFov: [90, d.zoomFov1, d.zoomFov2], boltAction: name === 'awp' || name === 'ssg08',
    burstCycle: d.cycletimeWhenInBurstMode, burstGap: d.timeBetweenBurstShots,
    inaccuracyJumpInitial: mr(d.inaccuracyJumpInitial),
    recoveryStand: d.recoveryTimeStand, recoveryStandFinal: d.recoveryTimeStandFinal,
    recoveryCrouch: d.recoveryTimeCrouch, recoveryCrouchFinal: d.recoveryTimeCrouchFinal,
    recoveryStartBullet: d.recoveryTransitionStartBullet, recoveryEndBullet: d.recoveryTransitionEndBullet,
    recoilSeed: d.recoilSeed,
    flinchLarge: d.flinchVelocityModifierLarge, flinchSmall: d.flinchVelocityModifierSmall,
    teams: d.teams, // who can buy it: 1 T, 2 CT, 3 both
  };
}

export const WEAPONS = [
  null, // id 0: no weapon
  {
    name: 'knife', label: 'Knife', slot: SLOT_KNIFE, melee: true,
    cycle: 0.4, cycle2: 1.0, damage: 40, damage2: 65, range: 48, range2: 32,
    maxSpeed: 250, deployTime: 1.0, price: 0, killAward: 1500, armorRatio: 1.7, flinchLarge: 0, flinchSmall: 0,
  },
  ...Object.keys(EXTRA).map(fromGameData),
  {
    name: 'c4', label: 'C4 Explosive', slot: SLOT_C4, c4: true, clip: 0, reserve: 0,
    maxSpeed: 250, deployTime: 1.0, price: 0, killAward: 0, teams: 0, armorRatio: 1, flinchLarge: 0, flinchSmall: 0,
  },
  // Grenades (slot 4, several kinds at once, see WS_GRENADES): CS:GO prices, speeds and
  // carry limits; `grenade` is the kind (shared/grenades.js).
  ...[
    ['hegrenade', 'HE Grenade', 'he', 300, 3, 1],
    ['flashbang', 'Flashbang', 'flash', 200, 3, 2],
    ['smokegrenade', 'Smoke Grenade', 'smoke', 300, 3, 1],
    ['molotov', 'Molotov', 'fire', 400, 1, 1],
    ['incgrenade', 'Incendiary Grenade', 'fire', 600, 2, 1],
    ['decoy', 'Decoy Grenade', 'decoy', 50, 3, 1],
  ].map(([name, label, grenade, price, teams, limit]) => ({
    name, label, slot: SLOT_GRENADE, grenade, price, teams, limit, maxSpeed: 245, clip: 0, reserve: 0,
    deployTime: 0.6, killAward: 300, armorRatio: 1, flinchLarge: 0, flinchSmall: 0,
  })),
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

// Valve's CUniformRandomStream (Source SDK 2013 vstdlib/random.cpp): Park-Miller
// minimal standard generator with a Bays-Durham shuffle. CS:GO seeds one with each
// weapon's "recoil seed", so reproducing it bit for bit reproduces the spray patterns.
const RS_IA = 16807, RS_IM = 2147483647, RS_IQ = 127773, RS_IR = 2836, RS_NTAB = 32;
const RS_NDIV = 1 + Math.floor((RS_IM - 1) / RS_NTAB);
export class UniformRandomStream {
  constructor(seed = 0) {
    this.iv = new Int32Array(RS_NTAB);
    this.setSeed(seed);
  }

  setSeed(seed) {
    this.idum = seed < 0 ? seed : -seed;
    this.iy = 0;
  }

  generateRandomNumber() {
    let k;
    if (this.idum <= 0 || !this.iy) {
      this.idum = -this.idum < 1 ? 1 : -this.idum;
      for (let j = RS_NTAB + 7; j >= 0; j--) {
        k = Math.trunc(this.idum / RS_IQ);
        this.idum = RS_IA * (this.idum - k * RS_IQ) - RS_IR * k;
        if (this.idum < 0) this.idum += RS_IM;
        if (j < RS_NTAB) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0];
    }
    k = Math.trunc(this.idum / RS_IQ);
    this.idum = RS_IA * (this.idum - k * RS_IQ) - RS_IR * k;
    if (this.idum < 0) this.idum += RS_IM;
    const j = Math.floor(this.iy / RS_NDIV);
    this.iy = this.iv[j];
    this.iv[j] = this.idum;
    return this.iy;
  }

  // Float in [lo, hi), computed in single precision like the C++.
  randomFloat(lo, hi) {
    let fl = Math.fround((1 / RS_IM) * this.generateRandomNumber());
    if (fl > 1 - 1.2e-7) fl = Math.fround(1 - 1.2e-7);
    return Math.fround(fl * (hi - lo) + lo);
  }
}

// Recoil table as CS:GO generates it: per shot index, a random angle (degrees from
// straight up, positive = right) and magnitude. Full-auto weapons lerp toward each new
// random value, so patterns sweep instead of jittering, and their first shots kick less.
// Stored as the aim-punch velocity kick (pitch, yaw) in deg/s.
const recoilRandom = new UniformRandomStream();
export function buildRecoilPattern(w) {
  const n = RECOIL.patternLength;
  const out = new Float32Array(n * 2);
  recoilRandom.setSeed(w.recoilSeed);
  let angle = 0, mag = 0;
  for (let j = 0; j < n; j++) {
    const angleNew = w.recoilAngle + recoilRandom.randomFloat(-w.recoilAngleVariance, w.recoilAngleVariance);
    const magNew = w.recoilMagnitude + recoilRandom.randomFloat(-w.recoilMagnitudeVariance, w.recoilMagnitudeVariance);
    if (w.auto && j > 0) {
      angle += (angleNew - angle) * RECOIL.variance;
      mag += (magNew - mag) * RECOIL.variance;
    } else {
      angle = angleNew;
      mag = magNew;
    }
    let kick = mag;
    if (w.auto && j < RECOIL.suppressionShots) {
      kick *= RECOIL.suppressionFactor + (1 - RECOIL.suppressionFactor) * j / RECOIL.suppressionShots;
    }
    const a = angle * Math.PI / 180;
    out[j * 2] = -Math.cos(a) * kick; // pitch: negative kicks the view up
    out[j * 2 + 1] = -Math.sin(a) * kick; // yaw: negative turns right
  }
  return out;
}
for (const w of WEAPONS) if (w) w.gun = !w.melee && !w.c4 && !w.grenade;
for (const w of WEAPONS) {
  if (!w || !w.gun) continue;
  for (const m of w.modes) m.recoilPattern = buildRecoilPattern({ ...w, ...m });
  w.recoilPattern = w.modes[w.defaultAlt ? 1 : 0].recoilPattern;
}

// Grenade kinds in WS_GRENADES order; CS:GO competitive carries at most 4 in all.
export const GRENADE_IDS = WEAPONS.flatMap((w, id) => (w && w.grenade ? [id] : []));
export const GRENADE_LIMIT = 4; // ammo_grenade_limit_total

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
export const WS_ACTION = 15; // ACTION_*: planting or defusing the bomb
export const WS_ACTION_END = 16; // seconds: when that action completes
export const WS_SLOTS = 17; // per slot: weapon id, clip, reserve
export const WS_ALT = WS_SLOTS + NUM_SLOTS * 3; // bit per slot: silencer on / burst mode
export const WS_ZOOM = WS_ALT + 1; // scope level, 0 = unscoped
export const WS_RESUME_ZOOM = WS_ALT + 2; // bolt-action rifles zoom back in after the bolt
export const WS_MODE_END = WS_ALT + 3; // seconds: a silencer goes on / comes off then
export const WS_BURST_LEFT = WS_ALT + 4; // shots left in the current burst
export const WS_BURST_NEXT = WS_ALT + 5; // seconds: the next one
export const WS_COCK = WS_ALT + 6; // seconds: the revolver fires then (hammer cocking)
export const WS_THROW = WS_ALT + 7; // grenade pin pulled: THROW_* strength
export const WS_THROW_TIME = WS_ALT + 8; // seconds: the grenade leaves the hand then (released)
export const WS_THROWN = WS_ALT + 9; // output: weapon id * 4 + THROW_* of the grenade thrown (WEV_THROW)
export const WS_GRENADES = WS_ALT + 10; // count per GRENADE_IDS kind
export const WS_SIZE = WS_GRENADES + 6;

export const WEV_FIRE = 1;
export const WEV_RELOAD = 2;
export const WEV_RELOADED = 4;
export const WEV_DEPLOY = 8;
export const WEV_DRYFIRE = 16;
export const WEV_MELEE = 32;
export const WEV_MELEE2 = 64;
export const WEV_PLANTED = 128;
export const WEV_DEFUSED = 256;
export const WEV_DROP = 512; // dropped the weapon in hand (G)
export const WEV_SHELL = 1024; // a shotgun shell went in
export const WEV_ZOOM = 2048; // scope level changed
export const WEV_MODE = 4096; // burst mode toggled / silencer on or off
export const WEV_PIN = 8192; // grenade pin pulled
export const WEV_THROW = 16384; // grenade thrown (WS_THROWN says which and how)
export const WEV_COCK = 32768; // revolver hammer
export const SILENCER_TIME = 3.0; // attaching / removing a silencer (approximation of the animations)
export const REVOLVER_COCK = 0.23; // trigger to shot for the R8's primary fire (approximation)
export const THROW_DELAY = 0.1; // release to throw (approximation of the animation)
export const THROW_SHORT = 1; // right click: strength 0
export const THROW_MEDIUM = 2; // both buttons: strength 0.5
export const THROW_LONG = 3; // left click: strength 1
export const throwStrength = (code) => (code - 1) / 2;

export const ACTION_PLANT = 1;
export const ACTION_DEFUSE = 2;

export function createWeaponState() {
  return { f: new Float64Array(WS_SIZE) };
}

export function copyWeaponState(dst, src) {
  dst.f.set(src.f);
}

// Puts weapon `id` in its slot with full ammo (grenades: one more, if there is room).
// Returns false when a grenade does not fit.
export function giveWeapon(ws, id) {
  const w = WEAPONS[id];
  if (w.grenade) return giveGrenade(ws, id);
  const o = WS_SLOTS + w.slot * 3;
  ws.f[o] = id;
  ws.f[o + 1] = w.melee ? 0 : w.clip;
  ws.f[o + 2] = w.melee ? 0 : w.reserve;
  const bit = 1 << w.slot;
  ws.f[WS_ALT] = w.defaultAlt ? ws.f[WS_ALT] | bit : ws.f[WS_ALT] & ~bit;
  if (ws.f[WS_ACTIVE] === w.slot) { // replaced in hand: the old gun's reload, scope... end
    ws.f[WS_RELOAD_END] = ws.f[WS_ZOOM] = ws.f[WS_RESUME_ZOOM] = ws.f[WS_MODE_END] = 0;
    ws.f[WS_BURST_LEFT] = ws.f[WS_COCK] = 0;
  }
  return true;
}

// Every gun held back to a full magazine and reserve (a new round for survivors).
export function refillAmmo(ws) {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const o = WS_SLOTS + s * 3, w = WEAPONS[ws.f[o]];
    if (!w || !w.gun) continue;
    ws.f[o + 1] = w.clip;
    ws.f[o + 2] = w.reserve;
  }
}

export function activeWeapon(ws) {
  return WEAPONS[ws.f[WS_SLOTS + ws.f[WS_ACTIVE] * 3]] || null;
}

// --- Modes -------------------------------------------------------------------------

// 1 when weapon w (in hand) is in its alt mode: scoped, burst fire, silencer on.
export function modeOf(ws, w) {
  if (!w || !w.modes) return 0;
  if (w.altKind === 'scope') return ws.f[WS_ZOOM] > 0 ? 1 : 0;
  if (w.altKind === 'silencer' || w.altKind === 'burst') return (ws.f[WS_ALT] >> w.slot) & 1;
  return 0;
}

// The active weapon's stats in its current mode (maxSpeed, spread, inaccuracies,
// recoil), or null.
export function weaponStats(ws) {
  const w = activeWeapon(ws);
  return w && w.modes ? w.modes[modeOf(ws, w)] : w;
}

// Is the weapon in `slot` a silenced one with its silencer on.
export function silenced(ws, slot) {
  const w = WEAPONS[ws.f[WS_SLOTS + slot * 3]];
  return !!w && w.altKind === 'silencer' && ((ws.f[WS_ALT] >> slot) & 1) === 1;
}

// --- Grenades ------------------------------------------------------------------------

const kindOf = (id) => GRENADE_IDS.indexOf(id);

export function grenadeCount(ws, id) {
  const k = kindOf(id);
  return k < 0 ? 0 : ws.f[WS_GRENADES + k];
}

export function grenadeTotal(ws) {
  let n = 0;
  for (let k = 0; k < GRENADE_IDS.length; k++) n += ws.f[WS_GRENADES + k];
  return n;
}

// Room for one more grenade `id` (its own limit and the total).
export function canCarryGrenade(ws, id) {
  return grenadeCount(ws, id) < WEAPONS[id].limit && grenadeTotal(ws) < GRENADE_LIMIT;
}

// Adds a grenade; the grenade slot shows it if it held none. False when full.
export function giveGrenade(ws, id) {
  if (!canCarryGrenade(ws, id)) return false;
  ws.f[WS_GRENADES + kindOf(id)]++;
  if (!ws.f[WS_SLOTS + SLOT_GRENADE * 3]) ws.f[WS_SLOTS + SLOT_GRENADE * 3] = id;
  return true;
}

// The next grenade kind held after `id` (cycling, `id` itself last), or 0.
export function nextGrenade(ws, id) {
  const k0 = Math.max(kindOf(id), 0), n = GRENADE_IDS.length;
  for (let i = 1; i <= n; i++) {
    const k = (k0 + i) % n;
    if (ws.f[WS_GRENADES + k] > 0) return GRENADE_IDS[k];
  }
  return 0;
}

// Takes one grenade `id` away; the slot moves on to another kind, or empties.
export function takeGrenade(ws, id) {
  const k = kindOf(id);
  if (k < 0 || ws.f[WS_GRENADES + k] <= 0) return;
  ws.f[WS_GRENADES + k]--;
  const o = WS_SLOTS + SLOT_GRENADE * 3;
  if (ws.f[o] === id && ws.f[WS_GRENADES + k] === 0) ws.f[o] = nextGrenade(ws, id);
}

// Bullets / swings produced by one tick (preallocated, reused).
export class ShotList {
  constructor(capacity = 16) {
    this.count = 0;
    this.origin = new Float64Array(capacity * 3);
    this.dir = new Float64Array(capacity * 3);
    this.range = new Float64Array(capacity);
    this.weapon = new Int32Array(capacity);
    this.damage = new Float64Array(capacity); // base damage before range falloff
  }

  push(ox, oy, oz, dx, dy, dz, range, weapon, damage) {
    const i = this.count++;
    this.origin[i * 3] = ox; this.origin[i * 3 + 1] = oy; this.origin[i * 3 + 2] = oz;
    this.dir[i * 3] = dx; this.dir[i * 3 + 1] = dy; this.dir[i * 3 + 2] = dz;
    this.range[i] = range;
    this.weapon[i] = weapon;
    this.damage[i] = damage;
  }
}

// CS:GO bullet damage after travelling `dist` units: damage * rangeModifier^(dist / 500).
export function damageAtRange(w, damage, dist) {
  return w.melee ? damage : damage * Math.pow(w.rangeModifier, dist / 500);
}

// Current inaccuracy (radians, cone radius) as CS:GO's GetInaccuracy: accuracy
// penalty plus movement and airborne terms.
export function getInaccuracy(ws, ps, buttons, mode = -1) {
  const aw = activeWeapon(ws);
  if (!aw || !aw.gun) return 0;
  const w = aw.modes[mode >= 0 ? mode : modeOf(ws, aw)];
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

// CS:GO GetRecoveryTime: recovery slows from the base to the "final" time as the
// recoil index climbs from the transition start bullet to the end bullet.
export function recoveryTime(w, ducked, recoilIndex) {
  const base = ducked ? w.recoveryCrouch : w.recoveryStand;
  const final = ducked ? w.recoveryCrouchFinal : w.recoveryStandFinal;
  if (final === -1) return base; // weapon has no transition
  const a = w.recoveryStartBullet, b = w.recoveryEndBullet, i = Math.floor(recoilIndex);
  if (a === b) return i >= b ? final : base;
  const t = Math.min(Math.max((i - a) / (b - a), 0), 1);
  return base + (final - base) * t;
}

function updateAccuracyPenalty(ws, ps, w, time) {
  const f = ws.f, s = w.modes[modeOf(ws, w)];
  const flags = ps.i[PS_FLAGS];
  const ducked = (flags & FL_DUCKING) !== 0;
  let target;
  if (flags & FL_ONLADDER) target = s.inaccuracyLadder;
  else if (ducked) target = s.inaccuracyCrouch;
  else target = s.inaccuracyStand;

  // Penalty and recoil index decay by the same factor: to 10% over the recovery time.
  const decay = Math.exp(-TICK_DT * Math.log(10) / recoveryTime(w, ducked, f[WS_RECOIL_INDEX]));
  if (target > f[WS_PENALTY]) f[WS_PENALTY] = target;
  else f[WS_PENALTY] = target + (f[WS_PENALTY] - target) * decay;
  // The recoil index only decays once a little more than a cycle passes without a shot.
  if (time > f[WS_LAST_SHOT] + w.cycle * 1.1) f[WS_RECOIL_INDEX] *= decay;

  const events = ps.i[PS_EVENTS];
  if (events & EV_JUMP) f[WS_PENALTY] += w.inaccuracyJumpInitial;
  if (events & EV_LAND) f[WS_PENALTY] += s.inaccuracyLand * Math.min(ps.f[PS_LAND_SPEED] / 600, 1);
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

// WS_RELOAD_END is when the reload completes, or for shell-by-shell shotguns when the
// next shell goes in (the first after reloadStart).
function startReload(f, w, time, o) {
  if (f[WS_RELOAD_END] > 0 || f[o + 1] >= w.clip || f[o + 2] <= 0) return false;
  if (f[WS_MODE_END] > 0) return false; // busy with the silencer
  f[WS_RELOAD_END] = time + (w.shellTime ? w.reloadStart + w.shellTime : w.reloadTime);
  f[WS_EVENTS] |= WEV_RELOAD;
  f[WS_ZOOM] = f[WS_RESUME_ZOOM] = f[WS_BURST_LEFT] = f[WS_COCK] = 0;
  return true;
}

const DEG = Math.PI / 180;

// The demo's infinite ammo (CS:GO's sv_infinite_ammo 1, run after weaponTick in the
// shared simulation, so clients predict it): a shot of the weapon that was in `slot` with
// `clip` rounds before the tick takes none, and a thrown grenade comes back, up again.
export function infiniteAmmo(ws, slot, clip, time) {
  const f = ws.f;
  if ((f[WS_EVENTS] & WEV_FIRE) && f[WS_ACTIVE] === slot) {
    const o = WS_SLOTS + slot * 3 + 1;
    if (f[o] < clip) f[o] = clip;
  }
  if (f[WS_EVENTS] & WEV_THROW) {
    const id = Math.floor(f[WS_THROWN] / 4), last = f[WS_LAST_SLOT];
    f[WS_GRENADES + kindOf(id)]++;
    f[WS_SLOTS + SLOT_GRENADE * 3] = id;
    deploy(ws, SLOT_GRENADE, time);
    f[WS_LAST_SLOT] = last;
  }
}

function deploy(ws, slot, time) {
  const f = ws.f;
  f[WS_LAST_SLOT] = f[WS_ACTIVE];
  f[WS_ACTIVE] = slot;
  const nw = activeWeapon(ws);
  f[WS_DEPLOY_END] = time + nw.deployTime;
  f[WS_NEXT_ATTACK] = f[WS_NEXT_ATTACK2] = f[WS_DEPLOY_END];
  f[WS_RELOAD_END] = 0;
  f[WS_RECOIL_INDEX] = 0;
  f[WS_PENALTY] = nw.gun ? nw.modes[modeOf(ws, nw)].inaccuracyStand : 0;
  f[WS_ZOOM] = f[WS_RESUME_ZOOM] = f[WS_MODE_END] = f[WS_BURST_LEFT] = f[WS_COCK] = 0;
  f[WS_THROW] = f[WS_THROW_TIME] = 0;
  f[WS_EVENTS] |= WEV_DEPLOY;
}

// Empties `slot`; if it was in hand, switches to the best weapon left (primary,
// secondary, knife), like CS:GO after a drop or a plant.
export function removeWeapon(ws, slot, time) {
  const f = ws.f;
  f[WS_SLOTS + slot * 3] = f[WS_SLOTS + slot * 3 + 1] = f[WS_SLOTS + slot * 3 + 2] = 0;
  if (slot === SLOT_GRENADE) f.fill(0, WS_GRENADES, WS_GRENADES + GRENADE_IDS.length);
  else f[WS_ALT] = f[WS_ALT] & ~(1 << slot);
  if (f[WS_LAST_SLOT] === slot) f[WS_LAST_SLOT] = SLOT_KNIFE;
  if (f[WS_ACTIVE] !== slot) return;
  for (const s of [SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE]) {
    if (f[WS_SLOTS + s * 3] > 0) {
      deploy(ws, s, time);
      f[WS_LAST_SLOT] = SLOT_KNIFE;
      return;
    }
  }
}

// One weapon tick. select = slot to switch to, or -1. tick = command number
// (also the spread seed, like CS:GO's usercmd random_seed).
export function weaponTick(ws, ps, buttons, select, pitch, yaw, tick, shots) {
  const f = ws.f;
  const time = tick * TICK_DT;
  f[WS_EVENTS] = 0;
  shots.count = 0;

  if (select === SLOT_GRENADE && f[WS_ACTIVE] === SLOT_GRENADE && !f[WS_THROW]) {
    // 4 again: the next kind of grenade.
    const next = nextGrenade(ws, f[WS_SLOTS + SLOT_GRENADE * 3]);
    if (next && next !== f[WS_SLOTS + SLOT_GRENADE * 3]) {
      const last = f[WS_LAST_SLOT];
      f[WS_SLOTS + SLOT_GRENADE * 3] = next;
      deploy(ws, SLOT_GRENADE, time);
      f[WS_LAST_SLOT] = last;
    }
  } else if (select >= 0 && select < NUM_SLOTS && select !== f[WS_ACTIVE] && f[WS_SLOTS + select * 3] > 0) {
    deploy(ws, select, time);
  }
  // Drop (G): the weapon in hand (one grenade of its kind), except the knife. The server
  // puts it on the ground (or, for the C4, drops the bomb) from WEV_DROP.
  const held = activeWeapon(ws);
  if ((buttons & IN_DROP) && !(f[WS_OLD_BUTTONS] & IN_DROP) && held && !held.melee && !f[WS_THROW]) {
    if (held.grenade) {
      takeGrenade(ws, f[WS_SLOTS + SLOT_GRENADE * 3]);
      if (f[WS_SLOTS + SLOT_GRENADE * 3]) {
        const last = f[WS_LAST_SLOT];
        deploy(ws, SLOT_GRENADE, time);
        f[WS_LAST_SLOT] = last;
      } else {
        removeWeapon(ws, SLOT_GRENADE, time);
      }
    } else {
      removeWeapon(ws, f[WS_ACTIVE], time);
    }
    f[WS_EVENTS] |= WEV_DROP;
  }

  const w = activeWeapon(ws);
  decayPunch(f);
  if (!w || w.c4) { // the C4 is planted by the player simulation (player.js)
    f[WS_OLD_BUTTONS] = buttons;
    return;
  }
  if (w.grenade) {
    grenadeTick(ws, buttons, time);
    f[WS_OLD_BUTTONS] = buttons;
    return;
  }
  const o = WS_SLOTS + f[WS_ACTIVE] * 3;

  // Finish a reload, or put a shell in.
  if (f[WS_RELOAD_END] > 0 && time >= f[WS_RELOAD_END]) {
    const take = Math.min(w.shellTime ? 1 : w.clip - f[o + 1], f[o + 2]);
    f[o + 1] += take;
    f[o + 2] -= take;
    if (w.shellTime) f[WS_EVENTS] |= WEV_SHELL;
    if (w.shellTime && f[o + 1] < w.clip && f[o + 2] > 0) f[WS_RELOAD_END] += w.shellTime;
    else {
      f[WS_RELOAD_END] = 0;
      f[WS_EVENTS] |= WEV_RELOADED;
    }
  }
  // A silencer finishes going on or coming off.
  if (f[WS_MODE_END] > 0 && time >= f[WS_MODE_END]) {
    f[WS_ALT] = f[WS_ALT] ^ (1 << w.slot);
    f[WS_MODE_END] = 0;
    f[WS_EVENTS] |= WEV_MODE;
  }
  // Bolt-action rifles zoom back in once the bolt is closed (CS:GO's resume zoom).
  if (f[WS_RESUME_ZOOM] > 0 && time >= f[WS_NEXT_ATTACK]) {
    f[WS_ZOOM] = f[WS_RESUME_ZOOM];
    f[WS_RESUME_ZOOM] = 0;
  }

  if (w.gun) updateAccuracyPenalty(ws, ps, w, time);

  const oldButtons = f[WS_OLD_BUTTONS];
  const pressed = (buttons & IN_ATTACK) && !(oldButtons & IN_ATTACK);
  const pressed2 = (buttons & IN_ATTACK2) && !(oldButtons & IN_ATTACK2);
  const ready = time >= f[WS_DEPLOY_END];

  if (!w.melee && ready && (buttons & IN_RELOAD)) startReload(f, w, time, o);
  // Shotguns stop loading to fire what they hold, like CS:GO.
  if (w.shellTime && f[WS_RELOAD_END] > 0 && (buttons & IN_ATTACK) && f[o + 1] > 0) f[WS_RELOAD_END] = 0;

  // Eye position and view axes (with aim punch for guns).
  const eyeX = ps.f[PS_ORIGIN], eyeY = ps.f[PS_ORIGIN + 1], eyeZ = ps.f[PS_ORIGIN + 2] + eyeOffset(ps);
  let idle = ready && f[WS_RELOAD_END] === 0 && f[WS_MODE_END] === 0;

  if (w.melee) {
    const primary = (buttons & IN_ATTACK) && time >= f[WS_NEXT_ATTACK];
    const secondary = !primary && (buttons & IN_ATTACK2) && time >= f[WS_NEXT_ATTACK2];
    if (primary || secondary) {
      const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG);
      const sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
      shots.push(eyeX, eyeY, eyeZ, cp * cy, cp * sy, -sp, primary ? w.range : w.range2, f[o],
        primary ? w.damage : w.damage2);
      const cycle = primary ? w.cycle : w.cycle2;
      f[WS_NEXT_ATTACK] = f[WS_NEXT_ATTACK2] = time + cycle;
      f[WS_EVENTS] |= primary ? WEV_MELEE : WEV_MELEE2;
    }
    f[WS_OLD_BUTTONS] = buttons;
    return;
  }

  // Secondary attack: scope, burst / silencer toggles, the revolver's fanning.
  if (pressed2 && idle && time >= f[WS_NEXT_ATTACK2] && !f[WS_BURST_LEFT]) {
    if (w.altKind === 'scope') {
      f[WS_ZOOM] = (f[WS_ZOOM] + 1) % (w.zoomLevels + 1);
      f[WS_RESUME_ZOOM] = 0;
      f[WS_NEXT_ATTACK2] = time + w.cycleAlt;
      f[WS_EVENTS] |= WEV_ZOOM;
    } else if (w.altKind === 'burst') {
      f[WS_ALT] = f[WS_ALT] ^ (1 << w.slot);
      f[WS_NEXT_ATTACK2] = time + w.cycleAlt;
      f[WS_EVENTS] |= WEV_MODE;
    } else if (w.altKind === 'silencer') {
      f[WS_MODE_END] = time + SILENCER_TIME;
      f[WS_NEXT_ATTACK] = f[WS_NEXT_ATTACK2] = f[WS_MODE_END];
    }
  }
  if (w.altKind === 'revolver' && (buttons & IN_ATTACK2) && !(buttons & IN_ATTACK) && idle &&
    time >= f[WS_NEXT_ATTACK2] && f[o + 1] > 0) {
    fire(ws, ps, w, o, buttons, pitch, yaw, tick, time, eyeX, eyeY, eyeZ, shots, 1);
    f[WS_NEXT_ATTACK] = f[WS_NEXT_ATTACK2] = time + w.cycleAlt;
    f[WS_COCK] = 0;
  }

  // The rest of a burst fires on its own.
  if (f[WS_BURST_LEFT] > 0 && time >= f[WS_BURST_NEXT]) {
    if (f[o + 1] > 0 && f[WS_RELOAD_END] === 0) {
      const next = f[WS_NEXT_ATTACK]; // the burst's cycle, not the gun's
      fire(ws, ps, w, o, buttons, pitch, yaw, tick, time, eyeX, eyeY, eyeZ, shots);
      f[WS_NEXT_ATTACK] = next;
      f[WS_BURST_LEFT] -= 1;
      f[WS_BURST_NEXT] = time + w.burstGap;
    } else {
      f[WS_BURST_LEFT] = 0;
    }
  }

  // An empty magazine reloads by itself once the last shot's cycle is over, trigger held
  // or not (CS:GO); with no reserve left the trigger dry-fires below.
  if (f[o + 1] <= 0 && idle && time >= f[WS_NEXT_ATTACK] && !f[WS_BURST_LEFT] && startReload(f, w, time, o)) {
    idle = false;
  }

  // The revolver fires a moment after the trigger: the hammer cocks while it is held.
  if (w.altKind === 'revolver' && !(buttons & IN_ATTACK)) f[WS_COCK] = 0;

  if ((buttons & IN_ATTACK) && idle && time >= f[WS_NEXT_ATTACK] && !f[WS_BURST_LEFT] && (w.auto || pressed)) {
    if (f[o + 1] <= 0) {
      if (!startReload(f, w, time, o)) {
        f[WS_EVENTS] |= WEV_DRYFIRE;
        f[WS_NEXT_ATTACK] = time + 0.2;
      }
    } else if (w.altKind === 'revolver' && (f[WS_COCK] === 0 || time < f[WS_COCK])) {
      if (f[WS_COCK] === 0) {
        f[WS_COCK] = time + REVOLVER_COCK;
        f[WS_EVENTS] |= WEV_COCK;
      }
    } else {
      f[WS_COCK] = 0;
      const zoom = f[WS_ZOOM];
      fire(ws, ps, w, o, buttons, pitch, yaw, tick, time, eyeX, eyeY, eyeZ, shots);
      if (w.altKind === 'burst' && modeOf(ws, w)) {
        f[WS_BURST_LEFT] = 2;
        f[WS_BURST_NEXT] = time + w.burstGap;
        f[WS_NEXT_ATTACK] = time + w.burstCycle;
      }
      if (w.boltAction && zoom > 0) { // the bolt: out of the scope until it closes
        f[WS_RESUME_ZOOM] = zoom;
        f[WS_ZOOM] = 0;
      }
    }
  }

  f[WS_OLD_BUTTONS] = buttons;
}

// CS:GO grenade handling: attack (long throw) or attack2 (lob) pulls the pin; while it
// is held the strength follows the buttons (both: medium); letting go throws after
// THROW_DELAY. The thrown grenade leaves the inventory (WS_THROWN, WEV_THROW: the server
// launches it); the next one of the kind comes up, else another kind, else the last
// weapon.
function grenadeTick(ws, buttons, time) {
  const f = ws.f, slot = WS_SLOTS + SLOT_GRENADE * 3;
  const a1 = (buttons & IN_ATTACK) !== 0, a2 = (buttons & IN_ATTACK2) !== 0;
  if (f[WS_THROW_TIME] > 0) {
    if (time < f[WS_THROW_TIME]) return;
    const id = f[slot];
    f[WS_THROWN] = id * 4 + f[WS_THROW];
    f[WS_EVENTS] |= WEV_THROW;
    f[WS_THROW] = f[WS_THROW_TIME] = 0;
    takeGrenade(ws, id);
    const back = f[WS_LAST_SLOT];
    if (f[slot]) { // another grenade comes up
      deploy(ws, SLOT_GRENADE, time);
      f[WS_LAST_SLOT] = back;
      return;
    }
    removeWeapon(ws, SLOT_GRENADE, time);
    if (back !== SLOT_GRENADE && f[WS_SLOTS + back * 3] > 0 && f[WS_ACTIVE] !== back) deploy(ws, back, time);
    return;
  }
  if (f[WS_THROW]) {
    if (a1 || a2) f[WS_THROW] = a1 && a2 ? THROW_MEDIUM : a1 ? THROW_LONG : THROW_SHORT;
    else f[WS_THROW_TIME] = time + THROW_DELAY;
    return;
  }
  if ((a1 || a2) && time >= f[WS_DEPLOY_END] && time >= f[WS_NEXT_ATTACK]) {
    f[WS_THROW] = a1 && a2 ? THROW_MEDIUM : a1 ? THROW_LONG : THROW_SHORT;
    f[WS_EVENTS] |= WEV_PIN;
  }
}

// mode: the weapon's stats to shoot with (-1: its current mode; 1: the revolver's fan).
function fire(ws, ps, aw, o, buttons, pitch, yaw, tick, time, ex, ey, ez, shots, mode = -1) {
  const f = ws.f;
  const w = aw.modes[mode >= 0 ? mode : modeOf(ws, aw)];
  f[o + 1] -= 1;
  const inacc = getInaccuracy(ws, ps, buttons, mode); // before this shot's penalty: first shot is accurate

  const p = (pitch + f[WS_PUNCH] * RECOIL.scale) * DEG;
  const yw = (yaw + f[WS_PUNCH + 1] * RECOIL.scale) * DEG;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(yw), cy = Math.cos(yw);
  const fx = cp * cy, fy = cp * sy, fz = -sp; // forward
  const rx = sy, ry = -cy; // right
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx; // up = right x forward

  // CS:GO FX_FireBullets: inaccuracy and spread each add a random polar offset,
  // drawn per pellet for shotguns.
  seedRandom(hash32(tick + 1));
  for (let b = 0; b < aw.bullets; b++) {
    const t0 = random() * 2 * Math.PI, r0 = random() * inacc;
    const t1 = random() * 2 * Math.PI, r1 = random() * w.spread;
    const x = r0 * Math.cos(t0) + r1 * Math.cos(t1);
    const y = r0 * Math.sin(t0) + r1 * Math.sin(t1);
    let dx = fx + x * rx + y * ux, dy = fy + x * ry + y * uy, dz = fz + y * uz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    dx /= len; dy /= len; dz /= len;
    shots.push(ex, ey, ez, dx, dy, dz, aw.range, f[o], aw.damage);
  }

  f[WS_PENALTY] += w.inaccuracyFire;
  const idx = Math.floor(f[WS_RECOIL_INDEX]) % RECOIL.patternLength;
  f[WS_PUNCH_VEL] += w.recoilPattern[idx * 2];
  f[WS_PUNCH_VEL + 1] += w.recoilPattern[idx * 2 + 1];
  f[WS_RECOIL_INDEX] += 1;
  f[WS_LAST_SHOT] = time;
  f[WS_NEXT_ATTACK] = time + aw.cycle;
  f[WS_EVENTS] |= WEV_FIRE;
}

// View angle offset the camera shows from recoil (degrees): punch * scale * tracking.
export function viewPunchPitch(ws) {
  return ws.f[WS_PUNCH] * RECOIL.scale * RECOIL.viewTracking;
}
export function viewPunchYaw(ws) {
  return ws.f[WS_PUNCH + 1] * RECOIL.scale * RECOIL.viewTracking;
}
