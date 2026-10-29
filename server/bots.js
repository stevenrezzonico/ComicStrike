// Bots: server-side players that think every tick and feed their own user commands into
// the same simulation as everyone else (so they obey the exact movement, weapons and
// rules). They find their way on the navigation graph generated from the map
// (shared/nav.js) and play the objective (plant, defuse, rescue, guard; roam in
// deathmatch), see enemies like the radar's spotting does (view cone, walls, smoke), hear
// gunfire, react after a delay, swing their view toward the target like a spring (the
// weak ones overshoot), aim with an error that wanders and shrinks the longer they look
// (CS:GO's aim offset and focus), fire in bursts by distance and skill, pull down part
// of the recoil, and buy at round start. Skill by bot_difficulty 0-3: the numbers follow
// CS:GO's bot profile templates (botprofile.db: Easy, Normal, Hard, Expert) where we know
// them and are estimates (approx.) elsewhere.

import { TICK_RATE, TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_ATTACK, IN_USE, IN_RELOAD }
  from '../shared/constants.js';
import { PS_ORIGIN, PS_FLAGS, PS_DUCK_AMOUNT, FL_ONGROUND, eyeOffset } from '../shared/pmove.js';
import { feetOffset, crouchScale } from '../shared/hitgroups.js';
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

// Per bot_difficulty (easy, normal, hard, expert), after CS:GO's profile templates:
//   skill: the profile's Skill (0..1). The aim error is AIM_ERROR × (1 − accuracy) degrees,
//     accuracy = max(skill, focus), focus growing to 0.75 over `focus` seconds of looking
//     at the enemy (CS:GO: 5 s for Skill 0, 2 s from Skill 0.6 up);
//   reaction: the profile's ReactionTime (s) before the first shot at a new enemy, plus
//     `delay` (AttackDelay; approx.);
//   head: how often the aim point is the head rather than the chest (approx.);
//   comp: how much of the recoil they pull down (approx.);
//   stiff / damp / accel: the look spring (CS:GO's LookAngleStiffness / Damping / MaxAccel
//     Attacking; values approx.): a weak, underdamped spring overshoots the target and
//     wobbles back, a stiff one snaps to it;
//   slack: extra degrees off the aim point they fire at (the weak fire before settled);
//   burst / rest: scale of the burst length and of the pause between bursts;
//   tap: seconds between pistol / sniper trigger pulls (approx.);
//   memory: seconds a lost enemy's last place is hunted;
//   track: keep an enemy that leaves the view cone in sight (the strong turn with him);
//   strafe: sidestep while spraying up close.
const SKILL = [
  { skill: 0, reaction: 0.5, delay: 0.4, focus: 5, head: 0.05, comp: 0, stiff: 60, damp: 9, accel: 900, slack: 2,
    burst: 0.4, rest: 2, tap: 0.35, memory: 2, track: false, strafe: false },
  { skill: 0.5, reaction: 0.4, delay: 0.15, focus: 2.5, head: 0.25, comp: 0.3, stiff: 160, damp: 20, accel: 3000,
    slack: 1, burst: 0.7, rest: 1.4, tap: 0.25, memory: 3, track: false, strafe: false },
  { skill: 0.75, reaction: 0.25, delay: 0, focus: 2, head: 0.5, comp: 0.6, stiff: 350, damp: 28, accel: 7000,
    slack: 0.4, burst: 1, rest: 1, tap: 0.18, memory: 4, track: true, strafe: true },
  { skill: 0.9, reaction: 0.2, delay: 0, focus: 2, head: 0.8, comp: 0.85, stiff: 600, damp: 34, accel: 12000,
    slack: 0.2, burst: 1.3, rest: 0.8, tap: 0.13, memory: 5, track: true, strafe: true },
];
const AIM_ERROR = 5.7; // degrees at accuracy 0 (CS:GO: a tenth of the range, at the target)
const FOCUS_MAX = 0.75; // how accurate looking long can make anyone
const AIM_GLIDE = 0.15; // per tick, the aim offset's share of the way to its goal (approx.)
const LOOK_WALK = { stiff: 250, damp: 28, accel: 6000 }; // the look spring while walking (approx.)

