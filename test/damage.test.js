import assert from 'node:assert/strict';
import { TICK_DT, IN_FORWARD } from '../shared/constants.js';
import { playerMove, PS_ORIGIN, PS_VELMOD, PS_FLAGS, FL_ONGROUND } from '../shared/pmove.js';
import { WEAPONS, WEAPON_ID, ShotList, createWeaponState, giveWeapon, WS_ACTIVE } from '../shared/weapons.js';
import { HitTargets, HITGROUP_HEAD, HITGROUP_CHEST, HITGROUP_LEGS } from '../shared/hitgroups.js';
import { Player, applyDamage, resolveShots, penetrationLoss, ImpactList } from '../shared/player.js';
import { SURF_DEFAULT, GM_GLASS, GM_WOOD } from '../shared/surfaces.js';
import { boxWorld, floorWorld } from './worlds.js';

const ak = WEAPONS[WEAPON_ID.ak47];
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

Deno.test('armor: CS:GO split between health and kevlar; helmets; legs unprotected', () => {
  const p = new Player();
  p.armor = 100;
  // AK chest: 36 * 1.55 * 0.5 = 27.9 to health (27 after truncation), (36 - 27.9) * 0.5 to armor.
  assert.equal(applyDamage(p, 36, ak, HITGROUP_CHEST), 27);
  assert.equal(p.health, 73);
  assert.equal(p.armor, 95);
  // Head without a helmet: unprotected (4x).
  const q = new Player();
  q.armor = 100;
  assert.equal(applyDamage(q, 144, ak, HITGROUP_HEAD), 144);
  assert.equal(q.armor, 100);
  // With a helmet the AK still one-taps: 144 * 0.775 = 111.6.
  const h = new Player();
  h.armor = 100;
  h.helmet = true;
  assert.equal(applyDamage(h, 144, ak, HITGROUP_HEAD), 111);
  // Legs never protected.
  const l = new Player();
  l.armor = 100;
  assert.equal(applyDamage(l, 27, ak, HITGROUP_LEGS), 27);
  assert.equal(l.armor, 100);
  // Running out of armor: what it cannot absorb goes to health, and the helmet goes.
  const r = new Player();
  r.armor = 2;
  r.helmet = true;
  assert.equal(applyDamage(r, 36, ak, HITGROUP_CHEST), 32); // 36 - 2 / 0.5
  assert.equal(r.armor, 0);
  assert.equal(r.helmet, false);
});

Deno.test('tagging: a hit caps speed (less with armor), recovering over time', () => {
  const bare = new Player();
  applyDamage(bare, 10, ak, HITGROUP_CHEST);
  assert.equal(bare.ps.f[PS_VELMOD], Math.fround(ak.flinchLarge));
  const kevlar = new Player();
  kevlar.armor = 100;
  applyDamage(kevlar, 10, ak, HITGROUP_CHEST);
  assert.equal(kevlar.ps.f[PS_VELMOD], Math.fround(ak.flinchSmall));

  // Running while tagged is slower, and the cap wears off.
  const world = floorWorld();
  const run = (p, ticks) => {
    for (let i = 0; i < ticks; i++) playerMove(world, p.ps, IN_FORWARD, 0, 0, TICK_DT, 250);
  };
  const fresh = new Player();
  for (const p of [fresh, bare]) {
    p.ps.f[PS_ORIGIN + 2] = 36;
    p.ps.i[PS_FLAGS] = FL_ONGROUND;
  }
  run(fresh, 20);
  run(bare, 20);
  assert.ok(bare.ps.f[PS_ORIGIN] < fresh.ps.f[PS_ORIGIN] - 10, 'tagged player kept up');
  run(bare, 64 * 2);
  assert.equal(bare.ps.f[PS_VELMOD], 1);
});

// One AK bullet along +x at chest height from x = 0.
function fire(world, targets) {
  const ws = createWeaponState();
  giveWeapon(ws, WEAPON_ID.ak47);
  ws.f[WS_ACTIVE] = ak.slot;
  const shots = new ShotList();
  shots.push(0, 0, 50, 1, 0, 0, ak.range, WEAPON_ID.ak47, ak.damage);
  const impacts = new ImpactList();
  const breakables = { slotOfEnt: new Uint8Array(8), material: new Uint8Array(1), damage: () => 0 };
  resolveShots(world, breakables, ws, shots, impacts, targets);
  return impacts;
}

function targetAt(...xs) {
  const t = new HitTargets(4);
  xs.forEach((x, id) => t.set(id, x, 0, 36, 180, FL_ONGROUND, 0, 2)); // facing the shooter
  return t;
}

