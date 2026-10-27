import assert from 'node:assert/strict';
import { analyze } from '../tools/texanalysis.js';
import { encodeRecord, textureRecord, withOriginalColor, TF_LINES } from '../client/texcolors.js';
import { classify, MAT } from '../shared/materials.js';

// Deterministic pseudo-random texel noise.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
}

// Builds a texture from color(x, y) -> [r, g, b, a].
function texture(name, w, h, color) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(color(x, y), (y * w + x) * 4);
  return { name, w, h, rgba };
}

Deno.test('texture analysis: running-bond bricks repeat in rows and per row', () => {
  const r = rng(1);
  const shade = Array.from({ length: 64 }, () => 0.8 + 0.4 * r());
  const a = analyze(texture('brickwall', 128, 128, (x, y) => {
    const row = y >> 4, bx = x + (row & 1) * 16; // 8 rows of 16, bricks 32 wide, offset half a brick
    if (y % 16 < 2 || bx % 32 < 2) return [200, 200, 190, 255]; // light mortar
    const k = shade[(row * 4 + (bx >> 5)) % 64] * (0.9 + 0.2 * r());
    return [150 * k, 60 * k, 45 * k, 255];
  }));
  assert.equal(a.ny, 8);
  assert.equal(a.nx, 4);
  assert.ok(a.mean[0] > a.mean[2] * 1.5, 'brick red dominates');
});

Deno.test('texture analysis: planks are rows without columns; plain noise has no lines', () => {
  const r = rng(2);
  const planks = analyze(texture('woodplank', 64, 128, (_x, y) => {
    if (y % 32 < 2) return [40, 25, 15, 255];
    const k = 0.85 + 0.3 * r();
    return [130 * k, 90 * k, 55 * k, 255];
  }));
  assert.equal(planks.ny, 4);
  assert.equal(planks.nx, 0);

  const sand = analyze(texture('sand', 64, 64, () => {
    const k = 0.8 + 0.4 * r();
    return [170 * k, 140 * k, 100 * k, 255];
  }));
  assert.equal(sand.ny, 0);
  assert.equal(sand.nx, 0);
  assert.ok(Math.abs(sand.mean[0] - 170) < 8 && Math.abs(sand.mean[2] - 100) < 8);
});

Deno.test('texture analysis: a wainscot stays out of the wall color; holes out of a grate', () => {
  const r = rng(4);
  const wall = analyze(texture('wall_wood', 64, 128, (_x, y) => {
    const k = 0.92 + 0.16 * r();
    return y >= 88 && y < 120 ? [150 * k, 80 * k, 20 * k, 255] : [180 * k, 180 * k, 180 * k, 255];
  }));
  assert.equal(wall.bands.length, 1);
  assert.ok(Math.abs(wall.bands[0].start - 88 / 128) < 0.02 && Math.abs(wall.bands[0].end - 120 / 128) < 0.02);
  assert.ok(Math.abs(wall.mean[0] - wall.mean[2]) < 4, `gray wall ${wall.mean}`);

  const grate = analyze(texture('{grate', 64, 64, (x, y) => (x % 16 < 4 || y % 16 < 4 ? [90, 90, 85, 255] : [0, 0, 255, 0])));
  assert.ok(Math.abs(grate.mean[2] - 85) < 1, 'transparent texels are not averaged in');
  assert.equal(grate.ny, 4);
});

Deno.test('texture colors: records, the generated table, and pattern correction', () => {
  const rec = encodeRecord({ mean: [10.4, 200.6, 300], ny: 0, nx: 3 });
  assert.deepEqual([...rec], [10, 201, 255, TF_LINES]);

  const sand = textureRecord('-0sand');
  if (sand) { // the committed table (tools/gen_texturedata.js) covers CS 1.6's dust sand
    assert.ok(sand[0] > sand[2], 'sand is warm');
    const m = withOriginalColor(classify('-0sand'), '-0sand');
    assert.deepEqual([m.r, m.g, m.b], [sand[0], sand[1], sand[2]]);
  }
  assert.equal(textureRecord('no_such_texture_xyz'), null);
  const plain = withOriginalColor(classify('no_such_brick'), 'no_such_brick');
  assert.equal(plain.mat, MAT.BRICK, 'unknown names keep their class');
});
