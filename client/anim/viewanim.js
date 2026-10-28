// First-person animation (Phase 8f): the arms and the gun in front of the eye, generated
// in code every frame from the weapon state (shared/weapons.js): draw, idle, fire (slide,
// bolt and pump cycling), per-weapon reloads that move the magazine and bolt bones, shell
// by shell shotguns, knife slashes and stabs, inspecting, planting and defusing.
//
// Everything is in the rig frame: x forward from the eye, y left, z up (the viewmodel
// turns it into eye space). The gun is placed first (a rotation about its grip and a
// position); then each hand reaches its point on the gun with a two-bone arm solve and
// takes a rotation relative to the gun. Points on the gun come from client/models/guns.js
// (support, magazine, bolt or pump, loading port). Nothing allocates per frame.

import { Pose, ARMS_SKELETON as A, MAX_BONES } from './skeleton.js';
import * as Q from './quat.js';
import { HAND_GRIP, HAND_GRIP_IN, GRIP_CURL } from '../models/arms.js';
import { GUN_MAG, GUN_BOLT } from '../models/guns.js';
import {
  WEAPONS, SLOT_SECONDARY, SLOT_KNIFE, SLOT_C4, SLOT_GRENADE, WS_ACTIVE, WS_SLOTS, WS_RELOAD_END, WS_DEPLOY_END,
  WS_LAST_SHOT, WS_ACTION, WS_MODE_END, WS_THROW, WS_THROW_TIME, ACTION_PLANT, ACTION_DEFUSE, WEV_MELEE, WEV_MELEE2,
  SILENCER_TIME, THROW_DELAY, THROW_SHORT,
} from '../../shared/weapons.js';

const UPPER = [A.bone('arm_upper_L'), A.bone('arm_upper_R')];
const LOWER = [A.bone('arm_lower_L'), A.bone('arm_lower_R')];
const HAND = [A.bone('hand_L'), A.bone('hand_R')];
const L = 0, R = 1;
const SIDE = [1, -1]; // +y is left

const euler = (pitch, yaw, roll) => Q.fromEuler(new Float32Array(4), 0, pitch, yaw, roll);

// Hand rotations relative to the gun. A hand's bind pose points along +x with the palm
// facing in (+y for the right hand, -y for the left); roll -90 turns a left palm up.
const ROT = {
  grip: euler(15, 0, 0), // right hand around a pistol grip (raked back)
  knife: euler(62, 0, 0), // fist around the knife handle
  support: euler(0, -60, -90), // left palm up under a handguard, fingers across it
  mag: euler(-15, -15, -70), // left hand taking a magazine from below
  top: euler(0, -20, 90), // palm down on top (P90 magazine)
  boltL: euler(0, -70, 110), // left hand reaching over to the right side
  boltR: euler(0, 25, -95), // right hand on a bolt handle, palm down
  side: euler(0, 0, 0), // palm flat on a side (C4)
  tap: euler(35, 0, -95), // right hand over the C4 keypad
  rest: euler(-40, 0, -60), // the hidden left hand
  shield: euler(-90, 90, 0), // left hand up before the face, palm out, fingers up (flashed)
};

// Per hold: where the gun's grip sits in the rig frame and the gun's base angles; the
// shoulders (left, right).
const HOLDS = {
  rifle: { grip: [10.8, -6, -7.5], angles: [0, 0, 0], shoulders: [[-3, 1, -12.5], [-10, -9.5, -13]] },
  pistol: { grip: [14.9, -3.6, -5.2], angles: [0, 0, 0], shoulders: [[-6, 2, -13], [-7, -9.5, -13]] },
  knife: { grip: [13.4, -6.5, -6.5], angles: [-35, 6, 0], shoulders: [[-6, 6, -13], [-7, -9.5, -13]] },
  c4: { grip: [12, -3.5, -6], angles: [0, 0, 0], shoulders: [[-7, 5, -13], [-7, -7, -13]] },
  elite: { grip: [14.9, -6, -5.6], angles: [0, 2, 0], shoulders: [[-6, 7, -13], [-6, -7, -13]] },
  grenade: { grip: [13, -6.5, -6.8], angles: [0, 0, 0], shoulders: [[-6, 6, -13], [-7, -9.5, -13]] },
};
const ELITE_LEFT = 11; // the second pistol, left of the first
const REST_L = [6, 6, -30]; // the left hand out of sight (knife)
const SHIELD_L = [15, 2.5, -2.6]; // the left hand before the eyes (flashed)

