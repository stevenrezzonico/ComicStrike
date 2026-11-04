import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import { PHASE_WARMUP, PHASE_FREEZE } from '../shared/economy.js';
import {
  Writer, Reader, CmdRing, writeHello, writeCmds, writeCommand, printChunks, S2C_PRINT, S2C_CHANGELEVEL, S2C_REJECT,
  MAX_TEXT, S2C_CHAT, readChat, CHAT_CONSOLE, CHAT_TEAM, CHAT_DEAD, CHAT_SPEC,
} from '../shared/protocol.js';
import { Host, AddressCounts } from '../server/host.js';
import { TICK_RATE } from '../shared/constants.js';

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
  const clock = { ms: 0 };
  const host = new Host({
    loadMap, listMaps: () => ['de_dust2', 'fy_buzzkill'], readCfg: () => null, print: (s) => out.push(s),
    defer: (fn) => fn(), now: () => clock.ms,
  });
  host.start('de_dust2');
  const w = new Writer();
  let cmdId = 0;
  const join = (name, team, address) => {
    const sent = [];
    const session = { send: (b) => sent.push(b.slice()), close: (reason) => sent.push(reason), closed: false, address };
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
    // Chat lines this client received, as "sender/flags: text".
    c.chats = () => sent.filter((b) => b instanceof Uint8Array && b[0] === S2C_CHAT).map((b) => {
      const r = new Reader().set(b);
      r.u8v();
      const m = readChat(r);
      return `${m.sender}/${m.flags}: ${m.text}`;
    });
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
  return { host, out, join, run, clock };
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

Deno.test('a tick that throws is logged at most once a second and the game goes on', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, clock } = s;
  const game = host.game, step = game.step;
  let broken = true;
  game.step = function () {
    step.call(this);
    if (broken) throw new Error('bug in a tick');
  };
  const logged = [], error = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const t0 = game.tick;
    for (let i = 0; i < 10; i++) host.step(game);
    assert.equal(game.tick, t0 + 10, 'every tick still counts');
    assert.equal(logged.length, 1, 'one report a second');
    assert.match(logged[0], /bug in a tick/);
    clock.ms += 1000;
    host.step(game);
    assert.equal(logged.length, 2);
    assert.match(logged[1], /10 failed ticks/);
    broken = false;
    host.step(game);
    assert.equal(game.tick, t0 + 12);
  } finally {
    console.error = error;
  }
});

Deno.test('rcon: guesses are counted by address, so reconnecting does not reset them', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join, clock } = s;
  host.con.exec('rcon_password hunter2');
  const guess = (c, n) => {
    for (let i = 0; i < n; i++) c.command(`rcon guess${i} status`);
  };
  const a = join('alpha', TEAM_T, '203.0.113.7');
  guess(a, 3);
  host.game.disconnect(a);
  const again = join('alpha', TEAM_T, '203.0.113.7'); // a new session, same address
  guess(again, 2);
  again.command('rcon hunter2 status');
  assert.match(again.prints().at(-1), /too many bad passwords/, 'blocked after 5 in all');
  const other = join('bravo', TEAM_CT, '198.51.100.2');
  other.command('rcon hunter2 status');
  assert.match(other.prints().at(-1), /bravo/, 'another address is not blocked');
  // IPv6: a whole /64 counts as one sender.
  const v6 = join('charlie', TEAM_T, '2001:db8:1:2::10');
  guess(v6, 5);
  const v6b = join('delta', TEAM_T, '2001:db8:1:2:ffff::99');
  v6b.command('rcon hunter2 status');
  assert.match(v6b.prints().at(-1), /too many bad passwords/);
  clock.ms += 61000; // the block runs out
  again.command('rcon hunter2 status');
  assert.match(again.prints().at(-1), /alpha/);
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

