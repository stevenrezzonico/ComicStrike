import assert from 'node:assert/strict';
import { TICK_DT, IN_ATTACK, IN_RELOAD, IN_SPEED } from '../shared/constants.js';
import { createPlayerState, PS_VEL, PS_FLAGS, FL_ONGROUND, FL_DUCKING } from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, ShotList, createWeaponState, giveWeapon,
  weaponTick, getInaccuracy, recoveryTime, UniformRandomStream, WS_ACTIVE, WS_SLOTS, WS_PUNCH, WS_EVENTS, WEV_FIRE, WEV_RELOADED,
  WEV_SHELL, WS_RELOAD_END, WEV_DRYFIRE, refillAmmo,
} from '../shared/weapons.js';

const DEG = Math.PI / 180;

function setup(...names) {
  const ws = createWeaponState();
  for (const n of names) giveWeapon(ws, WEAPON_ID[n]);
  ws.f[WS_ACTIVE] = WEAPONS[WEAPON_ID[names[0]]].slot;
  const ps = createPlayerState();
  ps.i[PS_FLAGS] = FL_ONGROUND;
  return { ws, ps, shots: new ShotList() };
}

// Runs ticks [from, from + n) with fixed buttons; returns shots fired and directions.
function hold(ctx, buttons, from, n, select = -1) {
  let fired = 0;
  const dirs = [];
  for (let t = from; t < from + n; t++) {
    weaponTick(ctx.ws, ctx.ps, buttons, t === from ? select : -1, 0, 0, t, ctx.shots);
    if (ctx.ws.f[WS_EVENTS] & WEV_FIRE) {
      fired++;
      dirs.push([...ctx.shots.dir.subarray(0, 3)]);
    }
  }
  return { fired, dirs };
}

const clip = (ctx, slot) => ctx.ws.f[WS_SLOTS + slot * 3 + 1];
const reserve = (ctx, slot) => ctx.ws.f[WS_SLOTS + slot * 3 + 2];

Deno.test('AK-47 fire rate quantizes to the 64-tick clock like CS:GO', () => {
  const ctx = setup('ak47');
  // 0.1 s cycle -> a shot every 7 ticks (0.109 s) at 64 tick.
  assert.equal(hold(ctx, IN_ATTACK, 1000, 64).fired, 10);
});

Deno.test('emptying the clip reloads by itself, no extra trigger pull', () => {
  for (const held of [IN_ATTACK, 0]) { // trigger still held after the last shot, or let go
    const ctx = setup('ak47');
    const ak = WEAPONS[WEAPON_ID.ak47];
    assert.equal(hold(ctx, IN_ATTACK, 1000, 7 * 29 + 1).fired, 30); // the 30th on the last tick
    assert.equal(clip(ctx, SLOT_PRIMARY), 0);
    let start = -1, reloaded = false;
    for (let t = 1204; t < 1204 + Math.ceil(ak.reloadTime / TICK_DT) + 10; t++) {
      weaponTick(ctx.ws, ctx.ps, held, -1, 0, 0, t, ctx.shots);
      if (start < 0 && ctx.ws.f[WS_RELOAD_END] > 0) start = t;
      if (ctx.ws.f[WS_EVENTS] & WEV_RELOADED) {
        reloaded = true;
        break;
      }
    }
    assert.equal(start, 1210, 'the reload starts when the last shot\'s cycle ends');
    assert.ok(reloaded);
    const firedAgain = (ctx.ws.f[WS_EVENTS] & WEV_FIRE) ? 1 : 0; // a held trigger fires in that tick
    assert.equal(clip(ctx, SLOT_PRIMARY) + firedAgain, 30);
    assert.equal(reserve(ctx, SLOT_PRIMARY), 60);
  }
  // Nothing left in reserve: the trigger dry-fires instead.
  const ctx = setup('ak47');
  ctx.ws.f[WS_SLOTS + SLOT_PRIMARY * 3 + 1] = 0;
  ctx.ws.f[WS_SLOTS + SLOT_PRIMARY * 3 + 2] = 0;
  weaponTick(ctx.ws, ctx.ps, IN_ATTACK, -1, 0, 0, 1000, ctx.shots);
  assert.ok(ctx.ws.f[WS_EVENTS] & WEV_DRYFIRE);
  assert.equal(ctx.ws.f[WS_RELOAD_END], 0);
});

