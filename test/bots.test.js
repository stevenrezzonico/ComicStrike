import assert from 'node:assert/strict';
import { PS_ORIGIN } from '../shared/pmove.js';
import { CollisionWorld, Trace, traceHull, HULL_POINT } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { TICK_RATE } from '../shared/constants.js';
import {
  giveWeapon, WEAPONS, WEAPON_ID, WS_ZOOM, WS_GRENADES, GRENADE_IDS, WS_ACTION, ACTION_DEFUSE, WS_SLOTS, SLOT_PRIMARY,
} from '../shared/weapons.js';
import { FX_HE, FX_FLASH, FX_SMOKE } from '../shared/grenades.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { PHASE_LIVE, END_DEFUSE, END_RESCUE } from '../shared/economy.js';
import { HS_CARRIED, HS_RESCUED } from '../shared/hostages.js';
import { Nav, EDGE_WALK } from '../shared/nav.js';
import { Writer } from '../shared/protocol.js';
import { Host } from '../server/host.js';
import { loadMap, mapOrNull, readCfg, seeded, joinClient, sendCmd, teleport } from './harness.js';

const dust2 = !!mapOrNull('de_dust2'), office = !!mapOrNull('cs_office');

function setup(map, cfg = '') {
  const host = new Host({ loadMap, listMaps: () => [map], readCfg, print: () => {} });
  host.con.exec(cfg);
  host.start(map);
  host.con.exec('mp_freezetime 0; mp_warmuptime 0');
  const g = host.game;
  g.bots.random = seeded(7);
  const w = new Writer();
  const humans = [];
  const join = (name, team) => { // a test player that stands where it is put
    const c = joinClient(g, w, name, team);
    humans.push(c);
    return c;
  };
  const run = (ticks, until = () => false) => {
    for (let i = 0; i < ticks && !until(); i++) {
      for (const c of humans) sendCmd(g, w, c);
      g.step();
    }
  };
  return { host, g, join, run, humans };
}

const inBox = (c, b) => {
  const f = c.player.ps.f;
  return f[PS_ORIGIN] >= b[0] && f[PS_ORIGIN] <= b[3] && f[PS_ORIGIN + 1] >= b[1] && f[PS_ORIGIN + 1] <= b[4];
};

Deno.test({ name: 'nav: de_dust2 is one walkable graph from spawn to spawn and both sites', ignore: !dust2, fn: () => {
  const bsp = loadMap('de_dust2'), world = CollisionWorld.fromBSP(bsp);
  const nav = new Nav(bsp, world);
  assert.ok(nav.count > 5000, `${nav.count} nodes`);
  const at = (cls) => bsp.entities.find((e) => e.classname === cls).origin.split(' ').map(Number);
  const t = at('info_player_deathmatch'), ct = at('info_player_start');
  const a = nav.nodeAt(t[0], t[1], t[2] - 36), b = nav.nodeAt(ct[0], ct[1], ct[2] - 36);
  const out = new Int32Array(2048);
  const len = nav.path(a, b, out);
  assert.ok(len > 50, 'a path from the T spawn to the CT spawn');
  for (let i = 1; i < len; i++) {
    const d = Math.hypot(nav.x[out[i]] - nav.x[out[i - 1]], nav.y[out[i]] - nav.y[out[i - 1]]);
    assert.ok(d < 36 && nav.edge(out[i - 1], out[i]) >= 0, 'every step is an edge between neighbor cells');
  }
  // ...and from the T spawn to every bomb site.
  for (const e of bsp.entities.filter((e) => e.classname === 'func_bomb_target')) {
    const m = +e.model.slice(1), f = bsp.modelsF;
    const site = nav.nodeAt((f[m * 16] + f[m * 16 + 3]) / 2, (f[m * 16 + 1] + f[m * 16 + 4]) / 2, f[m * 16 + 2] + 8);
    assert.ok(nav.path(a, site, out) > 0, 'a path to a bomb site');
  }
  nav.path(a, b, out);
  // Straight walks: along open ground yes, through the T spawn's outer wall no.
  assert.ok(nav.direct(nav.x[out[0]], nav.y[out[0]], nav.z[out[0]], nav.x[out[3]], nav.y[out[3]], nav.z[out[3]]));
  let blocked = 0;
  for (let i = 0; i + 40 < len; i += 10) {
    const p = out[i], q = out[i + 40];
    if (!nav.direct(nav.x[p], nav.y[p], nav.z[p], nav.x[q], nav.y[q], nav.z[q])) blocked++;
  }
  assert.ok(blocked > 0, 'a winding path is not all one straight line');
  assert.equal(nav.edge(out[0], out[1]), EDGE_WALK, 'out of the spawn on foot');
} });

