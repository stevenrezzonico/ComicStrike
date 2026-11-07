// Casual, Wingman, Arms Race and Demolition (game_type / game_mode 0/0, 0/2, 1/0, 1/1):
// their cfgs, Wingman's team cap and single bomb site, halftime, and the gun game modes'
// weapon progressions (shared/progression.js).
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import {
  WEAPON_ID, WS_SLOTS, WS_ACTIVE, WS_GRENADES, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, SLOT_C4, SLOT_GRENADE,
  createWeaponState, giveWeapon, activeWeapon,
} from '../shared/weapons.js';
import {
  PHASE_OVER, END_MATCH, GAME_ARMSRACE, GAME_DEMOLITION, GAME_WINGMAN, ITEM_KEVLAR,
} from '../shared/economy.js';
import { ARMS_RACE, DEMOLITION, levelWeapon, armLevel } from '../shared/progression.js';
import { mapOrNull, modeServer as setup, lineUp, fireUntil, loadMap, readCfg, quiet } from './harness.js';
import { MODES, modeOfBits, modeNamed } from '../shared/modes.js';
import { Host } from '../server/host.js';

const haveMap = !!mapOrNull('de_dust2');

const slot = (c, s) => c.player.ws.f[WS_SLOTS + s * 3];

Deno.test('progression: a weapon per level and team; arming leaves the knife, that weapon and the C4', () => {
  assert.equal(ARMS_RACE.at(-1), 'knife', 'Arms Race ends on the knife');
  assert.equal(levelWeapon(ARMS_RACE, 5, true), WEAPON_ID.m4a1);
  assert.equal(levelWeapon(ARMS_RACE, 5, false), WEAPON_ID.ak47);
  assert.equal(levelWeapon(DEMOLITION, 99, false), WEAPON_ID.glock, 'past the end: the last level');
  for (const list of [ARMS_RACE, DEMOLITION]) {
    for (let i = 0; i < list.length; i++) for (const ct of [true, false]) assert.ok(levelWeapon(list, i, ct), `${list}[${i}]`);
  }
  const ws = createWeaponState();
  for (const n of ['knife', 'glock', 'awp', 'hegrenade', 'flashbang', 'c4']) giveWeapon(ws, WEAPON_ID[n]);
  armLevel(ws, ARMS_RACE, 1, true);
  const f = ws.f;
  assert.equal(f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.p90);
  assert.equal(f[WS_ACTIVE], SLOT_PRIMARY, 'in hand');
  assert.equal(f[WS_SLOTS + SLOT_SECONDARY * 3], 0);
  assert.equal(f[WS_SLOTS + SLOT_GRENADE * 3], 0);
  assert.ok(f.slice(WS_GRENADES, WS_GRENADES + 6).every((n) => n === 0), 'no grenades');
  assert.equal(f[WS_SLOTS + SLOT_KNIFE * 3], WEAPON_ID.knife);
  assert.equal(f[WS_SLOTS + SLOT_C4 * 3], WEAPON_ID.c4, 'the bomb stays');
  armLevel(ws, ARMS_RACE, ARMS_RACE.length - 1, false, 10);
  assert.ok(activeWeapon(ws).melee, 'the last level: the knife in hand');
  assert.equal(f[WS_SLOTS + SLOT_PRIMARY * 3], 0);
});

Deno.test({ name: 'casual and wingman: their cfgs load; competitive resets halftime and the team cap', ignore: !haveMap, fn: () => {
  const { host } = setup([0, 0]);
  let r = host.game.rules;
  assert.equal(host.modeName, 'casual');
  assert.ok(r.maxRounds === 15 && !r.halftime && r.freeArmor && r.startMoney === 1000 && r.maxMoney === 10000);
  assert.equal(r.roundTime, 135, 'mp_roundtime_defuse 2.25');
  host.con.exec('game_type 0; game_mode 2; map de_dust2');
  r = host.game.rules;
  assert.equal(host.modeName, 'wingman');
  assert.ok(r.wingman && r.halftime && r.maxRounds === 16 && r.teamSizeMax === 2);
  assert.deepEqual(host.game.bombSites.names, ['B'], 'one bomb site');
  host.con.exec('game_type 0; game_mode 1; map de_dust2');
  r = host.game.rules;
  assert.ok(!r.wingman && r.halftime && r.teamSizeMax === 0);
  assert.equal(host.game.bombSites.count, 2);
} });

