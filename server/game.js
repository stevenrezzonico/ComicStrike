// Authoritative game state: runs every client's user commands through the shared
// player simulation, resolves shots with lag compensation, runs CS:GO rounds, the
// bomb and the economy (or deathmatch: respawns, free weapons, points, a time limit;
// free for all with mp_teammates_are_enemies), and sends each client a delta-compressed snapshot (plus the tick's shot and
// kill events) every tick. Transport-agnostic: sessions only need send(bytes) and
// close(reason).

import { parseVec3 } from '../shared/bsp.js';
import { TICK_RATE, TICK_DT } from '../shared/constants.js';
import { ARMS_RACE, DEMOLITION, armLevel } from '../shared/progression.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_STAND, HULL_POINT } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { Doors, MapLogic } from '../shared/doors.js';
import { touched, touchedCount } from '../shared/pmove.js';
import { PS_ORIGIN, PS_VEL, PS_FLAGS, PS_DUCK_AMOUNT, FL_ONGROUND, eyeOffset } from '../shared/pmove.js';
import {
  ShotList, WEAPONS, WEAPON_ID, giveWeapon, silenced, canCarryGrenade, WS_SLOTS, WS_ACTIVE, WS_EVENTS, SLOT_C4,
  WEV_PLANTED, WEV_DEFUSED, WEV_DROP, WEV_FIRE, WEV_MELEE, WEV_THROW, WS_RELOAD_END, WS_ACTION, WS_THROWN, ACTION_PLANT,
  ACTION_DEFUSE, SLOT_PRIMARY, SLOT_SECONDARY,
} from '../shared/weapons.js';
import { HitTargets, HITGROUP_HEAD, HITGROUP_CHEST, HITGROUP_LEGS, feetOffset } from '../shared/hitgroups.js';
import { Grenades } from '../shared/grenades.js';
import {
  Hostages, RescueZones, MAX_HOSTAGES, HOSTAGES_PER_ROUND, PICKUP_TIME, HS_IDLE, HS_CARRIED, HS_RESCUED, HS_DEAD,
} from '../shared/hostages.js';
import {
  BombSites, BombState, bombDamage, C4_TIMER, PICKUP_RANGE, BOMB_NONE, BOMB_CARRIED, BOMB_DROPPED, BOMB_PLANTED,
  BOMB_DEFUSED, BOMB_EXPLODED,
} from '../shared/bomb.js';
import {
  Player, spawnPlayer, runCommand, resolveShots, applyDamage, ImpactList, TEAM_T, TEAM_CT, TEAM_SPECTATOR, TEAM_NAMES,
} from '../shared/player.js';
import { SurfaceMap } from '../shared/surfaces.js';
import { Items, THROW_SPEED, LET_GO_SPEED } from '../shared/items.js';
import { IN_USE } from '../shared/constants.js';
import { parse } from '../shared/cvars.js';
import { Bots } from './bots.js';
import {
  PHASE_WARMUP, PHASE_FREEZE, PHASE_LIVE, PHASE_OVER, FREEZE_TIME, ROUND_TIME, BUY_TIME, ROUND_END_DELAY,
  MAX_ROUNDS, WARMUP_RESPAWN, START_MONEY, MAX_MONEY, WIN_REWARD, BOMB_WIN_REWARD, PLANT_REWARD, DEFUSE_REWARD,
  PLANT_LOSS_BONUS, LOSS_STREAK_MAX, TEAMKILL_PENALTY, END_ELIMINATION, END_TIME, END_DRAW, END_BOMB, END_DEFUSE,
  END_RESCUE, RESCUE_WIN_REWARD, RESCUE_REWARD, HOSTAGE_TOUCH_REWARD, HOSTAGE_HIT_PENALTY, HOSTAGE_KILL_PENALTY,
  END_MATCH, GAME_FFA, GAME_DM, GAME_DEMO, GAME_ARMSRACE, GAME_DEMOLITION, GAME_WINGMAN, DM_KILL_POINTS, DM_RESPAWN, lossBonus, buyError, applyBuy, BuyZones,
} from '../shared/economy.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, CMD_REDUNDANCY, C2S_HELLO, C2S_CMDS, C2S_BYE, C2S_BUY, C2S_COMMAND, SHOT_IMPACT,
  SHOT_BLOOD, writePrint, printChunks,
  KILL_HEADSHOT, KILL_REPEAT_TICKS, Writer, Reader, CmdRing, SnapshotRing, EventList, RoundState, readHello,
  writeWelcome, writeReject, writeInfo, writeItems, writeGrenades, writeHostages, readCmds, writeSnapshot, quantizePitch,
  quantizeYaw,
  E_ACTIVE, E_X, E_Y, E_Z,
  E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS, E_FIELDS, ANIM_RELOAD, ANIM_PLANT,
  ANIM_DEFUSE, ANIM_HELMET, ANIM_SILENCED, ANIM_SPOTTED_T, ANIM_SPOTTED_CT, ANIM_IMMUNE,
} from '../shared/protocol.js';

const CMD_BANK = 8; // commands a client may run ahead of server time (absorbs jitter, stops speedhacks)
const MAX_CMDS_PER_TICK = 8;
const TIMEOUT_TICKS = 30 * TICK_RATE; // clients in hidden tabs send a 1 Hz keepalive
const INFO_INTERVAL = TICK_RATE; // roster resent every second (datagrams can be lost)
const SEND_BUFFERS = 8; // rotating send buffers: a datagram may still be queued when the next is written
const WARMUP_MONEY = 16000; // CS:GO warmup: buy anything
const THROW_DISTANCE = 64; // a dropped (G) bomb lands this far ahead (weapons fly: shared/items.js)
const PICKUP_DELAY = TICK_RATE; // ticks before a thrown bomb or weapon can be picked up
const DEMO_RESTOCK = 2; // the demo: seconds from a bomb going off or being defused to the next one
const DEMO_HEAL = 2; // the demo: seconds from the last hurt to full health
const USE_RANGE = 96; // E picks up a weapon on the ground this close to the eyes
const USE_CONE = 0.8; // cos of the largest angle off the view it may be at

// Radar spotting (approx. of CS:GO's: how often, how wide a view, how long a shot shows).
const SPOT_TICKS = 4;
const SPOT_CONE = 0.5; // cos 60 degrees off the view
const SHOT_REVEAL_TICKS = TICK_RATE; // firing an unsilenced gun shows the shooter for 1 s
const DEG = Math.PI / 180;
// Deathmatch spawns (approx. of CS:GO's): random spots tried, the least distance to an enemy.
const DM_SPAWN_TRIES = 64;
const DM_SPAWN_GAP = 512;

// Lag compensation: how far back shots may rewind other players (CS:GO sv_maxunlag 1 s).
const HISTORY = 64; // ticks, power of two
const H_X = 0, H_Y = 1, H_Z = 2, H_YAW = 3, H_FLAGS = 4, H_DUCK = 5, H_LIFE = 6, H_FIELDS = 7;

class Client {
  constructor(id, session) {
    this.id = id;
    this.session = session;
    this.player = new Player();
    this.name = '';
    this.joined = false;
    this.inbox = new CmdRing(64);
    this.nextCmd = -1; // next command tick to run
    this.newestCmd = -1; // newest command tick received
    this.lastCmd = 0; // last command tick run (acked to the client)
    this.bank = 2;
    this.ackSeq = 0; // newest snapshot the client has decoded
    this.lastHeard = 0;
    this.spawnYaw = 0;
    this.respawnTick = Infinity; // while dead in warmup / with respawns: server tick to respawn at
    this.spawnTick = 0; // server tick of the last spawn (deathmatch buy time)
    this.immuneUntil = 0; // server tick: spawn protection (mp_respawn_immunitytime) until then
    this.immune = false; // and whether it is on this tick (snapshots show it)
    this.spotted = 0; // ANIM_SPOTTED_T / _CT: on whose radar he shows
    this.revealUntil = 0; // server tick: fired an unsilenced gun, on everyone's radar until then
    this.life = 0; // increments per spawn: history never interpolates across a respawn
    this.placed = false; // round start: already put on a spawn point
    this.canBuy = false;
    this.lastBuy = -1; // newest BUY id handled
    this.lastCommand = -1; // newest COMMAND id handled
    this.shots = 0; // shots fired mod 256 (E_SHOTS: third-person fire kicks)
    this.useHeld = false; // +use was down last command (E picks up on the press)
    this.controlled = false; // a bot a dead teammate took control of: out of play until it respawns
    this.lastHealth = 100; // the demo: health last tick, and when it heals back
    this.healAt = 0;
    this.level = 0; // Arms Race / Demolition: place in the weapon list (shared/progression.js)
    this.roundKills = 0; // Demolition: kills this round (one earns the next level)
    this.cmdTime = 0; // sim time of the last command run (a weapon earned mid-command draws then)
    this.flashLeft = 0; // seconds of flashbang blindness left (sent in the own block)
    this.flashTotal = 0;
    this.picking = -1; // hostage being picked up (use held), or -1
    this.pickEnd = 0; // server tick it is done
    this.useProgress = 0; // 0..1, sent in the own block
    // Last command run, repeated when one is lost.
    this.buttons = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.view = 0;
    this.out = Array.from({ length: SEND_BUFFERS }, () => new Writer());
    this.outNext = 0;
  }

  get team() {
    return this.player.team;
  }

  get alive() {
    return this.player.health > 0;
  }

  // On a team (not a spectator).
  get playing() {
    return this.player.team !== TEAM_SPECTATOR;
  }

  get kills() {
    return this.player.kills;
  }

  get deaths() {
    return this.player.deaths;
  }

  get score() {
    return this.player.score;
  }

  writer() {
    const w = this.out[this.outNext];
    this.outNext = (this.outNext + 1) % SEND_BUFFERS;
    return w;
  }
}

