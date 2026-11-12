// Game server entry point.
// HTTP(S) (TCP) serves the client files and connection info; WebTransport (UDP/QUIC)
// carries game traffic. Every game is a room (server/rooms.js): players make them from Play
// Online, each with its own map, mode and settings; the server has no game of its own.
//
//   deno run --unstable-net -A server/main.js
//
// Env: HTTP_PORT (tcp 27015), GAME_PORT (udp 27015), BIND (0.0.0.0),
//      TLS_CERT, TLS_KEY - PEM files of a real certificate (e.g. Let's Encrypt fullchain.pem
//        and privkey.pem): the pages go over HTTPS and WebTransport uses it as browsers
//        check any site's. Without them: plain HTTP and a self-signed certificate made in
//        certs/ that the page pins by hash (development),
//      HOSTNAMES ("localhost,127.0.0.1,::1") - names/IPs the self-signed certificate covers,
//      REDIRECT_PORT - with TLS, a plain HTTP port (80) that redirects to the HTTPS site.
// See deploy/README.md for a server with its own domain.
// A room runs its mode's cfg/gamemode_<mode>.cfg, then cfg/gamemode_<mode>_server.cfg (this
// server's own overrides, as in CS:GO).

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ensureCert, renewCert } from './cert.js';
import { staticPath } from './static.js';
import { listen } from './transport.js';
import { GAME_MODES, AddressCounts, runDue } from './host.js';
import { Rooms, RoomError, readBody } from './rooms.js';
import { adminResponse } from './admin.js';
import { parseBSP } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { Writer, writeReject, helloRoom } from '../shared/protocol.js';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const HTTP_PORT = Number(Deno.env.get('HTTP_PORT') || 27015);
const GAME_PORT = Number(Deno.env.get('GAME_PORT') || 27015);
const HOSTNAMES = (Deno.env.get('HOSTNAMES') || 'localhost,127.0.0.1,::1').split(',');
const BIND = Deno.env.get('BIND') || '0.0.0.0';
const TLS_CERT = Deno.env.get('TLS_CERT'), TLS_KEY = Deno.env.get('TLS_KEY');
const REDIRECT_PORT = Number(Deno.env.get('REDIRECT_PORT') || 0);

