// Binary wire protocol (WebTransport datagrams, little-endian). Every message fits one
// datagram of at most MAX_DATAGRAM bytes; readers and writers reuse preallocated
// buffers.
//
// Client -> server
//   HELLO    u8 type, u16 version, u8 team, u8 primary, u8 secondary, str name
//   BYE      u8 type (leaving: free my player now; sent best-effort on page hide)
//   BUY      u8 type, u16 buyId, u8 item (sent 3 times; the server acts once per buyId)
//   COMMAND  u8 type, u16 cmdId, lstr text (a console command for the server: name, jointeam,
//            kill, rcon ...; sent 3 times, run once per cmdId)
//   CMDS     u8 type, u32 ackSeq, u8 n,
//            n x { u32 tick, u32 buttons, f32 pitch, f32 yaw, i8 select, u32 viewTick * 256 }
//            (oldest first; the newest command plus the previous CMD_REDUNDANCY - 1, so a
//            lost datagram loses no input. viewTick: the server tick the player was seeing
//            other players at, for lag compensation)
// Server -> client
//   WELCOME  u8 type, u16 version, u8 playerId, u32 serverTick, u8 tickRate, str map
//   REJECT   u8 type, str reason
//   PRINT    u8 type, lstr text (console output: rcon replies, server messages)
//   CHANGELEVEL u8 type, str map (the server is switching maps: reconnect)
//   INFO     u8 type, u8 n, n x { u8 id, u8 team, u16 kills, u16 deaths, u16 score, str name }
//            (every player, resent periodically and on changes)
//   SNAPSHOT u8 type, u32 seq, u32 baseSeq (0 = full), u32 lastCmd, u8 flags,
//            [u32 x 8 broken-breakable mask if flags & SNAP_BROKEN],
//            round: u8 phase, u32 ticksLeft, u8 scoreT, u8 scoreCT, u8 roundInfo, u8 round, u8 mode,
//            bomb: u8 state, [f32 x, y, z, u16 ticksLeft if state >= BOMB_DROPPED],
//            movers (shared/doors.js) not closed at rest: u8 n, n x { u8 mover, u8 bits
//                        (dir + 1 | sign < 0 << 2), f32 from, u32 t0 },
//            own player: u8 health, u8 armor (bit 7: helmet), u8 spawnCount, u8 team, f32 spawnYaw,
//                        u16 money, u8 ownFlags (OWN_CAN_BUY, OWN_DEFUSER, OWN_CARRYING, OWN_IMMUNE),
//                        u8 flash left, u8 flash length (1/32 s: flashbang blindness),
//                        u8 use progress (0..255: picking up a hostage),
//                        PlayerState bytes, WeaponState (full every time, for prediction:
//                        a bitmask of the fields that are not +0, then those f64 values),
//            u8 n, n x { u8 id, u8 fieldMask, changed fields } (other players, delta vs base),
//            events of this tick (not delta-compressed, lost with their datagram):
//            u8 n, n x { u8 shooter, u8 kind, f32 x, y, z, i8 nx, ny, nz, u8 breakable }
//            u8 n, n x { u16 killId, u8 killer, u8 victim, u8 weapon, u8 flags } (kills of the
//            last KILL_REPEAT_TICKS, repeated every snapshot so one loss loses nothing)
//   GRENADES u8 type, u32 tick, u8 n, n x { u16 id, u8 weapon, f32 x, y, z } (in flight),
//            u8 n, n x { u16 id, u8 kind, u8 weapon, f32 x, y, z, u16 age ticks } (effects:
//            blasts, smokes, fires, decoys); every tick, nothing delta-compressed
//   HOSTAGES u8 type, u8 n, n x { u8 state, i8 carrier, u8 health, f32 x, y, z, u8 yaw }
//            (on changes and every second)

import { PS_SIZE } from './pmove.js';
import { WS_SIZE } from './weapons.js';
import { BombState, BOMB_DROPPED } from './bomb.js';
import { MAX_MOVERS } from './doors.js';

export const PROTOCOL_VERSION = 11;
export const MAX_PLAYERS = 20;
export const MAX_DATAGRAM = 1024; // Chrome's WebTransport maxDatagramSize
export const CMD_REDUNDANCY = 4;
export const SNAPSHOT_HISTORY = 32; // power of two

export const C2S_HELLO = 1;
export const C2S_CMDS = 2;
export const C2S_BYE = 3;
export const C2S_BUY = 4;
export const C2S_COMMAND = 5;
export const S2C_WELCOME = 10;
export const S2C_SNAPSHOT = 11;
export const S2C_REJECT = 12;
export const S2C_INFO = 13;
export const S2C_PRINT = 14;
export const S2C_CHANGELEVEL = 15;
export const S2C_ITEMS = 16; // weapons on the ground
export const S2C_GRENADES = 17;
export const S2C_HOSTAGES = 18;
export const MAX_TEXT = 900; // bytes of console text per datagram

