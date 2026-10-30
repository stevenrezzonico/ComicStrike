// Builds de_inkwell, ComicStrike's own defusal map: a harbour town round a print works.
// Written as a map editor project (maps/de_inkwell.cmap.json: open it in the editor to
// change it) and compiled by the editor's compiler into maps/de_inkwell.bsp.
//
// deno run --allow-read --allow-write=maps,docs tools/gen_inkwell.js [--draft]
//
// The layout is a list of rooms: rectangles of walkable floor, each with its floor height,
// textures, wall height and, indoors, a roof; ramps and stairs are rooms too. Everything
// else inside the map's bounds is solid: the floors, walls and roofs are rasterized on a
// 32-unit grid and merged into boxes. Details (cover, doors, angled walls, pillars, the
// canal) are shapes placed in the rooms after that. Valve's defusal maps set the scale:
// T spawn ~17-20 s from either site at a run, CT spawn ~8-11 s, sites ~400 units across.
// Deterministic: the same files every run.

import { makeBrush, FORMAT, VERSION, checkProject, compileProject } from '../client/editor/project.js';

const OUT = new URL('../maps/', import.meta.url);
const NAME = 'de_inkwell';
const CELL = 32;
const ZMIN = -192; // the bottom of every floor and wall
const MAX_RECT = 64; // cells (2048 units): a face's lightmap stays under 256 texels a side

// Materials: floor, walls, the tops of walls (roofs seen from above), ceilings indoors.
const M = {
  docks: { floor: 'asphaltdirty01', wall: 'crete3_wall02', top: 'crete3_wall02' },
  street: { floor: 'sandroad', wall: 'cssandwallbta', top: 'claytile1' },
  plaza: { floor: '-0rockcobblest', wall: 'azwall_a', top: 'claytile1' },
  works: { floor: 'flor_wood_lt_r3', wall: 'brick07', top: 'brick07', ceil: 'wdplanks128f' },
  shed: { floor: 'wdplanks128f', wall: 'brick13', top: 'metal_wall05b', ceil: 'wdplanks128f' },
  yard: { floor: '-0sand', wall: 'cssandwallbta', top: 'claytile1' },
};

