// Bots: server-side players that think every tick and feed their own user commands into
// the same simulation as everyone else (so they obey the exact movement, weapons and
// rules). They find their way on the navigation graph generated from the map
// (shared/nav.js) and play the objective (plant, defuse, rescue, guard; roam in
// deathmatch), see enemies like the radar's spotting does (view cone, walls, smoke), hear
// gunfire, react after a delay, turn toward their target at a limited speed with an aim
// error that settles, control their fire by distance and partly their recoil, and buy at
// round start. Skill by bot_difficulty 0-3; the numbers are estimates of CS:GO's bots
// (approx.), whose real profiles (botprofile.db) are richer.

import { TICK_RATE, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_ATTACK, IN_USE, IN_RELOAD }
  from '../shared/constants.js';
import { PS_ORIGIN, PS_FLAGS, FL_ONGROUND, eyeOffset } from '../shared/pmove.js';
import { feetOffset } from '../shared/hitgroups.js';
import {
  WEAPON_ID, WS_SLOTS, WS_ACTIVE, WS_PUNCH, WS_RELOAD_END, WS_ACTION, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_C4,
  activeWeapon,
} from '../shared/weapons.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { BOMB_DROPPED, BOMB_PLANTED } from '../shared/bomb.js';
import { HS_IDLE } from '../shared/hostages.js';
import { PHASE_LIVE, PHASE_WARMUP, ITEM_ASSAULTSUIT, ITEM_KEVLAR, ITEM_DEFUSER, itemPrice } from '../shared/economy.js';
import { Nav, NAV_CELL, NODE_CROUCH, EDGE_WALK, EDGE_JUMP, EDGE_LADDER } from '../shared/nav.js';
import { Writer, writeHello } from '../shared/protocol.js';

const DEG = Math.PI / 180;
const RECOIL_SCALE = 2; // weapon_recoil_scale: shots fly along the view plus twice the aim punch

// Per bot_difficulty (easy, normal, hard, expert), all approx.: seconds to react to a new
// enemy, turn speed (degrees per second), aim error when he appears (degrees) and how
// fast it settles (s), how much of the recoil they pull down, how often they go for the head.
const SKILL = [
  { reaction: 0.55, turn: 220, error: 7, settle: 0.6, comp: 0, head: 0.1 },
  { reaction: 0.38, turn: 340, error: 4, settle: 0.45, comp: 0.35, head: 0.25 },
  { reaction: 0.25, turn: 500, error: 2.2, settle: 0.3, comp: 0.65, head: 0.45 },
  { reaction: 0.16, turn: 720, error: 1.2, settle: 0.2, comp: 0.85, head: 0.65 },
];

// CS:GO's bot names (a few of botprofile.db's).
const NAMES = ['Albert', 'Allen', 'Bert', 'Bob', 'Cecil', 'Clarence', 'Elliot', 'Elmer', 'Ernie', 'Eugene', 'Fergus',
  'Ferris', 'Frank', 'Frasier', 'Fred', 'George', 'Graham', 'Harvey', 'Irwin', 'Lester', 'Marvin', 'Neil', 'Niles',
  'Oliver', 'Opie', 'Ringo', 'Ron', 'Ross', 'Sam', 'Sid', 'Steve', 'Ted', 'Vern', 'Vinny', 'Wade', 'Walt', 'Yogi',
  'Zach'];

const PERCEIVE_TICKS = 4; // how often a bot looks for enemies (staggered)
const LOOKAHEAD_TICKS = 4; // how often it looks for a shortcut along its path
const HEAR_RANGE = 1800; // gunfire heard this far (approx.)
const MEMORY = 4 * TICK_RATE; // ticks a lost enemy's last place is hunted
const ARRIVE = 20; // units from a waypoint that count as there
const PATH_MAX = 1024;

export class Bots {
  constructor(game) {
    this.game = game;
    this.list = []; // Bot
    this.nav = null; // built with the first bot
    this.writer = new Writer();
    this.random = Math.random;
  }

