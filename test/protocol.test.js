import assert from 'node:assert/strict';
import { IN_FORWARD, IN_ATTACK } from '../shared/constants.js';
import { Player, TEAM_CT } from '../shared/player.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, MAX_DATAGRAM, CMD_REDUNDANCY, C2S_HELLO, C2S_CMDS, S2C_WELCOME, S2C_SNAPSHOT, Writer, Reader,
  CmdRing, SnapshotRing, OwnState, writeHello, readHello, writeWelcome, readWelcome, writeCmds, readCmds,
  writeSnapshot, readSnapshot, quantizePitch, dequantizePitch, quantizeYaw, dequantizeYaw, E_ACTIVE, E_X, E_Y, E_Z,
  E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS, E_FIELDS, ANIM_RELOAD, ANIM_HELMET,
  RoundState, EventList, writeChat, readChat, cleanChat, S2C_CHAT, CHAT_CONSOLE, CHAT_TEAM, CHAT_DEAD, CHAT_MAX,
  writeInfo, readInfo, writeReport, readReport, S2C_INFO, S2C_REPORT, NO_MVP, cleanName, NAME_BYTES,
} from '../shared/protocol.js';

Deno.test('chat round-trip, and the server cleans a line before sending it', () => {
  const w = new Writer(), r = new Reader();
  r.set(writeChat(w, 7, CHAT_TEAM | CHAT_DEAD, 'rush b: no stop'));
  assert.equal(r.u8v(), S2C_CHAT);
  assert.deepEqual(readChat(r), { sender: 7, flags: CHAT_TEAM | CHAT_DEAD, text: 'rush b: no stop' });
  r.set(writeChat(w, CHAT_CONSOLE, 0, 'héllo wörld'));
  r.u8v();
  assert.equal(readChat(r).text, 'héllo wörld', 'UTF-8');
  assert.equal(cleanChat('  hi\nthere \x07 '), 'hi there', 'line breaks and control characters become spaces, trimmed');
  assert.equal(cleanChat('x'.repeat(300)).length, CHAT_MAX);
  assert.equal(cleanChat('\n\t'), '', 'nothing left: nothing to send');
});

Deno.test('hello and welcome round-trip', () => {
  const w = new Writer(), r = new Reader();
  r.set(writeHello(w, 2, 7, 3, 'gabe', 'abc234', 'pw'));
  assert.equal(r.u8v(), C2S_HELLO);
  assert.deepEqual(readHello(r), { version: PROTOCOL_VERSION, team: 2, primary: 7, secondary: 3, name: 'gabe', room: 'abc234', password: 'pw' });
  r.set(writeWelcome(w, 5, 123456, 64, 'de_dust2'));
  assert.equal(r.u8v(), S2C_WELCOME);
  assert.deepEqual(readWelcome(r), { version: PROTOCOL_VERSION, playerId: 5, serverTick: 123456, tickRate: 64, map: 'de_dust2' });
});

Deno.test('command redundancy survives dropped datagrams', () => {
  const client = new CmdRing(), server = new CmdRing(), w = new Writer(), r = new Reader();
  for (let t = 1; t <= 40; t++) {
    client.put(t, t & 1 ? IN_FORWARD : IN_ATTACK, -1, t * 0.5, 360 - t);
    const bytes = writeCmds(w, 77, client, t);
    if (t % 3 === 0 || t === 20 || t === 21) continue; // lost
    r.set(bytes);
    assert.equal(r.u8v(), C2S_CMDS);
    assert.equal(readCmds(r, server, 0), 77);
  }
  for (let t = 1; t <= 40; t++) {
    assert.ok(server.has(t), `command ${t} lost`);
    const k = t & server.mask;
    assert.equal(server.buttons[k], t & 1 ? IN_FORWARD : IN_ATTACK);
    assert.equal(server.pitch[k], Math.fround(t * 0.5));
  }
  assert.equal(writeCmds(w, 0, client, 40).length, 6 + CMD_REDUNDANCY * 21);
});

Deno.test('angle quantization round-trips within 0.01 degrees', () => {
  for (const p of [-89, -10.5, 0, 33.3, 89]) assert.ok(Math.abs(dequantizePitch(quantizePitch(p)) - p) < 0.01);
  for (const y of [0, 90, 179.99, 359.99, -45, 725]) {
    const back = dequantizeYaw(quantizeYaw(y));
    const want = ((y % 360) + 360) % 360;
    assert.ok(Math.abs(back - want) < 0.01 || Math.abs(back - want) > 359.99, `${y} -> ${back}`);
  }
});

function fillRow(ring, k, id, x) {
  const r = ring.row(k, id), E = ring.ents;
  E[r + E_ACTIVE] = 1;
  E[r + E_X] = x;
  E[r + E_Y] = id * 10;
  E[r + E_Z] = -50.5;
  E[r + E_PITCH] = quantizePitch(5);
  E[r + E_YAW] = quantizeYaw(id * 15);
  E[r + E_FLAGS] = 1;
  E[r + E_DUCK] = 0;
  E[r + E_WEAPON] = 5;
  E[r + E_HEALTH] = 100;
  E[r + E_TEAM] = 1 + (id & 1);
  E[r + E_ANIM] = ANIM_HELMET;
  E[r + E_SHOTS] = id;
}

