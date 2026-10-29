// Game server entry point.
// HTTP(S) (TCP) serves the client files and connection info; WebTransport (UDP/QUIC)
// carries game traffic.
//
//   deno run --unstable-net -A server/main.js
//
// Env: HTTP_PORT (tcp 27015), GAME_PORT (udp 27015), BIND (0.0.0.0),
//      MAP (de_dust2) - maps/<MAP>.bsp, RCON_PASSWORD - enables rcon,
//      TLS_CERT, TLS_KEY - PEM files of a real certificate (e.g. Let's Encrypt fullchain.pem
//        and privkey.pem): the pages go over HTTPS and WebTransport uses it as browsers
//        check any site's. Without them: plain HTTP and a self-signed certificate made in
//        certs/ that the page pins by hash (development),
//      HOSTNAMES ("localhost,127.0.0.1,::1") - names/IPs the self-signed certificate covers,
//      REDIRECT_PORT - with TLS, a plain HTTP port (80) that redirects to the HTTPS site.
// See deploy/README.md for a server with its own domain.
// cfg/server.cfg runs at startup; the terminal is a server console (status, map,
// mp_restartgame, ...).

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ensureCert } from './cert.js';
import { staticPath } from './static.js';
import { listen } from './transport.js';
import { Host, GAME_MODES } from './host.js';
import { parseBSP } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const HTTP_PORT = Number(Deno.env.get('HTTP_PORT') || 27015);
const GAME_PORT = Number(Deno.env.get('GAME_PORT') || 27015);
const HOSTNAMES = (Deno.env.get('HOSTNAMES') || 'localhost,127.0.0.1,::1').split(',');
const BIND = Deno.env.get('BIND') || '0.0.0.0';
const MAP = Deno.env.get('MAP') || 'de_dust2';
const TLS_CERT = Deno.env.get('TLS_CERT'), TLS_KEY = Deno.env.get('TLS_KEY');
const REDIRECT_PORT = Number(Deno.env.get('REDIRECT_PORT') || 0);

const STATIC_DIRS = ['client/', 'shared/', 'maps/'];
// The game server code and mode cfgs, for Practice: the browser runs them in a Web Worker
// (client/localserver.js). Not main.js, the transport, the certificate or server.cfg.
const STATIC_FILES = new Set(['server/host.js', 'server/game.js', 'server/bots.js',
  ...Object.values(GAME_MODES).map((name) => `cfg/gamemode_${name}.cfg`)]);
const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  css: 'text/css',
  bsp: 'application/octet-stream',
  cfg: 'text/plain; charset=utf-8',
};

if (!TLS_CERT !== !TLS_KEY) throw new Error('set both TLS_CERT and TLS_KEY, or neither');
// A real certificate (no hash: browsers check it like any site's; they only accept a pinned
// one valid for at most 14 days), else our own self-signed one, pinned.
const certInfo = TLS_CERT ?
  { cert: Deno.readTextFileSync(TLS_CERT), key: Deno.readTextFileSync(TLS_KEY), hash: null } :
  await ensureCert(fileURLToPath(new URL('certs', ROOT)), HOSTNAMES);

if (!/^[\w-]+$/.test(MAP)) throw new Error(`bad MAP: ${MAP}`);
const readText = (url) => {
  try {
    return Deno.readTextFileSync(url);
  } catch {
    return null;
  }
};
const host = new Host({
  loadMap: (name) => parseBSP(Deno.readFileSync(new URL(`maps/${name}.bsp`, ROOT)).buffer),
  listMaps: () => [...Deno.readDirSync(new URL('maps/', ROOT))].map((e) => e.name).filter((n) => n.endsWith('.bsp'))
    .map((n) => n.slice(0, -4)).sort(),
  readCfg: (name) => readText(new URL(`cfg/${name}`, ROOT)),
  quit: () => Deno.exit(0),
});
if (readText(new URL('cfg/server.cfg', ROOT)) !== null) host.execCfg('server.cfg');
const envPassword = Deno.env.get('RCON_PASSWORD');
if (envPassword) host.password.set(envPassword);
host.start(MAP);

listen({ hostname: BIND, port: GAME_PORT, cert: certInfo.cert, key: certInfo.key }, (session) => {
  const game = host.game; // a map change replaces the game; this session stays with its own
  const client = game.connect(session);
  if (!client) return { onDatagram() {}, onClose() {} };
  return {
    onDatagram(bytes) {
      game.receive(client, bytes);
    },
    onClose() {
      if (client.joined) console.log(`player ${client.id} "${client.name}" left`);
      game.disconnect(client);
    },
  };
});

// Fixed-rate loop on the monotonic clock: each wakeup runs every tick that is due, so
// timer jitter never accumulates into drift. After a long stall it skips ahead.
const TICK_MS = 1000 / TICK_RATE;
let epoch = performance.now();
function loop() {
  const game = host.game;
  const due = Math.floor((performance.now() - epoch) / TICK_MS);
  let ran = 0;
  while (game.tick < due && ran < 8) {
    host.step(game);
    ran++;
  }
  if (game.tick < due) epoch = performance.now() - game.tick * TICK_MS; // fell behind: resync
  setTimeout(loop, Math.max(0, epoch + (game.tick + 1) * TICK_MS - performance.now()));
}
loop();

async function serveStatic(pathname) {
  const rel = staticPath(pathname, STATIC_DIRS, STATIC_FILES);
  if (!rel) return null;
  try {
    const file = await Deno.open(join(ROOT_PATH, rel), { read: true });
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

const tls = TLS_CERT ? { cert: certInfo.cert, key: certInfo.key } : {};
Deno.serve({ hostname: BIND, port: HTTP_PORT, ...tls, onListen: () => {} }, async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === '/connect.json') {
    const certHash = certInfo.hash && Array.from(certInfo.hash);
    return Response.json({ port: GAME_PORT, certHash, ...host.info() });
  }
  if (pathname === '/maps.json') return Response.json(host.opts.listMaps()); // for offline practice
  return (await serveStatic(pathname)) || new Response('not found', { status: 404 });
});

// Plain HTTP to the HTTPS site (port 80: people typing the bare name).
if (TLS_CERT && REDIRECT_PORT) {
  Deno.serve({ hostname: BIND, port: REDIRECT_PORT, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    url.protocol = 'https:';
    url.port = HTTP_PORT === 443 ? '' : String(HTTP_PORT);
    return Response.redirect(url.href, 301);
  });
}

const site = TLS_CERT ? `https://${HOSTNAMES[0]}${HTTP_PORT === 443 ? '' : `:${HTTP_PORT}`}/` :
  `http://127.0.0.1:${HTTP_PORT}/`;
console.log(`${site}   webtransport: udp/${GAME_PORT}   ${TLS_CERT ? 'certificate: ' + TLS_CERT : 'self-signed certificate (development)'}` +
  `   map: ${MAP}   ${TICK_RATE} tick`);

// The terminal is a server console.
(async () => {
  try {
    let buf = '';
    for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) host.con.exec(line);
      }
    }
  } catch {
    // no terminal (detached): rcon and cfg/server.cfg still work
  }
})();
