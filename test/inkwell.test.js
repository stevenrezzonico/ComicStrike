import assert from 'node:assert/strict';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_STAND } from '../shared/trace.js';
import { Nav, NAV_CELL } from '../shared/nav.js';
import { Overview } from '../shared/overview.js';
import { SurfaceMap } from '../shared/surfaces.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { PHASE_LIVE } from '../shared/economy.js';
import { readProject, checkProject, compileProject } from '../client/editor/project.js';
import { TEAM_CT, TEAM_T } from '../shared/player.js';
import { Writer } from '../shared/protocol.js';
import { Host } from '../server/host.js';
import { readCfg, seeded, joinClient, sendCmd, walker } from './harness.js';
import { IN_USE, IN_FORWARD, TICK_RATE } from '../shared/constants.js';
import { MOVER_PUSH, MOVER_TRAIN, MOVER_SPIN, MOVER_PLAT, MOVER_MOMENTARY, MOVER_WHEEL } from '../shared/doors.js';
import { FX_BLAST } from '../shared/grenades.js';

// de_inkwell is our own defusal map (tools/gen_inkwell.js), so it is in the repository:
// its editor project and the map compiled from it.
const projectText = Deno.readTextFileSync(new URL('../maps/de_inkwell.cmap.json', import.meta.url));
const bytes = Deno.readFileSync(new URL('../maps/de_inkwell.bsp', import.meta.url));
const bsp = parseUntrustedBSP(bytes.slice().buffer); // checked like a map from outside
const world = CollisionWorld.fromBSP(bsp);
const at = (cls) => bsp.entities.filter((e) => e.classname === cls);

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
  // Every kind of map element the game plays, at least once (tools/gen_inkwell.js).
  const census = {
    info_player_deathmatch: 10, info_player_start: 10, func_buyzone: 2, func_bomb_target: 2, func_ladder: 4,
    func_water: 4, func_conveyor: 2, func_door_rotating: 2, func_door: 2, func_button: 1, func_rot_button: 2,
    multisource: 1, trigger_hurt: 1, trigger_multiple: 3, game_text: 3, func_illusionary: 5, func_train: 1,
    path_corner: 2, func_pendulum: 2, func_pushable: 1, trigger_teleport: 1, info_teleport_destination: 1,
    func_plat: 1, func_wall: 2, func_rotating: 2, trigger_auto: 1, trigger_relay: 2, multi_manager: 1,
    momentary_door: 1, momentary_rot_button: 1, env_explosion: 1,
  };
  for (const [cls, n] of Object.entries(census)) assert.equal(at(cls).length, n, cls);
  assert.equal(at('func_water').map((e) => e.skin).sort().join(), '-3,-3,-4,-5', 'water (the canal, the fountain), slime (the ink vat), lava (the crucible)');
  assert.ok(at('func_breakable').length >= 10);
  assert.equal(at('func_breakable').filter((e) => e.explodemagnitude).length, 6, 'the press hall\'s drums and A\'s bomb crates explode');
  // Every name something fires is some entity's name, and every master a multisource.
  const named = new Set(bsp.entities.map((e) => e.targetname).filter(Boolean));
  const mm = at('multi_manager').flatMap((e) => Object.keys(e).filter((k) => !['classname', 'targetname', 'origin', 'angles'].includes(k)));
  for (const name of [...bsp.entities.flatMap((e) => [e.target, e.killtarget]), ...mm].filter(Boolean)) assert.ok(named.has(name), `${name} names something`);
  for (const e of bsp.entities.filter((e) => e.master)) assert.ok(at('multisource').some((m) => m.targetname === e.master), e.master);
  // Lamps under every roof: the press hall's spot lamps and the warehouse's bulbs light
  // floors the sun never reaches (they were pitch dark: 20 20 24).
  assert.equal(at('light_spot').length, 3);
  assert.equal(at('light').length, 16);
  const s = new SurfaceMap(bsp, world), out = new Float32Array(3);
  assert.ok(s.lightAt(out, 928, 64, 20) && out[0] > 150 && out[0] > out[2] * 1.15, `under a press hall spot (${out.join(' ')})`);
  assert.ok(s.lightAt(out, -1400, -2000, 20) && out[0] > 100, `between the warehouse's bulbs (${out.join(' ')})`);
  assert.ok(s.lightAt(out, 0, -2100, 20) && out[0] > 200, `the docks in the sun (${out.join(' ')})`);
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
  const out = new Int32Array(8192), lane = []; // every node on the paths measured
  const secs = (a, b) => {
    const n = nav.path(a, b, out);
    assert.ok(n > 0, 'a way');
    for (let i = 0; i < n; i++) lane.push(out[i]);
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
  // No lane runs through a hazard, the chute or a machine bots do not work: the hurt zones, the
  // teleport, the slime and lava, the lift, the barge, the crate, the loft's gate and its wheel
  // (their boxes from the top, grown by a player's half width).
  const keepOut = new Set(['trigger_hurt', 'trigger_teleport', 'func_plat', 'func_train', 'func_pushable', 'momentary_door', 'momentary_rot_button']);
  const boxes = [];
  for (const e of bsp.entities) {
    if (!/^\*\d+$/.test(e.model || '') || !(keepOut.has(e.classname) || (e.classname === 'func_water' && e.skin !== '-3'))) continue;
    const m = +e.model.slice(1), o = (e.origin || '0 0 0').split(' ').map(Number);
    boxes.push([e.classname, f[m * 16] + o[0] - 16, f[m * 16 + 1] + o[1] - 16, f[m * 16 + 3] + o[0] + 16, f[m * 16 + 4] + o[1] + 16]);
  }
  assert.equal(boxes.length, 9);
  for (const n of lane) {
    for (const [cls, x0, y0, x1, y1] of boxes) {
      assert.ok(!(nav.x[n] > x0 && nav.x[n] < x1 && nav.y[n] > y0 && nav.y[n] < y1), `a lane through the ${cls} at ${nav.x[n]} ${nav.y[n]}`);
    }
  }
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

// The press hall's two-hand press: the button works the platen only while both valves
// have been turned (its master is a multisource the valves feed).
Deno.test('de_inkwell: the two-hand press comes down only after both valves are turned', () => {
  const { game: g, run, put } = walker(bsp);
  const d = g.doors, platen = d.name.indexOf('press');
  assert.ok(platen >= 0);
  const use = (x, y, yaw, pitch) => {
    put(x, y, 0);
    run(2, IN_USE, yaw, pitch);
    run(TICK_RATE * 2, 0, yaw, pitch);
  };
  const button = () => use(900, -52, 180, 20);
  button();
  assert.ok(d.atBottom(platen) && d.dir[platen] === 0, 'locked: the button alone does nothing');
  use(590, -88, 180, 25); // the valve on the west wall
  button();
  assert.ok(d.atBottom(platen) && d.dir[platen] === 0, 'one valve is not enough');
  use(690, 188, 0, 25); // the valve on the other press
  put(900, -52, 0);
  run(2, IN_USE, 180, 20);
  run(TICK_RATE / 2, 0, 180, 20);
  assert.ok(!d.atBottom(platen), 'both valves turned: the platen comes down');
});

// The harbour: a swimmer leaps out of the canal where the railing has a gap, the paper chute
// drops whoever steps in onto the quay, the crate in the quay's corner goes where it is
// pushed, the lift takes whoever stands on it up to the mezzanine.
Deno.test('de_inkwell: the harbour: a water jump, the paper chute, the pushable crate, the lift', () => {
  const { game: g, run, put, pos, feet } = walker(bsp);
  const f = pos(), d = g.doors;
  put(-64, -2452, -58); // waist deep against the quay's wall, at the railing's gap
  run(TICK_RATE * 2, IN_FORWARD, 90);
  assert.ok(f[PS_ORIGIN + 1] > -2432 && Math.abs(feet()) < 1, `out onto the quay (y ${f[PS_ORIGIN + 1].toFixed(0)}, feet ${feet().toFixed(1)})`);
  put(-790, -2272, 128); // on the mezzanine, walking east into the chute
  let out = false;
  for (let i = 0; i < TICK_RATE * 2 && !out; i++) {
    run(1, IN_FORWARD, 0);
    out = Math.hypot(f[PS_ORIGIN] - 1200, f[PS_ORIGIN + 1] + 1888) < 32;
  }
  assert.ok(out && Math.abs(feet() - 1) < 2, `out of the chute on the quay (${f[PS_ORIGIN].toFixed(0)} ${f[PS_ORIGIN + 1].toFixed(0)})`);
  const crate = d.kind.indexOf(MOVER_PUSH);
  put(686, -2080, 0); // against the crate's west side
  run(TICK_RATE, IN_FORWARD, 0);
  assert.ok(d.pos[crate * 3] > 24 && d.pos[crate * 3] <= 32 + 1e-3, `shoved up to the container (${d.pos[crate * 3].toFixed(1)})`);
  assert.ok(d.kind.indexOf(MOVER_PLAT) >= 0);
  put(-968, -2264, 16); // on the lift at rest
  run(TICK_RATE * 3, 0, 0);
  assert.ok(Math.abs(feet() - 128) < 2, `up on the mezzanine (feet ${feet().toFixed(1)})`);
});

// Each round start fires the harbour's relay: its list sets the barge off at once and the
// warehouse's fans two seconds on.
Deno.test('de_inkwell: the round start sets the barge off and switches the fans on', () => {
  const host = game('mp_warmuptime 0; mp_freezetime 0', 1), g = host.game, d = g.doors, w = new Writer();
  const barge = d.kind.indexOf(MOVER_TRAIN), fans = [...d.kind].flatMap((k, i) => (k === MOVER_SPIN ? [i] : []));
  assert.ok(barge >= 0 && fans.length === 2);
  const players = [joinClient(g, w, 't', TEAM_T), joinClient(g, w, 'ct', TEAM_CT)]; // a match starts
  for (let i = 0; i < TICK_RATE * 4; i++) {
    for (const c of players) sendCmd(g, w, c);
    g.step();
  }
  assert.equal(g.phase, PHASE_LIVE);
  assert.ok(!d.stopped[barge], 'the barge goes');
  for (const k of fans) assert.equal(d.dir[k], 1, 'the fans turn');
});

// The bomb going off on A fires the site's target: the stack's crates (trigger-only) break and
// explode, a fireball goes up over the stage and a relay tears its poster down.
Deno.test('de_inkwell: the bomb going off on A breaks the crate stack, sends up a fireball and tears the poster down', () => {
  const { game: g, run } = walker(bsp);
  const b = g.breakables, crates = [];
  for (let s = 1; s <= b.count; s++) if (b.name[s] === 'a_blast') crates.push(s);
  assert.equal(crates.length, 4);
  assert.equal(g.bombSites.targets[0], 'a_blast');
  const blasts = () => [...g.grenades.fxKind.subarray(0, g.grenades.fxCount)].filter((k) => k === FX_BLAST).length;
  g.fireTarget(g.bombSites.targets[0], null);
  run(TICK_RATE / 2);
  for (const s of crates) assert.equal(b.broken[s], 1, 'a crate of the stack');
  assert.ok(blasts() >= 5, `the crates' blasts and the fireball (${blasts()})`);
  assert.ok(g.logic.removed.some((m) => m !== 0), 'the poster torn down');
});

// The net loft's gate follows the wheel on the Fish alley's side, and stays where it is left.
Deno.test("de_inkwell: the net loft's gate rises as the wheel is turned and stays up", () => {
  const { game: g, run, put } = walker(bsp);
  const d = g.doors, gate = d.kind.indexOf(MOVER_MOMENTARY);
  assert.ok(gate >= 0 && d.kind.indexOf(MOVER_WHEEL) >= 0);
  put(-1524, 232, 0); // facing the wheel on the loft's south wall
  run(TICK_RATE * 5, IN_USE, 270, 20);
  run(TICK_RATE * 2, 0, 270, 20);
  assert.ok(d.atTop(gate), 'open');
});

function game(cfg, seed) {
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_inkwell'], readCfg, print: () => {} });
  host.start('de_inkwell');
  host.con.exec(cfg);
  host.game.bots.random = seeded(seed);
  return host;
}

Deno.test('de_inkwell: T bots take the bomb to either site and plant it', () => {
  for (const site of [0, 1]) {
    const host = game('mp_warmuptime 0; mp_freezetime 0; bot_dont_shoot 1; bot_join_team t; bot_quota 3', 5);
    const g = host.game, w = new Writer();
    const ct = joinClient(g, w, 'watcher', TEAM_CT); // stands at the CT spawn: seen, but the bots do not shoot
    const step = () => {
      sendCmd(g, w, ct);
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
