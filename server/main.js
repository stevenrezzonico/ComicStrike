// Game server entry point.
// HTTP (TCP) serves the client files and connection info; WebTransport (UDP/QUIC)
// carries game traffic.
//
//   deno run --unstable-net -A server/main.js
//
// Env: HTTP_PORT (tcp 27015), GAME_PORT (udp 27015), BIND (0.0.0.0),
//      HOSTNAMES ("localhost,127.0.0.1,::1") - names/IPs the certificate covers

import { fileURLToPath } from 'node:url';
import { ensureCert } from './cert.js';
import { listen } from './transport.js';

const ROOT = new URL('../', import.meta.url);
const HTTP_PORT = Number(Deno.env.get('HTTP_PORT') || 27015);
const GAME_PORT = Number(Deno.env.get('GAME_PORT') || 27015);
const HOSTNAMES = (Deno.env.get('HOSTNAMES') || 'localhost,127.0.0.1,::1').split(',');
const BIND = Deno.env.get('BIND') || '0.0.0.0';

const STATIC_DIRS = ['client/', 'shared/', 'maps/'];
const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  css: 'text/css',
  bsp: 'application/octet-stream',
};

const certInfo = await ensureCert(fileURLToPath(new URL('certs', ROOT)), HOSTNAMES);

listen({ hostname: BIND, port: GAME_PORT, cert: certInfo.cert, key: certInfo.key }, (session) => {
  console.log(`session ${session.id} connected`);
  return {
    onDatagram(bytes) {
      session.send(bytes); // spike: echo
    },
    onClose() {
      console.log(`session ${session.id} closed`);
    },
  };
});

async function serveStatic(pathname) {
  if (pathname === '/') pathname = '/client/index.html';
  const rel = pathname.slice(1);
  if (rel.includes('..') || !STATIC_DIRS.some((d) => rel.startsWith(d))) return null;
  try {
    const file = await Deno.open(new URL(rel, ROOT), { read: true });
    const ext = rel.slice(rel.lastIndexOf('.') + 1);
    return new Response(file.readable, {
      headers: {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return null;
  }
}

Deno.serve({ port: HTTP_PORT, onListen: () => {} }, async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === '/connect.json') {
    return Response.json({ port: GAME_PORT, certHash: Array.from(certInfo.hash) });
  }
  return (await serveStatic(pathname)) || new Response('not found', { status: 404 });
});

console.log(`http: http://localhost:${HTTP_PORT}/   webtransport: udp/${GAME_PORT}`);