// The rooms: [name, x0, y0, x1, y1, floor z, material, opts]. Later rooms cut into
// earlier ones. opts: wall (wall height over the floor, 320), roof (a ceiling this high
// over the floor) with skylights (sky: rectangles of glass in it), ramp / stairs: { up: the
// high side, z1: the high end's height }.
const ROOMS = [
  // T spawn: the docks, south, over the canal (a low harbour wall beyond it).
  ['t_spawn', -640, -2432, 640, -1792, 0, M.docks],
  ['canal', -640, -2624, 640, -2432, -128, M.docks, { wall: 192 }],
  // A long: the quay east, then Long street north, up a ramp onto site A.
  ['quay', 640, -2112, 1472, -1824, 0, M.docks],
  ['long_corner', 1472, -2112, 1984, -1600, 0, M.docks],
  ['long', 1600, -1600, 1984, 512, 0, M.street],
  ['long_ramp', 1600, 512, 1984, 768, 0, M.street, { ramp: { up: 'py', z1: 96 } }],
  // Site A: a raised plaza north-east.
  ['a_site', 1088, 768, 2240, 1472, 96, M.plaza],
  // Mid: Market street north from T spawn to the mid plaza, CT mid on to the CT spawn.
  ['market', 192, -1792, 512, -640, 0, M.street],
  ['mid', -512, -640, 512, 256, 0, M.plaza],
  ['ct_mid', -512, 256, -192, 1408, 0, M.street],
  ['ct_mid_ramp', -512, 1408, -192, 1664, 0, M.street, { ramp: { up: 'py', z1: 64 } }],
  // A short: through the print works' press hall, up stairs onto A.
  ['press_hall', 512, -128, 1344, 256, 0, M.works, { roof: 224, sky: [[736, -32, 832, 64], [1024, -32, 1120, 64]] }],
  ['short', 1088, 256, 1344, 512, 0, M.street],
  ['short_stairs', 1088, 512, 1344, 768, 0, M.street, { stairs: { up: 'py', z1: 96 } }],
  // CT spawn: north, with ways to both sites.
  ['ct_spawn', -640, 1664, 640, 2304, 64, M.yard],
  ['ct_a', 640, 1728, 1088, 2048, 64, M.yard],
  ['ct_a_ramp', 1088, 1728, 1344, 2048, 64, M.yard, { ramp: { up: 'px', z1: 96 } }],
  ['a_ct', 1344, 1472, 1600, 2048, 96, M.plaza],
  ['ct_b', -1088, 1664, -640, 2048, 64, M.yard],
  ['ct_b_ramp', -1600, 1664, -1088, 2048, 0, M.yard, { ramp: { up: 'px', z1: 64 } }],
  // Site B: a yard north-west.
  ['b_site', -2240, 576, -1088, 1408, 0, M.yard],
  ['b_ct', -1600, 1408, -1088, 1664, 0, M.yard],
  // B: through the paper warehouse west of T spawn, the lower tunnel, the B alley.
  ['warehouse', -2240, -2304, -640, -1792, 0, M.shed,
    { roof: 256, sky: [[-2016, -2112, -1888, -1984], [-1504, -2176, -1376, -2048], [-992, -2176, -864, -2048]] }],
  ['tunnel_stairs', -2240, -1792, -1792, -1600, -64, M.shed, { roof: 256, stairs: { up: 'ny', z1: 0 } }],
  ['tunnel', -2240, -1600, -1792, -768, -64, M.shed, { roof: 192, sky: [[-2080, -1216, -1952, -1152]] }],
  ['tunnel_ramp', -2240, -768, -1792, -512, -64, M.shed, { roof: 256, ramp: { up: 'py', z1: 0 } }],
  ['b_alley', -2112, -512, -1792, 576, 0, M.street],
  // Mid to B: the fish market alley west of mid, into B's south-east corner.
  ['fish_alley', -1344, -448, -512, -192, 0, M.street],
  ['fish_north', -1344, -192, -1088, 576, 0, M.street],
];

// Spawn areas (10 each), buy zones and bomb sites (A first).
const SPAWNS = [
  ['info_player_deathmatch', [-320, -2272, 0], 90],
  ['info_player_start', [-320, 1920, 64], 270],
];
const BUY_ZONES = [['1', 't_spawn'], ['2', 'ct_spawn']];
const SITES = [[1472, 832, 1984, 1344, 96], [-1920, 704, -1408, 1216, 0]];

// --- Rasterizing the rooms into boxes -------------------------------------------------

const roomOf = new Map(ROOMS.map((r) => [r[0], r]));
const X0 = Math.min(...ROOMS.map((r) => r[1])) - 2 * CELL, Y0 = Math.min(...ROOMS.map((r) => r[2])) - 2 * CELL;
const X1 = Math.max(...ROOMS.map((r) => r[3])) + 2 * CELL, Y1 = Math.max(...ROOMS.map((r) => r[4])) + 2 * CELL;
const W = (X1 - X0) / CELL, H = (Y1 - Y0) / CELL;
const at = (i, j) => j * W + i;
const room = new Int16Array(W * H).fill(-1); // the room each cell is in, -1 solid
ROOMS.forEach((r, k) => {
  for (let j = (r[2] - Y0) / CELL; j < (r[4] - Y0) / CELL; j++) {
    for (let i = (r[1] - X0) / CELL; i < (r[3] - X0) / CELL; i++) room[at(i, j)] = k;
  }
});

