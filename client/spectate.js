// Spectating while dead (CS:GO competitive, mp_forcecamera 1): after a moment on our
// own death, the camera follows a living teammate (anyone alive once our team is all
// dead). Mouse1 / mouse2 switch to the next / previous player, jump toggles between
// their eyes (with their weapon in view) and a chase camera behind them.
// The spectator team (`free`) watches anyone at once, and jump cycles on to free roam:
// a camera flying through walls along the view (movement keys; crouch sinks, walk is
// slower); mouse1 / mouse2 from there follow a player again.
//
// Their first-person weapon is animated by the normal view code from a weapon state
// rebuilt from what snapshots say: the weapon in hand, reload / plant / defuse bits,
// the shot counter and the silencer.

import { createPlayerState, eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_DUCK_AMOUNT, FL_DUCKING } from '../shared/pmove.js';
import {
  WEAPONS, createWeaponState, WS_ACTIVE, WS_SLOTS, WS_DEPLOY_END, WS_RELOAD_END, WS_LAST_SHOT, WS_ALT, WS_ACTION,
  WEV_FIRE, WEV_MELEE, ACTION_PLANT, ACTION_DEFUSE,
} from '../shared/weapons.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS,
  E_FIELDS, ANIM_RELOAD, ANIM_PLANT, ANIM_DEFUSE, ANIM_SILENCED, dequantizePitch, dequantizeYaw,
} from '../shared/protocol.js';
import {
  IN_ATTACK, IN_ATTACK2, IN_USE, IN_JUMP, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_DUCK, IN_SPEED,
} from '../shared/constants.js';

export const SPEC_DELAY = 2; // seconds on our own death before following someone (approx.)
export const SPEC_EYES = 0;
export const SPEC_CHASE = 1;
export const SPEC_ROAM = 2; // spectator team only
const CHASE_DISTANCE = 96;
const ROAM_SPEED = 800; // units/s, walk (+speed) 30 % (approx. of CS:GO's sv_specspeed)
const DEG = Math.PI / 180;

export class Spectator {
  constructor() {
    this.target = -1;
    this.mode = SPEC_EYES;
    this.oldButtons = 0;
    this.use = false; // E pressed this frame (take control of a watched teammate bot)
    this.ws = createWeaponState(); // the target's weapon, as far as snapshots tell
    this.ps = createPlayerState();
    this.weapon = -1;
    this.anim = 0;
    this.shots = -1;
    this.px = NaN;
    this.py = 0;
    this.synced = -1; // the target the weapon state is for
    this.roam = new Float32Array(3); // free roam camera position
  }

  // Puts the free roam camera at (x, y, z) (the eye).
  place(x, y, z) {
    this.roam[0] = x;
    this.roam[1] = y;
    this.roam[2] = z;
  }

