// NetClient's connection: a session that never opens (timed out, handshake refused) fails
// connect() with its reason and leaves a closed client that close() and send() pass over.
// Before, close() sent its goodbye through the missing writer and threw, so leaving the game
// failed and the menu never showed why the connection did not start.
import assert from 'node:assert/strict';
import { NetClient } from '../client/net.js';
import { Session, CLOSE_MS, listen } from '../server/transport.js';
import { renewCert, ensureCert } from '../server/cert.js';

// connect() with a stand-in fetch, page location and WebTransport whose `ready` is `ready`.
async function failedConnect(ready, timeoutMs) {
  const saved = { fetch: globalThis.fetch, location: globalThis.location, WebTransport: globalThis.WebTransport };
  let closedByClient = 0;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ port: 27015, certHash: null }) });
  Object.defineProperty(globalThis, 'location', { value: { hostname: '127.0.0.1' }, configurable: true });
  globalThis.WebTransport = class {
    constructor() {
      this.ready = ready();
      this.closed = this.ready.then(() => new Promise(() => {}));
    }
    close() {
      closedByClient++;
    }
  };
  const n = new NetClient();
  try {
    await assert.rejects(n.connect('', timeoutMs), Error);
  } finally {
    globalThis.fetch = saved.fetch;
    Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true });
    globalThis.WebTransport = saved.WebTransport;
  }
  return { n, closedByClient };
}

Deno.test('net: a client that never connected closes without sending', () => {
  const n = new NetClient();
  n.close('disconnect');
  assert.equal(n.closed, true);
  assert.equal(n.packetsOut, 0);
});

Deno.test('net: a refused handshake fails connect() with its reason, and close() is safe', async () => {
  const { n, closedByClient } = await failedConnect(() => Promise.reject(new Error('handshake refused')), 1000);
  assert.equal(n.closed, true);
  assert.equal(n.closeReason, 'handshake refused');
  assert.equal(closedByClient, 1, 'the session is given up');
  n.close('disconnect'); // leaveGame() after the failure: no throw
  assert.equal(n.packetsOut, 0);
});

Deno.test('net: a session that never opens times out', async () => {
  const { n } = await failedConnect(() => new Promise(() => {}), 20);
  assert.equal(n.closeReason, 'connection timed out');
  n.close('disconnect');
});

// The server's side of a session (server/transport.js): a close stops sending and receiving
// at once and closes the connection CLOSE_MS later, so a REJECT sent just before it goes out
// (closed at once, it was lost: a kicked player read "connection lost", not why).
Deno.test('transport: a closed session sends nothing more and closes its connection a moment later', async () => {
  const written = [], closes = [];
  const wt = {
    datagrams: { writable: { getWriter: () => ({ write: (b) => (written.push(b), Promise.resolve()) }) }, maxDatagramSize: 1200 },
    close: (o) => closes.push(o.reason),
  };
  const s = new Session(1, wt, '203.0.113.1');
  s.send(new Uint8Array([1]));
  s.close('kicked');
  s.send(new Uint8Array([2]));
  s.close('again');
  assert.equal(written.length, 1, 'nothing after the close');
  assert.equal(closes.length, 0, 'the connection stays a moment');
  await new Promise((r) => setTimeout(r, CLOSE_MS + 50));
  assert.deepEqual(closes, ['kicked'], 'then closes, once');
});

// A WritableStream queues what its sink has not taken yet: the buffer the game writes its next
// datagram into (its rotating writers) must not be what is queued.
Deno.test('transport: a datagram still queued keeps its bytes when its buffer is written again', async () => {
  const written = [];
  const writable = new WritableStream({ write: (b) => void written.push(b[0]) });
  const s = new Session(1, { datagrams: { writable } }, '203.0.113.1');
  const buf = new Uint8Array(1);
  for (let i = 1; i <= 3; i++) {
    buf[0] = i;
    s.send(buf);
  }
  await s.writer.ready;
  assert.deepEqual(written, [1, 2, 3]);
});

// server/main.js's renewal every 6 hours: connect.json pins only what the listener serves.
Deno.test('transport: a new certificate reaches connect.json only once the listener took it', () => {
  const info = { cert: 'old', key: 'k0', hash: [0] }, fresh = { cert: 'new', key: 'k1', hash: [1] };
  assert.throws(() => renewCert(info, fresh, { renew: () => { throw new Error('refused'); } }), /refused/);
  assert.equal(info.cert, 'old', 'still the one served');
  const served = [];
  const listener = { renew: (cert) => served.push(cert) };
  assert.equal(renewCert(info, fresh, listener), true, 'the next check tries again');
  assert.deepEqual([info.cert, info.key, info.hash, served], ['new', 'k1', [1], ['new']]);
  assert.equal(renewCert(info, { ...fresh }, listener), false, 'the same one: nothing to do');
  assert.equal(served.length, 1);
});

// A client that finishes the QUIC handshake (ALPN h3) and never upgrades got Deno's default 100
// streams each way and filled every one's window, never read: 16 connections from one address
// held ~1 GB. A session needs one bidirectional stream (CONNECT) and three unidirectional ones
// (HTTP/3's control and QPACK). Needs Deno's QUIC (--unstable-net), the network and openssl for
// a certificate (`deno task test` has neither: skipped there).
const granted = (d) => Deno.permissions.querySync(d).state === 'granted';
const quic = typeof Deno.QuicEndpoint === 'function' && granted({ name: 'net' }) && granted({ name: 'write' }) &&
  granted({ name: 'run', command: 'openssl' });
Deno.test({
  name: 'transport: a connection gets only the streams a WebTransport session needs',
  ignore: !quic, sanitizeOps: false, sanitizeResources: false, // (the listener stays up: listen has no stop)
  async fn() {
    const info = await ensureCert(await Deno.makeTempDir(), ['localhost']);
    const port = 40000 + Math.floor(Math.random() * 20000);
    listen({ hostname: '127.0.0.1', port, cert: info.cert, key: info.key }, () => ({ onDatagram() {}, onClose() {} }));
    const endpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 }); // (Windows: no IPv4-mapped sends)
    const conn = await Deno.connectQuic({
      hostname: '127.0.0.1', port, serverName: 'localhost', alpnProtocols: ['h3'], endpoint,
      serverCertificateHashes: [{ algorithm: 'sha-256', value: info.hash }],
    });
    // Streams opened up to the peer's limit: Deno throws at it, a peer may also just give no credit.
    const count = async (open) => {
      let n = 0;
      while (n < 8 && await Promise.race([open().then(() => true, () => false), new Promise((r) => setTimeout(r, 300, false))])) n++;
      return n;
    };
    try {
      assert.equal(await count(() => conn.createBidirectionalStream()), 1);
      assert.equal(await count(() => conn.createUnidirectionalStream()), 3);
    } finally {
      conn.close();
      endpoint.close();
    }
  },
});
