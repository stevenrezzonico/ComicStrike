// The round's end (server/game.js): the MVP, the damage report (S2C_REPORT and CS:GO's
// console lines) and the MVP counts in INFO; and where damage came from, sent in the own
// block for the hurt indicator. On de_playground, so no Valve map is needed.
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PHASE_LIVE, PHASE_OVER, END_ELIMINATION } from '../shared/economy.js';
import {
  Writer, Reader, S2C_PRINT, S2C_REPORT, S2C_INFO, S2C_SNAPSHOT, readReport, readInfo,
  readSnapshot, SnapshotRing, OwnState, MAX_PLAYERS, NO_MVP, OWN_HURT, HURT_REPEAT_TICKS,
} from '../shared/protocol.js';
import { WEAPON_ID } from '../shared/weapons.js';
import { Host } from '../server/host.js';
import { loadMap, joinClient, sendCmd } from './harness.js';

const bsp = loadMap('de_playground');

function setup() {
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_playground'], readCfg: () => null, print: () => {}, defer: (fn) => fn() });
  host.start('de_playground');
  host.con.exec('mp_warmuptime 0; mp_freezetime 1; mp_round_restart_delay 1');
  const w = new Writer();
  const join = (name, team) => {
    const sent = [];
    const c = joinClient(host.game, w, name, team, { send: (b) => sent.push(b.slice()), close: () => {}, closed: false });
    c.sent = sent;
    const of = (type) => sent.filter((b) => b[0] === type).map((b) => {
      const r = new Reader().set(b);
      r.u8v();
      return r;
    });
    c.prints = () => of(S2C_PRINT).map((r) => r.lstr());
    c.reports = () => of(S2C_REPORT).map((r) => readReport(r));
    c.lastInfo = () => {
      const rs = of(S2C_INFO);
      if (!rs.length) return null;
      const names = new Array(MAX_PLAYERS).fill(''), teams = new Uint8Array(MAX_PLAYERS), kills = new Int32Array(MAX_PLAYERS);
      const deaths = new Int32Array(MAX_PLAYERS), scores = new Int32Array(MAX_PLAYERS), mvps = new Int32Array(MAX_PLAYERS);
      readInfo(rs[rs.length - 1], names, teams, kills, deaths, scores, mvps);
      return { names, mvps };
    };
    c.lastOwn = () => {
      const rs = of(S2C_SNAPSHOT), ring = new SnapshotRing(), own = new OwnState();
      readSnapshot(rs[rs.length - 1], ring, own);
      return own;
    };
    c.lastRound = () => c.lastOwn().round;
    return c;
  };
  const run = (ticks, players) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of players) sendCmd(host.game, w, c);
      host.game.step();
    }
  };
  return { game: host.game, join, run };
}

Deno.test('round end: the killer is MVP, both sides get their damage report and the console lines', () => {
  const { game, join, run } = setup();
  const a = join('alice', TEAM_T), b = join('bob', TEAM_CT);
  run(90, [a, b]); // the freeze passes
  assert.equal(game.phase, PHASE_LIVE);
  game.hurtBy(b, 27, a, WEAPON_ID.ak47); // alice hits bob twice, the second kills (armor: the health lost counts)
  const lost = 100 - b.player.health;
  assert.ok(lost > 0 && lost <= 27);
  game.hurtBy(b, 100, a, WEAPON_ID.ak47);
  assert.ok(!b.alive);
  run(4, [a, b]);
  assert.equal(game.phase, PHASE_OVER);
  assert.equal(game.round.info, TEAM_T | (END_ELIMINATION << 2));
  assert.equal(game.round.mvp, a.id, 'the killer is the MVP');
  assert.equal(a.mvps, 1);
  const ra = a.reports(), rb = b.reports();
  assert.equal(ra.length, 1);
  assert.deepEqual(ra[0].rows, [{ id: b.id, given: 100, givenHits: 2, taken: 0, takenHits: 0 }]);
  assert.deepEqual(rb[0].rows, [{ id: a.id, given: 0, givenHits: 0, taken: 100, takenHits: 2 }]);
  assert.ok(a.prints().some((t) => t === 'Damage Given to "bob" - 100 in 2 hits'), a.prints().join('|'));
  assert.ok(b.prints().some((t) => t === 'Damage Taken from "alice" - 100 in 2 hits'));
  assert.equal(b.lastRound().mvp, a.id, 'the round block names the MVP');
  assert.equal(a.lastInfo().mvps[a.id], 1, 'INFO carries the count');
  // The next round starts clean: no MVP yet, empty tallies.
  run(70, [a, b]);
  assert.equal(game.round.mvp, NO_MVP);
  assert.equal(a.given[b.id], 0);
});

Deno.test('round end: the planter is MVP over a teammate with kills; a draw has none; a lost round has none', () => {
  const { game, join, run } = setup();
  const a = join('alice', TEAM_T), b = join('bob', TEAM_CT), c = join('carl', TEAM_T);
  run(90, [a, b, c]);
  c.roundKills = 2;
  game.roundMvp(TEAM_T, a); // the bomb went off: alice planted
  assert.equal(game.round.mvp, a.id);
  game.roundMvp(TEAM_T, null);
  assert.equal(game.round.mvp, c.id, 'else the most kills on the winning side');
  game.roundMvp(TEAM_CT, null);
  assert.equal(game.round.mvp, NO_MVP, 'the winners killed nobody');
  game.roundMvp(0, null);
  assert.equal(game.round.mvp, NO_MVP, 'a draw');
});

Deno.test('hurt indicator: the own block carries where the last damage came from, for a while', () => {
  const { game, join, run } = setup();
  const a = join('alice', TEAM_T), b = join('bob', TEAM_CT);
  run(90, [a, b]);
  assert.equal(b.lastOwn().flags & OWN_HURT, 0, 'nothing yet');
  game.hurtBy(b, 20, a, 0, 100, 200, 50); // a map explosion at (100, 200, 50)
  run(1, [a, b]);
  let own = b.lastOwn();
  assert.ok(own.flags & OWN_HURT);
  assert.equal(own.hurtSerial, 1);
  assert.deepEqual([...own.hurtFrom], [100, 200, 50]);
  assert.equal(a.lastOwn().flags & OWN_HURT, 0, 'only the one hurt');
  game.grenadeHurt(b, 12, WEAPON_ID.hegrenade, a.id, TEAM_T, -300.4, 40, 8); // an HE
  game.hurtBy(b, 5, null, 0); // a crushing door: no side to show
  run(1, [a, b]);
  own = b.lastOwn();
  assert.equal(own.hurtSerial, 2, 'the crush counts no hit');
  assert.deepEqual([...own.hurtFrom], [-300, 40, 8]);
  run(HURT_REPEAT_TICKS, [a, b]);
  assert.equal(b.lastOwn().flags & OWN_HURT, 0, 'repeated for a while only');
  const before = b.player.health;
  game.grenadeHurt(b, 12, WEAPON_ID.hegrenade, b.id === 0 ? 1 : 0, TEAM_CT, 0, 0, 0); // a teammate's: no damage
  assert.equal(b.player.health, before);
  run(1, [a, b]);
  assert.equal(b.lastOwn().flags & OWN_HURT, 0, 'no damage, no arc');
});