Deno.test({ name: 'wingman: two a side; a third goes to the other team, a fifth watches; bots fill to 4', ignore: !haveMap, fn: () => {
  const { host, join, run } = setup([0, 2]);
  const g = host.game;
  const p = [join('a', TEAM_T), join('b', TEAM_T), join('c', TEAM_T), join('d', TEAM_T), join('e', TEAM_CT)];
  run(2);
  assert.deepEqual(p.map((c) => c.team), [TEAM_T, TEAM_T, TEAM_CT, TEAM_CT, TEAM_SPECTATOR]);
  g.joinTeam(p[4], 2);
  assert.equal(p[4].team, TEAM_SPECTATOR, 'the Terrorists are full');
  g.disconnect(p[3]);
  g.joinTeam(p[4], 3);
  assert.equal(p[4].team, TEAM_CT, 'room again');
  for (const c of p) if (c.joined) g.disconnect(c);
  host.con.exec('bot_quota_mode fill; bot_quota 10');
  run(16 * 12);
  assert.equal(g.bots.list.length, 4, 'bot_quota 10 stops at two a side');
  assert.equal(g.round.mode & GAME_WINGMAN, GAME_WINGMAN);
} });

Deno.test({ name: 'halftime: competitive swaps sides at half time, casual (mp_halftime 0) does not', ignore: !haveMap, fn: () => {
  for (const [mode, swaps] of [[[0, 1], true], [[0, 0], false]]) {
    const { host, join, run, live } = setup(mode);
    const a = join('a', TEAM_T);
    join('b', TEAM_CT);
    run(2);
    live();
    const g = host.game;
    g.roundsPlayed = Math.floor(g.rules.maxRounds / 2);
    g.round.phase = PHASE_OVER;
    g.phaseEnd = g.tick;
    run(1);
    assert.equal(a.team, swaps ? TEAM_CT : TEAM_T, host.modeName);
  }
} });

Deno.test({ name: 'arms race: no buying; each kill gives the next weapon at once; the knife steals a level', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup([1, 0]);
  const a = join('alpha', TEAM_CT), b = join('bravo', TEAM_T);
  run(2);
  live();
  const g = host.game;
  assert.equal(host.modeName, 'armsrace');
  assert.equal(g.round.mode & GAME_ARMSRACE, GAME_ARMSRACE);
  assert.equal(g.bombCarrier, null);
  assert.equal(slot(a, SLOT_PRIMARY), WEAPON_ID.mp7, 'level 1');
  assert.equal(slot(a, SLOT_SECONDARY), 0, 'no pistol');
  assert.ok(!g.canBuy(a));
  const money = a.player.money;
  a.buy(ITEM_KEVLAR);
  assert.equal(a.player.money, money, 'buying does nothing');
  lineUp(g, a, b);
  fireUntil(run, a, () => !b.alive);
  assert.ok(!b.alive);
  assert.equal(a.level, 1);
  assert.equal(a.player.score, 1, 'the score shows the level');
  assert.equal(slot(a, SLOT_PRIMARY), WEAPON_ID.p90, 'the next weapon at once');
  assert.equal(a.player.ws.f[WS_ACTIVE], SLOT_PRIMARY);
  run(3 * 64);
  assert.ok(b.alive, 'respawned');
  assert.equal(slot(b, SLOT_PRIMARY), WEAPON_ID.mp7);
  // A knife kill takes a level from the victim.
  b.level = 4;
  g.kill(a, b, WEAPON_ID.knife, false);
  assert.equal(b.level, 3);
  assert.equal(a.level, 2);
} });

