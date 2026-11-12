// The admin page (client/admin.html): the commands it builds (client/admincmd.js), its HTTP
// side (server/admin.js) and the server's state and player commands it drives (server/host.js).
import assert from 'node:assert/strict';
import { Writer } from '../shared/protocol.js';
import { parse } from '../shared/cvars.js';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import { Host } from '../server/host.js';
import { adminResponse, ADMIN_BODY } from '../server/admin.js';
import { cvarCommand, who, modeCommands, botCommands, groupOf, whenApplies, controlOf, banMinutes, samePlayer, playerRowsKey, clock }
  from '../client/admincmd.js';
import { loadMap, joinClient, quiet } from './harness.js';

function setup() {
  const clock = { ms: 0 };
  const host = new Host({
    loadMap, listMaps: () => ['de_playground', 'de_inkwell'], readCfg: () => null, print: () => {}, now: () => clock.ms,
  });
  host.start('de_playground');
  host.con.exec('rcon_password hunter2');
  const w = new Writer();
  const join = (name, team, address) => joinClient(host.game, w, name, team, { send() {}, close() {}, address });
  return { host, clock, join };
}

// A request to /admin/<op> as the page sends it.
function ask(host, op, { password = 'hunter2', address = '127.0.0.1', method, body, room = 'abcdef' } = {}) {
  const url = new URL(`http://127.0.0.1/admin/${op}${room ? `?room=${room}` : ''}`);
  const headers = password === null ? {} : { 'x-rcon-password': encodeURIComponent(password) };
  const req = new Request(url, { method: method || (op === 'exec' ? 'POST' : 'GET'), headers, body });
  return adminResponse(req, url, { address, hostFor: (code) => (code === 'abcdef' ? host : null) });
}

Deno.test('admin: the page\'s commands parse back to what was meant', () => {
  assert.deepEqual(parse(cvarCommand('hostname', 'My "best"; server // 1')), [['hostname', "My 'best'; server // 1"]]);
  assert.equal(who(7), '#7');
  assert.equal(modeCommands('deathmatch', 'de_dust2'), 'game_type 1; game_mode 2; sv_game_mode_flags 0; changelevel "de_dust2"');
  assert.match(modeCommands('competitive_short', 'de_inkwell'), /^game_type 0; game_mode 1; sv_game_mode_flags 32;/);
  assert.equal(botCommands('t', 'hard', 3), 'bot_add t hard; bot_add t hard; bot_add t hard');
  assert.equal(botCommands('', 'easy', 50).split(';').length, 20, 'at most 20 at once');
  assert.deepEqual(parse(botCommands('ct', 'expert', 4, 'Bob; quit')), [['bot_add', 'ct', 'expert', 'Bob; quit']], 'a name: one bot');
  assert.equal(groupOf('mp_startmoney'), 'Economy');
  assert.equal(groupOf('sv_vote_timer_duration'), 'Votes');
  assert.equal(groupOf('mp_roundtime_defuse'), 'Rounds');
  assert.equal(groupOf('bot_quota'), null, 'the Bots tab shows them');
  assert.equal(whenApplies('game_mode'), 'next map');
  assert.equal(whenApplies('mp_freezetime'), 'next round');
  assert.equal(whenApplies('hostname'), '');
  const { host } = setup();
  const rows = new Map(host.con.catalog().map((r) => [r[0], r]));
  assert.equal(controlOf(rows.get('sv_cheats')), 'switch');
  assert.equal(controlOf(rows.get('ff_damage_reduction_grenade_self')), 'number', 'a 0..1 share is no switch');
  assert.equal(controlOf(rows.get('mp_death_drop_grenade')), 'number');
  assert.equal(controlOf(rows.get('hostname')), 'text');
  assert.deepEqual(rows.get('mp_maxrounds').slice(4), [1, 100, '30']);
  assert.deepEqual(rows.get('sv_password').slice(4), [null, null, null], 'a protected default is not sent');
  // The mode change the page sends switches the mode and the map.
  quiet(() => host.capture(modeCommands('deathmatch', 'de_inkwell')));
  assert.equal(host.modeName, 'deathmatch');
  assert.equal(host.game.mapName, 'de_inkwell');
});

