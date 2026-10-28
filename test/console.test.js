import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PHASE_WARMUP, PHASE_FREEZE } from '../shared/economy.js';
import {
  Writer, Reader, CmdRing, writeHello, writeCmds, writeCommand, printChunks, S2C_PRINT, S2C_CHANGELEVEL, S2C_REJECT,
  MAX_TEXT,
} from '../shared/protocol.js';
import { Host } from '../server/host.js';

const maps = {};
function loadMap(name) {
  if (!maps[name]) maps[name] = parseBSP(Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url)).buffer);
  return maps[name];
}

async function setup(t) {
  try {
    loadMap('de_dust2');
  } catch {
    await t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });
    return null;
  }
  const out = [];
  const host = new Host({
    loadMap, listMaps: () => ['de_dust2', 'fy_buzzkill'], readCfg: () => null, print: (s) => out.push(s),
    defer: (fn) => fn(),
  });
  host.start('de_dust2');
  const w = new Writer();
  let cmdId = 0;
  const join = (name, team) => {
    const sent = [];
    const session = { send: (b) => sent.push(b.slice()), close: (reason) => sent.push(reason), closed: false };
    const c = host.game.connect(session);
    host.game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    c.sent = sent;
    // Console output this client received.
    c.prints = () => sent.filter((b) => b instanceof Uint8Array && b[0] === S2C_PRINT).map((b) => {
      const r = new Reader().set(b);
      r.u8v();
      return r.lstr();
    });
    c.command = (text) => {
      const bytes = writeCommand(w, ++cmdId, text).slice();
      for (let i = 0; i < 3; i++) host.game.receive(c, bytes); // sent 3 times, run once
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
  return { host, out, join, run };
}

Deno.test('server console: mp_* cvars become the game rules (round time by map type)', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host } = s;
  assert.equal(host.game.rules.roundTime, 115, 'mp_roundtime_defuse 1.92 on a bomb map');
  host.con.exec('mp_freezetime 3; mp_roundtime_defuse 1; mp_c4timer 35; mp_startmoney 1000; mp_maxrounds 2');
  const r = host.game.rules;
  assert.deepEqual([r.freezeTime, r.roundTime, r.c4Timer, r.startMoney, r.maxRounds], [3, 60, 35, 1000, 2]);
  host.con.exec('mp_c4timer 5');
  assert.equal(host.game.rules.c4Timer, 10, 'clamped like CS:GO (10..90)');
  host.con.exec('mp_roundtime_defuse 0; mp_roundtime 3');
  assert.equal(host.game.rules.roundTime, 180, '0 falls back to mp_roundtime');
});

Deno.test('server info for the start menu: hostname, map, players', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join } = s;
  host.con.exec('hostname "Test server"');
  join('a', TEAM_T);
  assert.deepEqual(host.info(), { hostname: 'Test server', map: 'de_dust2', mode: 'competitive', players: 1, maxPlayers: 20 });
});

Deno.test('client commands: name, jointeam, kill; unknown ones answer', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join, run } = s;
  const a = join('alpha', TEAM_T);
  run(1, [a]);
  a.command('name "Big Alpha"');
  assert.equal(a.name, 'Big Alpha');
  assert.ok(host.game.rosterDirty);
  a.command('jointeam 3');
  assert.equal(a.team, TEAM_CT);
  assert.ok(a.alive, 'warmup: respawned on the new side at once');
  a.command('kill');
  assert.ok(!a.alive);
  assert.equal(a.deaths, 1);
  a.command('fly');
  assert.equal(a.prints().at(-1), 'Unknown command "fly"');
});

Deno.test('rcon: off without a password, bad passwords are refused and rate-limited', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join } = s;
  const a = join('alpha', TEAM_T);
  a.command('rcon x status');
  assert.match(a.prints().at(-1), /rcon is disabled/);
  host.con.exec('rcon_password hunter2');
  a.command('rcon wrong status');
  assert.equal(a.prints().at(-1), 'Bad rcon_password.');
  a.command('rcon hunter2 hostname "Test Server"; status');
  assert.match(a.prints().at(-1), /hostname: Test Server/);
  assert.match(a.prints().at(-1), /alpha/);
  for (let i = 0; i < 5; i++) a.command('rcon nope status');
  a.command('rcon hunter2 status');
  assert.match(a.prints().at(-1), /too many bad passwords/);
});

Deno.test('round control: mp_warmup_end, mp_restartgame, mp_warmup_start', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join, run } = s;
  host.con.exec('mp_warmuptime 30');
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2, [a, b]);
  assert.equal(host.game.phase, PHASE_WARMUP, 'mp_warmuptime holds the warmup');
  host.con.exec('mp_warmup_end');
  assert.equal(host.game.phase, PHASE_FREEZE);
  assert.equal(a.player.money, 800);
  a.player.money = 5000;
  const serial = host.game.round.serial;
  host.con.exec('mp_restartgame 1');
  run(65, [a, b]);
  assert.equal(host.game.round.round, 1);
  assert.equal(host.game.round.serial, (serial + 1) & 255, 'round 1 again, but a new start: clients clear the marks');
  assert.equal(a.player.money, 800, 'a fresh match');
  host.con.exec('mp_warmup_start');
  run(200, [a, b]);
  assert.equal(host.game.phase, PHASE_WARMUP);
  assert.equal(a.player.money, 16000);
});

Deno.test('kick and map change: clients are told to reconnect, a new game starts', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join, out } = s;
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  host.con.exec('kick bravo');
  assert.ok(b.sent.some((x) => x instanceof Uint8Array && x[0] === S2C_REJECT));
  assert.equal(host.game.clients[b.id], null);
  host.con.exec('kick nobody');
  assert.match(out.at(-1), /no such player/);

  const old = host.game;
  host.con.exec('map no_such_map');
  assert.equal(host.game, old);
  host.con.exec('map fy_buzzkill');
  assert.notEqual(host.game, old);
  assert.equal(host.game.mapName, 'fy_buzzkill');
  const cl = a.sent.find((x) => x instanceof Uint8Array && x[0] === S2C_CHANGELEVEL);
  const r = new Reader().set(cl);
  r.u8v();
  assert.equal(r.str(), 'fy_buzzkill');
  assert.equal(a.sent.at(-1), 'changelevel', 'session closed after the notice');
  assert.equal(host.game.rules.roundTime, 115, 'no bomb sites or hostages: mp_roundtime');
});

Deno.test('long console output splits into datagram-sized prints', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const chunks = printChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  for (const c of chunks) assert.ok(new TextEncoder().encode(c).length <= MAX_TEXT);
});