Deno.test('snapshots: full, then small deltas, removals and the breakable mask', () => {
  const server = new SnapshotRing(), client = new SnapshotRing(), own = new OwnState();
  const w = new Writer(), r = new Reader();
  const player = new Player();
  player.team = TEAM_CT;
  player.health = 87;
  player.ps.f[0] = 123.25;
  const ownInfo = { lastCmd: 999, spawnYaw: 90, player };

  // Full snapshot with every slot filled is the worst case: it must fit a datagram.
  let k = server.claim(1);
  for (let id = 0; id < MAX_PLAYERS; id++) fillRow(server, k, id, id * 100);
  server.broken.fill(0xffffffff, k * 8, k * 8 + 8);
  const rs = new RoundState();
  rs.round = 1;
  rs.serial = 201;
  const full = writeSnapshot(w, server, k, -1, 0, ownInfo, null, rs);
  assert.ok(full.length <= MAX_DATAGRAM, `full snapshot is ${full.length} bytes`);
  r.set(full);
  assert.equal(r.u8v(), S2C_SNAPSHOT);
  const c1 = readSnapshot(r, client, own);
  assert.ok(c1 >= 0);
  assert.equal(own.lastCmd, 999);
  assert.deepEqual([own.round.round, own.round.serial], [1, 201], 'the round and its start count');
  assert.equal(own.health, 87);
  assert.equal(own.team, TEAM_CT);
  assert.equal(own.psF[0], 123.25);
  for (let id = 1; id < MAX_PLAYERS; id++) {
    for (let f = 0; f < E_FIELDS; f++) {
      assert.equal(client.ents[client.row(c1, id) + f], server.ents[server.row(k, id) + f], `id ${id} field ${f}`);
    }
  }
  assert.equal(client.ents[client.row(c1, 0) + E_ACTIVE], 0, 'own row is not sent');

  // Next tick: one player moved, one left. Delta against the acked snapshot 1.
  const base = k;
  k = server.claim(2);
  server.ents.copyWithin(k * MAX_PLAYERS * E_FIELDS, base * MAX_PLAYERS * E_FIELDS, (base + 1) * MAX_PLAYERS * E_FIELDS);
  server.broken.copyWithin(k * 8, base * 8, base * 8 + 8);
  server.ents[server.row(k, 3) + E_X] += 4;
  server.ents.fill(0, server.row(k, 7), server.row(k, 7) + E_FIELDS);
  const delta = writeSnapshot(w, server, k, base, 0, ownInfo);
  // header 14 + round 12 + bomb 1 + movers 1 + own block (8 + money 3 + state) + 2 entries (moved: 2 + 12
  // bytes, removed: 2 bytes) + 2 empty event lists
  // (the weapon state: a field bitmask, then the fields that are not zero)
  const wsLength = Math.ceil(player.ws.f.length / 8) + 8 * player.ws.f.filter((v) => !Object.is(v, 0)).length;
  assert.equal(delta.length, 14 + 12 + 1 + 1 + 8 + 6 + player.psBytes.length + wsLength + 1 + 14 + 2 + 2);
  r.set(delta);
  r.u8v();
  const c2 = readSnapshot(r, client, own);
  assert.ok(c2 >= 0);
  assert.equal(client.ents[client.row(c2, 3) + E_X], 304);
  assert.equal(client.ents[client.row(c2, 7) + E_ACTIVE], 0);
  assert.equal(client.ents[client.row(c2, 8) + E_X], 800, 'unchanged rows carried over from the base');
  assert.equal(client.broken[c2 * 8 + 5], 0xffffffff, 'mask carried over from the base');
  for (const f of [E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS]) {
    assert.equal(client.ents[client.row(c2, 3) + f], server.ents[server.row(k, 3) + f]);
  }

  // Reloading and one shot: only the 3-byte anim block goes out for that player.
  const k4 = server.claim(4);
  server.ents.copyWithin(server.row(k4, 0), server.row(k, 0), server.row(k, 0) + MAX_PLAYERS * E_FIELDS);
  server.ents[server.row(k4, 3) + E_ANIM] |= ANIM_RELOAD;
  server.ents[server.row(k4, 3) + E_SHOTS] = 4;
  const anim = writeSnapshot(w, server, k4, k, 0, ownInfo);
  r.set(anim);
  r.u8v();
  const c4 = readSnapshot(r, client, own);
  assert.equal(client.ents[client.row(c4, 3) + E_ANIM], ANIM_HELMET | ANIM_RELOAD);
  assert.equal(client.ents[client.row(c4, 3) + E_SHOTS], 4);

  // A delta against a base the client never got cannot be decoded.
  const k3 = server.claim(3);
  const orphan = writeSnapshot(w, server, k3, server.claim(40), 0, ownInfo);
  r.set(orphan);
  r.u8v();
  assert.equal(readSnapshot(r, client, own), -1);
});

