// Server conveniences: sv_password, votes (callvote), the console's say.
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import {
  Writer, Reader, writeHello, writeCommand, readVote, S2C_REJECT, S2C_WELCOME, S2C_PRINT, S2C_VOTE, S2C_CHAT, VOTE_RUNNING,
  VOTE_PASSED, VOTE_FAILED, VOTE_KICK, VOTE_RESTART, VOTE_SURRENDER,
} from '../shared/protocol.js';
import {
  PHASE_OVER, PHASE_FREEZE, PHASE_LIVE, END_SURRENDER, GAME_PAUSED, GAME_TIMEOUT, reasonOf, matchOver,
} from '../shared/economy.js';
import { TICK_RATE } from '../shared/constants.js';
import { WEAPON_ID } from '../shared/weapons.js';
import { loadMap, readCfg, quiet } from './harness.js';
import { Host } from '../server/host.js';

// A server on de_playground with a clock the test moves; `hello(name, password, address,
// team)` connects a session and sends its HELLO: the client, the datagrams it got and whether
// its session was closed; `cmd(p, text)` a console command from it, `said(p)` its newest
// console line, `vote(p)` the newest vote it was sent.
function server() {
  const clock = { ms: 0 };
  const host = new Host({
    loadMap, listMaps: () => ['de_playground'], readCfg, print: () => {}, now: () => clock.ms,
  });
  quiet(() => host.start('de_playground'));
  host.con.exec('mp_limitteams 0'); // these tests put many players on one side
  const w = new Writer();
  const hello = (name, password = '', address = '203.0.113.7', team = TEAM_T) => {
    const sent = [];
    const session = { send: (b) => sent.push(b.slice()), close: (why) => (session.closed = why), closed: '', address };
    const c = host.game.connect(session);
    quiet(() => host.game.receive(c, writeHello(w, team, 0, 0, name, '', password).slice()));
    const reject = sent.find((b) => b[0] === S2C_REJECT);
    let why = '';
    if (reject) {
      const r = new Reader().set(reject);
      r.u8v();
      why = r.str();
    }
    return { c, joined: c.joined, welcomed: sent.some((b) => b[0] === S2C_WELCOME), why, session, sent };
  };
  let cmdId = 0;
  const cmd = (p, text) => quiet(() => host.game.receive(p.c, writeCommand(w, ++cmdId, text).slice()));
  const last = (p, type, read) => {
    const b = p.sent.findLast((x) => x[0] === type);
    if (!b) return null;
    const r = new Reader().set(b);
    r.u8v();
    return read(r);
  };
  const said = (p) => last(p, S2C_PRINT, (r) => r.lstr());
  const vote = (p) => last(p, S2C_VOTE, readVote);
  const tick = (n = 1) => quiet(() => {
    for (let i = 0; i < n; i++) host.step(host.game);
  });
  return { host, hello, clock, w, cmd, said, vote, tick };
}

Deno.test('sv_password: none lets anyone in; set, only the right password joins, guesses limited by address', () => {
  const { host, hello, clock, w } = server();
  assert.ok(hello('open').joined, 'no password set');
  assert.equal(host.info().password, false);
  host.con.exec('sv_password letmein');
  assert.equal(host.info().password, true, 'connect.json says so');
  const none = hello('none');
  assert.ok(!none.joined && !none.welcomed);
  assert.equal(none.why, 'this server has a password');
  // The refusal closes the session (the transport sends the REJECT first: server/transport.js
  // CLOSE_MS) and frees the slot; a HELLO resent meanwhile is not tried.
  const { c, session, sent } = none;
  assert.equal(session.closed, 'refused');
  assert.equal(host.game.clients[c.id], null, 'its slot is free');
  host.game.receive(c, writeHello(w, TEAM_T, 0, 0, 'none', '', 'letmein').slice());
  assert.ok(!c.joined && sent.filter((b) => b[0] === S2C_REJECT).length === 1, 'the resent HELLO is not tried');
  assert.equal(hello('bad', 'nope').why, 'bad password');
  const ok = hello('good', 'letmein');
  assert.ok(ok.joined && ok.welcomed, 'the right one joins');
  for (let i = 0; i < 5; i++) hello('guess', `g${i}`); // a right one cleared the count
  assert.equal(hello('good2', 'letmein').why, 'too many bad passwords, try later', 'blocked, even the right one');
  assert.ok(hello('other', 'letmein', '198.51.100.2').joined, 'another address is not');
  clock.ms += 61000;
  assert.ok(hello('later', 'letmein').joined, 'the block runs out');
});