  // Free roam: flies along the view (pitch, yaw degrees) with the movement buttons.
  fly(buttons, pitch, yaw, dt) {
    const fwd = ((buttons & IN_FORWARD) ? 1 : 0) - ((buttons & IN_BACK) ? 1 : 0);
    const side = ((buttons & IN_MOVERIGHT) ? 1 : 0) - ((buttons & IN_MOVELEFT) ? 1 : 0);
    const up = buttons & IN_DUCK ? -1 : 0;
    const speed = ROAM_SPEED * (buttons & IN_SPEED ? 0.3 : 1) * dt;
    const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG), sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
    const r = this.roam;
    r[0] += (fwd * cp * cy + side * sy) * speed;
    r[1] += (fwd * cp * sy - side * cy) * speed;
    r[2] += (-fwd * sp + up) * speed;
  }

  // Each frame while dead (`deadFor` seconds): picks the target and handles the
  // buttons; `free`: the spectator team (anyone, no delay, free roam). Returns true while
  // following someone or roaming.
  update(rows, selfId, selfTeam, deadFor, buttons, free = false) {
    const pressed = buttons & ~this.oldButtons;
    this.oldButtons = buttons;
    this.use = (pressed & IN_USE) !== 0;
    if (!free && this.mode === SPEC_ROAM) this.mode = SPEC_EYES; // joined a team
    if (deadFor < SPEC_DELAY && !free) {
      this.target = -1;
      return false;
    }
    if (pressed & IN_JUMP) this.mode = (this.mode + 1) % (free ? 3 : 2);
    const step = pressed & IN_ATTACK ? 1 : pressed & IN_ATTACK2 ? -1 : 0;
    if (this.mode === SPEC_ROAM) {
      if (!step) return true;
      this.mode = SPEC_EYES; // mouse1 / mouse2 from free roam: follow someone
    }
    if (step || !this.watchable(rows, this.target, selfId, selfTeam, free)) {
      this.target = this.next(rows, selfId, selfTeam, step || 1, free);
    }
    if (this.target < 0 && free) this.mode = SPEC_ROAM; // nobody to watch
    return this.target >= 0 || this.mode === SPEC_ROAM;
  }

  // Teammates while any live; then anyone (`free`: anyone).
  watchable(rows, id, selfId, selfTeam, free = false) {
    if (id < 0 || id === selfId) return false;
    const r = id * E_FIELDS;
    if (!rows[r + E_ACTIVE] || rows[r + E_HEALTH] <= 0) return false;
    return free || rows[r + E_TEAM] === selfTeam || !this.teamAlive(rows, selfId, selfTeam);
  }

  teamAlive(rows, selfId, team) {
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const r = id * E_FIELDS;
      if (id !== selfId && rows[r + E_ACTIVE] && rows[r + E_HEALTH] > 0 && rows[r + E_TEAM] === team) return true;
    }
    return false;
  }

  next(rows, selfId, selfTeam, dir, free = false) {
    const start = this.target < 0 ? (dir > 0 ? -1 : 0) : this.target;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const id = (start + dir * i + MAX_PLAYERS * 2) % MAX_PLAYERS;
      if (this.watchable(rows, id, selfId, selfTeam, free)) return id;
    }
    return -1;
  }

  // The camera: eye position into `eye`, returns [pitch, yaw] (degrees) in `angles`.
  // clear(x0, y0, z0, x1, y1, z1) -> fraction of the way that is open (chase camera).
  // Free roam: the roam position; `angles` keeps the caller's view.
  camera(rows, eye, angles, clear) {
    if (this.mode === SPEC_ROAM) {
      eye.set(this.roam);
      return;
    }
    const r = this.target * E_FIELDS;
    const ps = this.ps;
    ps.i[PS_FLAGS] = rows[r + E_FLAGS];
    ps.f[PS_DUCK_AMOUNT] = rows[r + E_DUCK] / 255;
    const x = rows[r + E_X], y = rows[r + E_Y], z = rows[r + E_Z] + eyeOffset(ps);
    const pitch = dequantizePitch(rows[r + E_PITCH]), yaw = dequantizeYaw(rows[r + E_YAW]);
    angles[0] = pitch;
    angles[1] = yaw;
    if (this.mode === SPEC_EYES) {
      eye[0] = x;
      eye[1] = y;
      eye[2] = z;
      return;
    }
    // Chase: behind and a little above, pulled in by walls, looking along their view.
    const cp = Math.cos(pitch * Math.PI / 180), dx = -cp * Math.cos(yaw * Math.PI / 180);
    const dy = -cp * Math.sin(yaw * Math.PI / 180), dz = Math.sin(pitch * Math.PI / 180);
    const ex = x + dx * CHASE_DISTANCE, ey = y + dy * CHASE_DISTANCE, ez = z + dz * CHASE_DISTANCE + 12;
    const t = Math.max(0, clear(x, y, z, ex, ey, ez) - 0.1);
    eye[0] = x + (ex - x) * t;
    eye[1] = y + (ey - y) * t;
    eye[2] = z + (ez - z) * t;
  }

  // Rebuilds the target's weapon state at `time` (seconds, the view animation clock);
  // view: the WeaponView (muzzle flashes, knife swings). Call each frame.
  syncWeapon(rows, time, dt, view) {
    const r = this.target * E_FIELDS, f = this.ws.f;
    const id = rows[r + E_WEAPON], w = WEAPONS[id], anim = rows[r + E_ANIM], shots = rows[r + E_SHOTS];
    const switched = this.synced !== this.target; // someone else: their gun is already up
    if (switched) {
      this.synced = this.target;
      this.weapon = -1;
      this.px = NaN;
    }
    if (id !== this.weapon) {
      f.fill(0);
      this.weapon = id;
      this.shots = shots;
      if (w) {
        f[WS_ACTIVE] = w.slot;
        f[WS_SLOTS + w.slot * 3] = id;
        f[WS_SLOTS + w.slot * 3 + 1] = w.clip || 0; // ammo is not in snapshots: show a full gun
        f[WS_SLOTS + w.slot * 3 + 2] = w.reserve || 0;
        f[WS_DEPLOY_END] = switched ? 0 : time + w.deployTime;
      }
    }
    if (!w) return;
    if ((anim & ANIM_RELOAD) && !(this.anim & ANIM_RELOAD)) {
      f[WS_RELOAD_END] = time + (w.shellTime ? w.reloadStart + w.shellTime : w.reloadTime);
    } else if (!(anim & ANIM_RELOAD)) f[WS_RELOAD_END] = 0;
    else if (w.shellTime && time >= f[WS_RELOAD_END]) f[WS_RELOAD_END] += w.shellTime; // next shell
    if (shots !== this.shots) {
      f[WS_LAST_SHOT] = time;
      view.onTick(w.melee ? WEV_MELEE : WEV_FIRE, time);
      this.shots = shots;
    }
    f[WS_ALT] = anim & ANIM_SILENCED ? 1 << w.slot : 0;
    f[WS_ACTION] = anim & ANIM_PLANT ? ACTION_PLANT : anim & ANIM_DEFUSE ? ACTION_DEFUSE : 0;
    this.anim = anim;
    // Walk bob from their movement.
    const x = rows[r + E_X], y = rows[r + E_Y], ps = this.ps;
    if (!Number.isNaN(this.px) && dt > 0) {
      ps.f[PS_VEL] = (x - this.px) / dt;
      ps.f[PS_VEL + 1] = (y - this.py) / dt;
    }
    this.px = x;
    this.py = y;
    ps.f[PS_ORIGIN] = x;
    ps.f[PS_ORIGIN + 1] = y;
    ps.f[PS_ORIGIN + 2] = rows[r + E_Z];
    if (rows[r + E_FLAGS] & FL_DUCKING) ps.i[PS_FLAGS] |= FL_DUCKING;
  }
}
