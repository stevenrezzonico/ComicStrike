import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_ATTACK, TICK_RATE } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { hullFits, HULL_STAND } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { WEAPON_ID, WS_SLOTS, SLOT_PRIMARY } from '../shared/weapons.js';
import {
  PHASE_WARMUP, PHASE_LIVE, PHASE_OVER, END_MATCH, GAME_FFA, GAME_DM, DM_KILL_POINTS, DM_RESPAWN,
} from '../shared/economy.js';
import { Writer, CmdRing, writeHello, writeCmds, writeBuy } from '../shared/protocol.js';
import { Host } from '../server/host.js';

const maps = {};
function loadMap(name) {
  if (!maps[name]) maps[name] = parseBSP(Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url)).buffer);
  return maps[name];
}
const readCfg = (name) => {
  try {
    return Deno.readTextFileSync(new URL(`../cfg/${name}`, import.meta.url));
  } catch {
    return null;
  }
};
let haveMap = true;
try {
  loadMap('de_dust2');
} catch {
  haveMap = false;
}

// A deathmatch server on de_dust2 (the real cfg/gamemode_deathmatch.cfg), with `rules`
// overriding it (tests: no spawn protection unless asked).
function setup(rules = { immunityTime: 0 }) {
  const host = new Host({ loadMap, listMaps: () => ['de_dust2'], readCfg, print: () => {}, rules, defer: (fn) => fn() });
  host.con.exec('game_type 1; game_mode 2');
  host.start('de_dust2');
  const w = new Writer();
  const clients = [];
  let buyId = 0;
  const join = (name, team) => {
    const c = host.game.connect({ send() {}, close() {} });
    host.game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    c.input = { buttons: 0, pitch: 0, yaw: 0 };
    c.buy = (item) => host.game.receive(c, writeBuy(w, ++buyId, item).slice());
    clients.push(c);
    return c;
  };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of clients) {
        const k = c.input;
        c.cmds.put(c.tick, k.buttons, -1, k.pitch, k.yaw, 0);
        host.game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      host.game.step();
    }
  };
  const live = () => {
    for (let i = 0; i < 64 * 5 && host.game.phase !== PHASE_LIVE; i++) run(1);
    assert.equal(host.game.phase, PHASE_LIVE);
  };
  return { host, join, run, live };
}

function teleport(c, x, y, z) {
  const f = c.player.ps.f;
  f[PS_ORIGIN] = x;
  f[PS_ORIGIN + 1] = y;
  f[PS_ORIGIN + 2] = z;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
}

// `shooter` 120 units west of `target` on open ground, aiming at its chest.
function lineUp(game, shooter, target) {
  for (const s of game.spawns[TEAM_CT]) {
    const [x, y, z] = s;
    if (!hullFits(game.world, HULL_STAND, x - 120, y, z)) continue;
    teleport(target, x, y, z);
    teleport(shooter, x - 120, y, z);
    shooter.input.yaw = 0;
    shooter.input.pitch = 8;
    target.input.yaw = 180;
    return;
  }
  throw new Error('no open spawn');
}

// Holds the trigger (a tap per tick pair, for pistols) until `done()` or `ticks` pass.
function fireUntil(run, c, done, ticks = 300) {
  for (let i = 0; i < ticks && !done(); i++) {
    c.input.buttons = i & 1 ? 0 : IN_ATTACK;
    run(1);
  }
  c.input.buttons = 0;
}

Deno.test({ name: 'deathmatch: game_type 1 / game_mode 2 load the mode cfg; back to competitive resets it', ignore: !haveMap, fn: () => {
  const { host } = setup();
  const r = host.game.rules;
  assert.equal(host.modeName, 'deathmatch');
  assert.ok(r.deathmatch && r.teammatesAreEnemies && r.respawnT && r.respawnCT && r.randomSpawn);
  assert.equal(r.timeLimit, 600, 'mp_timelimit 10');
  assert.ok(!r.giveC4 && r.hostagesMax === 0 && r.freeArmor && r.buyAnywhere);
  assert.equal(host.info().mode, 'deathmatch');
  host.con.exec('game_type 0; game_mode 1; map de_dust2');
  const c = host.game.rules;
  assert.equal(host.modeName, 'competitive');
  assert.ok(!c.deathmatch && !c.teammatesAreEnemies && !c.respawnT && !c.randomSpawn && c.giveC4);
  assert.equal(c.roundTime, 115);
} });

