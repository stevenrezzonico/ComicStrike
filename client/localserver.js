// Practice: the game server in a Web Worker. The same Host and Game as the real server
// (server/host.js, served to the browser for this) on the same fixed 64 Hz loop, with
// bots; the page talks to it like to the network (client/net.js `connectLocal`), one
// datagram per message. The worker fetches the map and the mode cfgs itself (the Host
// reads them synchronously), and handles `map` / `changelevel` by fetching first.
//
// Messages in:  start { map, mode: a GAME_MODES name ('competitive', 'casual', 'wingman', 'armsrace',
//                        'demolition', 'deathmatch', 'demo'), players, difficulty },
//               open { id }, dgram { id, bytes }, close { id },
//               pause { on }: the page's pause menu; the ticks stop (bots, the round clock,
//                 timeouts) and go on from where they were
// Messages out: ready { rcon } | failed { error }, dgram { id, bytes }, close { id, reason }

import { Host, GAME_MODES } from '../server/host.js';
import { parseBSP } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';

const CFGS = Object.values(GAME_MODES).map((name) => `gamemode_${name}.cfg`);
const TICK_MS = 1000 / TICK_RATE;

let host = null;
let players = 0; // bot_quota (fill) once the player is in
const maps = new Map(); // name -> parsed BSP
const cfgs = {};
const sessions = new Map(); // id -> { game, client }

async function fetchMap(name) {
  if (!/^[\w-]+$/.test(name)) throw new Error(`bad map name: ${name}`);
  if (!maps.has(name)) {
    const res = await fetch(`/maps/${name}.bsp`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    maps.clear(); // one map in memory at a time
    maps.set(name, parseBSP(await res.arrayBuffer()));
  }
  return maps.get(name);
}

async function start({ map, mode, players: n, difficulty }) {
  const [list] = await Promise.all([
    fetch('/maps.json').then((r) => r.json()).catch(() => []),
    ...CFGS.map((name) => fetch(`/cfg/${name}`).then((r) => (r.ok ? r.text() : null)).then((t) => {
      cfgs[name] = t;
    })),
    fetchMap(map),
  ]);
  host = new Host({
    loadMap: (name) => {
      if (!maps.has(name)) throw new Error('not loaded');
      return maps.get(name);
    },
    listMaps: () => list,
    readCfg: (name) => cfgs[name] ?? null,
    print: (s) => console.log(s),
  });
  // The page's console reaches the server with rcon: a password only it knows.
  const rcon = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16)).join('');
  host.password.set(rcon);
  const [type, gameMode] = Object.keys(GAME_MODES).find((k) => GAME_MODES[k] === mode)?.split('/') || ['0', '1'];
  host.con.exec(`game_type ${type}; game_mode ${gameMode}; hostname Practice; bot_difficulty ${difficulty}`);
  host.start(map);
  for (const name of ['map', 'changelevel']) { // fetch the map first (the Host loads synchronously)
    host.con.command(name, (a, ctx) => {
      fetchMap(a[1] || '').then(() => host.changeLevel(a[1], ctx), (err) => host.con.out(ctx, `map ${a[1]}: ${err.message}`));
    }, `${name} <name>: switches to another map`);
  }
  players = n;
  loop();
  postMessage({ type: 'ready', rcon });
}

// Drift-free fixed-rate loop on the monotonic clock (as server/main.js). Paused, it keeps
// the epoch with the tick, so no ticks are owed when the game goes on.
let epoch = 0;
let paused = false;
function loop() {
  epoch = performance.now();
  const step = () => {
    const game = host.game;
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
  if (m.type === 'start') {
    start(m).catch((err) => postMessage({ type: 'failed', error: String(err.message || err) }));
  } else if (m.type === 'open') {
    const game = host.game, id = m.id;
    const session = {
      send(bytes) {
        const copy = bytes.slice();
        postMessage({ type: 'dgram', id, bytes: copy.buffer }, [copy.buffer]);
      },
      close(reason) {
        sessions.delete(id);
        postMessage({ type: 'close', id, reason });
      },
    };
    const client = game.connect(session);
    if (client) sessions.set(id, { game, client });
    if (players) { // bots fill the teams once the player is there (they balance around him)
      host.con.exec(`bot_quota_mode fill; bot_quota ${players}`);
      players = 0;
    }
  } else if (m.type === 'dgram') {
    const s = sessions.get(m.id);
    if (s && s.client) s.game.receive(s.client, new Uint8Array(m.bytes));
  } else if (m.type === 'close') {
    const s = sessions.get(m.id);
    if (s) s.game.disconnect(s.client);
    sessions.delete(m.id);
  } else if (m.type === 'pause') {
    paused = m.on;
  }
};
