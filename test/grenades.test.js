import assert from 'node:assert/strict';
import { TICK_DT, IN_ATTACK } from '../shared/constants.js';
import { CollisionWorld } from '../shared/trace.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { TEAM_T, TEAM_CT, applyDamage } from '../shared/player.js';
import { HITGROUP_CHEST } from '../shared/hitgroups.js';
import { WEAPONS, WEAPON_ID, SLOT_GRENADE, THROW_LONG, THROW_SHORT, giveWeapon } from '../shared/weapons.js';
import {
  Grenades, heDamage, flashDuration, fireRadius, smokeRadius, FUSE, HE_DAMAGE, HE_RADIUS, FX_HE, FX_SMOKE, FX_FIRE,
  FX_FIZZLE, FIRE_DPS, SMOKE_TIME, SMOKE_GROW, SMOKE_SHAPES, SMOKE_FLOOR, SMOKE_MARGIN, smokePose,
} from '../shared/grenades.js';
import { buildSmokeCloud } from '../client/gl/grenadefx.js';
import { floorWorld } from './worlds.js';
import { Writer, writeCmds } from '../shared/protocol.js';
import { Game } from '../server/game.js';
import { mapOrNull, loadMap, joinClient } from './harness.js';

const bsp = mapOrNull('de_dust2');

// A T spawn on de_dust2 (open ground).
const SPAWN = bsp ? bsp.entities.find((e) => e.classname === 'info_player_deathmatch').origin.split(' ').map(Number) : [];

// Targets standing at given feet positions (hull center 36 above), looking along yaw.
function targets(list) {
  const damage = list.map(() => 0), flashed = list.map(() => 0);
  return {
    damage, flashed,
    count: list.length,
    alive: () => true,
    center: (i, out) => out.set([list[i][0], list[i][1], list[i][2] + 36]),
    eye: (i, out) => out.set([list[i][0], list[i][1], list[i][2] + 64]),
    feet: (i, out) => out.set([list[i][0], list[i][1], list[i][2]]),
    pitch: () => 0,
    yaw: (i) => list[i][3] || 0,
    hurt: (i, d) => (damage[i] += d),
    flash: (i, s) => (flashed[i] = Math.max(flashed[i], s)),
  };
}

function floorUnder(world, x, y, z) {
  const g = new Grenades();
  g.throw(world, WEAPON_ID.smokegrenade, 0, 0, x, y, z, 89, 0, 0, 0, 0, THROW_SHORT);
  for (let i = 0; i < 300 && !g.resting[0]; i++) g.move(world, 0, false);
  return g.pos[2];
}

Deno.test('grenade formulas: CS:GO throw speeds, HE gaussian, flash by angle and distance', () => {
  // HE: 99 at the center, gaussian falloff, nothing beyond 350.
  assert.equal(Math.round(heDamage(0)), HE_DAMAGE);
  assert.ok(heDamage(100) < heDamage(50) && heDamage(HE_RADIUS + 1) === 0);
  // At someone's feet (a hull's half width away): CS:GO's 98 unarmored, 57 armored, so two
  // kill a fully armored player.
  const atFeet = heDamage(16);
  assert.equal(Math.trunc(atFeet), 98);
  const armored = { health: 100, armor: 100, helmet: true, ps: { f: new Float32Array(64) } };
  assert.equal(applyDamage(armored, atFeet, WEAPONS[WEAPON_ID.hegrenade], HITGROUP_CHEST), 56);
  applyDamage(armored, atFeet, WEAPONS[WEAPON_ID.hegrenade], HITGROUP_CHEST);
  assert.ok(armored.health <= 0, `two HEs leave ${armored.health}`);
  // Flashbangs: looking at it is worst, looking away still blinds a little, far is less.
  assert.ok(flashDuration(200, 1) > flashDuration(200, 0) && flashDuration(200, 0) > flashDuration(200, -1));
  assert.ok(flashDuration(200, -1) > 0, 'even behind you');
  assert.ok(flashDuration(1200, 1) < flashDuration(200, 1));
  // Smoke and fire grow, then go.
  assert.ok(smokeRadius(0.1) < smokeRadius(5) && smokeRadius(SMOKE_TIME + 1) === 0);
  assert.ok(fireRadius(0.1) < fireRadius(3));
});

