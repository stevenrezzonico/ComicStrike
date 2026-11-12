// The map editor's projects (client/editor/project.js) through our box compiler
// (shared/bspwriter.js) into maps the game plays.
import assert from 'node:assert/strict';
import {
  newProject, readProject, checkProject, compileProject, projectToBuilder, hingeOf, KINDS, TEXTURES,
} from '../client/editor/project.js';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { CollisionWorld, Trace, traceHull, pointContents, entityContents, HULL_STAND, ENT_LADDER } from '../shared/trace.js';
import { Game } from '../server/game.js';
import { Host } from '../server/host.js';
import { textureRecord } from '../client/texcolors.js';
import { quiet } from './harness.js';

const compileToBsp = (p, light = 'draft') => parseUntrustedBSP(compileProject(p, light).bytes.buffer);

Deno.test('every editor texture has its measured color', () => {
  // (the sky prints as sky; the conveyor top keeps its name class: scroll*)
  for (const [name] of TEXTURES) if (name !== 'sky' && name !== 'scroll_conv') assert.ok(textureRecord(name), name);
});

Deno.test('the starter project compiles, is checked clean and the same every time', () => {
  const p = newProject();
  assert.deepEqual(checkProject(p), { errors: [], warnings: [] });
  const a = compileProject(p, 'full').bytes, b = compileProject(p, 'full').bytes;
  assert.deepEqual(a, b, 'deterministic');
  const bsp = parseUntrustedBSP(a.buffer);
  assert.equal(bsp.entities.filter((e) => e.classname === 'info_player_deathmatch').length, 5);
  assert.equal(bsp.entities.filter((e) => e.classname === 'func_buyzone').length, 2);
  assert.ok(bsp.lighting.length > 0, 'baked light');
});

Deno.test('spawns stand on the floor and the sky box closes the map', () => {
  const bsp = compileToBsp(newProject());
  const world = CollisionWorld.fromBSP(bsp);
  const t = new Trace();
  // A T spawn: hull center 37 over the floor; dropping it lands on the floor (feet at 0).
  traceHull(world, HULL_STAND, -864, -256, 37, -864, -256, -200, t);
  assert.ok(!t.startsolid && t.fraction < 1);
  assert.ok(Math.abs(t.endz - 36) < 0.1, `feet on the floor (${t.endz})`);
  // Up and out over the walls: the sky box stops the player.
  traceHull(world, HULL_STAND, 0, 0, 37, 0, 0, 5000, t);
  assert.ok(t.fraction < 1, 'a ceiling of sky');
  traceHull(world, HULL_STAND, 0, 0, 300, 5000, 0, 300, t);
  assert.ok(t.fraction < 1 && t.endx < 1200, 'sky walls past the walls');
  assert.equal(pointContents(world, 0, 0, -5000), -2, 'solid beyond the map');
});

Deno.test('a game with bots runs on an editor map', () => {
  const bsp = compileToBsp(newProject());
  const host = quiet(() => {
    const h = new Host({ loadMap: () => bsp, listMaps: () => ['my_map'], readCfg: () => null, print: () => {} });
    h.start('my_map');
    h.con.exec('bot_quota 6');
    for (let i = 0; i < 640; i++) h.step(h.game);
    return h;
  });
  assert.equal(host.failedTicks, 0);
  assert.equal(host.game.clients.filter((c) => c && c.bot).length, 6);
  for (const c of host.game.clients) if (c && c.alive) assert.ok(c.player.ps.f[2] > 30 && c.player.ps.f[2] < 60, 'bots on the floor');
});