// CS:GO's bot names (a few of botprofile.db's).
const NAMES = ['Albert', 'Allen', 'Bert', 'Bob', 'Cecil', 'Clarence', 'Elliot', 'Elmer', 'Ernie', 'Eugene', 'Fergus',
  'Ferris', 'Frank', 'Frasier', 'Fred', 'George', 'Graham', 'Harvey', 'Irwin', 'Lester', 'Marvin', 'Neil', 'Niles',
  'Oliver', 'Opie', 'Ringo', 'Ron', 'Ross', 'Sam', 'Sid', 'Steve', 'Ted', 'Vern', 'Vinny', 'Wade', 'Walt', 'Yogi',
  'Zach'];

const PERCEIVE_TICKS = 4; // how often a bot looks for enemies (staggered)
const LOOKAHEAD_TICKS = 4; // how often it looks for a shortcut along its path
const LOOKAHEAD = 10; // waypoints a shortcut may skip
const HEAR_RANGE = 1800; // gunfire heard this far (approx.)
const KNIFE_REACH = 56; // units (2D, center to center) from which a bot slashes (approx.)
const ARRIVE = 20; // units from a waypoint that count as there
const PATH_MAX = 1024;
const HOLD_MIN = 8, HOLD_MAX = 16; // seconds at a spot before picking another in the same area (approx.)
const REPATH_FAIL = 2; // seconds before a failed path search is tried again

export class Bots {
  constructor(game) {
    this.game = game;
    this.list = []; // Bot
    this.nav = null; // built with the first bot
    this.writer = new Writer();
    this.random = Math.random;
    this.tSite = 0; // teamSite(): the Terrorists' site in round siteRound (RoundState.serial)
    this.siteRound = -1;
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
    let want = Math.max(0, r.botQuotaMode === 'fill' ? r.botQuota - humans : r.botQuota);
    if (r.teamSizeMax) want = Math.min(want, Math.max(0, 2 * r.teamSizeMax - humans)); // Wingman: 2 a side
    if (this.list.length < want) this.add(teamFor(r.botJoinTeam), -1);
    else if (this.list.length > want) this.kick(null, this.largerTeam());
  }

  // The team with more players (humans count: a bot leaves the side that has one too many).
  largerTeam() {
    let t = 0, ct = 0;
    for (const c of this.game.clients) if (c && c.joined && c.playing) c.team === TEAM_CT ? ct++ : t++;
    return ct > t ? TEAM_CT : TEAM_T;
  }

