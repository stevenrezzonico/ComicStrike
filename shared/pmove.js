// CS:GO player movement on GoldSrc clip hulls.
// Follows Source's CGameMovement::FullWalkMove ordering with CS:GO's constants and
// CS:GO-specific rules (acceleration scale, air wishspeed cap, stamina, duck speed).
// Runs identically on client (prediction) and server (authority): all state lives in
// a PlayerState buffer that is rounded to float32 at the end of every tick.

import {
  IN_JUMP, IN_DUCK, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED,
} from './constants.js';
import { CONTENTS_EMPTY, CONTENTS_WATER, CONTENTS_SLIME } from './bsp.js';
import {
  Trace, tracePlayerA, traceEntity, entityContents, pointContents, hullFits,
  HULL_STAND, HULL_DUCK, HULL_POINT, HULL_MINS, HULL_MAXS, ENT_LADDER, ENT_BODY_BASE, BODY_FIELDS,
} from './trace.js';

// Tunables (CS:GO convar defaults where they exist).
export const MOVE = {
  gravity: 800, // sv_gravity
  friction: 5.2, // sv_friction
  stopspeed: 80, // sv_stopspeed
  accelerate: 5.5, // sv_accelerate
  airaccelerate: 12, // sv_airaccelerate
  airMaxWishspeed: 30, // sv_air_max_wishspeed
  jumpImpulse: 301.993377, // sv_jump_impulse
  stepsize: 18, // sv_stepsize
  maxVelocity: 3500, // sv_maxvelocity
  forwardSpeed: 450, // cl_forwardspeed / cl_sidespeed
  walkModifier: 0.52, // CS_PLAYER_SPEED_WALK_MODIFIER
  duckModifier: 0.34, // CS_PLAYER_SPEED_DUCK_MODIFIER
  ladderSpeed: 200, // MAX_CLIMB_SPEED
  ladderJumpSpeed: 270,
  ladderDetachTime: 0.2,
  waterSinkSpeed: 60,
  waterJumpSpeed: 100, // jump held in water swims up at this (HL's PM_Jump; slime 80, lava 50)
  slimeJumpSpeed: 80,
  lavaJumpSpeed: 50,
  waterJumpOut: 225, // HL's PM_CheckWaterJump: the leap out of the water onto a ledge
  waterJumpPush: 50, // and its push into the wall
  nonJumpVelocity: 140, // NON_JUMP_VELOCITY
  standableNormal: 0.7,
  // Stamina: landing/jumping adds stamina, which scales ground speed by
  // ((100 - stamina) / 100) ^ (dt * 70) and recovers linearly. Approximates CS:GO's
  // sv_stamina* behaviour; tune by feel against CS:GO.
  staminaMax: 80, // sv_staminamax
  staminaJumpCost: 0.08, // sv_staminajumpcost, per unit of jump impulse
  staminaLandCost: 0.05, // sv_staminalandcost, per unit of landing speed
  staminaRecoveryRate: 60, // sv_staminarecoveryrate
  // Duck: amount 0..1 approaches its goal at duckSpeed/s; each new duck press costs
  // speed (anti duck-spam), recovering over time.
  duckSpeedIdeal: 8,
  duckSpeedMin: 1.5,
  duckSpamPenalty: 2,
  duckSpeedRecovery: 3,
  crouchJumpRaise: 9, // feet rise when ducking in the air (CS:GO: 57 -> 66 unit jumps)
};

// Eye heights above the feet (CS:GO standing 64; crouch matches the 36-unit GoldSrc duck hull).
export const VIEW_STAND = 64;
export const VIEW_DUCK = 30;

// PlayerState layout: floats then ints over one 64-byte buffer.
export const PS_ORIGIN = 0; // 0..2, hull center
export const PS_VEL = 3; // 3..5
export const PS_DUCK_AMOUNT = 6;
export const PS_DUCK_SPEED = 7;
export const PS_STAMINA = 8;
export const PS_FALL_VEL = 9; // downward speed while airborne
export const PS_LAND_SPEED = 10; // output: impact speed on the tick we landed, else 0
export const PS_LADDER_COOLDOWN = 11; // seconds before ladders can grab us again
export const PS_FLAGS = 12; // int
export const PS_WATERLEVEL = 13; // int
export const PS_OLDBUTTONS = 14; // int
export const PS_EVENTS = 15; // int, output: EV_* bits for this tick
export const PS_BASEVEL = 16; // 16..18, velocity imparted by the ground entity (conveyors)
export const PS_GROUNDENT = 19; // int, collision entity we stand on, -1 if airborne
export const PS_VELMOD = 20; // CS:GO m_flVelocityModifier: tagging slowdown from being shot, 1 = none
export const PS_SIZE = 21;

const VELMOD_RECOVERY = 0.4; // per second back toward 1 (approximation of CS:GO's rate)

export const FL_ONGROUND = 1;
export const FL_DUCKING = 2; // using the duck hull
export const FL_ONLADDER = 4;
export const FL_NOCLIP = 8; // flying through walls (noclip: the demo, sv_cheats, the sandbox)
export const FL_WATERJUMP = 16; // leaping out of the water onto a ledge (HL's FL_WATERJUMP)
export const NOCLIP_SPEED = 800; // units a second (walking: 0.3 of it)

export const EV_JUMP = 1;
export const EV_LAND = 2;
export const EV_APEX = 4; // the top of a jump: still airborne, rising before this tick and not after

