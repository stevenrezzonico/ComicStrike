// Demos (client/demo.js): the file format and its checks, and a recording of a live game
// (a NetClient on a practice-style channel to a Game with a bot, the recording started
// mid-game) played back through another NetClient: every snapshot decodes again, the
// other players' rows are the same as live, and the recorder's own row, rebuilt from their
// own block and recorded commands, is where the server had them.
import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TEAM_CT } from '../shared/player.js';
import { IN_FORWARD, IN_MOVELEFT } from '../shared/constants.js';
import {
  PROTOCOL_VERSION, CmdRing, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_WEAPON, E_HEALTH, E_TEAM, E_FIELDS, MAX_PLAYERS,
} from '../shared/protocol.js';
import { Host } from '../server/host.js';
import { NetClient } from '../client/net.js';
import {
  DemoRecorder, DemoPlayer, encodeDemo, decodeDemo, fillRecorderRow, restoreRing, demoName, DIR_IN, DIR_OUT, DEMO_FORMAT,
  RING_BYTES,
} from '../client/demo.js';

const MAP = 'de_playground';
const bsp = parseBSP(Deno.readFileSync(new URL(`../maps/${MAP}.bsp`, import.meta.url)).buffer);

Deno.test('demo: the file reads back, and anything else is refused', () => {
  const header = { format: DEMO_FORMAT, version: 1, protocol: PROTOCOL_VERSION, map: MAP, name: 'x' };
  const frames = [
    { dir: DIR_IN, t: 0, bytes: new Uint8Array([1, 2, 3]) },
    { dir: DIR_OUT, t: 16, bytes: new Uint8Array([2, 0, 0, 0, 0, 0, 0]) },
    { dir: DIR_IN, t: 17, bytes: new Uint8Array(1024).fill(7) },
  ];
  const ring = new Uint8Array(RING_BYTES).map((_, i) => i & 255);
  const bytes = encodeDemo(header, ring, frames);
  const d = decodeDemo(bytes);
  assert.deepEqual(d.header, header);
  assert.deepEqual([...d.ring.subarray(0, 4)], [0, 1, 2, 3]);
  assert.equal(d.ring.length, RING_BYTES);
  assert.equal(d.frames.length, 3);
  assert.deepEqual(d.frames.map((f) => [f.dir, f.t, f.bytes.length]), [[0, 0, 3], [1, 16, 7], [0, 17, 1024]]);
  assert.deepEqual([...d.frames[2].bytes.subarray(0, 3)], [7, 7, 7]);
  const bad = (b, why) => assert.throws(() => decodeDemo(b), Error, why);
  bad(new Uint8Array(4), 'too short');
  bad(bytes.slice(0, bytes.length - 3), 'cut in a frame');
  const magic = bytes.slice();
  magic[0] = 0x41;
  bad(magic, 'magic');
  const dir = bytes.slice();
  dir[bytes.length - 1024 - 7] = 9;
  bad(dir, 'direction');
  bad(encodeDemo({ ...header, map: '../x' }, ring, frames), 'map name');
  bad(encodeDemo({ ...header, format: 'other' }, ring, frames), 'format');
  bad(encodeDemo(header, ring, [frames[2], frames[0]]), 'time going back');
  bad(encodeDemo(header, ring, [{ dir: DIR_IN, t: 0, bytes: new Uint8Array(1025) }]), 'over a datagram');
  bad(encodeDemo(header, ring.subarray(4), frames), 'a ring of another size');
  assert.equal(demoName('mid_smokes-2'), 'mid_smokes-2');
  assert.equal(demoName('../x'), '');
  assert.equal(demoName(''), '');
});

// A Host on the playground (competitive, no cfg files) and a NetClient joined to it over a
// practice-style message channel (the worker's role played by `link`).
async function liveGame() {
  const host = new Host({ loadMap: () => bsp, listMaps: () => [MAP], print: () => {}, defer: (fn) => fn(), now: () => 0 });
  host.con.exec('mp_freezetime 0; mp_warmuptime 0');
  host.start(MAP);
  host.con.exec('bot_quota 0; bot_stop 1; bot_add_t');
  const game = host.game;
  const link = new EventTarget();
  let c = null;
  link.postMessage = (m) => {
    if (m.type === 'open') {
      c = game.connect({
        send: (b) => link.dispatchEvent(new MessageEvent('message', { data: { id: m.id, type: 'dgram', bytes: b.slice().buffer } })),
        close() {}, closed: false,
      });
    } else if (m.type === 'dgram') game.receive(c, new Uint8Array(m.bytes));
  };
  const net = new NetClient();
  net.connectLocal(link, '');
  const welcome = await net.join(TEAM_CT, 0, 0, 'recorder');
  return { host, game, net, welcome, client: () => c };
}

