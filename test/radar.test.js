import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_ATTACK } from '../shared/constants.js';
import { CollisionWorld, hullFits, HULL_STAND } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { Overview } from '../shared/overview.js';
import { floorFaces } from '../shared/floorgrid.js';
import { box } from '../shared/bspwriter.js';
import { Grenades, FX_SMOKE, SMOKE_GROW } from '../shared/grenades.js';
import { PHASE_LIVE } from '../shared/economy.js';
import { Writer, E_ANIM, ANIM_SPOTTED_T, ANIM_SPOTTED_CT } from '../shared/protocol.js';
import { Game } from '../server/game.js';
import { mapOrNull, joinClient, runInputs, teleport, yard } from './harness.js';

import { BombSites } from '../shared/bomb.js';

const bsp = mapOrNull('de_dust2'), nuke = mapOrNull('de_nuke');

Deno.test({ name: 'overview: the reachable floors, lighter higher; spawns on them; north up', ignore: !bsp, fn: () => {
  const world = CollisionWorld.fromBSP(bsp);
  const o = new Overview(bsp, world, 256);
  assert.ok(Math.max(o.width, o.height) <= 256);
  // Spawn points show the floor they stand on (spawn origins float a little above it).
  // Where a walkable level passes over one (a few of dust2's CT spawns), that shows.
  const spawns = bsp.entities.filter((e) => e.classname === 'info_player_start' || e.classname === 'info_player_deathmatch');
  let onFloor = 0;
  for (const e of spawns) {
    const [x, y, z] = e.origin.split(' ').map(Number);
    const floor = o.floorAt(x, y);
    assert.ok(floor > z - 70, `spawn ${x} ${y}: a floor shows`);
    if (floor <= z - 30) onFloor++;
  }
  assert.ok(onFloor >= spawns.length * 0.75, `${onFloor} of ${spawns.length} spawns on their own floor`);
  // Pixels: transparent off the floors, opaque on them; higher floors are lighter.
  let lo = null, hi = null;
  for (let i = 0; i < o.width * o.height; i++) {
    const z = o.floor[i], a = o.rgba[i * 4 + 3];
    assert.equal(a, z === -Infinity ? 0 : 255);
    if (z === -Infinity || o.rgba[i * 4] < 60) continue; // outline
    if (!lo || z < lo[0]) lo = [z, o.rgba[i * 4]];
    if (!hi || z > hi[0]) hi = [z, o.rgba[i * 4]];
  }
  assert.ok(hi[1] > lo[1] + 60, 'higher is lighter');
  // North up: world y grows toward row 0.
  assert.ok(o.py(o.maxY - 100) < o.py(o.maxY - 200));
  // Most of the map's floor area is reachable, but not everything standable (roofs).
  let shown = 0, standable = 0;
  for (let i = 0; i < o.width * o.height; i++) {
    if (o.floor[i] > -Infinity) shown++;
    if (o.layers[i * 6] > -Infinity) standable++;
  }
  assert.ok(shown > standable * 0.5 && shown < standable * 0.95, `${shown} of ${standable}`);
  // One level: nothing lies over anything for long.
  assert.equal(o.levels.length, 1);
  assert.equal(o.levelOf(-1000), 0);
  assert.equal(o.levels[0].rgba, o.rgba);
} });

Deno.test({ name: 'overview: de_nuke is two levels, site B on the lower one under A', ignore: !nuke, fn: () => {
  const world = CollisionWorld.fromBSP(nuke);
  const o = new Overview(nuke, world, 256);
  assert.equal(o.levels.length, 2, `cuts ${o.cuts}`);
  assert.ok(o.cuts[0] > -700 && o.cuts[0] < -450, `the cut between the floors: ${o.cuts[0]}`); // CS:GO's lower section ends at -495
  const sites = new BombSites(nuke), [a, b] = sites.boxes; // A over B
  const ax = (a[0] + a[3]) / 2, ay = (a[1] + a[4]) / 2, bx = (b[0] + b[3]) / 2, by = (b[1] + b[4]) / 2;
  assert.equal(o.levelOf(a[2]), 1);
  assert.equal(o.levelOf(b[2]), 0);
  // Under B's middle the lower level shows B's floor, the upper level A's over it.
  const lower = o.floorAt(bx, by, 0), upper = o.floorAt(bx, by, 1);
  assert.ok(Math.abs(lower - b[2]) < 48, `B's floor on the lower level: ${lower} vs ${b[2]}`);
  assert.ok(upper > lower + 200, `A's floor over it on the upper level: ${upper}`);
  assert.ok(Math.abs(o.floorAt(ax - 80, ay, 1) - a[2]) < 48, 'A on the upper level (a crate stands at its middle)');
  assert.equal(o.floorAt(bx, by), upper, 'the all-levels view shows the top');
  // Each level has its own pixels, transparent where it has no floor.
  for (const l of o.levels) {
    let shown = 0;
    for (let i = 0; i < o.width * o.height; i++) {
      assert.equal(l.rgba[i * 4 + 3], l.floor[i] === -Infinity ? 0 : 255);
      if (l.floor[i] > -Infinity) shown++;
    }
    assert.ok(shown > o.width * o.height * 0.05, `level shows ${shown} px`);
  }
} });

