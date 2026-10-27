// Authoritative game state: runs every client's user commands through the shared
// player simulation, resolves shots with lag compensation, runs CS:GO rounds, the
// bomb and the economy, and sends each client a delta-compressed snapshot (plus the tick's shot and
// kill events) every tick. Transport-agnostic: sessions only need send(bytes) and
// close(reason).

import { parseVec3 } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_STAND, HULL_POINT } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { PS_ORIGIN, PS_FLAGS, PS_DUCK_AMOUNT } from '../shared/pmove.js';
import {
  ShotList, WEAPONS, WEAPON_ID, giveWeapon, WS_SLOTS, WS_ACTIVE, WS_EVENTS, SLOT_C4, WEV_PLANTED, WEV_DEFUSED, WEV_DROP,
} from '../shared/weapons.js';
import { HitTargets, HITGROUP_HEAD, HITGROUP_CHEST, feetOffset } from '../shared/hitgroups.js';
import {
  BombSites, BombState, bombDamage, C4_TIMER, PICKUP_RANGE, BOMB_NONE, BOMB_CARRIED, BOMB_DROPPED, BOMB_PLANTED,
  BOMB_DEFUSED, BOMB_EXPLODED,
} from '../shared/bomb.js';
import {
  Player, spawnPlayer, runCommand, resolveShots, applyDamage, ImpactList, TEAM_T, TEAM_CT,
} from '../shared/player.js';
import { SurfaceMap } from '../shared/surfaces.js';
import {
  PHASE_WARMUP, PHASE_FREEZE, PHASE_LIVE, PHASE_OVER, FREEZE_TIME, ROUND_TIME, BUY_TIME, ROUND_END_DELAY,
  MAX_ROUNDS, WARMUP_RESPAWN, START_MONEY, MAX_MONEY, WIN_REWARD, BOMB_WIN_REWARD, PLANT_REWARD, DEFUSE_REWARD,
  PLANT_LOSS_BONUS, LOSS_STREAK_MAX, TEAMKILL_PENALTY, END_ELIMINATION, END_TIME, END_DRAW, END_BOMB, END_DEFUSE,
  lossBonus, buyError, applyBuy, BuyZones,
} from '../shared/economy.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, CMD_REDUNDANCY, C2S_HELLO, C2S_CMDS, C2S_BYE, C2S_BUY, SHOT_IMPACT, SHOT_BLOOD,
  KILL_HEADSHOT, KILL_REPEAT_TICKS, Writer, Reader, CmdRing, SnapshotRing, EventList, RoundState, readHello,
  writeWelcome, writeReject, writeInfo, readCmds, writeSnapshot, quantizePitch, quantizeYaw, E_ACTIVE, E_X, E_Y, E_Z,
  E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_FIELDS,
} from '../shared/protocol.js';

const CMD_BANK = 8; // commands a client may run ahead of server time (absorbs jitter, stops speedhacks)
const MAX_CMDS_PER_TICK = 8;
const TIMEOUT_TICKS = 30 * TICK_RATE; // clients in hidden tabs send a 1 Hz keepalive
const INFO_INTERVAL = TICK_RATE; // roster resent every second (datagrams can be lost)
const SEND_BUFFERS = 8; // rotating send buffers: a datagram may still be queued when the next is written
const WARMUP_MONEY = 16000; // CS:GO warmup: buy anything
const THROW_DISTANCE = 64; // a dropped (G) bomb lands this far ahead
const PICKUP_DELAY = TICK_RATE; // ticks before a thrown bomb can be picked up

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
    this.respawnTick = Infinity; // while dead in warmup: server tick to respawn at
    this.life = 0; // increments per spawn: history never interpolates across a respawn
    this.placed = false; // round start: already put on a spawn point
    this.canBuy = false;
    this.lastBuy = -1; // newest BUY id handled
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

  get kills() {
    return this.player.kills;
  }

  get deaths() {
    return this.player.deaths;
  }

  writer() {
    const w = this.out[this.outNext];
    this.outNext = (this.outNext + 1) % SEND_BUFFERS;
    return w;
  }
}

// Round rules; tests override them (shorter timings, or no rounds at all).
export const DEFAULT_RULES = {
  rounds: true, // false: stay in warmup (free respawns) forever
  freezeTime: FREEZE_TIME,
  roundTime: ROUND_TIME,
  buyTime: BUY_TIME,
  roundEndDelay: ROUND_END_DELAY,
  c4Timer: C4_TIMER,
};

