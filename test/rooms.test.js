// Rooms (server/rooms.js): a game on a map a player uploads, held in memory, with limits.
import assert from 'node:assert/strict';
import { Rooms, RoomError } from '../server/rooms.js';
import { mapNameOf } from '../shared/bsp.js';
import { Writer, Reader, writeHello, readHello, helloRoom, C2S_HELLO, S2C_WELCOME, S2C_REJECT, readWelcome } from '../shared/protocol.js';
import { TEAM_T } from '../shared/player.js';

const PLAYGROUND = Deno.readFileSync(new URL('../maps/de_playground.bsp', import.meta.url));

function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

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
