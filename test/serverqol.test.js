// Server conveniences: sv_password, votes (callvote).
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import {
  Writer, Reader, writeHello, writeCommand, readVote, S2C_REJECT, S2C_WELCOME, S2C_PRINT, S2C_VOTE, VOTE_RUNNING,
  VOTE_PASSED, VOTE_FAILED, VOTE_KICK, VOTE_RESTART,
} from '../shared/protocol.js';
import { loadMap, readCfg, quiet } from './harness.js';
import { Host } from '../server/host.js';

// A server on de_playground with a clock the test moves; `hello(name, password, address,
// team)` connects a session and sends its HELLO: the client, the datagrams it got and whether
// its session was closed; `cmd(p, text)` a console command from it, `said(p)` its newest
// console line, `vote(p)` the newest vote it was sent.
function server() {
  const clock = { ms: 0 };
  const host = new Host({
    loadMap, listMaps: () => ['de_playground'], readCfg, print: () => {}, defer: (fn) => fn(), now: () => clock.ms,
  });
  quiet(() => host.start('de_playground'));
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
  // The HELLO is resent until an answer comes: each gets the refusal, counted as one guess,
  // and the session closes half a second later (a close at once lost the REJECT).
  const { c, session, sent } = none;
  host.game.receive(c, writeHello(w, TEAM_T, 0, 0, 'none', '', 'letmein').slice());
  assert.equal(sent.filter((b) => b[0] === S2C_REJECT).length, 2, 'the second HELLO is refused too, not tried');
  assert.ok(!c.joined && !session.closed);
  quiet(() => {
    for (let i = 0; i < 32; i++) host.game.step();
  });
  assert.equal(session.closed, 'refused');
  assert.equal(host.game.clients[c.id], null, 'its slot is free');
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

Deno.test('sv_password: a flood of bad guesses keeps new addresses out, not those that got in before; an empty one is no guess', () => {
  const { host, hello, tick } = server();
  host.con.exec('sv_password letmein');
  assert.ok(hello('regular', 'letmein', '198.51.100.1').joined);
  for (let i = 0; i < 6; i++) assert.equal(hello('curious', '', '198.51.100.9').why, 'this server has a password');
  tick(32);
  assert.ok(hello('friend', 'letmein', '198.51.100.9').joined, 'six tries with no password blocked nothing');
  for (let a = 0; a < 12; a++) {
    for (let i = 0; i < 5; i++) hello('guess', `g${i}`, `203.0.113.${a + 10}`);
    tick(32); // the refused sessions close
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