Deno.test('chat: say reaches everyone, say_team the team, the dead and spectators tagged, flood dropped', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join, run } = s;
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_T), c = join('charlie', TEAM_CT), d = join('delta', TEAM_SPECTATOR);
  const bot = host.game.bots.add(TEAM_CT, 0, 'BOT Rob');
  run(2, [a, b, c]);
  a.command('say hello "all"; kill'); // the rest of the line is text, not commands
  const line = `${a.id}/0: hello "all"; kill`;
  for (const x of [a, b, c, d]) assert.deepEqual(x.chats(), [line], x.name);
  assert.ok(a.alive, 'nothing after the ; ran');
  assert.ok(!bot.sent?.length, 'bots get nothing');
  run(64, [a, b, c]);
  a.command('say_team rush b');
  assert.deepEqual(b.chats().at(-1), `${a.id}/${CHAT_TEAM}: rush b`);
  assert.deepEqual(c.chats().length, 1, 'the other team hears nothing');
  assert.deepEqual(d.chats().length, 1, 'nor the spectators');
  run(64, [a, b, c]);
  a.command('kill');
  a.command('say im dead');
  assert.deepEqual(c.chats().at(-1), `${a.id}/${CHAT_DEAD}: im dead`, 'the living see a dead enemy (sv_talk_enemy_dead 1)');
  d.command('say watching');
  assert.deepEqual(b.chats().at(-1), `${d.id}/${CHAT_SPEC}: watching`);
  run(43, [a, b, c]);
  d.command('say_team spec talk');
  assert.deepEqual(d.chats().at(-1), `${d.id}/${CHAT_TEAM | CHAT_SPEC}: spec talk`);
  assert.ok(!b.chats().includes(`${d.id}/${CHAT_TEAM | CHAT_SPEC}: spec talk`), 'spectator team chat stays among spectators');
  // Flood: a second line within 0.66 s is dropped; a line of spaces too.
  b.command('say one');
  b.command('say two');
  b.command('say    ');
  assert.deepEqual(c.chats().filter((l) => l.startsWith(`${b.id}/`)), [`${b.id}/0: one`]);
  run(43, [a, b, c]);
  b.command('say three');
  assert.deepEqual(c.chats().at(-1), `${b.id}/0: three`);
  // The server console's say: Console to everyone.
  host.con.exec('say server here');
  for (const x of [a, b, c, d]) assert.equal(x.chats().at(-1), `${CHAT_CONSOLE}/0: server here`);
  // sv_talk_enemy_*: the living no longer see enemies' all chat; the dead and spectators do.
  host.con.exec('sv_talk_enemy_living 0; sv_talk_enemy_dead 0');
  run(43, [a, b, c]);
  b.command('say quiet');
  assert.equal(c.chats().at(-1), `${CHAT_CONSOLE}/0: server here`, 'a living enemy hears nothing');
  assert.equal(a.chats().at(-1), `${b.id}/0: quiet`, 'a teammate does');
  assert.equal(d.chats().at(-1), `${b.id}/0: quiet`, 'a spectator does');
  run(43, [a, b, c]);
  a.command('say dead talk');
  assert.equal(c.chats().at(-1), `${CHAT_CONSOLE}/0: server here`, 'a dead enemy neither');
  assert.equal(b.chats().at(-1), `${a.id}/${CHAT_DEAD}: dead talk`);
});

Deno.test('long console output splits into datagram-sized prints', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const chunks = printChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  for (const c of chunks) assert.ok(new TextEncoder().encode(c).length <= MAX_TEXT);
});

// A client's console commands: at most 32 a second (each name or team change resent the
// roster to everyone and logged a line: one packet a tick was a flood), names and teams
// changed at most four times a second.
Deno.test('client commands: a flood is cut, names and teams change at most 4 times a second', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { host, join, run } = s;
  const a = join('ann', TEAM_T), b = join('bob', TEAM_CT);
  run(2, [a, b]);
  a.command('name ann2');
  a.command('name ann3');
  assert.equal(a.name, 'ann2');
  assert.match(a.prints().join(' '), /too soon/);
  a.command('jointeam 3');
  a.command('jointeam 2');
  assert.equal(a.team, TEAM_CT);
  run(TICK_RATE, [a, b]);
  a.command('name ann3');
  a.command('jointeam 2');
  assert.deepEqual([a.name, a.team], ['ann3', TEAM_T]);
  const game = host.game, real = game.clientCommand.bind(game);
  let ran = 0;
  game.clientCommand = (c, text) => {
    ran++;
    real(c, text);
  };
  run(TICK_RATE, [a, b]);
  for (let i = 0; i < 40; i++) b.command('player_ping');
  assert.equal(ran, 32);
});

// Sessions per address (server/main.js): a household fits, one machine cannot take every
// slot; loopback is free (a tab per player in development).
Deno.test('sessions per address', () => {
  const counts = new AddressCounts(2);
  assert.ok(counts.add('1.2.3.4') && counts.add('::ffff:1.2.3.4'));
  assert.ok(!counts.add('1.2.3.4'), 'a third from the same address');
  assert.ok(counts.add('2001:db8::1') && counts.add('2001:db8::2') && !counts.add('2001:db8::3'), 'IPv6 by /64');
  counts.remove('1.2.3.4');
  assert.ok(counts.add('1.2.3.4'), 'a closed one frees its place');
  for (let i = 0; i < 10; i++) assert.ok(counts.add('127.0.0.1') && counts.add('::1'));
});
