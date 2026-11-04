// The render scale the GPU can hold (client/gl/renderer.js clampScale): within the largest
// texture side and the pixel budget (r_supersample_max).
import assert from 'node:assert/strict';
import { clampScale } from '../client/gl/renderer.js';

Deno.test('render scale: capped by the texture size and the pixel budget', () => {
  assert.equal(clampScale(2, 1920, 1080, 16384, 64e6), 2, '2x of 1080p fits');
  assert.ok(Math.abs(clampScale(8, 1920, 1080, 16384, 64e6) - Math.sqrt(64e6 / (1920 * 1080))) < 1e-9, '8x is cut by the budget (5.56x)');
  assert.equal(clampScale(8, 2560, 1440, 16384, 1e12), 16384 / 2560, 'the largest texture side cuts it (6.4x)');
  assert.equal(clampScale(0.5, 1920, 1080, 16384, 64e6), 0.5, 'a lower scale is never raised');
});
