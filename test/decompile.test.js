import assert from 'node:assert/strict';
import { parseUntrustedBSP, faceNumEdges, faceVertex, facePlane, faceSide, faceTexinfo } from '../shared/bsp.js';
import { CollisionWorld, pointContents, traceHull, Trace, HULL_POINT } from '../shared/trace.js';
import { Nav, NAV_CELL } from '../shared/nav.js';
import { decompileBSP } from '../client/editor/decompile.js';
import {
  readProject, checkProject, compileProject, bounds, withProject, projectIn, piecesOf, cornersOf, turnFaces, mirrorFaces, LIMITS,
  newProject, connectedTo, mainTexture,
} from '../client/editor/project.js';

// A .bsp opened in the map editor (client/editor/decompile.js): turned back into shapes that
// compile into the same solid space.
const read = (name) => {
  try {
    return Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url));
  } catch {
    return null;
  }
};

// Solid or not, at random points within the opened map's bounds: the original against the
// map compiled back from its project.
function agreement(bsp, p, out, samples = 3000) {
  const a = CollisionWorld.fromBSP(bsp), b = CollisionWorld.fromBSP(parseUntrustedBSP(out.buffer));
  const box = bounds(p);
  let seed = 7, same = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < samples; i++) {
    const q = [0, 1, 2].map((k) => box[k] + (box[k + 3] - box[k]) * rnd());
    if ((pointContents(a, ...q) === -1) === (pointContents(b, ...q) === -1)) same++;
  }
  return same / samples;
}

// Rays from random points open in both maps: of the hits on a face drawn in the original,
// the share where the map compiled back draws none (a hole: a cell side that came back
// with no texture compiles to no face, and the wall was see-through) or only sky where the
// original drew a wall (a side over a wall face and a sky face that took the sky).
function holes(bsp, out, rays = 2000) {
  const back = parseUntrustedBSP(out.slice().buffer);
  const maps = [bsp, back].map((m) => ({ world: CollisionWorld.fromBSP(m), faces: facesOf(m) }));
  const box = [0, 1, 2, 3, 4, 5].map((k) => bsp.modelsF[k]), tr = new Trace();
  let seed = 11, walls = 0, missing = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < rays;) {
    const q = [0, 1, 2].map((k) => box[k] + (box[k + 3] - box[k]) * rnd());
    if (maps.some((m) => pointContents(m.world, ...q) !== -1)) continue;
    i++;
    const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z), dir = [r * Math.cos(t), r * Math.sin(t), z];
    const hit = maps.map((m) => {
      traceHull(m.world, HULL_POINT, ...q, q[0] + dir[0] * 4000, q[1] + dir[1] * 4000, q[2] + dir[2] * 4000, tr);
      return tr.fraction < 1 && !tr.startsolid ? [tr.endx, tr.endy, tr.endz] : null;
    });
    if (!hit[0] || !hit[1] || Math.hypot(hit[0][0] - hit[1][0], hit[0][1] - hit[1][1], hit[0][2] - hit[1][2]) > 2) continue;
    if (drawnAt(maps[0].faces, hit[0], dir) !== 'wall') continue;
    walls++;
    if (drawnAt(maps[1].faces, hit[1], dir) !== 'wall') missing++;
  }
  return missing / Math.max(walls, 1);
}

// A map's faces as outward planes and corner loops, with their bounds.
function facesOf(b) {
  const faces = [];
  for (let f = 0; f < b.numFaces; f++) {
    const pl = facePlane(b, f), s = faceSide(b, f) ? -1 : 1;
    const pts = [];
    for (let i = 0; i < faceNumEdges(b, f); i++) {
      const v = faceVertex(b, f, i);
      pts.push([b.vertices[v * 3], b.vertices[v * 3 + 1], b.vertices[v * 3 + 2]]);
    }
    faces.push({
      sky: /^sky/i.test(b.textureNames[b.texinfoI[faceTexinfo(b, f) * 10 + 8]] || ''),
      n: [0, 1, 2].map((k) => b.planesF[pl * 5 + k] * s), d: b.planesF[pl * 5 + 3] * s, pts,
      lo: [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k])) - 1), hi: [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])) + 1),
    });
  }
  return faces;
}

