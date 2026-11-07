// The kill feed's weapon icons (client/killicons.js): every weapon's model seen side-on gives a
// silhouette of sane size, its triangles all wound one way (their union fills, none cancels).
import assert from 'node:assert/strict';
import { WEAPONS } from '../shared/weapons.js';
import { buildGun } from '../client/models/guns.js';
import { iconTriangles, MARK_NAMES } from '../client/killicons.js';

Deno.test('kill icons: every weapon has a silhouette at most 28 px tall and 110 wide, one winding', () => {
  for (const w of WEAPONS) {
    if (!w) continue;
    const { tris, w: iw, h } = iconTriangles(buildGun(w.name).mesh.positions);
    assert.ok(tris.length > 60, `${w.name}: triangles`);
    assert.ok(h >= 6 && h <= 29 && iw <= 111 && iw >= 8, `${w.name}: ${iw} x ${h}`);
    for (let i = 0; i < tris.length; i += 6) {
      const area = (tris[i + 2] - tris[i]) * (tris[i + 5] - tris[i + 1]) - (tris[i + 3] - tris[i + 1]) * (tris[i + 4] - tris[i]);
      assert.ok(area > 0, `${w.name}: a triangle wound the other way`);
    }
  }
  const awp = iconTriangles(buildGun('awp').mesh.positions), glock = iconTriangles(buildGun('glock').mesh.positions);
  assert.ok(awp.w > 2.5 * glock.w, 'a rifle reads longer than a pistol');
  assert.deepEqual(MARK_NAMES, ['headshot', 'wallbang', 'flash', 'air', 'noscope', 'skull']);
});