Deno.test('admin: /admin answers a room only, with its rcon password', async () => {
  const { host, clock } = setup();
  const status = async (p) => (await p).status;
  const error = async (p) => (await (await p).json()).error;
  assert.equal(await status(ask(host, 'state')), 200);
  assert.equal(await status(ask(host, 'state', { password: null })), 401);
  assert.equal(await status(ask(host, 'state', { room: '' })), 404, 'no game but the rooms');
  assert.equal(await status(ask(host, 'exec', { method: 'OPTIONS' })), 405, 'no preflight is answered');
  assert.equal(await status(ask(host, 'exec', { method: 'GET' })), 405);
  assert.equal(await status(ask(host, 'secrets')), 404);
  assert.equal(await status(ask(host, 'state', { room: 'nosuch' })), 404);
  // Over plain HTTP from anywhere: the room's password came back that way when it was made.
  assert.equal(await status(ask(host, 'state', { address: '203.0.113.9' })), 200);
  // Bad passwords count like rcon's: the fifth from one address blocks it for a minute.
  const away = { address: '203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal(await error(quiet(() => ask(host, 'state', { ...away, password: 'guess' }))), 'Bad rcon_password.');
  assert.match(await error(ask(host, 'state', away)), /too many bad passwords/);
  clock.ms += 60001;
  assert.equal(await status(ask(host, 'state', away)), 200);
  // A command line, bounded; any password a header cannot hold as it is.
  const out = await (await quiet(() => ask(host, 'exec', { body: 'bot_add_ct expert Gus; mp_freezetime 7' }))).json();
  assert.match(out.output, /added .*Gus \(CT\)/);
  assert.equal(host.con.get('mp_freezetime').value, '7');
  assert.equal(await status(ask(host, 'exec', { body: 'say '.padEnd(ADMIN_BODY + 1, 'a') })), 413);
  host.con.exec('rcon_password "pä%ss wörd"');
  assert.equal(await status(ask(host, 'catalog', { password: 'pä%ss wörd' })), 200);
  host.con.exec('rcon_password ""');
  assert.match(await error(ask(host, 'state', { password: '' })), /rcon is disabled/);
});

Deno.test('admin: the state lists players, bots, the round and the cvars, never a password', () => {
  const { host, join } = setup();
  const c = join('Alice', TEAM_T, '198.51.100.4');
  host.con.exec('sv_password letmein'); // (after the join: Alice sent none)
  quiet(() => host.capture('bot_add_ct expert Gus'));
  const s = host.adminState();
  assert.equal(s.map, 'de_playground');
  assert.equal(s.mode, 'competitive');
  assert.deepEqual(s.maps, ['de_playground', 'de_inkwell']);
  assert.equal(s.round.phase, 'warmup');
  const alice = s.players.find((p) => p.id === c.id), gus = s.players.find((p) => p.bot);
  assert.equal(alice.team, TEAM_T);
  assert.equal(alice.address, '198.51.100.4');
  assert.equal(gus.team, TEAM_CT);
  assert.equal(gus.difficulty, 3);
  assert.equal(gus.address, '');
  assert.equal(s.cvars.mp_maxrounds, '30');
  assert.equal(s.password, true);
  assert.ok(!('rcon_password' in s.cvars) && !('sv_password' in s.cvars));
  const text = JSON.stringify(s);
  assert.ok(!text.includes('hunter2') && !text.includes('letmein'));
  assert.ok(s.round.secondsLeft >= 0);
  // A phase with no end (the demo's round, deathmatch with no time limit): Infinity reached
  // practice's page as it is.
  host.game.setPhase(host.game.round.phase, Infinity);
  assert.equal(host.adminState().round.secondsLeft, null);
});

// A 4 KB line costs 3-6 ms of the thread every room shares: 160-340 lines a second from the
// admin page froze every room. Rcon and the admin page share one limit a Host.
Deno.test('admin: rcon and the admin page run at most 10 lines a second, 20 at once', async () => {
  const { host, clock } = setup();
  const freeze = () => host.con.get('mp_freezetime').value;
  for (let i = 1; i <= 20; i++) assert.equal(host.capture(`mp_freezetime ${i}`), '');
  assert.equal(freeze(), '20');
  const out = await (await quiet(() => ask(host, 'exec', { body: 'mp_freezetime 30' }))).json();
  assert.match(out.output, /too many commands/);
  assert.match(quiet(() => host.rconAs('198.51.100.4', 'player', 'hunter2', 'mp_freezetime 30')), /too many commands/);
  assert.equal(freeze(), '20', 'neither ran');
  clock.ms += 100; // a line's worth
  assert.equal(host.capture('mp_freezetime 31'), '');
  assert.match(host.capture('mp_freezetime 32'), /too many commands/);
  assert.equal(freeze(), '31');
  clock.ms += 60000;
  for (let i = 0; i < 20; i++) host.capture('mp_freezetime 5');
  assert.match(host.capture('mp_freezetime 6'), /too many commands/, 'a long pause still gives 20 at most');
});

// sv_password and rcon_password set by rcon or the admin page were logged in plain text.
Deno.test('admin: a protected cvar\'s value never reaches the log', async () => {
  const { host } = setup();
  const logged = [], log = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    await ask(host, 'exec', { body: 'sv_password letmein; hostname "x y"' });
    host.rconAs('198.51.100.4', 'player 1 "Alice"', 'hunter2',
      'alias p "sv_password opensesame"; sv_pass"word" letmein2; RCON_PASSWORD "s3cr3t pw"');
    host.rconAs('198.51.100.4', 'player 1 "Alice"', 's3cr3t pw', 'mp_freezetime 3; echo "hi there"');
  } finally {
    console.log = log;
  }
  const text = logged.join('\n');
  assert.ok(!/letmein|opensesame|s3cr3t/.test(text), text);
  assert.match(text, /admin page \(127\.0\.0\.1\): sv_password \*\*\*; hostname \*\*\*$/m);
  assert.match(text, /Alice": alias \*\*\*; sv_password \*\*\*; RCON_PASSWORD \*\*\*$/m);
  assert.match(text, /Alice": mp_freezetime 3; echo "hi there"$/m, 'other lines as they came');
  assert.equal(host.joinPassword.value, 'letmein2', 'run all the same');
  assert.equal(host.password.value, 's3cr3t pw');
});

Deno.test('admin: switchteam, slay, banid and removeip; bots by id', () => {
  const { host, join } = setup();
  const run = (line) => quiet(() => host.capture(line));
  const c = join('Alice', TEAM_T, '198.51.100.4');
  assert.equal(c.team, TEAM_T);
  assert.match(run(`switchteam spec ${who(c.id)}`), /Alice is on the spectators/);
  assert.equal(c.team, TEAM_SPECTATOR);
  run(`switchteam ct ${who(c.id)}`); // at once: past the change gap a player has
  assert.equal(c.team, TEAM_CT);
  assert.ok(c.alive, 'warmup: back at once');
  assert.match(run(`slay ${who(c.id)}`), /slayed Alice/);
  assert.ok(!c.alive);
  assert.match(run(`slay ${who(c.id)}`), /not alive/);
  assert.match(run('switchteam x #99'), /no such player or team/);
  // A ban kicks and keeps the address out until removeip; 0 is until the server restarts.
  assert.match(run(`banid 30 ${who(c.id)}`), /banned Alice for 30 min/);
  assert.ok(!c.joined);
  assert.equal(host.admit({ session: { address: '198.51.100.4' } }, ''), 'banned: you can come back in 30 min');
  assert.deepEqual(host.banList(), [{ address: '198.51.100.4', minutes: 30 }]);
  assert.match(run('listip'), /198\.51\.100\.4 {2}30 min/);
  assert.match(run('removeip 198.51.100.4'), /unbanned/);
  assert.equal(host.admit({ session: { address: '198.51.100.4' } }, ''), '');
  const d = join('Bob', TEAM_CT, '198.51.100.5');
  run(`banid 0 ${who(d.id)}`);
  assert.deepEqual(host.banList(), [{ address: '198.51.100.5', minutes: null }]);
  assert.equal(host.admit({ session: { address: '198.51.100.5' } }, ''), 'banned from this server');
  const e = join('Local', TEAM_T, '127.0.0.1');
  assert.match(run(`banid 5 ${who(e.id)}`), /not banned: this machine/);
  run('bot_add_t easy Zed');
  const bot = host.game.bots.list[0].c;
  run(`bot_kick ${who(bot.id)}`);
  assert.equal(host.game.bots.list.length, 0);
});

Deno.test('admin: the chat field and the ban prompt send what was typed, or nothing', () => {
  const { host, join } = setup();
  // The chat field's text is one argument: a `;` ran the rest as a command, `//` cut a URL.
  for (const text of ['gg; wp', 'join us at http://example.com/discord', 'two  spaces']) {
    assert.deepEqual(parse(cvarCommand('say', text)), [['say', text]]);
  }
  // A number of minutes, else nothing: "30m" became 0, a ban until the server restarts.
  assert.equal(banMinutes('60'), 60);
  assert.equal(banMinutes(' 15 '), 15);
  assert.equal(banMinutes('0'), 0);
  for (const typed of ['30m', '1h', '', ' ', '-5', 'Infinity', 'abc']) assert.equal(banMinutes(typed), null, typed);
  const c = join('Alice', TEAM_T, '198.51.100.4');
  quiet(() => host.capture(`banid ${banMinutes('30')} ${who(c.id)}`));
  assert.deepEqual(host.banList(), [{ address: '198.51.100.4', minutes: 30 }]);
});

Deno.test('admin: a player\'s row is checked again before an action by his id', () => {
  const { host, join } = setup();
  const alice = join('Alice', TEAM_T, '198.51.100.4');
  const row = host.adminState().players.find((p) => p.id === alice.id);
  assert.ok(samePlayer(host.adminState().players, row));
  // Alice leaves while the ban prompt is open and Bob takes her slot at once: #id is Bob now.
  host.game.disconnect(alice);
  const bob = join('Bob', TEAM_T, '198.51.100.77');
  assert.equal(bob.id, alice.id);
  assert.ok(!samePlayer(host.adminState().players, row));
});

Deno.test('admin: the players\' table is rebuilt for its rows and buttons, not their numbers', () => {
  const { host, join } = setup();
  const c = join('Alice', TEAM_T, '198.51.100.4');
  const key = () => playerRowsKey(host.adminState());
  const before = key();
  c.player.money += 300;
  c.player.health -= 20;
  c.player.kills++;
  c.player.score += 2;
  assert.equal(key(), before, 'money, health and score are written in place');
  quiet(() => host.capture(`switchteam ct ${who(c.id)}`));
  assert.notEqual(key(), before, 'a team change moves the row and its buttons');
});

Deno.test('admin: the clock shows a dash with no end in sight', () => {
  assert.equal(clock(95), '1:35');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(null), '-', 'a room: JSON has no Infinity');
  assert.equal(clock(Infinity), '-', 'practice: through the channel');
});
