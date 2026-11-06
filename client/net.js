// WebTransport connection to the game server. Datagrams arriving between ticks are
// queued and decoded on the game tick (poll), so network events never interleave with
// simulation.

import {
  MAX_PLAYERS, Writer, Reader, SnapshotRing, OwnState, EventList, writeHello, writeCmds, readWelcome, readSnapshot,
  readInfo, readItems, readGrenades, readHostages, readChat, readReport, readPing, S2C_PING, readVote, S2C_VOTE, VOTE_RUNNING, writeBuy, writeCommand, S2C_WELCOME, S2C_SNAPSHOT,
  S2C_REJECT, S2C_INFO, S2C_PRINT, S2C_CHANGELEVEL, S2C_ITEMS, S2C_GRENADES, S2C_HOSTAGES, S2C_CHAT, S2C_REPORT, C2S_CMDS,
  C2S_BYE,
} from '../shared/protocol.js';
import { Hostages } from '../shared/hostages.js';
import { Ring, SLOT, TO_WORKER_SLOTS, TO_PAGE_SLOTS, ringBytes } from './ring.js';
import { Items } from '../shared/items.js';
import { Grenades } from '../shared/grenades.js';

const HELLO_RETRY_MS = 250;
const JOIN_POLL_MS = 10; // the WELCOME is looked for this often (practice answers within a tick)
const KEEPALIVE_MS = 1000; // hidden tabs stop ticking; keep the server from timing us out
const JOIN_TIMEOUT_MS = 5000;
const QUEUE = 256; // datagrams buffered between polls (4 s: hidden tabs poll at 1 Hz)
const SEND_BUFFERS = 8;
let localSessions = 0; // connections made to the practice worker
const ignore = () => {}; // lost datagram writes (one handler, not a closure per send)

export class NetClient {
  constructor() {
    this.wt = null;
    this.local = null; // the practice worker, when connected to it
    this.localId = 0;
    this.localRcon = ''; // an rcon password the page holds (practice, a room we host): the console uses it
    this.room = ''; // the room (a hosted map) this session is in; '' the server's own game
    this.onLocal = null;
    this.writer = null;
    this.closed = false;
    this.closeReason = '';
    this.queue = new Array(QUEUE).fill(null); // datagrams: queue[k][qOff[k], qEnd[k])
    this.qOff = new Int32Array(QUEUE);
    this.qEnd = new Int32Array(QUEUE);
    this.qHead = 0;
    this.qLen = 0;
    this.out = Array.from({ length: SEND_BUFFERS }, () => new Writer());
    this.outNext = 0;
    this.reader = new Reader();
    this.ring = new SnapshotRing();
    this.own = new OwnState(); // newest snapshot's own-player block
    this.scratch = new OwnState();
    this.latest = -1; // ring slot of the newest snapshot
    this.latestSeq = 0;
    this.welcome = null;
    this.rejected = '';
    this.received = 0;
    this.dropped = 0; // snapshots that could not be decoded (base missing)
    this.lastSend = 0;
    this.events = new EventList(); // shots and kills decoded by the last poll()
    this.names = new Array(MAX_PLAYERS).fill('');
    this.teams = new Uint8Array(MAX_PLAYERS);
    this.kills = new Int32Array(MAX_PLAYERS);
    this.scores = new Int32Array(MAX_PLAYERS); // deathmatch points
    this.deaths = new Int32Array(MAX_PLAYERS);
    this.mvps = new Int32Array(MAX_PLAYERS); // rounds each player was the MVP of
    this.report = null; // the newest round's damage report { round, rows } (S2C_REPORT)
    this.buyId = 0;
    this.cmdId = 0;
    this.prints = []; // console text from the server, taken by the game loop
    this.chats = []; // chat lines { sender, flags, text } (S2C_CHAT), taken the same way
    this.pings = []; // teammates' pings { sender, x, y, z } (S2C_PING), likewise
    this.vote = null; // the newest vote (S2C_VOTE: server/votes.js), `at` when it came (ms); a new object each
    this.items = new Items(); // weapons on the ground (S2C_ITEMS)
    this.itemsVersion = 0; // bumps on every items message
    this.infoVersion = 0; // bumps when the roster (INFO) changes
    this.grenades = new Grenades(); // newest grenade lists (S2C_GRENADES)
    this.grenadeScratch = new Grenades();
    this.grenadeTick = 0;
    this.grenadesVersion = 0;
    this.hostages = new Hostages(); // S2C_HOSTAGES
    this.changelevel = ''; // the server is switching to this map: reconnect
    // Traffic totals (net_graph).
    this.bytesIn = 0;
    this.packetsIn = 0;
    this.bytesOut = 0;
    this.packetsOut = 0;
    this.gaps = new Float32Array(128); // ms between arriving datagrams (net_graph), a ring
    this.gapCount = 0;
    this.lastPacketAt = 0;
    // Demos (client/demo.js): the newest datagrams a recording starting now needs besides
    // the snapshot ring (the WELCOME, INFO, items and hostages lists), kept as they arrived
    // (references: nothing writes into a datagram).
    this.keep = { welcome: null, info: null, items: null, hostages: null };
    this.recorder = null; // a DemoRecorder taking every datagram in and our commands out
    this.onSnapshot = null; // (slot, own) after each snapshot is decoded (playback: the recorder's row)
    this.playback = false; // fed by a DemoPlayer: a demo, not a game
  }

