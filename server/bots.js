// Bots: server-side players that think every tick and feed their own user commands into
// the same simulation as everyone else (so they obey the exact movement, weapons and
// rules). They find their way on the navigation graph generated from the map
// (shared/nav.js) and play the objective (plant, defuse, rescue, guard; roam in
// deathmatch), see enemies like the radar's spotting does (view cone, walls, smoke), hear
// gunfire, react after a delay, swing their view toward the target like a spring (the
// weak ones overshoot), aim with an error that wanders and shrinks the longer they look
// (CS:GO's aim offset and focus), fire in bursts by distance and skill, pull down part
// of the recoil, scope a sniper rifle before a far shot, throw an HE or a flashbang at
// the place an enemy was lost, press the button that opens a door on their way, and buy
// at round start. Skill by bot_difficulty 0-3: the numbers follow CS:GO's bot profile
// templates (botprofile.db: Easy, Normal, Hard, Expert) where we know them and are
// estimates (approx.) elsewhere.

import {
  TICK_RATE, TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_ATTACK, IN_ATTACK2, IN_USE,
  IN_RELOAD,
} from '../shared/constants.js';
import { PS_ORIGIN, PS_FLAGS, PS_DUCK_AMOUNT, FL_ONGROUND, eyeOffset } from '../shared/pmove.js';
import { feetOffset, crouchScale } from '../shared/hitgroups.js';
import { HULL_POINT, Trace, traceHull } from '../shared/trace.js';
import {
  WEAPONS, WEAPON_ID, WS_SLOTS, WS_ACTIVE, WS_PUNCH, WS_RELOAD_END, WS_ACTION, WS_ZOOM, WS_RESUME_ZOOM, WS_DEPLOY_END,
  WS_THROW, WS_THROW_TIME, WS_GRENADES, GRENADE_IDS, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_GRENADE, SLOT_C4, activeWeapon,
  ACTION_DEFUSE,
} from '../shared/weapons.js';
import { GRENADE_GRAVITY } from '../shared/grenades.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { BOMB_DROPPED, BOMB_PLANTED } from '../shared/bomb.js';
import { HS_IDLE } from '../shared/hostages.js';
import { PHASE_LIVE, PHASE_WARMUP, ITEM_ASSAULTSUIT, ITEM_KEVLAR, ITEM_DEFUSER, itemPrice } from '../shared/economy.js';
import { Nav, NAV_CELL, NODE_CROUCH, EDGE_WALK, EDGE_JUMP, EDGE_LADDER } from '../shared/nav.js';
import { Writer, writeHello, radioIndex } from '../shared/protocol.js';

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
// Sniper rifles (AWP, SSG 08, SCAR-20, G3SG1: two scope levels): scoped for an enemy
// farther than SCOPE_DIST, firing SCOPE_SETTLE after scoping (a quick scope is still
// inaccurate), unscoped out of a fight; hard and expert bots with AWP_MONEY buy an AWP one
// round in three, one per team (approx. of CS:GO's profile weapon preferences).
const SCOPE_DIST = 250;
const SCOPE_SETTLE = 0.3;
const AWP_MONEY = 5400;
// Grenades (normal and up): an HE at the place an enemy was lost (or a shooter heard)
// NADE_LOST_MIN..MAX seconds ago and HE_RANGE away, else a flashbang within FLASH_RANGE,
// one throw per loss and at most one every NADE_COOLDOWN seconds; the throw takes the
// pin out once the grenade is up and the view is on the arc, and is given up after
// NADE_TIMEOUT. A flashbang's thrower looks away from it for AVERT seconds (approx.: CS:GO's
// bots flash themselves). A bot with more than BLIND seconds of flash left sees nobody.
const NADE_LOST_MIN = 0.5, NADE_LOST_MAX = 3;
const HE_RANGE = [300, 1200], FLASH_RANGE = [200, 800];
const NADE_COOLDOWN = 6;
const NADE_TIMEOUT = 3;
const NADE_ARC_ERROR = 60; // units the solved arc may miss the spot by
const AVERT = 1.6;
const BLIND = 0.3;
// Smokes and molotovs (normal and up; approx. of CS:GO's bots, which throw from spots the
// maps' nav files mark): at a lost enemy, a molotov (CTs: an incendiary) within MOLLY_RANGE
// when no HE fits, and a CT's smoke within SMOKE_RANGE when nothing else does (Ts pushing in:
// their way blocked); a T's molotov on the planted bomb while a CT is heard defusing it
// (within HEAR_RANGE, the bomb within MOLLY_BOMB); the Ts' smoke on the CT side of their
// site, the place SMOKE_AHEAD along the way from the site toward the nearest CT spawn, once
// a team a round, as a T comes within SMOKE_EXEC of the site (tried once a second).
const MOLLY_RANGE = [250, 900], SMOKE_RANGE = [400, 1400], MOLLY_BOMB = 1100;
const SMOKE_EXEC = [300, 1500], SMOKE_AHEAD = 400;
const SMOKE_ROLL = 220; // a smoke bounces and rolls on before it pops: aimed this much short
// Radio (approx. of CS:GO's bots): a human's "Follow me." / "Regroup, team!" sends the
// team's bots within ORDER_REACH after him for ORDER_SECONDS (stopping FOLLOW_NEAR away),
// "Hold this position." keeps them where they stand; a bot calls "Enemy spotted." on a new
// enemy, at most once a team every CALL_GAP seconds, and "Enemy down." after a kill now and
// then (DOWN_CHANCE).
const ORDER_REACH = 1500, ORDER_SECONDS = 20, FOLLOW_NEAR = 120;
const CALL_GAP = 12, DOWN_CHANCE = 0.3;
const ENEMY_SPOTTED = radioIndex('enemyspot'), ENEMY_DOWN = radioIndex('enemydown');
// A closed door a button opens within BUTTON_LOOKAHEAD waypoints and BUTTON_RANGE units
// along the path sends the bot to the button first (given up after BUTTON_TIMEOUT).
const BUTTON_LOOKAHEAD = 8;
const BUTTON_RANGE = 500;
const BUTTON_TIMEOUT = 8;
const USE_REACH = 60; // from the origin to the button's box (PlayerUse: 64)

