// Maps from outside (a player's own file, a room on the server): validateBSP must turn away
// every file the engine could not run safely, and a file it lets through must play.
import assert from 'node:assert/strict';
import { parseBSP, parseUntrustedBSP, validateBSP, BSP_LIMITS } from '../shared/bsp.js';
import { Trace, traceHull, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { Host } from '../server/host.js';

const MAPS = new URL('../maps/', import.meta.url);
const PLAYGROUND = Deno.readFileSync(new URL('de_playground.bsp', MAPS)); // tracked: always there

Deno.test('every map in maps/ passes the checks', () => {
  for (const e of Deno.readDirSync(MAPS)) {
    if (!e.name.endsWith('.bsp')) continue;
    assert.doesNotThrow(() => parseUntrustedBSP(Deno.readFileSync(new URL(e.name, MAPS)).buffer), e.name);
  }
});

Deno.test('broken indices, cycles, deep trees and far coordinates are turned away', () => {
  const fresh = () => parseBSP(PLAYGROUND.slice().buffer);
  const cases = {
    'node child out of range': (b) => { b.nodesI16[2] = b.numNodes; },
    'node cycle': (b) => { b.nodesI16[1 * 12 + 2] = 0; b.nodesI16[2] = 1; },
    'self loop': (b) => { b.clipnodesI16[2] = 0; },
    'clipnode contents': (b) => { b.clipnodesI16[2] = -40; },
    'leaf out of range': (b) => { b.nodesI16[3] = -b.numLeaves - 1; },
    'edge vertex': (b) => { b.edges[0] = 65535; },
    'surfedge': (b) => { b.surfedges[0] = 1e6; },
    'face texinfo': (b) => { b.facesI16[5] = b.numTexinfo; },
    'face edges': (b) => { b.facesI16[4] = 2; },
    'far vertex': (b) => { b.vertices[0] = 1e6; },
    'nan vertex': (b) => { b.vertices[1] = NaN; },
    'texinfo texture': (b) => { b.texinfoI[8] = b.numTextures; },
    'model head node': (b) => { b.modelsI[9] = b.numNodes; },
    'entity model': (b) => { b.entities.push({ classname: 'func_wall', model: `*${b.numModels}` }); },
    'infinite key': (b) => { b.entities.push({ classname: 'func_breakable', explodemagnitude: '1e39' }); },
    'overflowing key': (b) => { b.entities.push({ classname: 'func_door', speed: '1e999' }); },
    'huge vector': (b) => { b.entities.push({ classname: 'light', origin: '0 1e40 0' }); },
    'tabbed vector': (b) => { b.entities.push({ classname: 'info_player_start', origin: '0\t1e39\t0' }); },
    'model named twice': (b) => { b.entities.push({ classname: 'func_wall', model: '*1' }); },
    'leaf faces': (b) => { b.leavesI16[1 * 14 + 11] = b.marksurfaces.length + 1; },
    'model 0 leaf count': (b) => { b.modelsI[13] = b.numLeaves; },
  };
  assert.doesNotThrow(() => validateBSP(fresh()));
  const words = fresh();
  words.entities.push({ classname: 'trigger_relay', targetname: '1door', target: 'Infinity_room', delay: '0.5' });
  assert.doesNotThrow(() => validateBSP(words), 'names that start with digits or spell numbers are words');
  for (const [what, spoil] of Object.entries(cases)) {
    const b = fresh();
    spoil(b);
    assert.throws(() => validateBSP(b), /^Error: bsp: /, what);
  }
  const deep = fresh();
  assert.throws(() => validateBSP(deep, { ...BSP_LIMITS, depth: 3 }), /too deep/);
  assert.throws(() => validateBSP(fresh(), { ...BSP_LIMITS, models: 2 }), /too many models/);
  assert.throws(() => parseUntrustedBSP(new Uint8Array(64).buffer), /bsp: /, 'not a map');
});

// Each node's levels count wherever it is met: a chain written children first (allowed:
// compilers share subtrees) passed at any depth, and a trace across one past the limit hung.
// A hull 0 node with two parents made the client's per-frame walk exponential.
Deno.test('a tree written children first is held to the depth, and nodes are not shared', () => {
  const fresh = () => parseBSP(PLAYGROUND.slice().buffer);
  assert.doesNotThrow(() => validateBSP(fresh(), { ...BSP_LIMITS, depth: 30 }));
  const chain = fresh();
  for (let k = 0; k < 40; k++) { // clipnode k's child is k - 1
    chain.clipnodesI16[k * 4 + 2] = k ? k - 1 : -1;
    chain.clipnodesI16[k * 4 + 3] = -2;
  }
  assert.throws(() => validateBSP(chain, { ...BSP_LIMITS, depth: 30 }), /clipnode tree too deep/);
  const shared = fresh();
  let i = 0;
  while (shared.nodesI16[i * 12 + 2] < 0 || shared.nodesI16[i * 12 + 3] < 0) i++; // a node over two nodes
  shared.nodesI16[i * 12 + 3] = shared.nodesI16[i * 12 + 2];
  assert.throws(() => validateBSP(shared), /node \d+ shared/);
});

// A trace toward an infinite point (setpos 1e39 is Infinity as a float32) gets NaN fractions;
// backing out of the solid compared NaN < 0 and never ended, freezing every game.
Deno.test('a trace toward an infinite or NaN point ends', () => {
  const log = console.log;
  console.log = () => {};
  try {
    const host = new Host({ loadMap: () => parseBSP(PLAYGROUND.slice().buffer), listMaps: () => ['x'], readCfg: () => null, print: () => {} });
    host.start('x');
    const tr = new Trace();
    for (const hull of [HULL_POINT, HULL_STAND]) {
      for (const end of [Infinity, -Infinity, NaN]) traceHull(host.game.world, hull, 0, 0, 64, 0, end, 64, tr);
    }
  } finally {
    console.log = log;
  }
});

// Random bytes changed in the playground: each file is turned away or plays 200 ticks with
// bots, no tick failing (a tick that throws is caught by Host.step and reported).
Deno.test('fuzz: a mangled map is refused or plays', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const realError = console.error;
  let errors = 0, played = 0;
  console.error = () => errors++;
  const log = console.log;
  console.log = () => {};
  try {
    for (let n = 0; n < 24; n++) {
      const bytes = PLAYGROUND.slice();
      for (let i = 1 + Math.floor(rnd() * 20); i > 0; i--) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
      let bsp;
      try {
        bsp = parseUntrustedBSP(bytes.buffer);
      } catch {
        continue;
      }
      const host = new Host({ loadMap: () => bsp, listMaps: () => ['x'], readCfg: () => null, print: () => {} });
      host.start('x');
      host.con.exec('bot_quota 4');
      for (let t = 0; t < 200; t++) host.step(host.game);
      played++;
    }
  } finally {
    console.error = realError;
    console.log = log;
  }
  assert.ok(played > 3, `some files got through (${played})`);
  assert.equal(errors, 0, 'no tick failed');
});
