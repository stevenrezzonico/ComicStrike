// The visible-world culling (client/gl/worldvis.js): a map without visibility data and a
// camera in solid draw everything; elsewhere whole faces of the world's opaque range come
// out, each once, a small share of the map, less in each direction than all round, and the
// map's own index ranges stay untouched.
import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { buildMapMesh } from '../client/mapmesh.js';
import { WorldVis } from '../client/gl/worldvis.js';
import { perspective, viewFromAngles, multiply } from '../client/gl/mat4.js';

const load = (name) => {
  try {
    return parseBSP(Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url)).buffer);
  } catch {
    return null;
  }
};
const dust2 = load('de_dust2');

function viewProj(eye, pitch, yaw) {
  const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
  perspective(proj, 74 * Math.PI / 180, 16 / 9, 4, 16384);
  viewFromAngles(view, eye[0], eye[1], eye[2], pitch, yaw);
  return multiply(vp, proj, view);
}

Deno.test('worldvis: no visibility data (de_playground) draws everything', () => {
  const bsp = load('de_playground');
  const vis = new WorldVis(bsp, buildMapMesh(bsp));
  assert.equal(vis.update([0, 0, 64], viewProj([0, 0, 64], 0, 0)), -1);
});

Deno.test({ name: 'worldvis: de_dust2 keeps a small share, in whole faces, each once', ignore: !dust2, fn: () => {
  const mesh = buildMapMesh(dust2);
  const vis = new WorldVis(dust2, mesh);
  const before = mesh.indices.slice();
  // Every face has its own vertices: the face of each vertex the world's opaque range uses.
  const faceOfVertex = new Map();
  for (let f = 0; f < dust2.numFaces; f++) {
    for (let i = 0; i < mesh.faceCount[f]; i++) faceOfVertex.set(mesh.indices[mesh.faceFirst[f] + i], f);
  }
  const spawns = dust2.entities.filter((e) => /^info_player_(start|deathmatch)$/.test(e.classname))
    .map((e) => e.origin.split(' ').map(Number));
  assert.ok(spawns.length > 10);
  let total = 0;
  for (const [k, s] of spawns.entries()) {
    const eye = [s[0], s[1], s[2] + 28];
    const n = vis.update(eye, viewProj(eye, 0, k * 37));
    assert.ok(n > 0 && n % 3 === 0, `spawn ${k}: ${n}`);
    total += n;
    // Whole faces, each once: every face that comes out brings all of its indices.
    const got = new Map();
    for (const v of vis.out.subarray(0, n)) {
      const f = faceOfVertex.get(v);
      assert.ok(f !== undefined, 'only world opaque faces');
      got.set(f, (got.get(f) || 0) + 1);
    }
    for (const [f, c] of got) assert.equal(c, mesh.faceCount[f], `face ${f} whole`);
  }
  const share = total / spawns.length / mesh.worldOpaqueCount;
  assert.ok(share < 0.2, `kept ${(share * 100).toFixed(1)} %`);
  assert.deepEqual(mesh.indices, before, 'the map ranges are untouched');
} });

Deno.test({ name: 'worldvis: a camera in solid draws everything', ignore: !dust2, fn: () => {
  const vis = new WorldVis(dust2, buildMapMesh(dust2));
  const eye = [0, 0, 5000]; // far above the map: outside, solid
  assert.equal(vis.update(eye, viewProj(eye, 0, 0)), -1);
} });

Deno.test({ name: 'worldvis: looking away culls what is behind, turning round brings it back', ignore: !dust2, fn: () => {
  const vis = new WorldVis(dust2, buildMapMesh(dust2));
  const s = dust2.entities.find((e) => e.classname === 'info_player_start').origin.split(' ').map(Number);
  const eye = [s[0], s[1], s[2] + 28];
  const sets = [0, 90, 180, 270].map((yaw) => new Set(vis.out.subarray(0, vis.update(eye, viewProj(eye, 0, yaw)))));
  const all = new Set(sets.flatMap((x) => [...x]));
  for (const x of sets) assert.ok(x.size < all.size, 'each direction draws less than all four together');
} });

Deno.test({ name: 'worldvis: sees() a box in the camera\'s PVS, a point by its leaf, everything when not culling', ignore: !dust2, fn: () => {
  const vis = new WorldVis(dust2, buildMapMesh(dust2));
  const spawns = dust2.entities.filter((e) => e.classname === 'info_player_deathmatch').map((e) => e.origin.split(' ').map(Number));
  const cts = dust2.entities.filter((e) => e.classname === 'info_player_start').map((e) => e.origin.split(' ').map(Number));
  const eye = [spawns[0][0], spawns[0][1], spawns[0][2] + 28];
  assert.ok(vis.sees(-9999, -9999, -9999, 9999, 9999, 9999), 'before any update: everything');
  assert.ok(vis.update(eye, viewProj(eye, 0, 0)) > 0);
  const box = (p, r) => vis.sees(p[0] - r, p[1] - r, p[2] - r, p[0] + r, p[1] + r, p[2] + r);
  assert.ok(box(eye, 16), 'where the camera is');
  assert.ok(spawns.every((p) => box(p, 40)), 'the other T spawns');
  assert.ok(!cts.some((p) => box(p, 40)), 'not the CT spawn across the map');
  // A point is seen exactly when its own leaf is marked.
  let seen = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const p = [-2000 + (i * 977) % 4000, -1000 + (i * 613) % 4200, -200 + (i * 37) % 400];
    const leaf = vis.leafAt(p[0], p[1], p[2]);
    if (leaf === 0) continue;
    n++;
    const marked = vis.leafMark[leaf] === vis.visframe;
    assert.equal(vis.sees(p[0], p[1], p[2], p[0], p[1], p[2]), marked, `point ${p}`);
    if (marked) seen++;
  }
  assert.ok(n > 300 && seen < n / 2, `${seen} of ${n} points seen`);
  vis.update([eye[0], eye[1], -5000], viewProj(eye, 0, 0)); // in solid: draws everything
  assert.ok(box(cts[0], 40), 'not culling: everything');
}});

// A crafted visibility row that runs off the end of the lump (here a zero run of nothing,
// then the end) looped forever and hung the tab; it now ends, the rest of the row seen.
Deno.test('worldvis: a visibility row running off the lump ends, seeing the rest', () => {
  const bsp = load('cs_polaris');
  const vis = new WorldVis(bsp, buildMapMesh(bsp));
  bsp.visibility = new Uint8Array([0, 0]);
  bsp.leavesI32[1 * 7 + 1] = 0;
  vis.mark(1);
  assert.ok(vis.row.every((x) => x === 255));
});