  // Opens the WebTransport session: with the server's pinned certificate hash (its own
  // self-signed one), or none (a real certificate, checked like any site's).
  // `room`: a room's code (server/rooms.js): the session joins that room's game.
  async connect(room = '', timeoutMs = 3000) {
    const res = await fetch(room ? `/connect.json?room=${encodeURIComponent(room)}` : '/connect.json');
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
    this.room = room;
    // Chrome resolves "localhost" to ::1 first; the server listens on IPv4.
    const host = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
    const url = `https://${host.includes(':') ? `[${host}]` : host}:${info.port}`;
    this.wt = new WebTransport(url, info.certHash ? {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(info.certHash) }],
    } : {});
    let timer;
    try {
      await Promise.race([
        this.wt.ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('connection timed out')), timeoutMs);
        }),
      ]);
    } catch (err) {
      // Never opened: give the session up (its closed promise rejects too) and let the
      // caller say why; close() then has nothing to send through.
      this.wt.closed.catch(ignore);
      try {
        this.wt.close();
      } catch { /* not open */ }
      this.ended(err.message || 'could not connect');
      throw err;
    } finally {
      clearTimeout(timer);
    }
    // The spec moved the datagram writer to createWritable(); Safari has only that, Chrome both.
    const dg = this.wt.datagrams;
    this.writer = (dg.createWritable ? dg.createWritable() : dg.writable).getWriter();
    this.wt.closed
      .then((info) => info && info.reason, (err) => err.message)
      .then((reason) => this.ended(reason || 'closed'));
    this.readLoop();
    this.opened();
  }

  // Practice: the server running in a Web Worker (client/localserver.js). Cross-origin
  // isolated (`shared`: the server's COOP and COEP headers), the datagrams go through two
  // rings in shared memory (client/ring.js), each side taking what came at its own ticks:
  // no message at all (a message to the idle worker cost ~37 µs to wake its thread, 40 % of
  // a tick). Else as messages, with no object around them (an object per message was more
  // garbage than the datagrams): to the worker one buffer of ours, reused, holding the
  // session id (u32), the length (u16) and the datagram, which postMessage copies; from it a
  // transferred ArrayBuffer, the session id (u32), then each datagram after its u16 length.
  // A demo's player sends `dgram { id, bytes }` objects, one each.
  // `rcon`: the worker's rcon password (the console uses it).
  connectLocal(worker, rcon, shared = globalThis.crossOriginIsolated === true) {
    const id = this.localId = ++localSessions;
    this.local = worker;
    if (shared) {
      const sab = new SharedArrayBuffer(ringBytes(TO_WORKER_SLOTS) + ringBytes(TO_PAGE_SLOTS));
      this.toWorker = new Ring(sab, 0, TO_WORKER_SLOTS);
      this.fromWorker = new Ring(sab, ringBytes(TO_WORKER_SLOTS), TO_PAGE_SLOTS);
      this.qbuf = new Uint8Array(QUEUE * SLOT); // the queue's own copies of what the ring brought
      this.sab = sab;
    }
    const out = this.localOut = new Uint8Array(6 + 2048);
    out[0] = id;
    out[1] = id >> 8;
    out[2] = id >> 16;
    out[3] = id >> 24;
    this.localRcon = rcon;
    this.onLocal = (e) => {
      const m = e.data;
      if (m instanceof ArrayBuffer) {
        const b = new Uint8Array(m);
        if (b.length < 4 || (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) !== id) return;
        const t = performance.now();
        for (let o = 4; o + 2 <= b.length;) {
          const n = b[o] | b[o + 1] << 8;
          this.receive(b, o + 2, Math.min(o + 2 + n, b.length), t);
          o += 2 + n;
        }
        return;
      }
      if (m.id !== id) return;
      if (m.type === 'dgram') this.receiveDatagram(new Uint8Array(m.bytes));
      else if (m.type === 'close') {
        this.ended(m.reason || 'closed');
        worker.removeEventListener('message', this.onLocal);
      }
    };
    worker.addEventListener('message', this.onLocal);
    worker.postMessage(shared ? { type: 'open', id, sab: this.sab } : { type: 'open', id });
    this.opened();
  }

  opened() {
    // Leaving or reloading the page: close the session so the server frees our player
    // at once instead of waiting for the timeout. Removed on close: every map change and
    // rejoin opens a new client, and each listener kept its closed client alive.
    this.onPageHide = () => this.close('page closed');
    addEventListener('pagehide', this.onPageHide);
    const keepalive = setInterval(() => {
      if (this.closed) clearInterval(keepalive);
      else if (this.welcome && performance.now() - this.lastSend > KEEPALIVE_MS / 2) this.sendKeepalive();
    }, KEEPALIVE_MS);
  }

  // A command packet with no commands: just "still here" plus our snapshot ack.
  sendKeepalive() {
    const w = this.nextWriter().reset();
    w.u8v(C2S_CMDS);
    w.u32v(this.latestSeq);
    w.u8v(0);
    this.send(w.view());
  }

  async readLoop() {
    const reader = this.wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.receiveDatagram(value);
      }
    } catch { /* closed */ }
  }

  // Queues an arriving datagram for the next poll().
  receiveDatagram(value) {
    this.receive(value, 0, value.length, performance.now());
  }

  // Queues bytes[from, to), arrived at t (ms), for the next poll().
  receive(bytes, from, to, t) {
    this.bytesIn += to - from + 28; // + UDP/IP headers, like net_graph counts
    this.packetsIn++;
    if (this.recorder) this.recorder.incoming(bytes.slice(from, to), t); // (a copy: a batch or the queue's memory is reused)
    if (this.lastPacketAt) this.gaps[this.gapCount++ & 127] = t - this.lastPacketAt;
    this.lastPacketAt = t;
    if (this.qLen === QUEUE) { // tick loop stalled: drop the oldest
      this.queue[this.qHead] = null;
      this.qHead = (this.qHead + 1) % QUEUE;
      this.qLen--;
    }
    const k = (this.qHead + this.qLen) % QUEUE;
    this.queue[k] = bytes;
    this.qOff[k] = from;
    this.qEnd[k] = to;
    this.qLen++;
  }

  // What the practice worker put in the shared ring since the last poll, copied into the
  // queue's own memory (`qbuf`, a slot per queue place): text cannot be decoded out of shared
  // memory, and the ring's slot is the worker's again once taken.
  drainRing() {
    let t = -1;
    for (;;) {
      if (this.qLen === QUEUE) { // not polled for long: the oldest goes
        this.queue[this.qHead] = null;
        this.qHead = (this.qHead + 1) % QUEUE;
        this.qLen--;
      }
      const off = ((this.qHead + this.qLen) % QUEUE) * SLOT, n = this.fromWorker.take(this.qbuf, off);
      if (n < 0) return;
      if (t < 0) t = performance.now();
      this.receive(this.qbuf, off + 2, off + 2 + n, t);
    }
  }

  close(reason) {
    if (this.closed) return;
    // Say goodbye first: the session close itself does not always reach the server.
    const w = this.nextWriter().reset();
    w.u8v(C2S_BYE);
    this.send(w.view());
    this.ended(reason);
    if (this.local) {
      this.local.removeEventListener('message', this.onLocal);
      this.local.postMessage({ type: 'close', id: this.localId });
      return;
    }
    try {
      this.wt.close({ closeCode: 0, reason });
    } catch { /* already closed */ }
  }

  // Closed, by us or the server.
  ended(reason) {
    if (!this.closed) this.closeReason = reason;
    this.closed = true;
    if (this.onPageHide) removeEventListener('pagehide', this.onPageHide);
  }

  send(bytes) {
    if (this.closed || (!this.local && !this.writer)) return; // (no session: connect() failed or is under way)
    this.lastSend = performance.now();
    if (this.recorder) this.recorder.outgoing(bytes, this.lastSend);
    this.bytesOut += bytes.byteLength + 28;
    this.packetsOut++;
    if (this.toWorker) { // the shared ring (full: dropped, as on a network)
      this.toWorker.put(bytes);
      return;
    }
    if (this.local) { // our buffer: the id (written once), the length, the datagram; postMessage copies it
      const out = this.localOut, n = Math.min(bytes.length, out.length - 6);
      out[4] = n & 255;
      out[5] = n >> 8;
      out.set(n === bytes.length ? bytes : bytes.subarray(0, n), 6);
      this.local.postMessage(out);
      return;
    }
    this.writer.write(bytes).catch(ignore);
  }

  nextWriter() {
    const w = this.out[this.outNext];
    this.outNext = (this.outNext + 1) % SEND_BUFFERS;
    return w;
  }

  // Sends HELLO until the server answers. Resolves with the WELCOME. password: sv_password.
  async join(team, primary, secondary, name, password = '') {
    const start = performance.now();
    let sentAt = -Infinity;
    while (!this.welcome) {
      if (this.rejected) throw new Error(`server rejected us: ${this.rejected}`);
      if (this.closed) throw new Error(`connection closed: ${this.closeReason}`);
      const now = performance.now();
      if (now - start > JOIN_TIMEOUT_MS) throw new Error('no answer from the server');
      if (now - sentAt >= HELLO_RETRY_MS) {
        this.send(writeHello(this.nextWriter(), team, primary, secondary, name, this.room, password));
        sentAt = now;
      }
      await new Promise((r) => setTimeout(r, JOIN_POLL_MS));
      this.poll();
    }
    return this.welcome;
  }

  // A purchase. Datagrams can be lost: send it three times; the server acts once per id.
  buy(item) {
    this.buyId = (this.buyId + 1) & 0xffff;
    const bytes = writeBuy(this.nextWriter(), this.buyId, item).slice(); // see command()
    for (let i = 0; i < 3; i++) this.send(bytes);
  }

  // A console command for the server (name, jointeam, kill, rcon ...); sent three times,
  // run once.
  command(text) {
    this.cmdId = (this.cmdId + 1) & 0xffff;
    // Its own copy: a burst of commands would outrun the rotating send buffers while
    // the datagram writes are still queued.
    const bytes = writeCommand(this.nextWriter(), this.cmdId, text).slice();
    for (let i = 0; i < 3; i++) this.send(bytes);
  }

  // Our newest commands (with redundancy) plus the newest snapshot we decoded.
  sendCmds(ring, newestTick) {
    this.send(writeCmds(this.nextWriter(), this.latestSeq, ring, newestTick));
  }

  // Decodes queued datagrams into the snapshot ring and `events` (emptied first).
  // Returns true if a newer snapshot arrived.
  poll() {
    if (this.fromWorker) this.drainRing();
    let fresh = false;
    this.events.shots = 0;
    this.events.kills = 0;
    while (this.qLen) {
      const h = this.qHead, bytes = this.queue[h], from = this.qOff[h], to = this.qEnd[h];
      this.queue[h] = null;
      this.qHead = (h + 1) % QUEUE;
      this.qLen--;
      const r = this.reader.setRange(bytes, from, to);
      const type = r.u8v();
      if (type === S2C_SNAPSHOT) {
        const k = readSnapshot(r, this.ring, this.scratch, this.events);
        if (k >= 0 && this.onSnapshot) this.onSnapshot(k, this.scratch);
        if (k < 0) {
          this.dropped++;
          continue;
        }
        this.received++;
        const seq = this.ring.seq[k];
        if (seq > this.latestSeq) { // older ones still serve as delta bases
          this.latestSeq = seq;
          this.latest = k;
          const t = this.own;
          this.own = this.scratch;
          this.scratch = t;
          fresh = true;
        }
      } else if (type === S2C_WELCOME) {
        if (!this.welcome) {
          this.welcome = readWelcome(r);
          this.keep.welcome = bytes.slice(from, to);
        }
      } else if (type === S2C_REJECT) {
        this.rejected = r.str();
      } else if (type === S2C_INFO) { // resent every second, mostly the same
        const prev = this.keep.info;
        let same = prev !== null && prev.length === to - from;
        for (let i = 0; same && i < prev.length; i++) same = prev[i] === bytes[from + i];
        if (!same) {
          this.keep.info = bytes.slice(from, to);
          this.infoVersion++;
        }
        readInfo(r, this.names, this.teams, this.kills, this.deaths, this.scores, this.mvps);
      } else if (type === S2C_REPORT) {
        this.report = readReport(r);
      } else if (type === S2C_PRINT) {
        this.prints.push(r.lstr());
      } else if (type === S2C_CHAT) {
        this.chats.push(readChat(r));
      } else if (type === S2C_PING) {
        this.pings.push(readPing(r));
      } else if (type === S2C_VOTE) {
        const v = readVote(r), last = this.vote;
        // A running update overtaken by its own result (datagrams may arrive out of order) is old.
        if (!(last && last.id === v.id && last.state !== VOTE_RUNNING && v.state === VOTE_RUNNING)) {
          v.at = performance.now();
          this.vote = v;
        }
      } else if (type === S2C_CHANGELEVEL) {
        this.changelevel = r.str();
      } else if (type === S2C_HOSTAGES) {
        this.keep.hostages = bytes.slice(from, to);
        readHostages(r, this.hostages);
      } else if (type === S2C_GRENADES) {
        const tick = readGrenades(r, this.grenadeScratch);
        if (tick > this.grenadeTick) { // datagrams may arrive out of order
          const g = this.grenades;
          this.grenades = this.grenadeScratch;
          this.grenadeScratch = g;
          this.grenadeTick = tick;
          this.grenadesVersion++;
        }
      } else if (type === S2C_ITEMS) {
        this.keep.items = bytes.slice(from, to);
        readItems(r, this.items);
        this.itemsVersion++;
      }
    }
    return fresh;
  }
}
