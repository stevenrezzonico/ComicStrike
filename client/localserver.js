// Practice: the game server in a Web Worker. The same Host and Game as the real server
// (server/host.js, served to the browser for this) on the same fixed 64 Hz loop, with
// bots; the page talks to it like to the network (client/net.js `connectLocal`), with no
// message object around the datagrams: in, a Uint8Array of the session id (u32), the length
// (u16) and one datagram; out, a task's datagrams in one transferred ArrayBuffer after the
// session id, each after its u16 length (a message is an event, an object and a buffer on
// the page's heap, and a tick sends 2-4 datagrams).
// The worker fetches the map and the mode cfgs itself (the Host
// reads them synchronously), and handles `map` / `changelevel` by fetching first.
//
// Messages in:  start { map, mode: a GAME_MODES name ('competitive', 'casual', 'wingman', 'armsrace',
//                        'demolition', 'deathmatch', 'demo'), players, difficulty, armoury
//                        (the map's own weapons laid out: mp_armoury_entities),
//                        bytes: the map file itself (a player's own map, checked as untrusted:
//                        parseUntrustedBSP), else fetched from maps/ },
//               open { id, sab? }: with a SharedArrayBuffer (a cross-origin isolated page) the
//                 datagrams go through its two rings (client/ring.js) and no message carries
//                 them; else as below,
//               a Uint8Array (the session id, the length, a datagram), close { id },
//               pause { on }: the page's pause menu; the ticks stop (bots, the round clock,
//                 timeouts) and go on from where they were
// Messages out: ready { rcon, names: the server console's catalog() } | failed { error },
//               an ArrayBuffer (the session id, then each datagram after its length; little-endian), close { id, reason }

import { Host, GAME_MODES } from '../server/host.js';
import { parseBSP, parseUntrustedBSP } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { Ring, SLOT, TO_WORKER_SLOTS, TO_PAGE_SLOTS, ringBytes } from './ring.js';

const CFGS = Object.values(GAME_MODES).map((name) => `gamemode_${name}.cfg`);
const TICK_MS = 1000 / TICK_RATE;

let host = null;
let players = 0; // bot_quota (fill) once the player is in
const maps = new Map(); // name -> parsed BSP
let own = null; // a player's own map, from its bytes: { name, bsp } (kept across map changes)
const cfgs = {};
const sessions = new Map(); // id -> { game, client, rings: { in, out } or null }
const IN = new Uint8Array(SLOT); // a datagram taken from a page's ring

// Every session's datagrams from its page's ring, before the ticks (the page puts its
// commands there at its own ticks; nothing wakes this thread for them).
function drainRings() {
  for (const s of sessions.values()) {
    if (!s.rings || !s.client) continue;
    for (let n = s.rings.in.take(IN, 0); n >= 0; n = s.rings.in.take(IN, 0)) s.game.receive(s.client, IN.subarray(2, 2 + n));
  }
}
// Datagrams waiting to go out, by session id: sent together once the task that made them
// (the ticks due, a message from the page) is over.
const pending = new Map(); // id -> [Uint8Array copies]
let flushQueued = false;
function flush() {
  flushQueued = false;
  for (const [id, list] of pending) {
    let n = 4;
    for (const b of list) n += 2 + b.length;
    const out = new Uint8Array(n);
    out[0] = id;
    out[1] = id >> 8;
    out[2] = id >> 16;
    out[3] = id >> 24;
    let o = 4;
    for (const b of list) {
      out[o] = b.length & 255;
      out[o + 1] = b.length >> 8;
      out.set(b, o + 2);
      o += 2 + b.length;
    }
    postMessage(out.buffer, [out.buffer]);
  }
  pending.clear();
}

