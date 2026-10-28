// Third-person player animation, generated in code from what snapshots say about a
// player: position, view angles, duck amount, ground contact, weapon, ANIM_* bits and
// the shot counter. Feet follow a stride cycle whose phase advances with the distance
// travelled (a step every 2 x STEP_SCALE half-strides: a little foot slide buys a calmer
// cadence than the short legs allow); hips drop and the torso leans to fit the crouch hit boxes;
// the aim pitch bends spine and neck; hands reach per-hold grip points in the aim frame
// (two-bone solves) and the gun hand takes the aim rotation. Reloads follow the first-
// person timeline (client/anim/viewanim.js) from when the reload bit came on: the gun
// tilts, the off hand pulls the magazine out along its bone and seats a new one, racks
// the bolt or slide; shotguns load shell by shell at the port; the revolver's cylinder.
// The gun's bones move with it (magOff, boltOff). Nothing allocates per frame.

import { Pose, PLAYER_SKELETON as S } from './skeleton.js';
import * as Q from './quat.js';
import { HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4, HOLD_TIED } from '../models/players.js';
import { WEAPONS, SLOT_SECONDARY, SLOT_KNIFE, SLOT_C4 } from '../../shared/weapons.js';
import { ANIM_RELOAD, ANIM_PLANT, ANIM_DEFUSE } from '../../shared/protocol.js';
import { ramp, bump } from './viewanim.js';

const PELVIS = S.bone('pelvis'), SPINE1 = S.bone('spine_1'), SPINE2 = S.bone('spine_2'), SPINE3 = S.bone('spine_3');
const NECK = S.bone('neck_0'), HEAD = S.bone('head_0');
const ARM = [S.bone('arm_upper_L'), S.bone('arm_upper_R')], ELBOW = [S.bone('arm_lower_L'), S.bone('arm_lower_R')];
const HAND = [S.bone('hand_L'), S.bone('hand_R')], HAND_R = HAND[1];
const HIP = [S.bone('leg_upper_L'), S.bone('leg_upper_R')], KNEE = [S.bone('leg_lower_L'), S.bone('leg_lower_R')];
const ANKLE = [S.bone('ankle_L'), S.bone('ankle_R')];
const SIDE = [1, -1]; // +y is the left side

const PELVIS_Z = S.bind[PELVIS * 3 + 2];
const CROUCH_DROP = 22; // full duck: hips 16 units above the feet, head near the squashed head box
const CROUCH_LEAN = 55; // degrees forward at full duck
const LEG = 32.4; // hip to ankle when reaching, a little short of the 33 of the bones
const STEP_SCALE = 1.5; // distance per step over the swing: 60 units a step when running (~4/s)
const TOSS_RATE = 2.5; // a throw's arm swing lasts 1 / this seconds
const RIFLE_TWIST = 12; // per spine bone: left shoulder forward for a rifle stance

// Hand targets per hold, relative to the shoulder-line center (spine_3), in the aim frame
// (x along the aim, z up) when `aimed`, else in the body frame: [left xyz, right xyz].
const GRIPS = {
  [HOLD_RIFLE]: { aimed: true, hands: [[20, -1.5, -4.5], [8.5, -4.5, -6]] },
  [HOLD_PISTOL]: { aimed: true, hands: [[16, -0.6, -6], [17, -1.4, -4.6]] },
  [HOLD_KNIFE]: { aimed: false, hands: [[1, 9.5, -21], [12, -6.5, -10]] },
  [HOLD_C4]: { aimed: false, hands: [[11, 3, -13], [11, -2.5, -12.5]] },
  [HOLD_TIED]: { aimed: false, hands: [[-7, 2.5, -24], [-7, -2.5, -24]] },
};
const RELOAD_HAND = { [HOLD_RIFLE]: [7, -2, -11], [HOLD_PISTOL]: [5, 2, -14] }; // guns without a magazine point

// Hands turn a quarter about z on top of the aim so their boxes point forward, like
// fingers around a grip: the right +90 degrees, the left -90. The palm is PALM ahead of
// the wrist; the gun's grip (its origin) sits in the right palm.
export const PALM = 1.6;
export const handTurn = [Q.fromAxisAngle(new Float32Array(4), 0, 0, 0, 1, -Math.PI / 2),
  Q.fromAxisAngle(new Float32Array(4), 0, 0, 0, 1, Math.PI / 2)];

