// What the game sounds like: turns our predicted weapon events and movement, the other
// players' snapshot rows and the grenade lists into positional sounds (client/audio.js).
// CS:GO rules of thumb: running is heard, walking (shift) and crouching are silent;
// every gun has its own report; reloads click at the magazine's moments.

import { GUN_SOUNDS } from './audio.js';
import {
  WEAPONS, WEV_FIRE, WEV_MELEE, WEV_MELEE2, WEV_DRYFIRE, WEV_RELOAD, WEV_SHELL, WEV_DEPLOY, WEV_ZOOM, WEV_MODE, WEV_PIN,
  WEV_THROW, WEV_COCK, SLOT_SECONDARY,
} from '../shared/weapons.js';
import { PS_VEL, PS_FLAGS, PS_EVENTS, PS_LAND_SPEED, FL_ONGROUND, FL_DUCKING, EV_LAND } from '../shared/pmove.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_FLAGS, E_WEAPON, E_ANIM, E_SHOTS, E_HEALTH, E_FIELDS, ANIM_RELOAD,
  ANIM_SILENCED,
} from '../shared/protocol.js';
import { FX_FIRE, FX_DECOY, fireRadius } from '../shared/grenades.js';

const STEP_SPEED = 140; // faster than this on the ground is audible (CS:GO walks at ~130)
const STEP_LENGTH = 72; // units between footsteps
const SMG = new Set(['mac10', 'mp9', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon']);
const SNIPER = new Set(['awp', 'ssg08', 'g3sg1', 'scar20']);
const HEAVY = new Set(['deagle', 'revolver']);
const MG = new Set(['m249', 'negev']);
const RELOAD_CLICKS = [['magout', 0.25], ['magin', 0.6], ['bolt', 0.76]]; // as the first-person animation

// The gunshot voice of weapon w.
export function gunProfile(w, silencedOn) {
  if (silencedOn) return GUN_SOUNDS.silenced;
  if (w.bullets > 1) return GUN_SOUNDS.shotgun;
  if (SNIPER.has(w.name)) return GUN_SOUNDS.sniper;
  if (HEAVY.has(w.name)) return GUN_SOUNDS.heavy;
  if (MG.has(w.name)) return GUN_SOUNDS.mg;
  if (SMG.has(w.name)) return GUN_SOUNDS.smg;
  return w.slot === SLOT_SECONDARY ? GUN_SOUNDS.pistol : GUN_SOUNDS.rifle;
}

// Weapons of one class sound a little different from each other.
const pitchOf = (id) => 0.92 + (id % 5) * 0.04;

export class SoundScape {
  // sounds: Sounds; surfaceKind(x, y, z): 'soft' | 'metal' | 'wood' | 'hard' under a point,
  // 'water' | 'wade' in water at the feet / above the knees.
  constructor(sounds, surfaceKind) {
    this.s = sounds;
    this.surfaceKind = surfaceKind;
    this.ownStep = 0;
    this.shots = new Int16Array(MAX_PLAYERS).fill(-1); // last E_SHOTS seen per player
    this.anim = new Uint8Array(MAX_PLAYERS);
    this.stepDist = new Float32Array(MAX_PLAYERS);
    this.px = new Float32Array(MAX_PLAYERS).fill(NaN);
    this.py = new Float32Array(MAX_PLAYERS);
    this.nextDecoy = new Map(); // decoy effect id -> its next fake shot (s)
    this.onShot = null; // (x, y, z, silenced): another player fired a gun (the muzzle flash light)
  }

  // Our predicted weapon events of one tick; w: the weapon in hand; silencedOn.
  ownEvents(ev, w, silencedOn) {
    const s = this.s;
    if (!ev || !w) return;
    if (ev & WEV_FIRE) s.gun(gunProfile(w, silencedOn), null, 0, 0, 1, pitchOf(WEAPONS.indexOf(w)));
    if (ev & (WEV_MELEE | WEV_MELEE2 | WEV_THROW)) s.swish();
    if (ev & WEV_DRYFIRE) s.click('dry');
    if ((ev & WEV_RELOAD) && !w.shellTime) {
      for (const [name, at] of RELOAD_CLICKS) s.click(name, null, 0, 0, 1, at * w.reloadTime);
    }
    if (ev & WEV_SHELL) s.click('shell');
    if (ev & WEV_DEPLOY) s.click('deploy');
    if (ev & WEV_ZOOM) s.click('zoom');
    if (ev & (WEV_MODE | WEV_COCK)) s.click('mode');
    if (ev & WEV_PIN) s.click('pin');
  }

  // Our movement this tick: footsteps while running on the ground, the landing thud.
  ownMove(ps, buttonsWalk, x, y, feetZ) {
    const flags = ps.i[PS_FLAGS];
    if (ps.i[PS_EVENTS] & EV_LAND) this.s.land(Math.min(1, ps.f[PS_LAND_SPEED] / 500 + 0.3), this.surfaceKind(x, y, feetZ));
    const speed = Math.hypot(ps.f[PS_VEL], ps.f[PS_VEL + 1]);
    if (!(flags & FL_ONGROUND) || (flags & FL_DUCKING) || buttonsWalk || speed < STEP_SPEED) return;
    this.ownStep += speed / 64;
    if (this.ownStep < STEP_LENGTH) return;
    this.ownStep = 0;
    this.s.step(this.surfaceKind(x, y, feetZ), null, 0, 0, 0.35);
  }

  // Other players from interpolated rows (E_* layout): shots, reloads, footsteps.
  // feet(row): feet height of a row; dt: frame seconds.
  others(rows, selfId, dt, feet) {
    const s = this.s;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const r = id * E_FIELDS;
      if (id === selfId || !rows[r + E_ACTIVE] || rows[r + E_HEALTH] <= 0) {
        this.shots[id] = -1;
        this.px[id] = NaN;
        continue;
      }
      const x = rows[r + E_X], y = rows[r + E_Y], z = rows[r + E_Z], w = WEAPONS[rows[r + E_WEAPON]];
      const shots = rows[r + E_SHOTS], anim = rows[r + E_ANIM];
      if (this.shots[id] >= 0 && shots !== this.shots[id] && w) {
        if (w.gun) {
          s.gun(gunProfile(w, (anim & ANIM_SILENCED) !== 0), x, y, z + 28, 1, pitchOf(rows[r + E_WEAPON]));
          if (this.onShot) this.onShot(x, y, z + 28, (anim & ANIM_SILENCED) !== 0);
        } else s.swish(x, y, z + 28);
      }
      this.shots[id] = shots;
      if ((anim & ANIM_RELOAD) && !(this.anim[id] & ANIM_RELOAD) && w && w.gun && !w.shellTime) {
        for (const [name, at] of RELOAD_CLICKS) s.click(name, x, y, z, 1, at * w.reloadTime);
      }
      this.anim[id] = anim;
      // Footsteps from how fast they move.
      if (!Number.isNaN(this.px[id]) && dt > 0) {
        const d = Math.hypot(x - this.px[id], y - this.py[id]);
        const flags = rows[r + E_FLAGS];
        if (d / dt > STEP_SPEED && d < 64 && (flags & FL_ONGROUND) && !(flags & FL_DUCKING)) {
          this.stepDist[id] += d;
          if (this.stepDist[id] >= STEP_LENGTH) {
            this.stepDist[id] = 0;
            const fz = feet(rows, r);
            s.step(this.surfaceKind(x, y, fz), x, y, fz);
          }
        }
      }
      this.px[id] = x;
      this.py[id] = y;
    }
  }

  // Grenade effects each frame: fires crackle, decoys fire fake shots. g: the lists
  // shown; time: seconds (any steady clock).
  effects(g, time, dt) {
    const s = this.s;
    for (let k = 0; k < g.fxCount; k++) {
      const kind = g.fxKind[k], x = g.fxPos[k * 3], y = g.fxPos[k * 3 + 1], z = g.fxPos[k * 3 + 2];
      if (kind === FX_FIRE && Math.random() < dt * 14) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * fireRadius(g.fxAge[k]);
        s.crackle(x + Math.cos(a) * d, y + Math.sin(a) * d, z + 8);
      } else if (kind === FX_DECOY) { // CS:GO's decoy sounds like a gun: bursts at random
        const id = g.fxId[k];
        const next = this.nextDecoy.get(id) ?? time + 0.5;
        if (time >= next) {
          const n = 1 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) setTimeout(() => s.gun(GUN_SOUNDS.rifle, x, y, z + 8, 0.9), i * 110);
          this.nextDecoy.set(id, time + 0.6 + Math.random() * 1.6);
        } else if (!this.nextDecoy.has(id)) this.nextDecoy.set(id, next);
      }
    }
    if (this.nextDecoy.size > 16) this.nextDecoy.clear();
  }
}