// Each solid cell takes its walls from the rooms within 3 cells: the highest wall top
// and that room's material; cells farther from every room from the nearest one.
const wallTop = (r) => r[5] + Math.max((r[7] && r[7].wall) || 320, ((r[7] && r[7].roof) || 0) + 64, rampTop(r) - r[5] + 160);
const rampTop = (r) => (r[7] && (r[7].ramp || r[7].stairs) ? (r[7].ramp || r[7].stairs).z1 : r[5]);
const solidOf = new Int16Array(W * H).fill(-1);
{
  const dist = new Int32Array(W * H).fill(1 << 30), queue = [];
  for (let c = 0; c < W * H; c++) {
    if (room[c] >= 0) {
      dist[c] = 0;
      queue.push(c);
    }
  }
  for (let q = 0; q < queue.length; q++) { // nearest room by steps
    const c = queue[q], i = c % W, j = (c - i) / W;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= W || j2 >= H) continue;
      const c2 = at(i2, j2);
      if (dist[c2] <= dist[c] + 1) continue;
      dist[c2] = dist[c] + 1;
      solidOf[c2] = room[c] >= 0 ? room[c] : solidOf[c];
      queue.push(c2);
    }
  }
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = at(i, j);
      if (room[c] >= 0) continue;
      let best = solidOf[c];
      for (let dj = -3; dj <= 3; dj++) {
        for (let di = -3; di <= 3; di++) {
          const i2 = i + di, j2 = j + dj;
          if (i2 < 0 || j2 < 0 || i2 >= W || j2 >= H) continue;
          const k = room[at(i2, j2)];
          if (k >= 0 && wallTop(ROOMS[k]) > wallTop(ROOMS[best])) best = k;
        }
      }
      solidOf[c] = best;
    }
  }
}

// Greedy rectangles of equal keys (no key: skipped), at most MAX_RECT cells a side.
function rects(keyOf) {
  const keys = new Array(W * H), used = new Uint8Array(W * H), out = [];
  for (let c = 0; c < W * H; c++) keys[c] = keyOf(c);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = at(i, j), k = keys[c];
      if (k === null || used[c]) continue;
      let i1 = i;
      while (i1 + 1 < W && i1 + 1 - i < MAX_RECT && keys[at(i1 + 1, j)] === k && !used[at(i1 + 1, j)]) i1++;
      let j1 = j;
      grow: while (j1 + 1 < H && j1 + 1 - j < MAX_RECT) {
        for (let x = i; x <= i1; x++) if (keys[at(x, j1 + 1)] !== k || used[at(x, j1 + 1)]) break grow;
        j1++;
      }
      for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) used[at(x, y)] = 1;
      out.push({ k, b: [X0 + i * CELL, Y0 + j * CELL, X0 + (i1 + 1) * CELL, Y0 + (j1 + 1) * CELL] });
    }
  }
  return out;
}

const project = { format: FORMAT, version: VERSION, name: NAME, brushes: [], points: [], nextId: 1 };
const add = (b, tex, kind = 'world', keys = {}, shape = {}) => {
  const br = makeBrush(project.nextId++, b, tex, kind, keys, shape);
  project.brushes.push(br);
  return br;
};
const T = (top, side = top, bottom = null) => ({ top, bottom, side });
const all = (t) => ({ top: t, bottom: t, side: t });