Deno.test({ name: 'grenades fly, bounce and settle; HE and flashbangs go off after 1.5 s', ignore: !bsp, fn: () => {
  const world = CollisionWorld.fromBSP(bsp);
  const [x, y, z] = SPAWN;
  const floor = floorUnder(world, x, y, z + 64);
  const g = new Grenades();
  // Straight ahead at full strength: CS:GO throws 10 degrees up at 600 u/s.
  g.throw(world, WEAPON_ID.hegrenade, 0, TEAM_T, x, y, floor + 64, 0, 0, 0, 0, 0, THROW_LONG);
  assert.ok(Math.abs(Math.hypot(g.vel[0], g.vel[2]) - 600) < 1e-6);
  assert.ok(g.vel[2] > 0, 'aimed level, it leaves slightly upward');
  const lob = new Grenades();
  lob.throw(world, WEAPON_ID.hegrenade, 0, TEAM_T, x, y, floor + 64, 0, 0, 0, 0, 0, THROW_SHORT);
  assert.ok(Math.abs(Math.hypot(lob.vel[0], lob.vel[2]) - 180) < 1e-6, 'right click: 30 %');

  // An HE dropped at our feet: a target next to it is hurt, one far away is not.
  const h = new Grenades();
  const t = targets([[x + 40, y, floor], [x + 2000, y, floor]]);
  h.throw(world, WEAPON_ID.hegrenade, 5, TEAM_T, x, y, floor + 40, 89, 0, 0, 0, 0, THROW_SHORT);
  let ticks = 0;
  while (h.count && ticks < 500) {
    h.update(world, t);
    ticks++;
  }
  assert.equal(ticks, Math.round(FUSE / TICK_DT), 'goes off after its fuse');
  assert.equal(h.fxKind[0], FX_HE);
  assert.ok(t.damage[0] > 40 && t.damage[0] < HE_DAMAGE, `close: ${t.damage[0]}`);
  assert.equal(t.damage[1], 0);


  // A flashbang in front of one target and behind another.
  const f = new Grenades();
  const ft = targets([[x - 200, y, floor, 0], [x - 200, y + 1, floor, 180]]);
  f.throw(world, WEAPON_ID.flashbang, 5, TEAM_T, x, y, floor + 40, 89, 0, 0, 0, 0, THROW_SHORT);
  for (let i = 0; i < 200; i++) f.update(world, ft);
  assert.equal(f.fxCount, 0, 'the pop is over');
  assert.ok(ft.flashed[0] > 3 && ft.flashed[1] > 0 && ft.flashed[1] < ft.flashed[0] / 2,
    `facing ${ft.flashed[0]}, away ${ft.flashed[1]}`);
} });

Deno.test({ name: 'smoke pops once it stops; a molotov burns on the floor and a smoke puts it out', ignore: !bsp, fn: () => {
  const world = CollisionWorld.fromBSP(bsp);
  const [x, y, z] = SPAWN;
  const floor = floorUnder(world, x, y, z + 64);
  const g = new Grenades();
  const t = targets([[x + 30, y, floor]]);
  g.throw(world, WEAPON_ID.molotov, 5, TEAM_T, x, y, floor + 40, 89, 0, 0, 0, 0, THROW_SHORT);
  let ticks = 0;
  while (g.count && ticks < 300) {
    g.update(world, t);
    ticks++;
  }
  assert.ok(ticks < 64, 'bursts when it hits the floor');
  assert.equal(g.fxKind[0], FX_FIRE);
  assert.ok(Math.abs(g.fxPos[2] - floor) < 2);
  for (let i = 0; i < 128; i++) g.update(world, t);
  assert.ok(Math.abs(t.damage[0] - 2 * FIRE_DPS) <= 10, `about 40 a second: ${t.damage[0]} in 2 s`);

  g.throw(world, WEAPON_ID.smokegrenade, 5, TEAM_T, x + 10, y, floor + 40, 89, 0, 0, 0, 0, THROW_SHORT);
  for (let i = 0; i < 128 && g.count; i++) g.update(world, t);
  assert.equal(g.count, 0, 'the smoke stopped and popped');
  assert.deepEqual(Array.from(g.fxKind.subarray(0, g.fxCount)), [FX_SMOKE], 'and put the fire out');
  for (let i = 0; i < 64; i++) g.update(world, t);
  assert.ok(g.inSmoke(x, y, floor + 40), 'a second later the cloud covers it');
  // How far into the cloud a point is, for the fog: nothing well outside, all smoke inside.
  const cx = g.fxPos[0], cy = g.fxPos[1], cz = g.fxPos[2];
  assert.equal(g.smokeDepth(cx + 300, cy, cz + 40), 0, 'outside');
  assert.equal(g.smokeDepth(cx, cy, cz + 40), 1, 'in the middle');
} });