Deno.test('a new round refills the survivors\' guns', () => {
  const ctx = setup('ak47', 'glock');
  hold(ctx, IN_ATTACK, 1000, 7 * 5 - 6); // 5 shots
  ctx.ws.f[WS_SLOTS + SLOT_SECONDARY * 3 + 2] = 3;
  refillAmmo(ctx.ws);
  assert.deepEqual([clip(ctx, SLOT_PRIMARY), reserve(ctx, SLOT_PRIMARY)], [30, 90]);
  const glock = WEAPONS[WEAPON_ID.glock];
  assert.deepEqual([clip(ctx, SLOT_SECONDARY), reserve(ctx, SLOT_SECONDARY)], [glock.clip, glock.reserve]);
  assert.equal(clip(ctx, SLOT_KNIFE), 0, 'the knife has no ammo');
});

Deno.test('manual reload keeps the remaining rounds', () => {
  const ctx = setup('ak47');
  hold(ctx, IN_ATTACK, 1000, 7 * 5 - 6); // 5 shots
  hold(ctx, 0, 2000, 4);
  hold(ctx, IN_RELOAD, 2010, Math.ceil(2.43 / TICK_DT) + 2);
  assert.equal(clip(ctx, SLOT_PRIMARY), 30);
  assert.equal(reserve(ctx, SLOT_PRIMARY), 85);
});

Deno.test('shotguns load shell by shell and stop loading to fire', () => {
  const ctx = setup('nova');
  const nova = WEAPONS[WEAPON_ID.nova];
  hold(ctx, 0, 990, 1);
  for (let t = 1000, n = 0; n < 3; t++) { // three shots, a trigger press each
    weaponTick(ctx.ws, ctx.ps, t % 2 ? 0 : IN_ATTACK, -1, 0, 0, t, ctx.shots);
    if (ctx.ws.f[WS_EVENTS] & WEV_FIRE) n++;
    if (t > 1300) throw new Error('did not fire');
  }
  assert.equal(clip(ctx, SLOT_PRIMARY), 5);
  const start = 1400;
  const shells = [];
  for (let t = start; t < start + 256; t++) {
    weaponTick(ctx.ws, ctx.ps, t === start ? IN_RELOAD : 0, -1, 0, 0, t, ctx.shots);
    if (ctx.ws.f[WS_EVENTS] & WEV_SHELL) shells.push((t - start) * TICK_DT);
  }
  assert.equal(shells.length, 3, 'one shell per missing round');
  assert.ok(Math.abs(shells[0] - (nova.reloadStart + nova.shellTime)) < 0.02);
  assert.ok(Math.abs(shells[1] - shells[0] - nova.shellTime) < 0.02);
  assert.equal(clip(ctx, SLOT_PRIMARY), 8);
  assert.equal(ctx.ws.f[WS_RELOAD_END], 0);

  // Fire twice, start loading, then pull the trigger after the first shell: it fires.
  hold(ctx, IN_ATTACK, 2000, 1);
  hold(ctx, 0, 2001, 80);
  hold(ctx, IN_ATTACK, 2081, 1);
  hold(ctx, 0, 2082, 80);
  assert.equal(clip(ctx, SLOT_PRIMARY), 6);
  hold(ctx, IN_RELOAD, 2200, 1);
  hold(ctx, 0, 2201, Math.ceil((nova.reloadStart + nova.shellTime) / TICK_DT) + 1);
  assert.equal(clip(ctx, SLOT_PRIMARY), 7);
  assert.equal(hold(ctx, IN_ATTACK, 2201 + Math.ceil((nova.reloadStart + nova.shellTime) / TICK_DT) + 1, 1).fired, 1);
  assert.equal(ctx.ws.f[WS_RELOAD_END], 0, 'the reload stopped');
  assert.equal(clip(ctx, SLOT_PRIMARY), 6);
});