// Round rules (the server console's mp_* cvars); tests override them (shorter timings,
// or no rounds at all).
export const DEFAULT_RULES = {
  rounds: true, // false: stay in warmup (free respawns) forever
  freezeTime: FREEZE_TIME,
  roundTime: ROUND_TIME,
  buyTime: BUY_TIME,
  roundEndDelay: ROUND_END_DELAY,
  c4Timer: C4_TIMER,
  maxRounds: MAX_ROUNDS,
  startMoney: START_MONEY,
  maxMoney: MAX_MONEY,
  warmupTime: 0, // seconds of warmup once both teams have players (0: start at once)
  cheats: false, // sv_cheats: setpos for testing
  // Game mode (server/host.js: game_type / game_mode and the mode convars).
  deathmatch: false, // free weapons (kept for the next life), points instead of money
  wingman: false, // 2 against 2 on one bomb site (B, the second in entity order: approx.)
  armsRace: false, // a new weapon for every kill, the knife last; a knife kill there wins
  demolition: false, // bomb rounds; a kill earns the next weapon for the next round
  halftime: true, // mp_halftime: teams swap sides after half the rounds
  teamSizeMax: 0, // mp_teamsize_max: most players on one team (0 no limit)
  demo: false, // the demo: free buying anywhere and anytime, infinite ammo, humans cannot die, anyone
  // plants and defuses, the bomb comes back after each explosion or defuse (cfg/gamemode_demo.cfg)
  teammatesAreEnemies: false, // mp_teammates_are_enemies: free for all
  respawnT: false, // mp_respawn_on_death_t
  respawnCT: false, // mp_respawn_on_death_ct
  randomSpawn: false, // mp_randomspawn: any spawn point, away from enemies
  ignoreWinConditions: false, // mp_ignore_round_win_conditions
  timeLimit: 0, // mp_timelimit (s): match length when rounds never end; 0 none
  buyAnywhere: false, // mp_buy_anywhere
  freeArmor: false, // mp_free_armor: kevlar + helmet at every spawn
  giveC4: true, // mp_give_player_c4
  hostagesMax: HOSTAGES_PER_ROUND, // mp_hostages_max
  immunityTime: 0, // mp_respawn_immunitytime (s)
  matchRestartDelay: 15, // mp_match_restart_delay (s)
  deathDropGun: true, // mp_death_drop_gun
  // Bots (server/bots.js).
  botQuota: 0, // bot_quota
  botQuotaMode: 'normal', // bot_quota_mode: normal (that many bots) or fill (bots + humans)
  botDifficulty: 1, // bot_difficulty 0 easy .. 3 expert
  botJoinTeam: 'any', // bot_join_team: any, t, ct
  botStop: false, // bot_stop: they stand still
  botDontShoot: false, // bot_dont_shoot
};

export class Game {
  constructor(mapName, bsp, rules = {}) {
    this.mapName = mapName;
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.bsp = bsp;
    this.world = CollisionWorld.fromBSP(bsp);
    this.world.surfaces = new SurfaceMap(bsp);
    this.breakables = new Breakables(bsp, this.world);
    this.doors = new Doors(bsp, this.world, this.breakables.count);
    this.logic = new MapLogic(bsp, this.doors);
    this.doorBodies = []; // living players' PlayerStates, refilled every tick
    this.doorActs = []; // and where they stand ({ x, y, z, yaw }: trigger activators)
    this.fireTarget = (name, act) => this.logic.fireAt(this.tick, name, act, 0);
    this.buyZones = new BuyZones(bsp);
    this.spawns = { [TEAM_T]: [], [TEAM_CT]: [] };
    const o = new Float32Array(3);
    for (const e of bsp.entities) {
      const team = e.classname === 'info_player_deathmatch' ? TEAM_T : e.classname === 'info_player_start' ? TEAM_CT : 0;
      if (!team) continue;
      parseVec3(e.origin, o);
      const yaw = e.angles ? +e.angles.trim().split(/\s+/)[1] || 0 : +(e.angle || 0);
      this.spawns[team].push([o[0], o[1], o[2], yaw]);
    }
    // Who wins when the round clock runs out: CTs defend bomb sites, Ts hold hostages.
    this.bombSites = new BombSites(bsp);
    if (this.rules.wingman && this.bombSites.count > 1) this.bombSites.keepOnly(1);
    this.world.bombSites = this.bombSites;
    const hostages = bsp.entities.some((e) => e.classname === 'hostage_entity');
    this.timeWinner = this.bombSites.count ? TEAM_CT : hostages ? TEAM_T : 0;

    this.clients = new Array(MAX_PLAYERS).fill(null);
    this.tick = 0;
    this.snapshots = new SnapshotRing();
    this.events = new EventList();
    this.nextKillId = 1;
    this.rosterDirty = false;
    this.history = new Float32Array(MAX_PLAYERS * HISTORY * H_FIELDS);
    this.historyTick = new Int32Array(MAX_PLAYERS * HISTORY).fill(-1);
    this.targets = new HitTargets(MAX_PLAYERS + MAX_HOSTAGES); // players, then hostages
    this.shots = new ShotList();
    this.impacts = new ImpactList();
    this.reader = new Reader();
    this.spotTrace = new Trace();
    this.infoWriter = new Writer();

    // Rounds.
    this.round = new RoundState();
    this.phaseEnd = 0;
    this.buyEnd = 0;
    this.roundsPlayed = 0;
    this.lossStreak = { [TEAM_T]: 0, [TEAM_CT]: 0 };
    this.placing = false;
    this.warmupReady = -1; // warmup: server tick both teams first had players (-1: not yet)
    this.warmupManual = false; // mp_warmup_start without mp_warmuptime: until mp_warmup_end
    this.restartAt = 0; // mp_restartgame: server tick to restart the match at
    // rcon(client, password, command) -> output text; set by the Host. null: no rcon.
    this.rcon = null;

    // The bomb.
    this.bomb = new BombState();
    this.bombCarrier = null; // Client
    this.explodeTick = 0;
    this.lastPlanter = null; // the demo hands them the next bomb
    this.restockTick = 0; // the demo: the next bomb is handed out from this tick
    this.pickupTick = 0; // a dropped bomb can be picked up from this tick on
    this.planted = false; // this round: the Ts' plant bonus
    this.bombTrace = new Trace();
    this.landing = new Float64Array(3);

    // Weapons on the ground.
    this.items = new Items();
    this.itemsDirty = false;
    this.itemsWriter = new Writer();

    // Hostages (hostage maps).
    this.hostages = new Hostages(bsp);
    this.rescue = this.hostages.spots.length ? new RescueZones(bsp, this.spawns[TEAM_CT]) : null;
    this.hostagesDirty = false;
    this.hostageWriter = new Writer();

    // Grenades, and what they act on: the clients (index = player id).
    this.grenades = new Grenades();
    this.bots = new Bots(this);
    this.grenadeWriter = new Writer();
    const live = (i) => this.clients[i] && this.clients[i].joined && this.clients[i].alive;
    const origin = (i, out, dz) => {
      const p = this.clients[i].player, f = p.ps.f;
      out[0] = f[PS_ORIGIN];
      out[1] = f[PS_ORIGIN + 1];
      out[2] = f[PS_ORIGIN + 2] + dz(p);
    };
    this.grenadeTargets = {
      count: MAX_PLAYERS,
      alive: live,
      center: (i, out) => origin(i, out, () => 0),
      eye: (i, out) => origin(i, out, (p) => eyeOffset(p.ps)),
      feet: (i, out) => origin(i, out, (p) => -feetOffset(p.ps.i[PS_FLAGS])),
      pitch: (i) => this.clients[i].pitch,
      yaw: (i) => this.clients[i].yaw,
      hurt: (i, damage, weapon, owner, team) => this.grenadeHurt(this.clients[i], damage, weapon, owner, team),
      flash: (i, seconds) => {
        const c = this.clients[i];
        if (seconds > c.flashLeft) {
          c.flashLeft = seconds;
          c.flashTotal = seconds;
        }
      },
    };
  }

  // HE blasts and fires: friendly fire off (the thrower still hurts himself); HE as a
  // chest hit (armor helps), fire ignores armor.
  grenadeHurt(victim, damage, weapon, ownerId, ownerTeam) {
    const owner = this.clients[ownerId];
    if (victim.team === ownerTeam && victim.id !== ownerId && !this.rules.teammatesAreEnemies) return;
    if (this.tick < victim.immuneUntil) return;
    const w = WEAPONS[weapon];
    applyDamage(victim.player, damage, w, w.grenade === 'fire' ? HITGROUP_LEGS : HITGROUP_CHEST);
    if (victim.player.health <= 0) this.kill(owner && owner.joined ? owner : victim, victim, weapon, false);
  }

  get playerCount() {
    return this.clients.filter(Boolean).length;
  }

  // Can `a` hurt `b` (free for all: anyone else)?
  isEnemy(a, b) {
    return a !== b && (this.rules.teammatesAreEnemies || a.team !== b.team);
  }

  // Does `c` respawn after dying (deathmatch)?
  respawns(c) {
    return c.team === TEAM_T ? this.rules.respawnT : c.team === TEAM_CT && this.rules.respawnCT;
  }

  // The match can be played: free for all needs two players, else both teams.
  ready(t, ct) {
    if (this.rules.demo) return t + ct > 0; // the demo plays alone
    return this.rules.teammatesAreEnemies ? t + ct >= 2 : t > 0 && ct > 0;
  }

  get phase() {
    return this.round.phase;
  }

  // A new transport session. Returns its Client, or null if the server is full.
  connect(session) {
    const id = this.clients.indexOf(null);
    if (id < 0) {
      session.send(writeReject(new Writer(), 'server full').slice());
      session.close('server full');
      return null;
    }
    const c = new Client(id, session);
    c.lastHeard = this.tick;
    this.clients[id] = c;
    return c;
  }

  disconnect(c) {
    if (this.clients[c.id] !== c) return;
    if (c.bot) this.bots.list = this.bots.list.filter((b) => b !== c.bot);
    if (this.bombCarrier === c) this.dropBomb(c, false);
    this.dropHostage(c);
    this.clients[c.id] = null;
    this.historyTick.fill(-1, c.id * HISTORY, (c.id + 1) * HISTORY);
    this.rosterDirty = true;
  }