Deno.test({ name: 'deathmatch: free for all, points for kills, respawn after 2 s, no bomb, free armor', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_T); // same team: still enemies
  run(2);
  assert.notEqual(host.game.phase, PHASE_WARMUP, 'two players are enough in free for all');
  live();
  const g = host.game;
  assert.equal(g.round.mode, GAME_FFA | GAME_DM);
  assert.equal(g.bombCarrier, null, 'mp_give_player_c4 0');
  assert.equal(a.player.armor, 100);
  assert.ok(a.player.helmet, 'mp_free_armor');
  const money = a.player.money;
  lineUp(g, a, b);
  fireUntil(run, a, () => !b.alive);
  assert.ok(!b.alive, 'a teammate died: teammates are enemies');
  assert.equal(a.kills, 1);
  assert.equal(a.score, DM_KILL_POINTS);
  assert.equal(a.player.money, money, 'no kill money in deathmatch');
  run(DM_RESPAWN * TICK_RATE + 1);
  assert.ok(b.alive, 'respawned');
  assert.equal(g.phase, PHASE_LIVE, 'deaths never end the round');
} });

Deno.test({ name: 'deathmatch: weapons are free, anywhere, and come back after death', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2);
  live();
  const money = a.player.money;
  a.buy(WEAPON_ID.awp);
  run(1);
  assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp);
  assert.equal(a.player.money, money, 'free');
  assert.equal(host.game.items.count, 0, 'the replaced rifle is not dropped');
  host.game.kill(b, a, 0, false);
  run(DM_RESPAWN * TICK_RATE + 1);
  assert.ok(a.alive);
  assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp, 'the AWP again');
  run(16 * TICK_RATE);
  a.buy(WEAPON_ID.ak47);
  run(1);
  assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp, 'mp_buytime after the spawn is over');
} });

Deno.test({ name: 'deathmatch: spawn protection until the time runs out or he shoots', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup({ immunityTime: 4 });
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2);
  live();
  lineUp(host.game, a, b);
  b.immuneUntil = host.game.tick + 4 * TICK_RATE; // as if just spawned
  fireUntil(run, a, () => b.player.health < 100, 64);
  assert.equal(b.player.health, 100, 'protected');
  b.input.buttons = IN_ATTACK; // he shoots: protection ends
  run(1);
  b.input.buttons = 0;
  run(1);
  fireUntil(run, a, () => b.player.health < 100);
  assert.ok(b.player.health < 100);
} });

Deno.test({ name: 'deathmatch: random spawns keep away from enemies', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_T);
  run(2);
  live();
  const g = host.game;
  const [x, y, z] = g.spawns[TEAM_T][0];
  teleport(a, x, y, z); // a camps the T spawn
  for (let i = 0; i < 10; i++) {
    g.kill(a, b, 0, false);
    run(DM_RESPAWN * TICK_RATE + 1);
    const f = b.player.ps.f;
    assert.ok(Math.hypot(f[PS_ORIGIN] - x, f[PS_ORIGIN + 1] - y) > 1500, 'b respawns on the far side (CT spawn)');
  }
} });

Deno.test({ name: 'deathmatch: the time limit ends the match, the top score wins, a new match follows', ignore: !haveMap, fn: () => {
  const { host, join, run, live } = setup({ immunityTime: 0, timeLimit: 3, matchRestartDelay: 2 });
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2);
  live();
  const g = host.game;
  g.kill(a, b, 0, false);
  assert.equal(a.score, DM_KILL_POINTS);
  run(3 * TICK_RATE + 1);
  assert.equal(g.phase, PHASE_OVER);
  assert.equal(g.round.info >> 2, END_MATCH);
  run(2 * TICK_RATE + 2);
  assert.notEqual(g.phase, PHASE_OVER, 'next match');
  assert.equal(a.score, 0, 'scores reset');
  assert.ok(a.alive && b.alive);
} });