// Noclip (FL_NOCLIP): along the view at NOCLIP_SPEED through everything, jump rising and
// duck sinking, no gravity, ground or ladder. Shared, so a client predicts it exactly.
export function noclipMove(ps, buttons, pitch, yaw, frametime) {
  const f = ps.f, i = ps.i;
  const fwd = ((buttons & IN_FORWARD) ? 1 : 0) - ((buttons & IN_BACK) ? 1 : 0);
  const side = ((buttons & IN_MOVERIGHT) ? 1 : 0) - ((buttons & IN_MOVELEFT) ? 1 : 0);
  const up = ((buttons & IN_JUMP) ? 1 : 0) - ((buttons & IN_DUCK) ? 1 : 0);
  const speed = NOCLIP_SPEED * ((buttons & IN_SPEED) ? 0.3 : 1);
  const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG), sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
  f[PS_VEL] = (fwd * cp * cy + side * sy) * speed;
  f[PS_VEL + 1] = (fwd * cp * sy - side * cy) * speed;
  f[PS_VEL + 2] = (-fwd * sp + up) * speed;
  for (let k = 0; k < 3; k++) {
    f[PS_ORIGIN + k] += f[PS_VEL + k] * frametime;
    f[PS_BASEVEL + k] = 0;
  }
  f[PS_FALL_VEL] = 0;
  f[PS_DUCK_AMOUNT] = 0;
  i[PS_FLAGS] &= ~(FL_ONGROUND | FL_DUCKING | FL_ONLADDER | FL_WATERJUMP);
  i[PS_GROUNDENT] = -1;
  i[PS_EVENTS] = 0;
  i[PS_OLDBUTTONS] = buttons;
  touchedCount = 0; // touches nothing (the doors read the list after every move)
}

export function createPlayerState() {
  const buf = new ArrayBuffer(PS_SIZE * 4);
  const ps = { buf, f: new Float32Array(buf), i: new Int32Array(buf) };
  ps.f[PS_DUCK_SPEED] = MOVE.duckSpeedIdeal;
  ps.i[PS_GROUNDENT] = -1;
  ps.f[PS_VELMOD] = 1;
  return ps;
}

export function copyPlayerState(dst, src) {
  dst.i.set(src.i);
}

// Eye position offset from the hull center.
export function eyeOffset(ps) {
  const ducked = (ps.i[PS_FLAGS] & FL_DUCKING) !== 0;
  const top = ducked ? 34 : 70;
  // (Math.min, not a reassigned variable: the same value, no heap number through a phi)
  const fromFeet = Math.min(VIEW_STAND + (VIEW_DUCK - VIEW_STAND) * ps.f[PS_DUCK_AMOUNT], top);
  return fromFeet + (ducked ? -18 : -36);
}

// Falling damage for a landing speed (CS:GO PLAYER_MAX_SAFE_FALL_SPEED / FATAL).
export function fallDamage(landSpeed) {
  if (landSpeed <= 580) return 0;
  return (landSpeed - 580) * (100 / (1024 - 580));
}

// --- Per-tick working state (module scope: no allocation) -------------------

const DEG = Math.PI / 180;
const DIST_EPSILON = 0.03125;
const MAX_CLIP_PLANES = 5;

let W; // CollisionWorld
// The tick's numbers: fields of one object, not module variables (a double assigned to a
// module variable was a new heap number every time, ~16 a tick; a field holding doubles is
// written in place). Created as -0 so every field holds doubles from the start, then set
// to +0 as the variables were.
const M = {
  dt: -0,
  ox: -0, oy: -0, oz: -0, vx: -0, vy: -0, vz: -0,
  duckAmount: -0, duckSpeed: -0, stamina: -0, fallVel: -0, landSpeed: -0, ladderCooldown: -0,
  bvx: -0, bvy: -0, bvz: -0, // base velocity
  fx: -0, fy: -0, fz: -0, rx: -0, ry: -0, // forward (with pitch), right (flat)
  fmove: -0, smove: -0, maxspeed: -0,
  cvx: -0, cvy: -0, cvz: -0, // clipVelocity's result
  wdx: -0, wdy: -0, wspeed: -0, // flatWish's
};
for (const k in M) M[k] = 0;
let hull = HULL_STAND;
let onGround = false;
let flags = 0, waterLevel = 0, oldButtons = 0, events = 0;
let waterType = CONTENTS_EMPTY; // the liquid at the feet (checkWater)
let groundEnt = -1;

const tr = new Trace();
const TR = new Float64Array(6);
// Brush entities the last playerMove ran into (GoldSrc's pmove touch list: doors open).
export const touched = new Int32Array(4);
export let touchedCount = 0;
const planes = new Float64Array(MAX_CLIP_PLANES * 3);

// The world, the brush entities and the other players (`world.bodies`).
function trace(sx, sy, sz, ex, ey, ez) {
  const a = TR; // (the ends as an array: see trace.js, traceHullA)
  a[0] = sx; a[1] = sy; a[2] = sz; a[3] = ex; a[4] = ey; a[5] = ez;
  return tracePlayerA(W, hull, a, tr);
}

