import assert from 'node:assert/strict';
import { TICK_DT, IN_ATTACK, IN_ATTACK2 } from '../shared/constants.js';
import { createPlayerState, PS_FLAGS, FL_ONGROUND } from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_GRENADE, ShotList, createWeaponState, giveWeapon,
  weaponTick, getInaccuracy, weaponStats, silenced, grenadeCount, grenadeTotal, WS_ACTIVE, WS_SLOTS, WS_EVENTS,
  WS_ZOOM, WS_THROWN, WS_LAST_SLOT, WEV_FIRE, WEV_THROW, WEV_PIN, WEV_MODE, THROW_LONG, THROW_SHORT, THROW_MEDIUM,
  SILENCER_TIME, REVOLVER_COCK,
} from '../shared/weapons.js';

function setup(...names) {
  const ws = createWeaponState();
  for (const n of names) giveWeapon(ws, WEAPON_ID[n]);
  ws.f[WS_ACTIVE] = WEAPONS[WEAPON_ID[names[0]]].slot;
  const ps = createPlayerState();
  ps.i[PS_FLAGS] = FL_ONGROUND;
  return { ws, ps, shots: new ShotList(), t: 1000 };
}

// Runs n ticks with these buttons; returns the ticks (relative to the start) that fired
// and the events seen.
function run(ctx, buttons, n = 1, select = -1) {
  const start = ctx.t, fired = [];
  let events = 0;
  for (let i = 0; i < n; i++, ctx.t++) {
    weaponTick(ctx.ws, ctx.ps, buttons, i === 0 ? select : -1, 0, 0, ctx.t, ctx.shots);
    events |= ctx.ws.f[WS_EVENTS];
    if (ctx.ws.f[WS_EVENTS] & WEV_FIRE) fired.push(ctx.t - start);
  }
  return { fired, events };
}

const clip = (ctx, slot) => ctx.ws.f[WS_SLOTS + slot * 3 + 1];

Deno.test('scopes: right click cycles the zoom levels; scoped is accurate and slow; the AWP bolt unscopes', () => {
  const ctx = setup('awp');
  const awp = WEAPONS[WEAPON_ID.awp];
  run(ctx, 0, 10);
  const unscoped = getInaccuracy(ctx.ws, ctx.ps, 0);
  run(ctx, IN_ATTACK2);
  assert.ok(getInaccuracy(ctx.ws, ctx.ps, 0) > unscoped / 2, 'a quick scope is still inaccurate');
  run(ctx, 0, 64);
  assert.equal(ctx.ws.f[WS_ZOOM], 1);
  assert.ok(getInaccuracy(ctx.ws, ctx.ps, 0) < unscoped / 10, 'settled in the scope: far more accurate');
  assert.equal(weaponStats(ctx.ws).maxSpeed, 100, 'scoped AWP walks at 100');
  run(ctx, IN_ATTACK2);
  run(ctx, 0, 30);
  assert.equal(ctx.ws.f[WS_ZOOM], 2);
  run(ctx, IN_ATTACK2);
  run(ctx, 0, 30);
  assert.equal(ctx.ws.f[WS_ZOOM], 0, 'third click: out');
  // Scope, fire: out of the scope for the bolt, back in when it closes.
  run(ctx, IN_ATTACK2);
  run(ctx, 0, 30);
  assert.equal(run(ctx, IN_ATTACK).fired.length, 1);
  assert.equal(ctx.ws.f[WS_ZOOM], 0);
  run(ctx, 0, Math.ceil(awp.cycle / TICK_DT) + 1);
  assert.equal(ctx.ws.f[WS_ZOOM], 1);
  // The G3SG1 stays scoped while it fires.
  const g3 = setup('g3sg1');
  run(g3, IN_ATTACK2);
  run(g3, 0, 30);
  run(g3, IN_ATTACK);
  assert.equal(g3.ws.f[WS_ZOOM], 1);
});

Deno.test('burst fire: the Glock and FAMAS fire three-round bursts in alt mode', () => {
  for (const name of ['glock', 'famas']) {
    const ctx = setup(name);
    const w = WEAPONS[WEAPON_ID[name]];
    assert.equal(run(ctx, IN_ATTACK2).events & WEV_MODE, WEV_MODE);
    run(ctx, 0, 30);
    const cycleTicks = Math.ceil(w.burstCycle / TICK_DT);
    const { fired } = run(ctx, IN_ATTACK, 1);
    const rest = run(ctx, 0, cycleTicks - 2).fired.map((t) => t + 1);
    const all = [...fired, ...rest];
    assert.equal(all.length, 3, `${name}: three shots from one click`);
    assert.ok(Math.abs((all[1] - all[0]) * TICK_DT - w.burstGap) < TICK_DT + 1e-9, `${name}: burst spacing`);
    assert.equal(clip(ctx, w.slot), w.clip - 3);
    // The next burst waits for the burst cycle.
    assert.equal(run(ctx, IN_ATTACK).fired.length, 0);
    run(ctx, 0, 1);
    assert.equal(run(ctx, IN_ATTACK).fired.length, 1);
  }
});