Deno.test('callvote restartgame: the caller votes yes, it passes at the quorum, everyone sees it', () => {
  const { host, hello, cmd, said, vote } = server();
  const a = hello('alpha', '', '203.0.113.1'), b = hello('bravo', '', '203.0.113.2', TEAM_CT);
  const c = hello('charlie', '', '203.0.113.3'), spec = hello('watcher', '', '203.0.113.4', TEAM_SPECTATOR);
  cmd(spec, 'callvote restartgame');
  assert.equal(said(spec), 'Spectators cannot call votes.');
  cmd(a, 'callvote restartgame');
  const v = vote(c);
  assert.equal(v.state, VOTE_RUNNING);
  assert.equal(v.issue, VOTE_RESTART);
  assert.equal(v.caller, a.c.id);
  assert.deepEqual([v.yes, v.no, v.voters, v.needed, v.mine], [1, 0, 3, 2, 1], '3 may vote, 0.6 of them is 2, the caller said yes');
  assert.equal(v.left, 15);
  assert.equal(vote(spec).mine, 0, 'a spectator sees it but cannot vote');
  assert.equal(vote(a).mine, 2, 'the caller voted yes');
  cmd(b, 'callvote kick charlie');
  assert.equal(said(b), 'A vote is already in progress.');
  cmd(spec, 'vote option1');
  assert.equal(said(spec), 'You cannot vote on this one.');
  cmd(c, 'vote option2');
  assert.deepEqual([vote(a).yes, vote(a).no], [1, 1]);
  assert.equal(host.game.restartAt, 0);
  cmd(b, 'vote option1');
  assert.equal(vote(c).state, VOTE_PASSED);
  assert.ok(host.game.restartAt > host.game.tick, 'the match restarts');
  assert.match(said(c), /Vote passed: restart the match/);
});

Deno.test('callvote kick: the team votes, the target left out; passed, the address is kept out for a while', () => {
  const { hello, clock, cmd, said, vote, tick } = server();
  const a = hello('alpha', '', '203.0.113.1'), d = hello('delta', '', '203.0.113.4');
  hello('ct', '', '203.0.113.9', TEAM_CT);
  cmd(a, 'callvote kick ct');
  assert.equal(said(a), 'Only a teammate can be voted out.');
  cmd(a, 'callvote kick delta');
  assert.equal(said(a), 'Not enough players who can vote on that.', 'the caller alone never kicks');
  const b = hello('bravo', '', '203.0.113.2'), c = hello('charlie', '', '203.0.113.3');
  cmd(a, 'callvote kick delta');
  assert.deepEqual([vote(a).voters, vote(a).needed, vote(a).issue], [3, 2, VOTE_KICK], 'the Ts but delta');
  assert.equal(vote(a).detail, 'delta');
  assert.equal(vote(d).mine, 0, 'the target cannot vote');
  cmd(b, 'vote option2');
  tick(1);
  assert.ok(d.c.joined);
  cmd(c, 'vote option1');
  assert.equal(vote(b).state, VOTE_PASSED);
  assert.ok(!d.c.joined, 'kicked');
  assert.equal(hello('delta again', '', '203.0.113.4').why, 'voted out: you can come back in 15 min');
  clock.ms += 15 * 60000;
  assert.ok(hello('delta later', '', '203.0.113.4').joined, 'after sv_vote_kick_ban_duration');
});