Deno.test('every kind compiles into its entity: doors, button, breakable, water, ladder, zones, decoration, glass wall, movers, triggers, logic points', () => {
  const p = newProject();
  let id = 1000;
  const add = (kind, b, tex = { top: 'crate08', bottom: 'crate08', side: 'crate08' }, keys = {}) =>
    p.brushes.push({ id: id++, b, tex, kind, keys: { ...KINDS[kind].keys, ...keys } });
  add('func_door', [-200, 300, 0, -184, 428, 128], undefined, { targetname: 'gate' });
  add('func_button', [-260, 300, 48, -256, 316, 64], undefined, { target: 'gate' });
  add('func_door_rotating', [-200, -428, 0, -188, -300, 127]);
  add('func_breakable', [300, -300, 0, 364, -236, 64]);
  add('func_water', [400, 400, 0, 600, 600, 30], { top: '!watergreen', bottom: null, side: null });
  add('func_ladder', [-600, 700, 0, -560, 716, 160], { top: null, bottom: null, side: null });
  add('func_bomb_target', [-300, 400, 0, 0, 700, 128], { top: null, bottom: null, side: null });
  add('func_conveyor', [0, 500, 0, 300, 560, 8], { top: 'scroll_conv', bottom: null, side: 'steel' });
  add('func_hostage_rescue', [700, -700, 0, 960, -500, 128], { top: null, bottom: null, side: null });
  add('func_illusionary', [-700, -700, 120, -600, -600, 136]);
  add('func_wall', [600, 0, 0, 604, 128, 128], { top: 'glass_med', bottom: 'glass_med', side: 'glass_med' });
  add('func_rot_button', [-260, 340, 36, -256, 364, 60], undefined, { target: 'gate' });
  add('func_plat', [100, -200, 112, 180, -120, 128]);
  add('momentary_door', [-200, 500, 0, -184, 628, 128], undefined, { targetname: 'hatch' });
  add('momentary_rot_button', [-260, 540, 36, -256, 564, 60], undefined, { target: 'hatch' });
  add('func_train', [700, 200, 0, 764, 264, 16], undefined, { target: 'c1' });
  add('func_rotating', [-700, 200, 140, -500, 216, 150]);
  add('func_pendulum', [-700, 400, 60, -680, 440, 180]);
  add('func_pushable', [700, -600, 0, 764, -536, 64]);
  add('func_water', [400, -600, 0, 600, -400, 30], { top: '!toxicgrn', bottom: null, side: null }, { skin: '-4' });
  const zone = { top: null, bottom: null, side: null };
  add('trigger_hurt', [-900, -300, 0, -800, -200, 64], zone);
  add('trigger_teleport', [-900, 300, 0, -800, 400, 64], zone, { target: 'out' });
  add('trigger_multiple', [-900, 0, 0, -800, 100, 64], zone, { target: 'hello' });
  const point = (kind, o, keys) => p.points.push({ id: id++, kind, o, yaw: 90, keys });
  point('hostage_entity', [500, 0, 0]);
  point('path_corner', [732, 232, 8], { targetname: 'c1', target: 'c2', wait: '1' });
  point('path_corner', [732, 600, 8], { targetname: 'c2', target: 'c1' });
  point('info_teleport_destination', [0, -400, 0], { targetname: 'out' });
  point('game_text', [-850, 50, 64], { targetname: 'hello', message: 'hello' });
  point('env_explosion', [0, 0, 32], { targetname: 'boom', iMagnitude: '50' });
  point('multi_manager', [0, 0, 64], { targetname: 'mm', boom: '1', hello: '2' });
  point('trigger_relay', [0, 0, 96], { targetname: 'relay', target: 'mm' });
  point('trigger_auto', [0, 0, 128], { target: 'relay' });
  point('multisource', [0, 0, 160], { targetname: 'lock' });
  assert.deepEqual(checkProject(p).errors, []);
  assert.deepEqual(checkProject(readProject(JSON.stringify(p))).warnings, [], 'the train and the teleport find their points');
  const bsp = compileToBsp(readProject(JSON.stringify(p))); // the points' keys go through a file
  const cls = bsp.entities.map((e) => e.classname);
  for (const k of Object.keys(KINDS)) if (k !== 'world') assert.ok(cls.includes(k), k);
  const ent = (c) => bsp.entities.find((e) => e.classname === c);
  assert.equal(ent('func_rotating').origin, '-600 208 145', 'a fan turns about its middle');
  assert.equal(ent('func_pendulum').origin, '-690 420 180', 'a pendulum hangs from the middle of its top');
  assert.equal(ent('info_teleport_destination').origin, '0 -400 0', 'an exit by its feet');
  assert.equal(ent('path_corner').origin, '732 232 8', 'a corner where it is');
  assert.equal(ent('path_corner').wait, '1');
  assert.equal(ent('multi_manager').boom, '1', 'a relay list keeps its own keys');
  assert.equal(bsp.entities.filter((e) => e.classname === 'func_water').map((e) => e.skin).join(), '-3,-4', 'water by default, slime by its skin');
  const rot = bsp.entities.find((e) => e.classname === 'func_door_rotating');
  assert.equal(rot.origin, hingeOf(p.brushes.find((b) => b.kind === 'func_door_rotating')).join(' '), 'hinged at its end');
  assert.equal(rot.hinge, undefined, 'the editor\'s own key stays out');
  const glass = bsp.entities.find((e) => e.classname === 'func_wall');
  assert.equal(`${glass.rendermode} ${glass.renderamt}`, '2 90', 'a glass wall, see-through');
  const valve = bsp.entities.find((e) => e.classname === 'func_rot_button');
  assert.equal(valve.origin, '-258 352 48', 'a valve turns about its middle');
  const game = quiet(() => new Game('my_map', bsp, { rounds: false }));
  assert.equal(game.doors.count, 11, 'two doors, a button, a valve, a lift, a follower door, its wheel, a train, a fan, a pendulum, a crate');
  const world = CollisionWorld.fromBSP(bsp);
  assert.equal(pointContents(world, 500, 500, 10), -3, 'water');
  assert.equal(pointContents(world, 500, -500, 10), -4, 'slime');
  assert.ok(world.teleports && world.teleports.length === 1, 'the teleport and its exit');
  assert.equal(game.hostages.spots.length, 1);
});