  ensureNav() {
    if (!this.nav) {
      const t = performance.now();
      // Paths go through the doors a player can open (walking into them, +use, triggers).
      const { doors, logic } = this.game;
      const open = new Set();
      for (let k = 0; k < doors.count; k++) if (doors.opens(k, logic.named)) open.add(doors.bspEntity[k]);
      this.nav = new Nav(this.game.bsp, this.game.world, NAV_CELL, (bi) => open.has(bi));
      console.log(`bot navigation: ${this.nav.count} nodes in ${(performance.now() - t).toFixed(0)} ms`);
    }
    return this.nav;
  }

  // Adds a bot (team: TEAM_T, TEAM_CT or 0 = the smaller side; difficulty 0-3, or -1 =
  // bot_difficulty). Returns its client, or null when the server is full.
  add(team = 0, difficulty = -1, name = '') {
    const game = this.game;
    this.ensureNav();
    const c = game.connect({ send() {}, close() {}, bot: true });
    if (!c) return null;
    const used = new Set(game.clients.filter((o) => o && o.joined).map((o) => o.name));
    if (!name) name = NAMES.map((n) => `BOT ${n}`).find((n) => !used.has(n)) || `BOT ${c.id}`;
    c.bot = new Bot(this, c, difficulty >= 0 ? difficulty : game.rules.botDifficulty);
    game.receive(c, writeHello(this.writer, team, 0, 0, name).slice());
    this.list.push(c.bot);
    return c;
  }

  // Removes a bot (the newest of `team` when given), returns its name or ''.
  kick(c = null, team = 0) {
    if (!c) {
      for (let i = this.list.length - 1; i >= 0 && !c; i--) if (!team || this.list[i].c.team === team) c = this.list[i].c;
      if (!c && this.list.length) c = this.list[this.list.length - 1].c; // none on that side: the newest
    }
    if (!c || !c.bot) return '';
    this.list = this.list.filter((b) => b !== c.bot);
    this.game.disconnect(c);
    console.log(`bot "${c.name}" kicked`);
    return c.name;
  }

  // bot_quota: how many bots there should be (fill: bots + humans on teams).
  maintain() {
    const r = this.game.rules;
    let humans = 0;
    for (const c of this.game.clients) if (c && c.joined && !c.bot && c.playing) humans++;
    const want = Math.max(0, r.botQuotaMode === 'fill' ? r.botQuota - humans : r.botQuota);
    if (this.list.length < want) this.add(teamFor(r.botJoinTeam), -1);
    else if (this.list.length > want) this.kick(null, this.largerTeam());
  }

  // The team with more players (humans count: a bot leaves the side that has one too many).
  largerTeam() {
    let t = 0, ct = 0;
    for (const c of this.game.clients) if (c && c.joined && c.playing) c.team === TEAM_CT ? ct++ : t++;
    return ct > t ? TEAM_CT : TEAM_T;
  }

  // Each tick, before the server runs commands: every bot decides its command.
  think() {
    for (const b of this.list) b.think();
  }
}

const teamFor = (s) => (s === 't' ? TEAM_T : s === 'ct' ? TEAM_CT : 0);

class Bot {
  constructor(bots, c, difficulty) {
    this.bots = bots;
    this.game = bots.game;
    this.c = c;
    this.difficulty = Math.min(Math.max(Math.round(difficulty), 0), 3);
    this.cmdTick = 1;
    this.pitch = 0;
    this.yaw = 0;
    this.life = -1; // the client's life this state is for
    this.path = new Int32Array(PATH_MAX);
    this.pathLen = 0;
    this.pathIdx = 0;
    this.goal = -1; // node
    this.goalWhy = ''; // what the goal is for (a new reason makes a new path)
    this.repathAt = 0;
    this.enemy = null; // Client being fought
    this.seenAt = -1e9; // tick the enemy was last seen
    this.reactAt = 0; // tick he may shoot from
    this.acquiredAt = 0;
    this.errP = 0; // aim error when acquired (degrees)
    this.errY = 0;
    this.lastX = 0; // where he was last seen / heard
    this.lastY = 0;
    this.lastZ = 0;
    this.burst = 0; // shots left in this burst
    this.restUntil = 0; // tick the next burst may start
    this.stuckAt = 0;
    this.stuckX = 0;
    this.stuckY = 0;
    this.stuck = 0;
    this.lookAt = 0; // tick to pick a new idle look direction
    this.idleYaw = 0;
    this.site = 0; // bomb site this round
    this.bought = -1; // the life it bought in
  }

  get skill() {
    return SKILL[this.difficulty];
  }

