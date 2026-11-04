// The map's sun (shared/sun.js): read from light_environment the way hlrad reads it, the
// clamps for odd pitches, our compiler's own sun written into its maps, and the matrix that
// flattens a character onto its floor along the sun (client/gl/playermodels.js).
import assert from 'node:assert/strict';
import { sunOf, sunEntity, shadowMatrix, SUN_MIN_ELEVATION, SUN_MAX_ELEVATION } from '../shared/sun.js';
import { SUN, SUN_RGB } from '../shared/bspwriter.js';
import { parseBSP } from '../shared/bsp.js';

const deg = (r) => r * 180 / Math.PI;
const elevationOf = (v) => deg(Math.asin(v[2]));
// The yaw the light shines along (against the vector toward the sun), 0..360.
const yawOf = (v) => (deg(Math.atan2(-v[1], -v[0])) + 360) % 360;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

Deno.test('sun: the pitch key and the angle key, or the angles', () => {
  // de_dust2: pitch -60, angles 0 0 0 and angle 43: the angle key's yaw wins (hlrad).
  let v = sunOf([{ classname: 'worldspawn' }, { classname: 'light_environment', pitch: '-60', angles: '0 0 0', angle: '43' }]);
  assert.ok(near(elevationOf(v), 60) && near(yawOf(v), 43), `${[...v]}`);
  assert.ok(near(Math.hypot(v[0], v[1], v[2]), 1));
  // The angles alone (Source ports): pitch and yaw from them.
  v = sunOf([{ classname: 'light_environment', angles: '-50 110 0' }]);
  assert.ok(near(elevationOf(v), 50) && near(yawOf(v), 110));
  // A pitch key with the angles' yaw.
  v = sunOf([{ classname: 'light_environment', pitch: '-45', angles: '0 245 0' }]);
  assert.ok(near(elevationOf(v), 45) && near(yawOf(v), 245));
  // The vector points up toward the sun: the light shines down along yaw.
  assert.ok(v[2] > 0);
  assert.equal(sunOf([{ classname: 'worldspawn' }, { classname: 'light' }]), null);
  assert.equal(sunOf([]), null);
});

Deno.test('sun: odd pitches clamp to a usable elevation', () => {
  // cs_office: angles 90 0 0 (pointing up): taken as down, kept under straight overhead.
  let v = sunOf([{ classname: 'light_environment', angles: '90 0 0' }]);
  assert.ok(near(elevationOf(v), SUN_MAX_ELEVATION));
  // cs_estate: pitch 342 is -18: a low sun, raised to the minimum.
  v = sunOf([{ classname: 'light_environment', pitch: '342', angles: '0 67 0' }]);
  assert.ok(near(elevationOf(v), SUN_MIN_ELEVATION) && near(yawOf(v), 67));
  // de_prodigy: pitch 330 is -30.
  v = sunOf([{ classname: 'light_environment', pitch: '330', angle: '192' }]);
  assert.ok(near(elevationOf(v), 30) && near(yawOf(v), 192));
  // No pitch at all (fy_buzzkill: angles 0 0 0): a flat sun, raised to the minimum.
  v = sunOf([{ classname: 'light_environment', angles: '0 0 0' }]);
  assert.ok(near(elevationOf(v), SUN_MIN_ELEVATION));
  // Past straight up: the same line, facing the other way.
  v = sunOf([{ classname: 'light_environment', pitch: '-120', angles: '0 10 0' }]);
  assert.ok(near(elevationOf(v), 60) && near(yawOf(v), 190));
});

Deno.test('sun: our compiler writes its sun, and the maps carry it', () => {
  const e = sunEntity(SUN, SUN_RGB);
  const v = sunOf([e]);
  for (let i = 0; i < 3; i++) assert.ok(near(v[i], SUN[i]), `${[...v]} vs ${SUN}`);
  for (const name of ['de_playground', 'de_inkwell']) {
    const bsp = parseBSP(Deno.readFileSync(`maps/${name}.bsp`).buffer);
    const s = sunOf(bsp.entities);
    assert.ok(s, `${name} has a light_environment`);
    for (let i = 0; i < 3; i++) assert.ok(near(s[i], SUN[i]), name);
  }
});

Deno.test('sun: a character is flattened onto its floor away from the sun', () => {
  const sun = sunOf([{ classname: 'light_environment', pitch: '-45', angles: '0 0 0' }]); // shining along +x
  const m = shadowMatrix(new Float32Array(16), sun, 100);
  const at = (x, y, z) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
  // The feet stay; the head 72 up lands 72 further along +x at 45 degrees; every point on the plane.
  assert.deepEqual(at(10, 20, 100).map((x) => Math.round(x * 1e4) / 1e4), [10, 20, 100]);
  const head = at(10, 20, 172);
  assert.ok(near(head[0], 82) && near(head[1], 20) && near(head[2], 100), `${head}`);
  assert.equal(m[15], 1);
  // A steeper sun, a shorter shadow.
  const high = sunOf([{ classname: 'light_environment', pitch: '-80', angles: '0 0 0' }]);
  const h2 = shadowMatrix(new Float32Array(16), high, 0);
  assert.ok(Math.abs(h2[8] * 72) < 72 * Math.tan(10 * Math.PI / 180) + 1e-3);
});

Deno.test('sky: the far silhouette by the map\'s name', async () => {
  const { backdropOf } = await import('../client/gl/renderer.js');
  assert.equal(backdropOf('de_dust2').kind, 1, 'dunes');
  assert.equal(backdropOf('css_mirage_go').kind, 1);
  assert.equal(backdropOf('cs_polaris').kind, 2, 'a skyline');
  assert.equal(backdropOf('de_inkwell').kind, 2);
  assert.equal(backdropOf('de_cbble').kind, 3, 'mountains');
  assert.equal(backdropOf('fy_snow_pool').kind, 3);
  assert.equal(backdropOf('awp_cs16'), null, 'none');
  assert.equal(backdropOf('de_playground'), null);
});
