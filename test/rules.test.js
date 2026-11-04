// Game rules in the corners an audit found them wrong: a shot and the C4 in one tick, a draw
// in a decided match, the dead after a team empties, a planter who left, a picked-up silenced
// gun. On de_playground, so no Valve map is needed.
import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_ATTACK, IN_USE } from '../shared/constants.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PHASE_LIVE, PHASE_OVER, PHASE_WARMUP, ROUND_FINAL, END_ELIMINATION, END_DRAW } from '../shared/economy.js';
import { Writer, CmdRing, writeHello, writeCmds, NO_MVP } from '../shared/protocol.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import {
  giveWeapon, silenced, WEAPON_ID, WS_ACTIVE, WS_SLOTS, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_C4,
} from '../shared/weapons.js';
import { Game } from '../server/game.js';

const bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url)).buffer);

function setup(rules) {
  const log = console.log;
  console.log = () => {};
  const game = new Game('de_playground', bsp, rules);
  console.log = log;
  const w = new Writer();
  const join = (name, team) => {
    const c = game.connect({ send() {}, close() {} });
    game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    return c;
  };
  const send = (c, buttons = 0, yaw = 0) => {
    c.cmds.put(c.tick, buttons, -1, 0, yaw, 0);
    game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
  };
  const run = (ticks, players, buttons = 0) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of players) if (game.clients[c.id] === c) send(c, buttons);
      game.step();
    }
  };
  return { game, join, send, run };
}

const quietly = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

// Fire held and E pressed in a site: the rifle fired, then the C4 came out, and the bullet
// was traced with the C4's stats: NaN damage, a CT at NaN health, dead with no kill.
Deno.test('a shot in the tick E takes out the C4 is the rifle\'s', () => quietly(() => {
  const { game, join, send, run } = setup({ freezeTime: 0.1, roundTime: 600 });
  const t = join('t', TEAM_T), ct = join('ct', TEAM_CT);
  run(20, [t, ct]);
  const b = game.bombSites.boxes[0], cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, floor = game.floorBelow(cx, cy, b[2] + 60);
  const tf = t.player.ps.f, cf = ct.player.ps.f;
  [tf[PS_ORIGIN], tf[PS_ORIGIN + 1], tf[PS_ORIGIN + 2]] = [cx, cy, floor + 37];
  [cf[PS_ORIGIN], cf[PS_ORIGIN + 1], cf[PS_ORIGIN + 2]] = [cx + 120, cy, floor + 37];
  giveWeapon(t.player.ws, WEAPON_ID.ak47);
  t.player.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  if (!t.player.ws.f[WS_SLOTS + SLOT_C4 * 3]) {
    giveWeapon(t.player.ws, WEAPON_ID.c4);
    game.bombCarrier = t;
    game.bomb.state = 1;
  }
  run(80, [t, ct]);
  send(t, IN_ATTACK | IN_USE);
  send(ct);
  game.step();
  assert.equal(t.player.ws.f[WS_ACTIVE], SLOT_C4, 'E took the C4 out');
  assert.ok(Number.isFinite(ct.player.health), `health ${ct.player.health}`);
  assert.ok(ct.player.health < 100, 'the AK hit');
}));

// Draws happen (both sides dead, or time out on a map with no objective): a lead after all
// the rounds went to overtime, where the leader could lose.
Deno.test('a lead after all the rounds wins the match, draws or not', () => quietly(() => {
  const { game, join, run } = setup({ freezeTime: 0.1, roundTime: 600, roundEndDelay: 0.1, maxRounds: 4 });
  const players = [join('t', TEAM_T), join('ct', TEAM_CT)];
  run(2, players);
  const rounds = [[TEAM_T, END_ELIMINATION], [TEAM_CT, END_ELIMINATION], [0, END_DRAW], [TEAM_T, END_ELIMINATION]];
  for (let i = 0; i < rounds.length; i++) {
    while (game.phase !== PHASE_LIVE) run(1, players);
    game.endRound(...rounds[i]);
    assert.equal((game.round.info & ROUND_FINAL) !== 0, i === 3, `round ${i + 1}: the last one ends the match`);
    if (i < 3) while (game.phase === PHASE_OVER) run(1, players);
  }
  assert.deepEqual([game.round.scoreT, game.round.scoreCT], [2, 1]);
  while (game.phase === PHASE_OVER) run(1, players);
  assert.equal(game.overtime, 0, 'no overtime');
}));