Deno.test('problems: no spawns, a spawn in a wall or over nothing, flat boxes, a button with no door', () => {
  const p = newProject();
  p.points = p.points.filter((q) => q.kind !== 'info_player_start');
  assert.match(checkProject(p).errors.map((e) => e.text).join(), /No CT spawn/);
  assert.throws(() => compileProject(p), /No CT spawn/);
  const q = newProject();
  q.points[0].o = [-1040, 0, 0]; // in the west wall
  q.points[1].o = [5000, 0, 0]; // out in the void: no floor
  q.brushes.push({ id: 900, b: [0, 0, 0, 64, 0, 64], tex: { top: 'crate08', bottom: 'crate08', side: 'crate08' }, kind: 'world', keys: {} });
  q.brushes.push({ id: 901, b: [0, 0, 0, 8, 8, 8], tex: { top: 'crate08', bottom: 'crate08', side: 'crate08' }, kind: 'func_button',
    keys: { target: 'nowhere' } });
  const { errors, warnings } = checkProject(q);
  assert.ok(errors.some((e) => e.id === q.points[0].id && /inside a shape/.test(e.text)));
  assert.ok(warnings.some((e) => e.id === q.points[1].id && /no floor/.test(e.text)));
  assert.ok(errors.some((e) => e.id === 900 && /no volume/.test(e.text)));
  assert.ok(warnings.some((e) => e.id === 901 && /nowhere/.test(e.text)));
});

