// The comic renderer's GL-free contracts: every scene shader writes the whole G-buffer,
// decals paint only the albedo, the flags agree between JS and GLSL, every material class
// has its ink, and the per-map light level is a percentile of the lightmap.
import assert from 'node:assert/strict';
import { GBUFFER_SHADERS, WORLD_FS, DECAL_FS, COMPOSITE_FS, G_FLAGS } from '../client/gl/shaders.js';
import { fullLight } from '../client/gl/renderer.js';
import { MAT } from '../shared/materials.js';

const outputs = (src) => [...src.matchAll(/layout\(location ?= ?(\d)\) out vec4/g)].map((m) => +m[1]).sort();

Deno.test('comic: every G-buffer shader writes all three targets through gbuffer()', () => {
  for (const [name, src] of Object.entries(GBUFFER_SHADERS)) {
    assert.deepEqual(outputs(src), [0, 1, 2], name);
    const main = src.slice(src.lastIndexOf('void main()'));
    assert.match(main, /gbuffer\(/, `${name} never calls gbuffer()`);
  }
});

Deno.test('comic: decals paint the albedo target only', () => {
  assert.deepEqual(outputs(DECAL_FS), [0]);
});

Deno.test('comic: the G-buffer flags agree between JS and GLSL', () => {
  for (const src of [WORLD_FS, COMPOSITE_FS]) {
    for (const [name, value] of Object.entries(G_FLAGS)) {
      const m = src.match(new RegExp(`const uint G_${name} = (\\d+)u;`));
      assert.ok(m, `G_${name} missing`);
      assert.equal(+m[1], value, `G_${name}`);
    }
  }
});

Deno.test('comic: every material class has its branch in the world shader', () => {
  const classes = Object.values(MAT);
  const last = Math.max(...classes);
  for (const id of classes) {
    if (id === last) continue; // the fall-through at the end
    assert.match(WORLD_FS, new RegExp(`mat == ${id}u\\)`), `material ${id}`);
  }
  assert.doesNotMatch(WORLD_FS, new RegExp(`mat == ${last}u\\)`));
});

Deno.test('comic: the fully lit level is a percentile of the lit lightmap texels', () => {
  const texel = (rgba, i, v, a = 255) => rgba.set([v, v, v, a], i * 4);
  const rgba = new Uint8Array(140 * 4);
  for (let i = 0; i < 75; i++) texel(rgba, i, 100);
  for (let i = 75; i < 100; i++) texel(rgba, i, 200);
  for (let i = 100; i < 120; i++) texel(rgba, i, 250, 0); // atlas gaps: ignored
  for (let i = 120; i < 140; i++) texel(rgba, i, 0); // unlit texels: ignored
  assert.ok(Math.abs(fullLight(rgba) - Math.pow(100 / 255, 0.6) * 1.45) < 1e-9);
  assert.equal(fullLight(new Uint8Array(16)), 1.25, 'no lightmap: the default');
  const dark = new Uint8Array(4 * 4);
  for (let i = 0; i < 4; i++) texel(dark, i, 3);
  assert.equal(fullLight(dark), 0.5, 'a black map still prints its brightest as dark');
});
