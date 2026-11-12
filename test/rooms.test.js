// Rooms (server/rooms.js): a game on a map a player uploads, held in memory, with limits.
import assert from 'node:assert/strict';
import { Rooms, RoomError, readBody } from '../server/rooms.js';
import { Game } from '../server/game.js';
import { mapNameOf, parseBSP } from '../shared/bsp.js';
import { CollisionWorld } from '../shared/trace.js';
import { FloorGrid, MAX_CELLS, floorFaces } from '../shared/floorgrid.js';
import { Writer, Reader, writeHello, readHello, helloRoom, C2S_HELLO, S2C_WELCOME, S2C_REJECT, readWelcome } from '../shared/protocol.js';
import { TEAM_T } from '../shared/player.js';
import { quiet as quietly, readCfg, loadMap, joinClient, sendCmd } from './harness.js';

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
function session(address = undefined) {
  return {
    address, got: [], closed: '',
    send(bytes) {
      this.got.push(bytes.slice());
    },
    close(reason) {
      this.closed = reason;
    },
  };
}

// A player joins `room` as server/main.js lets one in; returns the client.
function play(rooms, room, name = 'ann', address = undefined) {
  const c = quietly(() => joinClient(room.host.game, new Writer(), name, TEAM_T, session(address)));
  rooms.joined(room, c);
  return c;
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
  assert.match(room.code, /^[a-z2-9]{10}$/, '~50 bits: /connect.json answers anyone asking');
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
  game.receive(c, writeHello(new Writer(), TEAM_T, 0, 0, 'ann', room.code).slice());
  rooms.joined(room, c);
  const welcome = new Reader().set(s.got.at(-1));
  assert.equal(welcome.u8v(), S2C_WELCOME);
  assert.equal(readWelcome(welcome).map, 'my_map');
  quietly(() => {
    for (let t = 0; t < 100; t++) room.host.step(game);
  });
  assert.equal(game.clients.filter((x) => x && x.bot).length, 3, 'bots fill up to 4 players with the first one in');
});

// A tab left open sends commands every tick: it keeps no room open, so idle sessions cannot hold
// every room on the server.
Deno.test('rooms: a player idle at the keys keeps no room open, one playing does', () => {
  const { rooms, clock } = makeRooms({ idleMs: 1000, activeMs: 1000, cooldownMs: 0 });
  const room = quietly(() => rooms.create(PLAYGROUND, { fileName: 'a.bsp', address: '1.1.1.1' }));
  const game = room.host.game, w = new Writer();
  const idle = joinClient(game, w, 'idle', TEAM_T, session()), busy = joinClient(game, w, 'busy', TEAM_T, session());
  rooms.joined(room, idle);
  const run = (ticks, turning) => quietly(() => {
    for (let i = 0; i < ticks; i++) {
      sendCmd(game, w, idle); // nothing pressed, the view still
      sendCmd(game, w, busy, 0, -1, 0, turning ? i % 90 : 0);
      game.step();
    }
  });
  run(100, true); // over activeMs: 64 ticks
  assert.equal(rooms.humans(room), 1, 'only the one turning');
  run(100, false);
  assert.equal(rooms.humans(room), 0, 'nobody at the keys');
  quietly(() => {
    rooms.sweep();
    clock.ms += 1001;
    rooms.sweep();
  });
  assert.equal(rooms.get(room.code), null, 'closed idleMs after the last one stopped');
  assert.match(idle.session.closed, /nobody played/);
});