Deno.test('callvote: a vote fails on time; the same vote and the caller wait; issues can be turned off', () => {
  const { host, hello, clock, cmd, said, vote, tick } = server();
  const a = hello('alpha', '', '203.0.113.1'), b = hello('bravo', '', '203.0.113.2');
  hello('charlie', '', '203.0.113.3');
  cmd(a, 'callvote changelevel de_nowhere');
  assert.match(said(a), /no map "de_nowhere"/);
  cmd(a, 'callvote changelevel de_playground');
  clock.ms += 14000;
  tick(32); // a running vote goes out twice a second
  assert.equal(vote(b).state, VOTE_RUNNING);
  assert.equal(vote(b).left, 1);
  clock.ms += 1000;
  tick(1);
  assert.equal(vote(b).state, VOTE_FAILED, 'one yes of the two needed when the time ran out');
  tick(3);
  assert.equal(b.sent.filter((x) => x[0] === S2C_VOTE && readVote(new Reader().set(x.subarray(1))).state === VOTE_FAILED).length, 3,
    'the result goes out three times');
  cmd(b, 'callvote changelevel de_playground');
  assert.match(said(b), /failed a moment ago: it can be called again in 300 s/);
  cmd(a, 'callvote restartgame');
  assert.match(said(a), /You can call another vote in 135 s/);
  const back = hello('alpha again', '', '203.0.113.1');
  cmd(back, 'callvote restartgame');
  assert.match(said(back), /You can call another vote in 135 s/, 'a reconnect is no new caller');
  host.con.exec('sv_vote_issue_restart_game_allowed 0');
  cmd(b, 'callvote restartgame');
  assert.equal(said(b), 'callvote restartgame is off on this server.');
  host.con.exec('sv_allow_votes 0');
  cmd(b, 'callvote restartgame');
  assert.equal(said(b), 'Voting is off on this server.');
});

// A passed changelevel is a map change like rcon's, so a room's gap between them holds for
// it too (each rebuilds the game and its bots' navigation); one that did not happen reads failed.
Deno.test('callvote changelevel: a passed vote waits out the gap since the last map change', () => {
  const { host, hello, clock, cmd, said, vote } = server();
  host.opts.mapGapMs = 30000;
  host.con.exec('map de_playground', { source: 'rcon', print: () => {} });
  const first = host.game;
  const a = hello('alpha', '', '203.0.113.1'), b = hello('bravo', '', '203.0.113.2');
  cmd(a, 'callvote changelevel de_playground');
  cmd(b, 'vote option1');
  assert.equal(said(a), 'Vote failed: change the map to de_playground (map: too soon after the last change)');
  assert.equal(vote(a).state, VOTE_FAILED);
  assert.ok(host.game === first, 'too soon after the last change'); // (a Game in a failure message is the whole game)
  clock.ms += 30000;
  cmd(b, 'callvote changelevel de_playground');
  cmd(a, 'vote option1');
  assert.ok(host.game !== first, 'changed once the gap is over');
});

// Practice's server (client/localserver.js) has only the running map: its changelevel fetches
// the map first, then changes. A passed vote calling the Host itself changed nothing there.
Deno.test('callvote changelevel: through the console\'s changelevel (practice fetches first); a map that never came reads failed', async () => {
  const { host, hello, cmd, said, vote } = server();
  host.opts.listMaps = () => ['de_playground', 'de_missing'];
  const fetched = [];
  host.con.command('changelevel', (a, ctx) => {
    fetched.push(a[1]);
    setTimeout(() => (a[1] === 'de_missing' ? host.con.out(ctx, `map ${a[1]}: HTTP 404`) : quiet(() => host.changeLevel(a[1], ctx))));
  });
  const later = () => new Promise((r) => setTimeout(r, 10));
  const first = host.game;
  const a = hello('alpha', '', '203.0.113.1'), b = hello('bravo', '', '203.0.113.2');
  cmd(a, 'callvote changelevel de_missing');
  cmd(b, 'vote option1');
  assert.deepEqual(fetched, ['de_missing']);
  assert.equal(vote(b).state, VOTE_PASSED);
  await later();
  assert.equal(vote(b).state, VOTE_FAILED, 'the map never came');
  assert.equal(said(b), 'Vote failed: change the map to de_missing (map de_missing: HTTP 404)');
  cmd(b, 'callvote changelevel de_playground');
  cmd(a, 'vote option1');
  await later();
  assert.deepEqual(fetched, ['de_missing', 'de_playground']);
  assert.ok(host.game !== first, 'changed once fetched');
  assert.equal(vote(a).state, VOTE_PASSED);
});

