// Authoritative game state: runs every client's user commands through the shared
// player simulation and sends each client a delta-compressed snapshot every tick.
// Transport-agnostic: sessions only need send(bytes) and close(reason).

import { parseVec3 } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { CollisionWorld, hullFits, HULL_STAND } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { PS_ORIGIN, PS_FLAGS, PS_DUCK_AMOUNT } from '../shared/pmove.js';
import { ShotList, WEAPONS, WS_SLOTS, WS_ACTIVE } from '../shared/weapons.js';
import { Player, spawnPlayer, runCommand, resolveShots, ImpactList, TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, CMD_REDUNDANCY, C2S_HELLO, C2S_CMDS, Writer, Reader, CmdRing, SnapshotRing,
  readHello, writeWelcome, writeReject, readCmds, writeSnapshot, quantizePitch, quantizeYaw, E_ACTIVE, E_X, E_Y,
  E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_FIELDS,
} from '../shared/protocol.js';

const CMD_BANK = 8; // commands a client may run ahead of server time (absorbs jitter, stops speedhacks)
const MAX_CMDS_PER_TICK = 8;
const TIMEOUT_TICKS = 30 * TICK_RATE; // clients in hidden tabs send a 1 Hz keepalive
const SEND_BUFFERS = 8; // rotating send buffers: a datagram may still be queued when the next is written

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
    // Last command run, repeated when one is lost.
    this.buttons = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.out = Array.from({ length: SEND_BUFFERS }, () => new Writer());
    this.outNext = 0;
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
    this.shots = new ShotList();
    this.impacts = new ImpactList();
    this.reader = new Reader();
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
    if (this.clients[c.id] === c) this.clients[c.id] = null;
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
      for (const o of this.clients) if (o && o !== c && o.joined) o.player.team === TEAM_CT ? ct++ : t++;
      p.team = ct < t ? TEAM_CT : TEAM_T;
    }
    this.respawn(c);
    console.log(`player ${c.id} "${c.name}" joined (${p.team === TEAM_CT ? 'CT' : 'T'})`);
  }

  // Free spawn point of the player's team: one no other player stands on.
  respawn(c) {
    const list = this.spawns[c.player.team].length ? this.spawns[c.player.team] : this.spawns[TEAM_T];
    let pick = list[0] || [0, 0, 0, 0];
    for (const s of list) {
      const taken = this.clients.some((o) =>
        o && o !== c && o.joined && Math.hypot(o.player.ps.f[PS_ORIGIN] - s[0], o.player.ps.f[PS_ORIGIN + 1] - s[1]) < 48
      );
      if (!taken && hullFits(this.world, HULL_STAND, s[0], s[1], s[2])) {
        pick = s;
        break;
      }
    }
    spawnPlayer(c.player, pick[0], pick[1], pick[2]);
    c.spawnYaw = pick[3];
  }

  // One server tick: run queued commands, then snapshot everyone.
  step() {
    this.tick++;
    for (const c of this.clients) {
      if (!c) continue;
      if (this.tick - c.lastHeard > TIMEOUT_TICKS) {
        console.log(`player ${c.id} timed out`);
        c.session.close('timeout');
        this.disconnect(c);
        continue;
      }
      if (c.joined) this.runCommands(c);
    }
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
        select = c.inbox.select[k];
      } else if (c.newestCmd < t + CMD_REDUNDANCY) {
        break; // not here yet
      } // else lost beyond redundancy: repeat the previous command
      const p = c.player;
      const died = runCommand(this.world, p, c.buttons, select, c.pitch, c.yaw, t, this.shots);
      resolveShots(this.world, this.breakables, p.ws, this.shots, this.impacts);
      if (died) this.respawn(c);
      c.lastCmd = t;
      c.nextCmd = t + 1;
      c.bank--;
    }
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
      const bytes = writeSnapshot(c.writer(), ring, k, base, c.id, c);
      c.session.send(bytes);
    }
  }
}
