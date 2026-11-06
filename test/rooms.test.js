// Rooms (server/rooms.js): a game on a map a player uploads, held in memory, with limits.
import assert from 'node:assert/strict';
import { Rooms, RoomError } from '../server/rooms.js';
import { mapNameOf, parseBSP } from '../shared/bsp.js';
import { CollisionWorld } from '../shared/trace.js';
import { FloorGrid, MAX_CELLS, floorFaces } from '../shared/floorgrid.js';
import { Writer, Reader, writeHello, readHello, helloRoom, C2S_HELLO, S2C_WELCOME, S2C_REJECT, readWelcome } from '../shared/protocol.js';
import { TEAM_T } from '../shared/player.js';
import { quiet as quietly } from './harness.js';

const PLAYGROUND = Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url));

function makeRooms(limits = {}) {
  const clock = { ms: 0 };
  let seed = 1;
  const rooms = new Rooms({
    now: () => clock.ms, limits,
    random: () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32,
  });
  return { rooms, clock };
}

// A transport session that keeps what the server sends.
function session() {
  return {
    got: [], closed: '',
    send(bytes) {
      this.got.push(bytes.slice());
    },
    close(reason) {
      this.closed = reason;
    },
  };
}

Deno.test('map names from file names', () => {
  assert.equal(mapNameOf('C:\\maps\\De_Cool Map.BSP'), 'de_cool_map');
  assert.equal(mapNameOf('../../etc/passwd'), 'passwd');
  assert.equal(mapNameOf('!!!.bsp'), 'custom');
  assert.equal(mapNameOf('x'.repeat(80) + '.bsp').length, 31);
});

Deno.test('HELLO carries the room code', () => {
  const w = new Writer();
  const bytes = writeHello(w, TEAM_T, 0, 0, 'ann', 'abc234').slice();
  assert.equal(helloRoom(bytes), 'abc234');
  const r = new Reader().set(bytes);
  assert.equal(r.u8v(), C2S_HELLO);
  assert.equal(readHello(r).name, 'ann');
  assert.equal(helloRoom(writeHello(w, TEAM_T, 0, 0, 'ann').slice()), '', 'no room: the server\'s own game');
  assert.equal(helloRoom(new Uint8Array([2, 0, 0])), null, 'not a HELLO');
});

Deno.test('a room runs the uploaded map, players join it, bots fill in', () => {
  const { rooms } = makeRooms();
  const room = quietly(() => rooms.create(PLAYGROUND, { fileName: 'My Map.bsp', mode: 'deathmatch', players: 4, address: '1.2.3.4' }));
  assert.match(room.code, /^[a-z2-9]{6}$/);
  assert.equal(room.name, 'my_map');
  assert.equal(rooms.get(room.code.toUpperCase()), room, 'codes ignore case');
  assert.equal(room.host.game.mapName, 'my_map');
  assert.equal(room.host.modeName, 'deathmatch');
  assert.equal(room.host.password.value, room.rcon);
  assert.throws(() => room.host.opts.loadMap('de_dust2'), /only has my_map/, 'a room has its map only');
  assert.equal(room.host.opts.readCfg('server.cfg'), null, 'no server cfgs through a room');
  assert.equal(room.host.game.rules.armouryEntities, true, 'the map weapons lie out unless the upload says not');
  const bare = quietly(() => rooms.create(PLAYGROUND, { fileName: 'bare.bsp', armoury: false, address: '9.9.9.9' }));
  assert.equal(bare.host.game.rules.armouryEntities, false);
  rooms.close(bare, 'done');

  const s = session();
  const game = room.host.game;
  const c = game.connect(s);
  rooms.joined(room);
  game.receive(c, writeHello(new Writer(), TEAM_T, 0, 0, 'ann', room.code).slice());
  const welcome = new Reader().set(s.got.at(-1));
  assert.equal(welcome.u8v(), S2C_WELCOME);
  assert.equal(readWelcome(welcome).map, 'my_map');
  quietly(() => {
    for (let t = 0; t < 100; t++) room.host.step(game);
  });
  assert.equal(game.clients.filter((x) => x && x.bot).length, 3, 'bots fill up to 4 players with the first one in');
});