  // --- The command --------------------------------------------------------------------

  think() {
    const c = this.c, g = this.game;
    c.lastHeard = g.tick;
    let buttons = 0, select = -1;
    if (c.alive) {
      if (c.life !== this.life) this.spawned();
      [buttons, select] = this.decide();
      if (g.rules.botStop) buttons = 0;
    }
    c.inbox.put(this.cmdTick, buttons, select, this.pitch, this.yaw, g.tick);
    c.newestCmd = c.inbox.newest;
    if (c.nextCmd < 0) c.nextCmd = this.cmdTick;
    this.cmdTick++;
  }

  // A new life: forget the last one's plans; pick a bomb site; face the spawn direction.
  spawned() {
    this.life = this.c.life;
    this.pathLen = this.pathIdx = 0;
    this.goal = -1;
    this.goalWhy = '';
    this.enemy = null;
    this.seenAt = -1e9;
    this.yaw = this.c.spawnYaw;
    this.pitch = 0;
    this.stuck = 0;
    const sites = this.game.bombSites.count;
    this.site = sites ? Math.floor(this.bots.random() * sites) : 0;
  }

  // Returns [buttons, weapon slot to select or -1].
  decide() {
    const c = this.c, g = this.game, p = c.player, f = p.ps.f, sk = this.skill;
    const x = f[PS_ORIGIN], y = f[PS_ORIGIN + 1], feet = f[PS_ORIGIN + 2] - feetOffset(p.ps.i[PS_FLAGS]);
    const eye = f[PS_ORIGIN + 2] + eyeOffset(p.ps);
    if (this.bought !== c.life && g.canBuy(c)) this.buy();
    if ((g.tick + c.id) % PERCEIVE_TICKS === 0) this.perceive(x, y, eye);

    let buttons = 0, select = this.weaponSlot();
    let wantP = this.pitch, wantY = this.yaw, move = true;
    const fighting = this.enemy && this.enemy.alive && g.tick - this.seenAt < TICK_RATE / 2;
    if (fighting) {
      const e = this.enemy, ef = e.player.ps.f;
      const head = this.bots.random() < sk.head;
      const tz = ef[PS_ORIGIN + 2] + eyeOffset(e.player.ps) - (head ? 0 : 16);
      // Lead nothing; aim where he is, plus the error that settles after acquiring him.
      const settle = Math.max(0.12, Math.exp(-(g.tick - this.acquiredAt) / TICK_RATE / sk.settle));
      [wantP, wantY] = angles(x, y, eye, ef[PS_ORIGIN], ef[PS_ORIGIN + 1], tz);
      wantP += this.errP * settle;
      wantY += this.errY * settle;
      // Pull down part of the recoil: the shot goes along the view plus the aim punch.
      wantP -= p.ws.f[WS_PUNCH] * RECOIL_SCALE * sk.comp;
      wantY -= p.ws.f[WS_PUNCH + 1] * RECOIL_SCALE * sk.comp;
      const dist = Math.hypot(ef[PS_ORIGIN] - x, ef[PS_ORIGIN + 1] - y);
      const off = Math.hypot(angleDiff(wantY, this.yaw), wantP - this.pitch);
      const tolerance = Math.atan2(14, dist) / DEG + 0.6;
      // A hostage in the way: hold fire and keep going (CS:GO's bots do not shoot them).
      const clear = !this.hostageInLine(x, y, eye, ef[PS_ORIGIN], ef[PS_ORIGIN + 1], tz);
      move = !clear || g.rules.botDontShoot; // else stand still to shoot straight (CS:GO's bots stop too)
      if (clear && !g.rules.botDontShoot && g.tick >= this.reactAt && off < tolerance) buttons |= this.trigger(dist);
      if (clear && dist < 300 && this.difficulty >= 2) { // close: strafe while spraying (approx.)
        move = true;
        buttons |= (g.tick >> 5) & 1 ? IN_MOVELEFT : IN_MOVERIGHT;
      }
    }

    // Where to go.
    if (!fighting) {
      const goal = this.objective(x, y, feet);
      if (goal.node !== this.goal || goal.why !== this.goalWhy || (goal.moving && g.tick >= this.repathAt)) {
        this.goal = goal.node;
        this.goalWhy = goal.why;
        this.repathAt = g.tick + TICK_RATE;
        const nav = this.bots.nav, from = nav.nodeAt(x, y, feet);
        this.pathLen = nav.path(from, goal.node, this.path);
        this.pathIdx = 1;
      }
      if (goal.action) {
        buttons |= goal.action;
        move = false;
        if (goal.select >= 0) select = goal.select;
        if (goal.look) [wantP, wantY] = angles(x, y, eye, goal.look[0], goal.look[1], goal.look[2]);
      }
    }
    if (move && !(buttons & (IN_MOVELEFT | IN_MOVERIGHT))) {
      const steer = this.steer(x, y, feet, fighting);
      buttons |= steer.buttons;
      if (!fighting && steer.lookYaw !== null) {
        wantY = steer.lookYaw;
        wantP = steer.lookPitch;
      }
    }
    if (!fighting && this.pathIdx >= this.pathLen && !(buttons & (IN_USE | IN_ATTACK))) [wantP, wantY] = this.idleLook();

    // Reload when empty, or with half a magazine and nobody around.
    const w = activeWeapon(p.ws), o = WS_SLOTS + p.ws.f[WS_ACTIVE] * 3;
    if (w && w.clip && !p.ws.f[WS_RELOAD_END] && (p.ws.f[o + 1] === 0 || (!fighting && p.ws.f[o + 1] < w.clip / 2))) {
      buttons |= IN_RELOAD;
    }
    this.turn(wantP, wantY);
    return [buttons, select];
  }