Deno.test('rooms close once empty, or unused; closing tells the players', () => {
  const { rooms, clock } = makeRooms({ idleMs: 1000, unusedMs: 5000, cooldownMs: 0, perAddress: 5 });
  const used = quietly(() => rooms.create(PLAYGROUND, { fileName: 'a.bsp', address: '1.1.1.1' }));
  const unused = quietly(() => rooms.create(PLAYGROUND, { fileName: 'b.bsp', address: '1.1.1.1' }));
  const c = quietly(() => joinClient(used.host.game, new Writer(), 'ann', TEAM_T, session()));
  rooms.joined(used, c);
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
  const first = quietly(() => rooms.create(PLAYGROUND, { address: '1.1.1.1' }));
  clock.ms += 2000;
  // A second room from one address replaces its first (a host who closed the browser left it behind).
  const second = quietly(() => rooms.create(PLAYGROUND, { address: '1.1.1.1' }));
  assert.ok(rooms.get(first.code) === null && rooms.get(second.code) === second);
  assert.equal(rooms.rooms.size, 1);
  const other = quietly(() => rooms.create(PLAYGROUND, { address: '2.2.2.2' }));
  play(rooms, other);
  second.host.game.disconnect(play(rooms, second)); // played in, empty now
  refused(() => rooms.create(PLAYGROUND, { address: '3.3.3.3' }), /every room/, 503);
  clock.ms += 2000;
  quietly(() => rooms.create(PLAYGROUND, { address: '1.1.1.1' })); // every room taken, but its own one goes
  assert.equal(rooms.rooms.size, 2);
  // IPv6: one /64 is one address.
  const v6 = makeRooms({ cooldownMs: 0 }).rooms;
  const a = quietly(() => v6.create(PLAYGROUND, { address: '2001:db8:1:2::5' }));
  quietly(() => v6.create(PLAYGROUND, { address: '2001:db8:1:2::77' }));
  assert.ok(v6.get(a.code) === null);
  assert.equal(v6.rooms.size, 1);
});