Deno.test('penetration: an 8-unit wall costs what CS:GO\'s formula says', () => {
  const world = boxWorld([{ min: [100, -64, 0], max: [108, 64, 128] }]);
  const im = fire(world, targetAt(200));
  // entry decal, exit decal, player
  assert.equal(im.count, 3);
  near(im.pos[0], 100, 0.1, 'entry');
  near(im.pos[3], 108, 0.1, 'exit');
  assert.equal(im.player[2], 0);
  // Recompute from the actual hit points (traces stop DIST_EPSILON short of surfaces).
  const entry = im.pos[0], exit = im.pos[3], thick = exit - entry;
  let d = ak.damage * Math.pow(ak.rangeModifier, entry / 500);
  d -= d * 0.16 + (3 / ak.penetration) * 1.25 * 3 + thick * thick / 24; // default surfaces both sides
  const chest = 200 - 7; // the chest box's front face
  d *= Math.pow(ak.rangeModifier, (entry + thick + (chest - exit)) / 500);
  near(im.damage[2], d, 1e-3, 'damage behind the wall');
  assert.equal(im.group[2], HITGROUP_CHEST);
});

Deno.test('penetration: too thick to find the far side within 90 units stops the bullet', () => {
  const world = boxWorld([{ min: [100, -64, 0], max: [200, 64, 128] }]);
  const im = fire(world, targetAt(300));
  assert.equal(im.count, 1, 'only the entry hole');
  assert.equal(im.player[0], -1);
});

Deno.test('collaterals: the bullet goes through one player into the next', () => {
  const im = fire(boxWorld([]), targetAt(200, 260));
  const hits = [...im.player.subarray(0, im.count)].filter((p) => p >= 0);
  assert.deepEqual(hits, [0, 1]);
  assert.ok(im.damage[1] < im.damage[0] && im.damage[1] > 10, `${im.damage[0]} then ${im.damage[1]}`);
});

Deno.test('penetration rules: glass and grates barely slow bullets; wood-to-wood is easy', () => {
  const glass = [0.99, GM_GLASS], wood = [0.9, GM_WOOD];
  const base = penetrationLoss(30, 2, SURF_DEFAULT, SURF_DEFAULT, 4);
  assert.ok(penetrationLoss(30, 2, glass, SURF_DEFAULT, 4) < base);
  near(penetrationLoss(30, 2, wood, wood, 4), 30 * 0.16 + 1.875 * 3 / 3 + 16 / 3 / 24, 1e-9, 'wood both sides');
  assert.ok(penetrationLoss(30, 1, SURF_DEFAULT, SURF_DEFAULT, 4) > base, 'pistols penetrate worse');
});

Deno.test('de_dust2: almost every bullet hit finds the face (and texture) it landed on', async (t) => {
  let bsp;
  try {
    const { parseBSP } = await import('../shared/bsp.js');
    bsp = parseBSP((await Deno.readFile(new URL('../maps/de_dust2.bsp', import.meta.url))).buffer);
  } catch {
    return t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });
  }
  const { CollisionWorld, Trace, traceHull, HULL_POINT } = await import('../shared/trace.js');
  const { SurfaceMap } = await import('../shared/surfaces.js');
  const world = CollisionWorld.fromBSP(bsp);
  const map = new SurfaceMap(bsp);
  const tr = new Trace();
  const spawns = bsp.entities.filter((e) => /^info_player_(start|deathmatch)$/.test(e.classname));
  let hits = 0, found = 0;
  const kinds = new Set();
  for (let i = 0; i < 400; i++) {
    const [x, y, z] = spawns[i % spawns.length].origin.split(' ').map(Number);
    const a = i * 2.39996, b = Math.sin(i * 1.7) * 0.5; // golden-angle spiral of directions
    const dx = Math.cos(a) * Math.cos(b), dy = Math.sin(a) * Math.cos(b), dz = Math.sin(b);
    traceHull(world, HULL_POINT, x, y, z + 20, x + dx * 4096, y + dy * 4096, z + 20 + dz * 4096, tr);
    if (tr.fraction >= 1 || tr.startsolid || tr.ent !== 0) continue;
    hits++;
    const f = map.findFace(0, tr.endx - dx * 4, tr.endy - dy * 4, tr.endz - dz * 4, tr.endx + dx * 4, tr.endy + dy * 4,
      tr.endz + dz * 4);
    if (f >= 0) {
      found++;
      kinds.add(map.surfaceAt(world, 0, tr.endx, tr.endy, tr.endz, dx, dy, dz)[0]);
    }
  }
  assert.ok(hits > 300, `${hits} hits`);
  assert.ok(found >= hits * 0.97, `found ${found} of ${hits}`);
  assert.ok(kinds.size >= 3, `only ${[...kinds]} surface types`);
});