Deno.test('projects read back from JSON, cleaned of what they should not hold', () => {
  const p = newProject('de_test');
  const back = readProject(JSON.stringify(p));
  assert.deepEqual(back.brushes.map((b) => b.b), p.brushes.map((b) => b.b));
  assert.equal(back.name, 'de_test');
  const odd = readProject({
    format: 'comicstrike-map', version: 1, name: '../evil name',
    brushes: [{ b: [0, 0, 0, 1.4, 64, 64], tex: { top: 'not a texture', side: 'crate08' }, kind: 'func_nuke', keys: { 'a"b': 1, ok: 'x"y' } }, { b: [0, 0, 0, 64, 64] }],
    points: [{ kind: 'weapon_awp', o: [0, 0, 0] }, { kind: 'hostage_entity', o: [1, 2, 3], yaw: 450 }, { kind: 'light', o: [1, 2] }],
  });
  assert.equal(odd.name, '___evil_name');
  assert.deepEqual(odd.brushes[0].b, [0, 0, 0, 1, 64, 64]);
  assert.deepEqual(odd.brushes[0].tex, { top: null, bottom: null, side: 'crate08' });
  assert.equal(odd.brushes[0].kind, 'world');
  assert.deepEqual(odd.brushes[0].keys, { ok: "x'y" });
  assert.equal(odd.brushes.length, 1, 'a box with five numbers is left out');
  assert.equal(odd.points.length, 1, 'and so is a lamp with two (and a kind the editor has no point for)');
  assert.equal(odd.points[0].yaw, 90);
  assert.throws(() => readProject('{"format":"something"}'), /not a ComicStrike map/);
});

Deno.test('the builder keeps the sky box out of the project bounds it is built from', () => {
  const map = projectToBuilder(newProject());
  const sky = map.world.filter((b) => b.sky);
  assert.equal(sky.length, 6);
});

Deno.test('shapes: ramps, angled walls, pillars, stairs and ladders compile and play', async () => {
  const { makeBrush, piecesOf, slopeOf, SHAPES } = await import('../client/editor/project.js');
  const p = newProject();
  const T = { top: 'crete3_wall02', bottom: 'crete3_wall02', side: 'crete3_wall02' };
  let id = 2000;
  const add = (b, shape) => p.brushes.push(makeBrush(id++, b, T, 'world', {}, shape));
  add([-400, 300, 0, -144, 500, 128], { shape: 'ramp', up: 'px' });
  add([0, -500, 0, 400, -468, 160], { shape: 'box', yaw: 30 });
  add([300, 300, 0, 400, 400, 200], { shape: 'pillar', sides: 12 });
  add([-600, -500, 0, -344, -380, 128], { shape: 'stairs', up: 'nx', step: 16 });
  add([-1000, 600, 0, -980, 664, 192], { shape: 'ladder', up: 'nx' });
  assert.deepEqual(checkProject(p).errors, []);
  assert.equal(Math.round(slopeOf(p.brushes.at(-5))), 27);
  assert.equal(piecesOf(p.brushes.at(-2)).length, 8, 'eight 16-unit steps');
  const ladder = piecesOf(p.brushes.at(-1));
  assert.deepEqual(ladder.map((pc) => pc.kind), ['world', 'func_ladder']);
  const bsp = compileToBsp(p);
  assert.ok(bsp.entities.some((e) => e.classname === 'func_ladder'));
  const world = CollisionWorld.fromBSP(bsp);
  const t = new Trace();
  // Down onto the stairs' third step from the low (east) end (x -440..-408): 3 · 16 high.
  traceHull(world, HULL_STAND, -424, -440, 200, -424, -440, 0, t);
  assert.ok(Math.abs(t.endz - 36 - 48) < 0.5, `on the third step (${t.endz - 36})`);
  // The ladder's volume is a climbable entity in front of its board.
  const li = world.ents.findIndex((e) => e.kind === ENT_LADDER);
  assert.ok(li > 0, 'a ladder entity');
  assert.notEqual(entityContents(world, li, HULL_STAND, -975, 632, 100), -1, 'touching it in front of the board');
  for (const k of Object.keys(SHAPES)) if (!SHAPES[k].made) assert.ok(p.brushes.some((b) => b.shape === k), k);
  const steep = makeBrush(1, [0, 0, 0, 64, 64, 128], T, 'world', {}, { shape: 'ramp', up: 'px' });
  const q = newProject();
  q.brushes.push(steep);
  assert.ok(checkProject(q).warnings.some((w) => /slide off/.test(w.text)), 'too steep');
  // Version 1 files read as boxes.
  const v1 = readProject({ format: 'comicstrike-map', version: 1, brushes: [{ b: [0, 0, 0, 8, 8, 8], tex: T, kind: 'world' }] });
  assert.equal(v1.brushes[0].shape, 'box');
  assert.equal(v1.brushes[0].yaw, 0);
});

