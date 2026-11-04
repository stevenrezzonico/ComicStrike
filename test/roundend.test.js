// The round's end (server/game.js): the MVP, the damage report (S2C_REPORT and CS:GO's
// console lines) and the MVP counts in INFO. On de_playground, so no Valve map is needed.
import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PHASE_LIVE, PHASE_OVER, END_ELIMINATION } from '../shared/economy.js';
import {
  Writer, Reader, CmdRing, writeHello, writeCmds, S2C_PRINT, S2C_REPORT, S2C_INFO, S2C_SNAPSHOT, readReport, readInfo,
  readSnapshot, SnapshotRing, OwnState, MAX_PLAYERS, NO_MVP,
} from '../shared/protocol.js';
import { WEAPON_ID } from '../shared/weapons.js';
import { Host } from '../server/host.js';

const bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url)).buffer);

function setup() {
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_playground'], readCfg: () => null, print: () => {}, defer: (fn) => fn() });
  host.start('de_playground');
  host.con.exec('mp_warmuptime 0; mp_freezetime 1; mp_round_restart_delay 1');
  const w = new Writer();
  const join = (name, team) => {
    const sent = [];
    const c = host.game.connect({ send: (b) => sent.push(b.slice()), close: () => {}, closed: false });
    host.game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
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
    c.lastRound = () => {
      const rs = of(S2C_SNAPSHOT), ring = new SnapshotRing(), own = new OwnState();
      readSnapshot(rs[rs.length - 1], ring, own);
      return own.round;
    };
    return c;
  };
  const run = (ticks, players) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of players) {
        c.cmds.put(c.tick, 0, -1, 0, 0, 0);
        host.game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
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
