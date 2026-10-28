import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_ATTACK, IN_USE, IN_FORWARD } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { traceHull, hullFits, Trace, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import {
  WEAPON_ID, WS_SLOTS, WS_ACTIVE, WS_GRENADES, GRENADE_IDS, SLOT_PRIMARY, SLOT_GRENADE, SLOT_C4,
} from '../shared/weapons.js';
import { TEAM_T } from '../shared/player.js';
import { BOMB_CARRIED, BOMB_PLANTED, BOMB_DEFUSED, BOMB_EXPLODED } from '../shared/bomb.js';
import { PHASE_LIVE, GAME_DEMO } from '../shared/economy.js';
import { Writer, CmdRing, writeHello, writeCmds, writeBuy } from '../shared/protocol.js';
import { Game } from '../server/game.js';
import { Host } from '../server/host.js';

let bsp = null;
try {
  bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_dust2.bsp', import.meta.url)).buffer);
} catch { /* map-dependent tests skip */ }

// The demo's rules as cfg/gamemode_demo.cfg and the mode set them; one T alone.
function setup(rules = {}) {
  const game = new Game('de_dust2', bsp, {
    demo: true, freezeTime: 0, warmupTime: 0, roundTime: 3600, buyTime: 3600, ignoreWinConditions: true,
    buyAnywhere: true, giveC4: false, respawnT: true, respawnCT: true, deathDropGun: false, ...rules,
  });
  const w = new Writer();
  const c = game.connect({ send() {}, close() {} });
  game.receive(c, writeHello(w, TEAM_T, 0, 0, 'tester').slice());
  c.cmds = new CmdRing();
  c.tick = 1;
  c.input = { buttons: 0, select: -1, pitch: 0, yaw: 0 };
  let buyId = 0;
  c.buy = (item) => game.receive(c, writeBuy(w, ++buyId, item).slice());
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      const k = c.input;
      c.cmds.put(c.tick, k.buttons, k.select, k.pitch, k.yaw, 0);
      k.select = -1;
      game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      game.step();
    }
  };
  return { game, c, run };
}

const slot = (c, s) => c.player.ws.f[WS_SLOTS + s * 3];

// A standable spot inside bomb site `i` (hull center).
function siteSpot(game, i) {
  const b = game.bombSites.boxes[i], tr = new Trace();
  for (let x = b[0] + 24; x < b[3] - 24; x += 16) {
    for (let y = b[1] + 24; y < b[4] - 24; y += 16) {
      traceHull(game.world, HULL_POINT, x, y, b[5] - 1, x, y, b[2] - 64, tr);
      if (tr.startsolid || tr.fraction >= 1) continue;
      const z = tr.endz + 37;
      if (z - 36 <= b[5] && hullFits(game.world, HULL_STAND, x, y, z)) return [x, y, z];
    }
  }
  throw new Error('no spot in the bomb site');
}

function teleport(c, [x, y, z]) {
  const f = c.player.ps.f;
  f[PS_ORIGIN] = x;
  f[PS_ORIGIN + 1] = y;
  f[PS_ORIGIN + 2] = z;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
}

Deno.test({ name: 'demo: game_type 2 / game_mode 0 loads the demo with its cfg', ignore: !bsp, fn: () => {
  const readCfg = (name) => {
    try {
      return Deno.readTextFileSync(new URL(`../cfg/${name}`, import.meta.url));
    } catch {
      return null;
    }
  };
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_dust2'], readCfg, print: () => {} });
  host.con.exec('game_type 2; game_mode 0');
  host.start('de_dust2');
  const r = host.game.rules;
  assert.ok(r.demo && r.ignoreWinConditions && r.buyAnywhere && !r.giveC4 && r.freezeTime === 0);
  assert.equal(host.modeName, 'demo');
} });