const INSPECT_TIME = 3.2;
const SLASH_TIME = 0.35;
const STAB_TIME = 0.6;
const SHELL_END_TIME = 0.5; // tilting back (and pumping) after the last shell

function holdOf(w) {
  if (w.slot === SLOT_KNIFE) return 'knife';
  if (w.slot === SLOT_C4) return 'c4';
  if (w.slot === SLOT_GRENADE) return 'grenade';
  if (w.name === 'elite') return 'elite';
  return w.slot === SLOT_SECONDARY ? 'pistol' : 'rifle';
}

// Default hand points in the gun frame (constants: no array per frame).
const HAND_KNIFE = [0.4, 0, 0], HAND_C4_R = [3, -2.3, 0], HAND_C4_L = [3, 2.3, 0], HAND_GRENADE = [0, 0, -0.3];
const HAND_GUN = [-0.75, 0, -1.6];
// How far in from the palm's axis the off hand's point is: under a long gun's handguard,
// on a pistol's grip beside the shooting hand.
const SUPPORT_IN = 0.6, PISTOL_IN = 0.55;

// What each hand holds at rest with weapon `id` (pts: its buildGun points), in the gun
// frame: [left, right], each { at, dir, r, rx } (a part around the axis through `at`
// along `dir`, half-size r, rx across the hand where it differs, thumb: how the thumb
// lies, see client/models/arms.js) or null (a flat hand, or the hand off the gun). client/anim/handfit.js curls the fingers around them.
const GRIP_AXIS = [0.27, 0, 0.96]; // a raked pistol grip
export function heldParts(id, pts) {
  const hold = holdOf(WEAPONS[id]);
  if (hold === 'c4') return [null, null];
  const gr = pts.gripR || GRIP_CURL.r;
  const grip = { at: HAND_GUN, dir: GRIP_AXIS, r: gr, rx: GRIP_CURL.rx * Math.max(1, gr / GRIP_CURL.r) };
  const right = hold === 'grenade' ? { at: [0, 0, 0], dir: [0, 0, 1], r: pts.bodyR || 1 } :
    hold === 'knife' ? { at: HAND_KNIFE, dir: [1, 0, 0], r: 0.6 } : grip;
  if (hold === 'elite') return [grip, right];
  if (!pts.support || !pts.grasp) return [null, right];
  // A pistol's off hand wraps the grip with the shooting hand's fingers on it.
  if (hold === 'pistol') return [{ at: HAND_GUN, dir: GRIP_AXIS, r: pts.grasp[1], thumb: 'forward' }, right];
  const [x, y, z] = pts.support;
  const [up, half, upright, wide = half] = pts.grasp;
  return [{ at: [x, y, z + up], dir: upright ? [0, 0, 1] : [1, 0, 0], r: half, rx: wide }, right];
}

// 0..1 between a and b, eased.
export function ramp(t, a, b) {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

// Up over a..b, down over c..d.
export function bump(t, a, b, c, d) {
  return ramp(t, a, b) * (1 - ramp(t, c, d));
}

// Column-major rotation + translation from quaternion q (at qo).
function matrix(m, q, qo, tx, ty, tz) {
  const x = q[qo], y = q[qo + 1], z = q[qo + 2], w = q[qo + 3];
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w); m[3] = 0;
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w); m[7] = 0;
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
  return m;
}

const tv = new Float32Array(6);
const tq = new Float32Array(8);

