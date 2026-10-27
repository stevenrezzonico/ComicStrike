import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TICK_DT, IN_ATTACK } from '../shared/constants.js';
import { CollisionWorld } from '../shared/trace.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { WEAPON_ID, SLOT_GRENADE, THROW_LONG, THROW_SHORT, giveWeapon } from '../shared/weapons.js';
import {
  Grenades, heDamage, flashDuration, fireRadius, smokeRadius, FUSE, HE_DAMAGE, HE_RADIUS, FX_HE, FX_SMOKE, FX_FIRE,
  FIRE_DPS, SMOKE_TIME,
} from '../shared/grenades.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
import { Game } from '../server/game.js';

let bsp = null;
try {
  bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_dust2.bsp', import.meta.url)).buffer);
} catch { /* map-dependent tests skip */ }

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
} });

Deno.test({ name: 'server: a thrown HE flies from the thrower, hurts an enemy, and the kill is credited', ignore: !bsp, fn: () => {
  const game = new Game('de_dust2', bsp, { rounds: false });
  const w = new Writer();
  const join = (name, team) => {
    const c = game.connect({ send() {}, close() {}, closed: false });
    game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
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