Deno.test('semi-automatic pistols fire once per trigger press', () => {
  const ctx = setup('glock');
  assert.equal(hold(ctx, IN_ATTACK, 1000, 64).fired, 1);
  hold(ctx, 0, 1100, 1); // release
  let fired = 0;
  for (let k = 0; k < 6; k++) {
    fired += hold(ctx, IN_ATTACK, 2000 + k * 12, 1).fired; // tap every 12 ticks (> 0.15 s cycle)
    hold(ctx, 0, 2001 + k * 12, 11);
  }
  assert.equal(fired, 6);
});

Deno.test('switching weapons delays the first shot by the deploy time', () => {
  const ctx = setup('ak47', 'glock', 'knife');
  hold(ctx, 0, 1000, 1, SLOT_SECONDARY);
  assert.equal(ctx.ws.f[WS_ACTIVE], SLOT_SECONDARY);
  assert.equal(hold(ctx, IN_ATTACK, 1001, 60).fired, 0, 'fired while deploying');
  hold(ctx, 0, 1061, 1); // semi-auto: release before the next press
  assert.equal(hold(ctx, IN_ATTACK, 1070, 1).fired, 1, 'could not fire after deploying');
});

Deno.test('inaccuracy: standing < walking < running; crouching is best', () => {
  const ctx = setup('ak47');
  hold(ctx, 0, 1000, 64);
  const ak = WEAPONS[WEAPON_ID.ak47];
  const stand = getInaccuracy(ctx.ws, ctx.ps, 0);
  assert.ok(Math.abs(stand - ak.inaccuracyStand) < 1e-6, `stand ${stand}`);

  ctx.ps.f[PS_VEL] = 250 * 0.52;
  const walk = getInaccuracy(ctx.ws, ctx.ps, IN_SPEED);
  ctx.ps.f[PS_VEL] = 215;
  const run = getInaccuracy(ctx.ws, ctx.ps, 0);
  ctx.ps.f[PS_VEL] = 70; // counter-strafed below 34% of max speed
  const slow = getInaccuracy(ctx.ws, ctx.ps, 0);
  assert.ok(stand < walk && walk < run, `${stand} ${walk} ${run}`);
  assert.equal(slow, stand, 'below duck speed movement adds nothing');

  ctx.ps.f[PS_VEL] = 0;
  ctx.ps.i[PS_FLAGS] = FL_ONGROUND | FL_DUCKING;
  hold(ctx, 0, 2000, 64);
  assert.ok(getInaccuracy(ctx.ws, ctx.ps, 0) < stand);
});

Deno.test('spread is deterministic per tick and stays inside the cone', () => {
  const a = setup('ak47'), b = setup('ak47');
  const da = hold(a, IN_ATTACK, 5000, 64).dirs, db = hold(b, IN_ATTACK, 5000, 64).dirs;
  assert.deepEqual(da, db);
  // First shot: within stand inaccuracy + spread of the aim direction (+x).
  const ak = WEAPONS[WEAPON_ID.ak47];
  const off = Math.acos(da[0][0]);
  assert.ok(off <= ak.inaccuracyStand + ak.spread + 1e-9, `first shot off by ${off / DEG}°`);
});

Deno.test('spraying climbs, and the punch recovers once you stop', () => {
  const ctx = setup('ak47');
  const { dirs } = hold(ctx, IN_ATTACK, 1000, 7 * 10);
  const pitchUp = (d) => Math.asin(d[2]) / DEG;
  assert.ok(pitchUp(dirs[9]) > pitchUp(dirs[0]) + 3, `10th shot only ${pitchUp(dirs[9])}° up`);
  assert.ok(ctx.ws.f[WS_PUNCH] < -1, 'aim punch should point up');
  hold(ctx, 0, 2000, 96);
  assert.ok(Math.abs(ctx.ws.f[WS_PUNCH]) < 0.05 && Math.abs(ctx.ws.f[WS_PUNCH + 1]) < 0.05, 'punch did not recover');
});