export class ViewAnimator {
  constructor() {
    this.pose = new Pose(A);
    this.gun = new Float32Array(16); // gun frame -> rig frame
    this.gun2 = new Float32Array(16); // the left pistol (Dual Berettas)
    this.dual = false;
    this.flash2 = false; // the last shot came from the left pistol
    this.gunSkin = new Float32Array(MAX_BONES * 16); // GUN_ROOT, GUN_MAG, GUN_BOLT
    for (let i = 0; i < MAX_BONES; i++) for (let k = 0; k < 4; k++) this.gunSkin[i * 16 + k * 5] = 1;
    this.qGun = new Float32Array(4);
    this.qGun2 = new Float32Array(4);
    // Hand targets: a point in the gun frame, a rotation relative to the gun, how far the
    // point is in from the palm's axis, and an offset in the rig frame.
    this.hp = new Float32Array(6);
    this.hq = new Float32Array(8);
    this.hc = new Float32Array(2);
    this.ho = new Float32Array(6);
    this.onGun = [true, true]; // false: the hand's target is in the rig frame
    this.blind = 0; // 0..1: how flashed we are (the off hand shields the eyes)
    this.qTmp = new Float32Array(4);
    this.id = -1;
    this.inspectStart = -1;
    this.swingStart = -1;
    this.swingStab = false;
    this.swingDir = 1;
    this.shellEnd = -1;
    this.wasLoading = false;
  }

  // Per-tick weapon events (WS_EVENTS) at sim time `time`: knife swings.
  onEvents(events, time) {
    if (events & (WEV_MELEE | WEV_MELEE2)) {
      this.swingStart = time;
      this.swingStab = (events & WEV_MELEE2) !== 0;
      if (!this.swingStab) this.swingDir = -this.swingDir; // slashes alternate
    }
  }

  // +lookatweapon: starts inspecting when nothing else is going on.
  inspect(time) {
    if (this.inspectStart < 0 || time - this.inspectStart > INSPECT_TIME * 0.8) this.inspectStart = time;
  }

  setHand(s, p, q, inward) {
    this.hp[s * 3] = p[0];
    this.hp[s * 3 + 1] = p[1];
    this.hp[s * 3 + 2] = p[2];
    this.hq.set(q, s * 4);
    this.hc[s] = inward;
    this.onGun[s] = true;
  }

  // Moves hand s toward point (x, y, z) / rotation q / inward by t (0..1).
  mixHand(s, x, y, z, q, inward, t) {
    if (t <= 0) return;
    const o = s * 3;
    this.hp[o] += (x - this.hp[o]) * t;
    this.hp[o + 1] += (y - this.hp[o + 1]) * t;
    this.hp[o + 2] += (z - this.hp[o + 2]) * t;
    Q.nlerp(this.hq, s * 4, this.hq, s * 4, q, 0, t);
    this.hc[s] += (inward - this.hc[s]) * t;
  }

