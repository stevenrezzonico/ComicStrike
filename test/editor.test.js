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

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};
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

Deno.test('every kind compiles into its entity: doors, button, breakable, water, ladder, zones, decoration', () => {
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
  p.points.push({ id: id++, kind: 'hostage_entity', o: [500, 0, 0], yaw: 90 });
  assert.deepEqual(checkProject(p).errors, []);
  const bsp = compileToBsp(p);
  const cls = bsp.entities.map((e) => e.classname);
  for (const k of Object.keys(KINDS)) if (k !== 'world') assert.ok(cls.includes(k), k);
  const rot = bsp.entities.find((e) => e.classname === 'func_door_rotating');
  assert.equal(rot.origin, hingeOf(p.brushes.find((b) => b.kind === 'func_door_rotating')).join(' '), 'hinged at its end');
  assert.equal(rot.hinge, undefined, 'the editor\'s own key stays out');
  const game = quiet(() => new Game('my_map', bsp, { rounds: false }));
  assert.equal(game.doors.count, 3, 'two doors and a button');
  const world = CollisionWorld.fromBSP(bsp);
  assert.equal(pointContents(world, 500, 500, 10), -3, 'water');
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
    brushes: [{ b: [0, 0, 0, 1.4, 64, 64], tex: { top: 'not_a_texture', side: 'crate08' }, kind: 'func_nuke', keys: { 'a"b': 1, ok: 'x"y' } }],
    points: [{ kind: 'weapon_awp', o: [0, 0, 0] }, { kind: 'hostage_entity', o: [1, 2, 3], yaw: 450 }],
  });
  assert.equal(odd.name, '___evil_name');
  assert.deepEqual(odd.brushes[0].b, [0, 0, 0, 1, 64, 64]);
  assert.deepEqual(odd.brushes[0].tex, { top: null, bottom: null, side: 'crate08' });
  assert.equal(odd.brushes[0].kind, 'world');
  assert.deepEqual(odd.brushes[0].keys, { ok: "x'y" });
  assert.equal(odd.points.length, 1);
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