  // The bomb site the Terrorists go for this round: one for all of them, as CS:GO's bots
  // pick one together (each picking its own sent the carrier in alone, and it died on the way).
  teamSite() {
    const g = this.game, n = g.bombSites.count;
    if (!n) return 0;
    if (this.siteRound !== g.round.serial) {
      this.siteRound = g.round.serial;
      this.tSite = Math.floor(this.random() * n);
    }
    return this.tSite;
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
    this.vPitch = 0; // the look spring's speed (degrees / s)
    this.vYaw = 0;
    this.life = -1; // the client's life this state is for
    this.path = new Int32Array(PATH_MAX);
    this.pathLen = 0;
    this.pathIdx = 0;
    this.pathFailed = false; // the last search found no way (retried after REPATH_FAIL)
    this.arrivedAt = -1; // tick the path's end was reached, -1 while under way
    this.holdTicks = 0; // how long to stay at that spot before picking another nearby
    this.goal = -1; // node
    this.goalWhy = ''; // what the goal is for (a new reason makes a new path)
    this.repathAt = 0;
    this.enemy = null; // Client being fought
    this.lastEnemy = null; // the last one fought (seen again soon: a shorter reaction)
    this.seenAt = -1e9; // tick the enemy was last seen
    this.reactAt = 0; // tick he may shoot from
    this.acquiredAt = 0; // tick he first saw this enemy (the focus grows from there)
    this.aimAt = 0; // tick to pick a new aim offset goal
    this.aimHead = false; // aiming at the head (else the chest)
    this.goalP = 0; // aim offset goal (degrees)
    this.goalY = 0;
    this.offP = 0; // the current aim offset, gliding to its goal
    this.offY = 0;
    this.lastX = 0; // where he was last seen / heard
    this.lastY = 0;
    this.lastZ = 0;
    this.burst = 0; // shots left in this burst
    this.restUntil = 0; // tick the next burst may start
    this.stuckAt = 0; // tick of the last progress check
    this.stuckWp = -1; // the waypoint the progress is measured to
    this.stuckBest = Infinity; // the nearest we have been to it
    this.stuck = 0; // checks in a row without progress
    this.jumpAt = 0; // tick a jump edge may be tried (again)
    this.jumpTick = -1e9; // tick of the last jump press (the duck follows it in the air)
    this.lookAt = 0; // tick to pick a new idle look direction
    this.idleYaw = 0;
    this.site = 0; // bomb site this round
    this.bought = -1; // the life it bought in
    this.steerOut = { moveYaw: null, buttons: 0, lookYaw: null, lookPitch: 0, sidestep: 0 };
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
    this.pathFailed = false;
    this.arrivedAt = -1;
    this.goal = -1;
    this.goalWhy = '';
    this.enemy = this.lastEnemy = null;
    this.seenAt = -1e9;
    this.yaw = this.c.spawnYaw;
    this.pitch = 0;
    this.vPitch = this.vYaw = 0;
    this.stuck = 0;
    this.site = this.bots.teamSite();
  }

