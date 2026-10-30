import assert from 'node:assert/strict';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_STAND } from '../shared/trace.js';
import { Nav, NAV_CELL } from '../shared/nav.js';
import { Overview } from '../shared/overview.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { PHASE_LIVE } from '../shared/economy.js';
import { readProject, checkProject, compileProject } from '../client/editor/project.js';
import { TEAM_CT } from '../shared/player.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
import { Host } from '../server/host.js';

// de_inkwell is our own defusal map (tools/gen_inkwell.js), so it is in the repository:
// its editor project and the map compiled from it.
const projectText = Deno.readTextFileSync(new URL('../maps/de_inkwell.cmap.json', import.meta.url));
const bytes = Deno.readFileSync(new URL('../maps/de_inkwell.bsp', import.meta.url));
const bsp = parseUntrustedBSP(bytes.slice().buffer); // checked like a map from outside
const world = CollisionWorld.fromBSP(bsp);
const at = (cls) => bsp.entities.filter((e) => e.classname === cls);
const readCfg = (name) => {
  try {
    return Deno.readTextFileSync(new URL(`../cfg/${name}`, import.meta.url));
  } catch {
    return null;
  }
};

Deno.test('de_inkwell: the map is its project compiled; the project reads clean with no problems', () => {
  const p = readProject(projectText);
  assert.equal(p.brushes.length, JSON.parse(projectText).brushes.length, 'nothing dropped by readProject');
  const { errors, warnings } = checkProject(p);
  assert.deepEqual([...errors, ...warnings].map((x) => x.text), []);
  const built = compileProject(p, 'full').bytes; // (compared by hand: a failing deepEqual diffs a megabyte)
  assert.ok(built.length === bytes.length && built.every((v, i) => v === bytes[i]),
    'maps/de_inkwell.bsp is up to date (rerun tools/gen_inkwell.js)');
});

Deno.test('de_inkwell: spawns, zones, ladders, water, doors and breakables; spawns stand on the floor', () => {
  assert.equal(at('info_player_deathmatch').length, 10);
  assert.equal(at('info_player_start').length, 10);
  assert.equal(at('func_buyzone').length, 2);
  assert.equal(at('func_bomb_target').length, 2);
  assert.equal(at('func_ladder').length, 3);
  assert.equal(at('func_water').length, 1);
  assert.equal(at('func_conveyor').length, 1);
  assert.equal(at('func_door_rotating').length, 2);
  assert.ok(at('func_breakable').length >= 10);
  const tr = new Trace();
  for (const e of [...at('info_player_deathmatch'), ...at('info_player_start')]) {
    const [x, y, z] = e.origin.split(' ').map(Number);
    assert.ok(hullFits(world, HULL_STAND, x, y, z), `room at ${e.origin}`);
    traceHull(world, HULL_STAND, x, y, z, x, y, z - 64, tr);
    assert.ok(tr.fraction < 0.05, `standing on the floor at ${e.origin}`);
    traceHull(world, HULL_STAND, x, y, z, x, y, z + 8192, tr);
    assert.ok(tr.fraction < 1, 'the sky holds');
  }
});

// Run times (250 units a second) along the navigation's paths, doors open as bots walk them.
Deno.test('de_inkwell: timings like a Valve defusal map, by every lane', () => {
  const nav = new Nav(bsp, world, NAV_CELL, true);
  const out = new Int32Array(8192);
  const secs = (a, b) => {
    const n = nav.path(a, b, out);
    assert.ok(n > 0, 'a way');
    let d = 0;
    for (let i = 1; i < n; i++) d += Math.hypot(nav.x[out[i]] - nav.x[out[i - 1]], nav.y[out[i]] - nav.y[out[i - 1]]);
    return d / 250;
  };
  const spawn = (cls) => {
    const [x, y, z] = at(cls)[0].origin.split(' ').map(Number);
    return nav.nodeAt(x, y, z - 36);
  };
  const t = spawn('info_player_deathmatch'), ct = spawn('info_player_start');
  const f = bsp.modelsF;
  const [a, b] = at('func_bomb_target').map((e) => {
    const m = +e.model.slice(1);
    return nav.nodeAt((f[m * 16] + f[m * 16 + 3]) / 2, (f[m * 16 + 1] + f[m * 16 + 4]) / 2, f[m * 16 + 2] + 8);
  });
  const via = (x, y, z, site) => {
    const n = nav.nodeAt(x, y, z);
    assert.ok(n >= 0, `on the navigation at ${x} ${y} ${z}`);
    return secs(t, n) + secs(n, site);
  };
  const inRange = (s, lo, hi, what) => assert.ok(s >= lo && s <= hi, `${what}: ${s.toFixed(1)} s`);
  inRange(secs(t, a), 17, 21, 'T to A');
  inRange(secs(t, b), 17, 21, 'T to B');
  inRange(secs(ct, a), 8, 11, 'CT to A');
  inRange(secs(ct, b), 7, 11, 'CT to B');
  inRange(via(1792, -1500, 0, a), 17, 22, 'T to A by Long (the gate)');
  inRange(via(1216, 384, 0, a), 17, 21, 'T to A by Short (the press hall)');
  inRange(via(-2016, -1300, -64, b), 17, 22, 'T to B by the tunnel');
  inRange(via(-900, -320, 0, b), 17, 22, 'T to B by the Fish alley');
});

