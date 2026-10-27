// Third-person player animation, generated in code from what snapshots say about a
// player: position, view angles, duck amount, ground contact, weapon, ANIM_* bits and
// the shot counter. Feet follow a stride cycle whose phase advances with the distance
// travelled (no sliding); hips drop and the torso leans to fit the crouch hit boxes;
// the aim pitch bends spine and neck; hands reach per-hold grip points in the aim frame
// (two-bone solves) and the gun hand takes the aim rotation. Nothing allocates per frame.

import { Pose, PLAYER_SKELETON as S } from './skeleton.js';
import * as Q from './quat.js';
import { HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4, HOLD_TIED } from '../models/players.js';
import { WEAPONS, SLOT_SECONDARY, SLOT_KNIFE, SLOT_C4 } from '../../shared/weapons.js';
import { ANIM_RELOAD, ANIM_PLANT, ANIM_DEFUSE } from '../../shared/protocol.js';

const PELVIS = S.bone('pelvis'), SPINE1 = S.bone('spine_1'), SPINE2 = S.bone('spine_2'), SPINE3 = S.bone('spine_3');
const NECK = S.bone('neck_0'), HEAD = S.bone('head_0');
const ARM = [S.bone('arm_upper_L'), S.bone('arm_upper_R')], ELBOW = [S.bone('arm_lower_L'), S.bone('arm_lower_R')];
const HAND = [S.bone('hand_L'), S.bone('hand_R')];
const HIP = [S.bone('leg_upper_L'), S.bone('leg_upper_R')], KNEE = [S.bone('leg_lower_L'), S.bone('leg_lower_R')];
const ANKLE = [S.bone('ankle_L'), S.bone('ankle_R')];
const SIDE = [1, -1]; // +y is the left side

const PELVIS_Z = S.bind[PELVIS * 3 + 2];
const CROUCH_DROP = 22; // full duck: hips 16 units above the feet, head near the squashed head box
const CROUCH_LEAN = 55; // degrees forward at full duck
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
const RELOAD_HAND = { [HOLD_RIFLE]: [7, -2, -11], [HOLD_PISTOL]: [5, 2, -14] }; // left hand fetching a magazine

// Hands turn a quarter about z on top of the aim so their boxes point forward, like
// fingers around a grip: the right +90 degrees, the left -90. The palm is PALM ahead of
// the wrist; the gun's grip (its origin) sits in the right palm.
export const PALM = 1.6;
export const handTurn = [Q.fromAxisAngle(new Float32Array(4), 0, 0, 0, 1, -Math.PI / 2),
  Q.fromAxisAngle(new Float32Array(4), 0, 0, 0, 1, Math.PI / 2)];

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
    this.shots = -1;
    this.dead = 0; // seconds since death (0 = alive)
    this.time = 0;
  }

  // Advances by dt seconds and rebuilds the pose. (x, y, z): feet; yaw / pitch in degrees
  // (pitch down-positive); duck 0..1; support: the gun's off-hand point in its frame
  // (client/models/guns.js), or null for the hold's default.
  update(dt, x, y, z, yaw, pitch, duck, onGround, hold, anim, shots, alive, support = null) {
    this.time += dt;
    // Velocity from positions, smoothed; teleports (spawns) start over.
    if (Number.isNaN(this.px) || Math.hypot(x - this.px, y - this.py, z - this.pz) > 96) {
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
    this.air += ((onGround ? 0 : 1) - this.air) * (1 - Math.exp(-dt * 10));

    // Velocity in the player's frame, and the stride cycle.
    const yr = yaw * Math.PI / 180, cy = Math.cos(yr), sy = Math.sin(yr);
    const fwd = this.vx * cy + this.vy * sy, left = -this.vx * sy + this.vy * cy;
    const speed = Math.hypot(fwd, left);
    this.stride = Math.min(15, 4 + speed * 0.045) * (1 - 0.35 * duck);
    if (onGround) this.phase = (this.phase + speed * dt / (4 * this.stride)) % 1;
    const walk = smoothstep(10, 70, speed) * (1 - this.air);
    const dirF = speed > 1 ? fwd / speed : 1, dirL = speed > 1 ? left / speed : 0;

    const kneel = anim & (ANIM_PLANT | ANIM_DEFUSE) ? 1 : 0;
    const c = Math.max(duck, kneel);
    const p = this.pose.reset();
    if (this.dead > 0) return this.deathPose(c);

    // Hips: crouch drop, a little bob in the stride.
    const bob = Math.abs(Math.sin(this.phase * 2 * Math.PI)) * 1.2 * walk;
    p.pos[PELVIS * 3] = -5 * c;
    p.pos[PELVIS * 3 + 2] = PELVIS_Z - CROUCH_DROP * c - bob;

    // Spine: crouch lean, aim pitch (down-positive), rifle twist, fire kick; the head
    // keeps looking along the aim.
    const lean = CROUCH_LEAN * c;
    const aimP = Math.max(-80, Math.min(80, pitch));
    const twist = hold === HOLD_RIFLE ? -RIFLE_TWIST : 0;
    p.turn(SPINE1, lean * 0.5 + aimP * 0.15, twist, 0);
    p.turn(SPINE2, lean * 0.3 + aimP * 0.15, twist, 0);
    p.turn(SPINE3, lean * 0.2 + aimP * 0.15 - this.kick * 5, 0, 0);
    p.turn(NECK, -lean * 0.4 + aimP * 0.2, -twist, 0);
    p.turn(HEAD, -lean * 0.6 + aimP * 0.35 + this.kick * 5, -twist, 0);
    p.solve();

    // Legs: feet on the ground under the hips, cycling along the movement direction.
    for (let s = 0; s < 2; s++) {
      const ph = (this.phase + s * 0.5) * 2 * Math.PI;
      const swing = Math.cos(ph) * this.stride * walk;
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
      let [ox, oy, oz] = grip.hands[s];
      if (s === 0 && anim & ANIM_RELOAD && RELOAD_HAND[hold]) {
        [ox, oy, oz] = RELOAD_HAND[hold];
        oz += Math.sin(this.time * 7) * 1.2;
      } else if (s === 0 && support && grip.aimed) {
        // Off hand on the gun's support point: right wrist + palm offset + support, minus
        // the left palm offset (all along the aim frame).
        const [rx, ry, rz] = grip.hands[1];
        ox = rx + support[0];
        oy = ry + support[1];
        oz = rz + support[2];
      }
      ox -= this.kick * 2;
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
      Q.fromEuler(tv, 0, grip.aimed || kneel ? handP : 0, 0, 0);
      Q.mul(tq, 0, tv, 0, handTurn[s], 0);
      p.setWorldRotation(HAND[s], tq, 0);
    }
    p.skinMatrices();
    return p;
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
    p.rot.set(tv.subarray(0, 4), PELVIS * 4);
    for (let s = 0; s < 2; s++) p.turn(ARM[s], 0, 0, SIDE[s] * 30 * f);
    p.solve();
    p.skinMatrices();
    return p;
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