  // Returns [buttons, weapon slot to select or -1].
  decide() {
    const c = this.c, g = this.game, p = c.player, f = p.ps.f, sk = this.skill;
    const x = f[PS_ORIGIN], y = f[PS_ORIGIN + 1], feet = f[PS_ORIGIN + 2] - feetOffset(p.ps.i[PS_FLAGS]);
    const eye = f[PS_ORIGIN + 2] + eyeOffset(p.ps);
    if (this.bought !== c.life && g.canBuy(c)) this.buy();
    if ((g.tick + c.id) % PERCEIVE_TICKS === 0) this.perceive(x, y, eye);

    let buttons = 0, select = this.weaponSlot();
    let wantP = this.pitch, wantY = this.yaw, move = true, strafe = 0;
    const fighting = this.enemy && this.enemy.alive && g.tick - this.seenAt < TICK_RATE / 2;
    if (fighting) {
      const e = this.enemy, ef = e.player.ps.f;
      this.updateAim();
      // Lead nothing; aim at the head or the chest, plus the offset that wanders and settles.
      const tFeet = ef[PS_ORIGIN + 2] - feetOffset(e.player.ps.i[PS_FLAGS]);
      const tz = tFeet + (this.aimHead ? 64 : 47) * crouchScale(ef[PS_DUCK_AMOUNT]);
      [wantP, wantY] = angles(x, y, eye, ef[PS_ORIGIN], ef[PS_ORIGIN + 1], tz);
      wantP += this.offP;
      wantY += this.offY;
      // Pull down part of the recoil: the shot goes along the view plus the aim punch.
      wantP -= p.ws.f[WS_PUNCH] * RECOIL_SCALE * sk.comp;
      wantY -= p.ws.f[WS_PUNCH + 1] * RECOIL_SCALE * sk.comp;
      const dist = Math.hypot(ef[PS_ORIGIN] - x, ef[PS_ORIGIN + 1] - y);
      const off = Math.hypot(angleDiff(wantY, this.yaw), wantP - this.pitch);
      const tolerance = Math.atan2(14, dist) / DEG + 0.6 + sk.slack;
      // A hostage in the way: hold fire and keep going (CS:GO's bots do not shoot them).
      const clear = !this.hostageInLine(x, y, eye, ef[PS_ORIGIN], ef[PS_ORIGIN + 1], tz);
      move = !clear || g.rules.botDontShoot; // else stand still to shoot straight (CS:GO's bots stop too)
      if (clear && !g.rules.botDontShoot && g.tick >= this.reactAt && off < tolerance) buttons |= this.trigger(dist);
      const knife = activeWeapon(p.ws)?.melee;
      if (knife) { // only a knife (Arms Race's last level): run at him, slash in reach
        move = false;
        buttons |= IN_FORWARD;
        if (clear && !g.rules.botDontShoot && g.tick >= this.reactAt && dist < KNIFE_REACH) buttons |= IN_ATTACK;
      } else if (clear && dist < 300 && sk.strafe) { // close: strafe while spraying (approx.)
        move = false;
        strafe = (g.tick >> 5) & 1 ? 1 : -1;
      }
    }

    // Where to go (bots told not to shoot keep to it, watching the enemy).
    if (!fighting || g.rules.botDontShoot) {
      const goal = this.objective(x, y, feet);
      let repath = goal.node !== this.goal || goal.why !== this.goalWhy;
      if (this.pathFailed && g.tick < this.repathAt) repath = false; // no way found: not searched again for a while
      else if (!repath && goal.moving && g.tick >= this.repathAt) repath = true;
      if (repath) {
        this.goal = goal.node;
        this.goalWhy = goal.why;
        const nav = this.bots.nav, from = nav.nodeAt(x, y, feet);
        this.pathLen = nav.path(from, goal.node, this.path);
        this.pathIdx = 1;
        this.arrivedAt = -1;
        this.pathFailed = goal.node >= 0 && this.pathLen === 0;
        this.repathAt = g.tick + (this.pathFailed ? REPATH_FAIL : 1) * TICK_RATE;
        if (this.pathFailed) this.goal = -1; // an area goal picks another spot next time
      }
      if (goal.action) {
        buttons |= goal.action;
        move = false;
        if (goal.select >= 0) select = goal.select;
        if (goal.look) [wantP, wantY] = angles(x, y, eye, goal.look[0], goal.look[1], goal.look[2]);
      }
    }
    let moveYaw = null;
    if (move) {
      const steer = this.steer(x, y, feet, (p.ps.i[PS_FLAGS] & FL_ONGROUND) !== 0);
      buttons |= steer.buttons;
      moveYaw = steer.moveYaw;
      strafe = steer.sidestep;
      if (!fighting && steer.lookYaw !== null) {
        wantY = steer.lookYaw;
        wantP = steer.lookPitch;
      }
    }
    if (this.pathIdx >= this.pathLen && this.arrivedAt < 0) this.arrivedAt = g.tick;
    if (!fighting && this.pathIdx >= this.pathLen && !(buttons & (IN_USE | IN_ATTACK))) [wantP, wantY] = this.idleLook();

    // Reload when empty, or with half a magazine and nobody around.
    const w = activeWeapon(p.ws), o = WS_SLOTS + p.ws.f[WS_ACTIVE] * 3;
    if (w && w.clip && !p.ws.f[WS_RELOAD_END] && (p.ws.f[o + 1] === 0 || (!fighting && p.ws.f[o + 1] < w.clip / 2))) {
      buttons |= IN_RELOAD;
    }
    this.turn(wantP, wantY, fighting);
    // Movement keys relative to the view as it is now sent (forward is along the view).
    if (moveYaw !== null) buttons |= moveKeys(moveYaw, this.yaw);
    if (strafe) buttons |= strafe > 0 ? IN_MOVELEFT : IN_MOVERIGHT;
    return [buttons, select];
  }