export class Game {
  constructor(mapName, bsp, rules = {}) {
    this.mapName = mapName;
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.world = CollisionWorld.fromBSP(bsp);
    this.world.surfaces = new SurfaceMap(bsp);
    this.breakables = new Breakables(bsp, this.world);
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
    this.targets = new HitTargets(MAX_PLAYERS);
    this.shots = new ShotList();
    this.impacts = new ImpactList();
    this.reader = new Reader();
    this.infoWriter = new Writer();

    // Rounds.
    this.round = new RoundState();
    this.phaseEnd = 0;
    this.buyEnd = 0;
    this.roundsPlayed = 0;
    this.lossStreak = { [TEAM_T]: 0, [TEAM_CT]: 0 };
    this.placing = false;

    // The bomb.
    this.bomb = new BombState();
    this.bombCarrier = null; // Client
    this.explodeTick = 0;
    this.pickupTick = 0; // a dropped bomb can be picked up from this tick on
    this.planted = false; // this round: the Ts' plant bonus
    this.bombTrace = new Trace();
  }

  get playerCount() {
    return this.clients.filter(Boolean).length;
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
    if (this.bombCarrier === c) this.dropBomb(c, false);
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
      if (!buyError(c.player, item, this.canBuy(c))) applyBuy(c.player, item);
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
    if (h.team === TEAM_T || h.team === TEAM_CT) p.team = h.team;
    else { // auto-balance
      let t = 0, ct = 0;
      for (const o of this.clients) if (o && o !== c && o.joined) o.team === TEAM_CT ? ct++ : t++;
      p.team = ct < t ? TEAM_CT : TEAM_T;
    }
    p.money = this.phase === PHASE_WARMUP ? WARMUP_MONEY : START_MONEY;
    if (this.phase === PHASE_WARMUP || this.phase === PHASE_FREEZE) {
      this.respawn(c, false, this.phase === PHASE_WARMUP);
    } else {
      p.health = 0; // joined mid-round: wait for the next one
      c.life++;
    }
    this.rosterDirty = true;
    console.log(`player ${c.id} "${c.name}" joined (${p.team === TEAM_CT ? 'CT' : 'T'})`);
  }

  // Free spawn point of the player's team: one no other live player stands on (at a
  // round start: no one placed yet this round).
  respawn(c, keepGear = false, withLoadout = false) {
    const list = this.spawns[c.team].length ? this.spawns[c.team] : this.spawns[TEAM_T];
    let pick = list[0] || [0, 0, 0, 0];
    for (const s of list) {
      const taken = this.clients.some((o) =>
        o && o !== c && o.joined && o.alive && (!this.placing || o.placed) &&
        Math.hypot(o.player.ps.f[PS_ORIGIN] - s[0], o.player.ps.f[PS_ORIGIN + 1] - s[1]) < 48
      );
      if (!taken && hullFits(this.world, HULL_STAND, s[0], s[1], s[2])) {
        pick = s;
        break;
      }
    }
    spawnPlayer(c.player, pick[0], pick[1], pick[2], keepGear, withLoadout);
    c.spawnYaw = pick[3];
    c.respawnTick = Infinity;
    c.placed = true;
    c.life++;
  }