// A grown smoke at (x, y, z) whose id picks cloud shape `shape`, `age` seconds old.
function oneSmoke(shape = 0, x = 0, y = 0, z = 0, age = SMOKE_GROW + 3) {
  const g = new Grenades();
  g.nextId = SMOKE_SHAPES + shape;
  g.addEffect(FX_SMOKE, 0, 0, TEAM_T, x, y, z);
  g.fxAge[0] = age;
  return g;
}

Deno.test('smoke: the rules take the cloud as it is drawn, every corner of it', () => {
  const P = new Float64Array(7);
  for (let shape = 0; shape < SMOKE_SHAPES; shape++) {
    for (const age of [0.5, SMOKE_GROW + 3, SMOKE_TIME - 1]) { // popping, grown, shrinking away
      const g = oneSmoke(shape, 100, -200, 30, age), id = g.fxId[0];
      smokePose(P, id, age, g.fxPos, 0);
      const cloud = buildSmokeCloud([1, 1, 1], id % SMOKE_SHAPES + 1), q = cloud.positions; // as GrenadeFx builds it
      let n = 0;
      for (let v = 0; v < q.length; v += 3) {
        if (q[v + 2] <= SMOKE_FLOOR + 1e-6) continue; // the flat base
        // The corner where the client draws it (GrenadeFx.smoke), and points along the line
        // from the cloud's middle through it.
        const ox = (P[4] * q[v] - P[5] * q[v + 1]) * P[6], oy = (P[5] * q[v] + P[4] * q[v + 1]) * P[6], oz = q[v + 2] * P[6];
        const d = Math.hypot(ox, oy, oz), at = (u) => [P[0] + ox * (1 + u / d), P[1] + oy * (1 + u / d), P[2] + oz * (1 + u / d)];
        const where = `shape ${shape} at ${age} s, corner ${v / 3}`;
        assert.ok(g.inSmoke(...at(-2)), `${where}: smoke 2 units in`);
        assert.ok(!g.inSmoke(...at(2)), `${where}: none 2 units out`);
        assert.equal(g.smokeDepth(...at(-2)), 1, `${where}: the view all smoke inside`);
        assert.equal(g.smokeDepth(...at(SMOKE_MARGIN + 2)), 0, `${where}: no fog well outside`);
        // 4 units off the surface (the near plane: closer, it cuts the cloud open) the view
        // is all smoke, beside a lobe too.
        const nx = P[4] * cloud.normals[v] - P[5] * cloud.normals[v + 1], ny = P[5] * cloud.normals[v] + P[4] * cloud.normals[v + 1];
        const nz = cloud.normals[v + 2], nl = Math.hypot(nx, ny, nz) / 4;
        assert.equal(g.smokeDepth(P[0] + ox + nx / nl, P[1] + oy + ny / nl, P[2] + oz + nz / nl), 1, `${where}: all smoke 4 units off`);
        n++;
      }
      assert.ok(n > 600, `${n} corners`);
    }
  }
});

Deno.test('smoke: lines through the cloud are blocked at every height it is drawn, not beyond', () => {
  for (let shape = 0; shape < SMOKE_SHAPES; shape++) {
    const g = oneSmoke(shape);
    for (let a = 0; a < 12; a++) {
      const c = Math.cos(a * Math.PI / 6), s = Math.sin(a * Math.PI / 6);
      // A line across the cloud passing `off` from its middle, `h` over the floor.
      const across = (off, h) => g.smokeBetween(-s * off - c * 600, c * off - s * 600, h, -s * off + c * 600, c * off + s * 600, h);
      // At a standing eye's height the cloud is drawn 131-181 out (the old rules stopped at
      // 107 and saw through the rest), up to ~140 high (they stopped at 96).
      assert.ok(across(120, 64), `shape ${shape}, ${a * 30} deg: 120 out at eye height`);
      assert.ok(across(0, 110), `shape ${shape}, ${a * 30} deg: over 96 high`);
      assert.ok(!across(220, 64), `shape ${shape}, ${a * 30} deg: beside it`);
      assert.ok(!across(0, 170), `shape ${shape}, ${a * 30} deg: over it`);
      assert.ok(!g.smokeBetween(-s * 600, c * 600, 64, -s * 260, c * 260, 64), `shape ${shape}, ${a * 30} deg: stops short`);
    }
  }
});