function checkVelocity() {
  const m = MOVE.maxVelocity;
  if (!(M.vx === M.vx)) M.vx = 0; // NaN guard
  if (!(M.vy === M.vy)) M.vy = 0;
  if (!(M.vz === M.vz)) M.vz = 0;
  M.vx = M.vx > m ? m : M.vx < -m ? -m : M.vx;
  M.vy = M.vy > m ? m : M.vy < -m ? -m : M.vy;
  M.vz = M.vz > m ? m : M.vz < -m ? -m : M.vz;
}

// Clips (vx,vy,vz)-style input against a plane; result in cvx/cvy/cvz.
function clipVelocity(ix, iy, iz, nx, ny, nz, overbounce) {
  const backoff = (ix * nx + iy * ny + iz * nz) * overbounce;
  M.cvx = ix - nx * backoff;
  M.cvy = iy - ny * backoff;
  M.cvz = iz - nz * backoff;
  const adjust = M.cvx * nx + M.cvy * ny + M.cvz * nz;
  if (adjust < 0) {
    M.cvx -= nx * adjust;
    M.cvy -= ny * adjust;
    M.cvz -= nz * adjust;
  }
}

// Source TryPlayerMove: slide along up to 4 surfaces this tick.
function tryPlayerMove() {
  let blocked = 0;
  let numPlanes = 0;
  let ovx = M.vx, ovy = M.vy, ovz = M.vz; // velocity at the start of the current bump
  const pvx = M.vx, pvy = M.vy, pvz = M.vz; // primal velocity
  let allFraction = 0;
  let timeLeft = M.dt;

  for (let bump = 0; bump < 4; bump++) {
    if (M.vx === 0 && M.vy === 0 && M.vz === 0) break;
    trace(M.ox, M.oy, M.oz, M.ox + M.vx * timeLeft, M.oy + M.vy * timeLeft, M.oz + M.vz * timeLeft);
    allFraction += tr.fraction;
    if (tr.allsolid) {
      M.vx = M.vy = M.vz = 0;
      return 4;
    }
    if (tr.fraction > 0) {
      M.ox = tr.endx; M.oy = tr.endy; M.oz = tr.endz;
      ovx = M.vx; ovy = M.vy; ovz = M.vz;
      numPlanes = 0;
    }
    if (tr.fraction === 1) break;
    if (tr.ent > 0 && touchedCount < 4) touched[touchedCount++] = tr.ent;

    if (tr.nz > MOVE.standableNormal) blocked |= 1; // floor
    if (tr.nz === 0) blocked |= 2; // step / wall
    timeLeft -= timeLeft * tr.fraction;

    if (numPlanes >= MAX_CLIP_PLANES) {
      M.vx = M.vy = M.vz = 0;
      break;
    }
    planes[numPlanes * 3] = tr.nx;
    planes[numPlanes * 3 + 1] = tr.ny;
    planes[numPlanes * 3 + 2] = tr.nz;
    numPlanes++;

    if (numPlanes === 1 && !onGround && !(flags & FL_ONLADDER)) {
      clipVelocity(ovx, ovy, ovz, tr.nx, tr.ny, tr.nz, 1);
      M.vx = ovx = M.cvx; M.vy = ovy = M.cvy; M.vz = ovz = M.cvz;
    } else {
      let i = 0;
      for (; i < numPlanes; i++) {
        clipVelocity(ovx, ovy, ovz, planes[i * 3], planes[i * 3 + 1], planes[i * 3 + 2], 1);
        M.vx = M.cvx; M.vy = M.cvy; M.vz = M.cvz;
        let j = 0;
        for (; j < numPlanes; j++) {
          if (j !== i && M.vx * planes[j * 3] + M.vy * planes[j * 3 + 1] + M.vz * planes[j * 3 + 2] < 0) break;
        }
        if (j === numPlanes) break; // velocity is clear of every plane
      }
      if (i === numPlanes) {
        // Go along the crease of two planes.
        if (numPlanes !== 2) {
          M.vx = M.vy = M.vz = 0;
          break;
        }
        const ax = planes[0], ay = planes[1], az = planes[2];
        const bx = planes[3], by = planes[4], bz = planes[5];
        let dx = ay * bz - az * by, dy = az * bx - ax * bz, dz = ax * by - ay * bx;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= len; dy /= len; dz /= len;
        const d = dx * M.vx + dy * M.vy + dz * M.vz;
        M.vx = dx * d; M.vy = dy * d; M.vz = dz * d;
      }
      // Moving against the original direction: stop dead to avoid oscillation in corners.
      if (M.vx * pvx + M.vy * pvy + M.vz * pvz <= 0) {
        M.vx = M.vy = M.vz = 0;
        break;
      }
    }
  }
  if (allFraction === 0) M.vx = M.vy = M.vz = 0;
  return blocked;
}

function friction() {
  const speed = Math.sqrt(M.vx * M.vx + M.vy * M.vy + M.vz * M.vz);
  if (speed < 0.1) return;
  let drop = 0;
  if (onGround) {
    const control = speed < MOVE.stopspeed ? MOVE.stopspeed : speed;
    drop = control * MOVE.friction * M.dt;
  }
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  if (newspeed !== speed) {
    const s = newspeed / speed;
    M.vx *= s; M.vy *= s; M.vz *= s;
  }
}