Deno.test({
  name: 'demo: a recording played back decodes every snapshot and shows everyone where they were',
  sanitizeOps: false, sanitizeResources: false, // the NetClients' keepalive timers
  fn: async () => {
    const { game, net, welcome } = await liveGame();
    const me = welcome.playerId, cmds = new CmdRing();
    let tick = 1;
    const live = new Map(); // seq -> rows as the live client decoded them
    const server = new Map(); // seq -> the recorder's row as the server had it
    let recorder = null;
    const step = (buttons, pitch, yaw) => {
      game.step();
      net.poll();
      cmds.put(tick, buttons, -1, pitch, yaw, net.latestSeq);
      net.sendCmds(cmds, tick++);
      const ring = game.snapshots, seq = Math.max(...ring.seq), k = ring.find(seq);
      if (recorder && k >= 0) server.set(seq, ring.ents.slice(ring.row(k, me), ring.row(k, me) + E_FIELDS));
      if (recorder && net.latest >= 0) live.set(net.latestSeq, net.ring.ents.slice(net.ring.row(net.latest, 0), net.ring.row(net.latest, MAX_PLAYERS)));
    };
    for (let i = 0; i < 150; i++) step(0, 0, 0); // into the game: deltas going
    assert.ok(net.received > 100 && net.own.team === TEAM_CT);
    recorder = net.recorder = new DemoRecorder(net, 'test', MAP, performance.now()); // the NetClient's clock
    for (let i = 0; i < 256; i++) {
      // Running and turning: the view goes into the recorded commands.
      step(i < 128 ? IN_FORWARD : IN_MOVELEFT, 10 - i * 0.05, (i * 1.7) % 360);
    }
    net.recorder = null;
    const bytes = recorder.finish();
    const demo = decodeDemo(bytes);
    assert.equal(demo.header.map, MAP);
    assert.equal(demo.header.player, me);
    assert.ok(demo.frames.some((f) => f.dir === DIR_OUT) && demo.frames.some((f) => f.dir === DIR_IN));

    // Play it back, the clock driven by hand.
    let now = 0;
    const dp = new DemoPlayer(demo, () => now);
    const pb = new NetClient();
    pb.playback = true;
    const state = { pitch: 0, yaw: 0, shots: 0, lastCmd: -1 };
    const decoded = new Map(); // seq -> rows, every snapshot as playback decoded it
    pb.onSnapshot = (k, own) => {
      fillRecorderRow(pb.ring, k, pb.welcome ? pb.welcome.playerId : -1, own, dp.cmds, state);
      decoded.set(pb.ring.seq[k], pb.ring.ents.slice(pb.ring.row(k, 0), pb.ring.row(k, MAX_PLAYERS)));
    };
    restoreRing(pb.ring, dp.ring);
    pb.connectLocal(dp, '');
    dp.stop(); // no timer: stepped below
    const take = () => pb.poll();
    take();
    assert.ok(pb.welcome && pb.welcome.playerId === me, 'the WELCOME comes first');
    for (let ms = 0; ms <= dp.length + 50; ms += 4) {
      now = ms;
      dp.step();
      take();
    }
    assert.equal(pb.closed, true, 'closed at the end ("demo over")');
    assert.equal(pb.closeReason, 'demo over');
    // Every snapshot the live client had since the recording began decoded again.
    let compared = 0;
    for (const [seq, rows] of live) {
      const got = decoded.get(seq);
      if (!got) continue;
      compared++;
      for (let id = 0; id < MAX_PLAYERS; id++) {
        if (id === me) continue;
        for (let f = 0; f < E_FIELDS; f++) assert.equal(got[id * E_FIELDS + f], rows[id * E_FIELDS + f], `seq ${seq} player ${id} field ${f}`);
      }
      // The recorder: rebuilt where the server had them, looking where they looked.
      const want = server.get(seq);
      if (!want) continue;
      const o = me * E_FIELDS;
      assert.equal(got[o + E_ACTIVE], 1);
      for (const f of [E_X, E_Y, E_Z, E_WEAPON, E_HEALTH, E_TEAM]) assert.equal(got[o + f], want[f], `recorder field ${f} at ${seq}`);
      for (const f of [E_PITCH, E_YAW]) assert.ok(Math.abs(got[o + f] - want[f]) <= 1, `recorder view ${f} at ${seq}: ${got[o + f]} vs ${want[f]}`);
    }
    assert.ok(compared > 200, `compared ${compared} of ${live.size}`);
    assert.equal(pb.dropped, 0, 'no snapshot lacked its base');
    assert.equal(compared, live.size, 'every one decoded again');
    // Somebody moved: the bot stood (bot_stop), the recorder ran.
    const first = decoded.get(Math.min(...decoded.keys())), last = decoded.get(Math.max(...decoded.keys()));
    assert.ok(Math.hypot(last[me * E_FIELDS + E_X] - first[me * E_FIELDS + E_X], last[me * E_FIELDS + E_Y] - first[me * E_FIELDS + E_Y]) > 100);
    net.close('done');
  },
});

// A hidden tab steps once a second: over 2 s of frames at once overflowed the NetClient's
// queue and playback froze for good. One step delivers at most 250 ms of demo time.
Deno.test('demo playback: one late step delivers a quarter second at most', () => {
  const frames = [];
  for (let t = 0; t <= 5000; t += 10) frames.push({ dir: DIR_IN, t, bytes: new Uint8Array([1]) });
  let now = 0, got = 0;
  const dp = new DemoPlayer({ header: {}, ring: null, frames }, () => now);
  dp.addEventListener('message', (e) => e.data.type === 'dgram' && got++);
  dp.step();
  now = 5000;
  dp.step();
  assert.equal(got, 26, 'frames at 0, 10, ..., 250 ms');
});
