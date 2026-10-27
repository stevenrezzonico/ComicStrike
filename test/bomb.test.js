import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_ATTACK, IN_USE, IN_DROP, IN_FORWARD } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { traceHull, hullFits, Trace, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { WEAPON_ID, WS_SLOTS, WS_ACTION, SLOT_C4, ACTION_PLANT, ACTION_DEFUSE } from '../shared/weapons.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  BombSites, bombDamage, PLANT_TIME, BOMB_CARRIED, BOMB_DROPPED, BOMB_PLANTED, BOMB_DEFUSED, BOMB_EXPLODED,
} from '../shared/bomb.js';
import {
  PHASE_LIVE, PHASE_OVER, START_MONEY, WIN_REWARD, BOMB_WIN_REWARD, PLANT_REWARD, DEFUSE_REWARD, PLANT_LOSS_BONUS,
  END_BOMB, END_DEFUSE, lossBonus,
} from '../shared/economy.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
import { Game } from '../server/game.js';

async function loadDust2(t) {
  try {
    return parseBSP((await Deno.readFile(new URL('../maps/de_dust2.bsp', import.meta.url))).buffer);
  } catch {
    await t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });
    return null;
  }
}

// A game with players joined by name -> team; each tick every player sends its `input`.
function setup(bsp, teams, rules = {}) {
  const game = new Game('de_dust2', bsp, { freezeTime: 1, roundTime: 60, buyTime: 1, roundEndDelay: 1, ...rules });
  const w = new Writer();
  const players = {};
  for (const [name, team] of Object.entries(teams)) {
    const c = game.connect({ send() {}, close() {} });
    game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    c.input = { buttons: 0, select: -1, pitch: 0, yaw: 0 };
    players[name] = c;
  }
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of Object.values(players)) {
        const k = c.input;
        c.cmds.put(c.tick, k.buttons, k.select, k.pitch, k.yaw, 0);
        k.select = -1;
        game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      game.step();
    }
  };
  const live = () => {
    while (game.phase !== PHASE_LIVE) run(1);
  };
  return { game, players, run, live };
}

// A standable spot inside bomb site `i`: [x, y, z of the hull center].
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

const slotId = (c, slot) => c.player.ws.f[WS_SLOTS + slot * 3];

// Live round, the T at bomb site A with the C4 in hand.
function readyToPlant(bsp, rules) {
  const s = setup(bsp, { terro: TEAM_T, ceetee: TEAM_CT }, rules);
  const { game, players: { terro }, run, live } = s;
  live();
  s.spot = siteSpot(game, 0);
  teleport(terro, s.spot);
  terro.input.select = SLOT_C4;
  run(70); // land, draw the C4 (1 s)
  return s;
}

function plant(s) {
  const { game, players: { terro }, run } = s;
  terro.input.buttons = IN_ATTACK;
  run(PLANT_TIME * 64 + 2);
  terro.input.buttons = 0;
  assert.equal(game.bomb.state, BOMB_PLANTED);
}

Deno.test('bomb blast: CS:GO gaussian falloff out to 3.5 x the bomb radius', () => {
  assert.equal(bombDamage(500, 0), 500);
  assert.ok(Math.abs(bombDamage(500, 1750) - 500 * Math.exp(-4.5)) < 1e-9);
  assert.equal(bombDamage(500, 1751), 0);
  assert.ok(bombDamage(500, 500) > 340 && bombDamage(500, 500) < 350);
});

Deno.test('planting: one T carries the C4, plants in a site in 3 s rooted in place; the bomb wins the round', async (t) => {
  const bsp = await loadDust2(t);
  if (!bsp) return;
  assert.equal(new BombSites(bsp).count, 2);
  const s = setup(bsp, { terro: TEAM_T, ceetee: TEAM_CT }, { c4Timer: 3 });
  const { game, players: { terro, ceetee }, run, live } = s;
  run(1);
  assert.equal(game.bomb.state, BOMB_CARRIED);
  assert.equal(game.bombCarrier, terro);
  assert.equal(slotId(terro, SLOT_C4), WEAPON_ID.c4);
  assert.equal(slotId(ceetee, SLOT_C4), 0);

  live();
  terro.input.select = SLOT_C4;
  terro.input.buttons = IN_ATTACK;
  run(64 * 5);
  assert.equal(game.bomb.state, BOMB_CARRIED, 'not in a bomb site: nothing happens');
  assert.equal(terro.player.ws.f[WS_ACTION], 0);

  teleport(terro, siteSpot(game, 0));
  terro.input.buttons = 0;
  run(8);
  terro.input.buttons = IN_ATTACK | IN_FORWARD;
  run(32); // the first tick's step slides to a stop
  assert.equal(terro.player.ws.f[WS_ACTION], ACTION_PLANT);
  const x = terro.player.ps.f[PS_ORIGIN];
  run(PLANT_TIME * 64 - 38);
  assert.equal(game.bomb.state, BOMB_CARRIED, 'still arming');
  assert.equal(terro.player.ps.f[PS_ORIGIN], x, 'planting roots the player');
  run(10);
  assert.equal(game.bomb.state, BOMB_PLANTED);
  assert.equal(slotId(terro, SLOT_C4), 0, 'the C4 left the inventory');
  assert.equal(terro.player.money, START_MONEY + PLANT_REWARD);
  assert.ok(Math.abs(game.bomb.x - x) < 1 && game.bomb.ticksLeft > 0);

  game.kill(ceetee, terro, WEAPON_ID.usp_silencer, false);
  run(1);
  assert.equal(game.phase, PHASE_LIVE, 'all Ts dead after the plant: the CTs still have to defuse');
  run(3 * 64);
  assert.equal(game.bomb.state, BOMB_EXPLODED);
  assert.equal(game.phase, PHASE_OVER);
  assert.equal(game.round.info, TEAM_T | (END_BOMB << 2));
  assert.equal(terro.player.money, START_MONEY + PLANT_REWARD + BOMB_WIN_REWARD);
});