Deno.test({ name: 'arms race: a kill with the last weapon, the knife, wins the match', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup([1, 0]);
  const a = join('alpha', TEAM_CT), b = join('bravo', TEAM_T);
  run(2);
  live();
  const g = host.game;
  a.level = ARMS_RACE.length - 1;
  g.kill(a, b, WEAPON_ID.knife, false);
  assert.equal(g.round.phase, PHASE_OVER);
  assert.equal(g.round.info >> 2, END_MATCH);
  assert.ok(a.player.score > b.player.score, 'the winner tops the scores');
  run(16 * 64);
  assert.equal(a.level, 0, 'a new match starts from the first weapon');
  assert.equal(slot(a, SLOT_PRIMARY), WEAPON_ID.mp7);
} });

Deno.test({ name: 'demolition: everyone starts on the first weapon; a round with a kill gives the next', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup([1, 1]);
  const a = join('alpha', TEAM_CT), b = join('bravo', TEAM_T), c = join('charlie', TEAM_T);
  run(2);
  live();
  const g = host.game;
  assert.equal(g.round.mode & GAME_DEMOLITION, GAME_DEMOLITION);
  assert.equal(slot(a, SLOT_PRIMARY), WEAPON_ID.m4a1);
  assert.equal(slot(b, SLOT_PRIMARY), WEAPON_ID.ak47);
  assert.ok(g.bombCarrier === b || g.bombCarrier === c, 'a bomb round');
  assert.ok(!g.canBuy(a));
  lineUp(g, a, b);
  fireUntil(run, a, () => !b.alive);
  assert.ok(!b.alive);
  assert.equal(slot(a, SLOT_PRIMARY), WEAPON_ID.m4a1, 'the next weapon waits for the next round');
  g.kill(c, c, 0, false); // the last T: the round ends
  for (let i = 0; i < 64 * 10 && g.round.round < 2; i++) run(1);
  assert.equal(g.round.round, 2);
  assert.equal(a.level, 1);
  assert.equal(slot(a, SLOT_PRIMARY), WEAPON_ID.famas, 'a kill last round: the next weapon');
  assert.equal(slot(b, SLOT_PRIMARY), WEAPON_ID.ak47, 'no kill: the same');
} });

// shared/modes.js holds what server, clients and menus each know of a mode: a mode picked by
// game_type / game_mode runs its cfg and sets its rule, the round block carries its bit, and
// a client reads the same row (its facts) back from those bits.
Deno.test('modes: each row runs its cfg and rule; the client reads the same facts back from the round bits', () => {
  for (const m of MODES) {
    const host = new Host({ loadMap, listMaps: () => ['de_playground'], readCfg, print: () => {} });
    const [type, mode, flags = 0] = m.key.split('/');
    quiet(() => {
      host.con.exec(`game_type ${type}; game_mode ${mode}; sv_game_mode_flags ${flags}`);
      host.start('de_playground');
      host.game.step();
    });
    assert.equal(host.modeName, m.name);
    assert.notEqual(readCfg(`gamemode_${m.name}.cfg`), null, `cfg/gamemode_${m.name}.cfg`);
    assert.equal(host.game.mode, m.rule ? m : modeNamed('competitive')); // casual plays as competitive, by its cfg
    if (m.rule) assert.equal(host.game.rules[m.rule], true);
    const back = modeOfBits(host.game.round.mode);
    assert.equal(back, m.bit ? m : modeNamed('competitive'), m.name);
    for (const k of ['respawns', 'free', 'earned', 'oneSite', 'ladder']) assert.equal(back[k], m[k], `${m.name}: ${k}`);
    // The client's bot takeover rule (respawns) and the server's (the mode cfg's respawn cvars).
    assert.equal(host.game.rules.respawnT && host.game.rules.respawnCT, m.respawns, `${m.name}: respawning`);
  }
});