// What is drawn at point h facing a ray along dir: 'wall', 'sky' or null.
function drawnAt(faces, h, dir) {
  const within = (f) => {
    let sign = 0;
    for (let i = 0; i < f.pts.length; i++) {
      const p = f.pts[i], q = f.pts[(i + 1) % f.pts.length], e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const r = [h[0] - p[0], h[1] - p[1], h[2] - p[2]];
      const x = (e[1] * r[2] - e[2] * r[1]) * f.n[0] + (e[2] * r[0] - e[0] * r[2]) * f.n[1] + (e[0] * r[1] - e[1] * r[0]) * f.n[2];
      if (Math.abs(x) < 0.5) continue;
      if (sign && Math.sign(x) !== sign) return false;
      sign = Math.sign(x);
    }
    return true;
  };
  const at = faces.filter((f) => h.every((v, k) => v >= f.lo[k] && v <= f.hi[k]) &&
    Math.abs(f.n[0] * h[0] + f.n[1] * h[1] + f.n[2] * h[2] - f.d) < 1 && f.n[0] * dir[0] + f.n[1] * dir[1] + f.n[2] * dir[2] < 0 &&
    within(f));
  return at.some((f) => !f.sky) ? 'wall' : at.length ? 'sky' : null;
}

function open(name) {
  const bsp = parseUntrustedBSP(read(name).slice().buffer);
  const { project, report } = decompileBSP(bsp, `${name}.bsp`);
  const p = readProject(JSON.parse(JSON.stringify(project))); // as the editor keeps it
  return { bsp, project, report, p };
}

for (const name of ['de_playground', 'de_inkwell']) {
  Deno.test(`decompile: ${name} opens and compiles back to the same solid space`, () => {
    const { bsp, project, report, p } = open(name);
    assert.equal(p.brushes.length, project.brushes.length, 'readProject keeps every shape');
    assert.deepEqual(checkProject(p).errors, []);
    const kinds = (list) => list.reduce((m, e) => m.set(e, (m.get(e) || 0) + 1), new Map());
    // Spawns come back where they were (feet 36 under the hull center).
    const spawns = bsp.entities.filter((e) => /^info_player_(deathmatch|start)$/.test(e.classname));
    assert.equal(p.points.filter((q) => /^info_player/.test(q.kind)).length, spawns.length);
    // Lamps come back as lamp points with their keys.
    const lamps = bsp.entities.filter((e) => e.classname === 'light' || e.classname === 'light_spot');
    assert.ok(lamps.length > 0, 'our maps have lamps');
    assert.equal(p.points.filter((q) => /^light/.test(q.kind)).length, lamps.length);
    for (const e of lamps) {
      const [x, y, z] = e.origin.split(' ').map(Number);
      const q = p.points.find((q) => q.kind === e.classname && q.o[0] === x && q.o[1] === y && q.o[2] === z);
      assert.ok(q, e.origin);
      assert.equal(q.keys._light, e._light);
    }
    for (const e of spawns) {
      const [x, y, z] = e.origin.split(' ').map(Number);
      assert.ok(p.points.some((q) => q.o[0] === Math.round(x) && q.o[1] === Math.round(y) && q.o[2] === Math.round(z - 36)), e.origin);
    }
    // Every entity kind the editor makes is there (zones as one shape each).
    const made = kinds(p.brushes.filter((b) => b.kind !== 'world').map((b) => b.kind));
    for (const cls of ['func_buyzone', 'func_bomb_target']) {
      assert.equal(made.get(cls), bsp.entities.filter((e) => e.classname === cls).length, cls);
    }
    for (const cls of ['func_breakable', 'func_door_rotating', 'func_water']) {
      if (bsp.entities.some((e) => e.classname === cls)) assert.ok(made.get(cls) > 0, cls);
    }
    // The editor has no trains yet: the playground's cart and its corners are left out.
    assert.deepEqual(report.dropped, name === 'de_playground' ? { func_train: 1, path_corner: 4 } : {},
      'our own maps hold nothing else the editor cannot make');
    const out = compileProject(p, 'draft').bytes;
    assert.ok(agreement(bsp, p, out) > 0.995, 'solid where it was solid');
    const h = holes(bsp, out);
    assert.ok(h < 0.002, `walls drawn where they were (${(h * 100).toFixed(2)} % of hits on no face or sky)`);
  });
}

Deno.test('decompile: an exported map carries its project and opens as it exactly', async () => {
  const p = readProject(Deno.readTextFileSync(new URL('../maps/de_inkwell.cmap.json', import.meta.url)));
  const bytes = compileProject(p, 'draft').bytes;
  const out = await withProject(bytes, p);
  assert.ok(out.length > bytes.length && out.length < bytes.length + 64 * 1024, `${out.length - bytes.length} bytes more`);
  parseUntrustedBSP(out.slice().buffer); // the game takes it as it is
  assert.deepEqual(readProject(await projectIn(out)), p);
  assert.equal(await projectIn(bytes), null, 'a plain map carries none');
  const bad = out.slice();
  bad[bytes.length + 5] ^= 0xff; // a spoiled project reads as none
  assert.equal(await projectIn(bad), null);
});

