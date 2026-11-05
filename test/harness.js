// Helpers the tests share: map and cfg files, fake clients driving a Game through the wire
// format, a server in a game mode, and a small compiled yard to walk in. Each test file gets
// its own copy of this module, so the map cache is per file.
import assert from 'node:assert/strict';
import { parseBSP, parseUntrustedBSP } from '../shared/bsp.js';
import { MapBuilder, box } from '../shared/bspwriter.js';
import { IN_ATTACK } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL, PS_GROUNDENT } from '../shared/pmove.js';
import { hullFits, HULL_STAND } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PHASE_LIVE } from '../shared/economy.js';
import {
  Writer, Reader, CmdRing, SnapshotRing, OwnState, writeHello, writeCmds, writeBuy, readSnapshot, S2C_SNAPSHOT,
} from '../shared/protocol.js';
import { Game } from '../server/game.js';
import { Host } from '../server/host.js';

// --- Files -------------------------------------------------------------------------------

const maps = {};

// maps/<name>.bsp parsed once; throws when the file is missing.
export function loadMap(name) {
  if (!maps[name]) maps[name] = parseBSP(Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url)).buffer);
  return maps[name];
}

// loadMap, or null when the file is missing (Valve's maps are not in the repository).
export function mapOrNull(name) {
  try {
    return loadMap(name);
  } catch {
    return null;
  }
}

// maps/<name>.bsp parsed afresh, or null with a skipped step in test `t` when it is missing.
export async function loadBSP(t, name) {
  try {
    return parseBSP((await Deno.readFile(new URL(`../maps/${name}.bsp`, import.meta.url))).buffer);
  } catch {
    await t.step({ name: `skipped: maps/${name}.bsp missing`, fn: () => {}, ignore: true });
    return null;
  }
}

// cfg/<name> as text, or null.
export function readCfg(name) {
  try {
    return Deno.readTextFileSync(new URL(`../cfg/${name}`, import.meta.url));
  } catch {
    return null;
  }
}

// A seeded random (mulberry32), so bot decisions and games repeat.
export function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// fn's result, with console.log silent while it runs (a Game logs as it loads).
export function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

// --- Fake clients --------------------------------------------------------------------------

// A client of `game` whose HELLO came in, with its own command ring; it is sent to through `session`.
export function joinClient(game, w, name, team, session = { send() {}, close() {} }) {
  const c = game.connect(session);
  game.receive(c, writeHello(w, team, 0, 0, name).slice());
  c.cmds = new CmdRing();
  c.tick = 1;
  return c;
}

// c's next user command, delivered as a client sends it every tick.
export function sendCmd(game, w, c, buttons = 0, select = -1, pitch = 0, yaw = 0) {
  c.cmds.put(c.tick, buttons, select, pitch, yaw, 0);
  game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
}

// `ticks` game ticks, every client sending what its `input` holds: { buttons, pitch, yaw } and
// a weapon slot to `select` (sent once, then -1).
export function runInputs(game, w, clients, ticks) {
  for (let i = 0; i < ticks; i++) {
    for (const c of clients) {
      const k = c.input;
      sendCmd(game, w, c, k.buttons, k.select ?? -1, k.pitch, k.yaw);
      k.select = -1;
    }
    game.step();
  }
}

// Puts c's hull center at (x, y, z), at rest.
export function teleport(c, x, y, z) {
  const f = c.player.ps.f;
  f[PS_ORIGIN] = x;
  f[PS_ORIGIN + 1] = y;
  f[PS_ORIGIN + 2] = z;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
}

// --- A server in a game mode ---------------------------------------------------------------