Deno.test({ name: 'bots: bot_add / bot_kick / bot_quota fill', ignore: !dust2, fn: () => {
  const { host, g, join, run } = setup('de_dust2');
  host.con.exec('bot_add_t; bot_add ct hard Tester');
  assert.equal(g.bots.list.length, 2);
  assert.equal(host.con.get('bot_quota').number, 2, 'bot_add raises bot_quota');
  assert.ok(g.clients.some((c) => c && c.name === 'Tester' && c.team === TEAM_CT && c.bot.difficulty === 2));
  run(20);
  assert.equal(g.bots.list.length, 2, 'the quota keeps them');
  host.con.exec('bot_quota_mode fill; bot_quota 4');
  join('human', TEAM_T);
  run(80);
  assert.equal(g.bots.list.length, 3, 'fill: 3 bots + 1 human');
  host.con.exec('bot_add_ct');
  run(40);
  assert.equal(g.bots.list.length, 4, 'bot_add in fill mode stays');
  assert.equal(host.con.get('bot_quota').number, 5);
  host.con.exec('bot_kick all');
  run(20);
  assert.equal(g.bots.list.length, 0);
  assert.equal(host.con.get('bot_quota').number, 1, 'fill: the human alone');
} });

Deno.test('bots: the server fills up with bots once someone plays, one leaving for each who joins', () => {
  const { g, join, run, humans } = setup('de_playground',
    'game_type 1; game_mode 2; bot_quota 10; bot_quota_mode fill; bot_join_after_player 1'); // cfg/server.cfg's
  run(64);
  assert.equal(g.bots.list.length, 0, 'no game on an empty server');
  join('first', TEAM_T);
  run(200);
  assert.equal(g.bots.list.length, 9, 'the first player and 9 bots');
  join('second', TEAM_CT);
  run(40);
  assert.equal(g.bots.list.length, 8, 'a bot left for the second');
  for (const c of humans.splice(0)) g.disconnect(c);
  run(200);
  assert.equal(g.bots.list.length, 0, 'gone with the last player');
});

Deno.test({ name: 'bots: a T walks from its spawn to a bomb site', ignore: !dust2, fn: () => {
  const { host, g, run } = setup('de_dust2');
  host.con.exec('bot_add_t');
  const b = g.bots.list[0];
  run(64 * 45, () => g.bombSites.boxes.some((box) => inBox(b.c, box)));
  assert.ok(g.bombSites.boxes.some((box) => inBox(b.c, box)), 'reached a site within 45 s');
} });

// A duel: a CT bot of `level` (no bomb to carry) facing a T standing 400 units away in
// plain view on open ground at the T spawn (`range`: [near, far] instead); the bots'
// random seeded with `seed`; `weapon` in the bot's hands instead of what it bought.
// Returns the seconds until the kill (20 if none) and whether it was a headshot.
function duel(level, seed, { weapon = null, range = [350, 450], watch = null } = {}) {
  const { host, g, join, run } = setup('de_dust2');
  g.bots.random = seeded(seed);
  const target = join('target', TEAM_T);
  host.con.exec(`bot_add ct ${['easy', 'normal', 'hard', 'expert'][level]}`);
  const bot = g.bots.list[0].c;
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  const [x, y, z] = g.spawns[TEAM_T][0];
  const nav = g.bots.nav, k = nav.nodeAt(x, y, z - 36);
  let best = -1;
  for (let j = 0; j < nav.count; j++) {
    const d = Math.hypot(nav.x[j] - nav.x[k], nav.y[j] - nav.y[k]);
    if (d > range[0] && d < range[1] && Math.abs(nav.z[j] - nav.z[k]) < 8 && nav.direct(nav.x[k], nav.y[k], nav.z[k], nav.x[j], nav.y[j], nav.z[j])) {
      best = j;
      break;
    }
  }
  assert.ok(best >= 0);
  teleport(bot, nav.x[k], nav.y[k], nav.z[k] + 36);
  teleport(target, nav.x[best], nav.y[best], nav.z[best] + 36);
  g.bots.list[0].yaw = Math.atan2(nav.y[best] - nav.y[k], nav.x[best] - nav.x[k]) * 180 / Math.PI;
  g.bots.list[0].c.yaw = g.bots.list[0].yaw;
  if (weapon) giveWeapon(bot.player.ws, WEAPON_ID[weapon]);
  let headshot = false;
  const kill = g.kill.bind(g);
  g.kill = (killer, victim, weapon, hs) => {
    headshot = !!hs;
    kill(killer, victim, weapon, hs);
  };
  const t0 = g.tick;
  run(64 * 20, () => {
    if (watch) watch(bot);
    return !target.alive;
  });
  return { bot, target, g, run, seconds: (g.tick - t0) / 64, headshot };
}

Deno.test({ name: 'bots: a hard bot kills a player standing in plain view', ignore: !dust2, fn: () => {
  const { bot, target, seconds } = duel(2, 7);
  assert.ok(!target.alive && seconds < 8, 'killed within 8 s');
  assert.equal(bot.kills, 1);
} });