// CS:GO ground acceleration: scaled by max(250, wishspeed) so slow weapons and
// walking/ducking still accelerate briskly.
function accelerate(wx, wy, wz, wishspeed, accel) {
  const current = M.vx * wx + M.vy * wy + M.vz * wz;
  const addspeed = wishspeed - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * M.dt * (wishspeed > 250 ? wishspeed : 250);
  if (accelspeed > addspeed) accelspeed = addspeed;
  M.vx += accelspeed * wx;
  M.vy += accelspeed * wy;
  M.vz += accelspeed * wz;
}

function airAccelerate(wx, wy, wishspeed, accel) {
  const wishspd = wishspeed > MOVE.airMaxWishspeed ? MOVE.airMaxWishspeed : wishspeed;
  const current = M.vx * wx + M.vy * wy;
  const addspeed = wishspd - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * M.dt;
  if (accelspeed > addspeed) accelspeed = addspeed;
  M.vx += accelspeed * wx;
  M.vy += accelspeed * wy;
}

// Horizontal wish direction from flattened view axes. Results in wdx/wdy/wspeed.
function flatWish() {
  let fxx = M.fx, fyy = M.fy;
  const fl = Math.sqrt(fxx * fxx + fyy * fyy);
  if (fl > 0) { fxx /= fl; fyy /= fl; }
  const wx = fxx * M.fmove + M.rx * M.smove;
  const wy = fyy * M.fmove + M.ry * M.smove;
  M.wspeed = Math.sqrt(wx * wx + wy * wy);
  if (M.wspeed > 0) {
    M.wdx = wx / M.wspeed;
    M.wdy = wy / M.wspeed;
  } else {
    M.wdx = M.wdy = 0;
  }
  if (M.wspeed > M.maxspeed) M.wspeed = M.maxspeed;
}

function stayOnGround() {
  trace(M.ox, M.oy, M.oz, M.ox, M.oy, M.oz + 2);
  const sz = tr.endz;
  trace(M.ox, M.oy, sz, M.ox, M.oy, M.oz - MOVE.stepsize);
  if (tr.fraction > 0 && tr.fraction < 1 && !tr.startsolid && tr.nz >= MOVE.standableNormal) {
    if (Math.abs(M.oz - tr.endz) > 0.5 / 32) {
      M.ox = tr.endx; M.oy = tr.endy; M.oz = tr.endz;
    }
  }
}

// Try the move flat and stepped up by stepsize; keep whichever goes farther.
function stepMove() {
  const sx = M.ox, sy = M.oy, sz = M.oz;
  const svx = M.vx, svy = M.vy, svz = M.vz;

  tryPlayerMove();
  const dX = M.ox, dY = M.oy, dZ = M.oz, dVx = M.vx, dVy = M.vy, dVz = M.vz;

  M.ox = sx; M.oy = sy; M.oz = sz;
  M.vx = svx; M.vy = svy; M.vz = svz;

  trace(M.ox, M.oy, M.oz, M.ox, M.oy, M.oz + MOVE.stepsize + DIST_EPSILON);
  if (!tr.startsolid && !tr.allsolid) {
    M.ox = tr.endx; M.oy = tr.endy; M.oz = tr.endz;
  }
  tryPlayerMove();

  trace(M.ox, M.oy, M.oz, M.ox, M.oy, M.oz - MOVE.stepsize - DIST_EPSILON);
  if (!tr.startsolid && !tr.allsolid) {
    M.ox = tr.endx; M.oy = tr.endy; M.oz = tr.endz;
  }
  // Stepped onto something unstandable (or nothing): use the flat attempt.
  if (tr.fraction === 1 || tr.nz < MOVE.standableNormal) {
    M.ox = dX; M.oy = dY; M.oz = dZ;
    M.vx = dVx; M.vy = dVy; M.vz = dVz;
    return;
  }

  const upDist = (M.ox - sx) * (M.ox - sx) + (M.oy - sy) * (M.oy - sy);
  const downDist = (dX - sx) * (dX - sx) + (dY - sy) * (dY - sy);
  if (downDist > upDist) {
    M.ox = dX; M.oy = dY; M.oz = dZ;
    M.vx = dVx; M.vy = dVy; M.vz = dVz;
  } else {
    M.vz = dVz;
  }
}

function walkMove() {
  flatWish();
  M.vz = 0;
  accelerate(M.wdx, M.wdy, 0, M.wspeed, MOVE.accelerate);
  M.vz = 0;

  // Ride whatever we stand on; removed again after categorizePosition.
  M.vx += M.bvx; M.vy += M.bvy; M.vz += M.bvz;
  if (M.vx * M.vx + M.vy * M.vy + M.vz * M.vz < 1) {
    M.vx = M.bvx; M.vy = M.bvy; M.vz = M.bvz; // net zero once base velocity is pulled back out
    return;
  }
  trace(M.ox, M.oy, M.oz, M.ox + M.vx * M.dt, M.oy + M.vy * M.dt, M.oz);
  if (tr.fraction === 1) {
    M.ox = tr.endx; M.oy = tr.endy; M.oz = tr.endz;
    stayOnGround();
    return;
  }
  stepMove();
  stayOnGround();
}

function airMove() {
  flatWish();
  airAccelerate(M.wdx, M.wdy, M.wspeed, MOVE.airaccelerate);
  M.vx += M.bvx; M.vy += M.bvy; M.vz += M.bvz;
  tryPlayerMove();
}

