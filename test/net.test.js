// NetClient's connection: a session that never opens (timed out, handshake refused) fails
// connect() with its reason and leaves a closed client that close() and send() pass over.
// Before, close() sent its goodbye through the missing writer and threw, so leaving the game
// failed and the menu never showed why the connection did not start.
import assert from 'node:assert/strict';
import { NetClient } from '../client/net.js';

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