Deno.test({ name: 'bots: an easy bot takes much longer than a hard one and lands fewer headshots', ignore: !dust2, fn: () => {
  const stats = (level) => {
    let time = 0, kills = 0, heads = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = duel(level, seed);
      if (!r.target.alive) kills++;
      time += r.seconds;
      if (r.headshot) heads++;
    }
    return { kills, mean: time / 8, heads };
  };
  const easy = stats(0), hard = stats(2);
  assert.equal(hard.kills, 8, 'a hard bot kills every time');
  assert.ok(hard.mean < 1.5, `hard: ${hard.mean.toFixed(2)} s a kill`);
  assert.ok(easy.kills >= 6, `easy kills in 20 s: ${easy.kills}`);
  assert.ok(easy.mean > 2 * hard.mean, `easy ${easy.mean.toFixed(2)} s vs hard ${hard.mean.toFixed(2)} s`);
  assert.ok(easy.heads < hard.heads, `headshot kills: easy ${easy.heads}, hard ${hard.heads}`);
} });

Deno.test({ name: 'bots: an expert with an AWP scopes, lets the scope settle, kills at 800 and unscopes', ignore: !dust2, fn: () => {
  let scopedTicks = 0;
  const r = duel(3, 7, { weapon: 'awp', range: [750, 900], watch: (b) => {
    if (b.player.ws.f[WS_ZOOM] > 0) scopedTicks++;
  } });
  const { bot, target, seconds, run } = r;
  assert.ok(!target.alive && seconds < 8, `killed within 8 s (${seconds.toFixed(2)})`);
  assert.ok(scopedTicks >= 0.3 * 64, `scoped ${scopedTicks} ticks before the shot`);
  run(64 * 3, () => bot.player.ws.f[WS_ZOOM] === 0);
  assert.equal(bot.player.ws.f[WS_ZOOM], 0, 'unscoped once the fight is over');
} });

// A bot and a target on the playground's open ground: the target at `far` units in the
// bot's view. Returns the pieces and the nodes.
function playgroundPair(cfg, far = [450, 600]) {
  const { host, g, join, run } = setup('de_playground');
  const target = join('target', TEAM_T);
  host.con.exec(cfg);
  const bot = g.bots.list[0];
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  const nav = g.bots.nav, tr = new Trace();
  const k = nav.nodeAt(-300, 300, 0); // the courtyard
  assert.ok(k >= 0);
  let best = -1, away = -1;
  for (let j = 0; j < nav.count; j++) {
    const d = Math.hypot(nav.x[j] - nav.x[k], nav.y[j] - nav.y[k]);
    if (best < 0 && d > far[0] && d < far[1] && Math.abs(nav.z[j] - nav.z[k]) < 8 &&
      nav.direct(nav.x[k], nav.y[k], nav.z[k], nav.x[j], nav.y[j], nav.z[j])) best = j;
    if (away < 0 && d > 1800) { // out of sight from k, so the target is lost there
      traceHull(g.world, HULL_POINT, nav.x[k], nav.y[k], nav.z[k] + 64, nav.x[j], nav.y[j], nav.z[j] + 64, tr);
      if (tr.fraction < 1) away = j;
    }
  }
  assert.ok(best >= 0 && away >= 0);
  teleport(bot.c, nav.x[k], nav.y[k], nav.z[k] + 36);
  teleport(target, nav.x[best], nav.y[best], nav.z[best] + 36);
  bot.yaw = bot.c.yaw = Math.atan2(nav.y[best] - nav.y[k], nav.x[best] - nav.x[k]) * 180 / Math.PI;
  return { g, run, bot, target, nav, k, best, away };
}

Deno.test('bots: a lost enemy gets an HE grenade at the place he was last seen', () => {
  const { g, run, bot, target, nav, best, away } = playgroundPair('bot_add ct normal');
  giveWeapon(bot.c.player.ws, WEAPON_ID.hegrenade);
  run(64 * 3, () => bot.enemy === target);
  assert.equal(bot.enemy, target, 'seen');
  teleport(target, nav.x[away], nav.y[away], nav.z[away] + 36); // gone
  const thrown = [];
  const throwFn = g.grenades.throw.bind(g.grenades);
  g.grenades.throw = (...a) => {
    thrown.push(a[1]);
    return throwFn(...a);
  };
  run(64 * 6, () => thrown.length > 0);
  assert.deepEqual(thrown, [WEAPON_ID.hegrenade], 'an HE thrown within 6 s of losing him');
  assert.equal(bot.c.player.ws.f[WS_GRENADES + GRENADE_IDS.indexOf(WEAPON_ID.hegrenade)], 0);
  run(64 * 4, () => g.grenades.fxCount > 0 && g.grenades.fxKind[0] === FX_HE);
  assert.ok(g.grenades.fxCount > 0 && g.grenades.fxKind[0] === FX_HE, 'it went off');
  const d = Math.hypot(g.grenades.fxPos[0] - nav.x[best], g.grenades.fxPos[1] - nav.y[best]);
  assert.ok(d < 200, `within 200 units of where he was: ${d.toFixed(0)}`);
  assert.ok(bot.c.alive && bot.c.player.health === 100, 'not hurt by its own throw');
});