  // Looks for enemies (the spotting test: view cone, no wall or smoke) and listens for
  // gunfire; a new enemy starts the reaction time and a fresh aim error.
  perceive(x, y, eye) {
    const c = this.c, g = this.game, sk = this.skill;
    let best = null, bestD = Infinity;
    for (const o of g.clients) {
      if (!o || !o.joined || !o.alive || !o.playing || !g.isEnemy(c, o)) continue;
      const of = o.player.ps.f, d = Math.hypot(of[PS_ORIGIN] - x, of[PS_ORIGIN + 1] - y, of[PS_ORIGIN + 2] - eye);
      const inSight = (o === this.enemy && g.tick - this.seenAt < TICK_RATE) ? g.visible(c, o) : g.sees(c, o);
      if (inSight && d < bestD) {
        best = o;
        bestD = d;
      } else if (!best && g.tick < o.revealUntil && d < HEAR_RANGE && g.tick - this.seenAt > MEMORY / 2) {
        this.heard(of[PS_ORIGIN], of[PS_ORIGIN + 1], of[PS_ORIGIN + 2]);
      }
    }
    if (!best) return;
    if (best !== this.enemy || g.tick - this.seenAt > TICK_RATE) {
      this.enemy = best;
      this.acquiredAt = g.tick;
      this.reactAt = g.tick + Math.round(sk.reaction * TICK_RATE * (0.8 + 0.4 * this.bots.random()));
      this.errP = gauss(this.bots.random) * sk.error * 0.6;
      this.errY = gauss(this.bots.random) * sk.error;
      this.burst = 0;
    }
    this.seenAt = g.tick;
    const of = best.player.ps.f;
    this.lastX = of[PS_ORIGIN];
    this.lastY = of[PS_ORIGIN + 1];
    this.lastZ = of[PS_ORIGIN + 2];
  }

  heard(x, y, z) {
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.seenAt = this.game.tick - TICK_RATE; // hunt there, but there is no one to shoot yet
    this.enemy = null;
  }

  // Is a standing hostage within a body's width of the line from (x, y, z) to the target?
  hostageInLine(x, y, z, tx, ty, tz) {
    const h = this.game.hostages, dx = tx - x, dy = ty - y, len2 = dx * dx + dy * dy;
    for (let k = 0; k < h.count; k++) {
      if (h.state[k] !== HS_IDLE) continue;
      const t = len2 > 0 ? ((h.x[k] - x) * dx + (h.y[k] - y) * dy) / len2 : 0;
      if (t <= 0 || t >= 1) continue;
      const lz = z + (tz - z) * t;
      if (Math.hypot(x + dx * t - h.x[k], y + dy * t - h.y[k]) < 20 && lz > h.z[k] && lz < h.z[k] + 72) return true;
    }
    return false;
  }

