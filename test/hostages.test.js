import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_USE, IN_ATTACK, TICK_RATE } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { traceHull, hullFits, Trace, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { HS_IDLE, HS_CARRIED, HS_RESCUED, HS_DEAD, HOSTAGES_PER_ROUND, PICKUP_TIME, CARRY_SPEED } from '../shared/hostages.js';
import { PHASE_LIVE, PHASE_OVER, END_RESCUE, RESCUE_REWARD, HOSTAGE_KILL_PENALTY } from '../shared/economy.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
import { Game } from '../server/game.js';

let bsp = null;
try {
  bsp = parseBSP(Deno.readFileSync(new URL('../maps/cs_office.bsp', import.meta.url)).buffer);
} catch { /* map-dependent tests skip */ }

function setup() {
  const game = new Game('cs_office', bsp, { freezeTime: 1, roundTime: 60, buyTime: 1, roundEndDelay: 1 });
  const w = new Writer();
  const players = {};
  for (const [name, team] of [['ct', TEAM_CT], ['t', TEAM_T]]) {
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

function teleport(c, x, y, z) {
  const f = c.player.ps.f;
  f[PS_ORIGIN] = x;
  f[PS_ORIGIN + 1] = y;
  f[PS_ORIGIN + 2] = z;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
}

// Stand `c` 50 units from hostage k, looking at its chest.
function faceHostage(game, c, k) {
  const h = game.hostages;
  for (let a = 0; a < 360; a += 30) {
    const r = a * Math.PI / 180, x = h.x[k] + Math.cos(r) * 50, y = h.y[k] + Math.sin(r) * 50, z = h.z[k] + 37;
    if (!hullFits(game.world, HULL_STAND, x, y, z)) continue;
    teleport(c, x, y, z);
    c.input.yaw = (a + 180) % 360;
    c.input.pitch = 20;
    return;
  }
  throw new Error('no room next to the hostage');
}

// A standable spot inside the first rescue zone.
function rescueSpot(game) {
  const tr = new Trace();
  for (const b of game.rescue.boxes) {
    for (let x = b[0] + 20; x < b[3] - 20; x += 16) {
      for (let y = b[1] + 20; y < b[4] - 20; y += 16) {
        traceHull(game.world, HULL_POINT, x, y, b[5] - 1, x, y, b[2] - 64, tr);
        if (tr.startsolid || tr.fraction >= 1) continue;
        const z = tr.endz + 37;
        if (z <= b[5] && z >= b[2] && hullFits(game.world, HULL_STAND, x, y, z)) return [x, y, z];
      }
    }
  }
  throw new Error('no spot in a rescue zone');
}

Deno.test({ name: 'hostages: two per round; hold E to carry one (slower); a rescue wins the round', ignore: !bsp, fn: () => {
  const { game, players: { ct }, run, live } = setup();
  run(2);
  live();
  const h = game.hostages;
  assert.equal(h.count, HOSTAGES_PER_ROUND);
  assert.ok(game.rescue.boxes.length > 0);
  assert.equal(h.state[0], HS_IDLE);

  faceHostage(game, ct, 0);
  ct.input.buttons = IN_USE;
  run(Math.round(PICKUP_TIME * TICK_RATE / 2));
  assert.equal(h.state[0], HS_IDLE, 'not yet');
  assert.ok(ct.useProgress > 0.3 && ct.useProgress < 0.7);
  run(Math.round(PICKUP_TIME * TICK_RATE / 2) + 2);
  assert.equal(h.state[0], HS_CARRIED);
  assert.equal(h.carrier[0], ct.id);
  assert.ok(ct.player.carrying);
  ct.input.buttons = 0;

  // Carrying slows him down.
  ct.input.buttons = 8; // IN_FORWARD
  run(64);
  const f = ct.player.ps.f;
  assert.ok(Math.hypot(f[PS_VEL], f[PS_VEL + 1]) <= CARRY_SPEED + 0.5, 'at most the carry speed');
  ct.input.buttons = 0;

  const money = ct.player.money;
  teleport(ct, ...rescueSpot(game));
  run(2);
  assert.equal(h.state[0], HS_RESCUED);
  assert.equal(game.phase, PHASE_OVER);
  assert.equal(game.round.info, TEAM_CT | (END_RESCUE << 2), 'CTs win by rescue');
  assert.ok(ct.player.money >= money + RESCUE_REWARD);
} });

Deno.test({ name: 'hostages: a dead carrier drops his hostage; shooting one costs money', ignore: !bsp, fn: () => {
  const { game, players: { ct, t }, run, live } = setup();
  run(2);
  live();
  const h = game.hostages;
  faceHostage(game, ct, 0);
  ct.input.buttons = IN_USE;
  run(Math.round(PICKUP_TIME * TICK_RATE) + 2);
  ct.input.buttons = 0;
  assert.equal(h.state[0], HS_CARRIED);
  const where = [...ct.player.ps.f.subarray(PS_ORIGIN, PS_ORIGIN + 2)];
  game.kill(t, ct, 0, false);
  assert.equal(h.state[0], HS_IDLE);
  assert.ok(Math.hypot(h.x[0] - where[0], h.y[0] - where[1]) < 1, 'where he died');

  // T empties a gun into hostage 1 (after the round-win money for the kill).
  run(2);
  faceHostage(game, t, 1);
  t.input.pitch = 10;
  const money = t.player.money;
  t.input.buttons = IN_ATTACK;
  for (let i = 0; i < 200 && h.state[1] !== HS_DEAD; i++) {
    run(1);
    t.input.buttons ^= IN_ATTACK; // pistol: a press per shot
  }
  assert.equal(h.state[1], HS_DEAD);
  assert.ok(t.player.money <= Math.max(0, money - HOSTAGE_KILL_PENALTY), `paid for it (never below $0): ${money} -> ${t.player.money}`);
} });
