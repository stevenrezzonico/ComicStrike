// Demo recording and playback (CS:GO's record / stop / playdemo). A demo is the stream of
// datagrams the game received, plus our own command packets (for where the recorder
// looked), each with its time; playback hands them back to a NetClient through the same
// path as the practice worker (`connectLocal` with a DemoPlayer standing in for the
// worker), so everything is decoded, interpolated and drawn as it was live, and the
// camera is a spectator's, free. No protocol change: a file holds the protocol version it
// was recorded with, and a demo of another version is refused.
//
// A recording can start mid-game: snapshots are deltas against ones the client already
// decoded (each against the one before it, so no number of kept datagrams would do), so the
// file holds the client's snapshot ring as it was (its 32 slots: sequence numbers, rows,
// breakable masks; ~33 KB), then what the NetClient keeps for a start (`keep`: the WELCOME,
// the newest INFO, items and hostages lists) and the datagrams still queued, at time 0.
// The recorder's own player is in no snapshot they received (the server sends it as the
// own block); playback rebuilds their row from that block and their recorded view
// (fillRecorderRow), so they are drawn and can be watched like anyone.
//
// File: "CSDEMO01", u32 header length, the header as JSON ({ format, version, protocol,
// map, name, recordedAt, player, seconds }), u32 ring length, the ring (RING_BYTES), then
// frames: u8 direction (0 in, 1 out), u32 ms since the start, u16 length, the datagram.

import {
  PROTOCOL_VERSION, MAX_DATAGRAM, SnapshotRing, C2S_CMDS, CmdRing, Reader, readCmds, quantizePitch, quantizeYaw, E_ACTIVE, E_X, E_Y,
  E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS, E_FIELDS, ANIM_RELOAD,
  ANIM_PLANT, ANIM_DEFUSE, ANIM_HELMET, ANIM_SILENCED,
} from '../shared/protocol.js';
import { PS_ORIGIN, PS_FLAGS, PS_DUCK_AMOUNT } from '../shared/pmove.js';
import {
  WS_ACTIVE, WS_SLOTS, WS_RELOAD_END, WS_ACTION, WS_EVENTS, WEV_FIRE, WEV_MELEE, ACTION_PLANT, ACTION_DEFUSE, silenced,
} from '../shared/weapons.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';

export const DEMO_MAGIC = 'CSDEMO01';
export const DEMO_FORMAT = 'comicstrike-demo';
export const DEMO_VERSION = 1;
export const DIR_IN = 0, DIR_OUT = 1;
export const MAX_DEMO_BYTES = 512 * 1024 * 1024; // ~4 hours of a 5v5
const MAX_HEADER = 64 * 1024;
// A SnapshotRing's state, as bytes: sequence numbers, rows, breakable masks.
const RING_PARTS = (ring) => [ring.seq, ring.ents, ring.broken];
export const RING_BYTES = RING_PARTS(new SnapshotRing()).reduce((n, a) => n + a.byteLength, 0);

export function saveRing(ring) {
  const out = new Uint8Array(RING_BYTES);
  let o = 0;
  for (const a of RING_PARTS(ring)) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  return out;
}

// Puts a saved ring's state into `ring` (playback, before the first datagram).
export function restoreRing(ring, bytes) {
  let o = 0;
  for (const a of RING_PARTS(ring)) {
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(bytes.subarray(o, o + a.byteLength));
    o += a.byteLength;
  }
}

// A demo's bytes from its header, the ring's state (saveRing) and frames ([{ dir, t,
// bytes }], t in ms, in order).
export function encodeDemo(header, ring, frames) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  let size = 8 + 4 + head.length + 4 + ring.length;
  for (const f of frames) size += 7 + f.bytes.length;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = DEMO_MAGIC.charCodeAt(i);
  dv.setUint32(8, head.length, true);
  out.set(head, 12);
  let o = 12 + head.length;
  dv.setUint32(o, ring.length, true);
  out.set(ring, o + 4);
  o += 4 + ring.length;
  for (const f of frames) {
    out[o] = f.dir;
    dv.setUint32(o + 1, Math.max(0, Math.round(f.t)), true);
    dv.setUint16(o + 5, f.bytes.length, true);
    out.set(f.bytes, o + 7);
    o += 7 + f.bytes.length;
  }
  return out;
}