Deno.test('defusing: a CT on the bomb, looking at it, holds use for 10 s; the Ts keep their plant bonus', async (t) => {
  const bsp = await loadDust2(t);
  if (!bsp) return;
  const s = readyToPlant(bsp, { c4Timer: 15 });
  const { game, players: { terro, ceetee }, run } = s;
  plant(s);
  teleport(ceetee, s.spot);
  run(8);
  ceetee.input.pitch = 89; // straight down at it
  ceetee.input.buttons = IN_USE | IN_FORWARD;
  run(32);
  assert.equal(ceetee.player.ws.f[WS_ACTION], ACTION_DEFUSE);
  const x = ceetee.player.ps.f[PS_ORIGIN];
  run(10 * 64 - 38);
  assert.equal(game.bomb.state, BOMB_PLANTED, 'not yet');
  assert.equal(ceetee.player.ps.f[PS_ORIGIN], x, 'defusing roots the player');
  run(10);
  assert.equal(game.bomb.state, BOMB_DEFUSED);
  assert.equal(game.round.info, TEAM_CT | (END_DEFUSE << 2));
  assert.equal(ceetee.player.money, START_MONEY + DEFUSE_REWARD + BOMB_WIN_REWARD);
  assert.equal(terro.player.money, START_MONEY + PLANT_REWARD + lossBonus(1) + PLANT_LOSS_BONUS);
  assert.ok(WIN_REWARD < BOMB_WIN_REWARD);
});

Deno.test('defusing with a kit takes 5 s; letting go of use starts over', async (t) => {
  const bsp = await loadDust2(t);
  if (!bsp) return;
  const s = readyToPlant(bsp, { c4Timer: 30 });
  const { game, players: { ceetee }, run } = s;
  plant(s);
  ceetee.player.defuser = true;
  teleport(ceetee, s.spot);
  run(8);
  ceetee.input.pitch = 89;
  ceetee.input.buttons = IN_USE;
  run(4 * 64);
  ceetee.input.buttons = 0;
  run(2);
  assert.equal(ceetee.player.ws.f[WS_ACTION], 0);
  ceetee.input.buttons = IN_USE;
  run(4 * 64);
  assert.equal(game.bomb.state, BOMB_PLANTED, 'restarted from zero');
  run(64 + 4);
  assert.equal(game.bomb.state, BOMB_DEFUSED);
});

Deno.test('the bomb drops when thrown (G) or when its carrier dies; another T picks it up', async (t) => {
  const bsp = await loadDust2(t);
  if (!bsp) return;
  const { game, players, run, live } = setup(bsp, { a: TEAM_T, b: TEAM_T, ceetee: TEAM_CT });
  live();
  const carrier = game.bombCarrier, other = carrier === players.a ? players.b : players.a;
  carrier.input.select = SLOT_C4;
  run(70);
  carrier.input.buttons = IN_DROP;
  run(1);
  carrier.input.buttons = 0;
  assert.equal(game.bomb.state, BOMB_DROPPED);
  assert.equal(slotId(carrier, SLOT_C4), 0);
  const d = Math.hypot(game.bomb.x - carrier.player.ps.f[PS_ORIGIN], game.bomb.y - carrier.player.ps.f[PS_ORIGIN + 1]);
  assert.ok(d > 20, `thrown ahead (${d.toFixed(0)} units)`);

  teleport(other, [game.bomb.x, game.bomb.y, game.bomb.z + 37]);
  run(70);
  assert.equal(game.bomb.state, BOMB_CARRIED);
  assert.equal(game.bombCarrier, other);
  assert.equal(slotId(other, SLOT_C4), WEAPON_ID.c4);

  game.kill(players.ceetee, other, WEAPON_ID.usp_silencer, false);
  assert.equal(game.bomb.state, BOMB_DROPPED, 'dropped where the carrier died');
  assert.ok(Math.hypot(game.bomb.x - other.player.ps.f[PS_ORIGIN], game.bomb.y - other.player.ps.f[PS_ORIGIN + 1]) < 1);
  teleport(players.ceetee, [game.bomb.x, game.bomb.y, game.bomb.z + 37]);
  run(2);
  assert.equal(game.bomb.state, BOMB_DROPPED, 'CTs cannot pick it up');
});