Deno.test('bots: a flashbang goes where the enemy was lost, and the thrower looks away from it', () => {
  const { g, run, bot, target, nav, away } = playgroundPair('bot_add ct hard', [300, 400]);
  giveWeapon(bot.c.player.ws, WEAPON_ID.flashbang);
  run(64 * 3, () => bot.enemy === target);
  assert.equal(bot.enemy, target);
  teleport(target, nav.x[away], nav.y[away], nav.z[away] + 36);
  const thrown = [];
  const throwFn = g.grenades.throw.bind(g.grenades);
  g.grenades.throw = (...a) => {
    thrown.push([a[1], a[8]]);
    return throwFn(...a);
  };
  run(64 * 6, () => thrown.length > 0);
  assert.equal(thrown.length, 1);
  assert.equal(thrown[0][0], WEAPON_ID.flashbang);
  const throwYaw = thrown[0][1];
  const fromOpposite = () => Math.abs((((bot.yaw - throwYaw) % 360) + 540) % 360 - 180);
  run(64, () => fromOpposite() < 60);
  assert.ok(fromOpposite() < 60, `looking away from the throw within a second: ${fromOpposite().toFixed(0)} degrees from opposite`);
  run(64 * 3, () => g.grenades.fxCount > 0);
  assert.equal(g.grenades.fxKind[0], FX_FLASH);
  // Facing away it gets the "behind" share (0.3 of the full 4.87 s), not the full blast.
  assert.ok(bot.c.flashLeft > 0 && bot.c.flashLeft < 1.8, `only a little of its own flash: ${bot.c.flashLeft.toFixed(2)} s`);
});

Deno.test('bots: the Ts smoke the CT side of their site on the way in, once a team a round', () => {
  const { host, g, join, run } = setup('de_playground');
  const ct = join('away', TEAM_CT);
  host.con.exec('bot_add t normal; bot_add t normal');
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  teleport(ct, -10000, -10000, -10000); // alive, out of sight: the round goes on
  const spawn = g.spawns[TEAM_CT][0];
  for (let i = 0; i < g.bombSites.count; i++) { // the place: out of the site, toward the CTs
    const b = g.bombSites.boxes[i], spot = g.bots.smokeSpot(i);
    assert.ok(spot, `site ${i} has a smoke spot`);
    const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2;
    assert.ok(Math.hypot(spot[0] - spawn[0], spot[1] - spawn[1]) < Math.hypot(cx - spawn[0], cy - spawn[1]), `site ${i}: toward the CTs`);
  }
  for (const bot of g.bots.list) giveWeapon(bot.c.player.ws, WEAPON_ID.smokegrenade);
  const thrown = [];
  const throwFn = g.grenades.throw.bind(g.grenades);
  g.grenades.throw = (...a) => {
    if (a[1] !== WEAPON_ID.decoy) thrown.push(a[1]); // a decoy toward the other site may come first
    return throwFn(...a);
  };
  run(64 * 40, () => thrown.length > 0);
  assert.deepEqual(thrown, [WEAPON_ID.smokegrenade], 'a smoke on the way in');
  const spot = g.bots.smokeSpot(g.bots.list[0].site % g.bombSites.count);
  const smoke = () => g.grenades.fxKind.subarray(0, g.grenades.fxCount).indexOf(FX_SMOKE); // past a decoy's
  run(64 * 6, () => smoke() >= 0);
  const k = smoke();
  assert.ok(k >= 0, 'it popped');
  const d = Math.hypot(g.grenades.fxPos[k * 3] - spot[0], g.grenades.fxPos[k * 3 + 1] - spot[1]);
  assert.ok(d < 250, `within 250 units of the spot: ${d.toFixed(0)}`);
  run(64 * 10);
  assert.equal(thrown.length, 1, 'once a team a round');
});

Deno.test('bots: a T throws his molotov on the planted bomb while a CT is heard defusing it', () => {
  const { host, g, join, run } = setup('de_playground');
  const t = join('planter', TEAM_T), ct = join('defuser', TEAM_CT);
  host.con.exec('bot_add t normal');
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  const nav = g.bots.nav, box = g.bombSites.boxes[0], spot = nav.random(seeded(3), box);
  teleport(t, nav.x[spot], nav.y[spot], nav.z[spot] + 36);
  giveWeapon(t.player.ws, WEAPON_ID.c4);
  g.bombCarrier = t;
  g.plantBomb(t);
  assert.equal(g.bomb.state, BOMB_PLANTED);
  const bot = g.bots.list[0], b = g.bomb;
  giveWeapon(bot.c.player.ws, WEAPON_ID.molotov);
  let from = -1; // somewhere 300-700 away with a throw to the bomb
  for (let k = 0; k < nav.count && from < 0; k++) {
    const d = Math.hypot(nav.x[k] - b.x, nav.y[k] - b.y);
    if (d > 300 && d < 700 && Math.abs(nav.z[k] - b.z) < 64) from = k;
  }
  assert.ok(from >= 0);
  teleport(bot.c, nav.x[from], nav.y[from], nav.z[from] + 36);
  const x = nav.x[from], y = nav.y[from], eye = nav.z[from] + 64;
  bot.nadeAt = 0;
  assert.ok(!bot.considerPlay(x, y, eye), 'nobody defusing: nothing');
  ct.player.ws.f[WS_ACTION] = ACTION_DEFUSE; // heard at the bomb
  teleport(ct, b.x, b.y, b.z + 36);
  let ok = false;
  for (let k = 0; k < nav.count && !ok; k++) { // the first place with an arc to the bomb
    const d = Math.hypot(nav.x[k] - b.x, nav.y[k] - b.y);
    if (d < 250 || d > 900) continue;
    ok = bot.considerPlay(nav.x[k], nav.y[k], nav.z[k] + 64);
  }
  assert.ok(ok, 'a molotov at the bomb');
  assert.equal(bot.nade.id, WEAPON_ID.molotov);
  run(1);
});