Deno.test('lamps: a lamp point compiles to a light entity with its keys, reads back, and warns inside a shape', async () => {
  const p = newProject();
  p.points.push({ id: 700, kind: 'light', o: [0, 0, 112], yaw: 0, keys: { _light: '255 200 150 180' } });
  p.points.push({ id: 701, kind: 'light_spot', o: [200, 0, 160], yaw: 90, keys: { _light: '255 255 255 250', pitch: '-60', _cone: '25', _cone2: '40' } });
  assert.deepEqual(checkProject(p), { errors: [], warnings: [] });
  const bsp = compileToBsp(p, 'full');
  const bulb = bsp.entities.find((e) => e.classname === 'light'), spot = bsp.entities.find((e) => e.classname === 'light_spot');
  assert.equal(bulb.origin, '0 0 112', 'a lamp is where it is (no hull offset)');
  assert.equal(bulb._light, '255 200 150 180');
  assert.equal(spot.angles, '0 90 0');
  assert.equal(spot.pitch, '-60');
  assert.equal(spot._cone2, '40');
  // Through JSON and the map's trailer, the keys come back; a lamp with none gets the defaults.
  const back = readProject(JSON.stringify(p));
  assert.deepEqual(back.points.find((q) => q.kind === 'light_spot').keys, p.points[p.points.length - 1].keys);
  const bare = readProject({ format: 'comicstrike-map', version: 3, name: 'x', brushes: [], points: [{ kind: 'light', o: [1, 2, 3] }] });
  assert.equal(bare.points[0].keys._light, '255 235 190 200');
  const { withProject, projectIn } = await import('../client/editor/project.js');
  const again = await projectIn(await withProject(new Uint8Array(16), p));
  assert.deepEqual(again.points.map((q) => q.keys), p.points.map((q) => q.keys));
  // A lamp inside the west wall lights nothing: a warning, not an error.
  p.points.push({ id: 702, kind: 'light', o: [-1040, 0, 100], yaw: 0, keys: {} });
  const { errors, warnings } = checkProject(p);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.id === 702 && /lights nothing/.test(w.text)));
});

// A crafted project hung the editor (and, autosaved first, at every visit): stairs 4e9 units
// tall were a billion pieces. Coordinates are kept within twice the limit, a stairs shape
// has at most MAX_STAIR_STEPS steps, and a project at most as many pieces as 12,000 boxes.
Deno.test('a crafted project cannot make the editor build millions of pieces', async () => {
  const { piecesOf, LIMITS, MAX_STAIR_STEPS } = await import('../client/editor/project.js');
  const p = readProject({ format: 'comicstrike-map', version: 3, brushes: [{ shape: 'stairs', b: [0, 0, 0, 64, 64, 4e9], step: 4 }] });
  assert.equal(p.brushes[0].b[5], 2 * LIMITS.coord);
  assert.equal(piecesOf(p.brushes[0]).length, MAX_STAIR_STEPS);
  // 12,000 stairs of 64 steps were 768k pieces: the shapes past the budget are left out.
  const budget = 4 * LIMITS.brushes;
  const stairs = Array.from({ length: budget }, () => ({ shape: 'stairs', b: [0, 0, 0, 64, 64, 1024], step: 16 }));
  const many = readProject({ format: 'comicstrike-map', version: 3, brushes: stairs });
  assert.equal(many.brushes.length, Math.floor(budget / MAX_STAIR_STEPS));
  assert.ok(many.brushes.reduce((n, b) => n + piecesOf(b).length, 0) <= budget);
});