function checkWater() {
  waterLevel = 0;
  const feet = M.oz + HULL_MINS[hull * 3 + 2] + 1;
  let c = pointContents(W, M.ox, M.oy, feet);
  if (c > -3 || c < -5) return; // not water / slime / lava
  waterLevel = 1;
  waterType = c;
  c = pointContents(W, M.ox, M.oy, M.oz);
  if (c > -3 || c < -5) return;
  waterLevel = 2;
  const eye = M.oz + (hull === HULL_DUCK ? VIEW_DUCK - 18 : VIEW_STAND - 36);
  c = pointContents(W, M.ox, M.oy, eye);
  if (c <= -3 && c >= -5) waterLevel = 3;
}

function waterMove(buttons) {
  // Full 3D wish direction (swim where you look).
  const ux = M.fx * M.fmove + M.rx * M.smove;
  const uy = M.fy * M.fmove + M.ry * M.smove;
  let uz = M.fz * M.fmove;
  if (buttons & IN_JUMP) uz += M.maxspeed;
  else if (M.fmove === 0 && M.smove === 0) uz -= MOVE.waterSinkSpeed;
  let wishspeed = Math.sqrt(ux * ux + uy * uy + uz * uz);
  let wx = 0, wy = 0, wz = 0;
  if (wishspeed > 0) {
    wx = ux / wishspeed; wy = uy / wishspeed; wz = uz / wishspeed;
  }
  if (wishspeed > M.maxspeed) wishspeed = M.maxspeed;
  wishspeed *= 0.8;

  const speed = Math.sqrt(M.vx * M.vx + M.vy * M.vy + M.vz * M.vz);
  let newspeed = 0;
  if (speed > 0) {
    newspeed = speed - M.dt * speed * MOVE.friction;
    if (newspeed < 0.1) newspeed = 0;
    const s = newspeed / speed;
    M.vx *= s; M.vy *= s; M.vz *= s;
  }
  if (wishspeed >= 0.1) {
    const addspeed = wishspeed - newspeed;
    if (addspeed > 0) {
      let accelspeed = MOVE.accelerate * wishspeed * M.dt;
      if (accelspeed > addspeed) accelspeed = addspeed;
      M.vx += accelspeed * wx; M.vy += accelspeed * wy; M.vz += accelspeed * wz;
    }
  }
  tryPlayerMove();
}

// HL's PM_CheckWaterJump: waist deep (waterLevel 2), not sinking fast, not backing away,
// facing a near-vertical wall within 24 units at the origin + 8 that is clear at the hull's
// top: leap out (vz 225, pushing 50 u/s into the wall) under FL_WATERJUMP.
function checkWaterJump() {
  if (M.vz < -180) return; // just jumped in
  const fl = Math.sqrt(M.fx * M.fx + M.fy * M.fy);
  if (fl === 0) return;
  const fx = M.fx / fl, fy = M.fy / fl;
  if (M.vx * fx + M.vy * fy < 0) return; // backing into the water
  const own = hull, low = M.oz + 8, top = M.oz + HULL_MAXS[own * 3 + 2];
  hull = HULL_POINT;
  trace(M.ox, M.oy, low, M.ox + 24 * fx, M.oy + 24 * fy, low);
  if (tr.fraction < 1 && Math.abs(tr.nz) < 0.1) {
    const nx = tr.nx, ny = tr.ny;
    trace(M.ox, M.oy, top, M.ox + 24 * fx, M.oy + 24 * fy, top);
    if (tr.fraction === 1) {
      M.vx = -MOVE.waterJumpPush * nx;
      M.vy = -MOVE.waterJumpPush * ny;
      M.vz = MOVE.waterJumpOut;
      flags |= FL_WATERJUMP;
    }
  }
  hull = own;
}

// HL's PM_WaterJump and PM_FlyMove: the leap keeps its push into the wall every tick (the
// wall clips it while it is in the way) and takes only the first half of the gravity, and
// none while still waist deep (HL returns before its second half), until the feet are out
// of the water, it falls or it lands. HL's 2 s timer never matters at 225 u/s.
function waterJumpMove() {
  const px = M.vx, py = M.vy;
  if (waterLevel < 2) M.vz -= MOVE.gravity * 0.5 * M.dt;
  tryPlayerMove();
  M.vx = px; M.vy = py;
  categorizePosition();
  if (onGround) M.vz = 0;
  if (waterLevel === 0 || M.vz <= 0) flags &= ~FL_WATERJUMP;
}

// Ladder volumes are func_ladder brushes; touching = player center inside the hull-expanded volume.
function findLadder() {
  const ents = W.ents, ladders = W.ladders;
  for (let k = 0; k < ladders.length; k++) {
    const i = ladders[k];
    if (ents[i].kind === ENT_LADDER && entityContents(W, i, hull, M.ox, M.oy, M.oz) !== CONTENTS_EMPTY) return i;
  }
  return -1;
}

