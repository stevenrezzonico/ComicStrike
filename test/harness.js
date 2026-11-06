// Helpers the tests share: map and cfg files, fake clients driving a Game through the wire
// format, a server in a game mode, a small compiled yard to walk in, and maps opened in the
// editor. Each test file gets
// its own copy of this module, so the map cache is per file.
import assert from 'node:assert/strict';
import { parseBSP, parseUntrustedBSP, faceNumEdges, faceVertex, facePlane, faceSide, faceTexinfo } from '../shared/bsp.js';
import { MapBuilder, box } from '../shared/bspwriter.js';
import { IN_ATTACK } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL, PS_GROUNDENT } from '../shared/pmove.js';
import { CollisionWorld, Trace, traceHull, pointContents, hullFits, HULL_STAND, HULL_POINT } from '../shared/trace.js';
import { Nav, NAV_CELL } from '../shared/nav.js';
import { decompileBSP } from '../client/editor/decompile.js';
import { readProject, checkProject, compileProject, bounds, LIMITS } from '../client/editor/project.js';
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

// mapOrNull, with a skipped step in test `t` when the file is missing.
export async function loadBSP(t, name) {
  const bsp = mapOrNull(name);
  if (!bsp) await t.step({ name: `skipped: maps/${name}.bsp missing`, fn: () => {}, ignore: true });
  return bsp;
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

// --- Maps opened in the editor (client/editor/decompile.js) ---------------------------------

// maps/<name>.bsp as bytes, or null when it is missing.
export const readMapFile = (name) => {
  try {
    return Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url));
  } catch {
    return null;
  }
};

// Solid or not, at random points within the opened map's bounds: the original against the
// map compiled back from its project.
export function solidAgreement(bsp, p, out, samples = 3000) {
  const a = CollisionWorld.fromBSP(bsp), b = CollisionWorld.fromBSP(parseUntrustedBSP(out.buffer));
  const box = bounds(p);
  let seed = 7, same = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < samples; i++) {
    const q = [0, 1, 2].map((k) => box[k] + (box[k + 3] - box[k]) * rnd());
    if ((pointContents(a, ...q) === -1) === (pointContents(b, ...q) === -1)) same++;
  }
  return same / samples;
}

// Rays from random points open in both maps: of the hits on a face drawn in the original,
// the share where the map compiled back draws none (a hole: a cell side that came back
// with no texture compiles to no face, and the wall was see-through) or only sky where the
// original drew a wall (a side over a wall face and a sky face that took the sky).
export function wallHoles(bsp, out, rays = 2000) {
  const back = parseUntrustedBSP(out.slice().buffer);
  const maps = [bsp, back].map((m) => ({ world: CollisionWorld.fromBSP(m), faces: facesOf(m) }));
  const box = [0, 1, 2, 3, 4, 5].map((k) => bsp.modelsF[k]), tr = new Trace();
  let seed = 11, walls = 0, missing = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < rays;) {
    const q = [0, 1, 2].map((k) => box[k] + (box[k + 3] - box[k]) * rnd());
    if (maps.some((m) => pointContents(m.world, ...q) !== -1)) continue;
    i++;
    const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z), dir = [r * Math.cos(t), r * Math.sin(t), z];
    const hit = maps.map((m) => {
      traceHull(m.world, HULL_POINT, ...q, q[0] + dir[0] * 4000, q[1] + dir[1] * 4000, q[2] + dir[2] * 4000, tr);
      return tr.fraction < 1 && !tr.startsolid ? [tr.endx, tr.endy, tr.endz] : null;
    });
    if (!hit[0] || !hit[1] || Math.hypot(hit[0][0] - hit[1][0], hit[0][1] - hit[1][1], hit[0][2] - hit[1][2]) > 2) continue;
    if (drawnAt(maps[0].faces, hit[0], dir) !== 'wall') continue;
    walls++;
    if (drawnAt(maps[1].faces, hit[1], dir) !== 'wall') missing++;
  }
  return missing / Math.max(walls, 1);
}

