import assert from 'node:assert/strict';
import { IN_FORWARD, IN_JUMP } from '../shared/constants.js';
import { PS_ORIGIN, PS_WATERLEVEL, PS_FLAGS, FL_ONGROUND, FL_WATERJUMP } from '../shared/pmove.js';
import { Trace, traceHull, pointContents, hullFits, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { SurfaceMap } from '../shared/surfaces.js';
import { isLiquid } from '../shared/bsp.js';
import { buildMapMesh, VERTEX_STRIDE, SCROLL_UNIT } from '../client/mapmesh.js';
import { loadMap, walker } from './harness.js';

// de_playground is our own map (tools/gen_demomap.js), so it is in the repository.
const bsp = loadMap('de_playground');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: expected ${b}±${eps}, got ${a}`);

Deno.test('de_playground: every element is there; spawns stand on the floor inside the walls', () => {
  const count = (cls) => bsp.entities.filter((e) => e.classname === cls).length;
  assert.equal(count('info_player_deathmatch'), 5);
  assert.equal(count('info_player_start'), 5);
  assert.equal(count('func_buyzone'), 2);
  assert.equal(count('func_bomb_target'), 2);
  assert.equal(count('func_ladder'), 2);
  assert.equal(count('func_water'), 1);
  assert.equal(count('func_conveyor'), 1);
  assert.equal(count('func_breakable'), 10);
  assert.equal(count('func_door') + count('func_door_rotating') + count('func_button'), 5);
  assert.equal(count('func_plat') + count('func_train') + count('func_rot_button'), 3);
  assert.equal(count('path_corner'), 4);
  const { game } = walker(bsp);
  const tr = new Trace();
  for (const e of bsp.entities.filter((e) => e.classname.startsWith('info_player'))) {
    const [x, y, z] = e.origin.split(' ').map(Number);
    assert.ok(hullFits(game.world, HULL_STAND, x, y, z), `room at ${e.origin}`);
    traceHull(game.world, HULL_STAND, x, y, z, x, y, z - 64, tr);
    assert.ok(tr.fraction < 0.05, 'standing on the floor');
  }
  traceHull(game.world, HULL_STAND, 0, 0, 37, 0, 5000, 37, tr);
  assert.ok(tr.endy < 1024, 'the outer wall holds');
  traceHull(game.world, HULL_POINT, 0, 0, 100, 0, 0, 5000, tr);
  assert.ok(tr.endz <= 640, 'so does the sky');
});

Deno.test('de_playground: the pool is shallow at one end and knee deep at the other', () => {
  const { game } = walker(bsp);
  const tr = new Trace();
  for (const [x, floor, wade] of [[-150, -16, false], [150, -32, true]]) {
    traceHull(game.world, HULL_POINT, x, 500, 50, x, 500, -100, tr);
    assert.ok(Math.abs(tr.endz - floor) < 0.1, `floor at ${floor}`);
    assert.ok(isLiquid(pointContents(game.world, x, 500, floor + 2)), 'water at the feet');
    assert.equal(isLiquid(pointContents(game.world, x, 500, floor + 24)), wade, 'above the knees: wading');
    assert.ok(!isLiquid(pointContents(game.world, x, 500, floor + 36)), 'walking, not swimming');
  }
});

Deno.test('de_playground: the diving well: under water at its bottom, swim up, leap or climb out', () => {
  const { c, run, put } = walker(bsp);
  const f = c.player.ps.f, i = c.player.ps.i;
  put(180, 640, -192);
  run(16);
  assert.equal(i[PS_WATERLEVEL], 3, 'the eyes under water');
  near(f[PS_ORIGIN + 2] - 36, -192, 1, 'at the bottom');
  run(3 * 64, IN_JUMP);
  assert.ok(f[PS_ORIGIN + 2] > -40 && i[PS_WATERLEVEL] >= 1, `swam up to the surface (z ${f[PS_ORIGIN + 2]})`);
  put(280, 640, -50); // waist deep at the east edge, facing the deck
  let leapt = false;
  for (let t = 0; t < 128; t++) {
    run(1, IN_FORWARD);
    leapt ||= (i[PS_FLAGS] & FL_WATERJUMP) !== 0;
  }
  assert.ok(leapt && (i[PS_FLAGS] & FL_ONGROUND) && f[PS_ORIGIN] > 300, 'leapt out onto the deck');
  near(f[PS_ORIGIN + 2] - 36, 0, 0.1, 'standing on the deck');
  put(232, 670, -192); // at the ladder's foot, looking up at it
  run(4 * 64, IN_FORWARD, 90, -60);
  assert.ok(f[PS_ORIGIN + 1] > 700 && Math.abs(f[PS_ORIGIN + 2] - 36) < 1, `climbed out (${f[PS_ORIGIN + 1]}, ${f[PS_ORIGIN + 2]})`);
});

Deno.test('de_playground: the ladder climbs the tower; the belt carries; doors and breakables work', () => {
  const { game, c, run, put } = walker(bsp);
  put(-376, -780, 0); // in front of the ladder, facing it, looking up
  const f = c.player.ps.f;
  let onTop = false;
  for (let t = 0; t < 4 * 64 && !onTop; t++) {
    run(1, IN_FORWARD, -90, -60);
    onTop = Math.abs(f[PS_ORIGIN + 2] - 36 - 320) < 1 && f[PS_ORIGIN + 1] < -840 && f[PS_ORIGIN + 1] > -950;
  }
  assert.ok(onTop, 'up the ladder and onto the tower');
  put(400, -908, 8);
  run(64);
  assert.ok(c.player.ps.f[PS_ORIGIN] > 500, `the belt carried us east (to ${c.player.ps.f[PS_ORIGIN].toFixed(0)})`);
  // Its top (scroll_conv, 64 wide, s along +x) slides east at the belt's speed.
  const mesh = buildMapMesh(bsp), b = new Int8Array(mesh.vertices);
  const rates = new Set();
  for (let v = 0; v < mesh.numVerts; v++) if (b[v * VERTEX_STRIDE + 31]) rates.add(b[v * VERTEX_STRIDE + 31]);
  assert.deepEqual([...rates], [160 / 64 * SCROLL_UNIT], 'the belt top scrolls, nothing else');
  assert.equal(game.doors.count, 8, 'four doors, a button, a valve, a lift and a cart');
  assert.equal(game.breakables.count, 10);
});

Deno.test('de_playground: baked sun and shade; bots find their way everywhere', () => {
  const { game } = walker(bsp);
  const s = new SurfaceMap(bsp, game.world), out = new Float32Array(3);
  assert.ok(s.lightAt(out, -500, 400, 50) && out[0] > 200, `open ground in the sun (${out[0]})`);
  assert.ok(s.lightAt(out, 0, 150, 50) && out[0] < 120, `in the free-standing wall's shadow (${out[0]})`);
  // The shed's lamp: its floor under the lamp is lit, warmer than the sky's blue.
  assert.ok(s.lightAt(out, 820, -660, 20) && out[0] > 100 && out[0] > out[2] * 1.2, `under the shed's lamp (${out.join(' ')})`);
  game.bots.ensureNav();
  const nav = game.bots.nav, path = new Int32Array(4096);
  const from = nav.nodeAt(-1400, 0, 1);
  for (const [x, y, z, what] of [[1400, 0, 1, 'the CT spawn'], [-780, 700, 0, 'site A'], [780, 700, 0, 'site B'],
    [-376, -896, 320, 'the tower top'], [-660, -860, 128, 'the stairs platform'], [180, 660, -192, 'the bottom of the well']]) {
    assert.ok(nav.path(from, nav.nodeAt(x, y, z), path) > 0, `a path to ${what}`);
  }
  assert.ok(nav.path(nav.nodeAt(180, 660, -192), from, path) > 0, 'a path out of the well');
});
