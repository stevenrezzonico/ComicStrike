import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { CollisionWorld, Trace, traceHull, HULL_POINT } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { giveWeapon, WEAPON_ID, WS_ZOOM, WS_GRENADES, GRENADE_IDS } from '../shared/weapons.js';
import { FX_HE, FX_FLASH } from '../shared/grenades.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { PHASE_LIVE, END_DEFUSE, END_RESCUE } from '../shared/economy.js';
import { HS_CARRIED, HS_RESCUED } from '../shared/hostages.js';
import { Nav, EDGE_WALK } from '../shared/nav.js';
import { Writer, CmdRing, writeHello, writeCmds } from '../shared/protocol.js';
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
const has = (name) => {
  try {
    loadMap(name);
    return true;
  } catch {
    return false;
  }
};
const dust2 = has('de_dust2'), office = has('cs_office');

// A seeded random (mulberry32) so bot decisions repeat.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(map, cfg = '') {
  const host = new Host({ loadMap, listMaps: () => [map], readCfg, print: () => {}, defer: (fn) => fn() });
  host.con.exec(cfg);
  host.start(map);
  host.con.exec('mp_freezetime 0; mp_warmuptime 0');
  const g = host.game;
  g.bots.random = seeded(7);
  const w = new Writer();
  const humans = [];
  const join = (name, team) => { // a test player that stands where it is put
    const c = g.connect({ send() {}, close() {} });
    g.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
    humans.push(c);
    return c;
  };
  const run = (ticks, until = () => false) => {
    for (let i = 0; i < ticks && !until(); i++) {
      for (const c of humans) {
        c.cmds.put(c.tick, 0, -1, 0, 0, 0);
        g.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      g.step();
    }
  };
  return { host, g, join, run };
}

function teleport(c, x, y, z) {
  const f = c.player.ps.f;
  f[PS_ORIGIN] = x;
  f[PS_ORIGIN + 1] = y;
  f[PS_ORIGIN + 2] = z;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
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
} });
