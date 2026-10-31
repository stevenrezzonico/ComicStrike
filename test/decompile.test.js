import assert from 'node:assert/strict';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, pointContents } from '../shared/trace.js';
import { Nav, NAV_CELL } from '../shared/nav.js';
import { decompileBSP } from '../client/editor/decompile.js';
import {
  readProject, checkProject, compileProject, bounds, withProject, projectIn, piecesOf, cornersOf, turnFaces, mirrorFaces, LIMITS,
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
    assert.equal(p.points.filter((q) => q.kind !== 'hostage_entity').length, spawns.length);
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
    assert.deepEqual(report.dropped, {}, 'our own maps hold nothing the editor cannot make');
    const out = compileProject(p, 'draft').bytes;
    assert.ok(agreement(bsp, p, out) > 0.995, 'solid where it was solid');
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
