// CS:GO's team rules (server/game.js): friendly fire and its shares, the grenade and the
// defuse kit the dead drop, assists (damage and flashes), the kill feed's wallbang mark, and
// the team limits (mp_limitteams, mp_autoteambalance), in a compiled yard.
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { Writer, KILL_PENETRATED, KILL_FLASH_ASSIST, NO_ASSIST } from '../shared/protocol.js';
import { WEAPONS, WEAPON_ID, giveWeapon, WS_ACTIVE, SLOT_PRIMARY } from '../shared/weapons.js';
import { HITGROUP_CHEST } from '../shared/hitgroups.js';
import { IN_ATTACK } from '../shared/constants.js';
import { GAME_FF, ITEM_DEFUSER } from '../shared/economy.js';
import { Game } from '../server/game.js';
import { yard, quiet, joinClient, runInputs, teleport } from './harness.js';

const bsp = yard(() => {});

function setup(rules = {}) {
  const g = quiet(() => new Game('test', bsp, { rounds: false, ...rules }));
  const w = new Writer(), list = [];
  const join = (name, team) => {
    const c = quiet(() => joinClient(g, w, name, team));
    c.input = { buttons: 0, pitch: 0, yaw: 0 };
    list.push(c);
    return c;
  };
  const run = (n) => runInputs(g, w, list, n);
  return { g, join, run };
}

// `shooter` fires one shot at `target` 120 units east of it (lineUp's aim at the chest).
function shoot(run, shooter, target, x = 0) {
  teleport(shooter, x, 0, 36);
  teleport(target, x + 120, 0, 36);
  shooter.input.yaw = 0;
  shooter.input.pitch = 8;
  run(80); // the pistol drawn, the aim settled
  shooter.input.buttons = IN_ATTACK;
  run(1);
  shooter.input.buttons = 0;
  run(1);
}

Deno.test('friendly fire: off, a teammate takes nothing; on, the bullets\' share of an enemy\'s damage', () => {
  const off = setup();
  const a = off.join('a', TEAM_T), mate = off.join('mate', TEAM_T);
  shoot(off.run, a, mate);
  assert.equal(mate.player.health, 100, 'no friendly fire');
  const on = setup({ friendlyFire: true, ffBullets: 0.33 });
  const s = on.join('s', TEAM_T), m = on.join('m', TEAM_T), e = on.join('e', TEAM_CT);
  shoot(on.run, s, e, -400);
  const full = 100 - e.player.health;
  assert.ok(full > 10, `the enemy took ${full}`);
  shoot(on.run, s, m, 400);
  const part = 100 - m.player.health;
  assert.ok(Math.abs(part - full * 0.33) <= 1.5, `a teammate took ${part} of ${full}`);
  on.run(1);
  assert.ok(on.g.round.mode & GAME_FF, 'the clients are told');
});

Deno.test('friendly fire: grenades by their share, the thrower\'s own by ff_damage_reduction_grenade_self', () => {
  const he = WEAPON_ID.hegrenade;
  const { g, join } = setup({ friendlyFire: true, ffGrenade: 0.85, ffGrenadeSelf: 0.5 });
  const a = join('a', TEAM_T), mate = join('mate', TEAM_T);
  g.hurtBy(mate, 40, a, he, 0, 0, 0, WEAPONS[he], HITGROUP_CHEST);
  assert.equal(mate.player.health, 100 - 34, '0.85 of 40');
  g.hurtBy(a, 40, a, he, 0, 0, 0, WEAPONS[he], HITGROUP_CHEST);
  assert.equal(a.player.health, 100 - 20, 'half of his own');
  const off = setup();
  const b = off.join('b', TEAM_T), m2 = off.join('m2', TEAM_T);
  off.g.hurtBy(m2, 40, b, he, 0, 0, 0, WEAPONS[he], HITGROUP_CHEST);
  assert.equal(m2.player.health, 100, 'off: nothing');
});