// A shape pasted from an opened map keeps that map's textures through a reload: the paste
// carries no sizes, and readProject dropped every name in neither table (the faces with it).
Deno.test('a texture of another map, pasted, survives a reload at a default size', () => {
  const p = newProject('de_test');
  p.brushes.push({ ...p.brushes[1], id: 999, tex: { top: '-0wall_mine', bottom: null, side: 'dust_wall9' } });
  const back = readProject(JSON.stringify(readProject(JSON.stringify(p))));
  assert.deepEqual(back.brushes.at(-1).tex, { top: '-0wall_mine', bottom: null, side: 'dust_wall9' });
  assert.deepEqual(back.textures['dust_wall9'], [64, 64]);
  compileToBsp(back);
});

Deno.test('water with no top texture compiles as water', () => {
  // The properties panel lets the Top be (none): the compiler's water is then !watergreen.
  const p = newProject();
  p.brushes.push({ id: 999, b: [300, 300, 0, 556, 556, 32], tex: { top: null, bottom: null, side: null }, kind: 'func_water', keys: { skin: '-3' },
    shape: 'box' });
  assert.equal(pointContents(CollisionWorld.fromBSP(compileToBsp(readProject(JSON.stringify(p)))), 400, 400, 16), -3);
});

Deno.test('a teleport and an exit both with no name warn: the teleport goes nowhere', () => {
  const p = newProject();
  p.brushes.push({ id: 998, b: [0, 300, 0, 64, 364, 72], tex: { top: null, bottom: null, side: null }, kind: 'trigger_teleport',
    keys: { ...KINDS.trigger_teleport.keys }, shape: 'box' });
  p.points.push({ id: 999, kind: 'info_teleport_destination', o: [500, 500, 0], yaw: 0, keys: { targetname: '' } });
  assert.ok(checkProject(p).warnings.some((w) => w.id === 998 && /Teleport exit/.test(w.text)));
});

// The editor page itself (client/editor/editor.js) without its page: its methods on an object
// with stubs for the panels, the worker, and the browser's storage and dialogs.
async function bareEditor(fields = {}) {
  const { Editor } = await import('../client/editor/editor.js');
  return Object.assign(Object.create(Editor.prototype), { project: newProject(), selection: new Set(), status() {}, ...fields });
}
async function withGlobals(stubs, fn) {
  const old = Object.keys(stubs).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const [k, v] of Object.entries(stubs)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    for (const [k, d] of old) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
}

Deno.test('editor: Open asks before replacing a map with shapes, as New and Example do', async () => {
  const ed = await bareEditor({ commit() {}, changed() {}, fitAll() {} });
  const before = ed.project, asked = [];
  const file = { name: 'other.cmap.json', arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(newProject('other'))).buffer) };
  await withGlobals({ confirm: (q) => (asked.push(q), false) }, () => ed.openFile(file));
  assert.equal(asked.length, 1, 'asked');
  assert.ok(ed.project === before, 'kept when the answer is no');
  await withGlobals({ confirm: () => true }, () => ed.openFile(file));
  assert.equal(ed.project.name, 'other');
});

