import assert from 'node:assert/strict';
import { IN_ATTACK, TICK_RATE } from '../shared/constants.js';
import { PS_ORIGIN, eyeOffset } from '../shared/pmove.js';
import { traceHull, Trace, HULL_POINT } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { WEAPON_ID, WS_SLOTS, SLOT_PRIMARY } from '../shared/weapons.js';
import {
  PHASE_WARMUP, PHASE_LIVE, PHASE_OVER, END_MATCH, GAME_FFA, GAME_DM, DM_KILL_POINTS, DM_RESPAWN,
} from '../shared/economy.js';
import { mapOrNull, modeServer, teleport, lineUp, fireUntil } from './harness.js';

const haveMap = !!mapOrNull('de_dust2');

// A deathmatch server on de_dust2 (the real cfg/gamemode_deathmatch.cfg), with `rules`
// overriding it (tests: no spawn protection unless asked).
const setup = (rules = { immunityTime: 0 }) => modeServer([1, 2], rules);

Deno.test({ name: 'deathmatch: game_type 1 / game_mode 2 load the mode cfg; back to competitive resets it', ignore: !haveMap, fn: () => {
  const { host } = setup();
  const r = host.game.rules;
  assert.equal(host.modeName, 'deathmatch');
  assert.ok(r.deathmatch && r.teammatesAreEnemies && r.respawnT && r.respawnCT && r.randomSpawn);
  assert.equal(r.timeLimit, 600, 'mp_timelimit 10');
  assert.ok(!r.giveC4 && r.hostagesMax === 0 && r.freeArmor && r.buyAnywhere);
  assert.equal(host.info().mode, 'deathmatch');
  host.con.exec('game_type 0; game_mode 1; map de_dust2');
  const c = host.game.rules;
  assert.equal(host.modeName, 'competitive');
  assert.ok(!c.deathmatch && !c.teammatesAreEnemies && !c.respawnT && !c.randomSpawn && c.giveC4);
  assert.equal(c.roundTime, 115);
} });

Deno.test({ name: 'deathmatch: free for all, points for kills, respawn after 2 s, no bomb, free armor', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_T); // same team: still enemies
  run(2);
  assert.notEqual(host.game.phase, PHASE_WARMUP, 'two players are enough in free for all');
  live();
  const g = host.game;
  assert.equal(g.round.mode, GAME_FFA | GAME_DM);
  assert.equal(g.bombCarrier, null, 'mp_give_player_c4 0');
  assert.equal(a.player.armor, 100);
  assert.ok(a.player.helmet, 'mp_free_armor');
  const money = a.player.money;
  lineUp(g, a, b);
  fireUntil(run, a, () => !b.alive);
  assert.ok(!b.alive, 'a teammate died: teammates are enemies');
  assert.equal(a.kills, 1);
  assert.equal(a.score, DM_KILL_POINTS);
  assert.equal(a.player.money, money, 'no kill money in deathmatch');
  run(DM_RESPAWN * TICK_RATE + 1);
  assert.ok(b.alive, 'respawned');
  assert.equal(g.phase, PHASE_LIVE, 'deaths never end the round');
} });

Deno.test({ name: 'deathmatch: weapons are free, anywhere, and come back after death', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2);
  live();
  const money = a.player.money;
  a.buy(WEAPON_ID.awp);
  run(1);
  assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp);
  assert.equal(a.player.money, money, 'free');
  assert.equal(host.game.items.count, 0, 'the replaced rifle is not dropped');
  host.game.kill(b, a, 0, false);
  run(DM_RESPAWN * TICK_RATE + 1);
  assert.ok(a.alive);
  assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp, 'the AWP again');
  run(16 * TICK_RATE);
  a.buy(WEAPON_ID.ak47);
  run(1);
  assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp, 'mp_buytime after the spawn is over');
} });

Deno.test({ name: 'deathmatch: spawn protection until the time runs out or he shoots', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup({ immunityTime: 4 });
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2);
  live();
  lineUp(host.game, a, b);
  b.immuneUntil = host.game.tick + 4 * TICK_RATE; // as if just spawned
  fireUntil(run, a, () => b.player.health < 100, 64);
  assert.equal(b.player.health, 100, 'protected');
  assert.ok(b.immune, 'shown (ANIM_IMMUNE, OWN_IMMUNE)');
  b.input.buttons = IN_ATTACK; // he shoots: protection ends
  run(1);
  b.input.buttons = 0;
  run(1);
  assert.ok(!b.immune);
  fireUntil(run, a, () => b.player.health < 100);
  assert.ok(b.player.health < 100);
} });

Deno.test({ name: 'deathmatch: spawns anywhere on the map, out of enemy sight and away from them', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_T);
  run(2);
  live();
  const g = host.game, tr = new Trace();
  const [x, y, z] = g.spawns[TEAM_T][0];
  const teamSpawns = [...g.spawns[TEAM_T], ...g.spawns[TEAM_CT]];
  const cells = new Set();
  let away = 0;
  for (let i = 0; i < 20; i++) {
    teleport(a, x, y, z); // a camps the T spawn
    g.kill(a, b, 0, false);
    run(DM_RESPAWN * TICK_RATE + 1);
    const f = b.player.ps.f, bx = f[PS_ORIGIN], by = f[PS_ORIGIN + 1], bz = f[PS_ORIGIN + 2];
    assert.ok(Math.hypot(bx - x, by - y) >= 500, 'not next to the enemy');
    const af = a.player.ps.f; // where the camper stood (he settles onto the floor)
    traceHull(g.world, HULL_POINT, af[PS_ORIGIN], af[PS_ORIGIN + 1], af[PS_ORIGIN + 2] + eyeOffset(a.player.ps),
      bx, by, bz + 28, tr);
    assert.ok(tr.fraction < 1, 'out of his sight');
    cells.add(`${Math.floor(bx / 256)},${Math.floor(by / 256)}`);
    if (teamSpawns.every((s) => Math.hypot(s[0] - bx, s[1] - by) > 300)) away++;
  }
  assert.ok(cells.size >= 10, `spread over the map: ${cells.size} areas in 20 spawns`);
  assert.ok(away >= 10, `mostly away from the team spawns: ${away} of 20`);
} });

Deno.test({ name: 'deathmatch: the time limit ends the match, the top score wins, a new match follows', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup({ immunityTime: 0, timeLimit: 3, matchRestartDelay: 2 });
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2);
  live();
  const g = host.game;
  g.kill(a, b, 0, false);
  assert.equal(a.score, DM_KILL_POINTS);
  run(3 * TICK_RATE + 1);
  assert.equal(g.phase, PHASE_OVER);
  assert.equal(g.round.info >> 2, END_MATCH);
  run(2 * TICK_RATE + 2);
  assert.notEqual(g.phase, PHASE_OVER, 'next match');
  assert.equal(a.score, 0, 'scores reset');
  assert.ok(a.alive && b.alive);
} });
