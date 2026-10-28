import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { CollisionWorld } from '../shared/trace.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { giveWeapon, WEAPON_ID } from '../shared/weapons.js';
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
  host.con.exec('bot_kick all');
  run(20);
  assert.equal(g.bots.list.length, 0);
  assert.equal(host.con.get('bot_quota').number, 0);
} });

Deno.test({ name: 'bots: a T walks from its spawn to a bomb site', ignore: !dust2, fn: () => {
  const { host, g, run } = setup('de_dust2');
  host.con.exec('bot_add_t');
  const b = g.bots.list[0];
  run(64 * 45, () => g.bombSites.boxes.some((box) => inBox(b.c, box)));
  assert.ok(g.bombSites.boxes.some((box) => inBox(b.c, box)), 'reached a site within 45 s');
} });

Deno.test({ name: 'bots: a hard bot kills a player standing in plain view', ignore: !dust2, fn: () => {
  const { host, g, join, run } = setup('de_dust2');
  const target = join('target', TEAM_CT);
  host.con.exec('bot_add t hard');
  const bot = g.bots.list[0].c;
  run(4);
  while (g.phase !== PHASE_LIVE) run(1);
  // The target 400 units ahead of the bot on open ground at the T spawn.
  const [x, y, z] = g.spawns[TEAM_T][0];
  const nav = g.bots.nav, k = nav.nodeAt(x, y, z - 36);
  let best = -1;
  for (let j = 0; j < nav.count; j++) {
    const d = Math.hypot(nav.x[j] - nav.x[k], nav.y[j] - nav.y[k]);
    if (d > 350 && d < 450 && Math.abs(nav.z[j] - nav.z[k]) < 8 && nav.direct(nav.x[k], nav.y[k], nav.z[k], nav.x[j], nav.y[j], nav.z[j])) {
      best = j;
      break;
    }
  }
  assert.ok(best >= 0);
  teleport(bot, nav.x[k], nav.y[k], nav.z[k] + 36);
  teleport(target, nav.x[best], nav.y[best], nav.z[best] + 36);
  g.bots.list[0].yaw = Math.atan2(nav.y[best] - nav.y[k], nav.x[best] - nav.x[k]) * 180 / Math.PI;
  g.bots.list[0].c.yaw = g.bots.list[0].yaw;
  run(64 * 8, () => !target.alive);
  assert.ok(!target.alive, 'killed within 8 s');
  assert.equal(bot.kills, 1);
} });

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
