// Rooms: the server's games. A player uploads a .bsp (POST /rooms) or picks one of the
// server's maps (the admin page's new room, a JSON POST /rooms) and gets a code; the server
// runs a game of its own on that map (a Host, as practice runs in the page, with bots),
// friends join with the code (`?room=` in the link, the code in HELLO). An uploaded map is
// held in memory only: never written to disk, served to the room's players from memory, and
// dropped with the room once nobody has played in it for a while.
//
// The file is untrusted: parseUntrustedBSP checks it before any engine part sees it, and
// the room's game is built (navigation, overview data, a first tick) before the code goes
// out, so a map that cannot run is refused at the upload. Limits keep one person or many
// from filling the server: rooms in all, live rooms and uploads per address, the file size.

import { parseUntrustedBSP, mapNameOf } from '../shared/bsp.js';
import { Writer, writeReject } from '../shared/protocol.js';
import { Host, addressKey, PASSWORD_BYTES } from './host.js';
import { modeNamed } from '../shared/modes.js';

export const ROOM_LIMITS = {
  rooms: 8, // live rooms on the server
  bytes: 24 << 20, // the largest map file taken
  perAddress: 1, // live rooms one address keeps: a new one replaces its oldest
  cooldownMs: 30000, // between two uploads from one address
  idleMs: 2 * 60000, // a room closes this long after its last player left
  unusedMs: 10 * 60000, // ... or after its upload when nobody ever joined
  uploads: 2, // uploads being read at once (each is held in memory until it is checked)
  uploadMs: 120000, // an upload must arrive within this
};
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
const CODE_LENGTH = 6;

// A refused upload: the message is for the uploader, status the HTTP status.
export class RoomError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Rooms {
  // opts: readCfg(name) (the mode cfgs), limits (ROOM_LIMITS overrides), now() -> ms,
  //       random() -> [0, 1) (codes and rcon passwords; tests seed it),
  //       maps: { loadMap(name), listMaps() } (the server's own maps, for open)
  constructor(opts = {}) {
    this.opts = opts;
    this.limits = { ...ROOM_LIMITS, ...opts.limits };
    this.now = opts.now || (() => performance.now());
    this.random = opts.random || (() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32);
    this.rooms = new Map(); // code -> room
    this.lastUpload = new Map(); // address key -> ms
    this.uploading = new Set(); // address keys whose upload is being read (server/main.js)
  }

  get(code) {
    return this.rooms.get(String(code || '').toLowerCase()) || null;
  }

  // A new room for `bytes` (the map file). opts: fileName, mode (a GAME_MODES name),
  // players (bot_quota fill: bots make up the rest), difficulty, armoury (mp_armoury_entities),
  // listed (sv_listed: in list(), anyone on the server sees it; else only those with the code),
  // password (sv_password, '' none), address (the uploader's).
  create(bytes, opts = {}) {
    const L = this.limits;
    if (bytes.byteLength > L.bytes) throw new RoomError(`the map is too large (${L.bytes >> 20} MB at most)`, 413);
    const row = this.admit(opts);
    let bsp;
    try {
      bsp = parseUntrustedBSP(bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer);
    } catch (err) {
      throw new RoomError(`not a map this game can play: ${err.message}`);
    }
    const name = mapNameOf(opts.fileName || '');
    const maps = {
      loadMap: (n) => {
        if (n !== name) throw new Error(`this room only has ${name}`);
        return bsp;
      },
      listMaps: () => [name],
    };
    return this.build(name, maps, bytes, row, opts);
  }

  // A new room on one of the server's own maps (opts.maps of the constructor: its loadMap and
  // listMaps); it may change to any of them later. opts as create's, without fileName.
  open(map, opts = {}) {
    const maps = this.opts.maps;
    if (!maps) throw new RoomError('this server makes rooms only on maps players bring', 404);
    if (!/^[\w-]+$/.test(map) || !maps.listMaps().includes(map)) throw new RoomError(`there is no map ${map} on this server`);
    const row = this.admit(opts);
    return this.build(map, maps, null, row, opts);
  }

  // The checks before a room is made (check, then the address's cooldown starts), and its
  // mode's row.
  admit(opts) {
    this.check(opts.address);
    this.lastUpload.set(addressKey(opts.address), this.now());
    const mode = opts.mode || 'competitive', row = modeNamed(mode);
    if (row.name !== mode) throw new RoomError(`unknown mode: ${mode}`);
    if (new TextEncoder().encode(opts.password || '').length > PASSWORD_BYTES) {
      throw new RoomError(`the password is too long (${PASSWORD_BYTES} bytes at most)`);
    }
    return row;
  }