// A map's faces as outward planes and corner loops, with their bounds.
function facesOf(b) {
  const faces = [];
  for (let f = 0; f < b.numFaces; f++) {
    const pl = facePlane(b, f), s = faceSide(b, f) ? -1 : 1;
    const pts = [];
    for (let i = 0; i < faceNumEdges(b, f); i++) {
      const v = faceVertex(b, f, i);
      pts.push([b.vertices[v * 3], b.vertices[v * 3 + 1], b.vertices[v * 3 + 2]]);
    }
    faces.push({
      sky: /^sky/i.test(b.textureNames[b.texinfoI[faceTexinfo(b, f) * 10 + 8]] || ''),
      n: [0, 1, 2].map((k) => b.planesF[pl * 5 + k] * s), d: b.planesF[pl * 5 + 3] * s, pts,
      lo: [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k])) - 1), hi: [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])) + 1),
    });
  }
  return faces;
}

// What is drawn at point h facing a ray along dir: 'wall', 'sky' or null.
function drawnAt(faces, h, dir) {
  const within = (f) => {
    let sign = 0;
    for (let i = 0; i < f.pts.length; i++) {
      const p = f.pts[i], q = f.pts[(i + 1) % f.pts.length], e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const r = [h[0] - p[0], h[1] - p[1], h[2] - p[2]];
      const x = (e[1] * r[2] - e[2] * r[1]) * f.n[0] + (e[2] * r[0] - e[0] * r[2]) * f.n[1] + (e[0] * r[1] - e[1] * r[0]) * f.n[2];
      if (Math.abs(x) < 0.5) continue;
      if (sign && Math.sign(x) !== sign) return false;
      sign = Math.sign(x);
    }
    return true;
  };
  const at = faces.filter((f) => h.every((v, k) => v >= f.lo[k] && v <= f.hi[k]) &&
    Math.abs(f.n[0] * h[0] + f.n[1] * h[1] + f.n[2] * h[2] - f.d) < 1 && f.n[0] * dir[0] + f.n[1] * dir[1] + f.n[2] * dir[2] < 0 &&
    within(f));
  return at.some((f) => !f.sky) ? 'wall' : at.length ? 'sky' : null;
}

// A map opened in the editor: the BSP, the project and report decompileBSP gave, and the
// project as the editor keeps it.
export function openInEditor(name) {
  const bsp = parseUntrustedBSP(readMapFile(name).slice().buffer);
  const { project, report } = decompileBSP(bsp, `${name}.bsp`);
  const p = readProject(JSON.parse(JSON.stringify(project))); // as the editor keeps it
  return { bsp, project, report, p };
}

// One of Valve's maps opened in the editor (skipped without it: not in the repository) opens
// under the editor's limits, compiles back the same and has a bot path from spawn to spawn.
// A file of its own each (decompile_*.test.js), as each takes 20-30 s: deno test --parallel
// runs them side by side.
export function valveRoundTrip(name) {
  Deno.test({
    name: `decompile: ${name} opens under the editor's limits, compiles back the same, and bots find their way`,
    ignore: !readMapFile(name),
    fn() {
      const { bsp, p } = openInEditor(name);
      assert.ok(p.brushes.length <= LIMITS.brushes, `${p.brushes.length} shapes`);
      assert.deepEqual(checkProject(p).errors, []);
      const out = compileProject(p, 'draft').bytes;
      assert.ok(solidAgreement(bsp, p, out, 2000) > 0.99, 'solid where it was solid');
      const h = wallHoles(bsp, out);
      assert.ok(h < 0.002, `walls drawn where they were (${(h * 100).toFixed(2)} % of hits on no face or sky)`);
      const back = parseUntrustedBSP(out.buffer), world = CollisionWorld.fromBSP(back);
      const nav = new Nav(back, world, NAV_CELL, true);
      const node = (cls) => {
        const [x, y, z] = back.entities.find((e) => e.classname === cls).origin.split(' ').map(Number);
        return nav.nodeAt(x, y, z - 36);
      };
      assert.ok(nav.path(node('info_player_deathmatch'), node('info_player_start'), new Int32Array(8192)) > 0, 'a way from spawn to spawn');
    },
  });
}