const ladderTr = new Trace();
function ladderMove(ladder, buttons) {
  const e = W.ents[ladder];
  const cx = (e.mins[0] + e.maxs[0]) * 0.5 + e.ox;
  const cy = (e.mins[1] + e.maxs[1]) * 0.5 + e.oy;
  const cz = (e.mins[2] + e.maxs[2]) * 0.5 + e.oz;
  // Find the ladder face facing us with a point trace towards the ladder center.
  traceEntity(W, ladder, HULL_POINT, M.ox, M.oy, M.oz, cx, cy, cz, ladderTr);
  let nx = ladderTr.nx, ny = ladderTr.ny, nz = ladderTr.nz;
  if (ladderTr.fraction === 1 || ladderTr.startsolid) {
    // Inside the ladder brush: push out along its thinnest horizontal axis.
    const sxw = e.maxs[0] - e.mins[0], syw = e.maxs[1] - e.mins[1];
    nx = sxw < syw ? Math.sign(M.ox - cx) || 1 : 0;
    ny = sxw < syw ? 0 : Math.sign(M.oy - cy) || 1;
    nz = 0;
  }

  if ((buttons & IN_JUMP) && !(oldButtons & IN_JUMP)) {
    M.vx = nx * MOVE.ladderJumpSpeed;
    M.vy = ny * MOVE.ladderJumpSpeed;
    M.vz = nz * MOVE.ladderJumpSpeed;
    flags &= ~FL_ONLADDER;
    M.ladderCooldown = MOVE.ladderDetachTime;
    tryPlayerMove();
    return;
  }

  let speed = MOVE.ladderSpeed;
  if (buttons & IN_DUCK) speed *= 0.333;
  const fwd = ((buttons & IN_FORWARD) ? speed : 0) - ((buttons & IN_BACK) ? speed : 0);
  const side = ((buttons & IN_MOVERIGHT) ? speed : 0) - ((buttons & IN_MOVELEFT) ? speed : 0);

  if (fwd === 0 && side === 0) {
    M.vx = M.vy = M.vz = 0;
    return;
  }
  // Intended velocity, decomposed against the ladder plane (GoldSrc PM_LadderMove).
  const ix = M.fx * fwd + M.rx * side, iy = M.fy * fwd + M.ry * side, iz = M.fz * fwd;
  // perp = up x normal
  let px = -ny, py = nx;
  const pl = Math.sqrt(px * px + py * py) || 1;
  px /= pl; py /= pl;
  const normal = ix * nx + iy * ny + iz * nz;
  const lx = ix - nx * normal, ly = iy - ny * normal, lz = iz - nz * normal;
  // tmp = normal x perp (points up along the ladder)
  const tx = -nz * py, ty = nz * px, tz = nx * py - ny * px;
  M.vx = lx - normal * tx;
  M.vy = ly - normal * ty;
  M.vz = lz - normal * tz;
  if (onGround && normal > 0) {
    M.vx += MOVE.ladderSpeed * nx;
    M.vy += MOVE.ladderSpeed * ny;
    M.vz += MOVE.ladderSpeed * nz;
  }
  tryPlayerMove();
}

function setGround(on, ent = -1) {
  groundEnt = on ? ent : -1;
  if (on && !onGround) {
    if (M.fallVel > 0) {
      M.landSpeed = M.fallVel;
      events |= EV_LAND;
      M.stamina += MOVE.staminaLandCost * M.fallVel;
      if (M.stamina > MOVE.staminaMax) M.stamina = MOVE.staminaMax;
    }
    M.fallVel = 0;
  }
  onGround = on;
}

function categorizePosition() {
  checkWater();
  if (M.vz > MOVE.nonJumpVelocity || ((flags & FL_ONLADDER) && M.vz > 0)) {
    setGround(false);
    return;
  }
  trace(M.ox, M.oy, M.oz, M.ox, M.oy, M.oz - 2);
  const grounded = tr.fraction < 1 && !tr.startsolid && tr.nz >= MOVE.standableNormal;
  setGround(grounded, tr.ent);
  // Snap onto the ground we found (GoldSrc PM_CatagorizePosition), so idle players
  // don't hover up to 2 units above the floor; not waist deep in water (HL's rule too: on
  // the bottom of deep water the snap undid every swim stroke, so nobody left it).
  if (grounded && waterLevel < 2) {
    M.ox = tr.endx; M.oy = tr.endy; M.oz = tr.endz;
  }
}

function checkJump() {
  if (!onGround) return;
  if (oldButtons & IN_JUMP) return; // no auto-bhop: must release jump
  // sv_enablebunnyhopping 0 (PreventBunnyJumping): a jump never carries more than 1.1 x the
  // max speed, so strafe-jumping cannot keep building speed.
  const lim = M.maxspeed * 1.1, sp = Math.sqrt(M.vx * M.vx + M.vy * M.vy);
  if (sp > lim) {
    M.vx *= lim / sp;
    M.vy *= lim / sp;
  }
  if (hull === HULL_DUCK || M.duckAmount > 0) M.vz = MOVE.jumpImpulse;
  else M.vz += MOVE.jumpImpulse;
  M.stamina += MOVE.staminaJumpCost * MOVE.jumpImpulse;
  if (M.stamina > MOVE.staminaMax) M.stamina = MOVE.staminaMax;
  M.vz -= MOVE.gravity * 0.5 * M.dt; // FinishGravity inside CheckJumpButton (Source)
  onGround = false;
  groundEnt = -1;
  events |= EV_JUMP;
}

