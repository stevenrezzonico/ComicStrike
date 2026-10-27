import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_ATTACK } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { CollisionWorld, hullFits, HULL_STAND } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { Overview } from '../shared/overview.js';
import { Grenades, FX_SMOKE, SMOKE_GROW } from '../shared/grenades.js';
import { PHASE_LIVE } from '../shared/economy.js';
import {
  Writer, CmdRing, writeHello, writeCmds, E_ANIM, ANIM_SPOTTED_T, ANIM_SPOTTED_CT,
} from '../shared/protocol.js';
import { Game } from '../server/game.js';

let bsp = null;
try {
  bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_dust2.bsp', import.meta.url)).buffer);
} catch { /* map-dependent tests skip */ }

Deno.test({ name: 'overview: the reachable floors, lighter higher; spawns on them; north up', ignore: !bsp, fn: () => {
  const world = CollisionWorld.fromBSP(bsp);
  const o = new Overview(bsp, world, 256);
  assert.ok(Math.max(o.width, o.height) <= 256);
  // Spawn points show the floor they stand on (spawn origins float a little above it).
  // Where a walkable level passes over one (a few of dust2's CT spawns), that shows.
  const spawns = bsp.entities.filter((e) => e.classname === 'info_player_start' || e.classname === 'info_player_deathmatch');
  let onFloor = 0;
  for (const e of spawns) {
    const [x, y, z] = e.origin.split(' ').map(Number);
    const floor = o.floorAt(x, y);
    assert.ok(floor > z - 70, `spawn ${x} ${y}: a floor shows`);
    if (floor <= z - 30) onFloor++;
  }
  assert.ok(onFloor >= spawns.length * 0.75, `${onFloor} of ${spawns.length} spawns on their own floor`);
  // Pixels: transparent off the floors, opaque on them; higher floors are lighter.
  let lo = null, hi = null;
  for (let i = 0; i < o.width * o.height; i++) {
    const z = o.floor[i], a = o.rgba[i * 4 + 3];
    assert.equal(a, z === -Infinity ? 0 : 255);
    if (z === -Infinity || o.rgba[i * 4] < 60) continue; // outline
    if (!lo || z < lo[0]) lo = [z, o.rgba[i * 4]];
    if (!hi || z > hi[0]) hi = [z, o.rgba[i * 4]];
  }
  assert.ok(hi[1] > lo[1] + 60, 'higher is lighter');
  // North up: world y grows toward row 0.
  assert.ok(o.py(o.maxY - 100) < o.py(o.maxY - 200));
  // Most of the map's floor area is reachable, but not everything standable (roofs).
  let shown = 0, standable = 0;
  for (let i = 0; i < o.width * o.height; i++) {
    if (o.floor[i] > -Infinity) shown++;
    if (o.layers[i * 6] > -Infinity) standable++;
  }
  assert.ok(shown > standable * 0.5 && shown < standable * 0.95, `${shown} of ${standable}`);
} });

Deno.test('smoke blocks a line of sight through it, not one beside it', () => {
  const g = new Grenades();
  g.addEffect(FX_SMOKE, 0, 0, TEAM_T, 0, 0, 0);
  g.fxAge[0] = SMOKE_GROW + 1; // fully grown
  assert.ok(g.smokeBetween(-500, 0, 40, 500, 0, 40), 'straight through');
  assert.ok(!g.smokeBetween(-500, 400, 40, 500, 400, 40), 'well beside it');
  assert.ok(!g.smokeBetween(-500, 0, 40, -300, 0, 40), 'stops short of it');
});

function setup() {
  const game = new Game('de_dust2', bsp, { freezeTime: 0, roundTime: 600, buyTime: 1, roundEndDelay: 1 });
  const w = new Writer();
  const clients = [];
  const join = (name, team) => {
    const c = game.connect({ send() {}, close() {} });
    game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    c.input = { buttons: 0, pitch: 0, yaw: 0 };
    clients.push(c);
    return c;
  };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of clients) {
        const k = c.input;
        c.cmds.put(c.tick, k.buttons, -1, k.pitch, k.yaw, 0);
        game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      game.step();
    }
  };
  // The spotted bits the newest snapshot carries for player `c`.
  const spotted = (c) => {
    const ring = game.snapshots;
    return ring.ents[ring.row(ring.find(game.tick), c.id) + E_ANIM] & (ANIM_SPOTTED_T | ANIM_SPOTTED_CT);
  };
  return { game, join, run, spotted };
}

function teleport(c, x, y, z) {
  const f = c.player.ps.f;
  f[PS_ORIGIN] = x;
  f[PS_ORIGIN + 1] = y;
  f[PS_ORIGIN + 2] = z;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
}

Deno.test({ name: 'spotting: seen in the view cone, not behind, not through smoke; firing shows', ignore: !bsp, fn: () => {
  const { game, join, run, spotted } = setup();
  const t = join('alpha', TEAM_T), ct = join('bravo', TEAM_CT), ct2 = join('charlie', TEAM_CT);
  run(2);
  while (game.phase !== PHASE_LIVE) run(1);
  // An open stretch at the CT spawn: t 300 units east of ct.
  const [x, y, z] = game.spawns[TEAM_CT].find(([sx, sy, sz]) =>
    hullFits(game.world, HULL_STAND, sx + 300, sy, sz) && hullFits(game.world, HULL_STAND, sx + 150, sy, sz));
  const place = (yawCt) => {
    teleport(ct, x, y, z);
    teleport(t, x + 300, y, z);
    teleport(ct2, x - 2000, y - 2000, z); // out of the way
    ct.input.yaw = yawCt;
    t.input.yaw = 180;
    ct2.input.yaw = 0;
    run(8);
    teleport(ct, x, y, z); // keep them there whatever the commands did
    teleport(t, x + 300, y, z);
    run(4);
  };
  place(0);
  assert.ok(spotted(t) & ANIM_SPOTTED_CT, 'the CT looks at him: on the CT radar');
  assert.ok(spotted(ct) & ANIM_SPOTTED_T, 'and the T sees the CT');
  assert.ok(!(spotted(t) & ANIM_SPOTTED_T), 'never on his own team\'s bit');
  place(180);
  assert.ok(!(spotted(t) & ANIM_SPOTTED_CT), 'the CT looks away: not spotted');
  // Smoke between them hides him even in plain view.
  place(0);
  game.grenades.addEffect(FX_SMOKE, 0, 0, TEAM_T, x + 150, y, z - 36);
  game.grenades.fxAge[game.grenades.fxCount - 1] = SMOKE_GROW + 1;
  run(8);
  assert.ok(!(spotted(t) & ANIM_SPOTTED_CT), 'smoke between');
  // Firing an unsilenced gun shows him for a moment, smoke or not.
  t.input.buttons = IN_ATTACK;
  run(1);
  t.input.buttons = 0;
  run(4);
  assert.equal(spotted(t), ANIM_SPOTTED_T | ANIM_SPOTTED_CT, 'firing: on every radar');
  run(80);
  assert.ok(!(spotted(t) & ANIM_SPOTTED_CT), 'a second later: hidden again');
} });
