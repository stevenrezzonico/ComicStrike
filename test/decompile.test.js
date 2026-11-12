import assert from 'node:assert/strict';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { box } from '../shared/bspwriter.js';
import { CollisionWorld, pointContents } from '../shared/trace.js';
import { decompileBSP } from '../client/editor/decompile.js';
import {
  readProject, checkProject, compileProject, withProject, projectIn, piecesOf, cornersOf, turnFaces, mirrorFaces,
  newProject, connectedTo, mainTexture,
} from '../client/editor/project.js';
import { readMapFile, openInEditor, solidAgreement, wallHoles, yard } from './harness.js';

// A .bsp opened in the map editor (client/editor/decompile.js): turned back into shapes that
// compile into the same solid space (the helpers and Valve's maps: test/harness.js and
// decompile_*.test.js).

for (const name of ['de_playground', 'de_inkwell']) {
  Deno.test(`decompile: ${name} opens and compiles back to the same solid space`, () => {
    const { bsp, project, report, p } = openInEditor(name);
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
    // The playground's cart comes back with its corners.
    if (name === 'de_playground') assert.equal(p.points.filter((q) => q.kind === 'path_corner').length, 4);
    assert.deepEqual(report.dropped, {},
      'our own maps hold nothing else the editor cannot make');
    const out = compileProject(p, 'draft').bytes;
    assert.ok(solidAgreement(bsp, p, out) > 0.995, 'solid where it was solid');
    const h = wallHoles(bsp, out);
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
  const { p } = openInEditor('de_playground');
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

// A map from `extra(map)` in the test yard, opened in the editor as the editor keeps it.
const openYard = (extra, edit = () => {}) => {
  const bsp = yard(extra);
  edit(bsp);
  return { bsp, p: readProject(JSON.parse(JSON.stringify(decompileBSP(bsp, 'x.bsp').project))) };
};
const compiled = (p) => parseUntrustedBSP(compileProject(p, 'draft').bytes.buffer);

Deno.test('decompile: an entity that comes back in several shapes stays one, turning about its own origin', () => {
  // A swinging door with a handle, hinged at x 0, and a cart of a bed and a cab.
  const { p } = openYard((map) => {
    map.brushEntity({ classname: 'func_door_rotating', origin: '0 0 64', distance: '90', speed: '100' },
      [box(0, -4, 0, 64, 4, 128, 'steel'), box(48, 4, 56, 56, 10, 64, 'steel')]);
    map.brushEntity({ classname: 'func_train', target: 'c1', speed: '100' },
      [box(-400, -32, 0, -272, 32, 16, 'steel'), box(-304, -32, 16, -272, 32, 64, 'steel')]);
    map.point({ classname: 'path_corner', targetname: 'c1', target: 'c2', origin: '-336 0 32' });
    map.point({ classname: 'path_corner', targetname: 'c2', target: 'c1', origin: '336 0 32' });
  });
  const door = p.brushes.filter((b) => b.kind === 'func_door_rotating');
  assert.ok(door.length > 1 && p.brushes.filter((b) => b.kind === 'func_train').length > 1, 'both come back in shapes');
  const out = compiled(p);
  const of = (b, cls) => b.entities.filter((e) => e.classname === cls);
  assert.deepEqual(of(out, 'func_door_rotating').map((e) => e.origin), ['0 0 64'], 'one door, hinged where it was');
  assert.equal(of(out, 'func_train').length, 1, 'one train');
  // Its shapes moved together, the hinge goes along.
  for (const b of door) for (const k of [0, 3]) b.b[k] += 100;
  assert.deepEqual(of(compiled(p), 'func_door_rotating').map((e) => e.origin), ['100 0 64']);
  // A file without the tags reads as before: a shape, an entity.
  const plain = readProject(JSON.parse(JSON.stringify(p, (k, v) => (k === 'entity' || k === 'origin' ? undefined : v))));
  assert.equal(of(compiled(plain), 'func_door_rotating').length, door.length);
});

Deno.test('decompile: world slime and lava come back as slime and lava', () => {
  const at = [600, 0, 100];
  const { p } = openYard((map) => map.world.push(box(-200, -200, -32, 200, 200, 0, 'steel')), (bsp) => {
    // The yard's air turned to lava (what a compiler makes of a !lava world brush).
    let n = bsp.modelsI[9];
    while (n >= 0) {
      const q = bsp.nodesI32[n * 6] * 5, d = bsp.planesF[q] * at[0] + bsp.planesF[q + 1] * at[1] + bsp.planesF[q + 2] * at[2] - bsp.planesF[q + 3];
      n = bsp.nodesI16[n * 12 + (d >= 0 ? 2 : 3)];
    }
    bsp.leavesI32[(-1 - n) * 7] = -5;
  });
  assert.deepEqual(p.brushes.filter((b) => b.kind === 'func_water').map((b) => b.keys.skin), ['-5']);
  assert.equal(pointContents(CollisionWorld.fromBSP(compiled(p)), ...at), -5);
});

Deno.test('decompile: a relay list keeps the keys that fire one name again (name#1)', () => {
  const { p } = openYard((map) => map.point({ classname: 'multi_manager', targetname: 'mm', boom: '1', 'boom#1': '3', origin: '0 0 64' }));
  const mm = p.points.find((q) => q.kind === 'multi_manager');
  assert.equal(mm.keys['boom#1'], '3', 'opened and read back');
  assert.equal(compiled(p).entities.find((e) => e.classname === 'multi_manager')['boom#1'], '3', 'compiled');
});

Deno.test('decompile: a texture named like an object\'s own property opens and compiles', () => {
  const { p } = openYard((map) => {
    map.textures = { ...map.textures, constructor: [32, 32] };
    map.world.push(box(0, 0, 0, 64, 64, 64, 'constructor'));
  });
  assert.deepEqual(p.textures.constructor, [32, 32], 'with its size');
  assert.ok(compiled(p).textureNames.includes('constructor'));
  // A project naming them, and a kind, shape or point kind no editor makes.
  const q = newProject();
  q.brushes[5].tex = { top: 'valueOf', bottom: 'toString', side: '__proto__' };
  q.brushes[6].kind = 'constructor';
  q.brushes[6].shape = 'toString';
  q.points.push({ kind: 'hasOwnProperty', o: [0, 0, 0], yaw: 0 });
  const back = readProject(JSON.parse(JSON.stringify(q)));
  assert.equal(back.brushes[6].kind, 'world');
  assert.equal(back.brushes[6].shape, 'box');
  assert.equal(back.points.length, q.points.length - 1);
  const names = compiled(readProject(JSON.parse(JSON.stringify(back)))).textureNames;
  for (const t of ['valueOf', 'toString', '__proto__']) assert.ok(names.some((n) => n.toLowerCase() === t.toLowerCase()), t);
});

Deno.test('decompile: a mangled map is refused or opens without throwing', () => {
  const src = readMapFile('de_playground');
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

Deno.test('select connected: touching shapes of one kind and texture, nothing apart', () => {
  // The starter map: three crates in a stack touch, the fourth stands apart.
  const q = newProject();
  const crates = q.brushes.filter((b) => b.tex.side === 'crate08');
  assert.deepEqual(connectedTo(q, [crates[0].id]).sort(), crates.slice(0, 3).map((b) => b.id).sort());
  assert.deepEqual(connectedTo(q, [crates[3].id]), [crates[3].id]);
  // An opened map's slices: each one found touches another and wears the same texture.
  const { p } = openInEditor('de_inkwell');
  const wall = p.brushes.find((b) => b.kind === 'world' && b.shape === 'convex' && b.tex.side && b.tex.side !== 'sky' &&
    connectedTo(p, [b.id]).length > 3);
  assert.ok(wall, 'a wall in slices');
  const ids = connectedTo(p, [wall.id]);
  for (const id of ids) assert.equal(mainTexture(p.brushes.find((b) => b.id === id)), mainTexture(wall));
});
