import assert from 'node:assert/strict';
import { buildGun, buildAllGuns, buildDefuser, GUN_MAG, GUN_BOLT } from '../client/models/guns.js';
import { WEAPONS } from '../shared/weapons.js';
import { MESH_STRIDE } from '../client/gl/meshkit.js';

// Closed (every directed edge matched by its reverse) and outward (positive volume).
function closed(m, what) {
  const p = m.positions;
  const key = (i) => `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
  const edges = new Map();
  let vol = 0;
  for (let t = 0; t < m.count; t += 3) {
    const k = [key(t), key(t + 1), key(t + 2)];
    for (let e = 0; e < 3; e++) edges.set(`${k[e]}>${k[(e + 1) % 3]}`, (edges.get(`${k[e]}>${k[(e + 1) % 3]}`) || 0) + 1);
    const a = t * 3, b = a + 3, c = a + 6;
    vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  for (const [id, n] of edges) {
    const [f, t] = id.split('>');
    assert.equal(edges.get(`${t}>${f}`), n, `${what}: open edge ${id}`);
  }
  assert.ok(vol > 0, `${what}: inside out`);
}

// Distance from point q to the mesh surface (nearest point over all triangles).
function nearest(m, q) {
  const p = m.positions;
  let best = Infinity;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let t = 0; t < m.count; t += 3) {
    const a = [p[t * 3], p[t * 3 + 1], p[t * 3 + 2]], b = [p[t * 3 + 3], p[t * 3 + 4], p[t * 3 + 5]];
    const c = [p[t * 3 + 6], p[t * 3 + 7], p[t * 3 + 8]];
    // Closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5).
    const ab = sub(b, a), ac = sub(c, a), ap = sub(q, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    let r;
    if (d1 <= 0 && d2 <= 0) r = a;
    else {
      const bp = sub(q, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
      const cp = sub(q, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
      const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) r = b;
      else if (d6 >= 0 && d5 <= d6) r = c;
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        r = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        r = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        r = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
      } else {
        const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
        r = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
      }
    }
    best = Math.min(best, Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2]));
  }
  return best;
}

Deno.test('guns: every weapon has a closed, low-poly model with its muzzle at the front', () => {
  const all = buildAllGuns();
  assert.equal(all.length, WEAPONS.length);
  WEAPONS.forEach((w, id) => {
    if (!w) return;
    const g = all[id];
    assert.ok(g, `${w.name} has a model`);
    closed(g.mesh, w.name);
    assert.ok(g.mesh.tris <= 800, `${w.name}: ${g.mesh.tris} triangles`);
    let maxX = -Infinity;
    for (let i = 0; i < g.mesh.count; i++) maxX = Math.max(maxX, g.mesh.positions[i * 3]);
    assert.ok(Math.abs(g.muzzle[0] - maxX) < 2.5, `${w.name}: muzzle ${g.muzzle[0]} vs front ${maxX}`);
    assert.ok(nearest(g.mesh, g.muzzle) < 1, `${w.name}: muzzle off the model`);
    if (g.support) assert.ok(nearest(g.mesh, g.support) < 1.5, `${w.name}: support point ${nearest(g.mesh, g.support)} off the model`);
    assert.ok(nearest(g.mesh, [0, 0, 0]) < 1, `${w.name}: the grip is at the origin`);
  });
  closed(buildDefuser(), 'defuser');
});

Deno.test('guns: magazines and bolts are separate bones; sizes follow the real guns', () => {
  const bones = (name) => {
    const m = buildGun(name).mesh, u8 = new Uint8Array(m.data), s = new Set();
    for (let v = 0; v < m.count; v++) s.add(u8[v * MESH_STRIDE + 15]);
    return s;
  };
  for (const n of ['ak47', 'm4a1', 'glock', 'deagle', 'awp', 'negev']) assert.ok(bones(n).has(GUN_MAG), `${n} magazine`);
  for (const n of ['ak47', 'glock', 'nova', 'awp']) assert.ok(bones(n).has(GUN_BOLT), `${n} bolt / slide / pump`);
  const len = (n) => {
    const p = buildGun(n).mesh.positions;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      lo = Math.min(lo, p[i]);
      hi = Math.max(hi, p[i]);
    }
    return hi - lo;
  };
  // Real overall lengths: AK-47 ~35 in, AWP ~46 in, Glock ~7.3 in, Deagle ~10.8 in.
  assert.ok(len('ak47') > 30 && len('ak47') < 40, `ak47 ${len('ak47')}`);
  assert.ok(len('awp') > 42 && len('awp') < 52, `awp ${len('awp')}`);
  assert.ok(len('glock') > 6 && len('glock') < 9, `glock ${len('glock')}`);
  assert.ok(len('deagle') > 9.5 && len('deagle') < 12.5, `deagle ${len('deagle')}`);
  assert.ok(len('awp') > len('ssg08') && len('ak47') > len('mp7'));
});