// Floors: a column under every room cell up to its floor (a ramp's or stairs' low end).
for (const { k, b } of rects((c) => (room[c] >= 0 ? `${ROOMS[room[c]][5]}|${ROOMS[room[c]][6].floor}|${ROOMS[room[c]][6].wall}` : null))) {
  const [z, floor, wall] = k.split('|');
  add([b[0], b[1], ZMIN, b[2], b[3], +z], T(floor, wall));
}
// Walls: every solid cell up to its wall top.
for (const { k, b } of rects((c) => (room[c] < 0 ? `${wallTop(ROOMS[solidOf[c]])}|${ROOMS[solidOf[c]][6].wall}|${ROOMS[solidOf[c]][6].top}` : null))) {
  const [z, wall, top] = k.split('|');
  add([b[0], b[1], ZMIN, b[2], b[3], +z], T(top, wall));
}
// Roofs over the indoor rooms, with holes for the skylights (glass panes: a shot breaks them).
const inRect = (x, y, [x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1;
for (const { k, b } of rects((c) => {
  const r = room[c] >= 0 && ROOMS[room[c]];
  if (!r || !r[7] || !r[7].roof) return null;
  const x = X0 + (c % W) * CELL, y = Y0 + Math.floor(c / W) * CELL;
  if ((r[7].sky || []).some((s) => inRect(x, y, s))) return null;
  return `${r[5] + r[7].roof}|${r[6].ceil}|${r[6].top}`;
})) {
  const [z, ceil, top] = k.split('|');
  add([b[0], b[1], +z, b[2], b[3], +z + 32], { top, bottom: ceil, side: ceil });
}
for (const r of ROOMS) {
  for (const [x0, y0, x1, y1] of (r[7] && r[7].sky) || []) {
    const z = r[5] + r[7].roof;
    add([x0, y0, z + 12, x1, y1, z + 20], all('glass_med'), 'func_breakable', { material: '0', health: '20' });
  }
}
// Ramps and stairs, on their rooms' floors.
for (const r of ROOMS) {
  const o = r[7] || {}, slope = o.ramp || o.stairs;
  if (!slope) continue;
  add([r[1], r[2], r[5], r[3], r[4], slope.z1], T(r[6].floor, r[6].wall), 'world', {},
    { shape: o.ramp ? 'ramp' : 'stairs', up: slope.up, step: 16 });
}

// --- Details: cover, doors, the canal, machines, awnings ---------------------------------

const firstDetail = project.brushes.length;
const block = (b, tex) => add(b, all(tex));
const crate = (x, y, z = 0, s = 64, tex = 'crate08') => block([x, y, z, x + s, y + s, z + s], tex);
const breakCrate = (x, y, z = 0, s = 64) => add([x, y, z, x + s, y + s, z + s], all('crate08'), 'func_breakable',
  { material: '1', health: '40' });
const glass = (b) => add(b, all('glass_med'), 'func_breakable', { material: '0', health: '20' });
const pillar = (x, y, z, r, h, tex, sides = 8) => add([x - r, y - r, z, x + r, y + r, z + h], T(tex), 'world', {},
  { shape: 'pillar', sides });
// A wall `len` long and `th` thick centered on (x, y), turned `yaw` degrees.
const slab = (x, y, z, len, th, h, yaw, tex) => add([x - len / 2, y - th / 2, z, x + len / 2, y + th / 2, z + h],
  all(tex), 'world', {}, { yaw });
// A wall with doorways [from, to, height] along its longer side.
function wallWithDoors(b, doors, tex) {
  const [x0, y0, z0, x1, y1, z1] = b, a = x1 - x0 >= y1 - y0 ? 0 : 1, lo = b[a], hi = b[a + 3];
  let at = lo;
  const piece = (u0, u1, za, zb) => {
    const p = [x0, y0, za, x1, y1, zb];
    p[a] = u0;
    p[a + 3] = u1;
    block(p, tex);
  };
  for (const [u0, u1, h] of doors) {
    if (u0 > at) piece(at, u0, z0, z1);
    piece(u0, u1, z0 + h, z1);
    at = u1;
  }
  if (hi > at) piece(at, hi, z0, z1);
}
// A parked car: body and cabin, along x or y.
function car(x, y, z, alongY, tex = 'metal_wall05b') {
  const [l, w] = alongY ? [96, 176] : [176, 96];
  block([x, y, z, x + l, y + w, z + 48], tex);
  const [cl, cw] = alongY ? [80, 96] : [96, 80];
  block([x + (l - cl) / 2, y + (w - cw) / 2, z + 48, x + (l + cl) / 2, y + (w + cw) / 2, z + 88], 'steel');
}

// T spawn: the canal (water 104 deep, ladders out, a railing with gaps at them), bollards,
// a container stack and crates.
add([-640, -2624, -128, 640, -2432, -24], { top: '!watergreen', bottom: null, side: null }, 'func_water');
for (const x of [-576, 448]) add([x, -2456, -128, x + 64, -2432, 0], T('crete3_wall02'), 'world', {}, { shape: 'ladder', up: 'py' });
for (const [x0, x1] of [[-640, -576], [-512, 448], [512, 640]]) block([x0, -2432, 0, x1, -2424, 40], 'steel');
for (const x of [-384, -128, 128, 384]) pillar(x, -2400, 0, 12, 28, 'steel');
block([384, -2400, 0, 640, -2304, 128], 'metal_wall05b');
block([448, -2304, 0, 640, -2208, 96], 'bcrate02');
crate(-448, -1920);
crate(-448, -1856);
crate(-416, -1888, 64);
crate(96, -1856);
// The quay: containers along the water side, crates.
block([800, -2112, 0, 1056, -2016, 128], 'metal_wall05b');
block([1184, -2112, 0, 1376, -2016, 128], 'metal_wall05b');
block([1216, -2112, 128, 1344, -2016, 192], 'bcrate02');
crate(1056, -1888);
breakCrate(1408, -2112);
// Long: the gate (two swinging doors in an arch), a car, crates by the walls.
wallWithDoors([1600, -1600, 0, 1984, -1568, 320], [[1728, 1856, 144]], 'brick13');
add([1728, -1592, 0, 1792, -1576, 144], all('fifties_dr2'), 'func_door_rotating',
  { distance: '90', speed: '140', wait: '4', hinge: 'start' });
add([1792, -1592, 0, 1856, -1576, 144], all('fifties_dr2'), 'func_door_rotating',
  { distance: '90', speed: '140', wait: '4', hinge: 'end' });
car(1632, -896, 0, true);
block([1888, -320, 0, 1984, -224, 96], 'bcrate02');
crate(1920, -224);
breakCrate(1600, 128);
crate(1920, 384);
// Market: stalls along the west wall, counters under tiled awnings (high enough to stand
// on a counter under them: a lower one trapped bots that jumped up); a cart.
for (const y of [-1600, -1280, -960]) {
  add([192, y, 0, 240, y + 128, 40], T('wdplanks128f'));
  add([192, y - 32, 160, 320, y + 160, 168], { top: 'claytile1', bottom: 'wdplanks128f', side: 'wdplanks128f' });
  crate(200, y + 32, 40, 32, 'bcrate02');
}
block([432, -1152, 0, 512, -1024, 48], 'wdplanks128f');
// Mid: a round fountain, crates; the press hall's wall with a doorway and a window.
pillar(0, -192, 0, 112, 24, 'azwall_a', 16);
pillar(0, -192, 24, 32, 72, 'azwall_a', 8);
crate(-448, -608);
crate(384, 128);
block([512, -128, 0, 544, -32, 224], 'brick07');
block([512, -32, 0, 544, 32, 48], 'brick07');
block([512, -32, 112, 544, 32, 224], 'brick07');
glass([524, -32, 48, 532, 32, 112]);
wallWithDoors([512, 32, 0, 544, 256, 224], [[64, 192, 128]], 'brick07');
// The press hall: two presses, a conveyor carrying paper east, ink drums, crates.
block([672, -96, 0, 864, 0, 112], 'steel');
block([704, -96, 112, 832, 0, 160], 'metal_wall05b');
block([736, 160, 0, 896, 256, 96], 'steel');
add([896, -128, 0, 1344, -80, 24], { top: 'scroll_conv', bottom: null, side: 'steel' }, 'func_conveyor',
  { speed: '100', angles: '0 0 0' });
for (const [x, y] of [[640, 224], [1000, 0], [1040, 40], [1312, 224]]) pillar(x, y, 0, 20, 48, 'metal_wall05b', 12);
crate(1280, 96);
// Short: a crate at the stairs.
crate(1280, 320);
// A: a crate stack in the middle of the site, a low angled wall at the Long ramp, a stage on
// the east side, a portico on pillars along the north wall.
crate(1664, 1024, 96);
crate(1728, 1024, 96);
crate(1664, 1088, 96);
crate(1696, 1056, 160);
slab(1856, 912, 96, 160, 24, 48, 45, 'azwall_a');
block([2112, 896, 96, 2240, 1280, 112], 'crete4_stp01');
crate(2144, 1152, 112);
crate(1216, 896, 96, 64, 'bcrate02');
breakCrate(1408, 1216, 96);
for (const x of [1152, 1280, 1664, 1856, 2048, 2176]) pillar(x, 1408, 96, 16, 176, 'azwall_a');
block([1088, 1376, 272, 1344, 1472, 288], 'claytile1');
block([1600, 1376, 272, 2240, 1472, 288], 'claytile1');
// CT side: a truck and crates at the CT spawn, crates on the ways to the sites, a car in CT mid.
block([416, 1824, 64, 512, 2048, 160], 'metal_wall05b');
block([416, 2048, 64, 512, 2144, 144], 'steel');
crate(-576, 2176, 64);
crate(-576, 2240, 64);
crate(832, 1728, 64);
crate(-896, 1984, 64, 64, 'bcrate02');
car(-480, 640, 0, true);
crate(-256, 1280);
// B: a hut with a ladder onto its roof, crate stacks, a low angled wall, a breakable crate
// at the Fish market corner.
add([-2240, 1216, 0, -2048, 1408, 128], { top: 'claytile1', bottom: 'brick13', side: 'brick13' });
add([-2048, 1280, 0, -2024, 1344, 128], T('brick13'), 'world', {}, { shape: 'ladder', up: 'nx' });
crate(-1728, 928);
crate(-1664, 928);
crate(-1728, 992);
crate(-1696, 960, 64);
block([-1472, 1088, 0, -1344, 1216, 128], 'mltrycrtesd');
slab(-1280, 800, 0, 192, 24, 64, 30, 'azwall_a');
breakCrate(-1216, 640);
crate(-2176, 640, 0, 64, 'bcrate02');
// Cover for the attackers: a box at each T entrance, a container between the CT entrance and
// the site (from the north side the CTs saw both T entrances across the open yard).
block([-1920, 704, 0, -1792, 832, 96], 'mltrycrtesd');
block([-1216, 768, 0, -1088, 896, 128], 'mltrycrtesd');
block([-1600, 1248, 0, -1376, 1344, 128], 'metal_wall05b');
// The warehouse: a wide doorway from T spawn, rolls of paper, shelves, crates.
wallWithDoors([-672, -2304, 0, -640, -1792, 256], [[-2112, -1920, 160]], 'brick13');
for (const [x, y] of [[-1216, -1888], [-1120, -1888], [-1664, -2176], [-1760, -2176], [-1712, -2096]]) {
  pillar(x, y, 0, 40, 96, 'snow', 12);
}
block([-1408, -2304, 0, -1152, -2240, 160], 'wdplanks128f');
block([-2240, -1984, 0, -2176, -1824, 128], 'wdplanks128f');
breakCrate(-1024, -2304);
breakCrate(-960, -2304);
crate(-992, -2304, 64, 64, 'bcrate02');
// The tunnel: a zigzag of two overlapping half walls (a straight line ran 3000 units from the
// warehouse down the tunnel and the B alley onto B; bots fought along it and the bomb never
// got there), crates, a pipe along the roof.
block([-2240, -1216, -64, -1984, -1152, 128], 'brick13');
block([-2048, -1024, -64, -1792, -960, 128], 'brick13');
crate(-2240, -1408, -64);
crate(-1856, -896, -64);
block([-2240, -1600, 88, -2208, -768, 112], 'steel');
// B alley: another zigzag (the tunnel saw B down it); the Fish alley.
block([-2112, -192, 0, -1920, -128, 256], 'cssandwallbta');
block([-1984, 64, 0, -1792, 128, 256], 'cssandwallbta');
crate(-2112, -384);
crate(-1856, 320, 0, 64, 'bcrate02');
for (const x of [-1024, -768]) block([x, -448, 0, x + 96, -400, 48], 'bcrate02');
add([-1280, -448, 160, -576, -384, 168], { top: 'claytile1', bottom: 'wdplanks128f', side: 'wdplanks128f' });
crate(-1344, 128);

// Spawns: two rows of five, 64 apart, facing out.
for (const [kind, [x, y, z], yaw] of SPAWNS) {
  for (let k = 0; k < 10; k++) {
    project.points.push({ id: project.nextId++, kind, o: [x + (k % 5) * 128 + 64, y + Math.floor(k / 5) * 96, z], yaw });
  }
}
for (const [team, name] of BUY_ZONES) {
  const r = roomOf.get(name);
  add([r[1], r[2], r[5], r[3], r[4], r[5] + 128], { top: null, bottom: null, side: null }, 'func_buyzone', { team });
}
for (const [x0, y0, x1, y1, z] of SITES) {
  add([x0, y0, z, x1, y1, z + 128], { top: null, bottom: null, side: null }, 'func_bomb_target');
}

// --- The plan drawing (docs/maps/de_inkwell.svg) ----------------------------------------

const LABELS = {
  t_spawn: 'T spawn (docks)', quay: 'Quay', long_corner: 'Long corner', long: 'Long', a_site: 'A',
  market: 'Market', mid: 'Mid', ct_mid: 'CT mid', press_hall: 'Press hall', short: 'Short', ct_spawn: 'CT spawn',
  b_site: 'B', warehouse: 'Paper warehouse', tunnel: 'Lower tunnel', b_alley: 'B alley', fish_alley: 'Fish alley',
};
const FILL = new Map([[M.docks, '#c9c3b8'], [M.street, '#ecd9a8'], [M.plaza, '#e3cfa0'], [M.works, '#d9a58f'],
  [M.shed, '#b8a993'], [M.yard, '#efe0b4']]);
function planSVG() {
  const s = 1 / 8, pad = 20, w = (X1 - X0) * s + pad * 2, h = (Y1 - Y0) * s + pad * 2;
  const px = (x) => (x - X0) * s + pad, py = (y) => (Y1 - y) * s + pad; // north up
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="sans-serif">`,
    `<rect width="${w}" height="${h}" fill="#5b5148"/>`,
    '<defs><pattern id="roof" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<line x1="0" y1="0" x2="0" y2="8" stroke="#000" stroke-opacity="0.25" stroke-width="3"/></pattern></defs>'];
  for (const r of ROOMS) {
    const [, x0, y0, x1, y1, z, m, o = {}] = r;
    const rect = `x="${px(x0)}" y="${py(y1)}" width="${(x1 - x0) * s}" height="${(y1 - y0) * s}"`;
    out.push(`<rect ${rect} fill="${FILL.get(m)}"/>`);
    if (o.roof) out.push(`<rect ${rect} fill="url(#roof)"/>`);
    const slope = o.ramp || o.stairs;
    if (slope) { // an arrow uphill
      const cx = px((x0 + x1) / 2), cy = py((y0 + y1) / 2), d = { px: [1, 0], nx: [-1, 0], py: [0, -1], ny: [0, 1] }[slope.up];
      out.push(`<line x1="${cx - d[0] * 14}" y1="${cy - d[1] * 14}" x2="${cx + d[0] * 14}" y2="${cy + d[1] * 14}" ` +
        'stroke="#222" stroke-width="2" marker-end="url(#up)"/>');
      out.push(`<text x="${cx}" y="${cy + 4}" dx="18" font-size="9" fill="#222">${o.ramp ? 'ramp' : 'stairs'} ${z}→${slope.z1}</text>`);
    }
  }
  out.push('<defs><marker id="up" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto">' +
    '<path d="M0 0L6 3L0 6z" fill="#222"/></marker></defs>');
  // The details on the floor (cover, walls, doors): dark shapes, the water blue; not the
  // roofs' skylights, awnings or porticoes (their bottoms are high above the floor).
  for (const br of project.brushes.slice(firstDetail)) {
    const [x0, y0, z0, x1, y1] = br.b;
    if (br.kind === 'func_water') {
      out.push(`<rect x="${px(x0)}" y="${py(y1)}" width="${(x1 - x0) * s}" height="${(y1 - y0) * s}" fill="#5e8fb0"/>`);
      continue;
    }
    if (z0 > 100 || br.shape === 'ladder') continue;
    const cx = px((x0 + x1) / 2), cy = py((y0 + y1) / 2), fill = 'fill="#3d352e" fill-opacity="0.75"';
    if (br.shape === 'pillar') out.push(`<circle cx="${cx}" cy="${cy}" r="${(x1 - x0) * s / 2}" ${fill}/>`);
    else {
      out.push(`<rect x="${px(x0)}" y="${py(y1)}" width="${(x1 - x0) * s}" height="${(y1 - y0) * s}" ${fill}` +
        `${br.yaw ? ` transform="rotate(${-br.yaw} ${cx} ${cy})"` : ''}/>`);
    }
  }
  SITES.forEach(([x0, y0, x1, y1], i) => {
    out.push(`<rect x="${px(x0)}" y="${py(y1)}" width="${(x1 - x0) * s}" height="${(y1 - y0) * s}" fill="#e2402a" ` +
      'fill-opacity="0.25" stroke="#e2402a" stroke-width="2"/>');
    out.push(`<text x="${px((x0 + x1) / 2)}" y="${py((y0 + y1) / 2) + 14}" font-size="40" font-weight="bold" ` +
      `fill="#e2402a" text-anchor="middle">${'AB'[i]}</text>`);
  });
  for (const q of project.points) {
    const t = q.kind === 'info_player_deathmatch';
    out.push(`<circle cx="${px(q.o[0])}" cy="${py(q.o[1])}" r="3" fill="${t ? '#c0392b' : '#2f6fc4'}"/>`);
  }
  for (const [name, label] of Object.entries(LABELS)) {
    if (name === 'a_site' || name === 'b_site') continue;
    const r = roomOf.get(name), tall = r[4] - r[2] > r[3] - r[1];
    const cx = px((r[1] + r[3]) / 2), cy = py((r[2] + r[4]) / 2);
    out.push(`<text x="${cx}" y="${cy}" font-size="12" font-weight="bold" fill="#17130f" text-anchor="middle"` +
      `${tall && r[3] - r[1] < 400 ? ` transform="rotate(-90 ${cx} ${cy})"` : ''}>${label}</text>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// --- Out --------------------------------------------------------------------------------

const { errors, warnings } = checkProject(project);
for (const w of warnings) console.log(`warning: ${w.text}`);
if (errors.length) throw new Error(errors.map((e) => e.text).join('\n'));
Deno.writeTextFileSync(new URL(`${NAME}.cmap.json`, OUT), JSON.stringify(project) + '\n');
Deno.writeTextFileSync(new URL(`../docs/maps/${NAME}.svg`, import.meta.url), planSVG());
const light = Deno.args.includes('--draft') ? 'draft' : 'full';
const t0 = performance.now();
const { bytes, stats } = compileProject(project, light);
Deno.writeFileSync(new URL(`${NAME}.bsp`, OUT), bytes);
console.log(`${NAME}: ${project.brushes.length} shapes; ${(bytes.length / 1024).toFixed(0)} KB, ${stats.faces} faces, ` +
  `${stats.nodes} nodes, ${stats.clipnodes} clipnodes, ${stats.leaves} leaves, ${stats.texels} light texels ` +
  `(${light} light, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