const STATIC_DIRS = ['client/', 'shared/', 'maps/'];
// The game server code and mode cfgs, for Practice: the browser runs them in a Web Worker
// (client/localserver.js). Not main.js, the transport or the certificate.
const STATIC_FILES = new Set(['server/host.js', 'server/game.js', 'server/bots.js', 'server/votes.js',
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

const readText = (url) => {
  try {
    return Deno.readTextFileSync(url);
  } catch {
    return null;
  }
};
// The maps in maps/, read again at most every MAP_LIST_MS: a failing `callvote changelevel`
// and every GET /maps.json read the directory and sorted it.
const MAP_LIST_MS = 5000;
let mapList = null, mapListAt = -Infinity;
const listMaps = () => {
  if (performance.now() - mapListAt >= MAP_LIST_MS) {
    mapList = [...Deno.readDirSync(new URL('maps/', ROOT))].map((e) => e.name).filter((n) => n.endsWith('.bsp'))
      .map((n) => n.slice(0, -4)).sort();
    mapListAt = performance.now();
  }
  return mapList;
};
const loadMap = (name) => parseBSP(Deno.readFileSync(new URL(`maps/${name}.bsp`, ROOT)).buffer);

// Rooms (server/rooms.js): the games, on maps players upload (held in memory only) or on the
// server's maps.
const rooms = new Rooms({ readCfg: (name) => readText(new URL(`cfg/${name}`, ROOT)), maps: { loadMap, listMaps } });

// A session belongs to the room its first HELLO names; a HELLO with no room or a closed one is
// refused. Datagrams before it are dropped. At most SESSIONS_PER_ADDRESS players from one
// address in all rooms (a household behind one IPv4 address fits).
const SESSIONS_PER_ADDRESS = 5;
const CONNECTIONS_PER_ADDRESS = 16; // QUIC connections, upgraded or not (transport.js)
const HELLO_MS = 10000; // a session's first HELLO
const sessionsByAddress = new AddressCounts(SESSIONS_PER_ADDRESS);
const connections = new AddressCounts(CONNECTIONS_PER_ADDRESS);
const transport = listen({ hostname: BIND, port: GAME_PORT, cert: certInfo.cert, key: certInfo.key, connections }, (session) => {
  let game = null, client = null;
  let joining = null; // the room its HELLO named, until the room lets it in
  setTimeout(() => { // a session that never says HELLO is let go
    if (!client) session.close('no hello');
  }, HELLO_MS);
  const refuse = (reason) => {
    session.send(writeReject(new Writer(), reason).slice());
    session.close(reason);
  };
  return {
    onDatagram(bytes) {
      if (!client) {
        const code = helloRoom(bytes);
        if (code === null) return;
        const room = rooms.get(code);
        if (!room) return refuse(code ? 'no such room: it may have closed' : 'this server plays in rooms: pick one in Play Online');
        if (!sessionsByAddress.add(session.address)) return refuse('too many players from your address');
        game = room.host.game; // a map change replaces the game; this session stays with its own
        client = game.connect(session);
        if (!client) return sessionsByAddress.remove(session.address); // full: connect closed it
        joining = room;
      }
      game.receive(client, bytes);
      if (joining && client.joined) { // (a refused HELLO, a bad password or a ban, joins nothing)
        rooms.joined(joining, client);
        joining = null;
      }
    },
    onClose() {
      if (!client) return;
      sessionsByAddress.remove(session.address);
      if (client.joined) console.log(`player ${client.id} "${client.name}" left`);
      game.disconnect(client);
    },
  };
});

// The self-signed certificate lives 13 days (browsers pin none valid longer), checked only at
// startup: a server up longer served an expired one and every Play failed. ensureCert makes a
// new one 12 days in; it goes to new connections and connect.json.
if (!TLS_CERT) {
  setInterval(async () => {
    try {
      const fresh = await ensureCert(fileURLToPath(new URL('certs', ROOT)), HOSTNAMES);
      if (renewCert(certInfo, fresh, transport)) console.log('webtransport: certificate renewed');
    } catch (err) {
      console.warn('webtransport: certificate renewal failed:', err.message);
    }
  }, 6 * 3600e3);
}

// Fixed-rate loops (runDue), one per room.
let sweptAt = 0;
function loop() {
  const now = performance.now();
  let next = now + 1000 / TICK_RATE;
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
// multi-megabyte map are not downloaded again), and gzipped for the types that shrink
// (scripts ~4x, maps ~3x; Deno.serve does not compress a file stream by itself), once per
// version of a file: CompressionStream runs on this thread, and compressing on every
// download stalled every game 0.2-0.6 s a map.
const COMPRESSED = new Set(['html', 'js', 'json', 'css', 'bsp', 'cfg', 'svg']);
const gzipCache = new Map(); // relative path -> { etag, bytes: Promise<Uint8Array> }
function gzipped(rel, path, etag) {
  let hit = gzipCache.get(rel);
  if (!hit || hit.etag !== etag) {
    hit = { etag, bytes: Deno.open(path).then((f) => new Response(f.readable.pipeThrough(new CompressionStream('gzip'))).bytes()) };
    gzipCache.set(rel, hit);
    hit.bytes.catch(() => gzipCache.get(rel) === hit && gzipCache.delete(rel));
  }
  return hit.bytes;
}
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
      // Cross-origin isolated pages and workers: practice's shared-memory rings need it
      // (client/ring.js); everything the pages load is our own, so nothing is blocked.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    };
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    if (COMPRESSED.has(ext) && /\bgzip\b/.test(req.headers.get('accept-encoding') || '')) {
      headers['content-encoding'] = 'gzip';
      return new Response(await gzipped(rel, path, etag), { headers });
    }
    headers['content-length'] = String(stat.size);
    return new Response((await Deno.open(path, { read: true })).readable, { headers });
  } catch {
    return null;
  }
}

const tls = TLS_CERT ? { cert: certInfo.cert, key: certInfo.key } : {};

// POST /rooms?file=<name>&mode=<mode>&players=<n>&difficulty=<0-3>&armoury=<0|1>&listed=<0|1>, the map
// file as the body and the join password, if any, URI-encoded in the `x-room-password` header (the body
// is the file, and the address would put it in the logs): a new room; answers its code, the map name,
// the room's rcon password (the uploader's console uses it) and the room console's catalog (the
// console's suggestions).
async function createRoom(req, url, address) {
  try {
    const q = url.searchParams;
    let password = req.headers.get('x-room-password') || '';
    try { // a header holds only Latin-1
      password = decodeURIComponent(password);
    } catch {
      // not encoded: as it is
    }
    const room = await rooms.upload((max, ms) => readBody(req, max, ms), {
      fileName: q.get('file') || '', mode: q.get('mode') || 'competitive', players: +q.get('players') || 0,
      difficulty: +(q.get('difficulty') ?? 1), armoury: q.get('armoury') !== '0', listed: q.get('listed') === '1',
      password, address,
    });
    return Response.json({ code: room.code, map: room.name, rcon: room.rcon, names: room.host.con.catalog() });
  } catch (err) {
    if (!(err instanceof RoomError)) console.warn('room upload failed:', err);
    return Response.json({ error: err instanceof RoomError ? err.message : 'the upload failed' },
      { status: err instanceof RoomError ? err.status : 500 });
  }
}

// POST /rooms with a JSON body { map, mode, players, difficulty, armoury, listed, password }: a
// new room on one of the server's maps (the admin page's new room); answers as createRoom.
// JSON, not the query: the join password stays out of the address and the logs.
async function openRoom(req, address) {
  try {
    let o;
    try {
      o = JSON.parse(new TextDecoder().decode(await readBody(req, 4096, 10000, 'the request is too large')));
    } catch (err) {
      if (err instanceof RoomError) throw err;
      throw new RoomError('the request is not JSON');
    }
    if (!o || typeof o !== 'object') throw new RoomError('the request is not a room');
    const room = rooms.open(String(o.map || ''), {
      mode: String(o.mode || 'competitive'), players: +o.players || 0, difficulty: +(o.difficulty ?? 1),
      armoury: o.armoury !== false, listed: o.listed === true, password: String(o.password || ''), address,
    });
    return Response.json({ code: room.code, map: room.name, rcon: room.rcon, names: room.host.con.catalog() });
  } catch (err) {
    if (!(err instanceof RoomError)) console.warn('room failed:', err);
    return Response.json({ error: err instanceof RoomError ? err.message : 'the room could not be made' },
      { status: err instanceof RoomError ? err.status : 500 });
  }
}

async function serveRoomMap(room, req) {
  // A server map: the room's current one from maps/ (it may have changed level since).
  if (!room.bytes) return (await serveStatic(`/maps/${room.host.game.mapName}.bsp`, req)) || new Response('no map', { status: 404 });
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
    const room = rooms.get(code);
    if (!room) {
      return Response.json({ error: code ? 'no such room: it may have closed' : 'this server plays in rooms (/rooms.json)' },
        { status: 404 });
    }
    // upload: the room plays a map its host brought (a demo of it cannot be played back by name)
    return Response.json({ port: GAME_PORT, certHash, ...room.host.info(), room: room.code, upload: !!room.bytes });
  }
  if (pathname === '/rooms' && req.method === 'POST') {
    // Our pages send the map as application/octet-stream and a server map's room as
    // application/json, types that need a CORS preflight this server never answers: any other
    // site's page could make its visitors upload rooms.
    const type = req.headers.get('content-type') || '';
    if (/^application\/json\b/.test(type)) return openRoom(req, info.remoteAddr.hostname);
    if (type !== 'application/octet-stream') {
      return Response.json({ error: 'send the map as application/octet-stream' }, { status: 415 });
    }
    return createRoom(req, url, info.remoteAddr.hostname);
  }
  if (pathname === '/rooms.json') { // the listed rooms, and how many of the server's are taken
    return Response.json({ rooms: rooms.list(), live: rooms.rooms.size, max: rooms.limits.rooms });
  }
  const roomMap = /^\/rooms\/([a-z0-9]+)\/map\.bsp$/.exec(pathname);
  if (roomMap) {
    const room = rooms.get(roomMap[1]);
    return room ? serveRoomMap(room, req) : new Response('no such room', { status: 404 });
  }
  if (pathname === '/maps.json') return Response.json(listMaps()); // practice and new rooms
  if (pathname === '/admin' || pathname === '/admin/') { // the admin page itself (its calls are under /admin/)
    return (await serveStatic('/client/admin.html', req)) || new Response('not found', { status: 404 });
  }
  if (pathname.startsWith('/admin/')) { // the admin page's calls (client/admin.html)
    return adminResponse(req, url, { address: info.remoteAddr.hostname, hostFor: (code) => rooms.get(code)?.host ?? null });
  }
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
  `   ${TICK_RATE} tick   rooms only`);
