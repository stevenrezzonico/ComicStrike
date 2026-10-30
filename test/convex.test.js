// The convex brush compiler (shared/bspwriter.js): ramps, angled walls and pillars become
// maps the engine walks, collides with, lights and the bots navigate.
import assert from 'node:assert/strict';
import { MapBuilder, box, wedge, turnedBox, prism, convex, brushPolygons, brushPlanes } from '../shared/bspwriter.js';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, pointContents, HULL_STAND } from '../shared/trace.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { IN_FORWARD } from '../shared/constants.js';
import { TEAM_T } from '../shared/player.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
import { Game } from '../server/game.js';
import { Nav } from '../shared/nav.js';

const TEX = { sky: [256, 256], crete3_wall02: [128, 128], '-0sand': [128, 128] };
const W = 'crete3_wall02';

// A walled yard 2048 x 1024 under the sky, plus `extra(map)`.
function yard(extra) {
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

function walker(bsp) {
  const log = console.log;
  console.log = () => {};
  const game = new Game('test', bsp, { rounds: false });
  console.log = log;
  const w = new Writer();
  const c = game.connect({ send() {}, close() {} });
  game.receive(c, writeHello(w, TEAM_T, 0, 0, 'tester').slice());
  c.cmds = new CmdRing();
  let tick = 1;
  const run = (ticks, buttons, yaw) => {
    for (let i = 0; i < ticks; i++) {
      c.cmds.put(tick, buttons, -1, 0, yaw, 0);
      game.receive(c, writeCmds(w, 0, c.cmds, tick++).slice());
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
  run(2, 0, 0);
  return { c, run, put, feet: () => c.player.ps.f[PS_ORIGIN + 2] - 36, pos: () => c.player.ps.f };
}

Deno.test('shapes: polygons close round their volume', () => {
  for (const br of [wedge([0, 0, 0, 256, 128, 128], 'px', W), turnedBox([0, 0, 0, 200, 16, 128], 37, W),
    prism([0, 0, 0, 128, 128, 200], 8, 0, W)]) {
    const polys = brushPolygons(brushPlanes(br));
    assert.ok(polys.every((p) => p.length >= 3), 'every side has a face');
    for (const p of polys.flat()) for (const pl of brushPlanes(br)) assert.ok(pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] <= pl.d + 0.02);
  }
  assert.equal(brushPolygons(brushPlanes(wedge([0, 0, 0, 256, 128, 128], 'px', W))).length, 5, 'a wedge has five sides');
});

Deno.test('a 27° ramp is walked up and down; its top is reached', () => {
  const bsp = yard((map) => map.world.push(wedge([0, -128, 0, 256, 128, 128], 'px', W), box(256, -128, 0, 512, 128, 128, W)));
  const p = walker(bsp);
  p.put(-100, 0, 0);
  p.run(120, IN_FORWARD, 0); // east, up the ramp onto the block (256..512)
  p.run(40, 0, 0);
  assert.ok(p.pos()[0] > 260 && p.pos()[0] < 512, `went up the ramp onto the block (${p.pos()[0]})`);
  assert.ok(Math.abs(p.feet() - 128) < 2, `on the block (${p.feet()})`);
  p.put(140, 0, 80); // mid-ramp, in the air above it: lands on the slope
  p.run(40, 0, 0);
  // The box rests on its uphill corner (x 156): 128 · 156 / 256 = 78.
  assert.ok(Math.abs(p.feet() - 78) < 1, `stands on the slope (${p.feet()})`);
  p.run(200, IN_FORWARD, 180); // back down west
  assert.ok(p.pos()[0] < -50 && Math.abs(p.feet()) < 1, 'down on the floor');
});

Deno.test('a slope steeper than 45° cannot be stood on', () => {
  const bsp = yard((map) => map.world.push(wedge([0, -128, 0, 100, 128, 200], 'px', W)));
  const p = walker(bsp);
  p.put(50, 0, 140); // over the 63° slope
  p.run(120, 0, 0);
  assert.ok(p.feet() < 20, `slid off (${p.feet()})`);
});

Deno.test('an angled wall blocks along its true outline, and its corner lets players by', () => {
  const bsp = yard((map) => map.world.push(turnedBox([-300, -16, 0, 300, 16, 256], 45, W)));
  const world = CollisionWorld.fromBSP(bsp);
  const t = new Trace();
  // Along y through the middle: the hull's center stops where the player box (16 each way)
  // first touches the wall's side (16 out from its center line), across the 45° plane:
  // (16 + 16·√2) out along the normal, so (16 + 16·√2)·√2 along y.
  traceHull(world, HULL_STAND, 0, -400, 37, 0, 400, 37, t);
  assert.ok(t.fraction < 1, 'blocked');
  assert.ok(Math.abs(t.endy + (16 + 16 * Math.SQRT2) * Math.SQRT2) < 1, `stopped by the diagonal (${t.endy})`);
  // Past the turned wall's end: open (a box this long but not turned would block there).
  traceHull(world, HULL_STAND, 280, -400, 37, 280, 400, 37, t);
  assert.equal(t.fraction, 1, 'the corner is cut');
  assert.equal(pointContents(world, 0, 0, 100), -2, 'solid inside');
});

Deno.test('a pillar is round enough: blocked at its radius from every side', () => {
  const bsp = yard((map) => map.world.push(prism([-64, -64, 0, 64, 64, 256], 16, 0, W)));
  const world = CollisionWorld.fromBSP(bsp);
  const t = new Trace();
  for (let a = 0; a < 360; a += 30) {
    const r = a * Math.PI / 180, x = Math.cos(r) * 400, y = Math.sin(r) * 400;
    traceHull(world, HULL_STAND, x, y, 37, 0, 0, 37, t);
    const dist = Math.hypot(t.endx, t.endy);
    assert.ok(dist > 64 && dist < 64 + 16 * Math.SQRT2 + 2, `angle ${a}: stopped at ${dist.toFixed(1)}`);
  }
});

Deno.test('the bots find their way over a ramp and onto a deck', () => {
  const bsp = yard((map) => {
    map.world.push(wedge([-400, -100, 0, -144, 100, 128], 'px', W), box(-144, -480, 0, 200, 480, 128, W));
  });
  const log = console.log;
  console.log = () => {};
  const game = new Game('test', bsp, { rounds: false });
  console.log = log;
  const nav = new Nav(bsp, game.world, 24, () => false);
  const from = nav.nodeAt(-800, 0, 0), to = nav.nodeAt(0, 300, 128);
  assert.ok(from >= 0 && to >= 0, 'both ends on the graph');
  const path = new Int32Array(4096);
  const n = nav.path(from, to, path);
  assert.ok(n > 0, 'a path up the ramp');
  const xs = Array.from(path.subarray(0, n), (k) => nav.x[k]);
  assert.ok(xs.some((x) => x > -400 && x < -144), 'by way of the ramp');
});

Deno.test('fuzzed convex brushes compile into maps the game takes, or fail with a message', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let n = 0; n < 12; n++) {
    let bsp;
    try {
      bsp = yard((map) => {
        for (let k = 0; k < 6; k++) {
          const x = Math.round(rnd() * 1600 - 800), y = Math.round(rnd() * 800 - 400), s = 32 + Math.round(rnd() * 200);
          const b = [x, y, 0, x + s, y + s / 2, 32 + Math.round(rnd() * 200)];
          const kind = Math.floor(rnd() * 3);
          map.world.push(kind === 0 ? wedge(b, ['px', 'nx', 'py', 'ny'][k % 4], W)
            : kind === 1 ? turnedBox(b, Math.round(rnd() * 90), W) : prism(b, 6 + 2 * (k % 4), rnd() * 30, W));
        }
        map.world.push(convex([{ n: [1, 1, 1], d: 600, tex: W }, { n: [-1, 0, 0], d: 0, tex: W }, { n: [0, -1, 0], d: 0, tex: W },
          { n: [0, 0, -1], d: 0, tex: W }]));
      });
    } catch (err) {
      assert.match(err.message, /bsp:|brush|volume|too big/, 'a message, not a crash');
      continue;
    }
    const world = CollisionWorld.fromBSP(bsp);
    const t = new Trace();
    traceHull(world, HULL_STAND, -900, 0, 37, -900, 0, -100, t);
    assert.ok(t.fraction < 1, 'the floor holds');
  }
});