  // Looks for enemies (the spotting test: view cone, no wall or smoke) and listens for
  // gunfire (the nearest unsilenced shooter); a new enemy starts the reaction time and
  // the focus, one seen again within a moment a shorter reaction.
  perceive(x, y, eye) {
    const c = this.c, g = this.game, sk = this.skill;
    let best = null, bestD = Infinity, loud = null, loudD = Infinity;
    for (const o of g.clients) {
      if (!o || !o.joined || !o.alive || !o.playing || !g.isEnemy(c, o)) continue;
      const of = o.player.ps.f, d = Math.hypot(of[PS_ORIGIN] - x, of[PS_ORIGIN + 1] - y, of[PS_ORIGIN + 2] - eye);
      const tracked = sk.track && o === this.enemy && g.tick - this.seenAt < TICK_RATE;
      const inSight = tracked ? g.visible(c, o) : g.sees(c, o);
      if (inSight) {
        if (d < bestD) {
          best = o;
          bestD = d;
        }
      } else if (g.tick < o.revealUntil && d < HEAR_RANGE && d < loudD) {
        loud = o;
        loudD = d;
      }
    }
    if (!best) {
      // Gunfire with nobody in sight (not just lost: the fight goes on for half a second).
      if (loud && g.tick - this.seenAt >= TICK_RATE / 2) {
        const of = loud.player.ps.f;
        this.heard(of[PS_ORIGIN], of[PS_ORIGIN + 1], of[PS_ORIGIN + 2]);
      }
      return;
    }
    if (best !== this.enemy || g.tick - this.seenAt > TICK_RATE) {
      const again = best === this.lastEnemy && g.tick - this.seenAt < 2 * TICK_RATE;
      this.enemy = this.lastEnemy = best;
      if (!again) this.acquiredAt = g.tick;
      const react = (sk.reaction + sk.delay) * (again ? 0.5 : 1) * (0.8 + 0.4 * this.bots.random());
      this.reactAt = g.tick + Math.round(react * TICK_RATE);
      this.vYaw = this.vPitch = 0; // the look stops where it is, then swings to him (else a swing under way carried a weak spring past him)
      this.aimAt = 0; // a fresh offset at once
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

  // The aim offset (CS:GO's SetAimOffset / UpdateAimOffset): every so often a new goal
  // within the error of the current accuracy (the profile's skill, or the focus of having
  // looked at him for a while, whichever is better), the offset gliding toward it; and
  // whether the head or the chest is the aim point.
  updateAim() {
    const g = this.game, sk = this.skill, rnd = this.bots.random;
    if (g.tick >= this.aimAt) {
      const focus = Math.min(FOCUS_MAX, (g.tick - this.acquiredAt) / TICK_RATE / sk.focus);
      const error = AIM_ERROR * (1 - Math.max(sk.skill, focus));
      this.goalP = (rnd() * 2 - 1) * error * 0.6;
      this.goalY = (rnd() * 2 - 1) * error;
      this.aimHead = rnd() < sk.head;
      this.aimAt = g.tick + Math.round((0.25 + 0.35 * rnd()) * TICK_RATE);
    }
    this.offP += (this.goalP - this.offP) * AIM_GLIDE;
    this.offY += (this.goalY - this.offY) * AIM_GLIDE;
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

  // Fire control: pistols and snipers tap (slower, the weaker); rifles burst at range and
  // spray up close, shorter bursts and longer rests at low skill.
  trigger(dist) {
    const g = this.game, p = this.c.player, w = activeWeapon(p.ws), sk = this.skill;
    if (!w || w.melee || !w.clip || g.tick < this.restUntil) return 0;
    if (!w.auto) {
      const every = Math.max(2, Math.round(sk.tap * TICK_RATE));
      return g.tick % every === 0 ? IN_ATTACK : 0; // a press, then released: it fires on the press
    }
    if (this.burst <= 0) this.burst = Math.max(1, Math.round((dist > 1400 ? 1 : dist > 700 ? 3 : 8) * sk.burst));
    const shotTicks = Math.max(1, Math.round(w.cycle * TICK_RATE));
    if (g.tick % shotTicks === 0 && --this.burst <= 0) {
      this.restUntil = g.tick + Math.round((dist > 1400 ? 0.45 : dist > 700 ? 0.35 : 0.2) * sk.rest * TICK_RATE);
    }
    return IN_ATTACK;
  }

  // Swings the view toward (pitch, yaw): a spring with damping and a top acceleration
  // (CS:GO's look angle spring), the skill's in a fight, a stiff one while walking.
  turn(wantP, wantY, attacking) {
    const sk = attacking ? this.skill : LOOK_WALK;
    const dy = angleDiff(wantY, this.yaw), dp = wantP - this.pitch;
    let ay = sk.stiff * dy - sk.damp * this.vYaw, ap = sk.stiff * dp - sk.damp * this.vPitch;
    const a = Math.sqrt(ay * ay + ap * ap);
    if (a > sk.accel) {
      ay *= sk.accel / a;
      ap *= sk.accel / a;
    }
    this.vYaw += ay * TICK_DT;
    this.vPitch += ap * TICK_DT;
    this.yaw = (this.yaw + this.vYaw * TICK_DT + 360) % 360;
    this.pitch = Math.max(-89, Math.min(89, this.pitch + this.vPitch * TICK_DT));
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
    // The spot picked before for this area goal, or -1 for a new one: at first, and after
    // standing there a while (a bot that held one spot all round was easy prey).
    const keep = (why) => {
      if (this.goalWhy !== why || this.goal < 0) return -1;
      if (this.arrivedAt >= 0 && g.tick - this.arrivedAt > this.holdTicks) {
        this.holdTicks = Math.round((HOLD_MIN + rnd() * (HOLD_MAX - HOLD_MIN)) * TICK_RATE);
        return -1;
      }
      return this.goal;
    };
    // Hunt the last place an enemy was seen or heard (not when told not to shoot, nor with
    // the bomb: the carrier keeps going for the site).
    const carrier = c.player.ws.f[WS_SLOTS + SLOT_C4 * 3] > 0;
    const memory = this.skill.memory * TICK_RATE;
    if (g.tick - this.seenAt < memory && this.lastX && !g.rules.botDontShoot && !carrier) {
      // The place is looked up once a second (gunfire updates it every few ticks).
      const due = this.goalWhy !== 'hunt' || g.tick >= this.repathAt;
      return { node: due ? nav.nodeAt(this.lastX, this.lastY, this.lastZ - 36) : this.goal, why: 'hunt', moving: true };
    }
    if (g.phase !== PHASE_LIVE && g.phase !== PHASE_WARMUP) return { node: -1, why: 'wait' };
    const bomb = g.bomb, f = c.player.ps.f;
    if (!g.rules.deathmatch && g.bombSites.count && g.rules.giveC4) {
      const site = g.bombSites.boxes[this.site % g.bombSites.count];
      if (c.team === TEAM_T) {
        if (carrier) { // the bomb: to the site, then plant
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
      if (bomb.state === BOMB_PLANTED) { // the nearest CT defuses, the others cover it from around
        if (this.nearestTo(bomb.x, bomb.y, TEAM_CT) !== c) {
          return { node: keep('cover') >= 0 ? this.goal : this.near(bomb.x, bomb.y, bomb.z, 400), why: 'cover' };
        }
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
  // the direction to walk in, jumps and ladders on their edges, crouching where only
  // that fits, unsticking. Returns { moveYaw (null: nowhere to go), buttons, lookYaw,
  // lookPitch, sidestep }.
  steer(x, y, feet, onGround) {
    const nav = this.bots.nav, g = this.game, P = this.path, out = this.steerOut;
    out.moveYaw = null;
    out.buttons = 0;
    out.lookYaw = null;
    out.lookPitch = 0;
    out.sidestep = 0;
    if (this.pathIdx >= this.pathLen) return out;
    const at = (k) => Math.hypot(nav.x[k] - x, nav.y[k] - y) < ARRIVE && Math.abs(nav.z[k] - feet) < 48;
    while (this.pathIdx < this.pathLen - 1 && at(P[this.pathIdx])) this.pathIdx++;
    if ((g.tick + this.c.id) % LOOKAHEAD_TICKS === 0) { // shortcut: skip waypoints we can walk straight to
      // ...as far as the path is plain walking (no jump or ladder edge skipped).
      let far = this.pathIdx;
      if (far === 0 || nav.edge(P[far - 1], P[far]) === EDGE_WALK) {
        const last = Math.min(this.pathLen - 1, this.pathIdx + LOOKAHEAD);
        while (far < last && nav.edge(P[far], P[far + 1]) === EDGE_WALK) far++;
      }
      for (let j = far; j > this.pathIdx; j--) {
        if (nav.direct(x, y, feet, nav.x[P[j]], nav.y[P[j]], nav.z[P[j]])) {
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
    out.moveYaw = Math.atan2(ty - y, tx - x) / DEG;
    out.lookYaw = out.moveYaw;
    out.lookPitch = edge === EDGE_LADDER ? -60 : 0;
    if (edge === EDGE_JUMP && d < 56) { // crouch jump up: a press (held, it never jumps again), ducking in the air, tried again if it failed
      if (onGround && g.tick >= this.jumpAt) {
        out.buttons |= IN_JUMP;
        this.jumpTick = g.tick;
        this.jumpAt = g.tick + Math.round(0.4 * TICK_RATE);
      } else if (g.tick > this.jumpTick && g.tick - this.jumpTick < TICK_RATE) out.buttons |= IN_DUCK;
    }
    if (nav.flags[k] & NODE_CROUCH) out.buttons |= IN_DUCK;
    // Stuck: no progress toward the waypoint for half a second (progress, not movement:
    // the wiggle below moved us without getting anywhere, and reset the count). Then use a
    // door, jump and wiggle sideways, then find a new way, then give up on this goal.
    if (k !== this.stuckWp) {
      this.stuckWp = k;
      this.stuckBest = d;
      this.stuckAt = g.tick;
      this.stuck = 0;
    } else if (g.tick - this.stuckAt >= TICK_RATE / 2) {
      this.stuck = d < this.stuckBest - 12 ? 0 : this.stuck + 1;
      this.stuckBest = Math.min(this.stuckBest, d);
      this.stuckAt = g.tick;
      if (this.stuck === 4) this.repathAt = 0, this.goalWhy = '';
      if (this.stuck >= 8) {
        this.goalWhy = '';
        this.goal = -1;
        this.stuck = 0;
      }
    }
    if (this.stuck >= 1 && (g.tick - this.stuckAt) < 4 && this.doorAhead(x, y, feet)) out.buttons |= IN_USE; // a use-only door or a button
    else if (this.stuck >= 2) {
      if ((g.tick - this.stuckAt) < 2) out.buttons |= IN_JUMP | IN_DUCK;
      out.sidestep = this.stuck & 1 ? 1 : -1;
    }
    return out;
  }
}

// Movement keys (8 ways) for walking toward moveYaw while looking along viewYaw.
function moveKeys(moveYaw, viewYaw) {
  const oct = Math.round(angleDiff(moveYaw, viewYaw) / 45);
  let b = 0;
  if (Math.abs(oct) <= 1) b |= IN_FORWARD;
  if (Math.abs(oct) >= 3) b |= IN_BACK;
  if (oct >= 1 && oct <= 3) b |= IN_MOVELEFT;
  if (oct <= -1 && oct >= -3) b |= IN_MOVERIGHT;
  return b;
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