Deno.test('info carries the MVP counts; the damage report round-trips; the round block carries the MVP', () => {
  const w = new Writer(), r = new Reader();
  const players = new Array(MAX_PLAYERS).fill(null);
  players[2] = { team: 2, name: 'ann', kills: 3, deaths: 1, score: 0, mvps: 2 };
  players[5] = { team: 3, name: 'bob', kills: 0, deaths: 4, score: 0, mvps: 0 };
  r.set(writeInfo(w, players));
  assert.equal(r.u8v(), S2C_INFO);
  const names = new Array(MAX_PLAYERS).fill(''), teams = new Uint8Array(MAX_PLAYERS), kills = new Int32Array(MAX_PLAYERS);
  const deaths = new Int32Array(MAX_PLAYERS), scores = new Int32Array(MAX_PLAYERS), mvps = new Int32Array(MAX_PLAYERS);
  readInfo(r, names, teams, kills, deaths, scores, mvps);
  assert.deepEqual([names[2], kills[2], mvps[2], names[5], mvps[5]], ['ann', 3, 2, 'bob', 0]);
  const rows = [{ id: 5, given: 127, givenHits: 4, taken: 0, takenHits: 0 }, { id: 9, given: 0, givenHits: 0, taken: 100, takenHits: 3 }];
  r.set(writeReport(w, 7, rows));
  assert.equal(r.u8v(), S2C_REPORT);
  assert.deepEqual(readReport(r), { round: 7, rows });
  const rs = new RoundState();
  assert.equal(rs.mvp, NO_MVP);
});

// Names are cut by UTF-8 bytes at a character, not by UTF-16 units: 16 players named with
// 31 emoji-ish characters overflowed INFO and the server's tick threw before snapshots.
Deno.test('names: control characters out, at most NAME_BYTES bytes, a full server fits INFO', () => {
  const enc = new TextEncoder();
  const emoji = String.fromCodePoint(0x1f600).repeat(20);
  assert.equal(cleanName(emoji), String.fromCodePoint(0x1f600).repeat(7), 'whole characters only');
  assert.equal(cleanName('  ann' + String.fromCharCode(10) + 'bind x' + String.fromCharCode(27) + '[31m '), 'ann bind x [31m');
  assert.equal(cleanName('x'.repeat(40)), 'x'.repeat(31));
  const w = new Writer(), players = [];
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const name = cleanName(emoji + 'abc');
    assert.ok(enc.encode(name).length <= NAME_BYTES);
    players.push({ team: 2, name, kills: 65535, deaths: 65535, score: 65535, mvps: 255 });
  }
  assert.ok(writeInfo(w, players).length <= MAX_DATAGRAM);
});

// The worst case: every player's full row, a weapon state with 32 fields set (a rifle firing
// with every slot and four grenades: planting, throwing and scoping exclude each other; all 48
// would not fit even with no movers), 16 kills and 64 shots, and all 64 movers away from rest. The writer ran past the datagram and threw, so
// that tick went out to nobody; movers past the room are left out, kills and shots fit.
Deno.test('snapshots: the busiest tick still fits a datagram and decodes', () => {
  const server = new SnapshotRing(), own = new OwnState(), ev = new EventList();
  const w = new Writer(), r = new Reader(), player = new Player();
  const k = server.claim(1);
  for (let id = 0; id < MAX_PLAYERS; id++) fillRow(server, k, id, id * 100);
  for (let i = 0; i < 64; i++) ev.addShot(1, 0, 1, 2, 3, 0, 0, 1, 0);
  for (let i = 0; i < 16; i++) ev.addKill(i, 1, 2, 3, 0, 1);
  const n = 64, doors = {
    count: n, idle: () => false, leg: new Uint8Array(n).fill(1), goal: new Float32Array(n).fill(0.5),
    dir: new Int8Array(n).fill(1), sign: new Int8Array(n).fill(1), from: new Float32Array(n), t0: new Int32Array(n),
  };
  for (const fields of [32, 0]) {
    player.ws.f.fill(0).fill(1, 0, fields);
    const bytes = writeSnapshot(w, server, k, -1, 0, { lastCmd: 1, spawnYaw: 0, player, hurtRecent: true, hurtSerial: 1, hurtFrom: [1, 2, 3] }, ev, new RoundState(), undefined, doors);
    assert.ok(bytes.length <= MAX_DATAGRAM, `${bytes.length} bytes`);
    r.set(bytes);
    r.u8v();
    assert.ok(readSnapshot(r, new SnapshotRing(), own, new EventList()) >= 0);
    assert.ok(own.movers.count > 0, 'movers fill what is left');
  }
});
