import assert from 'node:assert/strict';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, hullFits, HULL_STAND } from '../shared/trace.js';
import { Nav } from '../shared/nav.js';
import { readProject, checkProject, projectIn } from '../client/editor/project.js';

// cs_polaris is a hostage map made from an office floor plan (a script kept out of the
// repository wrote its editor project and compiled it), so here are the project and the
// map, the project appended to the map like the editor's exports.
const projectText = Deno.readTextFileSync(new URL('../maps/cs_polaris.cmap.json', import.meta.url));
const bytes = Deno.readFileSync(new URL('../maps/cs_polaris.bsp', import.meta.url));
const bsp = parseUntrustedBSP(bytes.slice().buffer); // checked like a map from outside
const world = CollisionWorld.fromBSP(bsp);
const at = (cls) => bsp.entities.filter((e) => e.classname === cls).map((e) => e.origin.split(' ').map(Number));

Deno.test('cs_polaris: the project reads clean, and the map carries it', async () => {
  const p = readProject(projectText);
  assert.equal(p.brushes.length, JSON.parse(projectText).brushes.length, 'nothing dropped by readProject');
  assert.deepEqual(checkProject(p).errors.map((x) => x.text), []);
  assert.deepEqual(await projectIn(bytes), JSON.parse(projectText), 'the editor opens the map as its project');
});

Deno.test('cs_polaris: spawns, hostages and the rescue zone; spawns stand free on the floor', () => {
  const t = at('info_player_deathmatch'), ct = at('info_player_start'), hostages = at('hostage_entity');
  assert.equal(t.length, 10);
  assert.equal(ct.length, 10);
  assert.ok(hostages.length >= 4);
  assert.equal(bsp.entities.filter((e) => e.classname === 'func_hostage_rescue').length, 1);
  for (const [x, y, z] of [...t, ...ct]) {
    assert.ok(hullFits(world, HULL_STAND, x, y, z), `room to stand at ${x} ${y}`);
    assert.ok(!hullFits(world, HULL_STAND, x, y, z - 2), `a floor under ${x} ${y}`);
  }
});

Deno.test('cs_polaris: the bots find a way from either spawn to every hostage', () => {
  const nav = new Nav(bsp, world);
  const from = nav.nodeAt(...at('info_player_start')[0].map((v, k) => (k === 2 ? v - 36 : v)));
  assert.ok(from >= 0);
  const seen = new Uint8Array(nav.count), queue = [from];
  seen[from] = 1;
  while (queue.length) {
    const k = queue.pop();
    for (let e = nav.first[k]; e < nav.first[k + 1]; e++) {
      if (!seen[nav.to[e]]) {
        seen[nav.to[e]] = 1;
        queue.push(nav.to[e]);
      }
    }
  }
  for (const [x, y, z] of [...at('info_player_deathmatch').map(([x, y, z]) => [x, y, z - 36]), ...at('hostage_entity')]) {
    const k = nav.nodeAt(x, y, z);
    assert.ok(k >= 0 && seen[k], `reached ${x} ${y}`);
  }
});
