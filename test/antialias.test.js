// Anti-aliasing besides supersampling (client/gl/antialias.js, r_inkaa): the jitter, the TAA
// reprojection's depth-to-clip constants, and the passes' shaders. The passes themselves run
// on the GPU (checked in a browser: see CLAUDE.md, Ink pass).
import assert from 'node:assert/strict';
import { halton, aaBytes, AA, FXAA_FS, SMAA_EDGE_FS, SMAA_WEIGHT_FS, SMAA_BLEND_FS, TAA_FS } from '../client/gl/antialias.js';
import { clampScale } from '../client/gl/renderer.js';
import { GBUFFER_CONSTS } from '../client/gl/shaders.js';
import { perspective, multiply, jitterClip } from '../client/gl/mat4.js';

Deno.test('antialias: Halton jitter covers the texel round its center', () => {
  assert.equal(halton(1, 2), 0.5);
  assert.equal(halton(2, 2), 0.25);
  assert.equal(halton(3, 2), 0.75);
  assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-12);
  let sx = 0, sy = 0;
  for (let k = 1; k <= 8; k++) {
    const x = halton(k, 2) - 0.5, y = halton(k, 3) - 0.5;
    assert.ok(Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5);
    sx += x;
    sy += y;
  }
  assert.ok(Math.abs(sx / 8) < 0.07 && Math.abs(sy / 8) < 0.07, 'about centered');
});

const project = (m, p) => {
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return c;
};

Deno.test('antialias: jitterClip moves the picture by the jitter in device coordinates', () => {
  const proj = perspective(new Float32Array(16), 1.2, 16 / 9, 4, 16384);
  const j = jitterClip(new Float32Array(proj), 0.01, -0.02);
  for (const p of [[3, -5, -40], [-200, 90, -3000], [0, 0, -4.5]]) {
    const a = project(proj, p), b = project(j, p);
    assert.ok(Math.abs(b[0] / b[3] - a[0] / a[3] - 0.01) < 1e-5);
    assert.ok(Math.abs(b[1] / b[3] - a[1] / a[3] + 0.02) < 1e-5);
    assert.ok(Math.abs(b[2] / b[3] - a[2] / a[3]) < 1e-6, 'depth unchanged');
  }
});

Deno.test('antialias: the TAA clip position rebuilt from the linear depth is the scene projection\'s', () => {
  // TAA_FS rebuilds clip z from the clip w with DEPTH_NEAR and DEPTH_FAR, the planes of
  // client/main.js's perspective: they must stay in step.
  const near = +GBUFFER_CONSTS.match(/DEPTH_NEAR = ([\d.]+)/)[1], far = +GBUFFER_CONSTS.match(/DEPTH_FAR = ([\d.]+)/)[1];
  const main = Deno.readTextFileSync(new URL('../client/main.js', import.meta.url));
  assert.ok(main.includes(`perspective(proj, fovY, aspect, ${near}, ${far});`), 'main.js draws with those planes');
  assert.match(TAA_FS, /ZA = \(DEPTH_FAR \+ DEPTH_NEAR\) \/ \(DEPTH_FAR - DEPTH_NEAR\)/);
  assert.match(TAA_FS, /ZB = -2\.0 \* DEPTH_FAR \* DEPTH_NEAR \/ \(DEPTH_FAR - DEPTH_NEAR\)/);
  const za = (far + near) / (far - near), zb = -2 * far * near / (far - near);
  const proj = perspective(new Float32Array(16), 1.1, 1.5, near, far);
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, -3, 2, 1]);
  const vp = multiply(new Float32Array(16), proj, view);
  for (const p of [[10, 20, -50], [-300, 40, -2500], [1, 1, -16000]]) {
    const c = project(vp, p), d = c[3];
    assert.ok(Math.abs((za * d + zb) - c[2]) < 1e-3 * Math.max(1, Math.abs(c[2])), `clip z at depth ${d}`);
  }
});

Deno.test('antialias: each pass reads its own inputs and writes one target', () => {
  const samplers = (src) => [...src.matchAll(/uniform sampler2D (\w+);/g)].map((m) => m[1]);
  assert.deepEqual(samplers(FXAA_FS), ['u_ink']);
  assert.deepEqual(samplers(SMAA_EDGE_FS), ['u_ink']);
  assert.deepEqual(samplers(SMAA_WEIGHT_FS), ['u_edges']);
  assert.deepEqual(samplers(SMAA_BLEND_FS), ['u_ink', 'u_weights']);
  assert.deepEqual(samplers(TAA_FS), ['u_albedo', 'u_depth', 'u_ink', 'u_cur', 'u_histC', 'u_histI']);
  // What moves by itself, now or last frame, takes this frame alone (no motion vectors: a
  // walking player's outline faded to a tenth); the rest is clamped to its neighborhood.
  assert.match(TAA_FS, /bool moving = \(flagsOf\(D\) & G_MOVING\) != 0u \|\| \(u_lines > 0\.0 && texelFetch\(u_ink, p, 0\)\.g > 0\.0\);/);
  assert.match(TAA_FS, /if \(moving \|\| u_blend >= 1\.0\) return;/);
  assert.match(TAA_FS, /if \(h\.g > 0\.0\) return;/);
  assert.match(TAA_FS, /clamp\(textureLod\(u_histC, prev, 0\.0\), lo, top\)/);
  assert.match(SMAA_EDGE_FS, /if \(u_only > 0\.0\)/, 'TAA runs SMAA on the moving texels only');
});

Deno.test('antialias: the supersampling cap counts the anti-aliasing targets', () => {
  assert.equal(aaBytes(AA.OFF, true), 0);
  assert.equal(aaBytes(AA.CORNERS, true), 0);
  assert.equal(aaBytes(AA.FXAA, true), 1);
  assert.equal(aaBytes(AA.SMAA, true), 7);
  assert.equal(aaBytes(AA.TAA, true), 32, 'SMAA, the mark and two half-float histories');
  assert.equal(aaBytes(AA.TAA, false), 20);
  // 64 Mpx over a 1440p window: 2x fits, 4x is capped; with TAA the cap is lower.
  const max = 64e6, w = 2560, h = 1440;
  const plain = clampScale(8, w, h, 16384, max), taa = clampScale(8, w, h, 16384, max * 15 / (15 + aaBytes(AA.TAA, true)));
  assert.ok(Math.abs(plain - Math.sqrt(max / (w * h))) < 1e-9);
  assert.ok(taa < plain * 0.6 && taa > 1, `TAA cap ${taa.toFixed(2)} vs ${plain.toFixed(2)}`);
});