export class Bots {
  constructor(game) {
    this.game = game;
    this.list = []; // Bot
    this.nav = null; // built with the first bot
    this.writer = new Writer();
    this.random = Math.random;
    this.tSite = 0; // teamSite(): the Terrorists' site in round siteRound (RoundState.serial)
    this.siteRound = -1;
    this.smokeSpots = []; // per bomb site: smokeSpot()'s place, null for none
    this.smokedRound = -1; // the round (RoundState.serial) the Ts smoked their site's CT side
    this.calledAt = { [TEAM_T]: -1e9, [TEAM_CT]: -1e9 }; // tick a bot of the team last called an enemy
  }

  // A radio line from `from` (a human, Game.radio): orders for the team's bots near him.
  radio(from, cmd) {
    if (from.bot) return;
    const kind = cmd === 'followme' || cmd === 'regroup' ? 'follow' : cmd === 'holdpos' ? 'hold' : null;
    if (!kind) return;
    const g = this.game, ff = from.player.ps.f;
    for (const b of this.list) {
      const c = b.c, f = c.player.ps.f;
      if (!c.alive || c.team !== from.team || Math.hypot(f[PS_ORIGIN] - ff[PS_ORIGIN], f[PS_ORIGIN + 1] - ff[PS_ORIGIN + 1]) > ORDER_REACH) continue;
      b.order = { kind, who: from, until: g.tick + ORDER_SECONDS * TICK_RATE, x: f[PS_ORIGIN], y: f[PS_ORIGIN + 1], z: f[PS_ORIGIN + 2] - 36 };
    }
  }

  // A bot of ours killed someone: "Enemy down." now and then.
  killed(c) {
    if (this.random() < DOWN_CHANCE) this.game.radio(c, ENEMY_DOWN);
  }

