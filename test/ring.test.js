import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TEAM_CT } from '../shared/player.js';
import { CmdRing, MAX_DATAGRAM } from '../shared/protocol.js';
import { Host } from '../server/host.js';
import { NetClient } from '../client/net.js';
import { Ring, SLOT, TO_WORKER_SLOTS, TO_PAGE_SLOTS, ringBytes } from '../client/ring.js';

Deno.test('ring: datagrams come out in order and whole, wrap round, a full ring drops', () => {
  const r = new Ring(new SharedArrayBuffer(ringBytes(4)), 0, 4), out = new Uint8Array(SLOT * 2);
  assert.equal(r.take(out, 0), -1, 'empty');
  for (let round = 0; round < 3; round++) { // past the end of the slots and round again
    for (let k = 0; k < 3; k++) assert.equal(r.put(new Uint8Array(10 + k).fill(round * 3 + k)), true);
    assert.equal(r.put(new Uint8Array(5)), false, 'full: one slot stays free');
    for (let k = 0; k < 3; k++) {
      const n = r.take(out, SLOT);
      assert.equal(n, 10 + k);
      assert.deepEqual([...out.subarray(SLOT + 2, SLOT + 2 + n)], new Array(n).fill(round * 3 + k));
    }
    assert.equal(r.take(out, 0), -1);
  }
  assert.equal(r.put(new Uint8Array(MAX_DATAGRAM)), true, 'the largest datagram fits');
  assert.equal(r.take(out, 0), MAX_DATAGRAM);
  assert.equal(r.put(new Uint8Array(MAX_DATAGRAM + 1)), false, 'too big');
});

Deno.test({
  name: 'ring: practice over shared memory joins, decodes snapshots and names, and sends no message a tick',
  sanitizeOps: false, sanitizeResources: false, // the NetClient's keepalive timer
  fn: async () => {
    const bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url)).buffer);
    const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_playground'], print: () => {}, now: () => 0 });
    host.con.exec('mp_freezetime 0; mp_warmuptime 0');
    host.start('de_playground');
    host.con.exec('bot_quota 0; bot_stop 1; bot_add_t');
    const game = host.game;
    // The worker's end, as client/localserver.js has it: rings from the open message.
    const worker = new EventTarget();
    let rings = null, client = null, messages = 0;
    const IN = new Uint8Array(SLOT);
    worker.postMessage = (m) => {
      messages++;
      if (m.type !== 'open') return;
      assert.ok(m.sab instanceof SharedArrayBuffer);
      rings = { in: new Ring(m.sab, 0, TO_WORKER_SLOTS), out: new Ring(m.sab, ringBytes(TO_WORKER_SLOTS), TO_PAGE_SLOTS) };
      client = game.connect({ send: (b) => rings.out.put(b), close() {}, closed: false });
    };
    const pump = () => {
      for (let n = rings.in.take(IN, 0); n >= 0; n = rings.in.take(IN, 0)) game.receive(client, IN.subarray(2, 2 + n));
    };
    const net = new NetClient();
    net.connectLocal(worker, '', true);
    const timer = setInterval(pump, 5); // join() waits on timers
    const welcome = await net.join(TEAM_CT, 0, 0, 'shared');
    clearInterval(timer);
    assert.equal(messages, 1, 'only the open went as a message');
    const cmds = new CmdRing();
    for (let t = 1; t <= 120; t++) {
      pump();
      game.step();
      net.poll();
      cmds.put(t, 0, -1, 0, 0, net.latestSeq);
      net.sendCmds(cmds, t);
    }
    assert.equal(messages, 1, 'and nothing per tick');
    assert.ok(net.received > 100, `snapshots decoded: ${net.received}`);
    assert.equal(net.dropped, 0);
    assert.equal(net.own.team, TEAM_CT);
    assert.equal(net.names[welcome.playerId], 'shared', 'text read from the copies, not from shared memory');
    assert.ok(net.keep.info && !(net.keep.info.buffer instanceof SharedArrayBuffer), 'kept datagrams are copies');
  },
});