  // Fire control: pistols and snipers tap; rifles burst at range, spray up close.
  trigger(dist) {
    const g = this.game, p = this.c.player, w = activeWeapon(p.ws);
    if (!w || w.melee || !w.clip || g.tick < this.restUntil) return 0;
    if (!w.auto) return g.tick & 1 ? IN_ATTACK : 0; // a press every other tick: as fast as it cycles
    if (this.burst <= 0) this.burst = dist > 1400 ? 1 : dist > 700 ? 3 : 8;
    const shotTicks = Math.max(1, Math.round(w.cycle * TICK_RATE));
    if (g.tick % shotTicks === 0 && --this.burst <= 0) {
      this.restUntil = g.tick + Math.round((dist > 1400 ? 0.45 : dist > 700 ? 0.35 : 0.2) * TICK_RATE);
    }
    return IN_ATTACK;
  }

  // Turns the view toward (pitch, yaw) at the skill's turn speed.
  turn(wantP, wantY) {
    const step = this.skill.turn / TICK_RATE;
    const dy = angleDiff(wantY, this.yaw), dp = wantP - this.pitch;
    const k = Math.min(1, step / Math.max(Math.hypot(dy, dp), 1e-6));
    this.yaw = (this.yaw + dy * k + 360) % 360;
    this.pitch = Math.max(-89, Math.min(89, this.pitch + dp * k));
  }

  idleLook() {
    const g = this.game;
    if (g.tick >= this.lookAt) {
      this.lookAt = g.tick + Math.round((1.5 + this.bots.random() * 2) * TICK_RATE);
      this.idleYaw = this.yaw + (this.bots.random() - 0.5) * 160;
    }
    return [0, this.idleYaw];
  }

  // Best gun: the primary if it has one with ammo, else the pistol.
  weaponSlot() {
    const f = this.c.player.ws.f, has = (s) => f[WS_SLOTS + s * 3] && (f[WS_SLOTS + s * 3 + 1] || f[WS_SLOTS + s * 3 + 2]);
    if (f[WS_ACTION]) return -1;
    const want = has(SLOT_PRIMARY) ? SLOT_PRIMARY : has(SLOT_SECONDARY) ? SLOT_SECONDARY : -1;
    return want >= 0 && want !== f[WS_ACTIVE] ? want : -1;
  }

  // --- Buying -------------------------------------------------------------------------

  buy() {
    const c = this.c, g = this.game, p = c.player, ct = c.team === TEAM_CT;
    this.bought = c.life;
    const free = g.rules.deathmatch;
    const order = [];
    const rifle = WEAPON_ID[ct ? (this.difficulty >= 2 ? 'm4a1_silencer' : 'm4a1') : 'ak47'];
    if (!p.ws.f[WS_SLOTS + SLOT_PRIMARY * 3]) order.push(rifle);
    if (!free) order.push(ITEM_ASSAULTSUIT, ITEM_KEVLAR);
    if (ct && g.bombSites.count && !free) order.push(ITEM_DEFUSER);
    for (const item of order) {
      const price = itemPrice(p, item);
      if (price < 0 || (!free && price > p.money)) continue;
      if (g.phase !== PHASE_WARMUP && !free && item !== rifle && p.money - price < 0) continue;
      g.buyItem(c, item);
    }
  }

  // --- Goals --------------------------------------------------------------------------