Deno.test('rooms close once empty, or unused; closing tells the players', () => {
  const { rooms, clock } = makeRooms({ idleMs: 1000, unusedMs: 5000, cooldownMs: 0, perAddress: 5 });
  const used = quietly(() => rooms.create(PLAYGROUND, { fileName: 'a.bsp', address: '1.1.1.1' }));
  const unused = quietly(() => rooms.create(PLAYGROUND, { fileName: 'b.bsp', address: '1.1.1.1' }));
  const s = session();
  const c = used.host.game.connect(s);
  rooms.joined(used);
  quietly(() => {
    clock.ms = 4000;
    rooms.sweep();
    assert.ok(rooms.get(used.code) && rooms.get(unused.code), 'both still open');
    used.host.game.disconnect(c);
    clock.ms = 4500;
    rooms.sweep(); // empty from now
    clock.ms = 5200;
    rooms.sweep();
    assert.ok(rooms.get(used.code), 'empty for less than idleMs');
    assert.equal(rooms.get(unused.code), null, 'nobody came within unusedMs');
    clock.ms = 5600;
    rooms.sweep();
    assert.equal(rooms.get(used.code), null, 'empty for idleMs');
  });

  const live = quietly(() => rooms.create(PLAYGROUND, { fileName: 'c.bsp', address: '2.2.2.2' }));
  const t = session();
  live.host.game.connect(t);
  quietly(() => rooms.close(live, 'bye'));
  assert.equal(t.closed, 'bye');
  assert.equal(new Reader().set(t.got.at(-1)).u8v(), S2C_REJECT);
});

Deno.test('uploads are limited: size, rooms, one per address, a cooldown, real maps only', () => {
  const { rooms, clock } = makeRooms({ rooms: 2, bytes: PLAYGROUND.byteLength + 10, cooldownMs: 1000 });
  const refused = (fn, pattern, status) => assert.throws(fn, (e) => e instanceof RoomError && pattern.test(e.message) && e.status === status);
  refused(() => rooms.create(new Uint8Array(PLAYGROUND.byteLength + 11), { address: '1.1.1.1' }), /too large/, 413);
  refused(() => rooms.create(new Uint8Array(4000), { address: '1.1.1.1' }), /not a map/, 400);
  clock.ms += 2000;
  refused(() => rooms.create(PLAYGROUND, { mode: 'quake', address: '1.1.1.1' }), /unknown mode/, 400);
  clock.ms += 2000;
  quietly(() => rooms.create(PLAYGROUND, { address: '1.1.1.1' }));
  clock.ms += 2000;
  refused(() => rooms.create(PLAYGROUND, { address: '1.1.1.1' }), /already host/, 429);
  quietly(() => rooms.create(PLAYGROUND, { address: '2.2.2.2' }));
  refused(() => rooms.create(PLAYGROUND, { address: '3.3.3.3' }), /every room/, 503);
  // IPv6: one /64 is one address.
  const v6 = makeRooms({ cooldownMs: 0 }).rooms;
  quietly(() => v6.create(PLAYGROUND, { address: '2001:db8:1:2::5' }));
  refused(() => v6.create(PLAYGROUND, { address: '2001:db8:1:2::77' }), /already host/, 429);
});

Deno.test('the map file is served gzipped from memory', async () => {
  const { rooms } = makeRooms();
  const room = quietly(() => rooms.create(PLAYGROUND, { address: '1.1.1.1' }));
  const gz = await rooms.gzipped(room);
  assert.ok(gz.byteLength < PLAYGROUND.byteLength);
  const back = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  assert.deepEqual(back, PLAYGROUND);
  assert.equal(await rooms.gzipped(room), gz, 'made once');
});

// An uploaded map may span the whole ±16384 world: its navigation held 1.7 GB and blocked
// every game for seconds. Grids past MAX_CELLS and floods past maxReached are refused
// before that work (a room then reports the map does not run).
Deno.test('a map too big for the navigation is refused before the work', () => {
  const bsp = parseBSP(PLAYGROUND.slice().buffer), world = CollisionWorld.fromBSP(bsp);
  assert.throws(() => new FloorGrid(bsp, world, 24, { bounds: [-16384, -16384, 16384, 16384] }), /too big/);
  assert.ok(Math.ceil(32768 / 24) ** 2 > MAX_CELLS);
  assert.throws(() => new FloorGrid(bsp, world, 24, { maxReached: 100 }), /over 100 places/);
  assert.ok(new FloorGrid(bsp, world, 24).reached.some((r) => r), 'the playground itself is fine');
  // Copies of one big floor face (20 bytes each, all on the same edges) each rasterized every
  // cell again: 100 were a second of building, before any other limit. Real maps: 2.35 a cell.
  const faces = floorFaces(bsp), big = faces.reduce((a, f) => (f.xs.length && area(f) > area(a) ? f : a));
  assert.throws(() => new FloorGrid(bsp, world, 24, { faces: [...faces, ...Array(200).fill(big)] }), /too many floors/);
  // A face of zero width fills no cell, but its every row walks its edges: those rows count.
  const ys = big.ys.map((_y, i) => (i % 2 ? Math.max(...big.ys) : Math.min(...big.ys)));
  const thin = { ...big, xs: big.xs.map(() => big.xs[0]), ys };
  assert.throws(() => new FloorGrid(bsp, world, 24, { faces: [...faces, ...Array(10000).fill(thin)] }), /too many floors/);
});
const area = (f) => (Math.max(...f.xs) - Math.min(...f.xs)) * (Math.max(...f.ys) - Math.min(...f.ys));