// The gun's matrix in the model frame (column-major, into `m`): in the right palm with
// the hand's rotation minus its quarter turn. q: scratch Float32Array(8).
export function gunInHand(pose, m, q) {
  const h = HAND_R;
  Q.conj(q, 4, handTurn[1], 0);
  Q.mul(q, 0, pose.wrot, h * 4, q, 4);
  const x = q[0], y = q[1], z = q[2], w = q[3];
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w); m[3] = 0;
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w); m[7] = 0;
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
  m[12] = pose.wpos[h * 3] + m[0] * PALM;
  m[13] = pose.wpos[h * 3 + 1] + m[1] * PALM;
  m[14] = pose.wpos[h * 3 + 2] + m[2] * PALM;
  m[15] = 1;
  return m;
}

export function holdOf(weaponId) {
  const w = WEAPONS[weaponId];
  if (!w || w.slot === SLOT_KNIFE || w.grenade) return HOLD_KNIFE; // one hand
  if (w.slot === SLOT_C4) return HOLD_C4;
  return w.slot === SLOT_SECONDARY ? HOLD_PISTOL : HOLD_RIFLE;
}

const tq = new Float32Array(4);
const tv = new Float32Array(6);

export class PlayerAnimator {
  constructor() {
    this.pose = new Pose(S);
    this.reload = { take: 0, roll: 0, drop: 0, x: 0, y: 0, z: 0 }; // reloadPose's result
    this.reset();
  }

  reset() {
    this.px = NaN; // last feet position
    this.py = 0;
    this.pz = 0;
    this.vx = 0; // smoothed velocity
    this.vy = 0;
    this.phase = 0; // stride cycle, in cycles
    this.stride = 4; // current half-stride length
    this.air = 0; // 0 grounded .. 1 airborne
    this.kick = 0; // fire kick, 1 at a shot
    this.toss = 0; // a weapon throw (G), 1 when it leaves the hand, down to 0
    this.shots = -1;
    this.dead = 0; // seconds since death (0 = alive)
    this.time = 0;
    this.reloadStart = -1; // time the reload bit came on (-1: not reloading)
    this.magOff = 0; // the gun's bones this frame: magazine out along magDir, bolt back
    this.boltOff = 0;
  }

  // A weapon left this player's hand (G): the arm swings it forward.
  throwArm() {
    this.toss = 1;
  }

  // Advances by dt seconds and rebuilds the pose. (x, y, z): feet; yaw / pitch in degrees
  // (pitch down-positive); duck 0..1; pts: the gun's points in its frame (buildGun:
  // support, mag / magDir, bolt, port, cylinder), or null for the hold's defaults;
  // weapon: its id (reload timing).
  update(dt, x, y, z, yaw, pitch, duck, onGround, hold, anim, shots, alive, pts = null, weapon = 0) {
    this.time += dt;
    // Velocity from positions, smoothed; teleports (spawns) start over.
    const jx = x - this.px, jy = y - this.py, jz = z - this.pz;
    if (Number.isNaN(this.px) || jx * jx + jy * jy + jz * jz > 96 * 96) {
      this.vx = this.vy = 0;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-dt * 12);
      this.vx += ((x - this.px) / dt - this.vx) * k;
      this.vy += ((y - this.py) / dt - this.vy) * k;
    }
    this.px = x;
    this.py = y;
    this.pz = z;
    if (!alive) this.dead += dt;
    else this.dead = 0;
    if (this.shots >= 0 && shots !== this.shots) this.kick = 1;
    this.shots = shots;
    this.kick = Math.max(0, this.kick - dt * 7);
    this.toss = Math.max(0, this.toss - dt * TOSS_RATE);
    this.air += ((onGround ? 0 : 1) - this.air) * (1 - Math.exp(-dt * 10));

    // Velocity in the player's frame, and the stride cycle.
    const yr = yaw * Math.PI / 180, cy = Math.cos(yr), sy = Math.sin(yr);
    const fwd = this.vx * cy + this.vy * sy, left = -this.vx * sy + this.vy * cy;
    const speed = Math.sqrt(fwd * fwd + left * left);
    this.stride = Math.min(20, 5 + speed * 0.06) * (1 - 0.35 * duck);
    if (onGround) this.phase = (this.phase + speed * dt / (4 * this.stride * STEP_SCALE)) % 1;
    const walk = smoothstep(10, 70, speed) * (1 - this.air);
    const dirF = speed > 1 ? fwd / speed : 1, dirL = speed > 1 ? left / speed : 0;

    const kneel = anim & (ANIM_PLANT | ANIM_DEFUSE) ? 1 : 0;
    const c = Math.max(duck, kneel);
    const support = pts ? pts.support : null;
    const reload = this.reloadPose(anim, hold, pts, weapon);
    const p = this.pose.reset();
    if (this.dead > 0) return this.deathPose(c);

