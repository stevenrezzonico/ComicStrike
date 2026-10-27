import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_FORWARD } from '../shared/constants.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { WEAPON_ID, WS_SLOTS, SLOT_PRIMARY, SLOT_SECONDARY } from '../shared/weapons.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  PHASE_WARMUP, PHASE_FREEZE, PHASE_LIVE, PHASE_OVER, START_MONEY, WIN_REWARD, LOSS_BONUS, END_ELIMINATION,
  END_TIME, ITEM_KEVLAR, ITEM_ASSAULTSUIT, MAX_ROUNDS, lossBonus,
} from '../shared/economy.js';
import { Writer, CmdRing, writeHello, writeCmds, writeBuy } from '../shared/protocol.js';
import { Game } from '../server/game.js';

const RULES = { freezeTime: 1, roundTime: 3, buyTime: 1, roundEndDelay: 1 }; // seconds

async function setup(t) {
  let bsp;
  try {
    bsp = parseBSP((await Deno.readFile(new URL('../maps/de_dust2.bsp', import.meta.url))).buffer);
  } catch {
    await t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });
    return null;
  }
  const game = new Game('de_dust2', bsp, RULES);
  const w = new Writer();
  const join = (name, team) => {
    const c = game.connect({ send() {}, close() {} });
    game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    c.buyId = 0;
    return c;
  };
  const t1 = join('terro', TEAM_T);
  const ct = join('ceetee', TEAM_CT);
  // Each tick both players hold `buttons` (commands delivered as a client would).
  const run = (ticks, buttons = 0) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of [t1, ct]) {
        c.cmds.put(c.tick, buttons, -1, 0, 0, 0);
        game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      game.step();
    }
  };
  const buy = (c, item) => game.receive(c, writeBuy(w, ++c.buyId, item).slice());
  return { game, t1, ct, run, buy };
}

const slotId = (c, slot) => c.player.ws.f[WS_SLOTS + slot * 3];

Deno.test('rounds: freeze, live, elimination, CS:GO money, survivors keep their gear', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { game, t1, ct, run } = s;
  run(1);
  assert.equal(game.phase, PHASE_FREEZE, 'both teams present: the match starts');
  assert.equal(t1.player.money, START_MONEY);
  assert.equal(slotId(t1, SLOT_PRIMARY), 0, 'pistol round: no rifle');
  assert.equal(slotId(t1, SLOT_SECONDARY), WEAPON_ID.glock);

  const x0 = t1.player.ps.f[PS_ORIGIN];
  run(32, IN_FORWARD);
  assert.equal(t1.player.ps.f[PS_ORIGIN], x0, 'frozen players cannot move');
  run(40, IN_FORWARD);
  assert.equal(game.phase, PHASE_LIVE);
  assert.notEqual(t1.player.ps.f[PS_ORIGIN], x0, 'moving once live');

  game.kill(ct, t1, WEAPON_ID.usp_silencer, true);
  run(1);
  assert.equal(game.phase, PHASE_OVER);
  assert.equal(game.round.scoreCT, 1);
  assert.equal(game.round.info, TEAM_CT | (END_ELIMINATION << 2));
  assert.equal(ct.player.money, START_MONEY + 300 + WIN_REWARD); // USP kill award + win
  assert.equal(t1.player.money, START_MONEY + LOSS_BONUS);
  assert.equal(ct.player.kills, 1);
  assert.equal(t1.player.deaths, 1);

  ct.player.armor = 57; // survivor's state carries over
  run(65);
  assert.equal(game.phase, PHASE_FREEZE, 'next round');
  assert.equal(game.round.round, 2);
  assert.equal(t1.player.health, 100, 'the dead come back');
  assert.equal(ct.player.armor, 57, 'survivors keep armor');
});

Deno.test('buying: zone, time, team, price; kevlar then the helmet upgrade', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { game, t1, ct, run, buy } = s;
  run(1);
  assert.ok(t1.canBuy, 'in the T spawn during freeze');
  buy(ct, WEAPON_ID.ak47);
  assert.equal(slotId(ct, SLOT_PRIMARY), 0, 'CTs cannot buy the AK');
  buy(t1, WEAPON_ID.ak47);
  assert.equal(slotId(t1, SLOT_PRIMARY), 0, 'not enough money for an AK');
  buy(t1, ITEM_KEVLAR);
  assert.equal(t1.player.armor, 100);
  assert.equal(t1.player.money, START_MONEY - 650);
  t1.player.money = 1000;
  buy(t1, ITEM_ASSAULTSUIT);
  assert.ok(t1.player.helmet);
  assert.equal(t1.player.money, 1000 - 350, 'helmet only, the vest was full');
  const before = t1.player.money;
  game.receive(t1, writeBuy(new Writer(), t1.buyId, WEAPON_ID.p250).slice()); // a resend of the same BUY id
  assert.equal(t1.player.money, before, 'a repeated BUY is ignored');

  run(64 + 64 + 2); // freeze (1 s) + buy time (1 s) over
  assert.equal(game.phase, PHASE_LIVE);
  assert.ok(!t1.canBuy, 'buy time is over');
  t1.player.money = 5000;
  buy(t1, WEAPON_ID.deagle);
  assert.equal(slotId(t1, SLOT_SECONDARY), WEAPON_ID.glock);
});

Deno.test('time runs out on a bomb map: CTs win; the loss bonus climbs', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { game, t1, run } = s;
  run(1 + 64 + 3 * 64 + 2);
  assert.equal(game.phase, PHASE_OVER);
  assert.equal(game.round.info, TEAM_CT | (END_TIME << 2));
  assert.equal(t1.player.money, START_MONEY + lossBonus(1));
  run(64 + 64 + 3 * 64 + 2); // a second loss
  assert.equal(t1.player.money, START_MONEY + lossBonus(1) + lossBonus(2));
  assert.equal(lossBonus(2), 1900);
  assert.equal(lossBonus(9), 3400);
});

Deno.test('halftime after round 15 swaps the teams and resets money', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { game, t1, ct, run } = s;
  run(1 + 64 + 2); // through the freeze
  assert.equal(game.phase, PHASE_LIVE);
  game.roundsPlayed = MAX_ROUNDS / 2 - 1;
  game.round.scoreCT = 9;
  game.kill(ct, t1, WEAPON_ID.usp_silencer, false);
  run(1 + 64 + 2);
  assert.equal(game.phase, PHASE_FREEZE);
  assert.equal(t1.team, TEAM_CT);
  assert.equal(ct.team, TEAM_T);
  assert.equal(game.round.scoreT, 10, 'the old CT score moved with them');
  assert.equal(t1.player.money, START_MONEY);
  assert.equal(slotId(ct, SLOT_SECONDARY), WEAPON_ID.glock, 'new side, new pistol');
});

Deno.test('back to warmup when a team empties', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { game, ct, run } = s;
  run(1);
  game.disconnect(ct);
  run(1);
  assert.equal(game.phase, PHASE_WARMUP);
});