// The limits are checked before an upload is read (reading 24 MB first let parallel uploads
// fill the server's memory): one upload being read per address, `uploads` in all.
Deno.test('uploads are refused before their body is read', async () => {
  const { rooms, clock } = makeRooms({ rooms: 2, uploads: 2 });
  const reads = [];
  const pending = () => new Promise((resolve) => reads.push(resolve));
  const refused = async (address, pattern, status) => {
    let read = false;
    await assert.rejects(rooms.upload(() => (read = true) && pending(), { address }),
      (e) => e instanceof RoomError && pattern.test(e.message) && e.status === status);
    assert.ok(!read, 'refused without reading');
  };
  const a = rooms.upload(pending, { address: '1.1.1.1' });
  await refused('1.1.1.1', /one upload at a time/, 429);
  const b = rooms.upload(pending, { address: '2.2.2.2' });
  await refused('3.3.3.3', /busy/, 503);
  reads[0](PLAYGROUND);
  reads[1](PLAYGROUND);
  await quietly(() => Promise.all([a, b]));
  assert.equal(rooms.rooms.size, 2);
  await refused('3.3.3.3', /every room/, 503);
  clock.ms += 1;
  await refused('1.1.1.1', /every room|already host/, 503);
});

// The cooldown list kept one entry per address that ever uploaded: the sweep drops those past it.
Deno.test('the upload cooldown list is pruned', () => {
  const { rooms, clock } = makeRooms({ cooldownMs: 1000 });
  assert.throws(() => rooms.create(new Uint8Array(4000), { address: '1.1.1.1' }), RoomError);
  assert.equal(rooms.lastUpload.size, 1);
  clock.ms += 1000;
  rooms.sweep();
  assert.equal(rooms.lastUpload.size, 0);
});

Deno.test('listed rooms: only those their host listed, each with its connect.json', () => {
  const { rooms, clock } = makeRooms();
  const open = quietly(() => rooms.create(PLAYGROUND, { fileName: 'open.bsp', mode: 'deathmatch', listed: true, address: '1.2.3.4' }));
  clock.ms += 60000;
  quietly(() => rooms.create(PLAYGROUND, { fileName: 'hidden.bsp', address: '5.6.7.8' }));
  const list = rooms.list();
  assert.equal(list.length, 1, 'the link-only room is not listed');
  assert.equal(list[0].room, open.code);
  assert.equal(list[0].map, 'open');
  assert.equal(list[0].mode, 'deathmatch');
  assert.equal(list[0].password, false);
  open.host.con.exec('sv_password x'); // its uploader's rcon
  assert.equal(rooms.list()[0].password, true);
  quietly(() => rooms.close(open, 'bye'));
  assert.deepEqual(rooms.list(), []);
});

Deno.test('a room changes its map by rcon at most once per upload cooldown (each rebuilds the game and navigation)', () => {
  const { rooms, clock } = makeRooms();
  const room = quietly(() => rooms.create(PLAYGROUND, { fileName: 'gap.bsp', address: '1.2.3.4' }));
  const who = { id: 0, name: 'uploader', session: { address: '1.2.3.4' } };
  assert.match(quietly(() => room.host.rcon(who, room.rcon, 'map gap')), /changelevel to gap/);
  clock.ms += 5000;
  assert.match(quietly(() => room.host.rcon(who, room.rcon, 'map gap')), /too soon/);
  clock.ms += 30000;
  assert.match(quietly(() => room.host.rcon(who, room.rcon, 'map gap')), /changelevel to gap/);
});
