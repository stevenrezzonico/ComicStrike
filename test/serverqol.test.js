// Server conveniences: sv_password.
import assert from 'node:assert/strict';
import { TEAM_T } from '../shared/player.js';
import { Writer, Reader, writeHello, S2C_REJECT, S2C_WELCOME } from '../shared/protocol.js';
import { loadMap, readCfg, quiet } from './harness.js';
import { Host } from '../server/host.js';

// A server on de_playground with a clock the test moves; `hello(name, password, address)`
// connects a session and sends its HELLO: the client, the datagrams it got and whether
// its session was closed.
function server() {
  const clock = { ms: 0 };
  const host = new Host({
    loadMap, listMaps: () => ['de_playground'], readCfg, print: () => {}, defer: (fn) => fn(), now: () => clock.ms,
  });
  quiet(() => host.start('de_playground'));
  const w = new Writer();
  const hello = (name, password = '', address = '203.0.113.7') => {
    const sent = [];
    const session = { send: (b) => sent.push(b.slice()), close: (why) => (session.closed = why), closed: '', address };
    const c = host.game.connect(session);
    quiet(() => host.game.receive(c, writeHello(w, TEAM_T, 0, 0, name, '', password).slice()));
    const reject = sent.find((b) => b[0] === S2C_REJECT);
    let why = '';
    if (reject) {
      const r = new Reader().set(reject);
      r.u8v();
      why = r.str();
    }
    return { c, joined: c.joined, welcomed: sent.some((b) => b[0] === S2C_WELCOME), why, session, sent };
  };
  return { host, hello, clock, w };
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