Deno.test('decompile: convex pieces move, turn and mirror with their box', () => {
  const { p } = open('de_playground');
  const piece = p.brushes.find((b) => b.shape === 'convex');
  assert.ok(piece, 'the playground has angled shapes');
  assert.ok(piece.faces.every((f) => f.length === 5 && Math.abs(Math.hypot(f[0], f[1], f[2]) - 1) < 1e-5));
  const corners = (br) => piecesOf(br).flatMap(cornersOf);
  const same = (a, b) => a.length === b.length && a.every((p) => b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.01));
  const before = corners(piece), [x0, y0, z0, x1, y1, z1] = piece.b, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // Moved and stretched with its box.
  const moved = { ...piece, b: [x0 + 64, y0, z0, x1 + 64 + (x1 - x0), y1, z1] };
  assert.ok(same(corners(moved), before.map(([x, y, z]) => [x0 + 64 + (x - x0) * 2, y, z])), 'stretched');
  // A quarter turn counter-clockwise about its center (the editor's rotate90 on the box).
  const hx = (y1 - y0) / 2, hy = (x1 - x0) / 2;
  const turned = { ...piece, b: [cx - hx, cy - hy, z0, cx + hx, cy + hy, z1], faces: turnFaces(piece.faces) };
  assert.ok(same(corners(turned), before.map(([x, y, z]) => [cx - (y - cy), cy + (x - cx), z])), 'turned');
  const mirrored = { ...piece, faces: mirrorFaces(piece.faces) };
  assert.ok(same(corners(mirrored), before.map(([x, y, z]) => [x0 + x1 - x, y, z])), 'mirrored');
});

Deno.test('decompile: a mangled map is refused or opens without throwing', () => {
  const src = read('de_playground');
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 40; i++) {
    const b = src.slice();
    for (let k = 0; k < 20; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    let bsp;
    try {
      bsp = parseUntrustedBSP(b.buffer);
    } catch {
      continue;
    }
    const { project } = decompileBSP(bsp, 'mangled.bsp');
    readProject(JSON.parse(JSON.stringify(project)));
  }
});

// Valve's maps (not in the repository: skipped without them).
for (const name of ['de_dust2', 'cs_office', 'de_nuke']) {
  Deno.test({
    name: `decompile: ${name} opens under the editor's limits, compiles back the same, and bots find their way`,
    ignore: !read(name),
    fn() {
      const { bsp, p } = open(name);
      assert.ok(p.brushes.length <= LIMITS.brushes, `${p.brushes.length} shapes`);
      assert.deepEqual(checkProject(p).errors, []);
      const out = compileProject(p, 'draft').bytes;
      assert.ok(agreement(bsp, p, out, 2000) > 0.99, 'solid where it was solid');
      const h = holes(bsp, out);
      assert.ok(h < 0.002, `walls drawn where they were (${(h * 100).toFixed(2)} % of hits on no face or sky)`);
      const back = parseUntrustedBSP(out.buffer), world = CollisionWorld.fromBSP(back);
      const nav = new Nav(back, world, NAV_CELL, true);
      const node = (cls) => {
        const [x, y, z] = back.entities.find((e) => e.classname === cls).origin.split(' ').map(Number);
        return nav.nodeAt(x, y, z - 36);
      };
      assert.ok(nav.path(node('info_player_deathmatch'), node('info_player_start'), new Int32Array(8192)) > 0, 'a way from spawn to spawn');
    },
  });
}

Deno.test('select connected: touching shapes of one kind and texture, nothing apart', () => {
  // The starter map: three crates in a stack touch, the fourth stands apart.
  const q = newProject();
  const crates = q.brushes.filter((b) => b.tex.side === 'crate08');
  assert.deepEqual(connectedTo(q, [crates[0].id]).sort(), crates.slice(0, 3).map((b) => b.id).sort());
  assert.deepEqual(connectedTo(q, [crates[3].id]), [crates[3].id]);
  // An opened map's slices: each one found touches another and wears the same texture.
  const { p } = open('de_inkwell');
  const wall = p.brushes.find((b) => b.kind === 'world' && b.shape === 'convex' && b.tex.side && b.tex.side !== 'sky' &&
    connectedTo(p, [b.id]).length > 3);
  assert.ok(wall, 'a wall in slices');
  const ids = connectedTo(p, [wall.id]);
  for (const id of ids) assert.equal(mainTexture(p.brushes.find((b) => b.id === id)), mainTexture(wall));
});