Deno.test('bots: a flashed bot sees nobody until it clears', () => {
  const { run, bot, target } = playgroundPair('bot_add ct expert');
  const yaw0 = bot.yaw;
  bot.objective = () => ({ node: -1, why: 'wait' }); // stays put, facing him
  bot.idleLook = () => [0, yaw0];
  bot.c.flashLeft = 2;
  run(64 * 1.5);
  assert.equal(bot.enemy, null, 'blind');
  assert.ok(target.alive);
  run(64 * 3, () => !target.alive);
  assert.ok(!target.alive, 'killed once it sees again');
});

Deno.test('bots: a door a button opens is on the way, and the bot presses the button first', () => {
  const { host, g, join, run } = setup('de_playground');
  join('other', TEAM_T); // both teams: the round goes live
  host.con.exec('bot_add ct normal');
  const bot = g.bots.list[0];
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  const nav = g.bots.nav, d = g.doors;
  const from = nav.nodeAt(1030, -640, 0), to = nav.nodeAt(1140, -640, 0);
  assert.ok(from >= 0 && to >= 0);
  const path = new Int32Array(256), n = nav.path(from, to, path);
  assert.ok(n > 0, 'a path through the passage');
  assert.ok(Array.from(path.subarray(0, n)).some((k) => nav.x[k] > 1072 && nav.x[k] < 1096 && nav.y[k] > -720 && nav.y[k] < -560), 'it crosses the garage door');
  const garage = d.name.indexOf('garage'), button = d.buttonFor('garage');
  assert.ok(garage >= 0 && button >= 0);
  teleport(bot.c, nav.x[from], nav.y[from], nav.z[from] + 36);
  bot.objective = () => ({ node: to, why: 'test' });
  let pressed = false, opened = false;
  const use = d.use.bind(d);
  d.use = (k, ...a) => {
    if (k === button) pressed = true;
    return use(k, ...a);
  };
  run(64 * 20, () => {
    if (!d.atBottom(garage)) opened = true;
    const f = bot.c.player.ps.f;
    return f[PS_ORIGIN] > 1120 && Math.abs(f[PS_ORIGIN + 1] + 640) < 100;
  });
  assert.ok(pressed, 'the button was pressed');
  assert.ok(opened, 'the door opened');
  const f = bot.c.player.ps.f;
  assert.ok(f[PS_ORIGIN] > 1120, `through the passage within 20 s (x ${f[PS_ORIGIN].toFixed(0)})`);
});

Deno.test({ name: 'bots: a CT goes to the planted bomb and defuses it', ignore: !dust2, fn: () => {
  const { host, g, join, run } = setup('de_dust2');
  const t = join('planter', TEAM_T);
  host.con.exec('bot_add ct hard; bot_dont_shoot 1');
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  // The planter puts the bomb down in the site nearest the CT spawn, then leaves.
  const ct = g.spawns[TEAM_CT][0], nav = g.bots.nav;
  const box = g.bombSites.boxes.slice().sort((a, b) =>
    Math.hypot((a[0] + a[3]) / 2 - ct[0], (a[1] + a[4]) / 2 - ct[1]) -
    Math.hypot((b[0] + b[3]) / 2 - ct[0], (b[1] + b[4]) / 2 - ct[1]))[0];
  const spot = nav.random(seeded(3), box);
  teleport(t, nav.x[spot], nav.y[spot], nav.z[spot] + 36);
  giveWeapon(t.player.ws, WEAPON_ID.c4);
  g.bombCarrier = t;
  g.plantBomb(t);
  assert.equal(g.bomb.state, BOMB_PLANTED);
  teleport(t, -10000, -10000, -10000); // out of the way
  g.kill(t, t, 0, false);
  run(64 * 39, () => g.round.info >> 2 === END_DEFUSE);
  assert.equal(g.round.info >> 2, END_DEFUSE, 'defused before it went off');
} });

