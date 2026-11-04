// Gun finishes (client/models/looks.js): every gun's looks, the painting of a built mesh
// (colors and finishes only: the shape, triangles and bones stay), which parts are painted,
// and the finish and fade bytes surviving the vertex sharing the GPU upload does.
import assert from 'node:assert/strict';
import { LOOKS, LOOK_GUNS, looksOf, lookOf, paintMesh, paintsAll } from '../client/models/looks.js';
import { buildGun } from '../client/models/guns.js';
import { FINISH, MESH_STRIDE, indexMesh } from '../client/gl/meshkit.js';
import { WEAPONS } from '../shared/weapons.js';

const BUDGET = 2500; // triangles a gun may have (test/guns.test.js)

Deno.test('looks: every gun and the knife offer four, the factory finish first', () => {
  const guns = WEAPONS.filter((w) => w && (w.gun || w.name === 'knife')).map((w) => w.name);
  assert.deepEqual([...LOOK_GUNS].sort(), [...guns].sort());
  for (const name of guns) {
    const list = looksOf(name);
    assert.equal(list.length, 4, name);
    assert.equal(list[0], 'plain');
    assert.equal(new Set(list).size, 4, `${name}: no look twice`);
    for (const k of list) assert.ok(LOOKS[k], `${name}: ${k}`);
  }
  assert.deepEqual(looksOf('hegrenade'), ['plain']);
  assert.equal(lookOf('ak47', 2), looksOf('ak47')[2]);
  assert.equal(lookOf('ak47', 9), 'plain');
});

Deno.test('looks: painting keeps the shape and paints the dark metal and polymer only', () => {
  for (const name of LOOK_GUNS) {
    const built = buildGun(name).mesh;
    assert.ok(built.tris <= BUDGET, name);
    const src = new Uint8Array(built.data);
    assert.equal(paintMesh(built, 'plain'), built, 'the factory finish is the mesh itself');
    for (const key of looksOf(name).slice(1)) {
      const look = LOOKS[key], m = paintMesh(built, key, paintsAll(name)), u8 = new Uint8Array(m.data);
      assert.equal(m.count, built.count);
      assert.equal(m.positions, built.positions);
      let painted = 0;
      for (let v = 0; v < built.count; v++) {
        const o = v * MESH_STRIDE;
        // Position, normal and bones byte for byte.
        for (let b = 0; b < 16; b++) assert.equal(u8[o + b], src[o + b]);
        assert.equal(u8[o + 20], src[o + 20]);
        assert.equal(u8[o + 21], src[o + 21]);
        const was = src[o + 19], now = u8[o + 19];
        if (now === look.pattern && was !== look.pattern) {
          painted++;
          assert.ok(was === FINISH.METAL || was === FINISH.POLYMER, `${name} ${key}: only metal and polymer`);
        } else {
          for (let b = 16; b < 20; b++) assert.equal(u8[o + b], src[o + b], `${name} ${key}: the rest untouched`);
        }
        if (was === FINISH.WOOD) assert.equal(now, FINISH.WOOD);
      }
      assert.ok(painted > built.count * 0.4, `${name} ${key}: most of the gun painted (${painted} of ${built.count})`);
    }
  }
});

Deno.test('looks: lenses, light steel and wood keep their colors; the knife paints its blade', () => {
  const awp = buildGun('awp').mesh, a = new Uint8Array(paintMesh(awp, 'hex').data), s = new Uint8Array(awp.data);
  let lens = 0;
  for (let v = 0; v < awp.count; v++) {
    const o = v * MESH_STRIDE + 16;
    if (s[o + 2] > s[o] + 0.12 * 255) { // bluish: the scope's glass
      lens++;
      assert.equal(a[o + 3], s[o + 3]);
    }
  }
  assert.ok(lens > 0, 'the AWP has lenses');
  const knife = buildGun('knife').mesh, k = new Uint8Array(paintMesh(knife, 'fade', paintsAll('knife')).data);
  let blade = 0;
  for (let v = 0; v < knife.count; v++) if (k[v * MESH_STRIDE + 19] === FINISH.FADE) blade++;
  assert.equal(blade, knife.count, 'every part of the knife');
});

Deno.test('looks: the finish and the fade coordinate survive the upload\'s vertex sharing', () => {
  const built = buildGun('m4a1').mesh, m = paintMesh(built, 'fade');
  const ix = indexMesh(m.data, m.count), u8 = new Uint8Array(m.data);
  const xs = [], ts = [];
  for (let v = 0; v < m.count; v++) {
    const o = ix.indices[v] * MESH_STRIDE, src = v * MESH_STRIDE;
    for (let b = 16; b < 24; b++) assert.equal(ix.vertices[o + b], u8[src + b]);
    if (u8[src + 19] === FINISH.FADE) {
      xs.push(built.positions[v * 3]);
      ts.push(u8[src + 22]);
    }
  }
  // The fade runs along the gun: 0 at the back end, 255 at the muzzle end, growing with x.
  const order = xs.map((_, i) => i).sort((p, q) => xs[p] - xs[q]);
  for (let i = 1; i < order.length; i++) assert.ok(ts[order[i]] >= ts[order[i - 1]]);
  assert.ok(Math.max(...ts) > 200 && Math.min(...ts) < 60);
});
