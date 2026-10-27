// Authoritative game state: runs every client's user commands through the shared
// player simulation, resolves shots with lag compensation, and sends each client a
// delta-compressed snapshot (plus the tick's shot and kill events) every tick.
// Transport-agnostic: sessions only need send(bytes) and close(reason).

import { parseVec3 } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { CollisionWorld, hullFits, HULL_STAND } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { PS_ORIGIN, PS_FLAGS, PS_DUCK_AMOUNT } from '../shared/pmove.js';
import { ShotList, WEAPONS, WS_SLOTS, WS_ACTIVE } from '../shared/weapons.js';
import { HitTargets, HITGROUP_HEAD } from '../shared/hitgroups.js';
import { Player, spawnPlayer, runCommand, resolveShots, ImpactList, TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, CMD_REDUNDANCY, C2S_HELLO, C2S_CMDS, C2S_BYE, SHOT_IMPACT, SHOT_BLOOD, KILL_HEADSHOT,
  KILL_REPEAT_TICKS, Writer, Reader, CmdRing, SnapshotRing, EventList, readHello, writeWelcome, writeReject,
  writeInfo, readCmds, writeSnapshot, quantizePitch, quantizeYaw, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS,
  E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_FIELDS,
} from '../shared/protocol.js';

const CMD_BANK = 8; // commands a client may run ahead of server time (absorbs jitter, stops speedhacks)
const MAX_CMDS_PER_TICK = 8;
const TIMEOUT_TICKS = 30 * TICK_RATE; // clients in hidden tabs send a 1 Hz keepalive
const RESPAWN_TICKS = 2 * TICK_RATE;
const INFO_INTERVAL = TICK_RATE; // roster resent every second (datagrams can be lost)
const SEND_BUFFERS = 8; // rotating send buffers: a datagram may still be queued when the next is written

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
    this.respawnTick = 0; // while dead: server tick to respawn at
    this.life = 0; // increments per spawn: history never interpolates across a respawn
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

  writer() {
    const w = this.out[this.outNext];
    this.outNext = (this.outNext + 1) % SEND_BUFFERS;
    return w;
  }
}

export class Game {
  constructor(mapName, bsp) {
    this.mapName = mapName;
    this.world = CollisionWorld.fromBSP(bsp);
    this.breakables = new Breakables(bsp, this.world);
    this.spawns = { [TEAM_T]: [], [TEAM_CT]: [] };
    const o = new Float32Array(3);
    for (const e of bsp.entities) {
      const team = e.classname === 'info_player_deathmatch' ? TEAM_T : e.classname === 'info_player_start' ? TEAM_CT : 0;
      if (!team) continue;
      parseVec3(e.origin, o);
      const yaw = e.angles ? +e.angles.trim().split(/\s+/)[1] || 0 : +(e.angle || 0);
      this.spawns[team].push([o[0], o[1], o[2], yaw]);
    }
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
  }

  get playerCount() {
    return this.clients.filter(Boolean).length;
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
    this.respawn(c);
    this.rosterDirty = true;
    console.log(`player ${c.id} "${c.name}" joined (${p.team === TEAM_CT ? 'CT' : 'T'})`);
  }

  // Free spawn point of the player's team: one no other live player stands on.
  respawn(c) {
    const list = this.spawns[c.team].length ? this.spawns[c.team] : this.spawns[TEAM_T];
    let pick = list[0] || [0, 0, 0, 0];
    for (const s of list) {
      const taken = this.clients.some((o) =>
        o && o !== c && o.joined && o.alive &&
        Math.hypot(o.player.ps.f[PS_ORIGIN] - s[0], o.player.ps.f[PS_ORIGIN + 1] - s[1]) < 48
      );
      if (!taken && hullFits(this.world, HULL_STAND, s[0], s[1], s[2])) {
        pick = s;
        break;
      }
    }
    spawnPlayer(c.player, pick[0], pick[1], pick[2]);
    c.spawnYaw = pick[3];
    c.life++;
  }

  // One server tick: run queued commands, record lag-compensation history, then
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
      if (!c.alive && this.tick >= c.respawnTick) this.respawn(c);
      this.runCommands(c);
    }
    this.recordHistory();
    if (this.rosterDirty || this.tick % INFO_INTERVAL === 0) this.sendInfo();
    this.sendSnapshots();
  }

  runCommands(c) {
    c.bank = Math.min(c.bank + 1, CMD_BANK);
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
      if (c.alive) this.runCommand(c, t, select); // the dead only use up their commands
      c.lastCmd = t;
      c.nextCmd = t + 1;
      c.bank--;
    }
  }

  runCommand(c, t, select) {
    const p = c.player;
    const fell = runCommand(this.world, p, c.buttons, select, c.pitch, c.yaw, t, this.shots);
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
      victim.player.health -= Math.floor(im.damage[i]); // CS:GO truncates damage
      if (victim.player.health <= 0) this.kill(shooter, victim, weapon, im.group[i] === HITGROUP_HEAD);
    }
  }

  kill(killer, victim, weapon, headshot) {
    victim.player.health = 0;
    victim.respawnTick = this.tick + RESPAWN_TICKS;
    this.events.addKill(this.nextKillId, killer.id, victim.id, weapon, headshot ? KILL_HEADSHOT : 0, this.tick);
    this.nextKillId = (this.nextKillId + 1) & 0xffff || 1;
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
      c.session.send(writeSnapshot(c.writer(), ring, k, base, c.id, c, this.events));
    }
  }
}