function duck(buttons) {
  const want = (buttons & IN_DUCK) !== 0;
  if (want && !(oldButtons & IN_DUCK)) {
    M.duckSpeed = Math.max(MOVE.duckSpeedMin, M.duckSpeed - MOVE.duckSpamPenalty);
  }
  M.duckSpeed = Math.min(MOVE.duckSpeedIdeal, M.duckSpeed + MOVE.duckSpeedRecovery * M.dt);

  if (want) {
    M.duckAmount = Math.min(1, M.duckAmount + M.dt * M.duckSpeed);
    if (hull === HULL_STAND) {
      if (!onGround) {
        // In air: shrink around a point so the feet rise crouchJumpRaise units.
        hull = HULL_DUCK;
        M.oz -= 18 - MOVE.crouchJumpRaise;
      } else if (M.duckAmount >= 1) {
        hull = HULL_DUCK;
        M.oz -= 18; // feet stay on the floor
      }
    }
    return;
  }

  if (hull === HULL_DUCK) {
    const dz = onGround ? 18 : 18 - MOVE.crouchJumpRaise;
    if (!hullFits(W, HULL_STAND, M.ox, M.oy, M.oz + dz)) {
      M.duckAmount = 1; // no room to stand
      return;
    }
    // Room to stand: the hull grows now and the view rises with the amount (the eye
    // cannot rise above a ducked hull, so waiting for the amount held it down, then popped it up).
    M.duckAmount = Math.max(0, M.duckAmount - M.dt * M.duckSpeed);
    hull = HULL_STAND;
    M.oz += dz;
  } else {
    M.duckAmount = Math.max(0, M.duckAmount - M.dt * M.duckSpeed);
  }
}

// Nudges a stuck player out of solid geometry (GoldSrc PM_CheckStuck, simplified).
function unstick() {
  if (hullFits(W, hull, M.ox, M.oy, M.oz)) return;
  for (let r = 1; r <= 18; r++) {
    for (let k = 0; k < 7; k++) {
      const dx = k === 1 ? r : k === 2 ? -r : 0;
      const dy = k === 3 ? r : k === 4 ? -r : 0;
      const dz = k === 0 ? r : k === 5 ? -r : 0;
      if (k === 6) continue;
      if (hullFits(W, hull, M.ox + dx, M.oy + dy, M.oz + dz)) {
        M.ox += dx; M.oy += dy; M.oz += dz;
        return;
      }
    }
  }
}

// Inside another player (he stood up under us, or we spawned on him): when our feet are
// in his upper half we are put on top of him (a crouching teammate standing up lifts
// whoever stands on him: CS:GO's boost), else we walk out of him (his box is passed
// through while we start inside it).
function liftOffBodies() {
  const n = W.bodyCount;
  if (n === 0) return;
  const B = W.bodies, self = W.bodySelf, pass = W.solidTeam ? -1 : W.bodyTeam;
  const hx = HULL_MAXS[hull * 3], hz = HULL_MAXS[hull * 3 + 2];
  for (let k = 0; k < n; k++) {
    const b = k * BODY_FIELDS, bh = B[b + 3];
    if (bh === 0 || k === self || B[b + 7] === pass) continue;
    if (Math.abs(M.ox - B[b]) >= 16 + hx || Math.abs(M.oy - B[b + 1]) >= 16 + hx) continue;
    const top = B[b + 2] + bh, feet = M.oz - hz;
    if (feet >= top || feet < B[b + 2]) continue;
    M.oz = top + hz + DIST_EPSILON;
  }
}

// GoldSrc SV_CheckMovingGround: standing on a conveyor sets the base velocity; once
// off it, the base velocity becomes real momentum (plus half a frame of it). Standing
// on another player, his velocity is the base velocity (Source's SetGroundEntity adds
// the ground's velocity on leaving it): we ride along with him, and a jump off a running
// teammate keeps his speed on top of its own, past the jump's speed cap (the run boost).
function checkMovingGround() {
  if (onGround && groundEnt >= ENT_BODY_BASE) {
    const b = (groundEnt - ENT_BODY_BASE) * BODY_FIELDS, B = W.bodies;
    if (B[b + 3] !== 0 && (B[b + 4] !== 0 || B[b + 5] !== 0 || B[b + 6] !== 0)) {
      M.bvx = B[b + 4]; M.bvy = B[b + 5]; M.bvz = B[b + 6];
      return;
    }
  }
  const e = onGround && groundEnt >= 0 && groundEnt < ENT_BODY_BASE ? W.ents[groundEnt] : null;
  if (e && (e.pushX !== 0 || e.pushY !== 0 || e.pushZ !== 0)) {
    M.bvx = e.pushX; M.bvy = e.pushY; M.bvz = e.pushZ;
    return;
  }
  const k = 1 + M.dt * 0.5;
  M.vx += M.bvx * k; M.vy += M.bvy * k; M.vz += M.bvz * k;
  M.bvx = M.bvy = M.bvz = 0;
}