Deno.test('recoil RNG is Valve\'s Park-Miller stream (published check value)', () => {
  // Park & Miller: from seed 1, the 10000th state is 1043618065. The stream runs 40
  // warm-up steps on its first call, then one per call.
  const r = new UniformRandomStream(1);
  for (let k = 0; k < 10000 - 40; k++) r.generateRandomNumber();
  assert.equal(r.idum, 1043618065);
});

// Aim-punch yaw (degrees, positive = right) at each shot of a full spray: the recoil
// pattern itself, without random spread.
function sprayPattern(name) {
  const ctx = setup(name);
  const w = WEAPONS[WEAPON_ID[name]];
  const xs = [];
  for (let t = 1000; xs.length < w.clip; t++) {
    weaponTick(ctx.ws, ctx.ps, IN_ATTACK, -1, 0, 0, t, ctx.shots);
    if (ctx.ws.f[WS_EVENTS] & WEV_FIRE) xs.push(-ctx.ws.f[WS_PUNCH + 1] * 2);
  }
  return xs;
}

Deno.test('spray patterns follow CS:GO\'s documented shapes', () => {
  // AK-47: climbs straight for the first shots, sweeps right, then back left.
  const ak = sprayPattern('ak47');
  assert.ok(Math.abs(ak[4]) < 1, `ak shot 5 x ${ak[4]}`);
  assert.ok(ak[14] > 2, `ak shot 15 x ${ak[14]}`);
  assert.ok(ak[19] < -1, `ak shot 20 x ${ak[19]}`);
  // Galil AR: drifts left while rising, then turns right.
  const galil = sprayPattern('galilar');
  assert.ok(galil[9] < -1 && galil[14] > 2, `galil ${galil[9]} ${galil[14]}`);
  // FAMAS: stays near the middle, then pulls left late in the spray.
  const famas = sprayPattern('famas');
  assert.ok(Math.abs(famas[9]) < 1 && famas[23] < -2, `famas ${famas[9]} ${famas[23]}`);
});

Deno.test('recovery slows between the transition bullets', () => {
  const ak = WEAPONS[WEAPON_ID.ak47];
  assert.equal(recoveryTime(ak, false, 0), ak.recoveryStand);
  assert.equal(recoveryTime(ak, false, 9), ak.recoveryStandFinal);
  const mid = recoveryTime(ak, false, 3.5); // bullets 2..5 -> one third of the way
  assert.ok(Math.abs(mid - (ak.recoveryStand + (ak.recoveryStandFinal - ak.recoveryStand) / 3)) < 1e-9);
  const p2000 = WEAPONS[WEAPON_ID.hkp2000]; // final == base: no transition
  assert.equal(recoveryTime(p2000, false, 20), p2000.recoveryStand);
});

Deno.test('every CS:GO gun builds from game data; shotguns fire pellets', () => {
  const guns = WEAPONS.filter((w) => w && w.gun);
  assert.equal(guns.length, 34);
  for (const w of guns) {
    assert.ok(w.cycle > 0 && w.clip > 0 && w.spread >= 0 && w.recoilPattern.every(Number.isFinite), w.name);
  }
  const ctx = setup('nova');
  hold(ctx, IN_ATTACK, 1000, 1);
  assert.equal(ctx.shots.count, 9);
});

Deno.test('knife swings without ammo at its cycle rate', () => {
  const ctx = setup('knife');
  const { fired } = hold(ctx, IN_ATTACK, 1000, 64);
  assert.equal(fired, 0, 'knife produces melee events, not bullets');
  let swings = 0;
  for (let t = 3000; t < 3064; t++) {
    weaponTick(ctx.ws, ctx.ps, IN_ATTACK, -1, 0, 0, t, ctx.shots);
    swings += ctx.shots.count;
  }
  assert.equal(swings, 3); // 0.4 s cycle -> ticks 0, 26, 52
  assert.equal(ctx.ws.f[WS_SLOTS + SLOT_KNIFE * 3 + 1], 0);
});