Deno.test('de_inkwell: the radar overview shows both sites and both spawns', () => {
  const o = new Overview(bsp, world, 256);
  const shown = (x, y) => {
    const i = Math.floor((x - o.minX) / o.scale), j = Math.floor((o.maxY - y) / o.scale);
    return o.floor[j * o.width + i] > -Infinity;
  };
  for (const e of [...at('info_player_deathmatch'), ...at('info_player_start')]) {
    const [x, y] = e.origin.split(' ').map(Number);
    assert.ok(shown(x, y), `spawn at ${e.origin}`);
  }
  assert.ok(shown(1536, 1296) && shown(-1536, 800), 'the sites');
});

// A seeded random (mulberry32) for Math.random and the bots, so games repeat.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function game(cfg, seed) {
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_inkwell'], readCfg, print: () => {}, defer: (fn) => fn() });
  host.start('de_inkwell');
  host.con.exec(cfg);
  host.game.bots.random = seeded(seed);
  return host;
}

Deno.test('de_inkwell: T bots take the bomb to either site and plant it', () => {
  for (const site of [0, 1]) {
    const host = game('mp_warmuptime 0; mp_freezetime 0; bot_dont_shoot 1; bot_join_team t; bot_quota 3', 5);
    const g = host.game, w = new Writer();
    const ct = g.connect({ send() {}, close() {} }); // stands at the CT spawn: seen, but the bots do not shoot
    g.receive(ct, writeHello(w, TEAM_CT, 0, 0, 'watcher').slice());
    ct.cmds = new CmdRing();
    ct.tick = 1;
    const step = () => {
      ct.cmds.put(ct.tick, 0, -1, 0, 0, 0);
      g.receive(ct, writeCmds(w, 0, ct.cmds, ct.tick++).slice());
      g.step();
    };
    for (let i = 0; i < 64 * 10 && g.phase !== PHASE_LIVE; i++) step();
    assert.equal(g.phase, PHASE_LIVE);
    g.bots.tSite = site; // this round's site for the team
    g.bots.siteRound = g.round.serial;
    for (const b of g.bots.list) b.site = site;
    for (let i = 0; i < 64 * 60 && g.bomb.state !== BOMB_PLANTED; i++) step();
    assert.equal(g.bomb.state, BOMB_PLANTED, `${'AB'[site]}: planted within 60 s`);
    assert.equal(g.bombSites.siteAt(g.bomb.x, g.bomb.y, g.bomb.z, 16, 16, 36), site);
  }
});

// Headless 5v5s of hard bots, seeded: they fight, plant, and keep moving.
Deno.test('de_inkwell: bots play 5 against 5: plants, kills, almost never stuck', () => {
  const random = Math.random;
  try {
    let plants = 0, kills = 0, stuck = 0, checks = 0;
    for (const seed of [1, 2]) {
      Math.random = seeded(seed); // spawns, spread, the C4's carrier
      const g = game('mp_warmuptime 0; bot_difficulty 2; bot_quota_mode fill; bot_quota 10', seed).game;
      g.bots.random = Math.random;
      const prev = new Map();
      let planted = false;
      for (let tick = 0; tick < 6 * 60 * 64; tick++) {
        g.step();
        if (g.bomb.state === BOMB_PLANTED && !planted) plants++;
        planted = g.bomb.state === BOMB_PLANTED;
        if (tick % 32 || g.phase !== PHASE_LIVE) continue;
        for (const b of g.bots.list) { // stuck: a bot with no progress that hardly moved
          if (!b.c.alive || !b.c.player) continue;
          const f = b.c.player.ps.f, p = prev.get(b);
          if (p) {
            checks++;
            if (Math.hypot(f[PS_ORIGIN] - p[0], f[PS_ORIGIN + 1] - p[1]) < 12 && b.stuck > 0) stuck++;
          }
          prev.set(b, [f[PS_ORIGIN], f[PS_ORIGIN + 1]]);
        }
      }
      kills += g.bots.list.reduce((n, b) => n + b.c.kills, 0);
    }
    assert.ok(plants >= 2, `plants: ${plants}`);
    assert.ok(kills > 40, `kills: ${kills}`);
    assert.ok(stuck / checks < 0.03, `stuck ${(100 * stuck / checks).toFixed(1)} %`);
  } finally {
    Math.random = random;
  }
});