Deno.test('death drops: the best grenade (or the one in hand) and a CT\'s kit; only a CT without one takes it', () => {
  const { g, join, run } = setup();
  const t = join('t', TEAM_T), ct = join('ct', TEAM_CT), ct2 = join('ct2', TEAM_CT);
  teleport(t, -600, 300, 36);
  teleport(ct2, 600, 300, 36);
  giveWeapon(ct.player.ws, WEAPON_ID.flashbang);
  giveWeapon(ct.player.ws, WEAPON_ID.hegrenade);
  ct.player.defuser = true;
  teleport(ct, 0, 0, 36);
  g.kill(t, ct, WEAPON_ID.glock, false);
  run(64); // they land
  const items = () => Array.from(g.items.weapon.subarray(0, g.items.count));
  assert.ok(items().includes(WEAPON_ID.hegrenade), 'the HE, worth more than the flashbang');
  assert.ok(!items().includes(WEAPON_ID.flashbang));
  const k = items().indexOf(ITEM_DEFUSER);
  assert.ok(k >= 0, 'the kit');
  assert.ok(!ct.player.defuser);
  const at = (c) => teleport(c, g.items.x[k], g.items.y[k], g.items.z[k] + 36);
  at(t);
  run(2);
  assert.ok(items().includes(ITEM_DEFUSER), 'a T leaves it');
  teleport(t, -600, 300, 36);
  at(ct2);
  run(2);
  assert.ok(ct2.player.defuser && !items().includes(ITEM_DEFUSER), 'a CT takes it');
  const none = setup({ deathDropGrenade: 0, deathDropDefuser: false });
  const a = none.join('a', TEAM_T), b = none.join('b', TEAM_CT);
  giveWeapon(b.player.ws, WEAPON_ID.hegrenade);
  b.player.defuser = true;
  none.g.kill(a, b, WEAPON_ID.glock, false);
  const left = Array.from(none.g.items.weapon.subarray(0, none.g.items.count));
  assert.ok(!left.includes(WEAPON_ID.hegrenade) && !left.includes(ITEM_DEFUSER), 'turned off');
});

Deno.test('assists: over 40 damage from the killer\'s teammate this life, else his flashbang still blinding', () => {
  const ak = WEAPON_ID.ak47;
  const { g, join } = setup();
  const killer = join('killer', TEAM_T), helper = join('helper', TEAM_T), victim = join('victim', TEAM_CT);
  const lastKill = () => {
    const e = g.events, k = e.kills - 1;
    return { assist: e.killAssist[k], flags: e.killFlags[k] };
  };
  g.hurtBy(victim, 41, helper, ak, 0, 0, 0, WEAPONS[ak], HITGROUP_CHEST);
  g.kill(killer, victim, ak, false);
  assert.equal(lastKill().assist, helper.id);
  assert.equal(lastKill().flags & KILL_FLASH_ASSIST, 0);
  assert.equal(helper.player.assists, 1);
  assert.equal(killer.player.assists, 0);
  g.respawn(victim);
  g.hurtBy(victim, 40, helper, ak, 0, 0, 0, WEAPONS[ak], HITGROUP_CHEST);
  g.kill(killer, victim, ak, false);
  assert.equal(lastKill().assist, NO_ASSIST, '40 is not enough');
  g.respawn(victim);
  victim.flashLeft = 2;
  victim.flashedBy = helper.id;
  g.kill(killer, victim, ak, false);
  assert.equal(lastKill().assist, helper.id, 'a flash assist');
  assert.ok(lastKill().flags & KILL_FLASH_ASSIST);
  assert.equal(helper.player.assists, 2);
  g.respawn(victim);
  assert.equal(victim.flashedBy, -1, 'a new life starts clean');
  assert.equal(victim.lifeTaken[helper.id], 0);
});

Deno.test('kill feed: a kill through another body is marked penetrated', () => {
  const { g, join, run } = setup();
  const a = join('a', TEAM_T), front = join('front', TEAM_CT), back = join('back', TEAM_CT);
  giveWeapon(a.player.ws, WEAPON_ID.ak47);
  a.player.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  teleport(a, 0, 0, 36);
  teleport(front, 100, 0, 36);
  teleport(back, 160, 0, 36);
  back.player.health = 1;
  a.input.pitch = 8;
  run(80);
  a.input.buttons = IN_ATTACK;
  run(1);
  a.input.buttons = 0;
  assert.ok(front.player.health < 100, 'the front one hit');
  assert.ok(!back.alive, 'the one behind killed');
  assert.ok(g.events.killFlags[g.events.kills - 1] & KILL_PENETRATED);
  assert.ok(Math.abs(back.player.ps.f[PS_ORIGIN] - 160) < 1);
});

Deno.test('team limits: a third T goes CT, a switch that stacks is refused; the round start evens teams out', () => {
  const { g, join } = setup({ limitTeams: 2 });
  const a = join('a', TEAM_T);
  join('b', TEAM_T);
  const c = join('c', TEAM_T);
  assert.equal(a.team, TEAM_T);
  assert.equal(c.team, TEAM_CT, 'three against none is two too many');
  const said = [];
  c.session = { send: () => said.push(1), close() {} };
  g.joinTeam(c, 2);
  assert.equal(c.team, TEAM_CT, 'refused');
  const bal = setup({ rounds: true, autoTeamBalance: true });
  const x = bal.join('x', TEAM_T), y = bal.join('y', TEAM_T), z = bal.join('z', TEAM_T);
  quiet(() => bal.g.startRound(false));
  assert.deepEqual([x.team, y.team, z.team], [TEAM_T, TEAM_T, TEAM_CT], 'the newest moved over');
  assert.ok(z.alive, 'and plays the round there');
});