// A molotov on the bomb under a defusing CT bot: the defuse would end after the fire killed
// it, so it lets go and steps out (it kept defusing and burned to death: defusing pins you).
Deno.test({ name: 'bots: a defusing CT caught in a fire lets go and steps out', ignore: !dust2, fn: async () => {
  const { FX_FIRE } = await import('../shared/grenades.js');
  const { host, g, join, run } = setup('de_dust2');
  const t = join('planter', TEAM_T);
  host.con.exec('bot_add ct hard; bot_dont_shoot 1');
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  const ct = g.spawns[TEAM_CT][0], nav = g.bots.nav;
  const box = g.bombSites.boxes.slice().sort((a, b) =>
    Math.hypot((a[0] + a[3]) / 2 - ct[0], (a[1] + a[4]) / 2 - ct[1]) -
    Math.hypot((b[0] + b[3]) / 2 - ct[0], (b[1] + b[4]) / 2 - ct[1]))[0];
  const spot = nav.random(seeded(3), box);
  teleport(t, nav.x[spot], nav.y[spot], nav.z[spot] + 36);
  giveWeapon(t.player.ws, WEAPON_ID.c4);
  g.bombCarrier = t;
  g.plantBomb(t);
  teleport(t, -10000, -10000, -10000);
  g.kill(t, t, 0, false);
  const bot = g.bots.list[0];
  run(64 * 39, () => bot.c.player.ws.f[WS_ACTION] === ACTION_DEFUSE);
  assert.equal(bot.c.player.ws.f[WS_ACTION], ACTION_DEFUSE, 'defusing');
  const k = g.grenades.addEffect(FX_FIRE, WEAPON_ID.molotov, t.id, TEAM_T, g.bomb.x, g.bomb.y, g.bomb.z);
  g.grenades.fxAge[k] = 2; // grown to its full reach
  run(64 * 2);
  assert.ok(bot.c.alive, `alive (${bot.c.player.health} HP)`);
  assert.notEqual(bot.c.player.ws.f[WS_ACTION], ACTION_DEFUSE, 'let go');
} });

Deno.test({ name: 'bots: the T bots take the bomb to one site together and plant it', ignore: !dust2, fn: () => {
  for (const seed of [1, 2, 3, 4]) {
    const { host, g, join, run } = setup('de_dust2');
    g.bots.random = seeded(seed);
    const ct = join('watcher', TEAM_CT); // stands at the CT spawn; seen, but the bots do not shoot
    host.con.exec('bot_dont_shoot 1; bot_add_t; bot_add_t; bot_add_t');
    run(4);
    while (g.phase !== PHASE_LIVE) run(1);
    const sites = new Set(g.bots.list.map((b) => b.site));
    assert.equal(sites.size, 1, 'one site for the team');
    assert.ok(g.bombCarrier && g.bombCarrier.bot, 'a bot carries the bomb');
    run(64 * 75, () => g.bomb.state === BOMB_PLANTED);
    assert.equal(g.bomb.state, BOMB_PLANTED, `seed ${seed}: planted within 75 s`);
    assert.ok(ct.alive);
  }
} });

Deno.test({ name: 'bots: a CT carries a hostage out on cs_office', ignore: !office, fn: () => {
  const { host, g, join, run } = setup('cs_office');
  join('t', TEAM_T); // stays at the T spawn, so the round is live
  host.con.exec('mp_roundtime_hostage 5; bot_dont_shoot 1; bot_add_ct'); // the T must live: no elimination win
  run(4);
  host.con.exec('mp_restartgame 1');
  run(70);
  const h = g.hostages;
  run(64 * 150, () => h.state[0] === HS_RESCUED || h.state[1] === HS_RESCUED);
  assert.ok([...h.state.subarray(0, h.count)].some((s) => s === HS_RESCUED || s === HS_CARRIED), 'picked one up');
  assert.equal(g.round.info >> 2, END_RESCUE, 'and rescued it');
} });

Deno.test({ name: 'bots: free-for-all deathmatch bots roam and kill each other', ignore: !dust2, fn: () => {
  const { host, g, run } = setup('de_dust2', 'game_type 1; game_mode 2');
  host.con.exec('bot_add_t; bot_add_t; bot_add_t; bot_add_t');
  run(64 * 60);
  const kills = g.bots.list.reduce((n, b) => n + b.c.kills, 0);
  assert.ok(kills >= 2, `${kills} kills in a minute`);
  assert.equal(g.bombCarrier, null);
} });

