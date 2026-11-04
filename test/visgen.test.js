// Visibility for our own maps (shared/bspvis.js through shared/bspwriter.js, `vis: true`):
// two rooms whose doors open onto one corridor cannot see each other, a doorway between
// them lets them; on cs_polaris every leaf a ray from a spawn reaches is in that spawn's
// PVS (conservative), and the renderer culls with it (client/gl/worldvis.js).
import assert from 'node:assert/strict';
import { MapBuilder, box } from '../shared/bspwriter.js';
import { parseUntrustedBSP, parseBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, HULL_POINT } from '../shared/trace.js';
import { WorldVis } from '../client/gl/worldvis.js';
import { buildMapMesh } from '../client/mapmesh.js';

const TEX = { sky: [256, 256], crete3_wall02: [128, 128], '-0sand': [128, 128] };
const W = 'crete3_wall02';
const NO_MESH = { indices: new Uint32Array(0), faceFirst: [], faceCount: [], worldOpaqueCount: 0 };

// Rooms west and east of a wall, each with a door in its north wall onto a corridor that
// runs over both (a line out of one door cannot come down through the other); `door`: a
// doorway through the wall between them too.
function rooms(door, vis = true) {
  const map = new MapBuilder(TEX, { message: 'test' });
  map.world.push(
    box(-1024, -512, -32, 1024, 1024, 0, '-0sand'),
    box(-1056, -544, -32, -1024, 1056, 288, W), box(1024, -544, -32, 1056, 1056, 288, W),
    box(-1024, -544, -32, 1024, -512, 288, W), box(-1024, 1024, -32, 1024, 1056, 288, W),
    box(-1056, -544, 256, 1056, 1056, 288, 'sky'),
    box(-1024, 512, 0, -900, 544, 256, W), box(-800, 512, 0, -64, 544, 256, W), // the west room's north wall
    box(64, 512, 0, 800, 544, 256, W), box(900, 512, 0, 1024, 544, 256, W), // the east room's
  );
  if (door) map.world.push(box(-64, -512, 0, 64, -64, 256, W), box(-64, 64, 0, 64, 544, 256, W));
  else map.world.push(box(-64, -512, 0, 64, 544, 256, W));
  map.point({ classname: 'info_player_deathmatch', origin: '-900 -400 37', angles: '0 0 0' });
  map.point({ classname: 'info_player_start', origin: '900 -400 37', angles: '0 180 0' });
  return parseUntrustedBSP(map.compile({ light: 'draft', vis }).bytes.buffer);
}

const sees = (bsp, a, b) => {
  const vis = new WorldVis(bsp, NO_MESH);
  const la = vis.leafAt(...a), lb = vis.leafAt(...b);
  assert.ok(la > 0 && lb > 0 && bsp.leavesI32[la * 7 + 1] >= 0, 'both in leaves with a PVS row');
  vis.mark(la);
  return vis.leafMark[lb] === vis.visframe;
};

Deno.test('vis: rooms round the end of a wall do not see each other, a doorway lets them', () => {
  const closed = rooms(false), open = rooms(true);
  assert.ok(closed.visibility.length > 0 && closed.modelsI[13] > 0, 'a visibility lump and visleafs');
  assert.ok(!sees(closed, [-500, -200, 64], [500, -200, 64]), 'west cannot see east');
  assert.ok(sees(closed, [-500, -200, 64], [-850, 700, 64]), 'west sees the corridor past its door');
  assert.ok(sees(closed, [500, -200, 64], [850, 700, 64]), 'east sees the corridor past its door');
  assert.ok(sees(open, [-500, -200, 64], [500, -200, 64]), 'through the doorway');
});

// Every leaf a ray from each spawn's eye reaches before a wall is marked from there.
function conservative(name) {
  const bsp = parseBSP(Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url)).buffer);
  assert.ok(bsp.visibility.length > 0, `${name} carries a PVS`);
  const world = CollisionWorld.fromBSP(bsp), tr = new Trace();
  const mesh = buildMapMesh(bsp), vis = new WorldVis(bsp, mesh);
  const spawns = bsp.entities.filter((e) => /^info_player_(start|deathmatch)$/.test(e.classname))
    .map((e) => e.origin.split(' ').map(Number));
  let drawn = 0, missed = 0, rays = 0;
  for (const s of spawns) {
    const eye = [s[0], s[1], s[2] + 28];
    const n = vis.update(eye, new Float32Array(16)); // no view: every face of the marked leaves, all round
    assert.ok(n >= 0, 'culling (the eye in a leaf with a row)');
    drawn += n;
    for (let i = 0; i < 1500; i++) { // directions on a sphere (golden spiral)
      const z = 1 - (i + 0.5) / 750, r = Math.sqrt(Math.max(0, 1 - z * z)), a = i * 2.39996;
      const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
      traceHull(world, HULL_POINT, eye[0], eye[1], eye[2], eye[0] + dx * 8192, eye[1] + dy * 8192, eye[2] + z * 8192, tr);
      const k = Math.max(0, tr.fraction * 8192 - 1); // just short of the wall
      const leaf = vis.leafAt(eye[0] + dx * k, eye[1] + dy * k, eye[2] + z * k);
      rays++;
      if (leaf > 0 && vis.leafMark[leaf] !== vis.visframe) missed++;
    }
  }
  assert.equal(missed, 0, `${name}: ${missed} of ${rays} rays end in a leaf outside the PVS`);
  return drawn / spawns.length / mesh.worldOpaqueCount;
}

Deno.test('vis: on cs_polaris every leaf a ray from a spawn reaches is in its PVS, and a part of the world is drawn', () => {
  const share = conservative('cs_polaris');
  assert.ok(share < 0.85, `cs_polaris draws ${(share * 100).toFixed(0)} % of its world from the spawns`);
});

Deno.test('vis: off by default, as before', () => {
  const bsp = rooms(false, false);
  assert.equal(bsp.visibility.length, 0);
  assert.equal(new WorldVis(bsp, NO_MESH).update([0, 0, 64], new Float32Array(16)), -1, 'everything drawn');
});