  // Builds the room's game on `name` (maps: its loadMap and listMaps; bytes: the uploaded file
  // the players download, null for a server map, served from maps/) and runs a first tick.
  build(name, maps, bytes, row, { players = 0, difficulty = 1, armoury = true, listed = false, password = '', address = '' }) {
    const L = this.limits, now = this.now(), key = addressKey(address);
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const rcon = Array.from({ length: 16 }, () => Math.floor(this.random() * 16).toString(16)).join('');
    const host = new Host({
      ...maps,
      // Only the mode cfgs and their _server overrides (exec in a room's rcon reads no other file).
      readCfg: (n) => (/^gamemode_[a-z_]+\.cfg$/.test(n) && this.opts.readCfg ? this.opts.readCfg(n) : null),
      print: (s) => console.log(`[room ${code}] ${s}`),
      now: this.opts.now,
      mapGapMs: L.cooldownMs,
    });
    const [type, gameMode, flags = 0] = row.key.split('/'); // (32: the short match)
    host.con.exec(`game_type ${type}; game_mode ${gameMode}; sv_game_mode_flags ${flags}; bot_difficulty ${Math.max(0, Math.min(3, difficulty | 0))}; ` +
      `mp_armoury_entities ${armoury ? 1 : 0}`);
    host.hostname.set(`Room ${code}`);
    host.password.set(rcon);
    host.joinPassword.set(password || '');
    host.con.cvar('sv_listed', listed ? 1 : 0, { help: 'The room shows in Play Online\'s list (0: only its link brings players in)', min: 0, max: 1 });
    try {
      host.start(name);
      host.game.bots.ensureNav();
      host.game.step(); // not Host.step: it logs a tick that throws and goes on
    } catch (err) {
      throw new RoomError(`the map does not run: ${err.message}`);
    }
    const room = {
      code, name, host, rcon, bytes, gzip: null, address: key, mode: row.name,
      players: Math.max(0, Math.min(20, players | 0)), // bots come in with the first player
      created: now, emptySince: null, joined: false,
      epoch: performance.now(), // the room's own tick clock (server/main.js)
    };
    // The address's older rooms past perAddress go, oldest first, only now that the new one
    // runs (a host who closed the browser left one behind and could not make another).
    const old = this.mine(key);
    for (const r of old.slice(0, Math.max(0, old.length - (L.perAddress - 1)))) this.close(r, 'its host made a new room');
    this.rooms.set(code, room);
    console.log(`room ${code}: ${name} (${row.name}${bytes ? `, ${(bytes.byteLength / 1048576).toFixed(1)} MB` : ', a server map'}) for ${key || 'local'}`);
    return room;
  }

  // The rooms an address key made, oldest first.
  mine(key) {
    return [...this.rooms.values()].filter((r) => r.address === key);
  }

  // Throws a RoomError when `address` may not make a room now: the server's rooms are taken
  // (not counting the address's own ones the new room will replace, build) or it made one a
  // moment ago. Run before an upload is read too (server/main.js: reading 24 MB first let
  // parallel uploads fill the memory).
  check(address) {
    const L = this.limits, key = addressKey(address);
    const replaced = Math.max(0, this.mine(key).length - (L.perAddress - 1));
    if (this.rooms.size - replaced >= L.rooms) throw new RoomError('every room on this server is taken: try again later', 503);
    if (this.now() - (this.lastUpload.get(key) ?? -Infinity) < L.cooldownMs) {
      throw new RoomError('one upload at a time: try again in a few seconds', 429);
    }
  }

  // Reads an upload with `read(maxBytes, ms)` (the request body) once `check` passes, one
  // at a time per address and `limits.uploads` in all, then makes its room (create).
  async upload(read, opts) {
    const L = this.limits, key = addressKey(opts.address);
    this.check(opts.address);
    if (this.uploading.has(key)) throw new RoomError('one upload at a time: try again in a few seconds', 429);
    if (this.uploading.size >= L.uploads) throw new RoomError('the server is busy with other uploads: try again in a minute', 503);
    this.uploading.add(key);
    let bytes;
    try {
      bytes = await read(L.bytes, L.uploadMs);
    } finally {
      this.uploading.delete(key);
    }
    return this.create(bytes, opts);
  }

  // A player's session joined `room` (the bots fill in once the first one is there).
  joined(room) {
    room.emptySince = null;
    if (!room.joined) {
      room.joined = true;
      if (room.players) room.host.con.exec(`bot_quota_mode fill; bot_quota ${room.players}`);
    }
  }

  // The listed rooms as the Play panel shows them (/rooms.json): each one's connect.json.
  list() {
    return [...this.rooms.values()].filter((r) => r.host.con.get('sv_listed').bool).map((r) => ({ room: r.code, ...r.host.info() }));
  }

  humans(room) {
    return room.host.game.clients.filter((c) => c && !c.bot).length;
  }

  // Closes rooms nobody plays in any more (call it now and then).
  sweep() {
    const now = this.now(), L = this.limits;
    for (const [key, at] of this.lastUpload) if (now - at >= L.cooldownMs) this.lastUpload.delete(key); // it only grew
    for (const room of [...this.rooms.values()]) {
      if (this.humans(room) > 0) {
        room.emptySince = null;
        continue;
      }
      if (room.emptySince === null) room.emptySince = now;
      const unused = !room.joined && now - room.created > L.unusedMs;
      if (unused || (room.joined && now - room.emptySince > L.idleMs)) this.close(room, 'the room closed');
    }
  }

  close(room, reason) {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    const w = new Writer();
    for (const c of room.host.game.clients) {
      if (!c || c.bot) continue;
      c.session.send(writeReject(w, reason).slice());
      c.session.close(reason);
    }
    console.log(`room ${room.code} closed`);
  }

  // The map file gzipped, made once on first request.
  async gzipped(room) {
    if (!room.gzip) {
      room.gzip = new Response(new Blob([room.bytes]).stream().pipeThrough(new CompressionStream('gzip')))
        .arrayBuffer().then((b) => new Uint8Array(b));
    }
    return await room.gzip;
  }
}
