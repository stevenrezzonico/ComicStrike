// WebTransport listener on top of Deno's QUIC API.
// Everything runtime-specific lives here so the transport can be swapped.

export class Session {
  constructor(id, wt) {
    this.id = id;
    this.wt = wt;
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

// onSession(session) -> { onDatagram(bytes), onClose() }
export function listen({ hostname = '0.0.0.0', port, cert, key }, onSession) {
  const endpoint = new Deno.QuicEndpoint({ hostname, port });
  const listener = endpoint.listen({ alpnProtocols: ['h3'], cert, key });
  let nextId = 1;

  (async () => {
    for await (const incoming of listener) {
      handle(incoming).catch((err) => console.warn('transport: session failed:', err.message));
    }
  })();

  async function handle(incoming) {
    const conn = await incoming.accept();
    const wt = await Deno.upgradeWebTransport(conn);
    await wt.ready;
    const session = new Session(nextId++, wt);
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

  return endpoint;
}
