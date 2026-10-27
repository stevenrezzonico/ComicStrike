import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, ENT_SOLID, ENT_NONE, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { Breakables, MAT_WOOD } from '../shared/breakables.js';
import { WEAPONS, WEAPON_ID, damageAtRange } from '../shared/weapons.js';

async function loadMap(t, name) {
  try {
    const bsp = parseBSP((await Deno.readFile(new URL(`../maps/${name}.bsp`, import.meta.url))).buffer);
    const world = CollisionWorld.fromBSP(bsp);
    return { bsp, world, breakables: new Breakables(bsp, world) };
  } catch {
    await t.step({ name: `skipped: maps/${name}.bsp missing`, fn: () => {}, ignore: true });
    return null;
  }
}

// A slot's world-space center and its top.
function center(b, slot) {
  const c = [0, 0, 0];
  for (let a = 0; a < 3; a++) c[a] = (b.mins[slot * 3 + a] + b.maxs[slot * 3 + a]) / 2;
  return [c, b.maxs[slot * 3 + 2]];
}

Deno.test('fy_buzzkill: wooden crates take AK fire and break on the third bullet', async (t) => {
  const m = await loadMap(t, 'fy_buzzkill');
  if (!m) return;
  const { world, breakables: b } = m;
  assert.equal(b.count, 24);
  const slot = [...Array(b.count + 1).keys()].find((s) => s > 0 && b.maxHealth[s] === 75);
  assert.equal(b.material[slot], MAT_WOOD);
  const ent = b.ent[slot];

  const ak = WEAPONS[WEAPON_ID.ak47];
  const dmg = damageAtRange(ak, ak.damage, 300);
  assert.ok(dmg > 75 / 3 && dmg < 75 / 2, `ak damage at 300u: ${dmg}`);
  assert.equal(b.damage(world, ent, dmg), 0);
  assert.equal(b.damage(world, ent, dmg), 0);
  assert.equal(b.damage(world, ent, dmg), slot, 'third bullet breaks it');
  assert.equal(world.ents[ent].kind, ENT_NONE);
  assert.equal(b.damage(world, ent, dmg), 0, 'already broken');

  // A player can now stand where the crate was.
  const [c] = center(b, slot);
  const tr = new Trace();
  traceHull(world, HULL_STAND, c[0], c[1], c[2] + 40, c[0], c[1], c[2] - 40, tr);
  assert.notEqual(tr.ent, ent, 'broken crate still collides');

  b.reset(world);
  assert.equal(world.ents[ent].kind, ENT_SOLID);
  assert.equal(b.health[slot], 75);
});

Deno.test('fy_buzzkill: every piece of every crate can be shot apart', async (t) => {
  const m = await loadMap(t, 'fy_buzzkill');
  if (!m) return;
  const { world, breakables: b } = m;
  // Each crate is 2-3 overlapping func_breakables (lid, hollow side walls, floor slab)
  // that break separately, as in GoldSrc. Shoot at its center from above and from the
  // four sides until every piece is gone.
  const tr = new Trace();
  const dirs = [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (let s = 1; s <= b.count; s++) {
    const [c] = center(b, s);
    for (let shot = 0; shot < 60 && !b.broken[s]; shot++) {
      const [dx, dy, dz] = dirs[shot % dirs.length];
      const from = 100 + (dz ? b.maxs[s * 3 + 2] - c[2] : 64);
      traceHull(world, HULL_POINT, c[0] + dx * from, c[1] + dy * from, c[2] + dz * from, c[0], c[1], c[2] - 1, tr);
      if (b.slotOfEnt[tr.ent]) b.damage(world, tr.ent, 50);
    }
    assert.ok(b.broken[s], `crate piece ${s} survived`);
  }
});

Deno.test('de_dust2: bomb-site crates are trigger-only and ignore bullets', async (t) => {
  const m = await loadMap(t, 'de_dust2');
  if (!m) return;
  const { world, breakables: b } = m;
  assert.ok(b.count > 0);
  for (let s = 1; s <= b.count; s++) {
    assert.equal(b.damage(world, b.ent[s], 1000), 0);
    assert.equal(world.ents[b.ent[s]].kind, ENT_SOLID);
  }
});