  receive(c, bytes) {
    const r = this.reader.set(bytes);
    if (r.remaining < 1) return;
    c.lastHeard = this.tick;
    const type = r.u8v();
    if (type === C2S_HELLO) {
      const h = readHello(r);
      if (h.version !== PROTOCOL_VERSION) {
        c.session.send(writeReject(c.writer(), `protocol ${h.version}, server speaks ${PROTOCOL_VERSION}`));
        c.session.close('version');
        return;
      }
      if (!c.joined) this.join(c, h);
      // HELLO is resent until a WELCOME gets through, so answer every one.
      c.session.send(writeWelcome(c.writer(), c.id, this.tick, TICK_RATE, this.mapName));
    } else if (type === C2S_BYE) {
      if (c.joined) console.log(`player ${c.id} "${c.name}" left`);
      c.joined = false; // the transport's close callback must not log it twice
      c.session.close('bye');
      this.disconnect(c);
    } else if (type === C2S_BUY && c.joined && r.remaining >= 3) {
      const id = r.u16v(), item = r.u8v();
      const ahead = (id - c.lastBuy) & 0xffff; // ids wrap; each BUY arrives up to 3 times
      if (c.lastBuy >= 0 && (ahead === 0 || ahead >= 0x8000)) return;
      c.lastBuy = id;
      this.buyItem(c, item);
    } else if (type === C2S_COMMAND && c.joined && r.remaining >= 4) {
      const id = r.u16v(), text = r.lstr();
      const ahead = (id - c.lastCommand) & 0xffff; // sent 3 times, like BUY
      if (c.lastCommand >= 0 && (ahead === 0 || ahead >= 0x8000)) return;
      c.lastCommand = id;
      this.clientCommand(c, text);
    } else if (type === C2S_CMDS && c.joined) {
      const ack = readCmds(r, c.inbox, c.nextCmd < 0 ? 0 : c.nextCmd);
      if (ack > c.ackSeq && ack <= this.tick) c.ackSeq = ack;
      c.newestCmd = c.inbox.newest;
      if (c.nextCmd < 0 && c.newestCmd >= 0) c.nextCmd = c.newestCmd; // start from the first command heard
    }
  }

  join(c, h) {
    c.joined = true;
    c.name = h.name.slice(0, 31) || `player${c.id}`;
    const p = c.player;
    p.primary = WEAPONS[h.primary] ? h.primary : 0;
    p.secondary = WEAPONS[h.secondary] ? h.secondary : 0;
    if (h.team === TEAM_T || h.team === TEAM_CT || h.team === TEAM_SPECTATOR) p.team = h.team;
    else { // auto-balance
      let t = 0, ct = 0;
      for (const o of this.clients) if (o && o !== c && o.joined && o.playing) o.team === TEAM_CT ? ct++ : t++;
      p.team = ct < t ? TEAM_CT : TEAM_T;
    }
    // A full team (mp_teamsize_max): the other one, else watch.
    if (p.team !== TEAM_SPECTATOR && this.teamFull(p.team, c)) {
      const other = p.team === TEAM_CT ? TEAM_T : TEAM_CT;
      p.team = this.teamFull(other, c) ? TEAM_SPECTATOR : other;
    }
    p.money = this.phase === PHASE_WARMUP ? WARMUP_MONEY : this.rules.startMoney;
    if (c.playing && (this.phase === PHASE_WARMUP || this.phase === PHASE_FREEZE ||
      (this.phase === PHASE_LIVE && this.respawns(c)))) {
      this.respawn(c, false, this.phase === PHASE_WARMUP || this.respawns(c));
    } else {
      p.health = 0; // joined mid-round: wait for the next one (spectators: never spawn)
      c.life++;
    }
    this.rosterDirty = true;
    console.log(`player ${c.id} "${c.name}" joined (${TEAM_NAMES[p.team]})`);
  }

  // Free spawn point of the player's team: one no other live player stands on (at a
  // round start: no one placed yet this round).
  respawn(c, keepGear = false, withLoadout = false) {
    if (!c.playing) return;
    const pick = this.rules.randomSpawn ? this.randomSpawn(c) : this.teamSpawn(c);
    spawnPlayer(c.player, pick[0], pick[1], pick[2], keepGear, withLoadout);
    const list = this.progression();
    if (list) armLevel(c.player.ws, list, c.level, c.team === TEAM_CT);
    if (this.rules.freeArmor) {
      c.player.armor = 100;
      c.player.helmet = true;
    }
    c.spawnYaw = pick[3];
    c.respawnTick = Infinity;
    c.spawnTick = this.tick;
    c.immuneUntil = this.tick + Math.round(this.rules.immunityTime * TICK_RATE);
    c.placed = true;
    c.controlled = false;
    c.life++;
  }

  // CS:GO's bot takeover: dead `c`, watching a living bot of its team, takes its place
  // (position, view, health, armor, weapons and ammo, the bomb, a carried hostage; c keeps
  // its own money and score). The bot leaves play until it next respawns, with no death
  // and no body. Not in warmup or deathmatch (they respawn), nor once the round is over.
  // Returns '' or why not.
  takeOver(c, id) {
    const o = this.clients[id];
    if (!c.playing || c.alive) return 'only the dead can take control of a bot';
    if (this.respawns(c) || (this.phase !== PHASE_FREEZE && this.phase !== PHASE_LIVE)) return 'not now';
    if (!o || !o.bot || !o.joined || !o.alive || o.team !== c.team) return 'not a living bot of your team';
    const p = c.player, b = o.player;
    p.psBytes.set(b.psBytes);
    p.wsBytes.set(b.wsBytes);
    p.health = b.health;
    p.armor = b.armor;
    p.helmet = b.helmet;
    p.defuser = b.defuser;
    p.carrying = b.carrying;
    p.spawnCount = (p.spawnCount + 1) & 255; // the client adopts the new state like a respawn
    c.spawnYaw = c.yaw = o.yaw;
    c.pitch = 0;
    c.respawnTick = Infinity;
    c.immuneUntil = 0;
    c.placed = true;
    c.life++;
    if (this.bombCarrier === o) this.bombCarrier = c;
    const h = this.hostages, k = h.carriedBy(o.id);
    if (k >= 0) {
      h.carrier[k] = c.id;
      this.hostagesDirty = true;
    }
    b.health = 0;
    b.carrying = false;
    o.controlled = true;
    this.printAll(`${c.name} took control of ${o.name}`);
    this.rosterDirty = true;
    return '';
  }

  // Is spawn point `s` free for `c` (nobody standing on it, room to stand)?
  spawnFree(c, s) {
    const taken = this.clients.some((o) =>
      o && o !== c && o.joined && o.alive && (!this.placing || o.placed) &&
      Math.hypot(o.player.ps.f[PS_ORIGIN] - s[0], o.player.ps.f[PS_ORIGIN + 1] - s[1]) < 48
    );
    return !taken && hullFits(this.world, HULL_STAND, s[0], s[1], s[2]);
  }

  // The first free spawn point of the player's team.
  teamSpawn(c) {
    const list = this.spawns[c.team].length ? this.spawns[c.team] : this.spawns[TEAM_T];
    return list.find((s) => this.spawnFree(c, s)) || list[0] || [0, 0, 0, 0];
  }

  // mp_randomspawn: a random spot anywhere on the map, as CS:GO's deathmatch spawns
  // (GoldSrc maps have only the team spawns, so the spots are the navigation's open
  // floors: shared/nav.js): standing room, nobody on it, out of every living enemy's
  // sight and at least DM_SPAWN_GAP from them; when no tried spot is, the farthest one.
  randomSpawn(c) {
    const nav = this.bots.ensureNav(), tr = this.spotTrace;
    let best = null, bestD = -1;
    for (let tries = 0; tries < DM_SPAWN_TRIES; tries++) {
      const k = Math.floor(Math.random() * nav.count);
      if (!nav.open(k)) continue;
      const x = nav.x[k], y = nav.y[k], z = nav.z[k] + 37; // hull center 36 above the feet
      const s = [x, y, z, Math.random() * 360];
      if (!this.spawnFree(c, s)) continue;
      let near = Infinity, seen = false;
      for (const o of this.clients) {
        if (!o || !o.joined || !o.alive || !this.isEnemy(c, o)) continue;
        const f = o.player.ps.f, ez = f[PS_ORIGIN + 2] + eyeOffset(o.player.ps);
        near = Math.min(near, Math.hypot(f[PS_ORIGIN] - x, f[PS_ORIGIN + 1] - y, f[PS_ORIGIN + 2] - z));
        if (!seen) {
          traceHull(this.world, HULL_POINT, f[PS_ORIGIN], f[PS_ORIGIN + 1], ez, x, y, z + 28, tr);
          seen = tr.fraction >= 1; // his eye to where ours would be
        }
      }
      if (!seen && near >= DM_SPAWN_GAP) return s;
      if (near > bestD) [best, bestD] = [s, near];
    }
    return best || this.teamSpawn(c);
  }

  // Buys `item` for `c` if he may (BUY messages, bots).
  buyItem(c, item) {
    const free = this.rules.deathmatch || this.rules.demo;
    if (buyError(c.player, item, this.canBuy(c), free)) return false;
    // A weapon bought into a taken slot throws the old one down (CS:GO; deathmatch: it is
    // gone, and the new one is handed out again at every respawn).
    const w = WEAPONS[item], p = c.player;
    if (w && !w.melee && !w.c4 && p.ws.f[WS_SLOTS + w.slot * 3] && !free) this.dropSlot(c, w.slot, true);
    applyBuy(p, item, free);
    if (free && w && w.slot === SLOT_PRIMARY) p.primary = item;
    if (free && w && w.slot === SLOT_SECONDARY) p.secondary = item;
    return true;
  }

  // The gun game modes' weapon list, or null.
  progression() {
    return this.rules.armsRace ? ARMS_RACE : this.rules.demolition ? DEMOLITION : null;
  }