  // Rebuilds the gun matrices, gun skin and arm pose. pts: the gun's points (buildGun
  // without the mesh); time: interpolated sim seconds.
  update(id, ws, time, pts) {
    const f = ws.f, w = WEAPONS[id];
    if (id !== this.id) {
      this.id = id;
      this.inspectStart = this.swingStart = this.shellEnd = -1;
      this.wasLoading = false;
    }
    const holdName = holdOf(w), hold = HOLDS[holdName];
    let gx = hold.grip[0], gy = hold.grip[1], gz = hold.grip[2];
    let pitch = hold.angles[0], yaw = hold.angles[1], roll = hold.angles[2];
    let magOff = 0, boltOff = 0; // magazine out along magDir; bolt / slide / pump back
    this.ho.fill(0);
    this.dual = holdName === 'elite';

    // Default hands.
    if (holdName === 'knife') this.setHand(R, HAND_KNIFE, ROT.knife, HAND_GRIP_IN);
    else if (holdName === 'c4') this.setHand(R, HAND_C4_R, ROT.side, 0.55);
    else if (holdName === 'grenade') this.setHand(R, HAND_GRENADE, ROT.side, HAND_GRIP_IN);
    else this.setHand(R, HAND_GUN, ROT.grip, HAND_GRIP_IN);
    if (holdName === 'c4') this.setHand(L, HAND_C4_L, ROT.side, 0.55);
    else if (holdName === 'elite') this.setHand(L, HAND_GUN, ROT.grip, HAND_GRIP_IN);
    else if (pts.support && holdName === 'pistol') this.setHand(L, pts.support, ROT.grip, PISTOL_IN); // two-handed
    else if (pts.support) this.setHand(L, pts.support, ROT.support, SUPPORT_IN);
    else {
      this.setHand(L, REST_L, ROT.rest, 0);
      this.onGun[L] = false;
    }

    // Timers from the weapon state.
    const deployTime = w.deployTime, deployLeft = f[WS_DEPLOY_END] - time;
    const deploying = deployLeft > 0;
    const shot = f[WS_LAST_SHOT];
    const since = shot > 0 && shot >= f[WS_DEPLOY_END] - deployTime ? time - shot : Infinity;
    const reloadEnd = f[WS_RELOAD_END];
    const loading = reloadEnd > 0 && w.shellTime > 0;
    if (this.wasLoading && !loading && since > 0.2) this.shellEnd = time;
    this.wasLoading = loading;
    const busy = deploying || reloadEnd > 0 || since < 0.3 || f[WS_ACTION] !== 0 ||
      (this.swingStart >= 0 && time - this.swingStart < STAB_TIME);
    if (busy && this.inspectStart >= 0 && time > this.inspectStart) this.inspectStart = -1;
    const name = w.name;
    const pumpGun = pts.pump, boltAction = name === 'awp' || name === 'ssg08';

    // Draw: up from below, then rack the slide / bolt.
    if (deploying) {
      const d = Math.min(1, deployLeft / deployTime); // 1 -> 0
      const up = ramp(d, 0.3, 1);
      gz -= 13 * up;
      pitch += 40 * up;
      roll += 15 * up;
      if (holdName === 'knife') roll -= 360 * (1 - ramp(d, 0.25, 0.9)); // a flip into the hand
      const rack = 1 - Math.min(1, d / 0.3); // 0 -> 1 over the last 30 %
      if (pts.bolt && d < 0.3 && holdName !== 'elite') {
        boltOff += (pumpGun ? 2.5 : 1.3) * bump(rack, 0.3, 0.45, 0.55, 0.75);
        if (boltAction || pumpGun) roll -= 10 * bump(rack, 0, 0.3, 0.75, 1);
        else {
          const [bx, by, bz] = pts.bolt;
          this.mixHand(L, bx, by, bz, holdName === 'pistol' ? ROT.top : ROT.boltL, 0.6, bump(rack, 0, 0.3, 0.75, 1));
        }
      }
    }

    // Fire: kick, then the slide / bolt / pump cycles.
    if (since < 3) {
      const kick = Math.exp(-since * 16);
      const kicks2 = this.dual && (f[WS_SLOTS + f[WS_ACTIVE] * 3 + 1] & 1) === 1;
      this.flash2 = kicks2;
      if (!kicks2) {
        gx -= kick * (holdName === 'pistol' ? 1.2 : 1.6);
        pitch -= kick * (pumpGun || boltAction ? 7 : 4);
        gz += kick * 0.4;
      }
      const cycle = w.cycle;
      if (pumpGun) {
        const e = since / cycle;
        boltOff += 2.6 * bump(e, 0.25, 0.42, 0.5, 0.72);
        roll -= 6 * bump(e, 0.2, 0.4, 0.55, 0.8);
      } else if (boltAction) {
        const e = since / cycle, hand = bump(e, 0.15, 0.3, 0.72, 0.88);
        boltOff += 2.6 * bump(e, 0.33, 0.44, 0.55, 0.68);
        roll -= 12 * hand;
        pitch -= 3 * hand;
        const [bx, by, bz] = pts.bolt;
        this.mixHand(R, bx - boltOff, by, bz, ROT.boltR, 0.5, hand);
      } else if (pts.bolt) {
        boltOff += (holdName === 'pistol' || this.dual ? 1.1 : 1.0) * bump(since, 0, 0.012, 0.03, Math.min(0.08, cycle * 0.8));
      }
    }

    // Silencer: the off hand screws it on or off at the muzzle, the gun turned to it.
    if (f[WS_MODE_END] > 0 && pts.muzzle) {
      const r = 1 - (f[WS_MODE_END] - time) / SILENCER_TIME;
      const turn = bump(r, 0, 0.12, 0.88, 1), hand = bump(r, 0.08, 0.2, 0.8, 0.92);
      roll += 18 * turn;
      yaw += 14 * turn;
      pitch -= 6 * turn;
      gy += 2 * turn;
      const [mx, my, mz] = pts.muzzle;
      this.mixHand(L, mx - 2.5, my, mz, ROT.support, 0.8, hand);
      this.ho[L * 3 + 2] += 0.4 * Math.sin(time * 20) * hand; // twisting
    }

    // Grenades: the pin comes out, the arm draws back (overhand, or low for a lob), then
    // swings through on the release.
    if (holdName === 'grenade' && f[WS_THROW]) {
      const lob = f[WS_THROW] === THROW_SHORT;
      const swing = f[WS_THROW_TIME] > 0 ? 1 - Math.max(0, f[WS_THROW_TIME] - time) / THROW_DELAY : 0;
      const back = 1 - swing;
      if (lob) {
        gz -= 5 * back - 2 * swing;
        pitch += 25 * back - 20 * swing;
      } else {
        gx -= 5 * back - 6 * swing;
        gz += 4 * back - 1 * swing;
        gy -= 1.5 * back;
        pitch -= 30 * back - 25 * swing;
      }
    }

    // Reload.
    if (reloadEnd > 0 && !w.shellTime) {
      const r = 1 - (reloadEnd - time) / w.reloadTime; // 0 -> 1
      const tilt = bump(r, 0, 0.12, 0.84, 1);
      const pistol = holdName === 'pistol' || this.dual;
      roll += (pistol ? 28 : 22) * tilt;
      pitch -= (pistol ? 14 : 8) * tilt;
      gy += 2 * tilt;
      gz += 1.5 * tilt;
      const take = bump(r, 0.08, 0.2, 0.62, 0.7); // the hand on the magazine
      const out = r < 0.45 ? ramp(r, 0.2, 0.42) : 1 - ramp(r, 0.48, 0.64);
      const dist = pts.magDir && pts.magDir[2] > 0 ? 9 : 16;
      if (pts.mag) magOff = dist * out * out;
      gz += 0.6 * bump(r, 0.62, 0.64, 0.64, 0.72); // seating it
      if (this.dual) gz -= 5 * tilt;
      else if (pts.mag) {
        const [mx, my, mz] = pts.mag, [dx, dy, dz] = pts.magDir;
        this.mixHand(L, mx + dx * magOff, my + dy * magOff, mz + dz * magOff, dz > 0 ? ROT.top : ROT.mag, 0.7, take);
        this.ho[L * 3 + 2] -= 5 * bump(r, 0.4, 0.46, 0.46, 0.55); // down for the new one
      } else if (pts.cylinder) { // revolver: rounds into the swung-out cylinder
        const [cx, cy, cz] = pts.cylinder;
        this.mixHand(L, cx, cy + 1, cz, ROT.mag, 0.7, take);
        this.ho[L * 3 + 2] -= 14 * bump(r, 0.28, 0.38, 0.48, 0.58);
        roll += 15 * tilt;
      }
      if (pts.bolt && !this.dual) { // bolt / slide release
        const [bx, by, bz] = pts.bolt;
        this.mixHand(L, bx, by, bz, pistol ? ROT.top : ROT.boltL, 0.6, bump(r, 0.68, 0.74, 0.82, 0.9));
        boltOff += (pistol ? 1.1 : 1.6) * bump(r, 0.75, 0.78, 0.79, 0.83);
      }
    }

    // Shell by shell: tip the gun, then the hand fetches each shell into the port.
    const tip = loading ? 1 : this.shellEnd >= 0 ? 1 - ramp(time - this.shellEnd, 0, SHELL_END_TIME * 0.7) : 0;
    if (loading || tip > 0) {
      let tilt = tip;
      const left = reloadEnd - time;
      if (loading && left > w.shellTime) tilt = ramp(1 - (left - w.shellTime) / w.reloadStart, 0, 1);
      roll -= 32 * tilt;
      pitch -= 6 * tilt;
      gy += 1.5 * tilt;
      gz += 1.5 * tilt;
      const [px, py, pz] = pts.port;
      this.mixHand(L, px, py, pz - 0.6, ROT.support, 0.6, tilt);
      if (loading && left <= w.shellTime) {
        const s = 1 - left / w.shellTime;
        this.ho[L * 3 + 2] -= 9 * bump(s, 0.05, 0.38, 0.5, 0.9);
        this.ho[L * 3] -= 2 * bump(s, 0.05, 0.38, 0.5, 0.9);
      }
      if (!loading && pumpGun) boltOff += 2.6 * bump(time - this.shellEnd, 0.12, 0.22, 0.28, 0.42);
    }

    // Knife: slashes sweep across, alternating; stabs thrust.
    if (holdName === 'knife' && this.swingStart >= 0) {
      const t = (time - this.swingStart) / (this.swingStab ? STAB_TIME : SLASH_TIME);
      if (t >= 0 && t < 1) {
        if (this.swingStab) {
          const e = bump(t, 0.1, 0.35, 0.55, 0.95);
          gx += 9 * e;
          gy += 3 * e;
          pitch += 30 * e;
          gz += 1 * e;
        } else {
          const e = bump(t, 0, 0.15, 0.7, 1), dir = this.swingDir;
          yaw += dir * (35 - 70 * ramp(t, 0.05, 0.75)) * e;
          roll += dir * 35 * e;
          pitch += 25 * e;
          gx += 3 * e;
          gy += 4 * e;
        }
      }
    }

    // Inspect.
    if (this.inspectStart >= 0) {
      const t = (time - this.inspectStart) / INSPECT_TIME;
      if (t >= 1) this.inspectStart = -1;
      else if (t >= 0) {
        const a = bump(t, 0.04, 0.22, 0.44, 0.56), b = bump(t, 0.5, 0.64, 0.84, 0.98);
        roll -= 50 * a - 30 * b;
        yaw += 12 * a + 8 * b;
        pitch += -10 * a + 15 * b;
        gy += 3 * a + 2 * b;
        gz += 2.5 * a + 1 * b;
        gx -= 2 * a;
        if (holdName === 'knife') roll -= 360 * ramp(t, 0.3, 0.52);
      }
    }

    // The bomb: planting taps the keypad; defusing takes the hands out of sight.
    const action = f[WS_ACTION];
    if (action === ACTION_PLANT) {
      pitch -= 25;
      gz += 1;
      gy += 1.5;
      this.mixHand(R, 3.6, 0.6, 1.9, ROT.tap, 0.6, 1);
      this.ho[R * 3 + 2] += 0.7 * Math.abs(Math.sin(time * 16));
    } else if (action === ACTION_DEFUSE) {
      gz -= 18;
      pitch += 30;
    }

    // Gun matrices and bones.
    const qg = this.qGun;
    Q.fromEuler(qg, 0, pitch, yaw, roll);
    matrix(this.gun, qg, 0, gx, gy, gz);
    if (this.dual) {
      Q.fromEuler(this.qGun2, 0, pitch, -yaw, -roll); // mirrored
      const kick2 = this.flash2 && since < 3 ? Math.exp(-since * 16) : 0;
      matrix(this.gun2, this.qGun2, 0, gx - kick2 * 1.2, gy + ELITE_LEFT - 2 * (gy - hold.grip[1]), gz + kick2 * 0.4);
    }
    const s = this.gunSkin, md = pts.magDir;
    s[GUN_MAG * 16 + 12] = md ? md[0] * magOff : 0;
    s[GUN_MAG * 16 + 13] = md ? md[1] * magOff : 0;
    s[GUN_MAG * 16 + 14] = md ? md[2] * magOff : 0;
    s[GUN_BOLT * 16 + 12] = -boltOff;
    if (pumpGun && this.onGun[L] && pts.support && holdName === 'rifle') this.hp[L * 3] -= boltOff * (1 - tip);

    // Flashed: the off hand comes up before the face (not while it holds a second pistol).
    if (this.blind > 0.01 && !this.dual) this.shield(this.blind);

    this.solveArms(hold);
    return this;
  }