Deno.test('callvote: one voter an address (two tabs of one machine never kick alone); on loopback one a client', () => {
  const { hello, cmd, said, vote } = server();
  const a = hello('alpha', '', '203.0.113.1'), a2 = hello('alpha2', '', '203.0.113.1'), d = hello('delta', '', '203.0.113.4');
  cmd(a, 'callvote kick delta');
  assert.equal(said(a), 'Not enough players who can vote on that.', 'alpha and his second tab are one voter');
  const b = hello('bravo', '', '203.0.113.2');
  cmd(a2, 'callvote kick delta');
  assert.deepEqual([vote(b).voters, vote(b).needed, vote(b).mine], [2, 2, 1], 'alpha2 (who called) and bravo');
  cmd(a, 'vote option1');
  assert.equal(said(a), 'You cannot vote on this one.');
  assert.ok(d.c.joined);
  const dev = server(), local = '127.0.0.1';
  const x = dev.hello('one', '', local);
  dev.hello('two', '', local);
  dev.hello('three', '', local);
  dev.cmd(x, 'callvote restartgame');
  assert.equal(dev.vote(x).voters, 3, 'development plays a tab per player');
});

Deno.test('sv_password: over 63 bytes (a HELLO carries no more) is refused with a message; 63 joins', () => {
  const { host, hello } = server();
  const admin = hello('admin');
  host.con.exec('rcon_password secret');
  assert.equal(quiet(() => host.rcon(admin.c, 'secret', `sv_password ${'é'.repeat(32)}`)), // 64 bytes of UTF-8
    'sv_password: at most 63 bytes (a HELLO carries no more): unchanged');
  assert.equal(host.joinPassword.value, '');
  const most = `${'é'.repeat(31)}x`;
  assert.equal(quiet(() => host.rcon(admin.c, 'secret', `sv_password ${most}`)), '');
  assert.equal(hello('friend', 'wrong', '198.51.100.3').why, 'bad password');
  assert.ok(hello('friend', most, '198.51.100.3').joined, 'the longest a HELLO carries');
});

// A room's uploader holds its rcon password: one line of `say a;say a;...` was ~160 chat lines.
Deno.test('say from rcon or the server console: one line every 0.66 s per caller, the rest dropped with one line back', () => {
  const { host, hello, clock } = server();
  const admin = hello('admin', '', '203.0.113.1'), p = hello('player', '', '203.0.113.2');
  host.con.exec('rcon_password secret');
  const chats = () => p.sent.filter((b) => b[0] === S2C_CHAT).length;
  const out = quiet(() => host.rcon(admin.c, 'secret', Array(200).fill('say spam').join(';')));
  assert.equal(chats(), 1);
  assert.equal(out, 'say: one line every 0.66 s, the rest dropped');
  host.con.exec('say from the terminal');
  assert.equal(chats(), 2, 'another caller');
  clock.ms += 700;
  quiet(() => host.rcon(admin.c, 'secret', 'say again'));
  assert.equal(chats(), 3);
});

Deno.test('sv_password: a flood of bad guesses keeps new addresses out, not those that got in before; an empty one is no guess', () => {
  const { host, hello } = server();
  host.con.exec('sv_password letmein');
  assert.ok(hello('regular', 'letmein', '198.51.100.1').joined);
  for (let i = 0; i < 6; i++) assert.equal(hello('curious', '', '198.51.100.9').why, 'this server has a password');
  assert.ok(hello('friend', 'letmein', '198.51.100.9').joined, 'six tries with no password blocked nothing');
  for (let a = 0; a < 12; a++) {
    for (let i = 0; i < 5; i++) hello('guess', `g${i}`, `203.0.113.${a + 10}`);
  }
  assert.equal(hello('new', 'letmein', '192.0.2.1').why, 'too many bad passwords, try later', 'sixty in a minute from everyone');
  assert.ok(hello('regular again', 'letmein', '198.51.100.1').joined, 'an address that got in before still does (a map change rejoins everyone)');
});