  // What to do when no enemy is in sight: { node, why, moving, action, select, look }.
  objective(x, y, feet) {
    const c = this.c, g = this.game, nav = this.bots.nav, rnd = this.bots.random;
    const keep = (why) => (this.goalWhy === why && this.goal >= 0 ? this.goal : -1);
    // Hunt the last place an enemy was seen or heard (not when told not to shoot).
    if (g.tick - this.seenAt < MEMORY && this.lastX && !g.rules.botDontShoot) {
      return { node: nav.nodeAt(this.lastX, this.lastY, this.lastZ - 36), why: `hunt${Math.round(this.lastX)}` };
    }
    if (g.phase !== PHASE_LIVE && g.phase !== PHASE_WARMUP) return { node: -1, why: 'wait' };
    const bomb = g.bomb, f = c.player.ps.f;
    if (!g.rules.deathmatch && g.bombSites.count && g.rules.giveC4) {
      const site = g.bombSites.boxes[this.site % g.bombSites.count];
      if (c.team === TEAM_T) {
        if (c.player.ws.f[WS_SLOTS + SLOT_C4 * 3]) { // the bomb: to the site, then plant
          if (g.bombSites.touches(x, y, f[PS_ORIGIN + 2], 16, 16, 36) && (c.player.ps.i[PS_FLAGS] & FL_ONGROUND)) {
            return { node: -1, why: 'plant', action: IN_ATTACK, select: SLOT_C4, look: [x, y, feet] };
          }
          return { node: keep('site') >= 0 ? this.goal : nav.random(rnd, site), why: 'site' };
        }
        if (bomb.state === BOMB_DROPPED && this.nearestTo(bomb.x, bomb.y, TEAM_T) === c) {
          return { node: nav.nodeAt(bomb.x, bomb.y, bomb.z), why: 'pickup' };
        }
        if (bomb.state === BOMB_PLANTED) return { node: keep('guard') >= 0 ? this.goal : this.near(bomb.x, bomb.y, bomb.z, 500), why: 'guard' };
        return { node: keep('site') >= 0 ? this.goal : nav.random(rnd, site), why: 'site' };
      }
      if (bomb.state === BOMB_PLANTED) { // defuse
        if (Math.hypot(bomb.x - x, bomb.y - y) < 48) {
          return { node: -1, why: 'defuse', action: IN_USE, look: [bomb.x, bomb.y, bomb.z + 2] };
        }
        return { node: nav.nodeAt(bomb.x, bomb.y, bomb.z), why: 'bomb' };
      }
      const held = g.bombSites.boxes[c.id % g.bombSites.count]; // CTs spread over the sites
      return { node: keep('hold') >= 0 ? this.goal : nav.random(rnd, held), why: 'hold' };
    }
    const h = g.hostages;
    if (!g.rules.deathmatch && h.count) {
      if (c.team === TEAM_CT) {
        if (c.player.carrying) {
          const box = g.rescue.boxes[0];
          return { node: keep('rescue') >= 0 ? this.goal : nav.random(rnd, box), why: 'rescue' };
        }
        let k = -1, bestD = Infinity;
        for (let i = 0; i < h.count; i++) {
          const d = Math.hypot(h.x[i] - x, h.y[i] - y);
          if (h.state[i] === HS_IDLE && d < bestD) [k, bestD] = [i, d];
        }
        if (k >= 0) {
          if (bestD < 64) return { node: -1, why: 'pick', action: IN_USE, look: [h.x[k], h.y[k], h.z[k] + 36] };
          return { node: nav.nodeAt(h.x[k], h.y[k], h.z[k]), why: `hostage${k}` };
        }
      } else if (h.count) {
        const k = c.id % h.count;
        return { node: keep('guard') >= 0 ? this.goal : this.near(h.x[k], h.y[k], h.z[k], 500), why: 'guard' };
      }
    }
    // Deathmatch, or nothing to do: roam to random places.
    if (this.goalWhy === 'roam' && this.pathIdx < this.pathLen) return { node: this.goal, why: 'roam' };
    return { node: nav.random(rnd), why: 'roam' };
  }

  // A random node within `r` of a point.
  near(x, y, z, r) {
    return this.bots.nav.random(this.bots.random, [x - r, y - r, z - 200, x + r, y + r, z + 200]);
  }

  // The living player of `team` nearest to (x, y).
  nearestTo(x, y, team) {
    let best = null, bestD = Infinity;
    for (const o of this.game.clients) {
      if (!o || !o.joined || !o.alive || o.team !== team) continue;
      const d = Math.hypot(o.player.ps.f[PS_ORIGIN] - x, o.player.ps.f[PS_ORIGIN + 1] - y);
      if (d < bestD) [best, bestD] = [o, d];
    }
    return best;
  }

  // Whether +use would work a door or button in front of us (feet at `feet`).
  doorAhead(x, y, feet) {
    const g = this.game, d = g.doors;
    if (!d.count) return false;
    const yr = this.yaw * DEG;
    return d.findUse(g.world, x, y, feet + 36, x, y, feet + 64, Math.cos(yr), Math.sin(yr), 0) >= 0;
  }

  // --- Walking ------------------------------------------------------------------------