    // Hips: crouch drop; standing, they sink when the feet are apart so both reach the
    // ground (lowest with both feet down, highest passing over the planted foot).
    const sw = this.stride * walk, spread = Math.cos(this.phase * 2 * Math.PI);
    const bob = (33 - Math.sqrt(LEG * LEG - sw * sw)) * spread * spread * (1 - c);
    p.pos[PELVIS * 3] = -5 * c;
    p.pos[PELVIS * 3 + 2] = PELVIS_Z - CROUCH_DROP * c - bob;

    // Spine: crouch lean, aim pitch (down-positive), rifle twist, fire kick; the head
    // keeps looking along the aim.
    const lean = CROUCH_LEAN * c;
    const aimP = Math.max(-80, Math.min(80, pitch));
    const twist = hold === HOLD_RIFLE ? -RIFLE_TWIST : 0;
    p.turn(SPINE1, lean * 0.5 + aimP * 0.15, twist, 0);
    p.turn(SPINE2, lean * 0.3 + aimP * 0.15, twist, 0);
    const swing = this.toss > 0 ? Math.sin(Math.PI * this.toss) : 0; // the throw's arm swing, out and back
    p.turn(SPINE3, lean * 0.2 + aimP * 0.15 - this.kick * 5 + swing * 6, swing * 10, 0);
    p.turn(NECK, -lean * 0.4 + aimP * 0.2, -twist, 0);
    p.turn(HEAD, -lean * 0.6 + aimP * 0.35 + this.kick * 5, -twist, 0);
    p.solve();

    // Legs: feet on the ground under the hips, cycling along the movement direction. A foot
    // is lifted while sin(ph) > 0 and swings from behind to ahead meanwhile (-cos), then
    // stays planted while the body passes over it (the other way round was a moonwalk).
    for (let s = 0; s < 2; s++) {
      const ph = (this.phase + s * 0.5) * 2 * Math.PI;
      const swing = -Math.cos(ph) * this.stride * walk;
      const lift = Math.max(0, Math.sin(ph)) * (2 + this.stride * 0.35) * walk;
      const tx = 2 * c + dirF * swing + (s ? -3 : 4) * this.air;
      const ty = SIDE[s] * (4.5 + c) + dirL * swing;
      const tz = 3.5 + lift + 9 * this.air;
      p.reach(HIP[s], KNEE[s], ANKLE[s], tx, ty, tz, 1, SIDE[s] * 0.25, 0);
      p.setWorldRotation(ANKLE[s], Q.identity(tq), 0); // soles flat
    }