Deno.test('editor: an autosave past the quota is said once, and the next visit says its map is older', async () => {
  const store = new Map(), said = [];
  let full = false;
  const localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      if (full && v.length > 100) throw new DOMException('the quota is reached', 'QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };
  await withGlobals({ localStorage, alert: (m) => said.push(m) }, async () => {
    const ed = await bareEditor();
    ed.save();
    const kept = store.get('comicstrike.editor');
    full = true;
    ed.project.brushes.pop();
    ed.save();
    ed.save();
    assert.equal(said.length, 1, 'told once');
    assert.ok(store.get('comicstrike.editor') === kept, 'the older map stays');
    const next = await bareEditor();
    assert.equal(next.load().brushes.length, ed.project.brushes.length + 1);
    assert.equal(said.length, 2);
    assert.match(said[1], /older/);
    full = false;
    next.save();
    next.load();
    assert.equal(said.length, 2, 'a save that fits clears the mark');
  });
});

Deno.test('editor: one preview compile at a time, and one more after it when edits came', async () => {
  const jobs = [], tick = () => new Promise((r) => setTimeout(r, 0));
  const ed = await bareEditor({
    previewReady: true, previewNext: 0, jobId: 0,
    compile() {
      const id = ++this.jobId;
      return new Promise((resolve) => jobs.push(() => resolve({ id, error: 'stub' })));
    },
  });
  for (let i = 0; i < 5; i++) ed.updatePreview();
  assert.equal(jobs.length, 1, 'the edits wait for the compile in the worker');
  jobs[0]();
  await tick();
  assert.equal(jobs.length, 2, 'then one more, of the map as it is then');
  jobs[1]();
  await tick();
  assert.equal(jobs.length, 2, 'and none after it');
});

Deno.test('editor: the undo history keeps at most UNDO_CHARS of projects, the newest first', async () => {
  const { UNDO_CHARS } = await import('../client/editor/editor.js');
  // Steps of 6 MB of JSON: 64 MB holds 10 of them (it held 200: a decompiled map's edits).
  const ed = await bareEditor({ undoStack: [], redoStack: [], project: { pad: 'x'.repeat(6 << 20), n: 0 } });
  for (let i = 0; i < 14; i++) {
    ed.project.n = i;
    ed.commit();
  }
  const chars = ed.undoStack.reduce((a, s) => a + s.length, 0);
  assert.ok(chars <= UNDO_CHARS, `${chars} characters kept`);
  assert.equal(ed.undoStack.length, 10);
  assert.equal(JSON.parse(ed.undoStack.at(-1)).n, 13, 'the newest step kept');
});

Deno.test('editor: copies of an entity\'s shapes are an entity of their own, and turning or mirroring takes its hinge along', async () => {
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  await withGlobals({ localStorage }, async () => {
    // A door in two shapes as an opened map brings it, hinged at 0 0 64 (`origin`: from each
    // shape's low corner).
    const q = newProject();
    const steel = { top: 'steel', bottom: 'steel', side: 'steel' };
    for (const [id, b] of [[900, [0, -4, 0, 64, 4, 128]], [901, [48, 4, 56, 56, 10, 64]]]) {
      q.brushes.push({ id, b, tex: steel, kind: 'func_door_rotating', keys: { distance: '90', speed: '100' }, shape: 'box',
        entity: 7, origin: [-b[0], -b[1], 64 - b[2]] });
    }
    const ed = await bareEditor({ project: readProject(JSON.stringify(q)), grid: 16,
      commit() {}, changed() {}, redraw() {}, renderProps() {}, tellPreviewSelection() {} });
    const doors = () => ed.project.brushes.filter((b) => b.kind === 'func_door_rotating');
    const hinges = () => compileToBsp(ed.project).entities.filter((e) => e.classname === 'func_door_rotating').map((e) => e.origin);
    assert.deepEqual(hinges(), ['0 0 64']);
    ed.select(doors().map((b) => b.id));
    ed.copy();
    ed.duplicate();
    const copies = doors().slice(2);
    assert.ok(copies[0].entity === copies[1].entity && copies[0].entity !== doors()[0].entity, 'a new entity of both copies');
    assert.deepEqual(hinges(), ['0 0 64', '16 16 64']);
    ed.paste();
    assert.equal(new Set(doors().map((b) => b.entity)).size, 3);
    assert.deepEqual(hinges(), ['0 0 64', '16 16 64', '16 16 64']);
    // The copies (x 16..80, y 12..26) a quarter turn about their middle, then mirrored.
    ed.select(copies.map((b) => b.id));
    ed.rotate90();
    assert.equal(hinges()[1], '51 -13 64');
    ed.mirror();
    assert.equal(hinges()[1], '45 -13 64');
  });
});