Deno.test({ name: 'demo: alone, live at once; free buying anywhere; infinite ammo and grenades', ignore: !bsp, fn: () => {
  const { game, c, run } = setup();
  run(2);
  assert.equal(game.phase, PHASE_LIVE, 'no second team needed');
  assert.equal(game.round.mode & GAME_DEMO, GAME_DEMO, 'clients are told');
  const money = c.player.money;
  teleport(c, siteSpot(game, 1)); // far from the buy zone
  c.buy(WEAPON_ID.ak47);
  c.buy(WEAPON_ID.hegrenade);
  run(70);
  assert.equal(slot(c, SLOT_PRIMARY), WEAPON_ID.ak47, 'bought away from the buy zone');
  assert.equal(c.player.money, money, 'for free');
  c.player.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  c.input.buttons = IN_ATTACK;
  run(64);
  c.input.buttons = 0;
  run(2);
  assert.ok(c.shots > 5, `it fired (${c.shots} shots)`);
  assert.equal(c.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3 + 1], 30, 'the magazine stays full');
  // A grenade thrown comes back, in hand again.
  c.input.select = SLOT_GRENADE;
  run(64);
  c.input.buttons = IN_ATTACK;
  run(16);
  c.input.buttons = 0;
  run(16);
  assert.equal(game.grenades.count, 1, 'thrown');
  const he = GRENADE_IDS.indexOf(WEAPON_ID.hegrenade);
  assert.equal(c.player.ws.f[WS_GRENADES + he], 1, 'and still carried');
  assert.equal(c.player.ws.f[WS_ACTIVE], SLOT_GRENADE, 'up again');
} });

Deno.test({ name: 'demo: humans take the hit but never die, then heal; the kill command still kills', ignore: !bsp, fn: () => {
  const { game, c, run } = setup();
  run(2);
  c.player.health = 30;
  game.grenadeHurt(c, 80, WEAPON_ID.hegrenade, c.id, c.team);
  assert.equal(c.player.health, 1, 'down to 1');
  assert.ok(c.alive);
  run(64);
  assert.equal(c.player.health, 1, 'still hurt a second later');
  run(80);
  assert.equal(c.player.health, 100, 'healed after 2 s');
  game.clientCommand(c, 'kill');
  assert.ok(!c.alive, 'kill works');
} });

Deno.test({ name: 'demo: the player gets the bomb, plants and defuses it himself; the next one comes', ignore: !bsp, fn: () => {
  const { game, c, run } = setup({ c4Timer: 40 });
  run(4);
  assert.equal(game.bomb.state, BOMB_CARRIED);
  assert.equal(slot(c, SLOT_C4), WEAPON_ID.c4, 'the bomb is handed to the player');
  const spot = siteSpot(game, 0);
  teleport(c, spot);
  c.input.select = SLOT_C4;
  run(8);
  c.input.buttons = IN_ATTACK | IN_FORWARD;
  run(4 * 64);
  c.input.buttons = 0;
  assert.equal(game.bomb.state, BOMB_PLANTED);
  assert.equal(game.phase, PHASE_LIVE);
  c.input.pitch = 89; // straight down at it
  c.input.buttons = IN_USE;
  run(11 * 64);
  c.input.buttons = 0;
  assert.equal(game.bomb.state, BOMB_DEFUSED, 'a T defused it');
  assert.equal(game.phase, PHASE_LIVE, 'and the round goes on');
  run(3 * 64);
  assert.equal(game.bomb.state, BOMB_CARRIED, 'a new bomb');
  assert.equal(slot(c, SLOT_C4), WEAPON_ID.c4);
  // Planted and left: it blows up, the player lives, and the next one comes.
  c.input.select = SLOT_C4;
  run(8);
  c.input.pitch = 0;
  c.input.buttons = IN_ATTACK | IN_FORWARD;
  run(4 * 64);
  c.input.buttons = 0;
  assert.equal(game.bomb.state, BOMB_PLANTED);
  run(41 * 64);
  assert.equal(game.bomb.state, BOMB_EXPLODED);
  assert.ok(c.alive, 'standing on it, and alive');
  run(3 * 64);
  assert.equal(game.bomb.state, BOMB_CARRIED);
} });