  canBuy(c) {
    const ph = this.phase;
    const inTime = ph === PHASE_WARMUP || ph === PHASE_FREEZE || (ph === PHASE_LIVE && this.tick < this.buyEnd);
    const f = c.player.ps.f;
    return inTime && c.alive && this.buyZones.contains(c.team, f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2]);
  }

  // One server tick: run queued commands, the round, lag-compensation history, then
  // snapshot everyone.
  step() {
    this.tick++;
    const ev = this.events;
    ev.shots = 0;
    while (ev.kills && ev.killTick[0] + KILL_REPEAT_TICKS < this.tick) ev.dropOldestKill();

    for (const c of this.clients) {
      if (!c) continue;
      if (this.tick - c.lastHeard > TIMEOUT_TICKS) {
        console.log(`player ${c.id} timed out`);
        c.session.close('timeout');
        this.disconnect(c);
        continue;
      }
      if (!c.joined) continue;
      if (!c.alive && this.tick >= c.respawnTick) this.respawn(c, false, true);
      this.runCommands(c);
    }
    this.updateBomb();
    this.updateRound();
    for (const c of this.clients) if (c && c.joined) c.canBuy = this.canBuy(c);
    this.recordHistory();
    if (this.rosterDirty || this.tick % INFO_INTERVAL === 0) this.sendInfo();
    this.sendSnapshots();
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
    const fell = runCommand(this.world, p, c.buttons, select, c.pitch, c.yaw, t, this.shots, frozen, this.bomb);
    const events = p.ws.f[WS_EVENTS];
    if (events & WEV_DROP) this.dropBomb(c, true);
    if (events & WEV_PLANTED) this.plantBomb(c);
    if (events & WEV_DEFUSED) this.defuseBomb(c);
    if (this.shots.count) {
      this.rewind(c.view);
      resolveShots(this.world, this.breakables, p.ws, this.shots, this.impacts, this.targets, c.id, c.team);
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
      const victim = im.player[i] >= 0 ? this.clients[im.player[i]] : null;
      if (!victim) {
        ev.addShot(shooter.id, SHOT_IMPACT, x, y, z, nx, ny, nz, im.owner[i]);
        continue;
      }
      ev.addShot(shooter.id, SHOT_BLOOD, x, y, z, nx, ny, nz, 0);
      if (!victim.alive) continue; // already killed by an earlier pellet
      applyDamage(victim.player, im.damage[i], w, im.group[i]);
      if (victim.player.health <= 0) this.kill(shooter, victim, weapon, im.group[i] === HITGROUP_HEAD);
    }
  }

  kill(killer, victim, weapon, headshot) {
    const k = killer.player, v = victim.player;
    v.health = 0;
    v.deaths++;
    if (this.bombCarrier === victim) this.dropBomb(victim, false);
    if (killer !== victim) {
      if (killer.team === victim.team) {
        k.kills--;
        k.money = Math.max(0, k.money - TEAMKILL_PENALTY);
      } else {
        k.kills++;
        if (this.phase !== PHASE_WARMUP) k.money = Math.min(MAX_MONEY, k.money + (WEAPONS[weapon]?.killAward || 0));
      }
    }
    if (this.phase === PHASE_WARMUP) victim.respawnTick = this.tick + WARMUP_RESPAWN * TICK_RATE;
    this.events.addKill(this.nextKillId, killer.id, victim.id, weapon, headshot ? KILL_HEADSHOT : 0, this.tick);
    this.nextKillId = (this.nextKillId + 1) & 0xffff || 1;
    this.rosterDirty = true;
  }

  // --- Rounds -----------------------------------------------------------------------

  updateRound() {
    let t = 0, ct = 0, aliveT = 0, aliveCT = 0;
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      if (c.team === TEAM_CT) {
        ct++;
        if (c.alive) aliveCT++;
      } else {
        t++;
        if (c.alive) aliveT++;
      }
    }
    const rs = this.round;
    if (rs.phase === PHASE_WARMUP) {
      if (t && ct && this.rules.rounds) this.startMatch();
    } else if (!t || !ct) { // a team emptied out
      this.setPhase(PHASE_WARMUP, 0);
      this.resetBomb();
      console.log('waiting for players');
    } else if (rs.phase === PHASE_FREEZE && this.tick >= this.phaseEnd) {
      this.setPhase(PHASE_LIVE, this.rules.roundTime);
      this.buyEnd = this.tick + this.rules.buyTime * TICK_RATE;
    } else if (rs.phase === PHASE_LIVE) {
      if (this.bomb.state === BOMB_PLANTED) { // the clock stops; dead Ts no longer lose, the bomb decides
        if (!aliveCT) this.endRound(TEAM_T, END_ELIMINATION);
      } else if (!aliveT || !aliveCT) {
        this.endRound(aliveT ? TEAM_T : aliveCT ? TEAM_CT : 0, aliveT || aliveCT ? END_ELIMINATION : END_DRAW);
      } else if (this.tick >= this.phaseEnd) {
        this.endRound(this.timeWinner, this.timeWinner ? END_TIME : END_DRAW);
      }
    } else if (rs.phase === PHASE_OVER && this.tick >= this.phaseEnd) {
      const half = MAX_ROUNDS / 2;
      if (rs.scoreT > half || rs.scoreCT > half || this.roundsPlayed >= MAX_ROUNDS) this.startMatch();
      else {
        if (this.roundsPlayed === half) this.halftime();
        this.startRound(this.roundsPlayed === half);
      }
    }
    rs.ticksLeft = rs.phase === PHASE_WARMUP ? 0 : this.phaseEnd - this.tick;
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
      c.player.money = START_MONEY;
      c.player.kills = c.player.deaths = 0;
    }
    this.rosterDirty = true;
    console.log('match start');
    this.startRound(true);
  }

  // Everyone to a spawn point; survivors keep their gear unless `fresh`.
  startRound(fresh) {
    this.breakables.reset(this.world);
    this.placing = true;
    for (const c of this.clients) if (c) c.placed = false;
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      this.respawn(c, !fresh && c.alive, false);
    }
    this.placing = false;
    this.resetBomb();
    // One random T carries the bomb.
    const ts = this.clients.filter((c) => c && c.joined && c.alive && c.team === TEAM_T);
    if (this.bombSites.count && ts.length) {
      const c = ts[Math.floor(Math.random() * ts.length)];
      giveWeapon(c.player.ws, WEAPON_ID.c4);
      this.bomb.state = BOMB_CARRIED;
      this.bombCarrier = c;
    }
    this.round.round++;
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
        ? (reason === END_BOMB || reason === END_DEFUSE ? BOMB_WIN_REWARD : WIN_REWARD)
        : lossBonus(Math.max(this.lossStreak[team], 1));
      if (!won && team === TEAM_T && this.planted) reward += PLANT_LOSS_BONUS;
      for (const c of this.clients) {
        if (!c || !c.joined || c.team !== team) continue;
        // Ts still alive when the clock runs out get nothing (CS:GO: no free saving).
        if (!won && team === TEAM_T && reason === END_TIME && c.alive) continue;
        c.player.money = Math.min(MAX_MONEY, c.player.money + reward);
      }
    }
    this.setPhase(PHASE_OVER, this.rules.roundEndDelay);
    const who = winner === TEAM_T ? 'Terrorists' : winner === TEAM_CT ? 'Counter-Terrorists' : 'nobody';
    console.log(`round ${rs.round}: ${who} win (${rs.scoreT}-${rs.scoreCT})`);
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

  // The carrier lets go of the bomb: thrown ahead (G) or where they died.
  dropBomb(c, thrown) {
    if (this.bombCarrier !== c) return;
    c.player.ws.f.fill(0, WS_SLOTS + SLOT_C4 * 3, WS_SLOTS + SLOT_C4 * 3 + 3);
    const f = c.player.ps.f;
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
    const b = this.bomb;
    b.state = BOMB_DROPPED;
    b.x = x;
    b.y = y;
    b.z = this.floorBelow(x, y, z);
    this.bombCarrier = null;
    this.pickupTick = this.tick + (thrown ? PICKUP_DELAY : 0);
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
    p.money = Math.min(MAX_MONEY, p.money + PLANT_REWARD);
    console.log(`bomb planted by player ${c.id}`);
  }

  defuseBomb(c) {
    if (this.bomb.state !== BOMB_PLANTED || this.phase !== PHASE_LIVE || !c.alive) return;
    this.bomb.state = BOMB_DEFUSED;
    c.player.money = Math.min(MAX_MONEY, c.player.money + DEFUSE_REWARD);
    console.log(`bomb defused by player ${c.id}`);
    this.endRound(TEAM_CT, END_DEFUSE);
  }

  // Each tick: Ts walking over a dropped bomb pick it up; a planted one counts down.
  updateBomb() {
    const b = this.bomb;
    if (b.state === BOMB_DROPPED && this.tick >= this.pickupTick) {
      for (const c of this.clients) {
        if (!c || !c.joined || !c.alive || c.team !== TEAM_T) continue;
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
    console.log('bomb exploded');
    if (this.phase === PHASE_LIVE) this.endRound(TEAM_T, END_BOMB);
  }

  // After round 15: teams swap sides, scores follow them, money restarts.
  halftime() {
    const rs = this.round;
    [rs.scoreT, rs.scoreCT] = [rs.scoreCT, rs.scoreT];
    [this.lossStreak[TEAM_T], this.lossStreak[TEAM_CT]] = [0, 0];
    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      c.player.team = c.team === TEAM_CT ? TEAM_T : TEAM_CT;
      c.player.money = START_MONEY;
    }
    this.rosterDirty = true;
    console.log('halftime: teams swap');
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
      if (!c || !c.joined) {
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
    }
    const words = ring.broken;
    words.fill(0, k * 8, k * 8 + 8);
    const b = this.breakables;
    for (let s = 1; s <= b.count; s++) if (b.broken[s]) words[k * 8 + (s >> 5)] |= 1 << (s & 31);

    for (const c of this.clients) {
      if (!c || !c.joined) continue;
      const base = c.ackSeq ? ring.find(c.ackSeq) : -1;
      c.session.send(writeSnapshot(c.writer(), ring, k, base, c.id, c, this.events, this.round, this.bomb));
    }
  }
}