// The last CT leaving sends the game back to warmup; the Ts killed in the live round waited
// for a next round that never came.
Deno.test('the dead respawn when a team empties out', () => quietly(() => {
  const { game, join, run } = setup({ freezeTime: 0.1, roundTime: 600 });
  const t1 = join('t1', TEAM_T), t2 = join('t2', TEAM_T), ct = join('ct', TEAM_CT);
  run(20, [t1, t2, ct]);
  game.kill(ct, t1, WEAPON_ID.usp_silencer, false);
  game.disconnect(ct);
  run(5 * 64, [t1, t2]);
  assert.equal(game.phase, PHASE_WARMUP);
  assert.ok(t1.alive);
}));

// A client that left kept `joined`, so the checks for "still here" passed: the planter's
// replacement in his slot was MVP of the Ts' win, and the demo's next bomb went to nobody.
Deno.test('a planter who left is no longer the planter', () => quietly(() => {
  {
    const { game, join, run } = setup({ freezeTime: 0.1, roundTime: 600, roundEndDelay: 1 });
    const t1 = join('planter', TEAM_T), t2 = join('t2', TEAM_T), ct = join('ct', TEAM_CT);
    run(20, [t1, t2, ct]);
    game.bombCarrier = t1;
    game.plantBomb(t1);
    game.disconnect(t1);
    const newcomer = join('newcomer', TEAM_CT);
    assert.equal(newcomer.id, t1.id, 'the newcomer takes the slot');
    game.explodeTick = game.tick + 1;
    run(3, [t2, ct, newcomer]);
    assert.equal(game.round.mvp, NO_MVP);
  }
  {
    const { game, join, run } = setup({ demo: true, ignoreWinConditions: true, respawnT: true, respawnCT: true, freezeTime: 0, giveC4: false });
    const a = join('a', TEAM_T), b = join('b', TEAM_CT);
    run(5, [a, b]);
    game.bombCarrier = a;
    game.plantBomb(a);
    game.disconnect(a);
    game.explodeTick = game.tick + 1;
    run(4 * 64, [b]);
    assert.ok(b.player.ws.f[WS_SLOTS + SLOT_C4 * 3] > 0, 'the next bomb goes to the one left');
  }
}));

// A gun from the ground is given like a bought one: a dropped M4A1-S or USP-S came back
// without its silencer (other stats, and it showed the shooter on the radar).
Deno.test('a silenced gun picked up keeps its silencer', () => quietly(() => {
  const { game, join, run } = setup({ freezeTime: 0.1, roundTime: 600 });
  const t = join('t', TEAM_T), ct = join('ct', TEAM_CT);
  run(20, [t, ct]);
  const f = ct.player.ws.f, p = ct.player.ps.f;
  giveWeapon(ct.player.ws, WEAPON_ID.hkp2000); // a pistol with no silencer, then none
  f[WS_SLOTS + SLOT_SECONDARY * 3] = 0;
  game.items.add(WEAPON_ID.usp_silencer, 12, 24, p[PS_ORIGIN], p[PS_ORIGIN + 1], p[PS_ORIGIN + 2] - 36, 0);
  game.updateItems();
  assert.equal(f[WS_SLOTS + SLOT_SECONDARY * 3], WEAPON_ID.usp_silencer);
  assert.equal(f[WS_SLOTS + SLOT_SECONDARY * 3 + 1], 12, 'its own clip');
  assert.ok(silenced(ct.player.ws, SLOT_SECONDARY));
}));