// { header, ring, frames } from a demo's bytes; throws on anything that is not one (a
// spoiled or cut file is refused, never half read; a ring of another size: another build).
export function decodeDemo(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 12 || bytes.length > MAX_DEMO_BYTES) throw new Error('not a ComicStrike demo');
  for (let i = 0; i < 8; i++) if (bytes[i] !== DEMO_MAGIC.charCodeAt(i)) throw new Error('not a ComicStrike demo');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLen = dv.getUint32(8, true);
  if (headLen > MAX_HEADER || 12 + headLen > bytes.length) throw new Error('a damaged demo (header)');
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headLen)));
  } catch {
    throw new Error('a damaged demo (header)');
  }
  if (!header || header.format !== DEMO_FORMAT || typeof header.map !== 'string' || !/^[\w-]+$/.test(header.map)) {
    throw new Error('not a ComicStrike demo');
  }
  let o = 12 + headLen;
  if (o + 4 > bytes.length) throw new Error('a damaged demo (cut short)');
  const ringLen = dv.getUint32(o, true);
  if (ringLen !== RING_BYTES || o + 4 + ringLen > bytes.length) throw new Error('a demo of another version of the game');
  const ring = bytes.subarray(o + 4, o + 4 + ringLen);
  o += 4 + ringLen;
  const frames = [];
  let last = 0;
  while (o < bytes.length) {
    if (o + 7 > bytes.length) throw new Error('a damaged demo (cut short)');
    const dir = bytes[o], t = dv.getUint32(o + 1, true), len = dv.getUint16(o + 5, true);
    if ((dir !== DIR_IN && dir !== DIR_OUT) || len === 0 || len > MAX_DATAGRAM || o + 7 + len > bytes.length || t < last) {
      throw new Error('a damaged demo (frames)');
    }
    frames.push({ dir, t, bytes: bytes.subarray(o + 7, o + 7 + len) });
    last = t;
    o += 7 + len;
  }
  return { header, ring, frames };
}

// Recording a NetClient (its `recorder`): the kept state first, then every datagram in and
// our command packets out, timed from `now` (ms).
export class DemoRecorder {
  constructor(net, name, map, now) {
    this.name = name;
    this.map = map;
    this.t0 = now;
    this.last = 0;
    this.size = 0;
    this.frames = [];
    this.player = net.welcome ? net.welcome.playerId : -1;
    this.ring = saveRing(net.ring);
    const k = net.keep;
    for (const b of [k.welcome, k.info, k.items, k.hostages]) if (b) this.add(DIR_IN, 0, b);
    for (let i = 0; i < net.qLen; i++) this.add(DIR_IN, 0, net.queue[(net.qHead + i) % net.queue.length]); // not decoded yet
  }

  add(dir, t, bytes) {
    this.frames.push({ dir, t, bytes });
    this.size += 7 + bytes.length;
    this.last = t;
  }

  // A datagram received (kept as it is: NetClient never writes into one).
  incoming(bytes, now) {
    if (this.size < MAX_DEMO_BYTES) this.add(DIR_IN, now - this.t0, bytes);
  }

  // A datagram we sent: our command packets only, copied (the send buffers are reused).
  outgoing(bytes, now) {
    if (bytes[0] === C2S_CMDS && bytes.length > 6 && this.size < MAX_DEMO_BYTES) this.add(DIR_OUT, now - this.t0, bytes.slice());
  }

  get seconds() {
    return this.last / 1000;
  }

  finish() {
    return encodeDemo({
      format: DEMO_FORMAT, version: DEMO_VERSION, protocol: PROTOCOL_VERSION, map: this.map, name: this.name,
      recordedAt: Date.now(), player: this.player, seconds: Math.round(this.seconds * 10) / 10,
    }, this.ring, this.frames);
  }
}

// Plays a decoded demo to a NetClient in place of the practice worker (connectLocal):
// the frames at their times (scaled by `timescale`, held while `paused`), datagrams in as
// the worker's messages, our recorded commands into `cmds` (the recorder's view by tick),
// then a close ("demo over"). What the client sends is dropped.
export class DemoPlayer extends EventTarget {
  constructor(demo, now = () => performance.now()) {
    super();
    this.header = demo.header;
    this.ring = demo.ring; // restoreRing it into the NetClient before connecting
    this.frames = demo.frames;
    this.now = now;
    this.next = 0; // the next frame
    this.time = 0; // ms into the demo
    this.timescale = 1;
    this.paused = false;
    this.cmds = new CmdRing(256); // the recorder's commands by tick: 4 s, so a burst of frames (a slow frame, a hidden tab) never overwrites one before its snapshot is decoded
    this.reader = new Reader();
    this.id = 0;
    this.timer = 0;
    this.done = false; // the close has gone out
    this.lastAt = 0;
    this.length = demo.frames.length ? demo.frames[demo.frames.length - 1].t : 0;
  }

