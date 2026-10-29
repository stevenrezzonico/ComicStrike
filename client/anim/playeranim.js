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
    this.deathDir = new Float32Array(2); // die(): the shot's direction in the world
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
    this.deathDir[0] = this.deathDir[1] = 0;
    this.headshot = false;
    this.deathDist = 0;
    this.deathDrop = 0;
    this.deathSeed = 0;
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
    if (this.dead > 0) return this.headshot ? this.headshotPose(c, yaw) : this.collapsePose(c);

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
      const goal = p.goal;
      goal[0] = 2 * c + dirF * swing + (s ? -3 : 4) * this.air;
      goal[1] = SIDE[s] * (4.5 + c) + dirL * swing;
      goal[2] = 3.5 + lift + 9 * this.air;
      goal[3] = 1;
      goal[4] = SIDE[s] * 0.25;
      goal[5] = 0;
      p.reachGoal(HIP[s], KNEE[s], ANKLE[s]);
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
      const goal = p.goal;
      goal[0] = tx;
      goal[1] = ty;
      goal[2] = tz;
      goal[3] = -0.2;
      goal[4] = SIDE[s] * 0.6;
      goal[5] = -1;
      p.reachGoal(ARM[s], ELBOW[s], HAND[s]);
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

  // This player was killed: how. (dx, dy): the shot's direction in the world (unit; 0, 0
  // when nobody shot him), headshot: thrown back along it; dist: how far the body may fly
  // before a wall; drop: how far the floor where it lands lies below the feet; seed: picks
  // the collapse's side and fold. Without a call the death is a collapse.
  die(dx, dy, headshot, dist, drop, seed) {
    this.deathDir[0] = dx;
    this.deathDir[1] = dy;
    this.headshot = headshot;
    this.deathDist = dist;
    this.deathDrop = drop;
    this.deathSeed = seed;
  }

  // Points leg s, straight (knee unbent), from its hip at the goal, then solves it. The
  // solver bends the knee in the plane of the pole only when the limb already points
  // near its target: a leg carried round by the pelvis of a falling body otherwise bent
  // the knee into the ground. Call with world transforms current (after solve()).
  reachLeg(s) {
    const p = this.pose, g = p.goal, w = p.wpos, h = HIP[s];
    Q.identity(p.rot, KNEE[s] * 4);
    let dx = g[0] - w[h * 3], dy = g[1] - w[h * 3 + 1], dz = g[2] - w[h * 3 + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    // The straight leg lies along -z: turn it onto d about (0, 0, -1) x d.
    const al = Math.sqrt(dx * dx + dy * dy);
    if (al > 1e-4) Q.fromAxisAngle(tq, 0, dy / al, -dx / al, 0, Math.acos(Math.max(-1, Math.min(1, -dz))));
    else Q.identity(tq);
    p.setWorldRotation(h, tq, 0);
    p.reachGoal(h, KNEE[s], ANKLE[s]);
  }

  // The hands come off the gun and hang from the shoulders (world down), swinging a little,
  // never below the ground. Call after solve(). k: 0 still holding .. 1 hanging.
  hangArms(k, sway) {
    const p = this.pose, w = p.wpos, cx = w[SPINE3 * 3], cy = w[SPINE3 * 3 + 1], cz = w[SPINE3 * 3 + 2];
    for (let s = 0; s < 2; s++) {
      const sx = w[ARM[s] * 3], sy = w[ARM[s] * 3 + 1], sz = w[ARM[s] * 3 + 2];
      const hx = cx + 14, hy = cy + SIDE[s] * 4, hz = cz - 6; // about where the gun was held
      const goal = p.goal;
      goal[0] = hx + (sx + sway - hx) * k;
      goal[1] = hy + (sy + SIDE[s] * 2 - hy) * k;
      goal[2] = hz + (Math.max(3, sz - 23) - hz) * k;
      goal[3] = -1;
      goal[4] = SIDE[s] * 0.4;
      goal[5] = 0.3; // elbows back, a little up: never into the ground once lying
      p.reachGoal(ARM[s], ELBOW[s], HAND[s]);
    }
  }

  // A marionette with its strings cut, over ~1 s: the knees give and the hips drop
  // straight down, the spine folds and the head droops, the arms hang; then the folded
  // body topples to one side (the seed picks which, how far forward, and a twist) and
  // settles on the ground with a small bounce. Feet stay planted until it goes over.
  collapsePose(c) {
    const p = this.pose, t = this.dead, seed = this.deathSeed;
    const side = seed & 1 ? 1 : -1;
    const fwd = 0.4 + 0.5 * ((seed >> 1) & 3) / 3;
    const twist = (((seed >> 3) & 7) / 7 - 0.5) * 40;
    const buckle = ramp(t, 0, 0.35);
    const fold = ramp(t, 0.05, 0.5);
    const f = ramp(t, 0.3, 0.95);
    const settle = bump(t, 0.85, 0.98, 0.98, 1.15);
    const c0 = c * (1 - buckle);
    const hUp = PELVIS_Z - CROUCH_DROP * c0 - 24 * buckle;
    const px = -5 * c0 + 10 * fwd * f, py = side * 13 * f, pz = hUp + (7 - hUp) * f + 2.5 * settle;
    p.pos[PELVIS * 3] = px;
    p.pos[PELVIS * 3 + 1] = py;
    p.pos[PELVIS * 3 + 2] = pz;
    Q.fromEuler(tv, 0, 30 * fwd * f, twist * f, -side * 85 * f);
    for (let k = 0; k < 4; k++) p.rot[PELVIS * 4 + k] = tv[k];
    p.turn(SPINE1, 22 * fold, 0, 0);
    p.turn(SPINE2, 22 * fold, 0, 0);
    p.turn(SPINE3, 18 * fold, 0, 0);
    p.turn(NECK, 15 * fold, 0, 0);
    p.turn(HEAD, 25 * fold, side * 10 * f, 0);
    p.solve();
    for (let s = 0; s < 2; s++) {
      const goal = p.goal;
      const ax = 2 * c0 + 1 - 5 * buckle, ay = SIDE[s] * (4.5 + c0); // planted, the toes dragging back as he kneels
      const lx = px - 24 + 4 * fwd, ly = py + SIDE[s] * 5 + side * 3; // legs trailing behind, knees bent
      goal[0] = ax + (lx - ax) * f;
      goal[1] = ay + (ly - ay) * f;
      goal[2] = 3.5;
      // Knees forward and down to the ground (kneeling), then swinging out and round to
      // up as he goes over (never through the leg's own line: that popped the knee).
      goal[3] = 1 - f;
      goal[4] = SIDE[s] * (0.25 + 1.2 * Math.sin(Math.PI * f));
      goal[5] = Math.min(1, -0.1 + 4 * f);
      this.reachLeg(s);
      p.setWorldRotation(ANKLE[s], tv, 0); // soles with the body
    }
    this.hangArms(ramp(t, 0, 0.3), Math.sin(t * 10) * 6 * Math.exp(-2 * t));
    p.skinMatrices();
    return p;
  }

  // A headshot: the head snaps back and the body is thrown along the shot (deathDir, in
  // the world; dist units at most, decelerating over 0.5 s), tipping over onto its back,
  // legs kicked up and arms flung, then lands (drop lower where the floor is) and slides
  // to rest with the limbs flopping down. yaw: the player's, to take the shot into his frame.
  headshotPose(c, yaw) {
    const p = this.pose, t = this.dead;
    const yr = yaw * Math.PI / 180, cy = Math.cos(yr), sy = Math.sin(yr);
    let dx = this.deathDir[0] * cy + this.deathDir[1] * sy, dy = -this.deathDir[0] * sy + this.deathDir[1] * cy;
    if (dx * dx + dy * dy < 0.5) { // nobody known to have shot: backwards
      dx = -1;
      dy = 0;
    }
    const u = Math.min(1, t / 0.5), travel = 1 - (1 - u) * (1 - u);
    const tip = ramp(t, 0.02, 0.6);
    const land = ramp(t, 0.5, 0.8);
    const settle = bump(t, 0.6, 0.7, 0.7, 0.9);
    const R = this.deathDist * travel + 6 * tip;
    const h = PELVIS_Z - CROUCH_DROP * c;
    const px = dx * R, py = dy * R;
    const pz = h + (6 - h) * tip + 12 * Math.sin(Math.PI * u) * (1 - land) - this.deathDrop * land + 2 * settle;
    p.pos[PELVIS * 3] = px;
    p.pos[PELVIS * 3 + 1] = py;
    p.pos[PELVIS * 3 + 2] = pz;
    Q.fromAxisAngle(tv, 0, -dy, dx, 0, (85 * tip) * Math.PI / 180); // over about the axis across the shot
    for (let k = 0; k < 4; k++) p.rot[PELVIS * 4 + k] = tv[k];
    const arch = -6 * ramp(t, 0, 0.2) * (1 - land);
    p.turn(SPINE1, arch, 0, 0);
    p.turn(SPINE2, arch, 0, 0);
    p.turn(SPINE3, arch, 0, 0);
    p.turn(HEAD, -45 * bump(t, 0, 0.08, 0.1, 0.4) - 15 * ramp(t, 0, 0.2), 0, 0);
    p.solve();
    const lift = ramp(t, 0, 0.2), ex = -dy, ey = dx; // ex, ey: across the shot
    for (let s = 0; s < 2; s++) {
      const goal = p.goal;
      // Planted, then trailing behind and kicked up, then stretched out along the ground.
      const fx = px - dx * 8 + ex * SIDE[s] * 6, fy = py - dy * 8 + ey * SIDE[s] * 6;
      const gx = px - dx * 22 + ex * SIDE[s] * 5, gy = py - dy * 22 + ey * SIDE[s] * 5;
      let x = (fx) * lift, y = SIDE[s] * 4.5 + (fy - SIDE[s] * 4.5) * lift, z = 3.5 + (pz + 8 - 3.5) * lift;
      x += (gx - x) * land;
      y += (gy - y) * land;
      z += (4 - z) * land;
      goal[0] = x;
      goal[1] = y;
      goal[2] = z;
      goal[3] = 1 - land;
      goal[4] = SIDE[s] * 0.25 * (1 - land);
      goal[5] = land;
      this.reachLeg(s);
      p.setWorldRotation(ANKLE[s], tv, 0);
    }
    const w = p.wpos, cx = w[SPINE3 * 3], cyy = w[SPINE3 * 3 + 1], cz = w[SPINE3 * 3 + 2];
    for (let s = 0; s < 2; s++) {
      const goal = p.goal;
      // Holding the gun, then whipped out and up as the body goes, then flat on the ground.
      const hx = cx + 14, hy = cyy + SIDE[s] * 4, hz = cz - 6;
      const fx = cx - dx * 12 + ex * SIDE[s] * 14, fy = cyy - dy * 12 + ey * SIDE[s] * 14, fz = cz + 8;
      const gx = px + dx * 4 + ex * SIDE[s] * 20, gy = py + dy * 4 + ey * SIDE[s] * 20;
      let x = hx + (fx - hx) * lift, y = hy + (fy - hy) * lift, z = hz + (fz - hz) * lift;
      x += (gx - x) * land;
      y += (gy - y) * land;
      z += (3 - z) * land;
      goal[0] = x;
      goal[1] = y;
      goal[2] = z;
      goal[3] = -0.2 * (1 - land);
      goal[4] = SIDE[s] * 0.6 * (1 - land);
      goal[5] = -1 + 2 * land;
      p.reachGoal(ARM[s], ELBOW[s], HAND[s]);
    }
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