// A server on de_dust2 in game_type / game_mode `mode` (the real cfgs), `rules` overriding.
export function modeServer(mode, rules = { immunityTime: 0, freezeTime: 0 }) {
  const host = new Host({ loadMap, listMaps: () => ['de_dust2'], readCfg, print: () => {}, rules, defer: (fn) => fn() });
  host.con.exec(`game_type ${mode[0]}; game_mode ${mode[1]}`);
  host.start('de_dust2');
  const w = new Writer();
  const clients = [];
  let buyId = 0;
  const join = (name, team) => {
    const c = joinClient(host.game, w, name, team);
    c.input = { buttons: 0, pitch: 0, yaw: 0 };
    c.buy = (item) => host.game.receive(c, writeBuy(w, ++buyId, item).slice());
    clients.push(c);
    return c;
  };
  const run = (ticks) => runInputs(host.game, w, clients, ticks);
  const live = () => {
    for (let i = 0; i < 64 * 5 && host.game.phase !== PHASE_LIVE; i++) run(1);
    assert.equal(host.game.phase, PHASE_LIVE);
  };
  return { host, join, run, live };
}

// `shooter` 120 units west of `target` on open ground, aiming at its chest.
export function lineUp(game, shooter, target) {
  for (const s of game.spawns[TEAM_CT]) {
    const [x, y, z] = s;
    if (!hullFits(game.world, HULL_STAND, x - 120, y, z)) continue;
    teleport(target, x, y, z);
    teleport(shooter, x - 120, y, z);
    shooter.input.yaw = 0;
    shooter.input.pitch = 8;
    target.input.yaw = 180;
    return;
  }
  throw new Error('no open spawn');
}

// Holds the trigger (a tap per tick pair, for pistols) until `done()` or `ticks` pass.
export function fireUntil(run, c, done, ticks = 300) {
  for (let i = 0; i < ticks && !done(); i++) {
    c.input.buttons = i & 1 ? 0 : IN_ATTACK;
    run(1);
  }
  c.input.buttons = 0;
}

// --- A compiled yard -----------------------------------------------------------------------

export const TEX = {
  sky: [256, 256], crete3_wall02: [128, 128], '-0sand': [128, 128], steel: [64, 64], crate08: [64, 64], glass_med: [64, 64],
};
export const W = 'crete3_wall02';

// A walled yard 2048 x 1024 under the sky, plus `extra(map)`.
export function yard(extra) {
  const map = new MapBuilder(TEX, { message: 'test' });
  map.world.push(
    box(-1024, -512, -32, 1024, 512, 0, '-0sand'),
    box(-1056, -544, -32, -1024, 544, 512, W), box(1024, -544, -32, 1056, 544, 512, W),
    box(-1024, -544, -32, 1024, -512, 512, W), box(-1024, 512, -32, 1024, 544, 512, W),
    box(-1056, -544, 512, 1056, 544, 544, 'sky'),
  );
  extra(map);
  map.point({ classname: 'info_player_deathmatch', origin: '-900 0 37', angles: '0 0 0' });
  map.point({ classname: 'info_player_start', origin: '900 0 37', angles: '0 180 0' });
  return parseUntrustedBSP(map.compile({ light: 'draft' }).bytes.buffer);
}

// A game on `bsp` with one player driven tick by tick (its snapshots kept for reading).
export function walker(bsp, team = TEAM_T) {
  const game = quiet(() => new Game('test', bsp, { rounds: false }));
  const w = new Writer();
  const inbox = [];
  const c = joinClient(game, w, 'tester', team, { send: (b) => inbox.push(b.slice()), close() {} });
  const run = (ticks, buttons = 0, yaw = 0, pitch = 0) => {
    for (let i = 0; i < ticks; i++) {
      sendCmd(game, w, c, buttons, -1, pitch, yaw);
      game.step();
    }
  };
  const put = (x, y, feet) => {
    teleport(c, x, y, feet + 36);
    c.player.ps.i[PS_GROUNDENT] = -1; // not riding whatever it stood on (a mover pushes its riders)
  };
  // The newest snapshot the server sent, read like the client does.
  const ring = new SnapshotRing(), own = new OwnState(), r = new Reader();
  const snapshot = () => {
    let k = -1;
    for (const bytes of inbox.splice(0)) {
      r.set(bytes);
      if (r.u8v() !== S2C_SNAPSHOT) continue;
      const s = readSnapshot(r, ring, own);
      if (s >= 0) k = s;
    }
    return { k, ring, own };
  };
  run(2);
  return { game, c, run, put, feet: () => c.player.ps.f[PS_ORIGIN + 2] - 36, pos: () => c.player.ps.f, snapshot, inbox };
}
