// WebTransport listener on top of Deno's QUIC API.
// Everything runtime-specific lives here so the transport can be swapped.

export class Session {
  constructor(id, wt, address) {
    this.id = id;
    this.wt = wt;
    this.address = address; // the remote IP (rcon counts bad passwords by it)
    this.writer = wt.datagrams.writable.getWriter();
    this.open = true;
    this.maxDatagramSize = wt.datagrams.maxDatagramSize || 1200;
  }

  // Fire-and-forget: datagrams are unreliable by design.
  send(bytes) {
    if (this.open) this.writer.write(bytes).catch(() => {});
  }

  close(reason = '') {
    if (!this.open) return;
    this.open = false;
    try { this.wt.close({ closeCode: 0, reason }); } catch { /* already closed */ }
  }
}

const UPGRADE_MS = 10000; // from the QUIC handshake to a ready WebTransport session

// onSession(session) -> { onDatagram(bytes), onClose() }
// connections: an AddressCounts (server/host.js) bounding the open connections per address,
// sessions or not: 2,000 that never upgraded were held forever, 45 KB each.
// Returns { endpoint, renew(cert, key) }: renew swaps the certificate for new connections (a
// new listener on the same endpoint; the open connections stay).
export function listen({ hostname = '0.0.0.0', port, cert, key, connections = null }, onSession) {
  const endpoint = new Deno.QuicEndpoint({ hostname, port });
  let listener = endpoint.listen({ alpnProtocols: ['h3'], cert, key });
  let nextId = 1;

  const accept = async (l) => {
    try {
      for await (const incoming of l) {
        handle(incoming).catch((err) => console.warn('transport: session failed:', err.message));
      }
    } catch (err) {
      if (l === listener) throw err; // a stopped listener's loop may end with an error
    }
  };
  accept(listener);

  // The address is read off the accepted connection: an incoming one's remoteAddr throws
  // ("Invalid QuicIncoming resource"), and read in the loop above that ended the server.
  async function handle(incoming) {
    const conn = await incoming.accept();
    const address = conn.remoteAddr && conn.remoteAddr.hostname;
    if (connections && !connections.add(address)) return conn.close({ closeCode: 0, reason: 'too many connections' });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (connections) connections.remove(address);
    };
    try {
      await serve(conn, release);
    } finally {
      release();
    }
  }

  async function serve(conn, release) {
    const timer = setTimeout(() => { // never upgraded: closed, and no longer counted even if the awaits hang
      release();
      try { conn.close({ closeCode: 0, reason: 'no upgrade' }); } catch { /* already closed */ }
    }, UPGRADE_MS);
    let wt;
    try {
      wt = await Deno.upgradeWebTransport(conn);
      await wt.ready;
    } finally {
      clearTimeout(timer);
    }
    const session = new Session(nextId++, wt, conn.remoteAddr && conn.remoteAddr.hostname);
    const handlers = onSession(session);
    const reader = wt.datagrams.readable.getReader();
    // Whichever notices first (closed promise or the end of the datagram stream).
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      session.open = false;
      handlers.onClose();
    };
    wt.closed.then(end, end);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        handlers.onDatagram(value);
      }
    } catch { /* connection dropped */ }
    session.close();
    end();
  }

  return {
    endpoint,
    renew(newCert, newKey) {
      listener.stop();
      listener = endpoint.listen({ alpnProtocols: ['h3'], cert: newCert, key: newKey });
      accept(listener);
    },
  };
}
