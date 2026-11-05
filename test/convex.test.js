// The convex brush compiler (shared/bspwriter.js): ramps, angled walls and pillars become
// maps the engine walks, collides with, lights and the bots navigate.
import assert from 'node:assert/strict';
import { MapBuilder, box, wedge, turnedBox, prism, convex, brushPolygons, brushPlanes } from '../shared/bspwriter.js';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, pointContents, HULL_STAND } from '../shared/trace.js';
import { IN_FORWARD } from '../shared/constants.js';
import { Game } from '../server/game.js';
import { Nav } from '../shared/nav.js';
import { SurfaceMap } from '../shared/surfaces.js';
import { TEX, W, yard, walker, quiet } from './harness.js';

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
  const game = quiet(() => new Game('test', bsp, { rounds: false }));
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

// --- Lamps -------------------------------------------------------------------------------

// A closed room 1024 x 512 x 256 (its roof keeps the sun and sky out) with lamps and
// `extra` shapes; the lightmap color of the floor under (x, y) through SurfaceMap.
function room(lamps, extra = [], light = 'full') {
  const map = new MapBuilder(TEX, { message: 'test' });
  map.world.push(
    box(-512, -256, -32, 512, 256, 0, '-0sand'),
    box(-544, -288, -32, -512, 288, 288, W), box(512, -288, -32, 544, 288, 288, W),
    box(-512, -288, -32, 512, -256, 288, W), box(-512, 256, -32, 512, 288, 288, W),
    box(-544, -288, 256, 544, 288, 288, W),
    ...extra,
  );
  for (const l of lamps) map.point({ classname: 'light', ...l });
  map.point({ classname: 'info_player_deathmatch', origin: '-400 0 37', angles: '0 0 0' });
  map.point({ classname: 'info_player_start', origin: '400 0 37', angles: '0 180 0' });
  const bsp = parseUntrustedBSP(map.compile({ light }).bytes.buffer);
  const s = new SurfaceMap(bsp, CollisionWorld.fromBSP(bsp)), out = new Float32Array(3);
  return (x, y) => {
    assert.ok(s.lightAt(out, x, y, 20), `a lit floor under ${x} ${y}`);
    return [...out];
  };
}

Deno.test('lamps: a bulb lights the floor under it, less farther off, not through a wall (draft: no shadows)', () => {
  const dark = room([]);
  assert.ok(dark(0, 0)[0] < 40, `a sealed room is dark (${dark(0, 0)})`);
  const lit = room([{ origin: '0 0 200', _light: '255 200 150 200' }]);
  const under = lit(0, 0), off = lit(400, 0);
  assert.ok(under[0] > 80 && under[0] > under[2] * 1.3, `lit and warm under the lamp (${under})`);
  assert.ok(off[0] < under[0] - 30 && off[0] > dark(400, 0)[0], `less 400 units off (${off})`);
  // A partition across the room between the lamp and (400, 0).
  const wall = [box(200, -256, 0, 216, 256, 256, W)];
  const shadowed = room([{ origin: '0 0 200', _light: '255 200 150 200' }], wall);
  assert.ok(shadowed(400, 0)[0] < 40, `nothing through the wall (${shadowed(400, 0)})`);
  assert.ok(shadowed(0, 0)[0] > 80, 'the lamp still lights its own side');
  const draft = room([{ origin: '0 0 200', _light: '255 200 150 200' }], wall, 'draft');
  assert.ok(draft(400, 0)[0] > 40, `draft light casts no shadows (${draft(400, 0)})`);
  // One number: brightness alone, white.
  const plain = room([{ origin: '0 0 200', _light: '200' }]);
  assert.ok(plain(0, 0)[0] > 80 && Math.abs(plain(0, 0)[0] - plain(0, 0)[2]) < 12, `white (${plain(0, 0)})`);
});

Deno.test('lamps: a spot lights inside its cone only; pitch from the key or the angles', () => {
  const bulb = room([{ origin: '0 0 200', _light: '255 255 255 200' }]);
  const spot = room([{ classname: 'light_spot', origin: '0 0 200', _light: '255 255 255 200', pitch: '-90', _cone: '20', _cone2: '30' }]);
  assert.ok(spot(0, 0)[0] > 80, `lit under the spot (${spot(0, 0)})`);
  assert.ok(bulb(200, 0)[0] > 40, `a bulb lights 200 units off (${bulb(200, 0)})`);
  assert.ok(spot(200, 0)[0] < 30, `the spot (45 degrees off its axis) does not (${spot(200, 0)})`);
  // Aimed 45 degrees down along +x by its angles (no pitch key): it lights the floor 200
  // units east, not the floor under it nor the floor west.
  const tilted = room([{ classname: 'light_spot', origin: '0 0 200', _light: '255 255 255 300', angles: '-45 0 0', _cone: '20', _cone2: '30' }]);
  assert.ok(tilted(200, 0)[0] > 50, `lit on its axis (${tilted(200, 0)})`);
  assert.ok(tilted(0, 0)[0] < 30 && tilted(-200, 0)[0] < 30, `dark off it (${tilted(0, 0)}, ${tilted(-200, 0)})`);
});
