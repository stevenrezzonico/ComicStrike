// WebTransport connection to the game server. Datagrams arriving between ticks are
// queued and decoded on the game tick (poll), so network events never interleave with
// simulation.

import {
  Writer, Reader, SnapshotRing, OwnState, writeHello, writeCmds, readWelcome, readSnapshot, S2C_WELCOME,
  S2C_SNAPSHOT, S2C_REJECT, C2S_CMDS,
} from '../shared/protocol.js';

const HELLO_RETRY_MS = 250;
const KEEPALIVE_MS = 1000; // hidden tabs stop ticking; keep the server from timing us out
const JOIN_TIMEOUT_MS = 5000;
const QUEUE = 64; // datagrams buffered between ticks
const SEND_BUFFERS = 8;

export class NetClient {
  constructor() {
    this.wt = null;
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
        if (this.qLen === QUEUE) { // tick loop stalled: drop the oldest
          this.qHead = (this.qHead + 1) % QUEUE;
          this.qLen--;
        }
        this.queue[(this.qHead + this.qLen) % QUEUE] = value;
        this.qLen++;
      }
    } catch { /* closed */ }
  }

  send(bytes) {
    if (this.closed) return;
    this.lastSend = performance.now();
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

  // Our newest commands (with redundancy) plus the newest snapshot we decoded.
  sendCmds(ring, newestTick) {
    this.send(writeCmds(this.nextWriter(), this.latestSeq, ring, newestTick));
  }

  // Decodes queued datagrams. Returns true if a newer snapshot arrived.
  poll() {
    let fresh = false;
    while (this.qLen) {
      const bytes = this.queue[this.qHead];
      this.queue[this.qHead] = null;
      this.qHead = (this.qHead + 1) % QUEUE;
      this.qLen--;
      const r = this.reader.set(bytes);
      const type = r.u8v();
      if (type === S2C_SNAPSHOT) {
        const k = readSnapshot(r, this.ring, this.scratch);
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
        if (!this.welcome) this.welcome = readWelcome(r);
      } else if (type === S2C_REJECT) {
        this.rejected = r.str();
      }
    }
    return fresh;
  }
}
