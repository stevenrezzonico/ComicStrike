// CS:GO player movement on GoldSrc clip hulls.
// Follows Source's CGameMovement::FullWalkMove ordering with CS:GO's constants and
// CS:GO-specific rules (acceleration scale, air wishspeed cap, stamina, duck speed).
// Runs identically on client (prediction) and server (authority): all state lives in
// a PlayerState buffer that is rounded to float32 at the end of every tick.

import {
  IN_JUMP, IN_DUCK, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED,
} from './constants.js';
import { CONTENTS_EMPTY } from './bsp.js';
import {
  Trace, traceHull, traceEntity, entityContents, pointContents, hullFits,
  HULL_STAND, HULL_DUCK, HULL_POINT, HULL_MINS, ENT_LADDER,
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
  waterJumpSpeed: 100,
  nonJumpVelocity: 140, // NON_JUMP_VELOCITY
  standableNormal: 0.7,
  // Stamina: landing/jumping adds stamina, which scales ground speed by
  // ((100 - stamina) / 100) ^ (dt * 70) and recovers linearly. Approximates CS:GO's
  // sv_stamina* behaviour; tune by feel against CS:GO.
  staminaMax: 80, // sv_staminamax
  staminaJumpCost: 0.08, // sv_staminajumpcost, per unit of jump impulse
  staminaLandCost: 0.02, // per unit of landing speed
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

export const EV_JUMP = 1;
export const EV_LAND = 2;
export const EV_APEX = 4; // the top of a jump: still airborne, rising before this tick and not after

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
  let fromFeet = VIEW_STAND + (VIEW_DUCK - VIEW_STAND) * ps.f[PS_DUCK_AMOUNT];
  const top = ducked ? 34 : 70;
  if (fromFeet > top) fromFeet = top;
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
let dt = 0;
let ox = 0, oy = 0, oz = 0, vx = 0, vy = 0, vz = 0;
let hull = HULL_STAND;
let onGround = false;
let duckAmount = 0, duckSpeed = 0, stamina = 0, fallVel = 0, landSpeed = 0;
let flags = 0, waterLevel = 0, oldButtons = 0, events = 0, ladderCooldown = 0;
let groundEnt = -1;
let bvx = 0, bvy = 0, bvz = 0; // base velocity
let fx = 0, fy = 0, fz = 0, rx = 0, ry = 0; // forward (with pitch), right (flat)
let fmove = 0, smove = 0, maxspeed = 0;

const tr = new Trace();
// Brush entities the last playerMove ran into (GoldSrc's pmove touch list: doors open).
export const touched = new Int32Array(4);
export let touchedCount = 0;
const planes = new Float64Array(MAX_CLIP_PLANES * 3);

function trace(sx, sy, sz, ex, ey, ez) {
  return traceHull(W, hull, sx, sy, sz, ex, ey, ez, tr);
}

function checkVelocity() {
  const m = MOVE.maxVelocity;
  if (!(vx === vx)) vx = 0; // NaN guard
  if (!(vy === vy)) vy = 0;
  if (!(vz === vz)) vz = 0;
  vx = vx > m ? m : vx < -m ? -m : vx;
  vy = vy > m ? m : vy < -m ? -m : vy;
  vz = vz > m ? m : vz < -m ? -m : vz;
}

// Clips (vx,vy,vz)-style input against a plane; result in cvx/cvy/cvz.
let cvx = 0, cvy = 0, cvz = 0;
function clipVelocity(ix, iy, iz, nx, ny, nz, overbounce) {
  const backoff = (ix * nx + iy * ny + iz * nz) * overbounce;
  cvx = ix - nx * backoff;
  cvy = iy - ny * backoff;
  cvz = iz - nz * backoff;
  const adjust = cvx * nx + cvy * ny + cvz * nz;
  if (adjust < 0) {
    cvx -= nx * adjust;
    cvy -= ny * adjust;
    cvz -= nz * adjust;
  }
}

// Source TryPlayerMove: slide along up to 4 surfaces this tick.
function tryPlayerMove() {
  let blocked = 0;
  let numPlanes = 0;
  let ovx = vx, ovy = vy, ovz = vz; // velocity at the start of the current bump
  const pvx = vx, pvy = vy, pvz = vz; // primal velocity
  let allFraction = 0;
  let timeLeft = dt;

  for (let bump = 0; bump < 4; bump++) {
    if (vx === 0 && vy === 0 && vz === 0) break;
    trace(ox, oy, oz, ox + vx * timeLeft, oy + vy * timeLeft, oz + vz * timeLeft);
    allFraction += tr.fraction;
    if (tr.allsolid) {
      vx = vy = vz = 0;
      return 4;
    }
    if (tr.fraction > 0) {
      ox = tr.endx; oy = tr.endy; oz = tr.endz;
      ovx = vx; ovy = vy; ovz = vz;
      numPlanes = 0;
    }
    if (tr.fraction === 1) break;
    if (tr.ent > 0 && touchedCount < 4) touched[touchedCount++] = tr.ent;

    if (tr.nz > MOVE.standableNormal) blocked |= 1; // floor
    if (tr.nz === 0) blocked |= 2; // step / wall
    timeLeft -= timeLeft * tr.fraction;

    if (numPlanes >= MAX_CLIP_PLANES) {
      vx = vy = vz = 0;
      break;
    }
    planes[numPlanes * 3] = tr.nx;
    planes[numPlanes * 3 + 1] = tr.ny;
    planes[numPlanes * 3 + 2] = tr.nz;
    numPlanes++;

    if (numPlanes === 1 && !onGround && !(flags & FL_ONLADDER)) {
      clipVelocity(ovx, ovy, ovz, tr.nx, tr.ny, tr.nz, 1);
      vx = ovx = cvx; vy = ovy = cvy; vz = ovz = cvz;
    } else {
      let i = 0;
      for (; i < numPlanes; i++) {
        clipVelocity(ovx, ovy, ovz, planes[i * 3], planes[i * 3 + 1], planes[i * 3 + 2], 1);
        vx = cvx; vy = cvy; vz = cvz;
        let j = 0;
        for (; j < numPlanes; j++) {
          if (j !== i && vx * planes[j * 3] + vy * planes[j * 3 + 1] + vz * planes[j * 3 + 2] < 0) break;
        }
        if (j === numPlanes) break; // velocity is clear of every plane
      }
      if (i === numPlanes) {
        // Go along the crease of two planes.
        if (numPlanes !== 2) {
          vx = vy = vz = 0;
          break;
        }
        const ax = planes[0], ay = planes[1], az = planes[2];
        const bx = planes[3], by = planes[4], bz = planes[5];
        let dx = ay * bz - az * by, dy = az * bx - ax * bz, dz = ax * by - ay * bx;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= len; dy /= len; dz /= len;
        const d = dx * vx + dy * vy + dz * vz;
        vx = dx * d; vy = dy * d; vz = dz * d;
      }
      // Moving against the original direction: stop dead to avoid oscillation in corners.
      if (vx * pvx + vy * pvy + vz * pvz <= 0) {
        vx = vy = vz = 0;
        break;
      }
    }
  }
  if (allFraction === 0) vx = vy = vz = 0;
  return blocked;
}

function friction() {
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (speed < 0.1) return;
  let drop = 0;
  if (onGround) {
    const control = speed < MOVE.stopspeed ? MOVE.stopspeed : speed;
    drop = control * MOVE.friction * dt;
  }
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  if (newspeed !== speed) {
    const s = newspeed / speed;
    vx *= s; vy *= s; vz *= s;
  }
}

// CS:GO ground acceleration: scaled by max(250, wishspeed) so slow weapons and
// walking/ducking still accelerate briskly.
function accelerate(wx, wy, wz, wishspeed, accel) {
  const current = vx * wx + vy * wy + vz * wz;
  const addspeed = wishspeed - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * dt * (wishspeed > 250 ? wishspeed : 250);
  if (accelspeed > addspeed) accelspeed = addspeed;
  vx += accelspeed * wx;
  vy += accelspeed * wy;
  vz += accelspeed * wz;
}

function airAccelerate(wx, wy, wishspeed, accel) {
  const wishspd = wishspeed > MOVE.airMaxWishspeed ? MOVE.airMaxWishspeed : wishspeed;
  const current = vx * wx + vy * wy;
  const addspeed = wishspd - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * dt;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vx += accelspeed * wx;
  vy += accelspeed * wy;
}

// Horizontal wish direction from flattened view axes. Results in wdx/wdy/wspeed.
let wdx = 0, wdy = 0, wspeed = 0;
function flatWish() {
  let fxx = fx, fyy = fy;
  const fl = Math.sqrt(fxx * fxx + fyy * fyy);
  if (fl > 0) { fxx /= fl; fyy /= fl; }
  const wx = fxx * fmove + rx * smove;
  const wy = fyy * fmove + ry * smove;
  wspeed = Math.sqrt(wx * wx + wy * wy);
  if (wspeed > 0) {
    wdx = wx / wspeed;
    wdy = wy / wspeed;
  } else {
    wdx = wdy = 0;
  }
  if (wspeed > maxspeed) wspeed = maxspeed;
}

function stayOnGround() {
  trace(ox, oy, oz, ox, oy, oz + 2);
  const sz = tr.endz;
  trace(ox, oy, sz, ox, oy, oz - MOVE.stepsize);
  if (tr.fraction > 0 && tr.fraction < 1 && !tr.startsolid && tr.nz >= MOVE.standableNormal) {
    if (Math.abs(oz - tr.endz) > 0.5 / 32) {
      ox = tr.endx; oy = tr.endy; oz = tr.endz;
    }
  }
}

// Try the move flat and stepped up by stepsize; keep whichever goes farther.
function stepMove() {
  const sx = ox, sy = oy, sz = oz;
  const svx = vx, svy = vy, svz = vz;

  tryPlayerMove();
  const dX = ox, dY = oy, dZ = oz, dVx = vx, dVy = vy, dVz = vz;

  ox = sx; oy = sy; oz = sz;
  vx = svx; vy = svy; vz = svz;

  trace(ox, oy, oz, ox, oy, oz + MOVE.stepsize + DIST_EPSILON);
  if (!tr.startsolid && !tr.allsolid) {
    ox = tr.endx; oy = tr.endy; oz = tr.endz;
  }
  tryPlayerMove();

  trace(ox, oy, oz, ox, oy, oz - MOVE.stepsize - DIST_EPSILON);
  if (!tr.startsolid && !tr.allsolid) {
    ox = tr.endx; oy = tr.endy; oz = tr.endz;
  }
  // Stepped onto something unstandable (or nothing): use the flat attempt.
  if (tr.fraction === 1 || tr.nz < MOVE.standableNormal) {
    ox = dX; oy = dY; oz = dZ;
    vx = dVx; vy = dVy; vz = dVz;
    return;
  }

  const upDist = (ox - sx) * (ox - sx) + (oy - sy) * (oy - sy);
  const downDist = (dX - sx) * (dX - sx) + (dY - sy) * (dY - sy);
  if (downDist > upDist) {
    ox = dX; oy = dY; oz = dZ;
    vx = dVx; vy = dVy; vz = dVz;
  } else {
    vz = dVz;
  }
}

function walkMove() {
  flatWish();
  vz = 0;
  accelerate(wdx, wdy, 0, wspeed, MOVE.accelerate);
  vz = 0;

  // Ride whatever we stand on; removed again after categorizePosition.
  vx += bvx; vy += bvy; vz += bvz;
  if (vx * vx + vy * vy + vz * vz < 1) {
    vx = bvx; vy = bvy; vz = bvz; // net zero once base velocity is pulled back out
    return;
  }
  trace(ox, oy, oz, ox + vx * dt, oy + vy * dt, oz);
  if (tr.fraction === 1) {
    ox = tr.endx; oy = tr.endy; oz = tr.endz;
    stayOnGround();
    return;
  }
  stepMove();
  stayOnGround();
}

function airMove() {
  flatWish();
  airAccelerate(wdx, wdy, wspeed, MOVE.airaccelerate);
  vx += bvx; vy += bvy; vz += bvz;
  tryPlayerMove();
}

function checkWater() {
  waterLevel = 0;
  const feet = oz + HULL_MINS[hull * 3 + 2] + 1;
  let c = pointContents(W, ox, oy, feet);
  if (c > -3 || c < -5) return; // not water / slime / lava
  waterLevel = 1;
  c = pointContents(W, ox, oy, oz);
  if (c > -3 || c < -5) return;
  waterLevel = 2;
  const eye = oz + (hull === HULL_DUCK ? VIEW_DUCK - 18 : VIEW_STAND - 36);
  c = pointContents(W, ox, oy, eye);
  if (c <= -3 && c >= -5) waterLevel = 3;
}

function waterMove(buttons) {
  // Full 3D wish direction (swim where you look).
  const ux = fx * fmove + rx * smove;
  const uy = fy * fmove + ry * smove;
  let uz = fz * fmove;
  if (buttons & IN_JUMP) uz += maxspeed;
  else if (fmove === 0 && smove === 0) uz -= MOVE.waterSinkSpeed;
  let wishspeed = Math.sqrt(ux * ux + uy * uy + uz * uz);
  let wx = 0, wy = 0, wz = 0;
  if (wishspeed > 0) {
    wx = ux / wishspeed; wy = uy / wishspeed; wz = uz / wishspeed;
  }
  if (wishspeed > maxspeed) wishspeed = maxspeed;
  wishspeed *= 0.8;

  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  let newspeed = 0;
  if (speed > 0) {
    newspeed = speed - dt * speed * MOVE.friction;
    if (newspeed < 0.1) newspeed = 0;
    const s = newspeed / speed;
    vx *= s; vy *= s; vz *= s;
  }
  if (wishspeed >= 0.1) {
    const addspeed = wishspeed - newspeed;
    if (addspeed > 0) {
      let accelspeed = MOVE.accelerate * wishspeed * dt;
      if (accelspeed > addspeed) accelspeed = addspeed;
      vx += accelspeed * wx; vy += accelspeed * wy; vz += accelspeed * wz;
    }
  }
  tryPlayerMove();
}

// Ladder volumes are func_ladder brushes; touching = player center inside the hull-expanded volume.
function findLadder() {
  const ents = W.ents;
  for (let i = 1; i < ents.length; i++) {
    if (ents[i].kind === ENT_LADDER && entityContents(W, i, hull, ox, oy, oz) !== CONTENTS_EMPTY) return i;
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
  traceEntity(W, ladder, HULL_POINT, ox, oy, oz, cx, cy, cz, ladderTr);
  let nx = ladderTr.nx, ny = ladderTr.ny, nz = ladderTr.nz;
  if (ladderTr.fraction === 1 || ladderTr.startsolid) {
    // Inside the ladder brush: push out along its thinnest horizontal axis.
    const sxw = e.maxs[0] - e.mins[0], syw = e.maxs[1] - e.mins[1];
    nx = sxw < syw ? Math.sign(ox - cx) || 1 : 0;
    ny = sxw < syw ? 0 : Math.sign(oy - cy) || 1;
    nz = 0;
  }

  if ((buttons & IN_JUMP) && !(oldButtons & IN_JUMP)) {
    vx = nx * MOVE.ladderJumpSpeed;
    vy = ny * MOVE.ladderJumpSpeed;
    vz = nz * MOVE.ladderJumpSpeed;
    flags &= ~FL_ONLADDER;
    ladderCooldown = MOVE.ladderDetachTime;
    tryPlayerMove();
    return;
  }

  let speed = MOVE.ladderSpeed;
  if (buttons & IN_DUCK) speed *= 0.333;
  const fwd = ((buttons & IN_FORWARD) ? speed : 0) - ((buttons & IN_BACK) ? speed : 0);
  const side = ((buttons & IN_MOVERIGHT) ? speed : 0) - ((buttons & IN_MOVELEFT) ? speed : 0);

  if (fwd === 0 && side === 0) {
    vx = vy = vz = 0;
    return;
  }
  // Intended velocity, decomposed against the ladder plane (GoldSrc PM_LadderMove).
  const ix = fx * fwd + rx * side, iy = fy * fwd + ry * side, iz = fz * fwd;
  // perp = up x normal
  let px = -ny, py = nx;
  const pl = Math.sqrt(px * px + py * py) || 1;
  px /= pl; py /= pl;
  const normal = ix * nx + iy * ny + iz * nz;
  const lx = ix - nx * normal, ly = iy - ny * normal, lz = iz - nz * normal;
  // tmp = normal x perp (points up along the ladder)
  const tx = -nz * py, ty = nz * px, tz = nx * py - ny * px;
  vx = lx - normal * tx;
  vy = ly - normal * ty;
  vz = lz - normal * tz;
  if (onGround && normal > 0) {
    vx += MOVE.ladderSpeed * nx;
    vy += MOVE.ladderSpeed * ny;
    vz += MOVE.ladderSpeed * nz;
  }
  tryPlayerMove();
}

function setGround(on, ent = -1) {
  groundEnt = on ? ent : -1;
  if (on && !onGround) {
    if (fallVel > 0) {
      landSpeed = fallVel;
      events |= EV_LAND;
      stamina += MOVE.staminaLandCost * fallVel;
      if (stamina > MOVE.staminaMax) stamina = MOVE.staminaMax;
    }
    fallVel = 0;
  }
  onGround = on;
}

function categorizePosition() {
  checkWater();
  if (vz > MOVE.nonJumpVelocity || ((flags & FL_ONLADDER) && vz > 0)) {
    setGround(false);
    return;
  }
  trace(ox, oy, oz, ox, oy, oz - 2);
  const grounded = tr.fraction < 1 && !tr.startsolid && tr.nz >= MOVE.standableNormal;
  setGround(grounded, tr.ent);
  // Snap onto the ground we found (GoldSrc PM_CatagorizePosition), so idle players
  // don't hover up to 2 units above the floor.
  if (grounded) {
    ox = tr.endx; oy = tr.endy; oz = tr.endz;
  }
}

function checkJump() {
  if (!onGround) return;
  if (oldButtons & IN_JUMP) return; // no auto-bhop: must release jump
  if (hull === HULL_DUCK || duckAmount > 0) vz = MOVE.jumpImpulse;
  else vz += MOVE.jumpImpulse;
  stamina += MOVE.staminaJumpCost * MOVE.jumpImpulse;
  if (stamina > MOVE.staminaMax) stamina = MOVE.staminaMax;
  vz -= MOVE.gravity * 0.5 * dt; // FinishGravity inside CheckJumpButton (Source)
  onGround = false;
  groundEnt = -1;
  events |= EV_JUMP;
}

function duck(buttons) {
  const want = (buttons & IN_DUCK) !== 0;
  if (want && !(oldButtons & IN_DUCK)) {
    duckSpeed = Math.max(MOVE.duckSpeedMin, duckSpeed - MOVE.duckSpamPenalty);
  }
  duckSpeed = Math.min(MOVE.duckSpeedIdeal, duckSpeed + MOVE.duckSpeedRecovery * dt);

  if (want) {
    duckAmount = Math.min(1, duckAmount + dt * duckSpeed);
    if (hull === HULL_STAND) {
      if (!onGround) {
        // In air: shrink around a point so the feet rise crouchJumpRaise units.
        hull = HULL_DUCK;
        oz -= 18 - MOVE.crouchJumpRaise;
      } else if (duckAmount >= 1) {
        hull = HULL_DUCK;
        oz -= 18; // feet stay on the floor
      }
    }
    return;
  }

  if (hull === HULL_DUCK) {
    const dz = onGround ? 18 : 18 - MOVE.crouchJumpRaise;
    if (!hullFits(W, HULL_STAND, ox, oy, oz + dz)) {
      duckAmount = 1; // no room to stand
      return;
    }
    // Room to stand: the hull grows now and the view rises with the amount (the eye
    // cannot rise above a ducked hull, so waiting for the amount held it down, then popped it up).
    duckAmount = Math.max(0, duckAmount - dt * duckSpeed);
    hull = HULL_STAND;
    oz += dz;
  } else {
    duckAmount = Math.max(0, duckAmount - dt * duckSpeed);
  }
}

// Nudges a stuck player out of solid geometry (GoldSrc PM_CheckStuck, simplified).
function unstick() {
  if (hullFits(W, hull, ox, oy, oz)) return;
  for (let r = 1; r <= 18; r++) {
    for (let k = 0; k < 7; k++) {
      const dx = k === 1 ? r : k === 2 ? -r : 0;
      const dy = k === 3 ? r : k === 4 ? -r : 0;
      const dz = k === 0 ? r : k === 5 ? -r : 0;
      if (k === 6) continue;
      if (hullFits(W, hull, ox + dx, oy + dy, oz + dz)) {
        ox += dx; oy += dy; oz += dz;
        return;
      }
    }
  }
}

// GoldSrc SV_CheckMovingGround: standing on a conveyor sets the base velocity; once
// off it, the base velocity becomes real momentum (plus half a frame of it).
function checkMovingGround() {
  const e = onGround && groundEnt >= 0 ? W.ents[groundEnt] : null;
  if (e && (e.pushX !== 0 || e.pushY !== 0 || e.pushZ !== 0)) {
    bvx = e.pushX; bvy = e.pushY; bvz = e.pushZ;
    return;
  }
  const k = 1 + dt * 0.5;
  vx += bvx * k; vy += bvy * k; vz += bvz * k;
  bvx = bvy = bvz = 0;
}

// Runs one movement tick. pitch/yaw in degrees, maxSpeed = current weapon speed.
export function playerMove(world, ps, buttons, pitch, yaw, frametime, maxSpeed) {
  W = world;
  dt = frametime;
  const f = ps.f, i = ps.i;
  ox = f[PS_ORIGIN]; oy = f[PS_ORIGIN + 1]; oz = f[PS_ORIGIN + 2];
  vx = f[PS_VEL]; vy = f[PS_VEL + 1]; vz = f[PS_VEL + 2];
  const startVz = vz;
  duckAmount = f[PS_DUCK_AMOUNT];
  duckSpeed = f[PS_DUCK_SPEED];
  stamina = f[PS_STAMINA];
  fallVel = f[PS_FALL_VEL];
  ladderCooldown = f[PS_LADDER_COOLDOWN];
  flags = i[PS_FLAGS];
  waterLevel = i[PS_WATERLEVEL];
  oldButtons = i[PS_OLDBUTTONS];
  groundEnt = i[PS_GROUNDENT];
  bvx = f[PS_BASEVEL]; bvy = f[PS_BASEVEL + 1]; bvz = f[PS_BASEVEL + 2];
  onGround = (flags & FL_ONGROUND) !== 0;
  hull = (flags & FL_DUCKING) ? HULL_DUCK : HULL_STAND;
  events = 0;
  landSpeed = 0;
  touchedCount = 0;

  // View axes.
  const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG);
  const sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
  fx = cp * cy; fy = cp * sy; fz = -sp;
  rx = sy; ry = -cy;

  fmove = ((buttons & IN_FORWARD) ? MOVE.forwardSpeed : 0) - ((buttons & IN_BACK) ? MOVE.forwardSpeed : 0);
  smove = ((buttons & IN_MOVERIGHT) ? MOVE.forwardSpeed : 0) - ((buttons & IN_MOVELEFT) ? MOVE.forwardSpeed : 0);

  unstick();
  checkMovingGround();
  if (!onGround) fallVel = -vz;

  stamina -= MOVE.staminaRecoveryRate * dt;
  if (stamina < 0) stamina = 0;

  duck(buttons);

  let scale = (buttons & IN_SPEED) ? MOVE.walkModifier : 1;
  if (onGround && duckAmount > 0) scale += (MOVE.duckModifier - scale) * duckAmount;
  // Tagging: being shot caps our speed, recovering over time.
  let velmod = f[PS_VELMOD] + VELMOD_RECOVERY * dt;
  if (velmod > 1) velmod = 1;
  f[PS_VELMOD] = velmod;
  maxspeed = maxSpeed * scale * velmod;

  ladderCooldown = ladderCooldown > dt ? ladderCooldown - dt : 0;
  const ladder = ladderCooldown > 0 ? -1 : findLadder();
  if (ladder >= 0) {
    flags |= FL_ONLADDER;
    ladderMove(ladder, buttons);
    categorizePosition();
  } else {
    flags &= ~FL_ONLADDER;
    checkWater();
    if (waterLevel >= 2) {
      if (buttons & IN_JUMP) {
        setGround(false);
        vz = MOVE.waterJumpSpeed;
      }
      waterMove(buttons);
      categorizePosition();
      if (onGround) vz = 0;
    } else {
      vz -= MOVE.gravity * 0.5 * dt; // StartGravity
      if (buttons & IN_JUMP) checkJump();
      if (onGround) {
        vz = 0;
        if (stamina > 0) {
          const ratio = Math.pow((100 - stamina) / 100, dt * 70);
          vx *= ratio;
          vy *= ratio;
        }
        friction();
      }
      checkVelocity();
      if (onGround) walkMove();
      else airMove();
      categorizePosition();
      // Pull the base velocity back out: it moved us but is not our own velocity.
      vx -= bvx; vy -= bvy; vz -= bvz;
      checkVelocity();
      if (waterLevel < 2) vz -= MOVE.gravity * 0.5 * dt; // FinishGravity
      if (onGround) vz = 0;
      else if (startVz > 0 && vz <= 0) events |= EV_APEX;
    }
  }

  flags = (flags & ~(FL_ONGROUND | FL_DUCKING)) | (onGround ? FL_ONGROUND : 0) | (hull === HULL_DUCK ? FL_DUCKING : 0);
  f[PS_ORIGIN] = ox; f[PS_ORIGIN + 1] = oy; f[PS_ORIGIN + 2] = oz;
  f[PS_VEL] = vx; f[PS_VEL + 1] = vy; f[PS_VEL + 2] = vz;
  f[PS_DUCK_AMOUNT] = duckAmount;
  f[PS_DUCK_SPEED] = duckSpeed;
  f[PS_STAMINA] = stamina;
  f[PS_FALL_VEL] = fallVel;
  f[PS_LAND_SPEED] = landSpeed;
  f[PS_LADDER_COOLDOWN] = ladderCooldown;
  i[PS_FLAGS] = flags;
  i[PS_WATERLEVEL] = waterLevel;
  i[PS_OLDBUTTONS] = buttons;
  i[PS_EVENTS] = events;
  f[PS_BASEVEL] = bvx; f[PS_BASEVEL + 1] = bvy; f[PS_BASEVEL + 2] = bvz;
  i[PS_GROUNDENT] = groundEnt;
}