// Runs one movement tick. pitch/yaw in degrees, maxSpeed = current weapon speed.
export function playerMove(world, ps, buttons, pitch, yaw, frametime, maxSpeed) {
  if (ps.i[PS_FLAGS] & FL_NOCLIP) return noclipMove(ps, buttons, pitch, yaw, frametime);
  W = world;
  M.dt = frametime;
  const f = ps.f, i = ps.i;
  M.ox = f[PS_ORIGIN]; M.oy = f[PS_ORIGIN + 1]; M.oz = f[PS_ORIGIN + 2];
  M.vx = f[PS_VEL]; M.vy = f[PS_VEL + 1]; M.vz = f[PS_VEL + 2];
  const startVz = M.vz;
  M.duckAmount = f[PS_DUCK_AMOUNT];
  M.duckSpeed = f[PS_DUCK_SPEED];
  M.stamina = f[PS_STAMINA];
  M.fallVel = f[PS_FALL_VEL];
  M.ladderCooldown = f[PS_LADDER_COOLDOWN];
  flags = i[PS_FLAGS];
  waterLevel = i[PS_WATERLEVEL];
  oldButtons = i[PS_OLDBUTTONS];
  groundEnt = i[PS_GROUNDENT];
  M.bvx = f[PS_BASEVEL]; M.bvy = f[PS_BASEVEL + 1]; M.bvz = f[PS_BASEVEL + 2];
  onGround = (flags & FL_ONGROUND) !== 0;
  hull = (flags & FL_DUCKING) ? HULL_DUCK : HULL_STAND;
  events = 0;
  M.landSpeed = 0;
  touchedCount = 0;

  // View axes.
  const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG);
  const sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
  M.fx = cp * cy; M.fy = cp * sy; M.fz = -sp;
  M.rx = sy; M.ry = -cy;

  M.fmove = ((buttons & IN_FORWARD) ? MOVE.forwardSpeed : 0) - ((buttons & IN_BACK) ? MOVE.forwardSpeed : 0);
  M.smove = ((buttons & IN_MOVERIGHT) ? MOVE.forwardSpeed : 0) - ((buttons & IN_MOVELEFT) ? MOVE.forwardSpeed : 0);

  unstick();
  liftOffBodies();
  checkMovingGround();
  if (!onGround) M.fallVel = -M.vz;

  M.stamina -= MOVE.staminaRecoveryRate * M.dt;
  if (M.stamina < 0) M.stamina = 0;

  duck(buttons);

  let scale = (buttons & IN_SPEED) ? MOVE.walkModifier : 1;
  if (onGround && M.duckAmount > 0) scale += (MOVE.duckModifier - scale) * M.duckAmount;
  // Tagging: being shot caps our speed, recovering over time.
  let velmod = f[PS_VELMOD] + VELMOD_RECOVERY * M.dt;
  if (velmod > 1) velmod = 1;
  f[PS_VELMOD] = velmod;
  M.maxspeed = maxSpeed * scale * velmod;

  M.ladderCooldown = M.ladderCooldown > M.dt ? M.ladderCooldown - M.dt : 0;
  const ladder = M.ladderCooldown > 0 ? -1 : findLadder();
  if (ladder >= 0) {
    flags = (flags | FL_ONLADDER) & ~FL_WATERJUMP;
    ladderMove(ladder, buttons);
    categorizePosition();
  } else {
    flags &= ~FL_ONLADDER;
    checkWater();
    if (waterLevel === 2 && !(flags & FL_WATERJUMP)) checkWaterJump();
    if (flags & FL_WATERJUMP) {
      waterJumpMove();
    } else if (waterLevel >= 2) {
      if (buttons & IN_JUMP) {
        setGround(false);
        M.vz = waterType === CONTENTS_WATER ? MOVE.waterJumpSpeed
          : waterType === CONTENTS_SLIME ? MOVE.slimeJumpSpeed : MOVE.lavaJumpSpeed;
      }
      waterMove(buttons);
      categorizePosition();
    } else {
      M.vz -= MOVE.gravity * 0.5 * M.dt; // StartGravity
      if (buttons & IN_JUMP) checkJump();
      if (onGround) {
        M.vz = 0;
        if (M.stamina > 0) {
          const ratio = Math.pow((100 - M.stamina) / 100, M.dt * 70);
          M.vx *= ratio;
          M.vy *= ratio;
        }
        friction();
      }
      checkVelocity();
      if (onGround) walkMove();
      else airMove();
      categorizePosition();
      // Pull the base velocity back out: it moved us but is not our own velocity.
      M.vx -= M.bvx; M.vy -= M.bvy; M.vz -= M.bvz;
      checkVelocity();
      if (waterLevel < 2) M.vz -= MOVE.gravity * 0.5 * M.dt; // FinishGravity
      if (onGround) M.vz = 0;
      else if (startVz > 0 && M.vz <= 0) events |= EV_APEX;
    }
  }

  flags = (flags & ~(FL_ONGROUND | FL_DUCKING)) | (onGround ? FL_ONGROUND : 0) | (hull === HULL_DUCK ? FL_DUCKING : 0);
  f[PS_ORIGIN] = M.ox; f[PS_ORIGIN + 1] = M.oy; f[PS_ORIGIN + 2] = M.oz;
  f[PS_VEL] = M.vx; f[PS_VEL + 1] = M.vy; f[PS_VEL + 2] = M.vz;
  f[PS_DUCK_AMOUNT] = M.duckAmount;
  f[PS_DUCK_SPEED] = M.duckSpeed;
  f[PS_STAMINA] = M.stamina;
  f[PS_FALL_VEL] = M.fallVel;
  f[PS_LAND_SPEED] = M.landSpeed;
  f[PS_LADDER_COOLDOWN] = M.ladderCooldown;
  i[PS_FLAGS] = flags;
  i[PS_WATERLEVEL] = waterLevel;
  i[PS_OLDBUTTONS] = buttons;
  i[PS_EVENTS] = events;
  f[PS_BASEVEL] = M.bvx; f[PS_BASEVEL + 1] = M.bvy; f[PS_BASEVEL + 2] = M.bvz;
  i[PS_GROUNDENT] = groundEnt;
}