    // Arms: grip points around the shoulder line, in the aim frame for guns.
    const grip = GRIPS[hold] || GRIPS[HOLD_KNIFE];
    const w = p.wpos, cx = w[SPINE3 * 3], cyy = w[SPINE3 * 3 + 1], cz = w[SPINE3 * 3 + 2];
    const handP = grip.aimed ? aimP : 25;
    const hr = handP * Math.PI / 180, ch = Math.cos(hr), sh = Math.sin(hr);
    for (let s = 1; s >= 0; s--) { // the gun hand first: the off hand follows the gun
      const hand = grip.hands[s];
      let ox = hand[0], oy = hand[1], oz = hand[2];
      if (s === 0 && grip.aimed && (support || reload.take > 0)) {
        // Off hand on a point of the gun (its support, or what the reload reaches for):
        // the right wrist plus the point turned by the gun's reload roll (aim frame).
        const rh = grip.hands[1], rx = rh[0], ry = rh[1], rz = rh[2];
        const k = reload.take, sx = support ? support[0] : ox - rx, sy = support ? support[1] : oy - ry;
        const sz = support ? support[2] : oz - rz;
        const gx = sx + (reload.x - sx) * k, gy = sy + (reload.y - sy) * k, gz = sz + (reload.z - sz) * k;
        const cr = Math.cos(reload.roll * Math.PI / 180), sr = Math.sin(reload.roll * Math.PI / 180);
        ox = rx + gx;
        oy = ry + gy * cr - gz * sr;
        oz = rz + gy * sr + gz * cr + reload.drop;
      } else if (s === 0 && anim & ANIM_RELOAD && RELOAD_HAND[hold]) {
        const rl = RELOAD_HAND[hold];
        ox = rl[0];
        oy = rl[1];
        oz = rl[2];
        oz += Math.sin(this.time * 7) * 1.2;
      }
      ox -= this.kick * 2;
      if (s === 1) { // throwing: the gun hand swings forward and up
        ox += swing * 9;
        oz += swing * 7;
      }
      let tx, ty, tz;
      if (kneel) { // planting / defusing: hands down in front of the knees
        tx = 15;
        ty = SIDE[s] * 3;
        tz = 9;
      } else if (grip.aimed) { // pitch the offset about y (down-positive)
        tx = cx + ox * ch + oz * sh;
        ty = cyy + oy;
        tz = cz - ox * sh + oz * ch;
      } else {
        tx = cx + ox;
        ty = cyy + oy;
        tz = cz + oz;
      }
      p.reach(ARM[s], ELBOW[s], HAND[s], tx, ty, tz, -0.2, SIDE[s] * 0.6, -1);
      Q.fromEuler(tv, 0, grip.aimed || kneel ? handP : 0, 0, s === 1 && grip.aimed ? reload.roll : 0);
      Q.mul(tq, 0, tv, 0, handTurn[s], 0);
      p.setWorldRotation(HAND[s], tq, 0);
    }
    p.skinMatrices();
    return p;
  }

  // Where a reload has the gun and the off hand now (first person's timeline, smaller):
  // the gun's roll (degrees), the hand's target in the gun frame and how much it goes
  // there (take), a drop of the hand below it; sets magOff / boltOff.
  reloadPose(anim, hold, pts, weapon) {
    const R = this.reload;
    R.take = R.roll = R.drop = 0;
    this.magOff = this.boltOff = 0;
    const w = WEAPONS[weapon];
    if (!(anim & ANIM_RELOAD) || !w || !w.gun || !pts || (hold !== HOLD_RIFLE && hold !== HOLD_PISTOL)) {
      this.reloadStart = -1;
      return R;
    }
    if (this.reloadStart < 0) this.reloadStart = this.time;
    const t = this.time - this.reloadStart, pistol = hold === HOLD_PISTOL;
    if (w.shellTime && pts.port) { // tip the gun, the hand fetches each shell into the port
      const tilt = ramp(t, 0, w.reloadStart);
      R.roll = -25 * tilt;
      setPoint(R, pts.port);
      R.take = tilt;
      if (t > w.reloadStart) R.drop = -7 * bump(((t - w.reloadStart) / w.shellTime) % 1, 0.05, 0.38, 0.5, 0.9);
      return R;
    }
    const r = Math.min(1, t / w.reloadTime);
    R.roll = (pistol ? 22 : 18) * bump(r, 0, 0.12, 0.84, 1);
    const out = r < 0.45 ? ramp(r, 0.2, 0.42) : 1 - ramp(r, 0.48, 0.64);
    if (pts.mag) {
      const md = pts.magDir, dist = md[2] > 0 ? 9 : 16;
      this.magOff = dist * out * out;
      R.x = pts.mag[0] + md[0] * this.magOff;
      R.y = pts.mag[1] + md[1] * this.magOff;
      R.z = pts.mag[2] + md[2] * this.magOff;
      R.take = bump(r, 0.08, 0.2, 0.62, 0.7);
      R.drop = -5 * bump(r, 0.4, 0.46, 0.46, 0.55); // down for the new one
    } else if (pts.cylinder) { // revolver: rounds into the swung-out cylinder
      setPoint(R, pts.cylinder);
      R.take = bump(r, 0.08, 0.2, 0.62, 0.7);
      R.drop = -10 * bump(r, 0.28, 0.38, 0.48, 0.58);
    }
    if (pts.bolt) { // bolt / slide release
      const b = bump(r, 0.68, 0.74, 0.82, 0.9);
      if (b > R.take) {
        setPoint(R, pts.bolt);
        R.take = b;
        R.drop = 0;
      }
      this.boltOff = (pistol ? 1.1 : 1.6) * bump(r, 0.75, 0.78, 0.79, 0.83);
    }
    return R;
  }

  // Falls backward like a plank about the feet over 0.7 s, arms flung up.
  deathPose(c) {
    const p = this.pose;
    const f = smoothstep(0, 0.7, this.dead);
    const a = (-88 * f) * Math.PI / 180;
    const pz = PELVIS_Z - CROUCH_DROP * c * (1 - f);
    p.pos[PELVIS * 3] = Math.sin(a) * pz;
    p.pos[PELVIS * 3 + 2] = Math.cos(a) * pz + 3 * f;
    Q.fromEuler(tv, 0, -88 * f, 0, 0);
    for (let k = 0; k < 4; k++) p.rot[PELVIS * 4 + k] = tv[k];
    for (let s = 0; s < 2; s++) p.turn(ARM[s], 0, 0, SIDE[s] * 30 * f);
    p.solve();
    p.skinMatrices();
    return p;
  }
}

// R.x / y / z = v (no destructuring: an iterator per call in unoptimized code).
function setPoint(R, v) {
  R.x = v[0];
  R.y = v[1];
  R.z = v[2];
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
