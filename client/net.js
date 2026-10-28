// WebTransport connection to the game server. Datagrams arriving between ticks are
// queued and decoded on the game tick (poll), so network events never interleave with
// simulation.

import {
  MAX_PLAYERS, Writer, Reader, SnapshotRing, OwnState, EventList, writeHello, writeCmds, readWelcome, readSnapshot,
  readInfo, readItems, readGrenades, readHostages, writeBuy, writeCommand, S2C_WELCOME, S2C_SNAPSHOT, S2C_REJECT,
  S2C_INFO, S2C_PRINT, S2C_CHANGELEVEL, S2C_ITEMS, S2C_GRENADES, S2C_HOSTAGES, C2S_CMDS, C2S_BYE,
} from '../shared/protocol.js';
import { Hostages } from '../shared/hostages.js';
import { Items } from '../shared/items.js';
import { Grenades } from '../shared/grenades.js';

const HELLO_RETRY_MS = 250;
const KEEPALIVE_MS = 1000; // hidden tabs stop ticking; keep the server from timing us out
const JOIN_TIMEOUT_MS = 5000;
const QUEUE = 256; // datagrams buffered between polls (4 s: hidden tabs poll at 1 Hz)
const SEND_BUFFERS = 8;
let localSessions = 0; // connections made to the practice worker

export class NetClient {
  constructor() {
    this.wt = null;
    this.local = null; // the practice worker, when connected to it
    this.localId = 0;
    this.localRcon = '';
    this.onLocal = null;
    this.writer = null;
    this.closed = false;
    this.closeReason = '';
    this.queue = new Array(QUEUE).fill(null);
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
    this.buyId = 0;
    this.cmdId = 0;
    this.prints = []; // console text from the server, taken by the game loop
    this.items = new Items(); // weapons on the ground (S2C_ITEMS)
    this.itemsVersion = 0; // bumps on every items message
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
    this.arrival = 0; // performance.now() when the newest snapshot arrived
  }

  // Opens the WebTransport session using the server's pinned certificate hash.
  async connect(timeoutMs = 3000) {
    const info = await (await fetch('/connect.json')).json();
    // Chrome resolves "localhost" to ::1 first; the server listens on IPv4.
    const host = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
    const url = `https://${host.includes(':') ? `[${host}]` : host}:${info.port}`;
    this.wt = new WebTransport(url, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(info.certHash) }],
    });
    let timer;
    await Promise.race([
      this.wt.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('connection timed out')), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    this.writer = this.wt.datagrams.writable.getWriter();
    this.wt.closed
      .then((info) => info && info.reason, (err) => err.message)
      .then((reason) => {
        this.closed = true;
        this.closeReason = reason || 'closed';
      });
    this.readLoop();
    this.opened();
  }

  // Practice: the server running in a Web Worker (client/localserver.js); datagrams go
  // as messages, one each way. `rcon`: the worker's rcon password (the console uses it).
  connectLocal(worker, rcon) {
    const id = this.localId = ++localSessions;
    this.local = worker;
    this.localRcon = rcon;
    this.onLocal = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'dgram') this.receiveDatagram(new Uint8Array(m.bytes));
      else if (m.type === 'close') {
        this.closed = true;
        this.closeReason = m.reason || 'closed';
        worker.removeEventListener('message', this.onLocal);
      }
    };
    worker.addEventListener('message', this.onLocal);
    worker.postMessage({ type: 'open', id });
    this.opened();
  }

  opened() {
    // Leaving or reloading the page: close the session so the server frees our player
    // at once instead of waiting for the timeout.
    addEventListener('pagehide', () => this.close('page closed'));
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
    this.bytesIn += value.byteLength + 28; // + UDP/IP headers, like net_graph counts
    this.packetsIn++;
    const t = performance.now();
    if (this.lastPacketAt) this.gaps[this.gapCount++ & 127] = t - this.lastPacketAt;
    this.lastPacketAt = t;
    if (this.qLen === QUEUE) { // tick loop stalled: drop the oldest
      this.qHead = (this.qHead + 1) % QUEUE;
      this.qLen--;
    }
    this.queue[(this.qHead + this.qLen) % QUEUE] = value;
    this.qLen++;
  }

  close(reason) {
    if (this.closed) return;
    // Say goodbye first: the session close itself does not always reach the server.
    const w = this.nextWriter().reset();
    w.u8v(C2S_BYE);
    this.send(w.view());
    this.closed = true;
    this.closeReason = reason;
    if (this.local) {
      this.local.removeEventListener('message', this.onLocal);
      this.local.postMessage({ type: 'close', id: this.localId });
      return;
    }
    try {
      this.wt.close({ closeCode: 0, reason });
    } catch { /* already closed */ }
  }

  send(bytes) {
    if (this.closed) return;
    this.lastSend = performance.now();
    this.bytesOut += bytes.byteLength + 28;
    this.packetsOut++;
    if (this.local) {
      const copy = bytes.slice(); // the writers' buffers are reused
      this.local.postMessage({ type: 'dgram', id: this.localId, bytes: copy.buffer }, [copy.buffer]);
      return;
    }
    this.writer.write(bytes).catch(() => {});
  }

  nextWriter() {
    const w = this.out[this.outNext];
    this.outNext = (this.outNext + 1) % SEND_BUFFERS;
    return w;
  }

  // Sends HELLO until the server answers. Resolves with the WELCOME.
  async join(team, primary, secondary, name) {
    const start = performance.now();
    while (!this.welcome) {
      if (this.rejected) throw new Error(`server rejected us: ${this.rejected}`);
      if (this.closed) throw new Error(`connection closed: ${this.closeReason}`);
      if (performance.now() - start > JOIN_TIMEOUT_MS) throw new Error('no answer from the server');
      this.send(writeHello(this.nextWriter(), team, primary, secondary, name));
      await new Promise((r) => setTimeout(r, HELLO_RETRY_MS));
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
    let fresh = false;
    this.events.shots = 0;
    this.events.kills = 0;
    while (this.qLen) {
      const bytes = this.queue[this.qHead];
      this.queue[this.qHead] = null;
      this.qHead = (this.qHead + 1) % QUEUE;
      this.qLen--;
      const r = this.reader.set(bytes);
      const type = r.u8v();
      if (type === S2C_SNAPSHOT) {
        const k = readSnapshot(r, this.ring, this.scratch, this.events);
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
          this.arrival = performance.now();
          fresh = true;
        }
      } else if (type === S2C_WELCOME) {
        if (!this.welcome) this.welcome = readWelcome(r);
      } else if (type === S2C_REJECT) {
        this.rejected = r.str();
      } else if (type === S2C_INFO) {
        readInfo(r, this.names, this.teams, this.kills, this.deaths, this.scores);
      } else if (type === S2C_PRINT) {
        this.prints.push(r.lstr());
      } else if (type === S2C_CHANGELEVEL) {
        this.changelevel = r.str();
      } else if (type === S2C_HOSTAGES) {
        readHostages(r, this.hostages);
      } else if (type === S2C_GRENADES) {
        const tick = readGrenades(r, this.grenadeScratch);
        if (tick > this.grenadeTick) { // datagrams may arrive out of order
          [this.grenades, this.grenadeScratch] = [this.grenadeScratch, this.grenades];
          this.grenadeTick = tick;
          this.grenadesVersion++;
        }
      } else if (type === S2C_ITEMS) {
        readItems(r, this.items);
        this.itemsVersion++;
      }
    }
    return fresh;
  }
}
