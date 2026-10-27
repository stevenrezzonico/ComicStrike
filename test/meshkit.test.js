import assert from 'node:assert/strict';
import { MeshBuilder, MESH_STRIDE } from '../client/gl/meshkit.js';
import { PLAYER_SKELETON, Pose } from '../client/anim/skeleton.js';
import * as Q from '../client/anim/quat.js';

// Closed and outward: every directed edge is matched by its reverse exactly once
// (positions keyed to 1e-4), and the enclosed signed volume is positive.
function checkClosed(built, what) {
  const p = built.positions;
  const key = (i) => `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
  const edges = new Map();
  let vol = 0;
  for (let t = 0; t < built.count; t += 3) {
    const k = [key(t), key(t + 1), key(t + 2)];
    for (let e = 0; e < 3; e++) {
      const id = `${k[e]}>${k[(e + 1) % 3]}`;
      edges.set(id, (edges.get(id) || 0) + 1);
    }
    const a = t * 3, b = a + 3, c = a + 6;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  for (const [id, n] of edges) {
    const [from, to] = id.split('>');
    assert.equal(edges.get(`${to}>${from}`), n, `${what}: open or flipped edge ${id}`);
  }
  assert.ok(vol > 0, `${what}: normals face inward (volume ${vol})`);
  return vol;
}

Deno.test('meshkit: every primitive is closed with outward normals and the expected volume', () => {
  const cases = [
    ['box', (m) => m.box(2, 3, 4, 1, 1, 1), 24],
    ['rotated mirrored box', (m) => m.rotate(30, 40, 10).mirror((b) => b.box(1, 1, 1, 0, 2, 0)), 2],
    ['extrude', (m) => m.extrude([[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]], 2), 12], // an L, concave
    ['clockwise extrude', (m) => m.extrude([[0, 0], [0, 2], [3, 2], [3, 0]], 1), 6],
    ['slab', (m) => m.slab(4, 2, 1, 0.5, 3), null],
    ['lathe cone', (m) => m.lathe([[0, 0], [1, 0.0001], [1, 2], [0, 3]], 12), null],
    ['lathe tube', (m) => m.lathe([[1, 0], [0.5, 2]], 6), null],
    ['capsule', (m) => m.capsule(1, 6, 8, 3), null],
    ['loft', (m) => m.loft([{ z: 0, pts: [[1, 1], [-1, 1], [-1, -1], [1, -1]] }, { z: 2, pts: [[2, 0], [0, 2], [-2, 0], [0, -2]] }]), null],
  ];
  for (const [what, make, volume] of cases) {
    const m = new MeshBuilder();
    make(m);
    const vol = checkClosed(m.build(), what);
    if (volume !== null) assert.ok(Math.abs(vol - volume) < 1e-3, `${what}: volume ${vol}, want ${volume}`);
  }
  // A capsule of radius 1 and length 6 approaches pi * (6 - 2/3 * 1) = 16.8 from below.
  const c = new MeshBuilder().capsule(1, 6, 16, 4).build();
  const v = checkClosed(c, 'fine capsule');
  assert.ok(v > 14 && v < 16.8, `capsule volume ${v}`);
});

Deno.test('meshkit: vertices carry flat normals, color and bone; budgets stay low', () => {
  const m = new MeshBuilder().color(1, 0.5, 0).bone(7).box(1, 1, 1);
  const b = m.build();
  assert.equal(b.tris, 12);
  assert.equal(b.data.byteLength, b.count * MESH_STRIDE);
  const i8 = new Int8Array(b.data), u8 = new Uint8Array(b.data);
  assert.deepEqual([i8[12], i8[13], i8[14]], [127, 0, 0], 'first face is +x');
  assert.deepEqual([u8[15], u8[16], u8[17], u8[18]], [7, 255, 128, 0]);
  assert.equal(new MeshBuilder().capsule(1, 6, 6, 1).build().tris, 6 * 2 + 6 * 2 * 1, 'a 6-sided capsule');
});

Deno.test('quaternions: Euler order matches yaw, then pitch, then roll', () => {
  const q = Q.fromEuler(new Float32Array(4), 0, 30, 50, 20);
  const z = Q.fromAxisAngle(new Float32Array(4), 0, 0, 0, 1, 50 * Math.PI / 180);
  const y = Q.fromAxisAngle(new Float32Array(4), 0, 0, 1, 0, 30 * Math.PI / 180);
  const x = Q.fromAxisAngle(new Float32Array(4), 0, 1, 0, 0, 20 * Math.PI / 180);
  const r = Q.mul(new Float32Array(4), 0, z, 0, Q.mul(new Float32Array(4), 0, y, 0, x, 0), 0);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(q[i] - r[i]) < 1e-6);
  // Pitch is down-positive in GoldSrc: forward (1, 0, 0) pitched 90 points down.
  const d = Q.rotate(new Float32Array(3), 0, Q.fromEuler(new Float32Array(4), 0, 90, 0, 0), 0, [1, 0, 0], 0);
  assert.ok(Math.abs(d[2] + 1) < 1e-6, `pitch 90 -> ${d}`);
});

Deno.test('skeleton: the bind pose skins to identity; poses rotate children with the parent', () => {
  const skel = PLAYER_SKELETON;
  const pose = new Pose(skel).solve();
  const m = pose.skinMatrices();
  for (let i = 0; i < skel.count; i++) {
    for (let k = 0; k < 16; k++) assert.ok(Math.abs(m[i * 16 + k] - (k % 5 === 0 ? 1 : 0)) < 1e-6, `bone ${i}`);
  }
  // Raise the left arm 90 degrees about x at the shoulder: the hand goes from +y to +z.
  const sh = skel.bone('arm_upper_L'), hand = skel.bone('hand_L');
  pose.turn(sh, 0, 0, 90).solve();
  const w = pose.wpos;
  assert.ok(Math.abs(w[hand * 3 + 1] - w[sh * 3 + 1]) < 1e-4);
  const arm = skel.bind[hand * 3 + 1] - skel.bind[sh * 3 + 1];
  assert.ok(Math.abs(w[hand * 3 + 2] - w[sh * 3 + 2] - arm) < 1e-4, 'hand straight above the shoulder');
  // The skin matrix moves the bind hand position to the posed one.
  const s = pose.skinMatrices(), o = hand * 16, b = skel.bind;
  const x = s[o] * b[hand * 3] + s[o + 4] * b[hand * 3 + 1] + s[o + 8] * b[hand * 3 + 2] + s[o + 12];
  const z = s[o + 2] * b[hand * 3] + s[o + 6] * b[hand * 3 + 1] + s[o + 10] * b[hand * 3 + 2] + s[o + 14];
  assert.ok(Math.abs(x - w[hand * 3]) < 1e-4 && Math.abs(z - w[hand * 3 + 2]) < 1e-4);

  const half = new Pose(skel).blend(new Pose(skel), pose, 0.5).solve();
  const up = half.wpos[hand * 3 + 2] - half.wpos[sh * 3 + 2];
  assert.ok(Math.abs(up - arm * Math.sin(Math.PI / 4)) < 1e-3, 'half way is 45 degrees');
});

Deno.test('skeleton: two-bone reach puts the hand on reachable targets, bending toward the pole', () => {
  const skel = PLAYER_SKELETON;
  const sh = skel.bone('arm_upper_R'), el = skel.bone('arm_lower_R'), hand = skel.bone('hand_R');
  const targets = [[14, -8, 50], [10, 0, 60], [5, -20, 45], [18, -4, 56]];
  for (const [tx, ty, tz] of targets) {
    const pose = new Pose(skel).solve();
    pose.reach(sh, el, hand, tx, ty, tz, 0, 0, -1); // elbow down
    const w = pose.wpos;
    const err = Math.hypot(w[hand * 3] - tx, w[hand * 3 + 1] - ty, w[hand * 3 + 2] - tz);
    assert.ok(err < 0.05, `target ${[tx, ty, tz]}: off by ${err}`);
    const shZ = w[sh * 3 + 2], handZ = w[hand * 3 + 2];
    assert.ok(w[el * 3 + 2] < Math.max(shZ, handZ), 'elbow bends down');
    // Bone lengths are kept.
    const upper = skel.bind[sh * 3 + 1] - skel.bind[el * 3 + 1];
    assert.ok(Math.abs(Math.hypot(w[el * 3] - w[sh * 3], w[el * 3 + 1] - w[sh * 3 + 1], w[el * 3 + 2] - shZ) - upper) < 1e-3);
  }
  // Out of reach: the arm points straight at the target.
  const pose = new Pose(skel).solve();
  pose.reach(sh, el, hand, 100, -7.5, 57.5, 0, 0, -1);
  const w = pose.wpos;
  const reach = skel.bind[sh * 3 + 1] - skel.bind[hand * 3 + 1];
  assert.ok(Math.abs(w[hand * 3] - w[sh * 3] - reach) < 0.05, `straight: ${w[hand * 3] - w[sh * 3]}`);
});

Deno.test('mannequin: closed, low-poly, and every part follows the bone it sits on', async () => {
  const { buildMannequin } = await import('../client/models/mannequin.js');
  const m = buildMannequin([0.3, 0.4, 0.6]);
  checkClosed(m, 'mannequin');
  assert.ok(m.tris <= 1000, `${m.tris} triangles`);
  // Each vertex lies near its bone's segment: the right arm's on the right side, etc.
  const u8 = new Uint8Array(m.data), S = PLAYER_SKELETON;
  const used = new Set();
  for (let v = 0; v < m.count; v++) {
    const bone = u8[v * MESH_STRIDE + 15], y = m.positions[v * 3 + 1];
    used.add(S.names[bone]);
    if (S.names[bone].endsWith('_R')) assert.ok(y < 0, `${S.names[bone]} vertex at y ${y}`);
    if (S.names[bone].endsWith('_L')) assert.ok(y > 0, `${S.names[bone]} vertex at y ${y}`);
  }
  for (const n of ['hand_R', 'ankle_R', 'head_0', 'pelvis']) assert.ok(used.has(n), `no vertex on ${n}`);
});

Deno.test('light point: the lightmap under a point, like GoldSrc R_LightPoint', async (t) => {
  const { parseBSP } = await import('../shared/bsp.js');
  const { SurfaceMap } = await import('../shared/surfaces.js');
  let bsp;
  try {
    bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_dust2.bsp', import.meta.url)).buffer);
  } catch {
    await t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });
    return;
  }
  const s = new SurfaceMap(bsp);
  const out = new Float32Array(3);
  assert.ok(s.lightAt(out, -832, -704, 164), 'T spawn floor is lit');
  assert.ok(out[0] > 20 && out[0] >= out[2], `warm sunlight ${out}`);
  assert.equal(s.lightAt(out, 0, 0, -20000), false, 'nothing below the map');
  assert.deepEqual([...out], [0, 0, 0]);
});