  postMessage(m) {
    if (m.type === 'open') {
      this.id = m.id;
      this.lastAt = this.now();
      this.step(); // the kept state at time 0 at once (the WELCOME)
      this.timer = setInterval(() => this.step(), 4);
    } else if (m.type === 'close') this.stop();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  // Advances the clock and delivers what is due.
  step() {
    const t = this.now();
    if (!this.paused) this.time += (t - this.lastAt) * this.timescale;
    this.lastAt = t;
    while (this.next < this.frames.length && this.frames[this.next].t <= this.time) {
      const f = this.frames[this.next++];
      if (f.dir === DIR_OUT) {
        const r = this.reader.set(f.bytes);
        r.u8v();
        readCmds(r, this.cmds, 0);
        continue;
      }
      const copy = f.bytes.slice(); // NetClient keeps it; the demo's bytes stay whole
      this.dispatchEvent(new MessageEvent('message', { data: { id: this.id, type: 'dgram', bytes: copy.buffer } }));
    }
    if (this.next >= this.frames.length && !this.done) {
      this.done = true;
      this.stop();
      this.dispatchEvent(new MessageEvent('message', { data: { id: this.id, type: 'close', reason: 'demo over' } }));
    }
  }
}

// The recorder's row in snapshot slot `k` of `ring` (playback): from the own block of that
// snapshot and the recorder's view at its command (`cmds`: a CmdRing), as the server fills
// everyone else's (server/game.js). `state` carries the shot count between snapshots.
export function fillRecorderRow(ring, k, id, own, cmds, state) {
  const E = ring.ents, row = ring.row(k, id);
  if (id < 0 || (own.team !== TEAM_T && own.team !== TEAM_CT)) {
    E.fill(0, row, row + E_FIELDS); // watching: no body
    return;
  }
  const f = own.psF, i = own.psI || (own.psI = new Int32Array(own.ps.buffer)), w = own.wsF;
  const ws = own.wsView || (own.wsView = { f: own.wsF });
  const t = own.lastCmd, c = t & cmds.mask, known = cmds.has(t);
  if (known) {
    state.pitch = cmds.pitch[c];
    state.yaw = cmds.yaw[c];
  }
  if (t !== state.lastCmd) {
    if (w[WS_EVENTS] & (WEV_FIRE | WEV_MELEE)) state.shots = (state.shots + 1) & 255;
    state.lastCmd = t;
  }
  const action = w[WS_ACTION];
  E[row + E_ACTIVE] = 1;
  E[row + E_X] = f[PS_ORIGIN];
  E[row + E_Y] = f[PS_ORIGIN + 1];
  E[row + E_Z] = f[PS_ORIGIN + 2];
  E[row + E_PITCH] = quantizePitch(state.pitch);
  E[row + E_YAW] = quantizeYaw(state.yaw);
  E[row + E_FLAGS] = i[PS_FLAGS] & 255;
  E[row + E_DUCK] = Math.round(f[PS_DUCK_AMOUNT] * 255);
  E[row + E_WEAPON] = w[WS_SLOTS + w[WS_ACTIVE] * 3];
  E[row + E_HEALTH] = Math.min(Math.max(own.health, 0), 255);
  E[row + E_TEAM] = own.team;
  E[row + E_ANIM] = (w[WS_RELOAD_END] > 0 ? ANIM_RELOAD : 0) | (action === ACTION_PLANT ? ANIM_PLANT : 0) |
    (action === ACTION_DEFUSE ? ANIM_DEFUSE : 0) | (own.helmet && own.armor > 0 ? ANIM_HELMET : 0) |
    (silenced(ws, w[WS_ACTIVE]) ? ANIM_SILENCED : 0);
  E[row + E_SHOTS] = state.shots;
}

// A demo name: letters, digits, _ and -, 1-40 of them.
export const demoName = (s) => /^[\w-]{1,40}$/.test(s || '') ? s : '';
