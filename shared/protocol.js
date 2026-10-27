// Binary wire protocol (WebTransport datagrams, little-endian). Every message fits one
// datagram of at most MAX_DATAGRAM bytes; readers and writers reuse preallocated
// buffers.
//
// Client -> server
//   HELLO    u8 type, u16 version, u8 team, u8 primary, u8 secondary, str name
//   CMDS     u8 type, u32 ackSeq, u8 n, n x { u32 tick, u32 buttons, f32 pitch, f32 yaw, i8 select }
//            (oldest first; the newest command plus the previous CMD_REDUNDANCY - 1, so a
//            lost datagram loses no input)
// Server -> client
//   WELCOME  u8 type, u16 version, u8 playerId, u32 serverTick, u8 tickRate, str map
//   REJECT   u8 type, str reason
//   SNAPSHOT u8 type, u32 seq, u32 baseSeq (0 = full), u32 lastCmd, u8 flags,
//            [u32 x 8 broken-breakable mask if flags & SNAP_BROKEN],
//            own player: u8 health, u8 armor, u8 spawnCount, u8 team, f32 spawnYaw,
//                        PlayerState bytes, WeaponState bytes (full every time, for prediction),
//            u8 n, n x { u8 id, u8 fieldMask, changed fields } (other players, delta vs base)

import { PS_SIZE } from './pmove.js';
import { WS_SIZE } from './weapons.js';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 20;
export const MAX_DATAGRAM = 1024; // Chrome's WebTransport maxDatagramSize
export const CMD_REDUNDANCY = 4;
export const SNAPSHOT_HISTORY = 32; // power of two

export const C2S_HELLO = 1;
export const C2S_CMDS = 2;
export const S2C_WELCOME = 10;
export const S2C_SNAPSHOT = 11;
export const S2C_REJECT = 12;

export const SNAP_BROKEN = 1;
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

  bytes(src) {
    this.u8.set(src, this.pos);
    this.pos += src.length;
  }

  str(s) { // short UTF-8 string, at most 63 bytes
    const n = utf8Encoder.encodeInto(s, this.u8.subarray(this.pos + 1, this.pos + 64)).written;
    this.u8[this.pos] = n;
    this.pos += 1 + n;
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

  bytesInto(dst) {
    dst.set(this.u8.subarray(this.pos, this.pos + dst.length));
    this.pos += dst.length;
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
    this.newest = -1; // newest tick ever stored
  }

  put(tick, buttons, select, pitch, yaw) {
    const k = tick & this.mask;
    if (tick > this.newest) this.newest = tick;
    this.tick[k] = tick;
    this.buttons[k] = buttons;
    this.select[k] = select;
    this.pitch[k] = pitch;
    this.yaw[k] = yaw;
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
  for (let i = 0; i < n && r.remaining >= 17; i++) {
    const t = r.u32v(), buttons = r.u32v(), pitch = r.f32v(), yaw = r.f32v(), select = r.i8v();
    if (t >= minTick && Number.isFinite(pitch) && Number.isFinite(yaw)) ring.put(t, buttons, select, pitch, yaw);
  }
  return ack;
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
export const E_FIELDS = 11;

const F_ORIGIN = 1;
const F_ANGLES = 2;
const F_STANCE = 4; // flags + duck amount
const F_WEAPON = 8;
const F_HEALTH = 16;
const F_TEAM = 32;
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

// Encodes snapshot `k` of `ring` for player `self`, as a delta against slot `base`
// (-1 = full). `own` = { lastCmd, spawnYaw, player }.
export function writeSnapshot(w, ring, k, base, self, own) {
  const E = ring.ents;
  w.reset();
  w.u8v(S2C_SNAPSHOT);
  w.u32v(ring.seq[k]);
  w.u32v(base >= 0 ? ring.seq[base] : 0);
  w.u32v(own.lastCmd);
  const sendBroken = base < 0 || !sameBroken(ring.broken, k, ring.broken, base);
  w.u8v(sendBroken ? SNAP_BROKEN : 0);
  if (sendBroken) for (let i = 0; i < BROKEN_WORDS; i++) w.u32v(ring.broken[k * BROKEN_WORDS + i]);

  const p = own.player;
  w.u8v(Math.min(Math.max(Math.ceil(p.health), 0), 255));
  w.u8v(p.armor);
  w.u8v(p.spawnCount);
  w.u8v(p.team);
  w.f32v(own.spawnYaw);
  w.bytes(p.psBytes);
  w.bytes(p.wsBytes);

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
    count++;
  }
  w.u8[countAt] = count;
  return w.view();
}

// Own-player block of a decoded snapshot (filled in place).
export class OwnState {
  constructor() {
    this.lastCmd = 0;
    this.health = 0;
    this.armor = 0;
    this.spawnCount = 0;
    this.team = 0;
    this.spawnYaw = 0;
    this.ps = new Uint8Array(PS_SIZE * 4); // raw PlayerState bytes
    this.psF = new Float32Array(this.ps.buffer); // the same bytes as floats
    this.ws = new Uint8Array(WS_SIZE * 8); // raw WeaponState bytes
  }
}

// Decodes a snapshot (after the type byte) into `ring`. Returns its slot index, or -1
// if its delta base is no longer held (the snapshot is then dropped).
export function readSnapshot(r, ring, own) {
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
  own.health = r.u8v();
  own.armor = r.u8v();
  own.spawnCount = r.u8v();
  own.team = r.u8v();
  own.spawnYaw = r.f32v();
  r.bytesInto(own.ps);
  r.bytesInto(own.ws);

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
  }
  return k;
}