Deno.test('silencers: the M4A1-S and USP-S start silenced; taking one off takes time and changes the stats', () => {
  const ctx = setup('m4a1_silencer', 'usp_silencer');
  assert.ok(silenced(ctx.ws, SLOT_PRIMARY) && silenced(ctx.ws, SLOT_SECONDARY));
  const on = weaponStats(ctx.ws);
  run(ctx, IN_ATTACK2);
  assert.equal(run(ctx, IN_ATTACK, 60).fired.length, 0, 'no shooting while the silencer comes off');
  assert.ok(silenced(ctx.ws, SLOT_PRIMARY));
  run(ctx, 0, Math.ceil(SILENCER_TIME / TICK_DT));
  assert.ok(!silenced(ctx.ws, SLOT_PRIMARY));
  assert.notEqual(weaponStats(ctx.ws), on);
  assert.ok(weaponStats(ctx.ws).spread > on.spread, 'the unsilenced M4A1-S spreads more');
  assert.equal(run(ctx, IN_ATTACK).fired.length, 1);
  assert.ok(silenced(ctx.ws, SLOT_SECONDARY), 'the pistol keeps its own silencer');
});

Deno.test('revolver: the hammer delays primary fire; right click fans at once', () => {
  const ctx = setup('revolver');
  const { fired } = run(ctx, IN_ATTACK, 30);
  assert.deepEqual(fired, [Math.ceil(REVOLVER_COCK / TICK_DT)]);
  run(ctx, 0, 64);
  assert.deepEqual(run(ctx, IN_ATTACK2, 1).fired, [0], 'fanning fires on the click');
  // Letting go before the hammer falls fires nothing.
  run(ctx, 0, 64);
  run(ctx, IN_ATTACK, 5);
  assert.equal(run(ctx, 0, 30).fired.length, 0);
});

Deno.test('grenades: CS:GO carry limits; pull the pin, let go, it flies; the next one comes up', () => {
  const ctx = setup('knife');
  const flash = WEAPON_ID.flashbang, he = WEAPON_ID.hegrenade;
  for (const id of [flash, flash, flash, he, WEAPON_ID.smokegrenade, WEAPON_ID.decoy]) giveWeapon(ctx.ws, id);
  assert.equal(grenadeCount(ctx.ws, flash), 2, 'two flashbangs at most');
  assert.equal(grenadeTotal(ctx.ws), 4, 'four grenades at most');
  assert.equal(grenadeCount(ctx.ws, WEAPON_ID.decoy), 0);

  run(ctx, 0, 1, SLOT_GRENADE);
  assert.equal(ctx.ws.f[WS_SLOTS + SLOT_GRENADE * 3], flash, 'the first grenade bought comes up');
  run(ctx, 0, 1, SLOT_GRENADE); // 4 again: the next kind
  assert.notEqual(ctx.ws.f[WS_SLOTS + SLOT_GRENADE * 3], flash);
  while (ctx.ws.f[WS_SLOTS + SLOT_GRENADE * 3] !== he) run(ctx, 0, 1, SLOT_GRENADE);
  run(ctx, 0, 64);
  assert.equal(run(ctx, IN_ATTACK).events & WEV_PIN, WEV_PIN);
  run(ctx, IN_ATTACK | IN_ATTACK2, 10); // both buttons: medium
  assert.equal(run(ctx, IN_ATTACK2, 10).events & WEV_THROW, 0, 'held: still in the hand');
  const { events } = run(ctx, 0, 10);
  assert.equal(events & WEV_THROW, WEV_THROW);
  assert.equal(ctx.ws.f[WS_THROWN], he * 4 + THROW_SHORT, 'the strength when let go');
  assert.equal(grenadeCount(ctx.ws, he), 0);
  assert.equal(ctx.ws.f[WS_ACTIVE], SLOT_GRENADE, 'another grenade comes up');
  assert.notEqual(ctx.ws.f[WS_SLOTS + SLOT_GRENADE * 3], he);
  // Throw everything left: back to the knife.
  while (grenadeTotal(ctx.ws) > 0) {
    run(ctx, 0, 64);
    run(ctx, IN_ATTACK, 3);
    run(ctx, 0, 10);
  }
  assert.equal(ctx.ws.f[WS_ACTIVE], WEAPONS[WEAPON_ID.knife].slot);
  assert.equal(ctx.ws.f[WS_SLOTS + SLOT_GRENADE * 3], 0);
  assert.equal(ctx.ws.f[WS_THROWN] & 3, THROW_LONG);
  assert.ok(THROW_MEDIUM > THROW_SHORT && ctx.ws.f[WS_LAST_SLOT] !== SLOT_GRENADE);
});
