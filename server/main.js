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
import { Rooms, RoomError } from './rooms.js';
import { parseBSP } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { Writer, writeReject, helloRoom } from '../shared/protocol.js';

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
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
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

// Rooms: games on maps players upload (server/rooms.js), held in memory only.
const rooms = new Rooms({ readCfg: (name) => readText(new URL(`cfg/${name}`, ROOT)) });

// A session belongs to the game its first HELLO asks for: the server's own (no room code)
// or a room's. Datagrams before it are dropped.
listen({ hostname: BIND, port: GAME_PORT, cert: certInfo.cert, key: certInfo.key }, (session) => {
  let game = null, client = null, refused = false;
  return {
    onDatagram(bytes) {
      if (!client) {
        if (refused) return;
        const code = helloRoom(bytes);
        if (code === null) return;
        const room = code ? rooms.get(code) : null;
        if (code && !room) {
          refused = true;
          session.send(writeReject(new Writer(), 'no such room: it may have closed').slice());
          session.close('no such room');
          return;
        }
        game = (room ? room.host : host).game; // a map change replaces the game; this session stays with its own
        client = game.connect(session);
        if (!client) {
          refused = true;
          return;
        }
        if (room) rooms.joined(room);
      }
      game.receive(client, bytes);
    },
    onClose() {
      if (!client) return;
      if (client.joined) console.log(`player ${client.id} "${client.name}" left`);
      game.disconnect(client);
    },
  };
});

// Fixed-rate loops on the monotonic clock, one per game (the server's own and each room's):
// each wakeup runs every tick that is due, so timer jitter never accumulates into drift.
// After a long stall a game skips ahead.
const TICK_MS = 1000 / TICK_RATE;
const main = { host, epoch: performance.now() };
let sweptAt = 0;
function runDue(entry, now) {
  const game = entry.host.game;
  const due = Math.floor((now - entry.epoch) / TICK_MS);
  let ran = 0;
  while (game.tick < due && ran < 8) {
    entry.host.step(game);
    ran++;
  }
  if (game.tick < due) entry.epoch = performance.now() - game.tick * TICK_MS; // fell behind: resync
  return entry.epoch + (game.tick + 1) * TICK_MS;
}
function loop() {
  const now = performance.now();
  let next = runDue(main, now);
  for (const room of rooms.rooms.values()) next = Math.min(next, runDue(room, now));
  if (now - sweptAt > 1000) {
    sweptAt = now;
    rooms.sweep();
  }
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

// Static files are revalidated on every visit (no-cache with an ETag from the file's size
// and time: a 304 when unchanged, so a deploy shows at once and ~1 MB of scripts and a
// multi-megabyte map are not downloaded again), and gzipped on the fly for the types that
// shrink (scripts ~4x, maps ~3x; Deno.serve does not compress a file stream by itself).
const COMPRESSED = new Set(['html', 'js', 'json', 'css', 'bsp', 'cfg', 'svg']);
async function serveStatic(pathname, req) {
  const rel = staticPath(pathname, STATIC_DIRS, STATIC_FILES);
  if (!rel) return null;
  try {
    const path = join(ROOT_PATH, rel);
    const stat = await Deno.stat(path);
    if (!stat.isFile) return null;
    const etag = `W/"${stat.size.toString(36)}-${(stat.mtime ? stat.mtime.getTime() : 0).toString(36)}"`;
    const ext = rel.slice(rel.lastIndexOf('.') + 1);
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'etag': etag,
      'vary': 'accept-encoding',
    };
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    const file = await Deno.open(path, { read: true });
    const gzip = COMPRESSED.has(ext) && /\bgzip\b/.test(req.headers.get('accept-encoding') || '');
    if (gzip) headers['content-encoding'] = 'gzip';
    else headers['content-length'] = String(stat.size);
    return new Response(gzip ? file.readable.pipeThrough(new CompressionStream('gzip')) : file.readable, { headers });
  } catch {
    return null;
  }
}

const tls = TLS_CERT ? { cert: certInfo.cert, key: certInfo.key } : {};
// A request body, refused past `max` bytes (whatever content-length says).
async function readBody(req, max) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) throw new RoomError(`the map is too large (${max >> 20} MB at most)`, 413);
  const parts = [];
  let size = 0;
  for await (const chunk of req.body || []) {
    size += chunk.byteLength;
    if (size > max) throw new RoomError(`the map is too large (${max >> 20} MB at most)`, 413);
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// POST /rooms?file=<name>&mode=<mode>&players=<n>&difficulty=<0-3>, the map file as the
// body: a new room; answers its code, the map name, the room's rcon password (the uploader's
// console uses it) and the room console's catalog (the console's suggestions).
async function createRoom(req, url, address) {
  try {
    const bytes = await readBody(req, rooms.limits.bytes);
    const q = url.searchParams;
    const room = rooms.create(bytes, {
      fileName: q.get('file') || '', mode: q.get('mode') || 'competitive', players: +q.get('players') || 0,
      difficulty: +(q.get('difficulty') ?? 1), address,
    });
    return Response.json({ code: room.code, map: room.name, rcon: room.rcon, names: room.host.con.catalog() });
  } catch (err) {
    if (!(err instanceof RoomError)) console.warn('room upload failed:', err);
    return Response.json({ error: err instanceof RoomError ? err.message : 'the upload failed' },
      { status: err instanceof RoomError ? err.status : 500 });
  }
}

async function serveRoomMap(room, req) {
  const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'vary': 'accept-encoding' };
  if (/\bgzip\b/.test(req.headers.get('accept-encoding') || '')) {
    return new Response(await rooms.gzipped(room), { headers: { ...headers, 'content-encoding': 'gzip' } });
  }
  return new Response(room.bytes, { headers });
}

Deno.serve({ hostname: BIND, port: HTTP_PORT, ...tls, onListen: () => {} }, async (req, info) => {
  const url = new URL(req.url);
  const { pathname } = url;
  if (pathname === '/connect.json') {
    const certHash = certInfo.hash && Array.from(certInfo.hash);
    const code = url.searchParams.get('room');
    if (code) {
      const room = rooms.get(code);
      if (!room) return Response.json({ error: 'no such room: it may have closed' }, { status: 404 });
      return Response.json({ port: GAME_PORT, certHash, ...room.host.info(), room: room.code });
    }
    return Response.json({ port: GAME_PORT, certHash, ...host.info() });
  }
  if (pathname === '/rooms' && req.method === 'POST') return createRoom(req, url, info.remoteAddr.hostname);
  const roomMap = /^\/rooms\/([a-z0-9]+)\/map\.bsp$/.exec(pathname);
  if (roomMap) {
    const room = rooms.get(roomMap[1]);
    return room ? serveRoomMap(room, req) : new Response('no such room', { status: 404 });
  }
  if (pathname === '/maps.json') return Response.json(host.opts.listMaps()); // for offline practice
  return (await serveStatic(pathname, req)) || new Response('not found', { status: 404 });
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