  ensureNav() {
    if (!this.nav) {
      const t = performance.now();
      // Paths go through the doors a player can open (walking into them, +use, triggers,
      // a button: the bot goes and presses it, `buttonDoors`).
      const { doors, logic } = this.game;
      const open = new Set(), buttons = doors.buttonTargets();
      this.buttonDoors = [];
      for (let k = 0; k < doors.count; k++) {
        if (!doors.opens(k, logic.named, buttons)) continue;
        open.add(doors.bspEntity[k]);
        if (!logic.named.has(doors.name[k]) && buttons.has(doors.name[k])) this.buttonDoors.push({ door: k, button: doors.buttonFor(doors.name[k]) });
      }
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
  // Does a living player of `team` hold a sniper rifle (two scope levels)?
  teamHasSniper(team) {
    for (const o of this.game.clients) {
      if (!o || !o.joined || !o.alive || o.team !== team) continue;
      const w = WEAPONS[o.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3]];
      if (w && w.zoomLevels >= 2) return true;
    }
    return false;
  }

  // The nav node nearest to a point within r (2D) and 72 up or down, or -1.
  nearestNode(x, y, z, r) {
    const nav = this.nav;
    let best = -1, bestD = r;
    for (let k = 0; k < nav.count; k++) {
      if (Math.abs(nav.z[k] - z) > 72) continue;
      const d = Math.hypot(nav.x[k] - x, nav.y[k] - y);
      if (d < bestD) [best, bestD] = [k, d];
    }
    return best;
  }

  // The place to smoke on the CT side of bomb site i: SMOKE_AHEAD along the bots' way from
  // inside the site toward the nearest CT spawn (where the CTs come in), [x, y, floor] or
  // null; worked out once a map.
  smokeSpot(i) {
    if (this.smokeSpots[i] !== undefined) return this.smokeSpots[i];
    const g = this.game, nav = this.ensureNav(), b = g.bombSites.boxes[i];
    const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2;
    let spawn = null, best = Infinity;
    for (const sp of g.spawns[TEAM_CT]) {
      const d = Math.hypot(sp[0] - cx, sp[1] - cy);
      if (d < best) [spawn, best] = [sp, d];
    }
    let spot = null;
    const from = nav.random(() => 0.5, b), to = spawn ? this.nearestNode(spawn[0], spawn[1], spawn[2] - 36, 300) : -1;
    const path = new Int32Array(PATH_MAX), n = nav.path(from, to, path);
    for (let k = 1, run = 0; k < n; k++) {
      run += Math.hypot(nav.x[path[k]] - nav.x[path[k - 1]], nav.y[path[k]] - nav.y[path[k - 1]]);
      if (run >= SMOKE_AHEAD) {
        spot = [nav.x[path[k]], nav.y[path[k]], nav.z[path[k]]];
        break;
      }
    }
    return (this.smokeSpots[i] = spot);
  }

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
    this.zoomWas = 0; // the scope level seen last tick
    this.scopeAt = -1e9; // tick of the last scope press (one press, then a few ticks off)
    this.scopedAt = 0; // tick the scope came up
    this.nade = null; // a throw under way: { id, pitch, yaw, phase, hold, until }
    this.nadeAt = 0; // tick the next throw may start
    this.nadeFor = -1; // the seenAt a throw was considered for (one per loss)
    this.avertUntil = 0; // looking away from our flashbang until then
    this.playAt = 0; // tick considerPlay() may try a smoke at the site again
    this.order = null; // a teammate's radio order: { kind: 'follow' | 'hold', who, until, x, y, z }
    this.avertYaw = 0;
    this.pressButton = -1; // the button to press for a door on our way, its door, the node by it
    this.pressDoor = -1;
    this.pressNode = -1;
    this.pressUntil = 0;
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
    this.nade = null;
    this.pressButton = -1;
    this.avertUntil = 0;
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
    const held = activeWeapon(p.ws), ws = p.ws.f;
    const zoom = ws[WS_ZOOM] || ws[WS_RESUME_ZOOM]; // the bolt drops the scope for a moment: still scoped
    if (zoom > 0 && !this.zoomWas) this.scopedAt = g.tick;
    this.zoomWas = zoom;
    if (this.nade && fighting && this.nade.phase === 0) this.nade = null; // an enemy in sight before the pin: the gun comes back
    if (this.nade) {
      [buttons, select] = this.throwing();
      move = false;
      wantP = this.nade ? this.nade.pitch : wantP;
      wantY = this.nade ? this.nade.yaw : wantY;
    } else if (fighting) {
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
      // A sniper rifle: scope for a far enemy, then let the scope settle before the shot.
      let mayFire = true;
      if (held && held.zoomLevels >= 2) {
        if (zoom === 0 && dist > SCOPE_DIST && g.tick - this.scopeAt > 4) {
          buttons |= IN_ATTACK2;
          this.scopeAt = g.tick;
        }
        mayFire = zoom === 0 ? dist <= SCOPE_DIST : g.tick - this.scopedAt >= SCOPE_SETTLE * TICK_RATE;
      }
      if (clear && !g.rules.botDontShoot && g.tick >= this.reactAt && off < tolerance && mayFire) buttons |= this.trigger(dist);
      const knife = held?.melee;
      if (knife) { // only a knife (Arms Race's last level): run at him, slash in reach
        move = false;
        buttons |= IN_FORWARD;
        if (clear && !g.rules.botDontShoot && g.tick >= this.reactAt && dist < KNIFE_REACH) buttons |= IN_ATTACK;
      } else if (clear && dist < 300 && sk.strafe) { // close: strafe while spraying (approx.)
        move = false;
        strafe = (g.tick >> 5) & 1 ? 1 : -1;
      }
    }

    // Out of a fight a sniper comes out of its scope (it walks at 100 in it).
    if (!fighting && !this.nade && zoom > 0 && g.tick - this.scopeAt > 4) {
      buttons |= IN_ATTACK2;
      this.scopeAt = g.tick;
    }
    // Where to go (bots told not to shoot keep to it, watching the enemy).
    if (!this.nade && (!fighting || g.rules.botDontShoot)) {
      const goal = this.pressButton >= 0 ? this.buttonGoal(x, y, feet) : this.objective(x, y, feet);
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
      if (goal.action || goal.stop) {
        buttons |= goal.action || 0;
        move = false;
        if (goal.select >= 0) select = goal.select;
        if (goal.look) [wantP, wantY] = angles(x, y, eye, goal.look[0], goal.look[1], goal.look[2]);
      } else if (!fighting && this.difficulty >= 1 && !g.rules.botDontShoot && (p.ps.i[PS_FLAGS] & FL_ONGROUND)) {
        if (!this.considerPlay(x, y, eye)) this.considerThrow(x, y, eye);
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
    if (!fighting && !this.nade && this.pathIdx >= this.pathLen && !(buttons & (IN_USE | IN_ATTACK))) [wantP, wantY] = this.idleLook();
    if (!fighting && !this.nade && g.tick < this.avertUntil) { // our flashbang is about to pop over there
      wantY = this.avertYaw;
      wantP = 0;
    }

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

  // Looks for enemies (the spotting test: view cone, no wall or smoke; nothing while
  // flashed) and listens for gunfire (the nearest unsilenced shooter); a new enemy starts
  // the reaction time and the focus, one seen again within a moment a shorter reaction.
  perceive(x, y, eye) {
    const c = this.c, g = this.game, sk = this.skill;
    if (c.flashLeft > BLIND) return;
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
      const called = this.bots.calledAt;
      if (!again && !g.rules.deathmatch && g.tick - called[this.c.team] > CALL_GAP * TICK_RATE) {
        called[this.c.team] = g.tick;
        g.radio(this.c, ENEMY_SPOTTED);
      }
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

  // --- Grenades -----------------------------------------------------------------------

  carries(id) {
    return this.c.player.ws.f[WS_GRENADES + GRENADE_IDS.indexOf(id)] > 0;
  }

  // Lost an enemy a moment ago (or heard one): an HE at the spot if it is in range, else a
  // flashbang, when an arc from here lands there (once per loss, with a cooldown).
  considerThrow(x, y, eye) {
    const g = this.game;
    if (g.tick < this.nadeAt || this.nadeFor === this.seenAt || !this.lastX) return;
    const lost = (g.tick - this.seenAt) / TICK_RATE;
    if (lost < NADE_LOST_MIN || lost > NADE_LOST_MAX) return;
    const d = Math.hypot(this.lastX - x, this.lastY - y), ct = this.c.team === TEAM_CT;
    const fire = WEAPON_ID[ct ? 'incgrenade' : 'molotov'], inside = (r) => d >= r[0] && d <= r[1];
    let id = 0;
    if (this.carries(WEAPON_ID.hegrenade) && inside(HE_RANGE)) id = WEAPON_ID.hegrenade;
    else if (this.carries(fire) && inside(MOLLY_RANGE)) id = fire;
    else if (this.carries(WEAPON_ID.flashbang) && inside(FLASH_RANGE)) id = WEAPON_ID.flashbang;
    else if (ct && this.carries(WEAPON_ID.smokegrenade) && inside(SMOKE_RANGE)) id = WEAPON_ID.smokegrenade;
    if (!id) return;
    this.nadeFor = this.seenAt;
    this.aimThrow(id, x, y, eye, this.lastX, this.lastY, this.lastZ);
  }

  // Starts a throw of grenade `id` from (x, y, eye) to land at (tx, ty, tz), when an arc
  // gets there; true if it did.
  aimThrow(id, x, y, eye, tx, ty, tz) {
    const arc = throwAngles(this.game.world, x, y, eye, tx, ty, tz);
    if (!arc) return false;
    this.nade = { id, pitch: arc[0], yaw: arc[1], phase: 0, hold: 0, until: this.game.tick + NADE_TIMEOUT * TICK_RATE };
    return true;
  }

  // The Ts' own plays: a molotov on the planted bomb while a CT is heard defusing it, and
  // the smoke on the CT side of their site on the way in. True if a throw started.
  considerPlay(x, y, eye) {
    const g = this.game, c = this.c, bomb = g.bomb;
    if (c.team !== TEAM_T || g.tick < this.nadeAt || g.rules.deathmatch) return false;
    if (bomb.state === BOMB_PLANTED) {
      if (!this.carries(WEAPON_ID.molotov) || Math.hypot(bomb.x - x, bomb.y - y) > MOLLY_BOMB) return false;
      let heard = false;
      for (const o of g.clients) {
        if (o && o.alive && o.team === TEAM_CT && o.player.ws.f[WS_ACTION] === ACTION_DEFUSE &&
          Math.hypot(o.player.ps.f[PS_ORIGIN] - x, o.player.ps.f[PS_ORIGIN + 1] - y) < HEAR_RANGE) heard = true;
      }
      return heard && this.aimThrow(WEAPON_ID.molotov, x, y, eye, bomb.x, bomb.y, bomb.z + 4);
    }
    if (g.phase !== PHASE_LIVE || !g.bombSites.count || this.bots.smokedRound === g.round.serial ||
      !this.carries(WEAPON_ID.smokegrenade) || g.tick < this.playAt) return false;
    this.playAt = g.tick + TICK_RATE;
    const i = this.site % g.bombSites.count, b = g.bombSites.boxes[i];
    const d = Math.hypot((b[0] + b[3]) / 2 - x, (b[1] + b[4]) / 2 - y);
    const spot = d >= SMOKE_EXEC[0] && d <= SMOKE_EXEC[1] ? this.bots.smokeSpot(i) : null;
    if (!spot) return false;
    const to = Math.hypot(spot[0] - x, spot[1] - y), k = Math.max(0, to - SMOKE_ROLL) / (to || 1);
    if (!this.aimThrow(WEAPON_ID.smokegrenade, x, y, eye, x + (spot[0] - x) * k, y + (spot[1] - y) * k, spot[2])) return false;
    this.bots.smokedRound = g.round.serial;
    return true;
  }

  // The throw under way: bring the grenade out (4 again cycles the kinds), pull the pin
  // once it is deployed and the view is on the arc, let go, and once it has left the hand
  // the gun comes back (weaponSlot). Returns [buttons, select].
  throwing() {
    const g = this.game, n = this.nade, f = this.c.player.ws.f;
    let buttons = 0, select = -1;
    const done = () => {
      this.nade = null;
      this.nadeAt = g.tick + NADE_COOLDOWN * TICK_RATE;
    };
    if (g.tick > n.until) {
      done();
      return [0, -1];
    }
    const out = f[WS_ACTIVE] === SLOT_GRENADE && f[WS_SLOTS + SLOT_GRENADE * 3] === n.id;
    if (n.phase === 0) {
      if (!out) select = SLOT_GRENADE;
      else if (this.cmdTick * TICK_DT >= f[WS_DEPLOY_END] && Math.hypot(angleDiff(n.yaw, this.yaw), n.pitch - this.pitch) < 2) n.phase = 1;
    }
    if (n.phase === 1) {
      buttons |= IN_ATTACK;
      if (++n.hold >= 2) n.phase = 2;
    } else if (n.phase === 2 && !f[WS_THROW] && !f[WS_THROW_TIME]) { // thrown
      if (n.id === WEAPON_ID.flashbang) {
        this.avertUntil = g.tick + AVERT * TICK_RATE;
        this.avertYaw = (n.yaw + 180) % 360;
      }
      done();
    }
    return [buttons, select];
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
    let rifle = WEAPON_ID[ct ? (this.difficulty >= 2 ? 'm4a1_silencer' : 'm4a1') : 'ak47'];
    if (!free && this.difficulty >= 2 && p.money >= AWP_MONEY && !this.bots.teamHasSniper(c.team) && this.bots.random() < 1 / 3) {
      rifle = WEAPON_ID.awp;
    }
    if (!p.ws.f[WS_SLOTS + SLOT_PRIMARY * 3]) order.push(rifle);
    if (!free) order.push(ITEM_ASSAULTSUIT, ITEM_KEVLAR);
    if (ct && g.bombSites.count && !free) order.push(ITEM_DEFUSER);
    if (!free && this.difficulty >= 1) {
      order.push(WEAPON_ID.hegrenade, WEAPON_ID.flashbang, WEAPON_ID.smokegrenade, WEAPON_ID[ct ? 'incgrenade' : 'molotov']);
    }
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
    // A teammate's radio order: after him (looked up once a second), or where we stood.
    const o = this.order;
    if (o && g.tick < o.until && o.who.alive && !carrier) {
      const f = o.who.player.ps.f, follow = o.kind === 'follow';
      const tx = follow ? f[PS_ORIGIN] : o.x, ty = follow ? f[PS_ORIGIN + 1] : o.y, tz = follow ? f[PS_ORIGIN + 2] - 36 : o.z;
      if (Math.hypot(tx - x, ty - y) < (follow ? FOLLOW_NEAR : 32)) return { node: -1, why: 'order', stop: true };
      const due = this.goalWhy !== 'order' || g.tick >= this.repathAt;
      return { node: due ? nav.nodeAt(tx, ty, tz) : this.goal, why: 'order', moving: follow };
    }
    this.order = null;
    if (g.phase !== PHASE_LIVE && g.phase !== PHASE_WARMUP) return { node: -1, why: 'wait' };
    const bomb = g.bomb, f = c.player.ps.f;
    if (!g.rules.deathmatch && g.bombSites.count && (g.rules.giveC4 || g.rules.retakes)) {
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

  // The button for a closed door on our way: walk to the node by it, look at it, press
  // it when in reach and facing it; back to the objective once the door is away from
  // rest (or after a while).
  buttonGoal(x, y, feet) {
    const g = this.game, d = g.doors, b = this.pressButton, k = this.pressDoor;
    if (!d.atBottom(k) || d.dead[k] || d.dead[b] || g.tick > this.pressUntil) {
      this.pressButton = -1;
      return this.objective(x, y, feet);
    }
    const cx = (d.mins[b * 3] + d.maxs[b * 3]) / 2, cy = (d.mins[b * 3 + 1] + d.maxs[b * 3 + 1]) / 2;
    const cz = (d.mins[b * 3 + 2] + d.maxs[b * 3 + 2]) / 2;
    let d2 = 0;
    for (let a = 0; a < 3; a++) {
      const v = a === 0 ? x : a === 1 ? y : feet + 36, lo = d.mins[b * 3 + a], hi = d.maxs[b * 3 + a];
      const gap = v < lo ? lo - v : v > hi ? v - hi : 0;
      d2 += gap * gap;
    }
    const inReach = d2 <= USE_REACH * USE_REACH;
    const facing = Math.abs(angleDiff(angles(x, y, feet + 64, cx, cy, cz)[1], this.yaw)) < 25;
    return { node: this.pressNode, why: 'button', stop: inReach, action: inReach && facing ? IN_USE : 0, look: [cx, cy, cz] };
  }

  // A closed door a button opens among the next waypoints: go for its button first.
  checkButtonDoors(x, y) {
    const g = this.game, d = g.doors, nav = this.bots.nav, P = this.path;
    const last = Math.min(this.pathLen - 1, this.pathIdx + BUTTON_LOOKAHEAD);
    for (let j = this.pathIdx; j <= last; j++) {
      const n = P[j], nx = nav.x[n], ny = nav.y[n], nz = nav.z[n];
      if (Math.hypot(nx - x, ny - y) > BUTTON_RANGE) return;
      for (const bd of this.bots.buttonDoors) {
        const k = bd.door;
        if (!d.atBottom(k) || d.dead[k] || bd.button < 0) continue;
        if (nx < d.mins[k * 3] - 24 || nx > d.maxs[k * 3] + 24 || ny < d.mins[k * 3 + 1] - 24 || ny > d.maxs[k * 3 + 1] + 24) continue;
        if (nz < d.mins[k * 3 + 2] - 40 || nz > d.maxs[k * 3 + 2]) continue;
        const b = bd.button;
        const node = this.bots.nearestNode((d.mins[b * 3] + d.maxs[b * 3]) / 2, (d.mins[b * 3 + 1] + d.maxs[b * 3 + 1]) / 2,
          (d.mins[b * 3 + 2] + d.maxs[b * 3 + 2]) / 2 - 36, 80);
        if (node < 0) continue;
        this.pressButton = b;
        this.pressDoor = k;
        this.pressNode = node;
        this.pressUntil = g.tick + BUTTON_TIMEOUT * TICK_RATE;
        this.goalWhy = ''; // a new goal: the button
        return;
      }
    }
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
    const yr = this.yaw * DEG, pr = this.pitch * DEG, cp = Math.cos(pr);
    return d.findUse(g.world, x, y, feet + 36, x, y, feet + 64, cp * Math.cos(yr), cp * Math.sin(yr), -Math.sin(pr)) >= 0;
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
    if (this.pressButton < 0 && this.bots.buttonDoors.length && (g.tick + this.c.id) % LOOKAHEAD_TICKS === 1) this.checkButtonDoors(x, y);
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

// The pitch and yaw of a long throw (IN_ATTACK: full strength, standing still) from the
// eye that lands nearest (tx, ty, tz): the shared throw's speed from the flattened pitch
// and the grenades' gravity, no bounces, the pitch searched in steps; null when no arc
// comes within NADE_ARC_ERROR, or the arc's first 70 % hits a wall.
const nadeTrace = new Trace();
function throwAngles(world, ex, ey, ez, tx, ty, tz) {
  const dx = tx - ex, dy = ty - ey, d = Math.hypot(dx, dy), yaw = Math.atan2(dy, dx) / DEG;
  if (d < 1) return null;
  let best = null, bestErr = NADE_ARC_ERROR;
  for (let pitch = -75; pitch <= 15; pitch += 2.5) {
    const p = -10 + pitch * (80 / 90), speed = Math.min((90 - p) * 6, 750);
    const vh = Math.cos(p * DEG) * speed, vz = -Math.sin(p * DEG) * speed;
    const a = GRENADE_GRAVITY / 2, disc = vz * vz - 4 * a * (tz - ez); // z(t) = ez + vz t - a t^2 = tz, the later root
    if (disc < 0) continue;
    const t = (vz + Math.sqrt(disc)) / (2 * a);
    if (t <= 0) continue;
    const err = Math.abs(vh * t - d);
    if (err < bestErr) {
      bestErr = err;
      best = { pitch, vh, vz, t };
    }
  }
  if (!best) return null;
  let px = ex, py = ey, pz = ez;
  for (let i = 1; i <= 8; i++) {
    const t = best.t * 0.7 * i / 8;
    const nx = ex + dx / d * best.vh * t, ny = ey + dy / d * best.vh * t, nz = ez + best.vz * t - GRENADE_GRAVITY / 2 * t * t;
    traceHull(world, HULL_POINT, px, py, pz, nx, ny, nz, nadeTrace);
    if (nadeTrace.fraction < 1) return null;
    px = nx;
    py = ny;
    pz = nz;
  }
  return [best.pitch, yaw];
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