// The upload's test tick is the game's own: Host.step logs a tick that throws and goes on.
Deno.test('a map whose first tick throws is refused at the upload', () => {
  const { rooms } = makeRooms();
  const step = Game.prototype.step;
  Game.prototype.step = () => {
    throw new Error('a broken map');
  };
  try {
    assert.throws(() => quietly(() => rooms.create(PLAYGROUND, { address: '1.2.3.4' })),
      (e) => e instanceof RoomError && e.message === 'the map does not run: a broken map');
  } finally {
    Game.prototype.step = step;
  }
  assert.equal(rooms.rooms.size, 0);
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
  const [ra, rb] = await quietly(() => Promise.all([a, b]));
  assert.equal(rooms.rooms.size, 2);
  ra.host.game.disconnect(play(rooms, ra)); // played in, empty now
  play(rooms, rb);
  await refused('3.3.3.3', /every room/, 503);
  clock.ms += 1;
  await refused('1.1.1.1', /one upload at a time/, 429); // its own room does not count toward full
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
  // A join password sent with the upload (Play Online's Host your map).
  assert.throws(() => rooms.create(PLAYGROUND, { fileName: 'long.bsp', password: 'x'.repeat(64), address: '9.9.9.9' }), /too long/);
  clock.ms += 60000;
  const locked = quietly(() => rooms.create(PLAYGROUND, { fileName: 'locked.bsp', listed: true, password: 'sesame', address: '9.9.9.9' }));
  assert.equal(locked.host.joinPassword.value, 'sesame');
  assert.equal(rooms.list()[0].password, true);
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

Deno.test('a Competitive (short) room plays the short match', () => {
  const rooms = new Rooms({ readCfg, now: () => 0 });
  const room = quietly(() => rooms.create(PLAYGROUND, { fileName: 'short.bsp', mode: 'competitive_short', address: '198.51.100.1' }));
  assert.equal(room.host.game.rules.maxRounds, 16);
  assert.equal(room.host.game.rules.overtime, false);
  rooms.close(room, 'done');
});

// Rooms on the server's own maps (the admin page's new room, a JSON POST /rooms): no upload,
// public or by link only (sv_listed, changeable later), a join password, the same limits, and
// a change of map among the server's.
Deno.test('rooms on the server\'s maps: listed by sv_listed, a join password, the limits, a map change', () => {
  const { rooms, clock } = makeRooms();
  assert.throws(() => rooms.open('de_playground', { address: '1.2.3.4' }), /only on maps players bring/);
  rooms.opts.maps = { loadMap, listMaps: () => ['de_playground', 'de_inkwell'] };
  assert.throws(() => rooms.open('de_nosuch', { address: '1.2.3.4' }), /no map de_nosuch/);
  assert.throws(() => rooms.open('../de_playground', { address: '1.2.3.4' }), /no map/);
  assert.throws(() => rooms.open('de_playground', { address: '1.2.3.4', password: 'x'.repeat(64) }), /too long/);
  clock.ms += 60000;
  const room = quietly(() => rooms.open('de_playground', { mode: 'deathmatch', listed: true, password: 'sesame', address: '1.2.3.4' }));
  assert.equal(room.bytes, null, 'served from maps/');
  assert.equal(room.host.game.mapName, 'de_playground');
  assert.equal(room.host.modeName, 'deathmatch');
  assert.equal(rooms.list().length, 1);
  assert.equal(rooms.list()[0].password, true);
  room.host.con.exec('sv_listed 0'); // the admin page's switch
  assert.deepEqual(rooms.list(), [], 'by link only');
  room.host.con.exec('sv_listed 1');
  assert.equal(rooms.list().length, 1);
  // The join password: refused without it, let in with it.
  const w = new Writer();
  const join = (password, address) => {
    const s = session(address), c = room.host.game.connect(s);
    quietly(() => room.host.game.receive(c, writeHello(w, TEAM_T, 0, 0, 'guest', room.code, password).slice()));
    c.s = s;
    return c;
  };
  assert.ok(!join('').joined);
  assert.ok(join('sesame').joined);
  // Its rcon may change to another of the server's maps.
  quietly(() => room.host.con.exec('changelevel de_inkwell'));
  assert.equal(room.host.game.mapName, 'de_inkwell');
  // A new room from the same address while someone from there plays in it is refused (two
  // people behind one NAT ended each other's matches); once nobody is at the keys there it
  // replaces the room, whoever is still connected told why.
  const guest = join('sesame', '1.2.3.4');
  clock.ms += 60000;
  assert.throws(() => rooms.open('de_inkwell', { address: '1.2.3.4' }), (e) => e.status === 409 && /plays in the room you made/.test(e.message));
  assert.ok(rooms.get(room.code) === room && guest.s.closed === '');
  rooms.limits.activeMs = 0; // the guest away from the keys
  const next = quietly(() => rooms.open('de_inkwell', { address: '1.2.3.4' }));
  assert.ok(rooms.get(room.code) === null && rooms.get(next.code) === next);
  assert.equal(guest.s.closed, 'its host made a new room');
  assert.equal(new Reader().set(guest.s.got.at(-1)).u8v(), S2C_REJECT);
});

// Two people behind one address (a carrier-grade NAT, a VPN exit): the second one's new room
// closed the first one's while four players were in it.
Deno.test('rooms: a new room never ends a match in another room from the same address', () => {
  const { rooms, clock } = makeRooms({ cooldownMs: 1000 });
  const first = quietly(() => rooms.create(PLAYGROUND, { address: '100.64.7.9' }));
  const neighbour = play(rooms, first, 'p0', '100.64.7.9');
  const players = [1, 2, 3].map((i) => play(rooms, first, `p${i}`, `198.51.100.${i}`));
  clock.ms += 1000;
  assert.throws(() => rooms.create(PLAYGROUND, { address: '100.64.7.9' }),
    (e) => e instanceof RoomError && e.status === 409 && /plays in the room you made: rejoin it by its link/.test(e.message));
  assert.ok(rooms.get(first.code) === first && [neighbour, ...players].every((c) => c.session.closed === ''), 'still playing');
  assert.equal(rooms.lastUpload.get('100.64.7.9'), 0, 'no cooldown for a refused room');
  // Nobody from that address plays there any more (a host who closed the browser): the new
  // room replaces it, its other players told why.
  first.host.game.disconnect(neighbour);
  const second = quietly(() => rooms.create(PLAYGROUND, { address: '100.64.7.9' }));
  assert.ok(rooms.get(first.code) === null && rooms.get(second.code) === second, 'replaced');
  assert.ok(players.every((c) => c.session.closed === 'its host made a new room'));
});

// Rooms nobody ever joins lived 10 minutes: eight addresses each re-making one every 9 minutes
// held every room on the server for good.
Deno.test('rooms: a full server replaces its oldest room nobody ever joined', () => {
  const { rooms, clock } = makeRooms({ rooms: 3, cooldownMs: 0 });
  const make = (address) => quietly(() => rooms.create(PLAYGROUND, { address }));
  const a = make('203.0.113.1'), b = make('203.0.113.2'), c = make('203.0.113.3');
  play(rooms, b);
  clock.ms += 1000;
  const d = make('198.51.100.5'); // the server full: a, never joined, goes
  assert.ok(rooms.get(a.code) === null && rooms.get(b.code) === b && rooms.get(c.code) === c && rooms.get(d.code) === d);
  play(rooms, c);
  const e = make('198.51.100.6'); // d, the one left that nobody joined
  assert.ok(rooms.get(d.code) === null && rooms.get(e.code) === e);
  play(rooms, e);
  assert.throws(() => make('198.51.100.7'), (err) => err.status === 503 && /every room/.test(err.message), 'all joined: full');
  assert.equal(rooms.rooms.size, 3);
});

// A refused HELLO (a bad sv_password, a ban, another protocol) marked a room joined: its bots
// came in, and a room nobody could join closed 2 minutes after instead of 10.
Deno.test('rooms: a refused HELLO does not count as joining the room', () => {
  const { rooms } = makeRooms();
  const room = quietly(() => rooms.create(PLAYGROUND, { players: 10, password: 'secret', address: '198.51.100.1' }));
  const game = room.host.game, w = new Writer();
  const hello = (password) => {
    const c = game.connect(session());
    quietly(() => game.receive(c, writeHello(w, TEAM_T, 0, 0, 'probe', room.code, password).slice()));
    rooms.joined(room, c); // as server/main.js does after each datagram
    return c;
  };
  hello('wrong');
  quietly(() => {
    for (let t = 0; t < 64; t++) game.step();
  });
  assert.equal(room.joined, false);
  assert.equal(game.bots.list.length, 0, 'no bots for nobody');
  assert.ok(hello('secret').joined);
  assert.equal(room.joined, true);
});

// An upload that failed while being read (too slow, too long) started no cooldown: the same
// address began the next one at once, and two addresses held both upload slots for good.
Deno.test('rooms: a failed upload starts its address\'s cooldown', async () => {
  const { rooms, clock } = makeRooms({ cooldownMs: 1000 });
  const slow = () => Promise.reject(new RoomError('the upload is too slow', 408));
  await assert.rejects(rooms.upload(slow, { address: '203.0.113.1' }), (e) => e.status === 408);
  let read = false;
  const fine = () => (read = true) && Promise.resolve(PLAYGROUND);
  await assert.rejects(rooms.upload(fine, { address: '203.0.113.1' }), (e) => e.status === 429 && /one upload at a time/.test(e.message));
  assert.ok(!read, 'refused before reading');
  clock.ms += 1000;
  assert.ok(await quietly(() => rooms.upload(fine, { address: '203.0.113.1' })));
});

// The request body: cut off once it runs slower than the least rate after its grace, or past
// its time; a body within both comes through whole.
Deno.test('rooms: an upload slower than the least rate is cut off after its grace', async () => {
  const rate = { bytesPerSecond: 64 << 10, afterMs: 100 };
  const trickle = () => new Request('http://127.0.0.1/rooms', {
    method: 'POST',
    body: new ReadableStream({ // 1 KB, then nothing more
      start(c) {
        c.enqueue(new Uint8Array(1024));
      },
      pull: () => new Promise(() => {}),
    }),
  });
  const t0 = performance.now();
  await assert.rejects(readBody(trickle(), 1 << 20, 60000, undefined, rate), (e) => e.status === 408 && /too slow/.test(e.message));
  assert.ok(performance.now() - t0 < 2000, 'at the end of the grace, not the time limit');
  await assert.rejects(readBody(trickle(), 1 << 20, 50, undefined, { bytesPerSecond: 0, afterMs: 100 }),
    (e) => e.status === 408 && /took too long/.test(e.message));
  const whole = await readBody(new Request('http://127.0.0.1/rooms', { method: 'POST', body: PLAYGROUND }), 24 << 20, 5000);
  assert.equal(whole.byteLength, PLAYGROUND.byteLength);
});