Deno.test('callvote kick: a name several players share goes by #id, and the panel says which', () => {
  const { host, hello, cmd, said, vote } = server();
  const a = hello('alpha', '', '203.0.113.1'), p1 = hello('player', '', '203.0.113.2'), p2 = hello('player', '', '203.0.113.3');
  hello('bravo', '', '203.0.113.4');
  cmd(a, 'callvote kick player');
  assert.match(said(a), /several have that name/);
  assert.equal(host.findClient('player'), null, 'rcon kick likewise');
  cmd(a, `callvote kick #${p2.c.id}`);
  assert.equal(vote(a).detail, `player (#${p2.c.id})`);
  assert.equal(vote(p2).mine, 0, 'the one meant is the target');
  assert.equal(vote(p1).mine, 1);
});

Deno.test('callvote kick: no ban while a housemate stays (he would be refused at the next map change)', () => {
  const { hello, cmd, vote } = server();
  const a = hello('alpha', '', '203.0.113.1'), b = hello('bravo', '', '203.0.113.2');
  const d = hello('delta', '', '203.0.113.4'), mate = hello('mate', '', '203.0.113.4');
  cmd(a, 'callvote kick delta');
  cmd(b, 'vote option1');
  assert.equal(vote(a).state, VOTE_PASSED);
  assert.ok(!d.c.joined && mate.c.joined);
  assert.ok(hello('mate rejoining', '', '203.0.113.4').joined, 'not banned');
});

Deno.test("callvote surrender: the caller's team alone votes, every one of them yes; the other side wins the match", () => {
  const { host, hello, cmd, said, vote, tick } = server();
  const a = hello('alpha', '', '203.0.113.1'), b = hello('bravo', '', '203.0.113.2'), ct = hello('ct', '', '203.0.113.9', TEAM_CT);
  cmd(a, 'callvote surrender');
  assert.equal(said(a), 'callvote surrender: not in warmup.');
  host.con.exec('mp_round_restart_delay 2; mp_warmup_end');
  tick(1);
  cmd(a, 'callvote surrender');
  const v = vote(a);
  assert.deepEqual([v.issue, v.voters, v.needed, v.detail], [VOTE_SURRENDER, 2, 2, 'Ts'], 'the Ts, both of them');
  assert.equal(vote(ct).mine, 0, 'the CTs see it and cannot vote');
  cmd(b, 'vote option1');
  assert.equal(vote(a).state, VOTE_PASSED);
  const rs = host.game.round;
  assert.deepEqual([rs.phase, rs.info & 3, reasonOf(rs.info), matchOver(rs.info), rs.scoreCT], [PHASE_OVER, TEAM_CT, END_SURRENDER, true, 1]);
  tick(2 * TICK_RATE + 1);
  assert.deepEqual([rs.phase, rs.scoreCT, rs.scoreT], [PHASE_FREEZE, 0, 0], 'a new match');
});

Deno.test('callvote starttimeout: the team votes; mp_team_timeout_time more freeze time, mp_team_timeout_max a match', () => {
  const { host, hello, clock, cmd, said, vote, tick } = server();
  const a = hello('alpha', '', '203.0.113.1'), ct = hello('ct', '', '203.0.113.9', TEAM_CT);
  // (10 s: the test's sessions send nothing, and a silent one times out after a while)
  host.con.exec('mp_team_timeout_max 1; mp_team_timeout_time 10; mp_freezetime 5; mp_warmup_end');
  const g = host.game, rs = g.round;
  tick(1);
  const before = rs.ticksLeft;
  cmd(a, 'callvote starttimeout');
  assert.equal(vote(a).state, VOTE_PASSED, 'alone on his team');
  tick(1);
  assert.equal(rs.ticksLeft, before - 1 + 10 * TICK_RATE);
  assert.ok(rs.mode & GAME_TIMEOUT);
  clock.ms += 200000; // (past sv_vote_creation_timer)
  cmd(a, 'callvote starttimeout');
  assert.equal(said(a), 'A timeout is already on.');
  tick(10 * TICK_RATE + 2);
  assert.ok(!(rs.mode & GAME_TIMEOUT) && rs.phase === PHASE_FREEZE);
  cmd(a, 'callvote starttimeout');
  assert.equal(said(a), 'Your team has no timeouts left (mp_team_timeout_max).');
  tick(5 * TICK_RATE);
  assert.equal(rs.phase, PHASE_LIVE);
  cmd(ct, 'callvote starttimeout');
  assert.ok(g.timeoutTeam === TEAM_CT && !(rs.mode & GAME_TIMEOUT), 'mid-round: at the next freeze time');
  quiet(() => g.startRound(false));
  tick(1);
  assert.ok(rs.ticksLeft > 14 * TICK_RATE && rs.mode & GAME_TIMEOUT);
});