  // Moves the off hand toward shielding the eyes by `amount` (0..1, eased): its target goes
  // to the rig frame where it is now, then blends to the shield pose.
  shield(amount) {
    const o = L * 3, t = amount * amount * (3 - 2 * amount);
    if (this.onGun[L]) {
      const g = this.gun, x = this.hp[o], y = this.hp[o + 1], z = this.hp[o + 2];
      this.hp[o] = g[0] * x + g[4] * y + g[8] * z + g[12];
      this.hp[o + 1] = g[1] * x + g[5] * y + g[9] * z + g[13];
      this.hp[o + 2] = g[2] * x + g[6] * y + g[10] * z + g[14];
      Q.mul(this.qTmp, 0, this.qGun, 0, this.hq, L * 4);
      this.hq.set(this.qTmp, L * 4);
      this.onGun[L] = false;
    }
    this.mixHand(L, SHIELD_L[0], SHIELD_L[1], SHIELD_L[2], ROT.shield, 0, t);
  }

  // Both arms to their hand targets.
  solveArms(hold) {
    const p = this.pose.reset();
    for (let s = 0; s < 2; s++) p.pos.set(hold.shoulders[s], UPPER[s] * 3);
    p.solve();
    const g = this.gun;
    for (let s = 1; s >= 0; s--) {
      const o = s * 3;
      let x = this.hp[o], y = this.hp[o + 1], z = this.hp[o + 2];
      // Hand rotation: the gun's, then the hand's relative one (a hand off the gun only
      // keeps its own); the target is the held point, so the wrist goes back by the
      // grip offset along the hand and out by the inward offset.
      const second = this.dual && s === L;
      const gm = second ? this.gun2 : g;
      if (this.onGun[s]) {
        const px = x, py = y, pz = z;
        x = gm[0] * px + gm[4] * py + gm[8] * pz + gm[12];
        y = gm[1] * px + gm[5] * py + gm[9] * pz + gm[13];
        z = gm[2] * px + gm[6] * py + gm[10] * pz + gm[14];
        Q.mul(tq, 0, second ? this.qGun2 : this.qGun, 0, this.hq, s * 4);
      } else for (let c = 0; c < 4; c++) tq[c] = this.hq[s * 4 + c];
      x += this.ho[o];
      y += this.ho[o + 1];
      z += this.ho[o + 2];
      tv[0] = HAND_GRIP;
      tv[1] = SIDE[s] * -this.hc[s];
      tv[2] = 0;
      Q.rotate(tv, 3, tq, 0, tv, 0);
      p.reach(UPPER[s], LOWER[s], HAND[s], x - tv[3], y - tv[4], z - tv[5], 0, SIDE[s] * 0.7, -1);
      p.setWorldRotation(HAND[s], tq, 0);
    }
    p.skinMatrices();
  }
}
