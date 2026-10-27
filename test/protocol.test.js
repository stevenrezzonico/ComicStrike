import assert from 'node:assert/strict';
import { IN_FORWARD, IN_ATTACK } from '../shared/constants.js';
import { Player, TEAM_CT } from '../shared/player.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, MAX_DATAGRAM, CMD_REDUNDANCY, C2S_HELLO, C2S_CMDS, S2C_WELCOME, S2C_SNAPSHOT, Writer, Reader,
  CmdRing, SnapshotRing, OwnState, writeHello, readHello, writeWelcome, readWelcome, writeCmds, readCmds,
  writeSnapshot, readSnapshot, quantizePitch, dequantizePitch, quantizeYaw, dequantizeYaw, E_ACTIVE, E_X, E_Y, E_Z,
  E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_FIELDS,
} from '../shared/protocol.js';

Deno.test('hello and welcome round-trip', () => {
  const w = new Writer(), r = new Reader();
  r.set(writeHello(w, 2, 7, 3, 'gabe'));
  assert.equal(r.u8v(), C2S_HELLO);
  assert.deepEqual(readHello(r), { version: PROTOCOL_VERSION, team: 2, primary: 7, secondary: 3, name: 'gabe' });
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
  const full = writeSnapshot(w, server, k, -1, 0, ownInfo);
  assert.ok(full.length <= MAX_DATAGRAM, `full snapshot is ${full.length} bytes`);
  r.set(full);
  assert.equal(r.u8v(), S2C_SNAPSHOT);
  const c1 = readSnapshot(r, client, own);
  assert.ok(c1 >= 0);
  assert.equal(own.lastCmd, 999);
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
  // header 14 + round 7 + own block (8 + money 3 + state) + 2 entries (moved: 2 + 12 bytes,
  // removed: 2 bytes) + 2 empty event lists
  assert.equal(delta.length, 14 + 7 + 8 + 3 + player.psBytes.length + player.wsBytes.length + 1 + 14 + 2 + 2);
  r.set(delta);
  r.u8v();
  const c2 = readSnapshot(r, client, own);
  assert.ok(c2 >= 0);
  assert.equal(client.ents[client.row(c2, 3) + E_X], 304);
  assert.equal(client.ents[client.row(c2, 7) + E_ACTIVE], 0);
  assert.equal(client.ents[client.row(c2, 8) + E_X], 800, 'unchanged rows carried over from the base');
  assert.equal(client.broken[c2 * 8 + 5], 0xffffffff, 'mask carried over from the base');
  for (const f of [E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM]) {
    assert.equal(client.ents[client.row(c2, 3) + f], server.ents[server.row(k, 3) + f]);
  }

  // A delta against a base the client never got cannot be decoded.
  const k3 = server.claim(3);
  const orphan = writeSnapshot(w, server, k3, server.claim(40), 0, ownInfo);
  r.set(orphan);
  r.u8v();
  assert.equal(readSnapshot(r, client, own), -1);
});