Deno.test('callvote pausematch / unpausematch: the freeze time stands still until resumed; mp_pause_match mid-round waits for it', () => {
  const { host, hello, cmd, vote, tick } = server();
  const a = hello('alpha', '', '203.0.113.1'), ct = hello('ct', '', '203.0.113.9', TEAM_CT);
  host.con.exec('mp_freezetime 5; mp_warmup_end');
  const g = host.game, rs = g.round;
  tick(1);
  cmd(a, 'callvote pausematch');
  cmd(ct, 'vote option1');
  assert.equal(vote(a).state, VOTE_PASSED);
  tick(1);
  const held = rs.ticksLeft;
  tick(20 * TICK_RATE);
  assert.ok(rs.ticksLeft === held && rs.phase === PHASE_FREEZE && rs.mode & GAME_PAUSED, 'paused');
  cmd(ct, 'callvote unpausematch');
  cmd(a, 'vote option1');
  tick(1);
  assert.ok(rs.ticksLeft === held - 1 && !(rs.mode & GAME_PAUSED), 'resumed');
  tick(5 * TICK_RATE);
  assert.equal(rs.phase, PHASE_LIVE);
  host.con.exec('mp_pause_match');
  tick(TICK_RATE);
  assert.ok(g.paused && !(rs.mode & GAME_PAUSED), 'live: the next freeze time');
});

Deno.test('callvote swapteams, mp_scrambleteams: the sides change at a restart a second later', () => {
  const { host, hello, cmd, vote, tick } = server();
  const ts = [hello('a', '', '203.0.113.1'), hello('b', '', '203.0.113.2')];
  const cts = [hello('c', '', '203.0.113.3', TEAM_CT), hello('d', '', '203.0.113.4', TEAM_CT)];
  host.con.exec('mp_warmup_end');
  tick(1);
  cmd(ts[0], 'callvote swapteams');
  cmd(ts[1], 'vote option1');
  cmd(cts[0], 'vote option1');
  assert.equal(vote(ts[0]).state, VOTE_PASSED);
  assert.equal(ts[0].c.team, TEAM_T, 'not yet');
  tick(TICK_RATE + 1);
  assert.deepEqual([...ts, ...cts].map((p) => p.c.team), [TEAM_CT, TEAM_CT, TEAM_T, TEAM_T]);
  assert.equal(host.game.round.phase, PHASE_FREEZE);
  host.con.exec('mp_scrambleteams');
  tick(TICK_RATE + 1);
  const all = [...ts, ...cts].map((p) => p.c.team);
  assert.ok(all.filter((t) => t === TEAM_T).length === 2 && all.filter((t) => t === TEAM_CT).length === 2, 'two a side');
});

Deno.test("kill: a suicide (the kill command, a fall, the world) costs a kill, as in CS; the bomb's victims lose none", () => {
  const { host, hello, cmd } = server();
  const a = hello('alpha', '', '203.0.113.1'), ct = hello('ct', '', '203.0.113.9', TEAM_CT);
  cmd(a, 'kill');
  assert.deepEqual([a.c.player.kills, a.c.player.deaths], [-1, 1]);
  quiet(() => host.game.kill(ct.c, ct.c, WEAPON_ID.c4, false));
  assert.deepEqual([ct.c.player.kills, ct.c.player.deaths], [0, 1]);
});
