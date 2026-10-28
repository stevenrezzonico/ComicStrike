import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_FORWARD } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { Trace, traceHull, pointContents, hullFits, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { SurfaceMap } from '../shared/surfaces.js';
import { TEAM_T } from '../shared/player.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
import { Game } from '../server/game.js';

// de_playground is our own map (tools/gen_demomap.js), so it is in the repository.
const bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url)).buffer);
const water = (c) => c <= -3 && c >= -5;

function setup() {
  const game = new Game('de_playground', bsp, { rounds: false });
  const w = new Writer();
  const c = game.connect({ send() {}, close() {} });
  game.receive(c, writeHello(w, TEAM_T, 0, 0, 'tester').slice());
  c.cmds = new CmdRing();
  c.tick = 1;
  c.input = { buttons: 0, pitch: 0, yaw: 0 };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      c.cmds.put(c.tick, c.input.buttons, -1, c.input.pitch, c.input.yaw, 0);
      game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      game.step();
    }
  };
  const put = (x, y, feet) => {
    const f = c.player.ps.f;
    f[PS_ORIGIN] = x;
    f[PS_ORIGIN + 1] = y;
    f[PS_ORIGIN + 2] = feet + 36;
    f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
  };
  run(2);
  return { game, c, run, put };
}

Deno.test('de_playground: every element is there; spawns stand on the floor inside the walls', () => {
  const count = (cls) => bsp.entities.filter((e) => e.classname === cls).length;
  assert.equal(count('info_player_deathmatch'), 5);
  assert.equal(count('info_player_start'), 5);
  assert.equal(count('func_buyzone'), 2);
  assert.equal(count('func_bomb_target'), 2);
  assert.equal(count('func_ladder'), 1);
  assert.equal(count('func_water'), 1);
  assert.equal(count('func_conveyor'), 1);
  assert.equal(count('func_breakable'), 6);
  assert.equal(count('func_door') + count('func_door_rotating') + count('func_button'), 4);
  const { game } = setup();
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
  const { game } = setup();
  const tr = new Trace();
  for (const [x, floor, wade] of [[-150, -16, false], [150, -32, true]]) {
    traceHull(game.world, HULL_POINT, x, 500, 50, x, 500, -100, tr);
    assert.ok(Math.abs(tr.endz - floor) < 0.1, `floor at ${floor}`);
    assert.ok(water(pointContents(game.world, x, 500, floor + 2)), 'water at the feet');
    assert.equal(water(pointContents(game.world, x, 500, floor + 24)), wade, 'above the knees: wading');
    assert.ok(!water(pointContents(game.world, x, 500, floor + 36)), 'walking, not swimming');
  }
});

Deno.test('de_playground: the ladder climbs the tower; the belt carries; doors and breakables work', () => {
  const { game, c, run, put } = setup();
  put(-376, -780, 0); // in front of the ladder, facing it, looking up
  c.input = { buttons: IN_FORWARD, pitch: -60, yaw: -90 };
  const f = c.player.ps.f;
  let onTop = false;
  for (let t = 0; t < 4 * 64 && !onTop; t++) {
    run(1);
    onTop = Math.abs(f[PS_ORIGIN + 2] - 36 - 320) < 1 && f[PS_ORIGIN + 1] < -840 && f[PS_ORIGIN + 1] > -950;
  }
  assert.ok(onTop, 'up the ladder and onto the tower');
  put(400, -908, 8);
  c.input = { buttons: 0, pitch: 0, yaw: 0 };
  run(64);
  assert.ok(c.player.ps.f[PS_ORIGIN] > 500, `the belt carried us east (to ${c.player.ps.f[PS_ORIGIN].toFixed(0)})`);
  assert.equal(game.doors.count, 4, 'three doors and a button');
  assert.equal(game.breakables.count, 6);
});

Deno.test('de_playground: baked sun and shade; bots find their way everywhere', () => {
  const { game } = setup();
  const s = new SurfaceMap(bsp, game.world), out = new Float32Array(3);
  assert.ok(s.lightAt(out, -500, 400, 50) && out[0] > 200, `open ground in the sun (${out[0]})`);
  assert.ok(s.lightAt(out, 0, 150, 50) && out[0] < 120, `in the free-standing wall's shadow (${out[0]})`);
  game.bots.ensureNav();
  const nav = game.bots.nav, path = new Int32Array(4096);
  const from = nav.nodeAt(-1400, 0, 1);
  for (const [x, y, z, what] of [[1400, 0, 1, 'the CT spawn'], [-780, 700, 0, 'site A'], [780, 700, 0, 'site B'],
    [-376, -896, 320, 'the tower top'], [-660, -860, 128, 'the stairs platform']]) {
    assert.ok(nav.path(from, nav.nodeAt(x, y, z), path) > 0, `a path to ${what}`);
  }
});