  // Follows the path: the farthest waypoint straight ahead (no jump or ladder skipped),
  // movement keys toward it relative to the view, jumps and ladders on their edges,
  // crouching where only that fits, unsticking. Returns { buttons, lookYaw, lookPitch }.
  steer(x, y, feet, fighting) {
    const nav = this.bots.nav, g = this.game, P = this.path, out = { buttons: 0, lookYaw: null, lookPitch: 0 };
    if (this.pathIdx >= this.pathLen) return out;
    const at = (k) => Math.hypot(nav.x[k] - x, nav.y[k] - y) < ARRIVE && Math.abs(nav.z[k] - feet) < 48;
    while (this.pathIdx < this.pathLen - 1 && at(P[this.pathIdx])) this.pathIdx++;
    if ((g.tick + this.c.id) % LOOKAHEAD_TICKS === 0) { // shortcut: skip waypoints we can walk straight to
      for (let j = Math.min(this.pathLen - 1, this.pathIdx + 6); j > this.pathIdx; j--) {
        let plain = true;
        for (let q = this.pathIdx; q <= j && plain; q++) plain = q === 0 || nav.edge(P[q - 1], P[q]) === EDGE_WALK;
        if (plain && nav.direct(x, y, feet, nav.x[P[j]], nav.y[P[j]], nav.z[P[j]])) {
          this.pathIdx = j;
          break;
        }
      }
    }
    const k = P[this.pathIdx], tx = nav.x[k], ty = nav.y[k];
    const d = Math.hypot(tx - x, ty - y);
    if (this.pathIdx === this.pathLen - 1 && at(k)) {
      this.pathIdx = this.pathLen; // there
      return out;
    }
    const prev = this.pathIdx > 0 ? P[this.pathIdx - 1] : -1;
    const edge = prev >= 0 ? nav.edge(prev, k) : EDGE_WALK;
    const moveYaw = Math.atan2(ty - y, tx - x) / DEG;
    if (!fighting) {
      out.lookYaw = moveYaw;
      out.lookPitch = edge === EDGE_LADDER ? -60 : 0;
    }
    // Movement keys: the direction to the waypoint relative to where we look (8 ways).
    const rel = angleDiff(moveYaw, fighting ? this.yaw : moveYaw);
    const oct = Math.round(rel / 45);
    if (Math.abs(oct) <= 1) out.buttons |= IN_FORWARD;
    if (Math.abs(oct) >= 3) out.buttons |= IN_BACK;
    if (oct >= 1 && oct <= 3) out.buttons |= IN_MOVELEFT;
    if (oct <= -1 && oct >= -3) out.buttons |= IN_MOVERIGHT;
    if (edge === EDGE_JUMP && d < 56) out.buttons |= IN_JUMP | IN_DUCK; // crouch jump up
    if (nav.flags[k] & NODE_CROUCH) out.buttons |= IN_DUCK;
    // Stuck: jump, then find a new way, then give up on this goal.
    if (g.tick - this.stuckAt >= TICK_RATE / 2) {
      const moved = Math.hypot(x - this.stuckX, y - this.stuckY);
      this.stuck = moved < 12 ? this.stuck + 1 : 0;
      this.stuckAt = g.tick;
      this.stuckX = x;
      this.stuckY = y;
      if (this.stuck >= 1 && this.doorAhead(x, y, feet)) out.buttons |= IN_USE; // a use-only door or a button
      else if (this.stuck >= 2) out.buttons |= IN_JUMP | IN_DUCK;
      if (this.stuck === 4) this.repathAt = 0, this.goalWhy = '';
      if (this.stuck >= 8) {
        this.goalWhy = '';
        this.goal = -1;
        this.stuck = 0;
      }
    }
    return out;
  }
}

// Pitch and yaw (degrees) from an eye to a point.
function angles(x, y, z, tx, ty, tz) {
  const dx = tx - x, dy = ty - y, dz = tz - z;
  return [-Math.atan2(dz, Math.hypot(dx, dy)) / DEG, Math.atan2(dy, dx) / DEG];
}

// a - b wrapped to -180..180.
function angleDiff(a, b) {
  const d = (a - b) % 360;
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
}

// A standard normal sample (Box-Muller) from rand() in 0..1.
function gauss(rand) {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9))) * Math.cos(2 * Math.PI * rand());
}

