// Rooms: bring your own map. A player uploads a .bsp (POST /rooms) and gets a code; the
// server runs a game of its own on that map (a Host like the main one, with bots), friends
// join with the code (`?room=` in the link, the code in HELLO). The map is held in memory
// only: never written to disk, served to the room's players from memory, and dropped with
// the room once nobody has played in it for a while.
//
// The file is untrusted: parseUntrustedBSP checks it before any engine part sees it, and
// the room's game is built (navigation, overview data, a first tick) before the code goes
// out, so a map that cannot run is refused at the upload. Limits keep one person or many
// from filling the server: rooms in all, live rooms and uploads per address, the file size.

import { parseUntrustedBSP, mapNameOf } from '../shared/bsp.js';
import { Writer, writeReject } from '../shared/protocol.js';
import { Host, addressKey } from './host.js';
import { modeNamed } from '../shared/modes.js';

export const ROOM_LIMITS = {
  rooms: 8, // live rooms on the server
  bytes: 24 << 20, // the largest map file taken
  perAddress: 1, // live rooms one address may have
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
  //       random() -> [0, 1) (codes and rcon passwords; tests seed it)
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
  // listed (in list(): anyone on the server sees it; else only those with the code),
  // address (the uploader's).
  // Returns the room; throws a RoomError when refused.
  create(bytes, { fileName = '', mode = 'competitive', players = 0, difficulty = 1, armoury = true, listed = false, address = '' } = {}) {
    const L = this.limits, now = this.now(), key = addressKey(address);
    if (bytes.byteLength > L.bytes) throw new RoomError(`the map is too large (${L.bytes >> 20} MB at most)`, 413);
    this.check(address);
    this.lastUpload.set(key, now);
    const row = modeNamed(mode);
    if (row.name !== mode) throw new RoomError(`unknown mode: ${mode}`);

    let bsp;
    try {
      bsp = parseUntrustedBSP(bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer);
    } catch (err) {
      throw new RoomError(`not a map this game can play: ${err.message}`);
    }
    const name = mapNameOf(fileName);
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const rcon = Array.from({ length: 16 }, () => Math.floor(this.random() * 16).toString(16)).join('');
    const host = new Host({
      loadMap: (n) => {
        if (n !== name) throw new Error(`this room only has ${name}`);
        return bsp;
      },
      listMaps: () => [name],
      // Only the mode cfgs (exec in a room's rcon must not read the server's own cfgs).
      readCfg: (n) => (/^gamemode_[a-z]+(_server)?\.cfg$/.test(n) && this.opts.readCfg ? this.opts.readCfg(n) : null),
      print: (s) => console.log(`[room ${code}] ${s}`),
      now: this.opts.now,
      mapGapMs: L.cooldownMs,
    });
    const [type, gameMode] = row.key.split('/');
    host.con.exec(`game_type ${type}; game_mode ${gameMode}; bot_difficulty ${Math.max(0, Math.min(3, difficulty | 0))}; ` +
      `mp_armoury_entities ${armoury ? 1 : 0}`);
    host.hostname.set(`Room ${code}`);
    host.password.set(rcon);
    try {
      host.start(name);
      host.game.bots.ensureNav();
      host.game.step(); // not Host.step: it logs a tick that throws and goes on
    } catch (err) {
      throw new RoomError(`the map does not run: ${err.message}`);
    }
    const room = {
      code, name, host, rcon, bytes, gzip: null, address: key, mode, listed: !!listed,
      players: Math.max(0, Math.min(20, players | 0)), // bots come in with the first player
      created: now, emptySince: null, joined: false,
      epoch: performance.now(), // the room's own tick clock (server/main.js)
    };
    this.rooms.set(code, room);
    console.log(`room ${code}: ${name} (${mode}, ${(bytes.byteLength / 1048576).toFixed(1)} MB) for ${key || 'local'}`);
    return room;
  }

  // Throws a RoomError when `address` may not make a room now: the server's rooms are taken,
  // it hosts one already, or it uploaded a moment ago. Run before an upload is read too
  // (server/main.js: reading 24 MB first let parallel uploads fill the memory).
  check(address) {
    const L = this.limits, key = addressKey(address);
    if (this.rooms.size >= L.rooms) throw new RoomError('every room on this server is taken: try again later', 503);
    if ([...this.rooms.values()].filter((r) => r.address === key).length >= L.perAddress) {
      throw new RoomError('you already host a room: close it first (quit it and wait for it to empty)', 429);
    }
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
    return [...this.rooms.values()].filter((r) => r.listed).map((r) => ({ room: r.code, ...r.host.info() }));
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