Deno.test('smoke: a flashbang behind the edge of a cloud blinds nobody', () => {
  const world = floorWorld();
  // A line 120 from the cloud's middle at eye height: its midpoint was out of the old
  // rules' cloud, so the flash went through.
  const flash = (g) => {
    const t = targets([[400, 120, 0, 180]]);
    g.throw(world, WEAPON_ID.flashbang, 1, TEAM_CT, -400, 120, 64, 0, 0, 0, 0, 0, THROW_LONG);
    g.detonate(world, g.count - 1, 'flash', -400, 120, 64, true, t);
    return t.flashed[0];
  };
  assert.ok(flash(new Grenades()) > 1, 'with no smoke it blinds');
  assert.equal(flash(oneSmoke()), 0, 'through the cloud it does not');
});

Deno.test({ name: 'server: a thrown HE flies from the thrower, hurts an enemy, and the kill is credited', ignore: !bsp, fn: () => {
  const game = new Game('de_dust2', bsp, { rounds: false });
  const w = new Writer();
  const join = (name, team) => {
    const c = joinClient(game, w, name, team);
    c.input = { buttons: 0, select: -1, pitch: 0, yaw: 0 };
    return c;
  };
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      for (const c of [a, b]) {
        c.cmds.put(c.tick, c.input.buttons, i === 0 ? c.input.select : -1, c.input.pitch, c.input.yaw, 0);
        game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      game.step();
    }
  };
  run(2);
  // Bravo stands right where alpha drops an HE.
  giveWeapon(a.player.ws, WEAPON_ID.hegrenade);
  const af = a.player.ps.f, bf = b.player.ps.f;
  bf[PS_ORIGIN] = af[PS_ORIGIN] + 48;
  bf[PS_ORIGIN + 1] = af[PS_ORIGIN + 1];
  bf[PS_ORIGIN + 2] = af[PS_ORIGIN + 2];
  b.player.health = 40;
  a.input.select = SLOT_GRENADE;
  run(64);
  a.input.pitch = 89;
  a.input.buttons = IN_ATTACK;
  run(3);
  a.input.buttons = 0;
  run(10);
  assert.equal(game.grenades.count, 1, 'in flight');
  run(Math.round(FUSE / TICK_DT));
  assert.equal(game.grenades.count, 0);
  assert.ok(b.player.health <= 0, 'bravo died');
  assert.equal(a.player.kills, 1);
  assert.ok(a.player.health > 0 && a.player.health < 100, 'the thrower is hurt by his own HE');
} });

Deno.test('grenades in water drag and sink slowly (HL); a molotov in water fizzles', () => {
  const world = CollisionWorld.fromBSP(loadMap('de_playground')); // its diving well: x 60..300, y 520..700, water -192..-2
  const g = new Grenades(), none = targets([]);
  g.throw(world, WEAPON_ID.decoy, 0, TEAM_T, 180, 610, 120, 89, 90, 0, 0, 0, THROW_LONG);
  let under = 0, speed = Infinity;
  for (let t = 0; t < 128 && !g.resting[0]; t++) {
    g.update(world, none);
    if (g.pos[2] < -10 && ++under === 20) speed = Math.hypot(g.vel[0], g.vel[1], g.vel[2]);
  }
  assert.ok(speed < 100, `slowed under water (it went in at ~400 u/s; sinking settles at ~49) (${speed.toFixed(0)} u/s after 20 ticks in)`);
  const fire = new Grenades();
  fire.throw(world, WEAPON_ID.molotov, 0, TEAM_T, 180, 610, 120, 89, 90, 0, 0, 0, THROW_LONG);
  for (let t = 0; t < 192 && !fire.fxCount; t++) fire.update(world, none);
  assert.equal(fire.fxCount, 1, 'it burst');
  assert.equal(fire.fxKind[0], FX_FIZZLE, 'and fizzled');
  assert.ok(fire.fxPos[2] < 0 && fire.fxPos[2] > -40, `at the surface (z ${fire.fxPos[2].toFixed(0)})`);
});
