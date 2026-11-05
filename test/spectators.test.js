import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import { PHASE_WARMUP, PHASE_FREEZE, PHASE_LIVE } from '../shared/economy.js';
import { Writer, E_ACTIVE } from '../shared/protocol.js';
import { Game } from '../server/game.js';
import { mapOrNull, joinClient, sendCmd } from './harness.js';

const bsp = mapOrNull('de_dust2');

function setup() {
  const game = new Game('de_dust2', bsp, { freezeTime: 1, roundTime: 60, buyTime: 1, roundEndDelay: 1, warmupTime: 0 });
  const w = new Writer();
  const clients = [];
  const join = (name, team) => {
    const c = joinClient(game, w, name, team);
    clients.push(c);
    return c;
  };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of clients) if (c.joined) sendCmd(game, w, c);
      game.step();
    }
  };
  // Is player `c` in the newest snapshot's entity rows?
  const inSnapshot = (c) => {
    const ring = game.snapshots;
    return ring.ents[ring.row(ring.find(game.tick), c.id) + E_ACTIVE] !== 0;
  };
  return { game, join, run, inSnapshot };
}

Deno.test({ name: 'spectators: never spawn, not in snapshots, not counted as a team', ignore: !bsp, fn: () => {
  const { game, join, run, inSnapshot } = setup();
  const s = join('watcher', TEAM_SPECTATOR);
  const t = join('alpha', TEAM_T);
  run(4);
  assert.equal(s.team, TEAM_SPECTATOR);
  assert.ok(!s.alive, 'a spectator has no body');
  assert.ok(!inSnapshot(s));
  assert.ok(inSnapshot(t));
  assert.equal(game.phase, PHASE_WARMUP, 'a T and a spectator are not two teams');
  assert.equal(game.endWarmup(), 'the match needs players on both teams');
  run(64 * 3);
  assert.ok(!s.alive, 'no warmup respawn either');

  // Auto-select ignores spectators: the next player evens out the teams.
  const b = join('bravo', 0);
  assert.equal(b.team, TEAM_CT);
  run(2);
  assert.equal(game.phase, PHASE_FREEZE, 'both teams have players: the match starts');
  assert.ok(!s.alive, 'round start does not spawn spectators');
  run(70);
  assert.equal(game.phase, PHASE_LIVE);
  assert.ok(!s.alive);
} });

Deno.test({ name: 'spectators: jointeam 1 leaves the game (no death), jointeam 2/3 come back', ignore: !bsp, fn: () => {
  const { game, join, run, inSnapshot } = setup();
  const a = join('alpha', TEAM_T);
  run(2);
  assert.ok(a.alive);
  game.clientCommand(a, 'jointeam 1');
  assert.equal(a.team, TEAM_SPECTATOR);
  assert.ok(!a.alive);
  assert.equal(a.deaths, 0, 'not counted as a death');
  run(16); // team changes at most every 250 ms
  assert.ok(!inSnapshot(a));
  game.clientCommand(a, 'jointeam 3');
  assert.equal(a.team, TEAM_CT);
  assert.ok(a.alive, 'warmup: back in at once');
  run(1);
  assert.ok(inSnapshot(a));
} });

Deno.test({ name: 'spectators: rounds end by the teams alone; halftime leaves them watching', ignore: !bsp, fn: () => {
  const { game, join, run } = setup();
  game.rules.maxRounds = 2;
  const s = join('watcher', TEAM_SPECTATOR), t = join('alpha', TEAM_T), ct = join('bravo', TEAM_CT);
  run(2);
  while (game.phase !== PHASE_LIVE) run(1);
  run(10);
  assert.equal(game.phase, PHASE_LIVE, 'a dead spectator does not end the round');
  game.kill(ct, t, 0, false);
  run(1);
  assert.equal(game.round.scoreCT, 1);
  while (game.round.round < 2) run(1);
  assert.equal(s.team, TEAM_SPECTATOR, 'halftime swaps the teams only');
  assert.equal(t.team, TEAM_CT);
  assert.ok(!s.alive);
} });