export const SHOT_IMPACT = 0; // bullet hit the world
export const SHOT_BLOOD = 1; // bullet hit a player
export const KILL_HEADSHOT = 1;
export const KILL_REPEAT_TICKS = 32;
const CMD_BYTES = 21;

export const SNAP_BROKEN = 1;
export const OWN_CAN_BUY = 1;
export const OWN_DEFUSER = 2;
export const OWN_CARRYING = 4; // carrying a hostage (slower: the client predicts it)
export const OWN_IMMUNE = 8; // our spawn protection is on (deathmatch)
const BROKEN_WORDS = 8; // 256-bit mask, one bit per breakable slot

// --- Byte buffers ------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export class Writer {
  constructor(size = MAX_DATAGRAM) {
    this.u8 = new Uint8Array(size);
    this.dv = new DataView(this.u8.buffer);
    this.pos = 0;
  }

  reset() {
    this.pos = 0;
    return this;
  }

  u8v(v) { this.dv.setUint8(this.pos, v); this.pos += 1; }
  i8v(v) { this.dv.setInt8(this.pos, v); this.pos += 1; }
  u16v(v) { this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32v(v) { this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  f32v(v) { this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  f64v(v) { this.dv.setFloat64(this.pos, v, true); this.pos += 8; }

  bytes(src) {
    this.u8.set(src, this.pos);
    this.pos += src.length;
  }

  str(s) { // short UTF-8 string, at most 63 bytes
    const n = utf8Encoder.encodeInto(s, this.u8.subarray(this.pos + 1, this.pos + 64)).written;
    this.u8[this.pos] = n;
    this.pos += 1 + n;
  }

  lstr(s) { // long UTF-8 string (console text), at most MAX_TEXT bytes
    const n = utf8Encoder.encodeInto(s, this.u8.subarray(this.pos + 2, this.pos + 2 + MAX_TEXT)).written;
    this.dv.setUint16(this.pos, n, true);
    this.pos += 2 + n;
  }

  // The written bytes (a view; copy it if it must outlive the next reset).
  view() {
    return this.u8.subarray(0, this.pos);
  }
}

export class Reader {
  constructor() {
    this.u8 = new Uint8Array(0);
    this.dv = new DataView(this.u8.buffer);
    this.pos = 0;
  }

  set(bytes) {
    this.u8 = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    return this;
  }

  get remaining() {
    return this.u8.length - this.pos;
  }

  u8v() { const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  i8v() { const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
  u16v() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32v() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32v() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64v() { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }

  bytesInto(dst) {
    const src = this.u8, p = this.pos; // (a subarray would allocate a view per snapshot)
    for (let i = 0; i < dst.length; i++) dst[i] = src[p + i];
    this.pos += dst.length;
  }

  lstr() {
    const n = Math.min(this.u16v(), this.remaining);
    const s = utf8Decoder.decode(this.u8.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  str() {
    const n = this.u8v();
    const s = utf8Decoder.decode(this.u8.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

// --- Handshake ---------------------------------------------------------------

export function writeHello(w, team, primary, secondary, name) {
  w.reset();
  w.u8v(C2S_HELLO);
  w.u16v(PROTOCOL_VERSION);
  w.u8v(team);
  w.u8v(primary);
  w.u8v(secondary);
  w.str(name);
  return w.view();
}

export function readHello(r) { // after the type byte
  return { version: r.u16v(), team: r.u8v(), primary: r.u8v(), secondary: r.u8v(), name: r.str() };
}

export function writeWelcome(w, playerId, serverTick, tickRate, map) {
  w.reset();
  w.u8v(S2C_WELCOME);
  w.u16v(PROTOCOL_VERSION);
  w.u8v(playerId);
  w.u32v(serverTick);
  w.u8v(tickRate);
  w.str(map);
  return w.view();
}

export function readWelcome(r) {
  return { version: r.u16v(), playerId: r.u8v(), serverTick: r.u32v(), tickRate: r.u8v(), map: r.str() };
}

export function writeReject(w, reason) {
  w.reset();
  w.u8v(S2C_REJECT);
  w.str(reason);
  return w.view();
}

// players: array indexed by id of { team, name, kills, deaths, score } or null.
export function writeInfo(w, players) {
  w.reset();
  w.u8v(S2C_INFO);
  const countAt = w.pos;
  w.u8v(0);
  let n = 0;
  for (let id = 0; id < players.length; id++) {
    const p = players[id];
    if (!p) continue;
    w.u8v(id);
    w.u8v(p.team);
    w.u16v(p.kills);
    w.u16v(p.deaths);
    w.u16v(Math.min(Math.max(p.score, 0), 65535));
    w.str(p.name);
    n++;
  }
  w.u8[countAt] = n;
  return w.view();
}

// Fills names / teams / kills / deaths / scores indexed by id (others cleared).
export function readInfo(r, names, teams, kills, deaths, scores) {
  names.fill('');
  teams.fill(0);
  kills.fill(0);
  deaths.fill(0);
  scores.fill(0);
  const n = r.u8v();
  for (let i = 0; i < n; i++) {
    const id = r.u8v(), team = r.u8v(), k = r.u16v(), d = r.u16v(), score = r.u16v(), name = r.str();
    if (id < names.length) {
      names[id] = name;
      teams[id] = team;
      kills[id] = k;
      deaths[id] = d;
      scores[id] = score;
    }
  }
}

// Weapons on the ground (shared/items.js): count, then per item id, weapon, position
// and yaw (16 bytes each; MAX_ITEMS fits a datagram).
export function writeItems(w, items) {
  w.reset();
  w.u8v(S2C_ITEMS);
  w.u8v(items.count);
  for (let i = 0; i < items.count; i++) {
    w.u16v(items.id[i]);
    w.u8v(items.weapon[i]);
    w.f32v(items.x[i]);
    w.f32v(items.y[i]);
    w.f32v(items.z[i]);
    w.u8v(Math.round(items.yaw[i] / 360 * 256) & 255);
  }
  return w.view();
}

// Replaces `items` with the list (ammo and pickup times are the server's business).
export function readItems(r, items) {
  const n = Math.min(r.u8v(), items.id.length);
  items.count = 0;
  for (let i = 0; i < n; i++) {
    const id = r.u16v(), weapon = r.u8v(), x = r.f32v(), y = r.f32v(), z = r.f32v(), yaw = r.u8v() / 256 * 360;
    const k = items.add(weapon, 0, 0, x, y, z, yaw);
    items.id[k] = id;
  }
}

// Hostages (shared/hostages.js).
export function writeHostages(w, h) {
  w.reset();
  w.u8v(S2C_HOSTAGES);
  w.u8v(h.count);
  for (let k = 0; k < h.count; k++) {
    w.u8v(h.state[k]);
    w.i8v(h.carrier[k]);
    w.u8v(Math.min(Math.max(Math.ceil(h.health[k]), 0), 255));
    w.f32v(h.x[k]);
    w.f32v(h.y[k]);
    w.f32v(h.z[k]);
    w.u8v(Math.round(h.yaw[k] / 360 * 256) & 255);
  }
  return w.view();
}

export function readHostages(r, h) {
  h.count = Math.min(r.u8v(), h.state.length);
  for (let k = 0; k < h.count; k++) {
    h.state[k] = r.u8v();
    h.carrier[k] = r.i8v();
    h.health[k] = r.u8v();
    h.x[k] = r.f32v();
    h.y[k] = r.f32v();
    h.z[k] = r.f32v();
    h.yaw[k] = r.u8v() / 256 * 360;
  }
}

// Grenades in flight and their effects (shared/grenades.js) at server tick `tick`.
export function writeGrenades(w, tick, g) {
  w.reset();
  w.u8v(S2C_GRENADES);
  w.u32v(tick);
  w.u8v(g.count);
  for (let k = 0; k < g.count; k++) {
    w.u16v(g.id[k]);
    w.u8v(g.weapon[k]);
    w.f32v(g.pos[k * 3]);
    w.f32v(g.pos[k * 3 + 1]);
    w.f32v(g.pos[k * 3 + 2]);
  }
  w.u8v(g.fxCount);
  for (let k = 0; k < g.fxCount; k++) {
    w.u16v(g.fxId[k]);
    w.u8v(g.fxKind[k]);
    w.u8v(g.fxWeapon[k]);
    w.f32v(g.fxPos[k * 3]);
    w.f32v(g.fxPos[k * 3 + 1]);
    w.f32v(g.fxPos[k * 3 + 2]);
    w.u16v(Math.min(Math.round(g.fxAge[k] * 64), 65535));
  }
  return w.view();
}

// Decodes into a Grenades (lists replaced; ages in seconds at `tick`). Returns the tick.
export function readGrenades(r, g) {
  const tick = r.u32v();
  g.count = Math.min(r.u8v(), g.id.length);
  for (let k = 0; k < g.count; k++) {
    g.id[k] = r.u16v();
    g.weapon[k] = r.u8v();
    g.pos[k * 3] = r.f32v();
    g.pos[k * 3 + 1] = r.f32v();
    g.pos[k * 3 + 2] = r.f32v();
  }
  g.fxCount = Math.min(r.u8v(), g.fxId.length);
  for (let k = 0; k < g.fxCount; k++) {
    g.fxId[k] = r.u16v();
    g.fxKind[k] = r.u8v();
    g.fxWeapon[k] = r.u8v();
    g.fxPos[k * 3] = r.f32v();
    g.fxPos[k * 3 + 1] = r.f32v();
    g.fxPos[k * 3 + 2] = r.f32v();
    g.fxAge[k] = r.u16v() / 64;
  }
  return tick;
}

export function writeBuy(w, buyId, item) {
  w.reset();
  w.u8v(C2S_BUY);
  w.u16v(buyId);
  w.u8v(item);
  return w.view();
}

export function writeCommand(w, cmdId, text) {
  w.reset();
  w.u8v(C2S_COMMAND);
  w.u16v(cmdId);
  w.lstr(text);
  return w.view();
}

export function writePrint(w, text) {
  w.reset();
  w.u8v(S2C_PRINT);
  w.lstr(text);
  return w.view();
}

// Console output split into datagram-sized PRINT messages (at line breaks when it can).
export function printChunks(text) {
  const chunks = [];
  const enc = new TextEncoder();
  let rest = text;
  while (rest.length) {
    let n = rest.length;
    while (enc.encode(rest.slice(0, n)).length > MAX_TEXT) {
      const nl = rest.lastIndexOf('\n', Math.floor(n * 0.9));
      n = nl > 0 ? nl + 1 : Math.floor(n * 0.9);
    }
    chunks.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return chunks;
}

export function writeChangelevel(w, map) {
  w.reset();
  w.u8v(S2C_CHANGELEVEL);
  w.str(map);
  return w.view();
}

// --- User commands -------------------------------------------------------------

// Ring of user commands indexed by command tick (client history / server inbox).
export class CmdRing {
  constructor(size = 64) { // power of two
    this.mask = size - 1;
    this.tick = new Int32Array(size).fill(-1);
    this.buttons = new Int32Array(size);
    this.select = new Int8Array(size);
    this.pitch = new Float32Array(size);
    this.yaw = new Float32Array(size);
    this.view = new Float64Array(size); // server tick the player was seeing (lag compensation)
    this.newest = -1; // newest tick ever stored
  }

  put(tick, buttons, select, pitch, yaw, view = 0) {
    const k = tick & this.mask;
    if (tick > this.newest) this.newest = tick;
    this.tick[k] = tick;
    this.buttons[k] = buttons;
    this.select[k] = select;
    this.pitch[k] = pitch;
    this.yaw[k] = yaw;
    this.view[k] = Math.round(view * 256) / 256; // as sent
  }

  has(tick) {
    return this.tick[tick & this.mask] === tick;
  }
}

// Commands `newest - n + 1 .. newest` (those present in the ring), plus the snapshot ack.
export function writeCmds(w, ackSeq, ring, newest, n = CMD_REDUNDANCY) {
  w.reset();
  w.u8v(C2S_CMDS);
  w.u32v(ackSeq);
  const countAt = w.pos;
  w.u8v(0);
  let count = 0;
  for (let t = newest - n + 1; t <= newest; t++) {
    if (t < 0 || !ring.has(t)) continue;
    const k = t & ring.mask;
    w.u32v(t);
    w.u32v(ring.buttons[k]);
    w.f32v(ring.pitch[k]);
    w.f32v(ring.yaw[k]);
    w.i8v(ring.select[k]);
    w.u32v(Math.round(ring.view[k] * 256));
    count++;
  }
  w.u8[countAt] = count;
  return w.view();
}

// Stores the packet's commands into `ring`, skipping ticks below `minTick`
// (already run). Returns the snapshot ack.
export function readCmds(r, ring, minTick) {
  const ack = r.u32v();
  const n = r.u8v();
  for (let i = 0; i < n && r.remaining >= CMD_BYTES; i++) {
    const t = r.u32v(), buttons = r.u32v(), pitch = r.f32v(), yaw = r.f32v(), select = r.i8v();
    const view = r.u32v() / 256;
    if (t >= minTick && Number.isFinite(pitch) && Number.isFinite(yaw)) ring.put(t, buttons, select, pitch, yaw, view);
  }
  return ack;
}

// --- Events ----------------------------------------------------------------------

// Shot impacts and kills of a tick (server: gathered while simulating; client: decoded).
export class EventList {
  constructor(shotCapacity = 64, killCapacity = 16) {
    this.shots = 0;
    this.shooter = new Uint8Array(shotCapacity);
    this.kind = new Uint8Array(shotCapacity);
    this.pos = new Float32Array(shotCapacity * 3);
    this.normal = new Float32Array(shotCapacity * 3);
    this.breakable = new Uint8Array(shotCapacity);
    this.kills = 0;
    this.killId = new Uint16Array(killCapacity);
    this.killer = new Uint8Array(killCapacity);
    this.victim = new Uint8Array(killCapacity);
    this.weapon = new Uint8Array(killCapacity);
    this.killFlags = new Uint8Array(killCapacity);
    this.killTick = new Uint32Array(killCapacity); // server only
  }

  addShot(shooter, kind, x, y, z, nx, ny, nz, breakable) {
    if (this.shots === this.shooter.length) return;
    const k = this.shots++;
    this.shooter[k] = shooter;
    this.kind[k] = kind;
    this.pos[k * 3] = x;
    this.pos[k * 3 + 1] = y;
    this.pos[k * 3 + 2] = z;
    this.normal[k * 3] = nx;
    this.normal[k * 3 + 1] = ny;
    this.normal[k * 3 + 2] = nz;
    this.breakable[k] = breakable;
  }

  addKill(id, killer, victim, weapon, flags, tick) {
    if (this.kills === this.killId.length) this.dropOldestKill();
    const k = this.kills++;
    this.killId[k] = id;
    this.killer[k] = killer;
    this.victim[k] = victim;
    this.weapon[k] = weapon;
    this.killFlags[k] = flags;
    this.killTick[k] = tick;
  }

  dropOldestKill() {
    this.killId.copyWithin(0, 1, this.kills);
    this.killer.copyWithin(0, 1, this.kills);
    this.victim.copyWithin(0, 1, this.kills);
    this.weapon.copyWithin(0, 1, this.kills);
    this.killFlags.copyWithin(0, 1, this.kills);
    this.killTick.copyWithin(0, 1, this.kills);
    this.kills--;
  }
}

const SHOT_BYTES = 18;
const KILL_BYTES = 6;
const quantizeNormal = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));

// Appends a tick's events for player `self`, as many shots as the datagram has room
// for. The shooter's own world impacts are left out: it predicted and drew them.
function writeEvents(w, ev, self) {
  const killBytes = 1 + ev.kills * KILL_BYTES;
  const room = Math.floor((MAX_DATAGRAM - w.pos - 1 - killBytes) / SHOT_BYTES);
  const countAt = w.pos;
  w.u8v(0);
  let n = 0;
  for (let k = 0; k < ev.shots && n < room; k++) {
    if (ev.shooter[k] === self && ev.kind[k] === SHOT_IMPACT) continue;
    w.u8v(ev.shooter[k]);
    w.u8v(ev.kind[k]);
    w.f32v(ev.pos[k * 3]);
    w.f32v(ev.pos[k * 3 + 1]);
    w.f32v(ev.pos[k * 3 + 2]);
    w.i8v(quantizeNormal(ev.normal[k * 3]));
    w.i8v(quantizeNormal(ev.normal[k * 3 + 1]));
    w.i8v(quantizeNormal(ev.normal[k * 3 + 2]));
    w.u8v(ev.breakable[k]);
    n++;
  }
  w.u8[countAt] = n;
  w.u8v(ev.kills);
  for (let k = 0; k < ev.kills; k++) {
    w.u16v(ev.killId[k]);
    w.u8v(ev.killer[k]);
    w.u8v(ev.victim[k]);
    w.u8v(ev.weapon[k]);
    w.u8v(ev.killFlags[k]);
  }
}

// Appends decoded events to `ev` (which the caller empties).
function readEvents(r, ev) {
  const n = r.u8v();
  for (let i = 0; i < n; i++) {
    const shooter = r.u8v(), kind = r.u8v(), x = r.f32v(), y = r.f32v(), z = r.f32v();
    const nx = r.i8v() / 127, ny = r.i8v() / 127, nz = r.i8v() / 127;
    ev.addShot(shooter, kind, x, y, z, nx, ny, nz, r.u8v());
  }
  const kills = r.u8v();
  for (let i = 0; i < kills; i++) {
    const id = r.u16v(), killer = r.u8v(), victim = r.u8v(), weapon = r.u8v(), flags = r.u8v();
    ev.addKill(id, killer, victim, weapon, flags, 0);
  }
}

// --- Snapshots -------------------------------------------------------------------

// Per-player row in a snapshot, already quantized as sent so that the sender's and
// receiver's copies compare equal.
export const E_ACTIVE = 0;
export const E_X = 1; // hull center
export const E_Y = 2;
export const E_Z = 3;
export const E_PITCH = 4; // u16 units
export const E_YAW = 5; // u16 units
export const E_FLAGS = 6; // FL_* bits
export const E_DUCK = 7; // duck amount, 0..255
export const E_WEAPON = 8;
export const E_HEALTH = 9;
export const E_TEAM = 10;
export const E_ANIM = 11; // ANIM_* bits: what the body is doing (third-person animation)
export const E_SHOTS = 12; // shots fired, counting up mod 256 (each step: a fire kick)
export const E_FIELDS = 13;

export const ANIM_RELOAD = 1;
export const ANIM_PLANT = 2;
export const ANIM_DEFUSE = 4;
export const ANIM_HELMET = 8;
export const ANIM_SILENCED = 16; // the gun in hand wears its silencer (M4A1-S, USP-S)
export const ANIM_SPOTTED_T = 32; // on the Terrorists' radar (seen by one of them, or firing)
export const ANIM_SPOTTED_CT = 64; // on the Counter-Terrorists' radar
export const ANIM_IMMUNE = 128; // spawn protection (deathmatch): bullets do nothing

const F_ORIGIN = 1;
const F_ANGLES = 2;
const F_STANCE = 4; // flags + duck amount
const F_WEAPON = 8;
const F_HEALTH = 16;
const F_TEAM = 32;
const F_ANIM = 64; // anim bits + shot counter
const F_REMOVE = 128;

export const quantizePitch = (deg) => Math.round((Math.min(Math.max(deg, -90), 90) + 90) / 180 * 65535);
export const dequantizePitch = (q) => q / 65535 * 180 - 90;
export const quantizeYaw = (deg) => Math.round((deg - Math.floor(deg / 360) * 360) / 360 * 65536) & 0xffff;
export const dequantizeYaw = (q) => q / 65536 * 360;

// Recent snapshots (player rows + breakable mask) keyed by sequence number.
export class SnapshotRing {
  constructor() {
    this.seq = new Int32Array(SNAPSHOT_HISTORY).fill(-1);
    this.ents = new Float32Array(SNAPSHOT_HISTORY * MAX_PLAYERS * E_FIELDS);
    this.broken = new Uint32Array(SNAPSHOT_HISTORY * BROKEN_WORDS);
  }

  // Slot index for `seq` if it is still held, else -1.
  find(seq) {
    const k = seq & (SNAPSHOT_HISTORY - 1);
    return seq > 0 && this.seq[k] === seq ? k : -1;
  }

  // Claims the slot for `seq` (overwriting the oldest) and returns its index.
  claim(seq) {
    const k = seq & (SNAPSHOT_HISTORY - 1);
    this.seq[k] = seq;
    return k;
  }

  row(k, id) {
    return (k * MAX_PLAYERS + id) * E_FIELDS;
  }
}

function sameBroken(a, ak, b, bk) {
  for (let i = 0; i < BROKEN_WORDS; i++) if (a[ak * BROKEN_WORDS + i] !== b[bk * BROKEN_WORDS + i]) return false;
  return true;
}

// Round state shared by every snapshot of a tick.
export class RoundState {
  constructor() {
    this.phase = 0;
    this.ticksLeft = 0;
    this.scoreT = 0;
    this.scoreCT = 0;
    this.info = 0; // last round: winner team | reason << 2
    this.round = 0;
    this.mode = 0; // GAME_FFA | GAME_DM (shared/economy.js)
  }
}
const NO_ROUND = new RoundState();
const NO_BOMB = new BombState();

// Movers' replicated states as last received (only those away from rest).
export class MoverStates {
  constructor() {
    this.count = 0;
    this.mover = new Uint8Array(MAX_MOVERS);
    this.dir = new Int8Array(MAX_MOVERS);
    this.sign = new Int8Array(MAX_MOVERS);
    this.from = new Float32Array(MAX_MOVERS);
    this.t0 = new Int32Array(MAX_MOVERS);
  }
}

// Encodes snapshot `k` of `ring` for player `self`, as a delta against slot `base`
// (-1 = full), followed by the tick's events `ev` (optional).
// `own` = { lastCmd, spawnYaw, canBuy, player }.
export function writeSnapshot(w, ring, k, base, self, own, ev = null, rs = NO_ROUND, bomb = NO_BOMB, doors = null) {
  const E = ring.ents;
  w.reset();
  w.u8v(S2C_SNAPSHOT);
  w.u32v(ring.seq[k]);
  w.u32v(base >= 0 ? ring.seq[base] : 0);
  w.u32v(own.lastCmd);
  const sendBroken = base < 0 || !sameBroken(ring.broken, k, ring.broken, base);
  w.u8v(sendBroken ? SNAP_BROKEN : 0);
  if (sendBroken) for (let i = 0; i < BROKEN_WORDS; i++) w.u32v(ring.broken[k * BROKEN_WORDS + i]);
  w.u8v(rs.phase);
  w.u32v(Math.max(rs.ticksLeft, 0));
  w.u8v(rs.scoreT);
  w.u8v(rs.scoreCT);
  w.u8v(rs.info);
  w.u8v(rs.round);
  w.u8v(rs.mode);
  w.u8v(bomb.state);
  if (bomb.state >= BOMB_DROPPED) {
    w.f32v(bomb.x);
    w.f32v(bomb.y);
    w.f32v(bomb.z);
    w.u16v(Math.min(Math.max(bomb.ticksLeft, 0), 65535));
  }
  const moversAt = w.pos;
  w.u8v(0);
  if (doors) {
    let n = 0;
    for (let m = 0; m < doors.count; m++) {
      if (doors.atBottom(m)) continue;
      w.u8v(m);
      w.u8v((doors.dir[m] + 1) | (doors.sign[m] < 0 ? 4 : 0));
      w.f32v(doors.from[m]);
      w.u32v(doors.t0[m]);
      n++;
    }
    w.u8[moversAt] = n;
  }

  const p = own.player;
  w.u8v(Math.min(Math.max(Math.ceil(p.health), 0), 255));
  w.u8v(Math.min(p.armor, 127) | (p.helmet ? 128 : 0));
  w.u8v(p.spawnCount);
  w.u8v(p.team);
  w.f32v(own.spawnYaw);
  w.u16v(Math.min(Math.max(p.money, 0), 65535));
  w.u8v((own.canBuy ? OWN_CAN_BUY : 0) | (p.defuser ? OWN_DEFUSER : 0) | (p.carrying ? OWN_CARRYING : 0) |
    (own.immune ? OWN_IMMUNE : 0));
  w.u8v(Math.min(Math.max(Math.round((own.flashLeft || 0) * 32), 0), 255));
  w.u8v(Math.min(Math.max(Math.round((own.flashTotal || 0) * 32), 0), 255));
  w.u8v(Math.min(Math.max(Math.round((own.useProgress || 0) * 255), 0), 255));
  w.bytes(p.psBytes);
  writeWeaponState(w, p.ws.f);

  const countAt = w.pos;
  w.u8v(0);
  let count = 0;
  for (let id = 0; id < MAX_PLAYERS; id++) {
    if (id === self) continue;
    const c = ring.row(k, id);
    const b = base >= 0 ? ring.row(base, id) : -1;
    const inBase = b >= 0 && E[b + E_ACTIVE] !== 0;
    if (!E[c + E_ACTIVE]) {
      if (inBase) {
        w.u8v(id);
        w.u8v(F_REMOVE);
        count++;
      }
      continue;
    }
    let mask = 0;
    if (!inBase || E[c + E_X] !== E[b + E_X] || E[c + E_Y] !== E[b + E_Y] || E[c + E_Z] !== E[b + E_Z]) mask |= F_ORIGIN;
    if (!inBase || E[c + E_PITCH] !== E[b + E_PITCH] || E[c + E_YAW] !== E[b + E_YAW]) mask |= F_ANGLES;
    if (!inBase || E[c + E_FLAGS] !== E[b + E_FLAGS] || E[c + E_DUCK] !== E[b + E_DUCK]) mask |= F_STANCE;
    if (!inBase || E[c + E_WEAPON] !== E[b + E_WEAPON]) mask |= F_WEAPON;
    if (!inBase || E[c + E_HEALTH] !== E[b + E_HEALTH]) mask |= F_HEALTH;
    if (!inBase || E[c + E_TEAM] !== E[b + E_TEAM]) mask |= F_TEAM;
    if (!inBase || E[c + E_ANIM] !== E[b + E_ANIM] || E[c + E_SHOTS] !== E[b + E_SHOTS]) mask |= F_ANIM;
    if (!mask) continue;
    w.u8v(id);
    w.u8v(mask);
    if (mask & F_ORIGIN) {
      w.f32v(E[c + E_X]);
      w.f32v(E[c + E_Y]);
      w.f32v(E[c + E_Z]);
    }
    if (mask & F_ANGLES) {
      w.u16v(E[c + E_PITCH]);
      w.u16v(E[c + E_YAW]);
    }
    if (mask & F_STANCE) {
      w.u8v(E[c + E_FLAGS]);
      w.u8v(E[c + E_DUCK]);
    }
    if (mask & F_WEAPON) w.u8v(E[c + E_WEAPON]);
    if (mask & F_HEALTH) w.u8v(E[c + E_HEALTH]);
    if (mask & F_TEAM) w.u8v(E[c + E_TEAM]);
    if (mask & F_ANIM) {
      w.u8v(E[c + E_ANIM]);
      w.u8v(E[c + E_SHOTS]);
    }
    count++;
  }
  w.u8[countAt] = count;
  if (ev) {
    writeEvents(w, ev, self);
  } else {
    w.u8v(0);
    w.u8v(0);
  }
  return w.view();
}

// The weapon state is mostly zeros (timers, modes, grenades, empty slots): only the
// fields that are not +0 go out, after a bitmask. Bit-exact both ways.
const WS_MASK_BYTES = Math.ceil(WS_SIZE / 8);

function writeWeaponState(w, f) {
  const at = w.pos;
  w.u8.fill(0, at, at + WS_MASK_BYTES);
  w.pos += WS_MASK_BYTES;
  for (let i = 0; i < WS_SIZE; i++) {
    if (Object.is(f[i], 0)) continue;
    w.u8[at + (i >> 3)] |= 1 << (i & 7);
    w.f64v(f[i]);
  }
}

function readWeaponState(r, f) {
  const at = r.pos;
  r.pos += WS_MASK_BYTES;
  for (let i = 0; i < WS_SIZE; i++) f[i] = r.u8[at + (i >> 3)] & (1 << (i & 7)) ? r.f64v() : 0;
}

// Own-player block of a decoded snapshot (filled in place).
export class OwnState {
  constructor() {
    this.lastCmd = 0;
    this.health = 0;
    this.armor = 0;
    this.helmet = false;
    this.spawnCount = 0;
    this.team = 0;
    this.spawnYaw = 0;
    this.money = 0;
    this.flags = 0; // OWN_*
    this.flashLeft = 0; // seconds of flashbang blindness left
    this.flashTotal = 0; // and how long it lasts in all
    this.useProgress = 0; // 0..1: picking up a hostage
    this.round = new RoundState();
    this.bomb = new BombState();
    this.movers = new MoverStates();
    this.ps = new Uint8Array(PS_SIZE * 4); // raw PlayerState bytes
    this.psF = new Float32Array(this.ps.buffer); // the same bytes as floats
    this.ws = new Uint8Array(WS_SIZE * 8); // raw WeaponState bytes
    this.wsF = new Float64Array(this.ws.buffer); // the same bytes as numbers
  }
}

// Decodes a snapshot (after the type byte) into `ring`, appending its events to `ev`
// (optional). Returns its slot index, or -1 if its delta base is no longer held (the
// snapshot is then dropped).
export function readSnapshot(r, ring, own, ev = null) {
  const seq = r.u32v();
  const baseSeq = r.u32v();
  const base = baseSeq ? ring.find(baseSeq) : -1;
  if (baseSeq && base < 0) return -1;
  const slot = seq & (SNAPSHOT_HISTORY - 1);
  // Duplicate, stale (its slot already holds something newer), or base would be overwritten.
  if (ring.seq[slot] >= seq || base === slot) return -1;
  const lastCmd = r.u32v();
  const flags = r.u8v();
  const k = ring.claim(seq);
  const E = ring.ents;
  const B = ring.broken;
  if (flags & SNAP_BROKEN) {
    for (let i = 0; i < BROKEN_WORDS; i++) B[k * BROKEN_WORDS + i] = r.u32v();
  } else {
    B.copyWithin(k * BROKEN_WORDS, base * BROKEN_WORDS, (base + 1) * BROKEN_WORDS);
  }

  own.lastCmd = lastCmd;
  const rs = own.round;
  rs.phase = r.u8v();
  rs.ticksLeft = r.u32v();
  rs.scoreT = r.u8v();
  rs.scoreCT = r.u8v();
  rs.info = r.u8v();
  rs.round = r.u8v();
  rs.mode = r.u8v();
  const bomb = own.bomb;
  bomb.state = r.u8v();
  if (bomb.state >= BOMB_DROPPED) {
    bomb.x = r.f32v();
    bomb.y = r.f32v();
    bomb.z = r.f32v();
    bomb.ticksLeft = r.u16v();
  }
  const mv = own.movers;
  mv.count = r.u8v();
  for (let m = 0; m < mv.count; m++) {
    mv.mover[m] = r.u8v();
    const bits = r.u8v();
    mv.dir[m] = (bits & 3) - 1;
    mv.sign[m] = bits & 4 ? -1 : 1;
    mv.from[m] = r.f32v();
    mv.t0[m] = r.u32v();
  }
  own.health = r.u8v();
  const armor = r.u8v();
  own.armor = armor & 127;
  own.helmet = (armor & 128) !== 0;
  own.spawnCount = r.u8v();
  own.team = r.u8v();
  own.spawnYaw = r.f32v();
  own.money = r.u16v();
  own.flags = r.u8v();
  own.flashLeft = r.u8v() / 32;
  own.flashTotal = r.u8v() / 32;
  own.useProgress = r.u8v() / 255;
  r.bytesInto(own.ps);
  readWeaponState(r, own.wsF);

  const rows = MAX_PLAYERS * E_FIELDS;
  if (base >= 0) E.copyWithin(k * rows, base * rows, (base + 1) * rows);
  else E.fill(0, k * rows, (k + 1) * rows);
  const n = r.u8v();
  for (let i = 0; i < n; i++) {
    const id = r.u8v();
    const mask = r.u8v();
    if (id >= MAX_PLAYERS) {
      ring.seq[k] = -1;
      return -1;
    }
    const c = ring.row(k, id);
    if (mask & F_REMOVE) {
      E.fill(0, c, c + E_FIELDS);
      continue;
    }
    E[c + E_ACTIVE] = 1;
    if (mask & F_ORIGIN) {
      E[c + E_X] = r.f32v();
      E[c + E_Y] = r.f32v();
      E[c + E_Z] = r.f32v();
    }
    if (mask & F_ANGLES) {
      E[c + E_PITCH] = r.u16v();
      E[c + E_YAW] = r.u16v();
    }
    if (mask & F_STANCE) {
      E[c + E_FLAGS] = r.u8v();
      E[c + E_DUCK] = r.u8v();
    }
    if (mask & F_WEAPON) E[c + E_WEAPON] = r.u8v();
    if (mask & F_HEALTH) E[c + E_HEALTH] = r.u8v();
    if (mask & F_TEAM) E[c + E_TEAM] = r.u8v();
    if (mask & F_ANIM) {
      E[c + E_ANIM] = r.u8v();
      E[c + E_SHOTS] = r.u8v();
    }
  }
  if (ev) readEvents(r, ev);
  return k;
}