Deno.test('smoke blocks a line of sight through it, not one beside it', () => {
  const g = new Grenades();
  g.addEffect(FX_SMOKE, 0, 0, TEAM_T, 0, 0, 0);
  g.fxAge[0] = SMOKE_GROW + 1; // fully grown
  assert.ok(g.smokeBetween(-500, 0, 40, 500, 0, 40), 'straight through');
  assert.ok(!g.smokeBetween(-500, 400, 40, 500, 400, 40), 'well beside it');
  assert.ok(!g.smokeBetween(-500, 0, 40, -300, 0, 40), 'stops short of it');
});

function setup() {
  const game = new Game('de_dust2', bsp, { freezeTime: 0, roundTime: 600, buyTime: 1, roundEndDelay: 1 });
  const w = new Writer();
  const clients = [];
  const join = (name, team) => {
    const c = joinClient(game, w, name, team);
    c.input = { buttons: 0, pitch: 0, yaw: 0 };
    clients.push(c);
    return c;
  };
  const run = (ticks) => runInputs(game, w, clients, ticks);
  // The spotted bits the newest snapshot carries for player `c`.
  const spotted = (c) => {
    const ring = game.snapshots;
    return ring.ents[ring.row(ring.find(game.tick), c.id) + E_ANIM] & (ANIM_SPOTTED_T | ANIM_SPOTTED_CT);
  };
  return { game, join, run, spotted };
}

Deno.test({ name: 'spotting: seen in the view cone, not behind, not through smoke; firing shows', ignore: !bsp, fn: () => {
  const { game, join, run, spotted } = setup();
  const t = join('alpha', TEAM_T), ct = join('bravo', TEAM_CT), ct2 = join('charlie', TEAM_CT);
  run(2);
  while (game.phase !== PHASE_LIVE) run(1);
  // An open stretch at the CT spawn: t 300 units east of ct.
  const [x, y, z] = game.spawns[TEAM_CT].find(([sx, sy, sz]) =>
    hullFits(game.world, HULL_STAND, sx + 300, sy, sz) && hullFits(game.world, HULL_STAND, sx + 150, sy, sz));
  const place = (yawCt) => {
    teleport(ct, x, y, z);
    teleport(t, x + 300, y, z);
    teleport(ct2, x - 2000, y - 2000, z); // out of the way
    ct.input.yaw = yawCt;
    t.input.yaw = 180;
    ct2.input.yaw = 0;
    run(8);
    teleport(ct, x, y, z); // keep them there whatever the commands did
    teleport(t, x + 300, y, z);
    run(4);
  };
  place(0);
  assert.ok(spotted(t) & ANIM_SPOTTED_CT, 'the CT looks at him: on the CT radar');
  assert.ok(spotted(ct) & ANIM_SPOTTED_T, 'and the T sees the CT');
  assert.ok(!(spotted(t) & ANIM_SPOTTED_T), 'never on his own team\'s bit');
  place(180);
  assert.ok(!(spotted(t) & ANIM_SPOTTED_CT), 'the CT looks away: not spotted');
  // Smoke between them hides him even in plain view.
  place(0);
  game.grenades.addEffect(FX_SMOKE, 0, 0, TEAM_T, x + 150, y, z - 36);
  game.grenades.fxAge[game.grenades.fxCount - 1] = SMOKE_GROW + 1;
  run(8);
  assert.ok(!(spotted(t) & ANIM_SPOTTED_CT), 'smoke between');
  // Firing an unsilenced gun shows him for a moment, smoke or not.
  t.input.buttons = IN_ATTACK;
  run(1);
  t.input.buttons = 0;
  run(4);
  assert.equal(spotted(t), ANIM_SPOTTED_T | ANIM_SPOTTED_CT, 'firing: on every radar');
  run(80);
  assert.ok(!(spotted(t) & ANIM_SPOTTED_CT), 'a second later: hidden again');
} });

Deno.test('overview: built in its worker, handed over as data that places and levels like the original', async () => {
  const bytes = Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url));
  const map = parseBSP(bytes.slice().buffer), original = new Overview(map, CollisionWorld.fromBSP(map));
  const worker = new Worker(new URL('../client/overviewworker.js', import.meta.url), { type: 'module' });
  const reply = await new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    const copy = bytes.slice().buffer;
    worker.postMessage({ id: 7, buffer: copy, untrusted: false }, [copy]);
  });
  worker.terminate();
  assert.equal(reply.id, 7);
  const o = Overview.from(reply.data);
  for (const k of ['scale', 'width', 'height', 'minX', 'maxY']) assert.equal(o[k], original[k], k);
  assert.equal(o.levels.length, original.levels.length);
  assert.deepEqual(o.levels[0].rgba, original.levels[0].rgba, 'the same pixels');
  for (const z of [-100, 0, 200, 1000]) assert.equal(o.levelOf(z), original.levelOf(z));
  assert.equal(o.px(123), original.px(123));
});

Deno.test('floor grid: its floors are what the collision world holds solid', () => {
  // A not-solid conveyor (spawnflags 2) was a floor to the bots and the radar while players
  // fell through it; a momentary_door, solid, was none.
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_conveyor', spawnflags: '2' }, [box(-400, -100, 200, -200, 100, 216, 'steel')]);
    map.brushEntity({ classname: 'momentary_door', targetname: 'd' }, [box(200, -100, 300, 400, 100, 316, 'steel')]);
  });
  const tops = floorFaces(bsp).map((f) => f.d / f.nz);
  assert.ok(!tops.some((z) => Math.abs(z - 216) < 1), 'the conveyor players fall through is no floor');
  assert.ok(tops.some((z) => Math.abs(z - 316) < 1), 'the momentary door is one');
});