Deno.test({ name: 'bots: a dead player takes control of a teammate bot until the next round', ignore: !dust2, fn: async () => {
  const { E_ACTIVE } = await import('../shared/protocol.js');
  const { g, host, join, run } = setup('de_dust2');
  host.con.exec('bot_stop 1; bot_add_t');
  const h = join('human', TEAM_T), ct = join('enemy', TEAM_CT);
  run(8, () => g.phase === PHASE_LIVE);
  assert.equal(g.phase, PHASE_LIVE);
  const bot = g.clients.find((c) => c && c.bot);
  giveWeapon(bot.player.ws, WEAPON_ID.ak47);
  bot.player.health = 64;
  bot.player.armor = 50;
  teleport(bot, -400, 800, 100);
  bot.yaw = 37;
  const row = () => { // the bot's row in the newest snapshot
    const ring = g.snapshots, k = ring.seq.indexOf(Math.max(...ring.seq));
    return ring.ents[ring.row(k, bot.id) + E_ACTIVE];
  };
  assert.equal(g.takeOver(h, bot.id), 'only the dead can take control of a bot', 'not while alive');
  assert.equal(g.takeOver(ct, bot.id).length > 0, true);
  g.kill(h, h, 0, false);
  assert.match(g.takeOver(ct, bot.id), /only the dead|not a living bot/);
  const deaths = bot.player.deaths, spawns = h.player.spawnCount;
  g.clientCommand(h, `takeover ${bot.id}`);
  assert.ok(h.alive, 'the human lives again');
  assert.equal(h.player.health, 64);
  assert.equal(h.player.armor, 50);
  assert.equal(h.player.ws.f[17], WEAPON_ID.ak47, 'with the bot\'s rifle');
  assert.equal(Math.round(h.player.ps.f[PS_ORIGIN]), -400, 'where the bot was');
  assert.equal(h.spawnYaw, 37, 'looking where it looked');
  assert.notEqual(h.player.spawnCount, spawns, 'the client adopts it like a respawn');
  assert.ok(!bot.alive && bot.controlled, 'the bot is out of play');
  assert.equal(bot.player.deaths, deaths, 'without a death');
  run(2);
  assert.equal(row(), 0, 'and drawn nowhere');
  assert.ok(h.alive);
  assert.notEqual(g.takeOver(h, bot.id), '', 'nor taken twice');
  // Next round: the bot plays again.
  g.startRound(false);
  run(2);
  assert.ok(bot.alive && !bot.controlled);
  assert.equal(row(), 1);
  // Switching sides mid-round (a living body on the other team) takes no bot that round.
  run(8, () => g.phase === PHASE_LIVE);
  ct.lastTeamChange = -Infinity;
  host.con.exec('mp_limitteams 0'); // (two Ts against none)
  g.joinTeam(ct, 2);
  assert.match(g.takeOver(ct, bot.id), /changed teams/);
  g.startRound(false);
  assert.ok(!ct.switchedTeam, 'the next round it may');
} });

// The other snipers (hard and expert, a team with no sniper yet): with $5400 an AWP one round
// in three or an auto-sniper one in ten, short of a rifle an SSG 08 one in four.
Deno.test('bots: buy the AWP, an auto-sniper or an SSG 08 by money', () => {
  const { g, host, join, run } = setup('de_playground');
  host.con.exec('bot_difficulty 3; bot_stop 1; bot_add_ct');
  join('human', TEAM_T);
  run(4);
  const bot = g.bots.list[0], p = bot.c.player, slot = WS_SLOTS + SLOT_PRIMARY * 3;
  const tally = (money) => {
    const got = {};
    for (let i = 0; i < 300; i++) {
      p.ws.f[slot] = p.ws.f[slot + 1] = p.ws.f[slot + 2] = 0;
      p.money = money;
      bot.buy();
      const name = WEAPONS[p.ws.f[slot]]?.name || 'none';
      got[name] = (got[name] || 0) + 1;
    }
    return got;
  };
  const rich = tally(6000), poor = tally(2500);
  assert.ok(rich.awp > 70 && rich.awp < 130, `AWP ${rich.awp} of 300`);
  assert.ok(rich.scar20 > 12 && rich.scar20 < 50, `SCAR-20 ${rich.scar20}`);
  assert.ok(!rich.ssg08 && !rich.g3sg1, 'a CT, with money for a rifle');
  assert.ok(poor.ssg08 > 50 && poor.ssg08 < 110, `SSG 08 ${poor.ssg08} of 300`);
  assert.equal(poor.ssg08 + (poor.none || 0), 300, 'else nothing: no rifle money');
});

// Decoys: a T bot throws its decoy toward the site the team is not going for early in the
// round, and a CT bot hears a T decoy as gunfire and goes to look.
Deno.test('bots: throw decoys at the other site, and fall for the other team\'s', async () => {
  const { FX_DECOY } = await import('../shared/grenades.js');
  const { g, host, join, run } = setup('de_playground');
  host.con.exec('bot_add_t; bot_add_ct');
  join('human', TEAM_CT);
  run(TICK_RATE * 2, () => g.phase === PHASE_LIVE);
  assert.equal(g.phase, PHASE_LIVE);
  const t = g.bots.list.find((b) => b.c.team === TEAM_T), ct = g.bots.list.find((b) => b.c.team === TEAM_CT);
  // The T, going for site 0 with a decoy: from a spot where a wall hides site 1 it looks
  // again a second later (the round's try is not spent); from one with an arc, it throws.
  t.site = 0;
  giveWeapon(t.c.player.ws, WEAPON_ID.decoy);
  const s1 = g.bombSites.boxes[1], sx = (s1[0] + s1[3]) / 2, sy = (s1[1] + s1[4]) / 2, nav = g.bots.nav;
  assert.equal(t.decoyPlay(sx + 800, sy + 4, 64), false, 'a wall in the way');
  assert.notEqual(t.decoyRound, g.round.serial);
  assert.equal(t.decoyPlay(sx + 800, sy + 4, 64), false, 'not again within the second');
  let from = -1;
  for (let k = 0; k < nav.count && from < 0; k++) {
    const d = Math.hypot(nav.x[k] - sx, nav.y[k] - sy);
    t.decoyTryAt = 0;
    if (d > 600 && d < 1400 && t.decoyPlay(nav.x[k], nav.y[k], nav.z[k] + 64)) from = k;
  }
  assert.ok(from >= 0 && t.nade && t.nade.id === WEAPON_ID.decoy, 'a decoy throw toward site 1');
  assert.equal(t.decoyRound, g.round.serial, 'once a round');
  t.nade = null;
  // The CT: a T decoy popping 600 units off is gunfire to hunt.
  const cf = ct.c.player.ps.f;
  const k = g.grenades.addEffect(FX_DECOY, WEAPON_ID.decoy, t.c.id, TEAM_T, cf[0] + 600, cf[1], cf[2] - 36); // on the floor
  const id = g.grenades.fxId[k], x = cf[0] + 600;
  run(TICK_RATE);
  assert.equal(ct.decoyHeard, id, 'heard it');
  assert.equal(ct.lastX, x, 'and hunts there');
  assert.equal(ct.lastZ, cf[2], 'at standing height, where the hunt looks for a floor under it');
});

