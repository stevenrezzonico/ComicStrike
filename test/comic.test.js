// The comic renderer's GL-free contracts: every scene shader writes the whole G-buffer,
// decals paint only the albedo, the flags agree between JS and GLSL, every material class
// has its ink, the per-map light level is a percentile of the lightmap, and the opaque
// bulk of the world draws with a shader that never discards.
import assert from 'node:assert/strict';
import {
  GBUFFER_SHADERS, WORLD_FS, WORLD_SOLID_FS, DECAL_FS, SHADOW_FS, COMPOSITE_FS, COMPOSITE_FAST_FS, G_FLAGS,
} from '../client/gl/shaders.js';
import { FlashLights, MAX_FLASHES } from '../client/gl/flashes.js';
import { fullLight } from '../client/gl/renderer.js';
import { buildMapMesh, VERTEX_STRIDE } from '../client/mapmesh.js';
import { parseBSP } from '../shared/bsp.js';
import { MAT, FLAG_ALPHATEST } from '../shared/materials.js';

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
  assert.deepEqual(outputs(SHADOW_FS), [0], 'contact shadows: the light in its alpha');
});

Deno.test('comic: flash lights fade out, the live ones packed first, the newest replacing the nearest end', () => {
  const f = new FlashLights();
  f.add(1, 2, 3, 100, 1, 1, 10);
  f.add(4, 5, 6, 200, 0.5, 0.1, 10);
  f.update(10.05);
  assert.equal(f.count, 2);
  assert.ok(Math.abs(f.k[0] - 0.95) < 1e-6 && Math.abs(f.k[1] - 0.25) < 1e-6, 'linear fades');
  f.update(10.5); // the short one is gone: the long one stays first
  assert.equal(f.count, 1);
  assert.deepEqual([...f.pos.slice(0, 4)], [1, 2, 3, 100]);
  for (let i = 0; i < MAX_FLASHES; i++) f.add(i, 0, 0, 10, 1, 2 + i, 10.5);
  f.update(10.6);
  assert.equal(f.count, MAX_FLASHES);
  assert.ok(![...f.pos].some((v, i) => i % 4 === 3 && v === 100), 'the one ending soonest made room');
  f.update(100);
  assert.equal(f.count, 0);
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

// de_aztec has alpha-tested faces (foliage, grates); skipped without the map.
const aztec = (() => {
  try {
    return Deno.readFileSync(new URL('../maps/de_aztec.bsp', import.meta.url)).buffer;
  } catch {
    return null;
  }
})();

Deno.test({ name: 'comic: alpha-tested faces draw apart; the opaque bulk never discards', ignore: !aztec, fn: () => {
  // Every discard goes through CUT, which SOLID turns into nothing.
  const code = WORLD_FS.replace(/\/\/.*$/gm, '').replace('#define CUT discard', '');
  assert.doesNotMatch(code, /discard/);
  assert.match(WORLD_FS, /#ifdef SOLID\n#define CUT\n#else\n#define CUT discard\n#endif/);
  assert.ok(WORLD_SOLID_FS.startsWith('#version 300 es\n#define SOLID\n'));
  const mesh = buildMapMesh(parseBSP(aztec));
  assert.ok(mesh.cutoutCount > 0, 'aztec has alpha-tested faces');
  const flags = new Uint8Array(mesh.vertices);
  const cut = (i) => (flags[mesh.indices[i] * VERTEX_STRIDE + 37] & FLAG_ALPHATEST) !== 0;
  for (let i = 0; i < mesh.opaqueCount; i++) assert.ok(!cut(i), 'opaque range');
  for (let i = mesh.opaqueCount; i < mesh.opaqueCount + mesh.cutoutCount; i++) assert.ok(cut(i), 'alpha-tested range');
} });

Deno.test('comic: the fast ink (r_inkfast) is the print without the diagonal fetches', () => {
  assert.ok(COMPOSITE_FAST_FS.startsWith('#version 300 es\n#define INK_FAST\n'));
  // The fetches the GLSL preprocessor keeps for each variant.
  const kept = (src, fast) => {
    const on = [true];
    let n = 0;
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t === '#ifdef INK_FAST') on.push(fast);
      else if (t === '#ifndef INK_FAST') on.push(!fast);
      else if (t === '#else' && on.length > 1) on.push(!on.pop());
      else if (t === '#endif' && on.length > 1) on.pop();
      else if (on.every(Boolean)) n += (t.match(/\b(dtex|ntex)\(pc/g) || []).length;
    }
    return n;
  };
  assert.equal(kept(COMPOSITE_FS, false) - kept(COMPOSITE_FS, true), 5, 'four diagonal depths and one normal');
});