async function fetchMap(name) {
  if (own && name === own.name) return own.bsp;
  if (!/^[\w-]+$/.test(name)) throw new Error(`bad map name: ${name}`);
  if (!maps.has(name)) {
    const res = await fetch(`/maps/${name}.bsp`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    maps.clear(); // one map in memory at a time
    maps.set(name, parseBSP(await res.arrayBuffer()));
  }
  return maps.get(name);
}

async function start({ map, mode, players: n, difficulty, armoury = true, bytes }) {
  if (bytes) own = { name: map, bsp: parseUntrustedBSP(bytes) };
  const [list] = await Promise.all([
    fetch('/maps.json').then((r) => r.json()).catch(() => []),
    ...CFGS.map((name) => fetch(`/cfg/${name}`).then((r) => (r.ok ? r.text() : null)).then((t) => {
      cfgs[name] = t;
    })),
    fetchMap(map),
  ]);
  host = new Host({
    loadMap: (name) => {
      if (own && name === own.name) return own.bsp;
      if (!maps.has(name)) throw new Error('not loaded');
      return maps.get(name);
    },
    listMaps: () => (own ? [own.name, ...list.filter((m) => m !== own.name)] : list),
    readCfg: (name) => cfgs[name] ?? null,
    print: (s) => console.log(s),
  });
  // The page's console reaches the server with rcon: a password only it knows.
  const rcon = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16)).join('');
  host.password.set(rcon);
  const [type, gameMode] = Object.keys(GAME_MODES).find((k) => GAME_MODES[k] === mode)?.split('/') || ['0', '1'];
  host.con.exec(`game_type ${type}; game_mode ${gameMode}; hostname Practice; bot_difficulty ${difficulty}; ` +
    `mp_armoury_entities ${armoury ? 1 : 0}`);
  host.start(map);
  for (const name of ['map', 'changelevel']) { // fetch the map first (the Host loads synchronously)
    host.con.command(name, (a, ctx) => {
      fetchMap(a[1] || '').then(() => host.changeLevel(a[1], ctx), (err) => host.con.out(ctx, `map ${a[1]}: ${err.message}`));
    }, `${name} <name>: switches to another map`);
  }
  players = n;
  loop();
  postMessage({ type: 'ready', rcon, names: host.con.catalog() }); // names: the console's suggestions
}

// Drift-free fixed-rate loop on the monotonic clock (as server/main.js). Paused, it keeps
// the epoch with the tick, so no ticks are owed when the game goes on.
let epoch = 0;
let paused = false;
function loop() {
  epoch = performance.now();
  const step = () => {
    const game = host.game;
    drainRings();
    if (paused) {
      epoch = performance.now() - game.tick * TICK_MS;
      setTimeout(step, 50);
      return;
    }
    const due = Math.floor((performance.now() - epoch) / TICK_MS);
    let ran = 0;
    while (game.tick < due && ran < 8) {
      host.step(game);
      ran++;
    }
    if (game.tick < due) epoch = performance.now() - game.tick * TICK_MS; // fell behind: resync
    setTimeout(step, Math.max(0, epoch + (game.tick + 1) * TICK_MS - performance.now()));
  };
  step();
}

onmessage = (e) => {
  const m = e.data;
  if (m instanceof Uint8Array) { // a datagram from the page: its session id and length first
    const s = m.length >= 6 && sessions.get(m[0] | m[1] << 8 | m[2] << 16 | m[3] << 24);
    if (s && s.client) s.game.receive(s.client, m.subarray(6, 6 + (m[4] | m[5] << 8)));
    return;
  }
  if (m.type === 'start') {
    start(m).catch((err) => postMessage({ type: 'failed', error: String(err.message || err) }));
  } else if (m.type === 'open') {
    const game = host.game, id = m.id;
    const rings = m.sab
      ? { in: new Ring(m.sab, 0, TO_WORKER_SLOTS), out: new Ring(m.sab, ringBytes(TO_WORKER_SLOTS), TO_PAGE_SLOTS) } : null;
    const session = {
      send(bytes) {
        if (rings) { // the page takes it at its next tick (a full ring drops it, as a network would)
          rings.out.put(bytes);
          return;
        }
        if (!pending.has(id)) pending.set(id, []);
        pending.get(id).push(bytes.slice()); // (the server's buffers are reused)
        if (!flushQueued) {
          flushQueued = true;
          queueMicrotask(flush);
        }
      },
      close(reason) {
        flush(); // what was sent before the close arrives first
        sessions.delete(id);
        postMessage({ type: 'close', id, reason });
      },
    };
    const client = game.connect(session);
    if (client) sessions.set(id, { game, client, rings });
    if (players) { // bots fill the teams once the player is there (they balance around him)
      host.con.exec(`bot_quota_mode fill; bot_quota ${players}`);
      players = 0;
    }
  } else if (m.type === 'close') {
    const s = sessions.get(m.id);
    if (s) s.game.disconnect(s.client);
    sessions.delete(m.id);
  } else if (m.type === 'pause') {
    paused = m.on;
  }
};