// Fires: a bot standing in one steps out of it, and paths go round one when there is a way.
Deno.test('bots: keep out of fires', async () => {
  const { FX_FIRE, FIRE_TIME } = await import('../shared/grenades.js');
  const { g, host, join, run } = setup('de_playground', 'game_type 2; game_mode 0'); // the demo: no round end
  host.con.exec('bot_dont_shoot 1; bot_add_ct');
  join('human', TEAM_T);
  run(TICK_RATE);
  const bot = g.bots.list[0], f = bot.c.player.ps.f, bots = g.bots, nav = bots.nav;
  // Its middle 70 units off (burning slows the bot: each hurt tags it, as any damage does).
  const k = g.grenades.addEffect(FX_FIRE, WEAPON_ID.molotov, -1, TEAM_T, f[0] + 70, f[1], f[2] - 36);
  g.grenades.fxAge[k] = 2; // grown to its full reach
  assert.ok(bots.fireAt(f[0], f[1], f[2] - 36) >= 0, 'in it');
  run(TICK_RATE * 2);
  assert.ok(bots.fireAt(f[0], f[1], f[2] - 36) < 0, 'stepped out');
  assert.ok(bot.c.alive);
  // A path between two nodes either side of the fire avoids its nodes.
  g.grenades.fxAge[k] = 2;
  bots.markFires();
  const fx = g.grenades.fxPos[k * 3], fy = g.grenades.fxPos[k * 3 + 1], fz = g.grenades.fxPos[k * 3 + 2];
  const a = bots.nearestNode(fx - 300, fy, fz + 37, 120), b = bots.nearestNode(fx + 300, fy, fz + 37, 120);
  assert.ok(a >= 0 && b >= 0 && !bots.burning[a] && !bots.burning[b]);
  const path = new Int32Array(1024), plain = nav.path(a, b, path);
  const through = [...path.subarray(0, plain)].filter((n) => bots.burning[n]).length;
  const n = nav.path(a, b, path, bots.burning);
  assert.ok(n > 0);
  const burnt = [...path.subarray(0, n)].filter((m) => bots.burning[m]).length;
  assert.ok(through > 0 && burnt < through, `straight: ${through} burning nodes, round: ${burnt}`);
  // A goal inside the fire waits at the nearest node outside it (a defuser at its edge).
  const inside = bots.burning.indexOf(1), edge = bots.safeNear(inside);
  assert.ok(edge !== inside && !bots.burning[edge], 'the goal moves out of the fire');
  g.grenades.fxAge[k] = FIRE_TIME + 1;
});

// When the freeze ends every bot gets a goal in the same tick; each searched its path then
// (0.6-1.4 ms each, 13-17 ms with 20 bots, every round). Two searches a tick, the rest next.
Deno.test('bots: path searches are spread over the ticks after the freeze', () => {
  const { host, g, run } = setup('de_playground');
  host.con.exec('mp_freezetime 1; bot_quota 10');
  run(TICK_RATE * 2);
  host.con.exec('mp_restartgame 1');
  const nav = g.bots.ensureNav(), path = nav.path.bind(nav);
  let searches = 0, worst = 0;
  nav.path = (from, to, ...a) => (to >= 0 && searches++, path(from, to, ...a)); // to -1: no search (the freeze)
  for (let i = 0; i < TICK_RATE * 4; i++) {
    searches = 0;
    run(1);
    worst = Math.max(worst, searches);
  }
  assert.ok(worst <= 2, `${worst} searches in one tick`);
  assert.equal(g.phase, PHASE_LIVE);
  assert.ok(g.bots.list.every((b) => b.pathLen > 0 || !b.c.alive), 'every bot has its path');
});

// de_train's bomb site B holds no navigation node (the floor flood never reaches it): the
// bots sent there got no goal and stood at spawn all round. Such a zone gives the nearest.
Deno.test('bots: a zone with no navigation inside gives the nearest node', () => {
  const { g } = setup('de_playground');
  const nav = g.bots.ensureNav(), rnd = seeded(3);
  const k = nav.random(rnd, [-64, -64, 4000, 64, 64, 4100]); // high over the middle: no floor there
  assert.ok(k >= 0);
  for (let j = 0; j < nav.count; j++) assert.ok(Math.hypot(nav.x[j], nav.y[j], nav.z[j] - 4000) >= Math.hypot(nav.x[k], nav.y[k], nav.z[k] - 4000));
});
