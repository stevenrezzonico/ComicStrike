import assert from 'node:assert/strict';
import { TICK_DT, IN_ATTACK, IN_RELOAD, IN_SPEED } from '../shared/constants.js';
import { createPlayerState, PS_VEL, PS_FLAGS, FL_ONGROUND, FL_DUCKING } from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, ShotList, createWeaponState, giveWeapon,
  weaponTick, getInaccuracy, WS_ACTIVE, WS_SLOTS, WS_PUNCH, WS_EVENTS, WEV_FIRE, WEV_RELOADED,
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

Deno.test('emptying the clip auto-reloads on the next trigger pull', () => {
  const ctx = setup('ak47');
  const ak = WEAPONS[WEAPON_ID.ak47];
  assert.equal(hold(ctx, IN_ATTACK, 1000, 7 * 30 + 3).fired, 30);
  assert.equal(clip(ctx, SLOT_PRIMARY), 0);
  let reloaded = false;
  // One trigger pull on the empty clip starts the reload; then let go.
  for (let t = 1300; t < 1300 + Math.ceil(ak.reloadTime / TICK_DT) + 2; t++) {
    weaponTick(ctx.ws, ctx.ps, t === 1300 ? IN_ATTACK : 0, -1, 0, 0, t, ctx.shots);
    if (ctx.ws.f[WS_EVENTS] & WEV_RELOADED) reloaded = true;
  }
  assert.ok(reloaded);
  assert.equal(clip(ctx, SLOT_PRIMARY), 30);
  assert.equal(reserve(ctx, SLOT_PRIMARY), 60);
});

Deno.test('manual reload keeps the remaining rounds', () => {
  const ctx = setup('ak47');
  hold(ctx, IN_ATTACK, 1000, 7 * 5 - 6); // 5 shots
  hold(ctx, 0, 2000, 4);
  hold(ctx, IN_RELOAD, 2010, Math.ceil(2.43 / TICK_DT) + 2);
  assert.equal(clip(ctx, SLOT_PRIMARY), 30);
  assert.equal(reserve(ctx, SLOT_PRIMARY), 85);
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