  // In a buy zone (or mp_buy_anywhere) in buy time; deathmatch: mp_buytime from each spawn.
  // The gun game modes earn their weapons instead.
  canBuy(c) {
    const ph = this.phase, r = this.rules;
    if (r.armsRace || r.demolition) return false;
    if (r.demo) return c.alive && ph !== PHASE_OVER; // anywhere, anytime
    const inTime = r.deathmatch ? ph !== PHASE_OVER && this.tick < c.spawnTick + r.buyTime * TICK_RATE
      : ph === PHASE_WARMUP || ph === PHASE_FREEZE || (ph === PHASE_LIVE && this.tick < this.buyEnd);
    const f = c.player.ps.f;
    return inTime && c.alive &&
      (r.buyAnywhere || this.buyZones.contains(c.team, f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2]));
  }

  // One server tick: run queued commands, the round, lag-compensation history, then
  // snapshot everyone.
  step() {
    this.tick++;
    const ev = this.events;
    ev.shots = 0;
    while (ev.kills && ev.killTick[0] + KILL_REPEAT_TICKS < this.tick) ev.dropOldestKill();
    if (this.tick % 16 === 0) this.bots.maintain(); // bot_quota
    this.bots.think(); // bots queue this tick's commands like clients do
    this.updateDoors();

    for (const c of this.clients) {
      if (!c) continue;
      if (this.tick - c.lastHeard > TIMEOUT_TICKS) {
        console.log(`player ${c.id} timed out`);
        c.session.close('timeout');
        this.disconnect(c);
        continue;
      }
      if (!c.joined) continue;
      if (!c.alive && this.tick >= c.respawnTick && this.phase !== PHASE_OVER) this.respawn(c, false, true);
      this.runCommands(c);
      if (this.rules.demo) this.demoHeal(c);
    }
    this.updateBomb();
    this.updateHostages();
    this.grenades.update(this.world, this.grenadeTargets);
    for (const c of this.clients) if (c) c.flashLeft = Math.max(0, c.flashLeft - 1 / TICK_RATE);
    this.updateItems();
    this.updateSpotting();
    this.updateRound();
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      c.canBuy = this.canBuy(c);
      c.immune = c.alive && this.tick < c.immuneUntil; // shown: others' models pulse, our HUD says so
    }
    this.recordHistory();
    if (this.rosterDirty || this.tick % INFO_INTERVAL === 0) this.sendInfo();
    if (this.itemsDirty || this.tick % INFO_INTERVAL === 0) this.sendItems();
    this.sendSnapshots();
    this.sendGrenades();
    if (this.hostages.count && (this.hostagesDirty || this.tick % INFO_INTERVAL === 0)) this.sendHostages();
  }

  runCommands(c) {
    c.bank = Math.min(c.bank + 1, CMD_BANK);
    const frozen = this.phase === PHASE_FREEZE;
    for (let n = 0; n < MAX_CMDS_PER_TICK && c.nextCmd >= 0 && c.bank >= 1; n++) {
      const t = c.nextCmd;
      let select = -1;
      if (c.inbox.has(t)) {
        const k = t & c.inbox.mask;
        c.buttons = c.inbox.buttons[k];
        c.pitch = c.inbox.pitch[k];
        c.yaw = c.inbox.yaw[k];
        c.view = c.inbox.view[k];
        select = c.inbox.select[k];
      } else if (c.newestCmd < t + CMD_REDUNDANCY) {
        break; // not here yet
      } // else lost beyond redundancy: repeat the previous command
      if (c.alive) this.runCommand(c, t, select, frozen); // the dead only use up their commands
      c.lastCmd = t;
      c.nextCmd = t + 1;
      c.bank--;
    }
  }

  runCommand(c, t, select, frozen) {
    const p = c.player;
    c.cmdTime = t * TICK_DT;
    const wf = p.ws.f, held = WS_SLOTS + wf[WS_ACTIVE] * 3;
    const heldId = wf[held], heldClip = wf[held + 1], heldReserve = wf[held + 2]; // what G may drop
    const fell = runCommand(this.world, p, c.buttons, select, c.pitch, c.yaw, t, this.shots, frozen, this.bomb,
      this.rules.demo);
    const events = p.ws.f[WS_EVENTS];
    if (events & (WEV_FIRE | WEV_MELEE | WEV_THROW)) {
      c.shots = (c.shots + 1) & 255;
      c.immuneUntil = 0; // CS:GO: shooting ends spawn protection
      if ((events & WEV_FIRE) && !silenced(p.ws, p.ws.f[WS_ACTIVE])) c.revealUntil = this.tick + SHOT_REVEAL_TICKS;
    }
    if (events & WEV_THROW) {
      const f = p.ps.f, thrown = p.ws.f[WS_THROWN];
      this.grenades.throw(this.world, Math.floor(thrown / 4), c.id, c.team, f[PS_ORIGIN], f[PS_ORIGIN + 1],
        f[PS_ORIGIN + 2] + eyeOffset(p.ps), c.pitch, c.yaw, f[PS_VEL], f[PS_VEL + 1], f[PS_VEL + 2], thrown & 3);
    }
    if (events & WEV_DROP) {
      if (WEAPONS[heldId]?.c4) this.dropBomb(c, true);
      else if (this.progression()) armLevel(p.ws, this.progression(), c.level, c.team === TEAM_CT, c.cmdTime); // earned, not dropped
      else this.spawnItem(c, heldId, heldClip, heldReserve, true);
    }
    // Doors and buttons it ran into.
    for (let i = 0; i < touchedCount; i++) {
      const k = this.doors.ofEnt(touched[i]);
      if (k >= 0) this.doors.touch(k, this.tick, this.actOf(c));
    }
    // E on a door or button, else on a weapon on the ground: swap it for the one in its
    // slot (not while defusing).
    if ((c.buttons & IN_USE) && !c.useHeld && !p.ws.f[WS_ACTION] && !this.useDoor(c)) this.useItem(c);
    c.useHeld = (c.buttons & IN_USE) !== 0;
    this.useHostage(c);
    if (events & WEV_PLANTED) this.plantBomb(c);
    if (events & WEV_DEFUSED) this.defuseBomb(c);
    if (this.shots.count) {
      this.rewind(c.view);
      const team = this.rules.teammatesAreEnemies ? 0 : c.team; // 0: nobody is skipped
      resolveShots(this.world, this.breakables, p.ws, this.shots, this.impacts, this.targets, c.id, team);
      this.applyImpacts(c);
    }
    if (fell && p.health <= 0) this.kill(c, c, 0, false);
  }

  // Shot results: damage players, publish impacts.
  applyImpacts(shooter) {
    const im = this.impacts, ev = this.events;
    const weapon = this.shots.weapon[0];
    const w = WEAPONS[weapon];
    for (let i = 0; i < im.count; i++) {
      const x = im.pos[i * 3], y = im.pos[i * 3 + 1], z = im.pos[i * 3 + 2];
      const nx = im.normal[i * 3], ny = im.normal[i * 3 + 1], nz = im.normal[i * 3 + 2];
      if (im.player[i] >= MAX_PLAYERS) { // a hostage
        ev.addShot(shooter.id, SHOT_BLOOD, x, y, z, nx, ny, nz, 0);
        this.hurtHostage(shooter, im.player[i] - MAX_PLAYERS, im.damage[i]);
        continue;
      }
      const victim = im.player[i] >= 0 ? this.clients[im.player[i]] : null;
      if (!victim) {
        ev.addShot(shooter.id, SHOT_IMPACT, x, y, z, nx, ny, nz, im.owner[i]);
        continue;
      }
      if (this.tick < victim.immuneUntil) continue; // spawn protection: the bullet does nothing
      ev.addShot(shooter.id, SHOT_BLOOD, x, y, z, nx, ny, nz, 0);
      if (!victim.alive) continue; // already killed by an earlier pellet
      applyDamage(victim.player, im.damage[i], w, im.group[i]);
      if (victim.player.health <= 0) this.kill(shooter, victim, weapon, im.group[i] === HITGROUP_HEAD);
    }
  }

  kill(killer, victim, weapon, headshot) {
    const k = killer.player, v = victim.player;
    if (this.rules.demo && !victim.bot && v.health <= 0) { // the demo: humans take the hit, not the death
      v.health = 1;
      return;
    }
    v.health = 0;
    v.deaths++;
    if (this.bombCarrier === victim) this.dropBomb(victim, false);
    this.dropHostage(victim);
    // CS:GO: the dead drop their primary, else their pistol.
    const vf = v.ws.f;
    const slot = vf[WS_SLOTS + SLOT_PRIMARY * 3] ? SLOT_PRIMARY : vf[WS_SLOTS + SLOT_SECONDARY * 3] ? SLOT_SECONDARY : -1;
    if (slot >= 0 && this.rules.deathDropGun) this.dropSlot(victim, slot, false);
    const dm = this.rules.deathmatch;
    if (killer !== victim) {
      if (!this.isEnemy(killer, victim)) {
        k.kills--;
        if (!dm) k.money = Math.max(0, k.money - TEAMKILL_PENALTY);
      } else {
        k.kills++;
        if (dm) k.score += DM_KILL_POINTS;
        else if (this.phase !== PHASE_WARMUP) {
          k.money = Math.min(this.rules.maxMoney, k.money + (WEAPONS[weapon]?.killAward || 0));
        }
        if (this.phase === PHASE_LIVE) {
          if (this.rules.armsRace) this.armsRaceKill(killer, victim, weapon);
          else if (this.rules.demolition) killer.roundKills++;
        }
      }
    }
    if (this.phase === PHASE_WARMUP) victim.respawnTick = this.tick + WARMUP_RESPAWN * TICK_RATE;
    else if (this.respawns(victim)) victim.respawnTick = this.tick + DM_RESPAWN * TICK_RATE;
    this.events.addKill(this.nextKillId, killer.id, victim.id, weapon, headshot ? KILL_HEADSHOT : 0, this.tick);
    this.nextKillId = (this.nextKillId + 1) & 0xffff || 1;
    this.rosterDirty = true;
  }

  // Arms Race: the killer gets the next weapon at once (score = level); a knife kill takes a
  // level from the victim; a kill on the last level (the knife) wins the match.
  armsRaceKill(killer, victim, weapon) {
    if (WEAPONS[weapon]?.melee && victim.level > 0) {
      victim.level--;
      victim.player.score = victim.level;
    }
    if (killer.level >= ARMS_RACE.length - 1) {
      killer.player.score = ARMS_RACE.length; // past the last level: the top score
      this.endMatch();
      return;
    }
    killer.level++;
    killer.player.score = killer.level;
    armLevel(killer.player.ws, ARMS_RACE, killer.level, killer.team === TEAM_CT, killer.cmdTime);
  }

  // --- Rounds -----------------------------------------------------------------------

  updateRound() {
    let t = 0, ct = 0, aliveT = 0, aliveCT = 0;
    for (const c of this.clients) {
      if (!c || !c.joined || !c.playing) continue;
      if (c.team === TEAM_CT) {
        ct++;
        if (c.alive) aliveCT++;
      } else {
        t++;
        if (c.alive) aliveT++;
      }
    }
    const rs = this.round;
    if (this.restartAt && this.tick >= this.restartAt) { // mp_restartgame
      this.restartAt = 0;
      if (t && ct && this.rules.rounds) this.startMatch();
      else this.startWarmup(false);
    }
    const ready = this.ready(t, ct), r = this.rules;
    rs.mode = (r.teammatesAreEnemies ? GAME_FFA : 0) | (r.deathmatch ? GAME_DM : 0) | (r.demo ? GAME_DEMO : 0) |
      (r.armsRace ? GAME_ARMSRACE : 0) | (r.demolition ? GAME_DEMOLITION : 0) | (r.wingman ? GAME_WINGMAN : 0);
    if (rs.phase === PHASE_WARMUP) {
      if (!ready) this.warmupReady = -1;
      else if (this.warmupReady < 0) this.warmupReady = this.tick;
      // mp_warmuptime counts from the moment both teams (free for all: two players) are there.
      if (ready && this.rules.rounds && !this.warmupManual &&
        this.tick >= this.warmupReady + this.rules.warmupTime * TICK_RATE) this.startMatch();
    } else if (!ready) { // a team emptied out
      this.setPhase(PHASE_WARMUP, 0);
      this.warmupReady = -1;
      this.resetBomb();
      console.log('waiting for players');
    } else if (rs.phase === PHASE_FREEZE && this.tick >= this.phaseEnd) {
      // Rounds that never end run on the match clock (mp_timelimit; none: no clock).
      this.setPhase(PHASE_LIVE, r.ignoreWinConditions ? r.timeLimit || Infinity : r.roundTime);
      this.buyEnd = this.tick + this.rules.buyTime * TICK_RATE;
    } else if (rs.phase === PHASE_LIVE && r.ignoreWinConditions) {
      if (this.tick >= this.phaseEnd) this.endMatch();
    } else if (rs.phase === PHASE_LIVE) {
      if (this.bomb.state === BOMB_PLANTED) { // the clock stops; dead Ts no longer lose, the bomb decides
        if (!aliveCT) this.endRound(TEAM_T, END_ELIMINATION);
      } else if (!aliveT || !aliveCT) {
        this.endRound(aliveT ? TEAM_T : aliveCT ? TEAM_CT : 0, aliveT || aliveCT ? END_ELIMINATION : END_DRAW);
      } else if (this.tick >= this.phaseEnd) {
        this.endRound(this.timeWinner, this.timeWinner ? END_TIME : END_DRAW);
      }
    } else if (rs.phase === PHASE_OVER && this.tick >= this.phaseEnd) {
      const max = this.rules.maxRounds, half = Math.floor(max / 2);
      if (rs.info >> 2 === END_MATCH || rs.scoreT > half || rs.scoreCT > half || this.roundsPlayed >= max) this.startMatch();
      else {
        const swap = this.roundsPlayed === half && this.rules.halftime;
        if (swap) this.halftime();
        this.startRound(swap);
      }
    }
    rs.ticksLeft = rs.phase === PHASE_WARMUP || this.phaseEnd === Infinity ? 0 : this.phaseEnd - this.tick;
  }

  // The time limit ran out (rounds that never end): the top score wins the match.
  endMatch() {
    const rs = this.round;
    let best = null;
    for (const c of this.clients) if (c && c.joined && c.playing && (!best || c.score > best.score)) best = c;
    rs.info = END_MATCH << 2;
    this.setPhase(PHASE_OVER, this.rules.matchRestartDelay);
    console.log(`match over${best ? `: ${best.name} wins with ${best.score} points` : ''}`);
  }

  setPhase(phase, seconds) {
    this.round.phase = phase;
    this.phaseEnd = this.tick + seconds * TICK_RATE;
  }

  startMatch() {
    const rs = this.round;
    rs.scoreT = rs.scoreCT = rs.info = rs.round = 0;
    this.roundsPlayed = 0;
    this.lossStreak[TEAM_T] = this.lossStreak[TEAM_CT] = 0;
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      c.player.money = this.rules.startMoney;
      c.player.kills = c.player.deaths = c.player.score = 0;
      c.level = c.roundKills = 0;
    }
    this.rosterDirty = true;
    console.log('match start');
    this.startRound(true);
  }

  // Everyone to a spawn point; survivors keep their gear unless `fresh`.
  startRound(fresh) {
    this.breakables.reset(this.world);
    this.doors.reset(this.world);
    this.logic.reset(this.tick);
    this.placing = true;
    for (const c of this.clients) if (c) c.placed = false;
    const demolition = this.rules.demolition;
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      if (demolition && c.roundKills > 0) c.level = Math.min(c.level + 1, DEMOLITION.length - 1); // a kill: the next weapon
      if (demolition) c.player.score = c.level; // clients show the level from the score
      c.roundKills = 0;
      // Survivors keep their gear (deathmatch: the weapons picked); Demolition arms everyone
      // for their level instead.
      this.respawn(c, !fresh && c.alive && !demolition, this.rules.deathmatch);
    }
    this.placing = false;
    this.resetBomb();
    this.items.clear(); // CS:GO cleans up the ground between rounds
    this.itemsDirty = true;
    this.grenades.clear();
    for (const c of this.clients) if (c) c.flashLeft = 0;
    // CS:GO puts two hostages at random spots.
    this.hostages.reset(this.rules.hostagesMax, Math.random, (x, y, z) => this.floorBelow(x, y, z));
    for (const c of this.clients) {
      if (!c) continue;
      c.player.carrying = false;
      c.picking = -1;
      c.useProgress = 0;
    }
    this.hostagesDirty = true;
    // One random T carries the bomb.
    const ts = this.clients.filter((c) => c && c.joined && c.alive && c.team === TEAM_T);
    if (this.bombSites.count && ts.length && this.rules.giveC4) {
      const c = ts[Math.floor(Math.random() * ts.length)];
      giveWeapon(c.player.ws, WEAPON_ID.c4);
      this.bomb.state = BOMB_CARRIED;
      this.bombCarrier = c;
    }
    this.round.round++;
    this.round.serial = (this.round.serial + 1) & 255;
    if (demolition) this.rosterDirty = true; // the new levels
    this.setPhase(PHASE_FREEZE, this.rules.freezeTime);
  }

  endRound(winner, reason) {
    const rs = this.round;
    this.roundsPlayed++;
    if (winner === TEAM_T) rs.scoreT++;
    if (winner === TEAM_CT) rs.scoreCT++;
    rs.info = winner | (reason << 2);
    for (const team of [TEAM_T, TEAM_CT]) {
      const won = team === winner;
      if (won) this.lossStreak[team] = Math.max(0, this.lossStreak[team] - 1);
      else if (winner) this.lossStreak[team] = Math.min(this.lossStreak[team] + 1, LOSS_STREAK_MAX + 1);
      let reward = won
        ? (reason === END_BOMB || reason === END_DEFUSE ? BOMB_WIN_REWARD : reason === END_RESCUE ? RESCUE_WIN_REWARD
          : WIN_REWARD)
        : lossBonus(Math.max(this.lossStreak[team], 1));
      if (!won && team === TEAM_T && this.planted) reward += PLANT_LOSS_BONUS;
      for (const c of this.clients) {
        if (!c || !c.joined || c.team !== team) continue;
        // Ts still alive when the clock runs out get nothing (CS:GO: no free saving).
        if (!won && team === TEAM_T && reason === END_TIME && c.alive) continue;
        c.player.money = Math.min(this.rules.maxMoney, c.player.money + reward);
      }
    }
    this.setPhase(PHASE_OVER, this.rules.roundEndDelay);
    const who = winner === TEAM_T ? 'Terrorists' : winner === TEAM_CT ? 'Counter-Terrorists' : 'nobody';
    console.log(`round ${rs.round}: ${who} win (${rs.scoreT}-${rs.scoreCT})`);
  }

  // Back to warmup (`manual`: until mp_warmup_end, else for mp_warmuptime): everyone
  // respawns with warmup money; the match starts when it ends.
  startWarmup(manual) {
    this.setPhase(PHASE_WARMUP, 0);
    this.warmupReady = -1;
    this.warmupManual = manual;
    this.resetBomb();
    const rs = this.round;
    rs.scoreT = rs.scoreCT = rs.info = rs.round = 0;
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      c.player.money = WARMUP_MONEY;
      this.respawn(c, false, true);
    }
    this.rosterDirty = true;
  }

  // mp_restartgame: a fresh match in `seconds`.
  restartGame(seconds) {
    this.restartAt = this.tick + Math.max(1, seconds) * TICK_RATE;
  }

  // mp_warmup_end: start the match now if both teams have players.
  endWarmup() {
    if (this.phase !== PHASE_WARMUP) return 'not in warmup';
    let t = 0, ct = 0;
    for (const c of this.clients) if (c && c.joined && c.playing) c.team === TEAM_CT ? ct++ : t++;
    if (!this.ready(t, ct)) {
      return this.rules.teammatesAreEnemies ? 'the match needs two players' : 'the match needs players on both teams';
    }
    this.warmupManual = false;
    this.startMatch();
    return '';
  }

  // --- Client commands ---------------------------------------------------------------

  // Console text for one client (split into datagram-sized PRINTs).
  print(c, text) {
    for (const chunk of printChunks(text)) c.session.send(writePrint(c.writer(), chunk));
  }

  // Everyone's console.
  printAll(text) {
    for (const c of this.clients) if (c && c.joined) this.print(c, text);
  }

  // Commands a client's console sends to the server (Source "client commands").
  clientCommand(c, text) {
    const args = parse(text)[0];
    if (!args) return;
    const name = args[0].toLowerCase();
    if (name === 'name') {
      const n = args.slice(1).join(' ').trim().slice(0, 31);
      if (!n || n === c.name) return;
      console.log(`player ${c.id} "${c.name}" is now "${n}"`);
      c.name = n;
      this.rosterDirty = true;
    } else if (name === 'jointeam') {
      this.joinTeam(c, +args[1]);
    } else if (name === 'kill') {
      if (c.alive) this.kill(c, c, 0, false);
    } else if (name === 'takeover') { // E while watching a teammate bot
      const err = this.takeOver(c, +args[1]);
      if (err) this.print(c, `takeover: ${err}`);
    } else if (name === 'setpos') { // CS:GO: setpos x y z puts the feet there (sv_cheats)
      if (!this.rules.cheats) {
        this.print(c, `Can't use cheat command setpos in multiplayer, unless the server has sv_cheats set to 1.`);
      } else if (c.alive && args.length >= 4 && args.slice(1, 4).every((v) => Number.isFinite(+v))) {
        const f = c.player.ps.f;
        f[PS_ORIGIN] = +args[1];
        f[PS_ORIGIN + 1] = +args[2];
        f[PS_ORIGIN + 2] = +args[3] + feetOffset(c.player.ps.i[PS_FLAGS]);
        f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
      }
    } else if (name === 'rcon') { // the rest of the line, quotes and `;` included, is the command
      const m = /^\s*rcon\s+("[^"]*"|\S+)\s*([^]*)$/i.exec(text);
      this.print(c, this.rconCommand(c, m ? m[1].replace(/^"|"$/g, '') : '', m ? m[2] : ''));
    } else {
      this.print(c, `Unknown command "${args[0]}"`);
    }
  }

  // The Host checks the password and limits guessing (server/host.js).
  rconCommand(c, password, command) {
    if (!this.rcon) return 'rcon is disabled on this server (no rcon_password)';
    return this.rcon(c, password, command) ?? 'Bad rcon_password.';
  }

  // CS:GO jointeam: 1 = spectators, 2 = T, 3 = CT. Switching while alive costs the life
  // (no death counted); you play from the next round (at once in warmup or freeze time).
  joinTeam(c, n) {
    const team = n === 1 ? TEAM_SPECTATOR : n === 2 ? TEAM_T : n === 3 ? TEAM_CT : 0;
    if (!team) return this.print(c, 'jointeam 1 (Spectators), 2 (Terrorists) or 3 (Counter-Terrorists)');
    if (team === c.team) return;
    if (team !== TEAM_SPECTATOR && this.teamFull(team, c)) {
      return this.print(c, `The ${TEAM_NAMES[team]}s are full (mp_teamsize_max ${this.rules.teamSizeMax})`);
    }
    if (this.bombCarrier === c) this.dropBomb(c, false);
    this.dropHostage(c);
    c.player.team = team;
    c.player.health = 0;
    c.life++;
    this.rosterDirty = true;
    if (this.phase === PHASE_WARMUP || this.phase === PHASE_FREEZE) this.respawn(c, false, this.phase === PHASE_WARMUP);
    else if (this.phase === PHASE_LIVE && this.respawns(c)) c.respawnTick = this.tick + DM_RESPAWN * TICK_RATE;
    console.log(`player ${c.id} "${c.name}" joined ${team === TEAM_SPECTATOR ? 'the spectators' : `the ${TEAM_NAMES[team]}s`}`);
  }

  // Has `team` its mp_teamsize_max players already (not counting `except`)?
  teamFull(team, except = null) {
    const max = this.rules.teamSizeMax;
    if (!max) return false;
    let n = 0;
    for (const o of this.clients) if (o && o !== except && o.joined && o.playing && o.team === team) n++;
    return n >= max;
  }

  // Drops a client from the server with a reason.
  kick(c, reason = 'kicked') {
    c.session.send(writeReject(c.writer(), reason));
    c.joined = false;
    c.session.close(reason);
    console.log(`player ${c.id} "${c.name}" kicked (${reason})`);
    this.disconnect(c);
  }

  // --- The bomb -------------------------------------------------------------------

  // No bomb anywhere (round start, back to warmup).
  resetBomb() {
    for (const c of this.clients) {
      if (c) c.player.ws.f.fill(0, WS_SLOTS + SLOT_C4 * 3, WS_SLOTS + SLOT_C4 * 3 + 3);
    }
    this.bomb.state = BOMB_NONE;
    this.bomb.ticksLeft = 0;
    this.bombCarrier = null;
    this.planted = false;
  }

  // Floor height under (x, y, z), at most 512 units down.
  floorBelow(x, y, z) {
    const t = traceHull(this.world, HULL_POINT, x, y, z, x, y, z - 512, this.bombTrace);
    return t.startsolid ? z : t.endz;
  }

  // Where something a player lets go of lands: thrown THROW_DISTANCE ahead (stopping
  // short of walls) or at their feet, on the floor. Returns this.landing [x, y, z].
  landingSpot(c, thrown) {
    const f = c.player.ps.f, out = this.landing;
    let x = f[PS_ORIGIN], y = f[PS_ORIGIN + 1];
    const z = f[PS_ORIGIN + 2];
    if (thrown) {
      const dx = Math.cos(c.yaw * Math.PI / 180), dy = Math.sin(c.yaw * Math.PI / 180);
      const t = traceHull(this.world, HULL_POINT, x, y, z, x + dx * THROW_DISTANCE, y + dy * THROW_DISTANCE, z,
        this.bombTrace);
      const d = Math.max(0, THROW_DISTANCE * t.fraction - 8); // keep clear of a wall it hit
      x += dx * d;
      y += dy * d;
    }
    out[0] = x;
    out[1] = y;
    out[2] = this.floorBelow(x, y, z);
    return out;
  }

  // The carrier lets go of the bomb: thrown ahead (G) or where they died.
  dropBomb(c, thrown) {
    if (this.bombCarrier !== c) return;
    c.player.ws.f.fill(0, WS_SLOTS + SLOT_C4 * 3, WS_SLOTS + SLOT_C4 * 3 + 3);
    const spot = this.landingSpot(c, thrown), b = this.bomb;
    b.state = BOMB_DROPPED;
    b.x = spot[0];
    b.y = spot[1];
    b.z = spot[2];
    this.bombCarrier = null;
    this.pickupTick = this.tick + (thrown ? PICKUP_DELAY : 0);
  }

  // --- Weapons on the ground -----------------------------------------------------------

  // c lets go of a weapon: thrown from the eye along the view (G, buying over it), or
  // let go of at chest height (dying, swapping with E); it flies and lands (Items.update).
  spawnItem(c, weapon, clip, reserve, thrown) {
    const w = WEAPONS[weapon];
    if (!w || w.melee || w.c4) return;
    const p = c.player, f = p.ps.f;
    const ez = f[PS_ORIGIN + 2] + (thrown ? eyeOffset(p.ps) - 6 : 10);
    this.items.throw(this.world, weapon, clip, reserve, c.id, f[PS_ORIGIN], f[PS_ORIGIN + 1], ez, thrown ? c.pitch : 0,
      c.yaw, thrown ? THROW_SPEED : LET_GO_SPEED, f[PS_VEL], f[PS_VEL + 1], f[PS_VEL + 2],
      this.tick + (thrown ? PICKUP_DELAY : 0));
    this.itemsDirty = true;
  }

  // Empties `slot` (without switching weapons: a purchase refills it, the dead hold
  // nothing) and puts its weapon on the ground.
  dropSlot(c, slot, thrown) {
    const f = c.player.ws.f, o = WS_SLOTS + slot * 3;
    const weapon = f[o], clip = f[o + 1], reserve = f[o + 2];
    if (!weapon) return;
    f[o] = f[o + 1] = f[o + 2] = 0;
    this.spawnItem(c, weapon, clip, reserve, thrown);
  }

  // Gives item i to c (into its slot, which must be free; a grenade joins the others)
  // and takes it off the ground.
  takeItem(c, i) {
    const it = this.items, w = WEAPONS[it.weapon[i]];
    const f = c.player.ws.f, o = WS_SLOTS + w.slot * 3;
    if (w.grenade) {
      giveWeapon(c.player.ws, it.weapon[i]);
      it.remove(i);
      this.itemsDirty = true;
      return;
    }
    f[o] = it.weapon[i];
    f[o + 1] = it.clip[i];
    f[o + 2] = it.reserve[i];
    it.remove(i);
    this.itemsDirty = true;
  }

  // Each tick: the living take weapons they walk over when that slot is free.
  updateItems() {
    const it = this.items;
    if (it.update(this.world)) this.itemsDirty = true; // flying ones go out every tick
    for (const c of this.clients) {
      if (!c || !c.joined || !c.alive) continue;
      const f = c.player.ps.f, ws = c.player.ws.f;
      const feet = f[PS_ORIGIN + 2] - feetOffset(c.player.ps.i[PS_FLAGS]);
      for (let i = 0; i < it.count; i++) {
        const w = WEAPONS[it.weapon[i]];
        if (this.tick < it.pickupTick[i] || it.flying[i]) continue;
        if (w.grenade ? !canCarryGrenade(c.player.ws, it.weapon[i]) : ws[WS_SLOTS + w.slot * 3]) continue;
        if (Math.hypot(f[PS_ORIGIN] - it.x[i], f[PS_ORIGIN + 1] - it.y[i]) > PICKUP_RANGE) continue;
        if (Math.abs(feet - it.z[i]) > 40) continue;
        this.takeItem(c, i);
        break;
      }
    }
  }

  // E: the nearest weapon on the ground in front of c's eyes (within USE_RANGE and
  // USE_CONE) replaces the one in its slot, which drops at c's feet.
  useItem(c) {
    const it = this.items, f = c.player.ps.f;
    const ex = f[PS_ORIGIN], ey = f[PS_ORIGIN + 1], ez = f[PS_ORIGIN + 2] + eyeOffset(c.player.ps);
    const cp = Math.cos(c.pitch * Math.PI / 180);
    const dx = cp * Math.cos(c.yaw * Math.PI / 180), dy = cp * Math.sin(c.yaw * Math.PI / 180);
    const dz = -Math.sin(c.pitch * Math.PI / 180);
    let best = -1, bestD = USE_RANGE;
    for (let i = 0; i < it.count; i++) {
      if (WEAPONS[it.weapon[i]].grenade || it.flying[i]) continue; // grenades are walked over
      const vx = it.x[i] - ex, vy = it.y[i] - ey, vz = it.z[i] + 2 - ez, d = Math.hypot(vx, vy, vz);
      if (d >= bestD || (vx * dx + vy * dy + vz * dz) / d < USE_CONE) continue;
      best = i;
      bestD = d;
    }
    if (best < 0) return;
    const o = WS_SLOTS + WEAPONS[it.weapon[best]].slot * 3, ws = c.player.ws.f;
    const old = ws[o], oldClip = ws[o + 1], oldReserve = ws[o + 2];
    ws[o] = ws[o + 1] = ws[o + 2] = 0;
    this.takeItem(c, best);
    if (old) this.spawnItem(c, old, oldClip, oldReserve, false);
  }

  // --- Doors ----------------------------------------------------------------------------

  // Map logic, then doors move (pushing living players) to where they are this tick, so
  // the tick's commands run against them as the clients predict.
  updateDoors() {
    if (!this.doors.count && !this.logic.triggers.length) return;
    const bodies = this.doorBodies, acts = this.doorActs;
    bodies.length = acts.length = 0;
    for (const c of this.clients) {
      if (!c || !c.joined || !c.alive) continue;
      bodies.push(c.player.ps);
      acts.push(this.actOf(c));
    }
    this.logic.update(this.tick, acts);
    this.doors.update(this.world, this.tick, bodies, this.fireTarget);
  }

  // Where client c stands and looks (door swing side, trigger activator).
  actOf(c) {
    const a = c.act || (c.act = { x: 0, y: 0, z: 0, yaw: 0 }), f = c.player.ps.f;
    a.x = f[PS_ORIGIN];
    a.y = f[PS_ORIGIN + 1];
    a.z = f[PS_ORIGIN + 2];
    a.yaw = c.yaw;
    return a;
  }

  // +use on a usable door or button in reach; true if one was used.
  useDoor(c) {
    const d = this.doors;
    if (!d.count) return false;
    const f = c.player.ps.f, x = f[PS_ORIGIN], y = f[PS_ORIGIN + 1], z = f[PS_ORIGIN + 2];
    const cp = Math.cos(c.pitch * Math.PI / 180);
    const k = d.findUse(this.world, x, y, z, x, y, z + eyeOffset(c.player.ps), cp * Math.cos(c.yaw * Math.PI / 180),
      cp * Math.sin(c.yaw * Math.PI / 180), -Math.sin(c.pitch * Math.PI / 180));
    if (k < 0) return false;
    d.use(k, this.tick, this.actOf(c));
    return true;
  }

  // --- Hostages ------------------------------------------------------------------------

  // A CT holding use on an idle hostage picks it up after PICKUP_TIME (letting go or
  // looking away starts over); one at a time.
  useHostage(c) {
    const h = this.hostages, p = c.player;
    c.useProgress = 0;
    if (!h.count || c.team !== TEAM_CT || !c.alive || !(c.buttons & IN_USE) || p.carrying || p.ws.f[WS_ACTION]) {
      c.picking = -1;
      return;
    }
    const f = p.ps.f;
    const k = h.inReach(f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2] + eyeOffset(p.ps), c.pitch, c.yaw);
    if (k < 0) {
      c.picking = -1;
      return;
    }
    if (k !== c.picking) {
      c.picking = k;
      c.pickEnd = this.tick + Math.round(PICKUP_TIME * TICK_RATE);
    }
    c.useProgress = 1 - (c.pickEnd - this.tick) / (PICKUP_TIME * TICK_RATE);
    if (this.tick < c.pickEnd) return;
    h.state[k] = HS_CARRIED;
    h.carrier[k] = c.id;
    p.carrying = true;
    c.picking = -1;
    c.useProgress = 0;
    if (!h.touched[k] && this.phase !== PHASE_WARMUP) p.money = Math.min(this.rules.maxMoney, p.money + HOSTAGE_TOUCH_REWARD);
    h.touched[k] = 1;
    this.hostagesDirty = true;
  }

  // The carrier lets go (death, leaving): the hostage stands where he was.
  dropHostage(c) {
    const h = this.hostages, k = h.carriedBy(c.id);
    c.player.carrying = false;
    if (k < 0) return;
    const f = c.player.ps.f;
    h.place(k, f[PS_ORIGIN], f[PS_ORIGIN + 1], this.floorBelow(f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2]), c.yaw);
    this.hostagesDirty = true;
  }

  // Carried into a rescue zone: rescued, and (CS:GO) the CTs win the round.
  updateHostages() {
    const h = this.hostages;
    for (let k = 0; k < h.count; k++) {
      if (h.state[k] !== HS_CARRIED) continue;
      const c = this.clients[h.carrier[k]];
      if (!c || !c.alive) continue;
      const f = c.player.ps.f;
      if (!this.rescue.contains(f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2])) continue;
      h.state[k] = HS_RESCUED;
      c.player.carrying = false;
      this.hostagesDirty = true;
      if (this.phase === PHASE_LIVE) {
        c.player.money = Math.min(this.rules.maxMoney, c.player.money + RESCUE_REWARD);
        console.log(`hostage rescued by ${c.name}`);
        this.endRound(TEAM_CT, END_RESCUE);
      }
    }
  }

  // A bullet hit hostage k: the shooter pays for it, more for killing it.
  hurtHostage(shooter, k, damage) {
    const h = this.hostages;
    if (h.state[k] !== HS_IDLE) return;
    h.health[k] -= Math.trunc(damage);
    const p = shooter.player, penalty = h.health[k] <= 0 ? HOSTAGE_KILL_PENALTY : HOSTAGE_HIT_PENALTY;
    if (this.phase !== PHASE_WARMUP) p.money = Math.max(0, p.money - penalty);
    if (h.health[k] <= 0) {
      h.health[k] = 0;
      h.state[k] = HS_DEAD;
      this.print(shooter, 'You killed a hostage.');
    }
    this.hostagesDirty = true;
  }

  sendHostages() {
    this.hostagesDirty = false;
    const bytes = writeHostages(this.hostageWriter, this.hostages).slice();
    for (const c of this.clients) if (c && c.joined) c.session.send(bytes);
  }

  // Every tick (a few bytes when there are none): grenades lost with a datagram come
  // back on the next one.
  sendGrenades() {
    const bytes = writeGrenades(this.grenadeWriter, this.tick, this.grenades).slice();
    for (const c of this.clients) if (c && c.joined) c.session.send(bytes);
  }

  sendItems() {
    this.itemsDirty = false;
    const bytes = writeItems(this.itemsWriter, this.items).slice();
    for (const c of this.clients) if (c && c.joined) c.session.send(bytes);
  }

  plantBomb(c) {
    const p = c.player;
    if (this.phase !== PHASE_LIVE || this.bombCarrier !== c) { // round over: they keep it
      if (this.bombCarrier === c) giveWeapon(p.ws, WEAPON_ID.c4);
      return;
    }
    const f = p.ps.f, b = this.bomb;
    b.state = BOMB_PLANTED;
    b.x = f[PS_ORIGIN];
    b.y = f[PS_ORIGIN + 1];
    b.z = this.floorBelow(b.x, b.y, f[PS_ORIGIN + 2] - feetOffset(p.ps.i[PS_FLAGS]) + 1);
    this.explodeTick = this.tick + this.rules.c4Timer * TICK_RATE;
    b.ticksLeft = this.explodeTick - this.tick;
    this.bombCarrier = null;
    this.planted = true;
    this.lastPlanter = c;
    p.money = Math.min(this.rules.maxMoney, p.money + PLANT_REWARD);
    console.log(`bomb planted by player ${c.id}`);
  }

  defuseBomb(c) {
    if (this.bomb.state !== BOMB_PLANTED || this.phase !== PHASE_LIVE || !c.alive) return;
    this.bomb.state = BOMB_DEFUSED;
    c.player.money = Math.min(this.rules.maxMoney, c.player.money + DEFUSE_REWARD);
    console.log(`bomb defused by player ${c.id}`);
    this.restockTick = this.tick + DEMO_RESTOCK * TICK_RATE;
    if (!this.rules.ignoreWinConditions) this.endRound(TEAM_CT, END_DEFUSE);
  }

  // Each tick: Ts walking over a dropped bomb pick it up; a planted one counts down.
  updateBomb() {
    const b = this.bomb;
    if (b.state === BOMB_DROPPED && this.tick >= this.pickupTick) {
      for (const c of this.clients) {
        if (!c || !c.joined || !c.alive || (c.team !== TEAM_T && !this.rules.demo)) continue;
        const f = c.player.ps.f;
        const feet = f[PS_ORIGIN + 2] - feetOffset(c.player.ps.i[PS_FLAGS]);
        if (Math.hypot(f[PS_ORIGIN] - b.x, f[PS_ORIGIN + 1] - b.y) > PICKUP_RANGE || Math.abs(feet - b.z) > 40) continue;
        giveWeapon(c.player.ws, WEAPON_ID.c4);
        b.state = BOMB_CARRIED;
        this.bombCarrier = c;
        break;
      }
    }
    if (b.state === BOMB_PLANTED) {
      b.ticksLeft = this.explodeTick - this.tick;
      if (b.ticksLeft <= 0) this.explodeBomb();
    }
    if (this.rules.demo) this.demoBomb();
  }

  // The demo: with no bomb in play (none yet, or DEMO_RESTOCK s after one went off or was
  // defused), the last planter (else the first human) gets a new one, whatever the team.
  demoBomb() {
    const b = this.bomb;
    if (!this.bombSites.count || this.phase !== PHASE_LIVE || this.tick < this.restockTick) return;
    if (b.state === BOMB_CARRIED || b.state === BOMB_DROPPED || b.state === BOMB_PLANTED) return;
    let c = this.demoHuman(this.lastPlanter) ? this.lastPlanter : null;
    for (let i = 0; !c && i < this.clients.length; i++) if (this.demoHuman(this.clients[i])) c = this.clients[i];
    if (!c) return;
    giveWeapon(c.player.ws, WEAPON_ID.c4);
    b.state = BOMB_CARRIED;
    this.bombCarrier = c;
  }

  demoHuman(c) {
    return c && c.joined && c.alive && c.playing && !c.bot;
  }

  // The demo: a human's health comes back DEMO_HEAL s after the last hurt.
  demoHeal(c) {
    const p = c.player;
    if (c.bot || !c.alive) return;
    if (p.health < c.lastHealth) c.healAt = this.tick + DEMO_HEAL * TICK_RATE;
    else if (p.health < 100 && this.tick >= c.healAt) p.health = 100;
    c.lastHealth = p.health;
  }

  // Everyone in range takes the blast (through walls) as a chest hit; armor helps.
  explodeBomb() {
    const b = this.bomb;
    b.state = BOMB_EXPLODED;
    b.ticksLeft = 0;
    const c4 = WEAPONS[WEAPON_ID.c4];
    for (const c of this.clients) {
      if (!c || !c.joined || !c.alive) continue;
      const f = c.player.ps.f;
      const damage = bombDamage(this.bombSites.radius,
        Math.hypot(f[PS_ORIGIN] - b.x, f[PS_ORIGIN + 1] - b.y, f[PS_ORIGIN + 2] - b.z));
      if (damage <= 0) continue;
      applyDamage(c.player, damage, c4, HITGROUP_CHEST);
      if (c.player.health <= 0) this.kill(c, c, WEAPON_ID.c4, false);
    }
    // CS: the site fires its target (de_torn blows a door open).
    const site = this.bombSites.siteAt(b.x, b.y, b.z, 16, 16, 16);
    if (site >= 0 && this.bombSites.targets[site]) this.fireTarget(this.bombSites.targets[site], null);
    console.log('bomb exploded');
    this.restockTick = this.tick + DEMO_RESTOCK * TICK_RATE;
    if (this.phase === PHASE_LIVE && !this.rules.ignoreWinConditions) this.endRound(TEAM_T, END_BOMB);
  }

  // After round 15: teams swap sides, scores follow them, money restarts.
  halftime() {
    const rs = this.round;
    [rs.scoreT, rs.scoreCT] = [rs.scoreCT, rs.scoreT];
    [this.lossStreak[TEAM_T], this.lossStreak[TEAM_CT]] = [0, 0];
    for (const c of this.clients) {
      if (!c || !c.joined || !c.playing) continue;
      c.player.team = c.team === TEAM_CT ? TEAM_T : TEAM_CT;
      c.player.money = this.rules.startMoney;
    }
    this.rosterDirty = true;
    console.log('halftime: teams swap');
  }

  // --- Radar ----------------------------------------------------------------------

  // CS:GO's "spotted": a player shows on the other team's radar while one of them sees
  // him (in the view cone, no wall or smoke between their eye and his head or chest),
  // and on everyone's for a moment after firing an unsilenced gun. Free for all has no
  // team to share sight with: only firing shows (approx. of CS:GO's deathmatch radar).
  updateSpotting() {
    if (this.tick % SPOT_TICKS !== 0) return;
    const ffa = this.rules.teammatesAreEnemies, all = this.clients;
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (!c || !c.joined) continue;
      let bits = c.alive && this.tick < c.revealUntil ? ANIM_SPOTTED_T | ANIM_SPOTTED_CT : 0;
      if (c.alive && !ffa) {
        for (let j = 0; j < all.length; j++) {
          const o = all[j];
          if (!o || !o.joined || !o.alive || !o.playing || o.team === c.team) continue;
          const bit = o.team === TEAM_T ? ANIM_SPOTTED_T : ANIM_SPOTTED_CT;
          if (!(bits & bit) && this.sees(o, c)) bits |= bit;
        }
      }
      c.spotted = bits;
    }
  }

  // Can `o` see `c` (head or chest) anywhere around him (no view cone)?
  visible(o, c) {
    return this.sees(o, c, -1);
  }

  // Can `o` see `c` (head or chest) within his view cone?
  sees(o, c, cone = SPOT_CONE) {
    const f = o.player.ps.f, ex = f[PS_ORIGIN], ey = f[PS_ORIGIN + 1], ez = f[PS_ORIGIN + 2] + eyeOffset(o.player.ps);
    const cp = Math.cos(o.pitch * DEG), vx = cp * Math.cos(o.yaw * DEG), vy = cp * Math.sin(o.yaw * DEG);
    const vz = -Math.sin(o.pitch * DEG);
    const g = c.player.ps.f, tr = this.spotTrace;
    for (let k = 0; k < 2; k++) { // head, then chest
      const x = g[PS_ORIGIN], y = g[PS_ORIGIN + 1], z = g[PS_ORIGIN + 2] + (k ? 0 : eyeOffset(c.player.ps));
      const dx = x - ex, dy = y - ey, dzz = z - ez, d = Math.hypot(dx, dy, dzz);
      if (d > 0 && (dx * vx + dy * vy + dzz * vz) / d < cone) continue; // outside their view
      traceHull(this.world, HULL_POINT, ex, ey, ez, x, y, z, tr);
      if (tr.fraction >= 1 && !this.grenades.smokeBetween(ex, ey, ez, x, y, z)) return true;
    }
    return false;
  }

  // --- Lag compensation ---------------------------------------------------------

  recordHistory() {
    const H = this.history;
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      const k = c.id * HISTORY + (this.tick & (HISTORY - 1));
      const o = k * H_FIELDS, p = c.player;
      this.historyTick[k] = this.tick;
      H[o + H_X] = p.ps.f[PS_ORIGIN];
      H[o + H_Y] = p.ps.f[PS_ORIGIN + 1];
      H[o + H_Z] = p.ps.f[PS_ORIGIN + 2];
      H[o + H_YAW] = c.yaw;
      H[o + H_FLAGS] = p.ps.i[PS_FLAGS];
      H[o + H_DUCK] = p.ps.f[PS_DUCK_AMOUNT];
      H[o + H_LIFE] = c.alive ? c.life : 0;
    }
  }

  // Puts every player where the shooter saw them: at server tick `view` (fractional,
  // from the shooter's interpolation), clamped to the history we keep.
  rewind(view) {
    const T = this.targets, H = this.history, now = this.tick - 1; // last recorded tick
    let at = Math.min(Math.max(view, now - HISTORY + 2), now);
    if (!(at >= 0)) at = now;
    const t0 = Math.floor(at), frac = at - t0;
    T.clear();
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      const base = c.id * HISTORY;
      let k0 = base + (t0 & (HISTORY - 1));
      const k1 = base + ((t0 + 1) & (HISTORY - 1));
      if (this.historyTick[k0] !== t0) k0 = base + (now & (HISTORY - 1)); // joined later: use latest
      if (this.historyTick[k0] < 0 || !this.history[k0 * H_FIELDS + H_LIFE]) continue; // dead then
      const a = k0 * H_FIELDS;
      let f = 0, b = a;
      if (frac > 0 && this.historyTick[k1] === t0 + 1 && H[k1 * H_FIELDS + H_LIFE] === H[a + H_LIFE]) {
        b = k1 * H_FIELDS;
        f = frac;
      }
      let dyaw = H[b + H_YAW] - H[a + H_YAW];
      dyaw -= Math.round(dyaw / 360) * 360;
      T.set(c.id, H[a + H_X] + (H[b + H_X] - H[a + H_X]) * f, H[a + H_Y] + (H[b + H_Y] - H[a + H_Y]) * f,
        H[a + H_Z] + (H[b + H_Z] - H[a + H_Z]) * f, H[a + H_YAW] + dyaw * f,
        f < 0.5 ? H[a + H_FLAGS] : H[b + H_FLAGS], H[a + H_DUCK] + (H[b + H_DUCK] - H[a + H_DUCK]) * f, c.team);
    }
    // Standing hostages (they do not move: no history needed).
    const h = this.hostages;
    for (let k = 0; k < h.count; k++) {
      if (h.state[k] === HS_IDLE) T.set(MAX_PLAYERS + k, h.x[k], h.y[k], h.z[k] + 36, h.yaw[k], FL_ONGROUND, 0, 0);
    }
  }

  // --- Output -------------------------------------------------------------------

  sendInfo() {
    this.rosterDirty = false;
    const roster = this.clients.map((c) => (c && c.joined ? c : null));
    const bytes = writeInfo(this.infoWriter, roster).slice();
    for (const c of this.clients) if (c && c.joined) c.session.send(bytes);
  }

  sendSnapshots() {
    const ring = this.snapshots;
    const seq = this.tick;
    const k = ring.claim(seq);
    const E = ring.ents;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const c = this.clients[id];
      const row = ring.row(k, id);
      if (!c || !c.joined || !c.playing || c.controlled) { // spectators and taken-over bots are nowhere
        E.fill(0, row, row + E_FIELDS);
        continue;
      }
      const p = c.player;
      E[row + E_ACTIVE] = 1;
      E[row + E_X] = p.ps.f[PS_ORIGIN];
      E[row + E_Y] = p.ps.f[PS_ORIGIN + 1];
      E[row + E_Z] = p.ps.f[PS_ORIGIN + 2];
      E[row + E_PITCH] = quantizePitch(c.pitch);
      E[row + E_YAW] = quantizeYaw(c.yaw);
      E[row + E_FLAGS] = p.ps.i[PS_FLAGS];
      E[row + E_DUCK] = Math.round(p.ps.f[PS_DUCK_AMOUNT] * 255);
      E[row + E_WEAPON] = p.ws.f[WS_SLOTS + p.ws.f[WS_ACTIVE] * 3];
      E[row + E_HEALTH] = Math.min(Math.max(Math.ceil(p.health), 0), 255);
      E[row + E_TEAM] = p.team;
      const action = p.ws.f[WS_ACTION];
      E[row + E_ANIM] = (p.ws.f[WS_RELOAD_END] > 0 ? ANIM_RELOAD : 0) | (action === ACTION_PLANT ? ANIM_PLANT : 0) |
        (action === ACTION_DEFUSE ? ANIM_DEFUSE : 0) | (p.helmet && p.armor > 0 ? ANIM_HELMET : 0) |
        (silenced(p.ws, p.ws.f[WS_ACTIVE]) ? ANIM_SILENCED : 0) | c.spotted | (c.immune ? ANIM_IMMUNE : 0);
      E[row + E_SHOTS] = c.shots;
    }
    const words = ring.broken;
    words.fill(0, k * 8, k * 8 + 8);
    const b = this.breakables;
    for (let s = 1; s <= b.count; s++) if (b.broken[s]) words[k * 8 + (s >> 5)] |= 1 << (s & 31);

    for (const c of this.clients) {
      if (!c || !c.joined || c.bot) continue;
      const base = c.ackSeq ? ring.find(c.ackSeq) : -1;
      c.session.send(writeSnapshot(c.writer(), ring, k, base, c.id, c, this.events, this.round, this.bomb, this.doors));
    }
  }
}
