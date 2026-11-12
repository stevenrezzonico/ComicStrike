// The movers beyond doors and buttons (shared/doors.js): lifts (func_plat), trains on
// path_corners, rotating buttons, momentary doors driven by wheels, killtarget and
// master; and what breakables set off (shared/breakables.js, server/game.js): their
// targets, their explosions, the blasts that break them.
import assert from 'node:assert/strict';
import { box, NONE } from '../shared/bspwriter.js';
import { Trace, traceHull, hullFits, HULL_POINT, HULL_STAND, ENT_NONE, ENT_SOLID } from '../shared/trace.js';
import { PS_ORIGIN, PS_VEL, PS_GROUNDENT } from '../shared/pmove.js';
import { IN_USE, IN_ATTACK, IN_FORWARD, TICK_RATE } from '../shared/constants.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { Writer } from '../shared/protocol.js';
import { WEAPON_ID, WS_ACTIVE, giveWeapon, SLOT_PRIMARY } from '../shared/weapons.js';
import {
  MOVER_PLAT, MOVER_TRAIN, MOVER_BUTTON, MOVER_MOMENTARY, MOVER_WHEEL, MOVER_SPIN, MOVER_PENDULUM, MOVER_PUSH, MAX_FIRES, MAX_QUEUED,
} from '../shared/doors.js';
import { blastDamage } from '../shared/breakables.js';
import { Game } from '../server/game.js';
import { W, yard, walker, quiet, joinClient } from './harness.js';

const ticksOf = (s) => Math.round(s * TICK_RATE);

// --- Lifts ----------------------------------------------------------------------------

Deno.test('func_plat: a lift rises under whoever steps on it, waits 3 s at the top, comes down', () => {
  const bsp = yard((map) => {
    // Drawn at its top (128 up), it starts 128 lower: 2 units proud of the floor.
    map.brushEntity({ classname: 'func_plat', height: '128', speed: '200' }, [box(0, -40, 114, 80, 40, 130, 'steel')]);
  });
  const { game, c, run, put, feet } = walker(bsp);
  const d = game.doors, k = 0;
  assert.equal(d.count, 1);
  assert.equal(d.kind[k], MOVER_PLAT);
  assert.ok(d.atBottom(k));
  const tr = new Trace();
  traceHull(game.world, HULL_POINT, 40, 0, 40, 40, 0, -40, tr);
  assert.ok(Math.abs(tr.endz - 2) < 0.1, `rests 2 proud of the floor (top at ${tr.endz})`);
  put(40, 0, 2); // standing on it
  run(2);
  assert.equal(d.dir[k], 1, 'called up by its column');
  run(ticksOf(128 / 200) + 4);
  assert.ok(d.atTop(k), 'at the top');
  assert.ok(Math.abs(feet() - 130) < 1, `rode up on it (feet at ${feet().toFixed(1)})`);
  assert.equal(c.player.ps.i[PS_GROUNDENT], d.ent[k], 'standing on the lift');
  run(ticksOf(3) + 2);
  assert.equal(d.dir[k], -1, 'back down after 3 s');
  run(ticksOf(64 / 200));
  assert.ok(feet() < 110 && feet() > 20, `riding down (feet at ${feet().toFixed(1)})`);
  put(-900, 0, 0); // off it: a rider still on it at the bottom calls it straight up again (CPlatTrigger)
  run(ticksOf(64 / 200) + 4);
  assert.ok(d.atBottom(k), 'down');
});

// --- Trains -----------------------------------------------------------------------------

Deno.test('func_train: a cart runs corner to corner at its speed, waits where told, carries a rider, stops and goes on use', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_train', target: 'c1', speed: '160', targetname: 'cart' },
      [box(-32, -32, 0, 32, 32, 16, 'steel')]);
    map.point({ classname: 'path_corner', targetname: 'c1', target: 'c2', origin: '0 0 8', wait: '1' });
    map.point({ classname: 'path_corner', targetname: 'c2', target: 'c3', origin: '320 0 8' });
    map.point({ classname: 'path_corner', targetname: 'c3', target: 'c1', origin: '320 240 8', speed: '80' });
    // A trigger starts it (a named train waits for one).
    map.brushEntity({ classname: 'trigger_once', target: 'cart' }, [box(-600, -100, 0, -500, 100, 100, NONE)]);
  });
  const { game, c, run, put, pos } = walker(bsp);
  const d = game.doors, k = 0, p = d.path[k];
  assert.equal(d.kind[k], MOVER_TRAIN);
  assert.equal(p.count, 3);
  assert.deepEqual([...p.next], [1, 2, 0], 'a loop');
  assert.equal(d.stopped[k], 1, 'named: waits for its trigger');
  const e = game.world.ents[d.ent[k]];
  assert.deepEqual([e.ox, e.oy, e.oz], [0, 0, 0], 'its center starts on the first corner');
  put(-550, 0, 0); // into the trigger
  run(3);
  assert.equal(d.stopped[k], 0);
  assert.equal(d.dir[k], 1, 'off along the first leg');
  const legTicks = Math.ceil(320 / 160 * TICK_RATE);
  run(Math.floor(legTicks / 2));
  assert.ok(Math.abs(e.ox - 160) < 8, `half way along +x (${e.ox.toFixed(1)})`);
  // Standing on it: carried along.
  put(e.ox, 0, 16);
  run(16);
  assert.equal(c.player.ps.i[PS_GROUNDENT], d.ent[k], 'riding');
  assert.ok(pos()[PS_ORIGIN] > 160 + 16 * 160 / TICK_RATE - 4, `carried (x ${pos()[PS_ORIGIN].toFixed(1)})`);
  // +use stops it where it is; +use again sends it on.
  put(-900, 0, 0);
  const x0 = e.ox;
  game.logic.fireAt(game.tick, 'cart', null, 0);
  run(8);
  assert.equal(d.dir[k], 0, 'stopped');
  assert.equal(e.ox, x0, 'where it was');
  game.logic.fireAt(game.tick, 'cart', null, 0);
  run(Math.ceil((1 - d.from[k]) / p.rate[0]) + 1); // the rest of the leg
  assert.equal(d.leg[k], 1, 'arrived at the second corner');
  assert.ok(Math.abs(e.ox - 320) < 0.01 && e.oy >= 0 && e.oy < 16, `on it, and straight on along +y (no wait there): ${e.oy.toFixed(1)}`);
  assert.equal(d.dir[k], 1);
  // The third corner sets the speed to 80 for the leg out of it.
  run(Math.ceil(240 / 160 * TICK_RATE) + 1);
  assert.equal(d.leg[k], 2);
  const back = Math.hypot(320, 240);
  assert.ok(Math.abs(p.rate[2] - 80 / back / TICK_RATE) < 1e-12, 'slower on the way back');
  run(Math.ceil(back / 80 * TICK_RATE) + 1);
  assert.equal(d.leg[k], 0, 'round the loop');
  assert.ok(d.atBottom(k) && d.next[k] > game.tick, 'waiting its second at the first corner');
  assert.ok(d.idle(k), 'the state a snapshot leaves out');
  run(ticksOf(1) + 1);
  assert.equal(d.dir[k], 1, 'and off again');
});

// --- Rotating buttons -------------------------------------------------------------------

Deno.test('func_rot_button: a valve turns a quarter on use, fires its door, and comes back', () => {
  const bsp = yard((map) => {
    // A wheel on a post, turning about its own axis (x: GoldSrc's "rotate z" flag 64 adds
    // to the roll), beside a toggle door.
    map.world.push(box(0, -12, 0, 20, 12, 80, 'steel'));
    map.brushEntity({ classname: 'func_rot_button', target: 'gate', origin: '-2 0 48', spawnflags: '64', distance: '90',
      speed: '180', wait: '1' }, [box(-4, -12, 36, 0, 12, 60, 'steel')]);
    map.brushEntity({ classname: 'func_door', targetname: 'gate', angle: '-1', speed: '400', wait: '-1', spawnflags: '32', lip: '8' },
      [box(200, -64, 0, 216, 64, 128, 'steel')]);
  });
  const { game, run, put } = walker(bsp);
  const d = game.doors, valve = d.name.indexOf('') === 0 ? 0 : 1, gate = d.name.indexOf('gate');
  assert.equal(d.kind[valve], MOVER_BUTTON);
  assert.equal(d.turns[valve], 1);
  // West of it, facing east, out of its reach: a turned wheel is traced with the unturned
  // player hull in its own space (GoldSrc), so a player right against it blocks its return.
  put(-66, 0, 0);
  run(4, 0, 0);
  assert.ok(d.atBottom(gate));
  run(2, IN_USE, 0);
  assert.equal(d.dir[valve], 1, 'turning');
  run(ticksOf(90 / 180) + 2, 0, 0);
  assert.ok(d.atTop(valve) || d.next[valve] > 0, 'turned');
  assert.equal(d.dir[gate], 1, 'the gate opens');
  // Turned a quarter about x, the wheel (24 tall, 24 wide) now stands the same: a trace
  // along y through its top corner finds it where the untouched wheel was not.
  const e = game.world.ents[d.ent[valve]];
  assert.ok(e.rot, 'turned');
  run(ticksOf(1) + ticksOf(90 / 180) + 4, 0, 0);
  assert.ok(d.atBottom(valve), 'back after its second');
  assert.equal(e.rot, null);
  run(ticksOf(128 / 400) + 4, 0, 0);
  assert.ok(d.atTop(gate), 'the gate stays open');
  run(2, IN_USE, 0);
  run(ticksOf(90 / 180) + 2, 0, 0);
  assert.equal(d.dir[gate], -1, 'the next turn closes it');
});

// --- Momentary doors --------------------------------------------------------------------

Deno.test('momentary_rot_button: a wheel turns while +use is held and its door follows the wheel', () => {
  const bsp = yard((map) => {
    map.world.push(box(0, -12, 0, 20, 12, 80, 'steel'));
    map.brushEntity({ classname: 'momentary_rot_button', target: 'hatch', origin: '-2 0 48', spawnflags: '64', distance: '180',
      speed: '180' }, [box(-4, -12, 36, 0, 12, 60, 'steel')]);
    map.brushEntity({ classname: 'momentary_door', targetname: 'hatch', angle: '-1', speed: '400', lip: '0' },
      [box(200, -64, 0, 216, 64, 128, 'steel')]);
  });
  const { game, run, put } = walker(bsp);
  const d = game.doors, wheel = d.kind.indexOf(MOVER_WHEEL), hatch = d.kind.indexOf(MOVER_MOMENTARY);
  assert.ok(wheel >= 0 && hatch >= 0);
  put(-66, 0, 0);
  run(4, 0, 0);
  // Held half a second: the wheel turns half way (180 deg/s over 180), the hatch goes to
  // the same fraction at its own speed and stops there.
  run(ticksOf(0.5), IN_USE, 0);
  const half = d.frac(wheel, game.tick);
  assert.ok(Math.abs(half - 0.5) < 0.05, `half turned (${half.toFixed(3)})`);
  run(ticksOf(0.3), 0, 0);
  assert.equal(d.dir[wheel], 0, 'let go: holds');
  const held = d.frac(wheel, game.tick);
  assert.ok(Math.abs(held - half) < 0.04, 'a tick more at most'); // the release is seen a tick after the last hold
  assert.equal(d.dir[hatch], 0, 'the hatch has caught up');
  assert.ok(Math.abs(d.goal[hatch] - held) < 1e-6);
  assert.ok(Math.abs(d.frac(hatch, game.tick) - held) < 1e-6, 'and stands where the wheel is');
  const e = game.world.ents[d.ent[hatch]];
  assert.ok(Math.abs(e.oz - 126 * held) < 0.01, `risen ${e.oz.toFixed(1)}`);
  // A new press turns it the other way (HL: each press flips the direction): back to the
  // start, the hatch following down; the press after that takes it all the way up.
  run(ticksOf(0.7), IN_USE, 0);
  assert.ok(d.atBottom(wheel), 'turned back to the start');
  run(ticksOf(0.4), 0, 0);
  assert.ok(d.atBottom(hatch) && e.oz === 0, 'the hatch down again');
  run(ticksOf(1.1), IN_USE, 0);
  assert.ok(d.frac(wheel, game.tick) >= 1 - 1e-6, 'all the way');
  run(ticksOf(0.4), 0, 0);
  assert.ok(Math.abs(e.oz - 126) < 0.01, 'the hatch fully up (126: its size less 2)');
});

Deno.test('momentary_rot_button: with auto return it comes back at its return speed when let go', () => {
  const bsp = yard((map) => {
    map.world.push(box(0, -12, 0, 20, 12, 80, 'steel'));
    map.brushEntity({ classname: 'momentary_rot_button', target: 'hatch', origin: '-2 0 48', spawnflags: '80', distance: '180',
      speed: '180', returnspeed: '90' }, [box(-4, -12, 36, 0, 12, 60, 'steel')]);
    map.brushEntity({ classname: 'momentary_door', targetname: 'hatch', angle: '-1', speed: '400', lip: '0' },
      [box(200, -64, 0, 216, 64, 128, 'steel')]);
  });
  const { game, run, put } = walker(bsp);
  const d = game.doors, wheel = d.kind.indexOf(MOVER_WHEEL);
  put(-66, 0, 0);
  run(4, 0, 0);
  run(ticksOf(0.5), IN_USE, 0);
  run(2, 0, 0);
  assert.equal(d.dir[wheel], -1, 'returning');
  assert.equal(d.sign[wheel], -1, 'at the return speed');
  const f0 = d.frac(wheel, game.tick);
  run(ticksOf(0.25), 0, 0);
  const f1 = d.frac(wheel, game.tick);
  assert.ok(Math.abs((f0 - f1) - 0.25 * 90 / 180) < 0.03, `half the speed back (${(f0 - f1).toFixed(3)} in 0.25 s)`);
  run(ticksOf(1), 0, 0);
  assert.ok(d.atBottom(wheel), 'all the way back');
});

// --- killtarget and master --------------------------------------------------------------

Deno.test('killtarget: a trigger removes a wall and a door; the snapshot mask carries it; the round brings them back', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_wall', targetname: 'wall' }, [box(0, -64, 0, 16, 64, 128, 'steel')]);
    map.brushEntity({ classname: 'func_door', targetname: 'wall', angle: '-1', speed: '100' }, [box(100, -64, 0, 116, 64, 128, 'steel')]);
    map.brushEntity({ classname: 'trigger_once', killtarget: 'wall' }, [box(-600, -100, 0, -500, 100, 100, NONE)]);
  });
  const { game, run, put, snapshot } = walker(bsp);
  const kb = game.killables, d = game.doors;
  assert.equal(kb.count, 1);
  assert.equal(kb.slot(0), d.slotBase + d.count + 1, 'slots after the movers');
  const wall = game.world.ents[kb.ent[0]], door = game.world.ents[d.ent[0]];
  assert.equal(wall.kind, ENT_SOLID);
  put(-550, 0, 0);
  run(3);
  assert.equal(wall.kind, ENT_NONE, 'the wall is gone');
  assert.equal(door.kind, ENT_NONE, 'so is the door');
  assert.equal(d.dead[0], 1);
  assert.ok(hullFits(game.world, HULL_STAND, 8, 0, 36), 'a player can stand where it was');
  const { k, ring } = snapshot();
  assert.ok(k >= 0);
  for (const slot of [kb.slot(0), d.slot(0)]) {
    assert.ok(ring.broken[k * 8 + (slot >> 5)] & (1 << (slot & 31)), `slot ${slot} in the mask`);
  }
  game.startRound(true);
  run(2);
  assert.equal(wall.kind, ENT_SOLID, 'back for the next round');
  assert.equal(door.kind, ENT_SOLID);
  const after = snapshot();
  assert.equal(after.ring.broken[after.k * 8], 0, 'the mask is clear');
});

Deno.test('master: a door stays locked until every input of its multisource has fired', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_door', targetname: 'vault', master: 'ms', angle: '-1', speed: '400', spawnflags: '256', lip: '8' },
      [box(0, -64, 0, 16, 64, 128, 'steel')]);
    map.point({ classname: 'multisource', targetname: 'ms', origin: '0 0 0' });
    map.brushEntity({ classname: 'trigger_multiple', target: 'ms', wait: '0.1' }, [box(-600, -100, 0, -500, 100, 100, NONE)]);
    map.brushEntity({ classname: 'trigger_multiple', target: 'ms', wait: '0.1' }, [box(-400, -100, 0, -300, 100, 100, NONE)]);
  });
  const { game, run, put } = walker(bsp);
  const d = game.doors, ms = game.logic.masters.get('ms');
  assert.equal(ms.sources.length, 2);
  assert.equal(ms.on, false);
  assert.ok(d.locked(0));
  put(-40, 0, 0);
  run(2, IN_USE, 0); // +use on it: locked
  run(2, 0, 0);
  assert.ok(d.atBottom(0), 'locked');
  put(-550, 0, 0); // the first input
  run(2, 0, 0);
  assert.equal(ms.on, false, 'one of two');
  put(-900, 0, 0);
  run(ticksOf(0.2), 0, 0);
  put(-350, 0, 0); // the second
  run(2, 0, 0);
  assert.equal(ms.on, true);
  put(-40, 0, 0);
  run(2, IN_USE, 0);
  assert.equal(d.dir[0], 1, 'unlocked: it opens');
});

// --- Snapshots ----------------------------------------------------------------------------

Deno.test('snapshots carry a train\'s leg and a momentary door\'s goal', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_train', target: 'c1', speed: '160' }, [box(-32, -32, 0, 32, 32, 16, 'steel')]);
    map.point({ classname: 'path_corner', targetname: 'c1', target: 'c2', origin: '0 0 8' });
    map.point({ classname: 'path_corner', targetname: 'c2', target: 'c3', origin: '320 0 8' });
    map.point({ classname: 'path_corner', targetname: 'c3', target: 'c1', origin: '320 240 8' });
    map.brushEntity({ classname: 'momentary_door', targetname: 'hatch', angle: '-1', speed: '400', lip: '0' },
      [box(200, -64, 0, 216, 64, 128, 'steel')]);
  });
  const { game, run, snapshot } = walker(bsp);
  const d = game.doors, train = d.kind.indexOf(MOVER_TRAIN), hatch = d.kind.indexOf(MOVER_MOMENTARY);
  run(Math.ceil(2 * TICK_RATE) + 2); // the unnamed train sets off at once: on its second leg
  assert.equal(d.leg[train], 1);
  d.moveTo(hatch, game.tick, 0.375);
  run(1);
  const { k, own } = snapshot();
  assert.ok(k >= 0);
  const mv = own.movers;
  const mt = [...mv.mover.subarray(0, mv.count)].indexOf(train), mh = [...mv.mover.subarray(0, mv.count)].indexOf(hatch);
  assert.ok(mt >= 0 && mh >= 0, 'both sent');
  assert.equal(mv.leg[mt], 1);
  assert.equal(mv.goal[mh], 0.375);
  assert.equal(mv.dir[mh], 1);
  assert.equal(mv.leg[mh], 0);
});

// --- Breakables ---------------------------------------------------------------------------

Deno.test('breakables: a barrel\'s explosion breaks the crate beside it and hurts whoever stands near, not behind a wall', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_breakable', material: '2', health: '20', explodemagnitude: '120' }, [box(0, -24, 0, 48, 24, 56, 'steel')]);
    map.brushEntity({ classname: 'func_breakable', material: '1', health: '40' }, [box(64, -32, 0, 128, 32, 64, 'crate08')]);
    map.brushEntity({ classname: 'func_breakable', material: '1', health: '40' }, [box(0, 400, 0, 64, 464, 64, 'crate08')]); // too far
    map.world.push(box(-100, -200, 0, -84, 200, 128, W)); // a wall west of the barrel
  });
  const { game, c, run, put } = walker(bsp);
  const b = game.breakables;
  assert.equal(b.count, 3);
  assert.equal(b.magnitude[1], 120);
  put(24, 120, 0); // 120 units north of the barrel, in the open
  run(2);
  c.player.armor = 0;
  const hp = c.player.health;
  game.breakSlot(1, null);
  assert.equal(b.broken[1], 1);
  assert.equal(b.broken[2], 1, 'the crate beside it went too');
  assert.equal(b.broken[3], 0, 'the far one did not');
  const expected = Math.trunc(blastDamage(120, 300, Math.hypot(0, 120 - 0, 36 - 28)));
  assert.equal(hp - c.player.health, expected, `hurt by the blast (${expected})`);
  assert.ok(expected > 50 && expected < 80);
  assert.equal(game.grenades.fxCount, 1, 'the clients see a blast');
  // Behind the wall: nothing.
  game.startRound(true);
  run(2);
  put(-140, 0, 0);
  run(2);
  const hp2 = c.player.health;
  game.breakSlot(1, null);
  assert.equal(c.player.health, hp2, 'the wall shields');
  // Set off by a teammate it spares us (friendly fire is off, as for his HE); by an enemy it hurts.
  put(24, 120, 0);
  run(2);
  const mate = joinClient(game, new Writer(), 'mate', TEAM_T), foe = joinClient(game, new Writer(), 'foe', TEAM_CT);
  const hp3 = c.player.health;
  game.blast(24, 0, 28, 120, 300, mate);
  assert.equal(c.player.health, hp3, "a teammate's barrel spares us");
  game.blast(24, 0, 28, 120, 300, foe);
  assert.ok(c.player.health < hp3, "an enemy's hurts");
});

Deno.test('breakables: a breakable fires its target when it breaks; one only a trigger breaks goes when its name fires', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_breakable', material: '0', health: '10', target: 'gate', delay: '0.5' }, [box(0, -24, 0, 4, 24, 96, 'glass_med')]);
    map.brushEntity({ classname: 'func_door', targetname: 'gate', angle: '-1', speed: '400', lip: '8' }, [box(200, -64, 0, 216, 64, 128, 'steel')]);
    map.brushEntity({ classname: 'func_breakable', targetname: 'crates', spawnflags: '1', material: '1', health: '1' },
      [box(300, -32, 0, 364, 32, 64, 'crate08')]);
    map.brushEntity({ classname: 'func_button', target: 'crates', angle: '0', speed: '40', wait: '1', lip: '2' },
      [box(500, -8, 40, 504, 8, 56, 'steel')]);
  });
  const { game, run, put } = walker(bsp);
  const b = game.breakables, d = game.doors, gate = d.name.indexOf('gate');
  // Shoot the glass: the AK's first bullet breaks it, the gate opens half a second later.
  put(-200, 0, 0);
  run(4, 0, 0);
  const ws = game.clients[0].player.ws;
  giveWeapon(ws, WEAPON_ID.ak47);
  ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  run(ticksOf(1.2), 0, 0); // drawn
  run(2, IN_ATTACK, 0);
  run(1, 0, 0);
  assert.equal(b.broken[1], 1, 'the glass broke');
  assert.equal(d.dir[gate], 0, 'not yet');
  run(ticksOf(0.5) + 1, 0, 0);
  assert.equal(d.dir[gate], 1, 'the gate opens after the delay');
  // The crates ignore bullets; the button's target breaks them.
  assert.equal(b.damage(game.world, b.ent[2], 500), 0);
  assert.equal(b.broken[2], 0);
  put(460, 0, 0);
  run(2, IN_USE, 0);
  run(ticksOf(2 / 40) + 2, 0, 0);
  assert.equal(b.broken[2], 1, 'fired by name');
});

Deno.test('breakables: an HE grenade breaks the glass in its blast and the bomb blows up the site\'s crates', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_breakable', material: '0', health: '10' }, [box(100, -64, 0, 104, 64, 96, 'glass_med')]);
    map.brushEntity({ classname: 'func_breakable', material: '1', health: '400' }, [box(-200, -32, 0, -136, 32, 64, 'crate08')]);
    map.brushEntity({ classname: 'func_bomb_target', target: 'crates' }, [box(400, -200, 0, 800, 200, 128, NONE)]);
    map.brushEntity({ classname: 'func_breakable', targetname: 'crates', spawnflags: '1', material: '1', health: '1', explodemagnitude: '100' },
      [box(600, 300, 0, 664, 364, 64, 'crate08')]);
    map.brushEntity({ classname: 'func_breakable', material: '1', health: '40' }, [box(700, 300, 0, 764, 364, 64, 'crate08')]);
  });
  const { game, run } = walker(bsp, TEAM_CT);
  const b = game.breakables;
  game.grenades.count = 0;
  game.grenades.detonate(game.world, 0, 'he', 0, 0, 8, true, game.grenadeTargets);
  assert.equal(b.broken[1], 1, 'the glass shattered');
  assert.equal(b.broken[2], 0, 'the tough crate stood');
  // The bomb at the site: the site's target breaks the crate only a trigger breaks, and
  // its explosion takes the one beside it.
  game.bomb.x = 600;
  game.bomb.y = 0;
  game.bomb.z = 8;
  game.explodeBomb();
  run(1);
  assert.equal(b.broken[3], 1, 'the site crate went');
  assert.equal(b.broken[4], 1, 'and the one beside it with its blast');
});

// Logic that loops (an uploaded map hung the server): a multi_manager firing itself twice
// with delays doubled its queue every tick, a relay naming itself recursed until the stack
// ran out. Both stay within MAX_FIRES a tick and MAX_QUEUED waiting.
Deno.test('looping map logic is bounded', () => {
  const bsp = yard((map) => {
    map.point({ classname: 'trigger_auto', target: 'boom', delay: '0.5', origin: '0 0 64' });
    map.point({ classname: 'multi_manager', targetname: 'boom', boom: '0.01', 'boom#1': '0.01', origin: '0 0 64' });
    map.point({ classname: 'trigger_relay', targetname: 'self', target: 'self', origin: '0 0 64' });
  });
  const g = quiet(() => new Game('yard', bsp, { rounds: false }));
  const logic = g.logic;
  logic.reset(0);
  let worst = 0, tick = 0;
  for (; tick < 200; tick++) { // the logic alone (the game skips it on a map with no doors or triggers)
    const t = performance.now();
    logic.update(tick, []);
    worst = Math.max(worst, performance.now() - t);
    assert.ok(logic.queue.length <= MAX_QUEUED);
  }
  assert.ok(logic.queue.length > 100, 'the loop still runs, within the budget');
  assert.ok(worst < 50, `the slowest tick took ${worst.toFixed(1)} ms`);
  logic.fireAt(tick, 'self', null, 0);
  assert.equal(logic.fires, MAX_FIRES, 'the self relay stopped at the budget');
});

// Past the budget a fire returned at once, but each of the 256 that passed still walked its
// whole relay list: a multi_manager naming itself 60,000 times was 15M calls a tick.
Deno.test('a relay with many targets stops at the fire budget', () => {
  const keys = {};
  for (let i = 0; i < 5000; i++) keys[`fan#${i}`] = '0';
  const bsp = yard((map) => map.point({ classname: 'multi_manager', targetname: 'fan', ...keys, origin: '0 0 64' }));
  const logic = quiet(() => new Game('yard', bsp, { rounds: false })).logic;
  logic.reset(0);
  let calls = 0;
  const fire = logic.fireAt.bind(logic);
  logic.fireAt = (...a) => (calls++, fire(...a));
  logic.fireAt(1, 'fan', null, 0);
  assert.ok(calls <= MAX_FIRES + 1, `${calls} calls`);
});

// The budget counted only the fires that happened: a killtargeted multi_manager's entries and
// spent explosions were walked for nothing at every fire of their name, and each kill walked
// the killed relay's whole list again (a 60,000-key one fired ~250 times a tick: 51 ms a tick).
Deno.test('killed relays and spent explosions are not walked past the fire budget', () => {
  const keys = {};
  for (let i = 0; i < 5000; i++) keys[`x#${i}`] = '0';
  const bsp = yard((map) => {
    map.point({ classname: 'multi_manager', targetname: 'boom', ...keys, origin: '0 0 64' });
    map.point({ classname: 'trigger_relay', targetname: 'cut', killtarget: 'boom', origin: '0 0 64' });
    for (let i = 0; i < 2000; i++) {
      map.point({ classname: 'env_explosion', targetname: 'bang', iMagnitude: '1', spawnflags: '5', origin: '0 0 64' });
    }
  });
  const logic = quiet(() => new Game('yard', bsp, { rounds: false })).logic;
  logic.reset(0);
  logic.fireAt(1, 'cut', null, 0); // boom is gone
  for (let t = 2; t < 20; t++) logic.fireAt(t, 'bang', null, 0); // every explosion spent
  let walked = 0;
  const counted = (list) => new Proxy(list, {
    get: (a, k, r) => {
      if (typeof k === 'string' && /^\d+$/.test(k)) walked++;
      return Reflect.get(a, k, r);
    },
  });
  logic.relays.set('boom', counted(logic.relays.get('boom')));
  logic.explosions.set('bang', counted(logic.explosions.get('bang')));
  for (let i = 0; i < 300; i++) {
    logic.fireAt(100, 'boom', null, 0);
    logic.fireAt(100, 'cut', null, 0);
    logic.fireAt(100, 'bang', null, 0);
  }
  assert.ok(walked <= 2 * MAX_FIRES, `${walked} entries walked in a tick`);
});

// A multisource found the input that fired it with indexOf and its state with every(): an
// uploaded map's 5,000 inputs, the last one fired 256 times a tick, walked 1.3 M entries.
Deno.test('a multisource finds its input and its state without walking its list', () => {
  const bsp = yard((map) => {
    map.point({ classname: 'multisource', targetname: 'ms', origin: '0 0 64' });
    for (let i = 0; i < 5000; i++) map.point({ classname: 'trigger_relay', target: 'ms', origin: '0 0 64' });
  });
  const logic = quiet(() => new Game('yard', bsp, { rounds: false })).logic;
  logic.reset(0);
  const ms = logic.masters.get('ms'), last = ms.sources[ms.sources.length - 1];
  let walked = 0;
  const counted = (list) => new Proxy(list, {
    get: (a, k, r) => {
      if (typeof k === 'string' && /^\d+$/.test(k)) walked++;
      return Reflect.get(a, k, r);
    },
  });
  ms.sources = counted(ms.sources);
  ms.state = counted(ms.state);
  for (let i = 0; i < 300; i++) logic.fireAt(100, 'ms', null, 0, last);
  assert.ok(walked <= 2 * MAX_FIRES, `${walked} entries walked in a tick`);
  assert.equal(ms.on, false, 'one input of 5,000 does not turn it on');
});

// The inputs' order does not matter, and toggling one back off counts.
Deno.test('a multisource is on once every input is on, whatever the order', () => {
  const bsp = yard((map) => {
    map.point({ classname: 'multisource', targetname: 'ms', origin: '0 0 64' });
    for (let i = 0; i < 3; i++) map.point({ classname: 'trigger_relay', target: 'ms', origin: '0 0 64' });
  });
  const logic = quiet(() => new Game('yard', bsp, { rounds: false })).logic;
  logic.reset(0);
  const ms = logic.masters.get('ms'), [a, b, c] = ms.sources;
  logic.fireAt(1, 'ms', null, 0, c);
  logic.fireAt(2, 'ms', null, 0, a);
  logic.fireAt(3, 'ms', null, 0, a); // a off again
  logic.fireAt(4, 'ms', null, 0, b);
  assert.equal(ms.on, false, 'a was turned off');
  logic.fireAt(5, 'ms', null, 0, a);
  assert.equal(ms.on, true);
  logic.reset(10);
  assert.equal(ms.on, false, 'off again at the round start');
  logic.fireAt(11, 'ms', null, 0, a);
  logic.fireAt(12, 'ms', null, 0, b);
  assert.equal(ms.on, false, 'the count started over');
  logic.fireAt(13, 'ms', null, 0, c);
  assert.equal(ms.on, true);
});

// A map's explosion traced to every breakable: 254 that never break and a loop firing
// env_explosions were ~200 blasts a tick, 160-300 ms. Each blast counts the breakables it
// tests against the budget.
Deno.test('map explosions pay for the breakables they test', () => {
  const bsp = yard((map) => {
    for (let i = 0; i < 100; i++) {
      const x = -400 + (i % 20) * 40, y = -200 + Math.floor(i / 20) * 80;
      map.brushEntity({ classname: 'func_breakable', material: '2', health: '1e30' }, [box(x, y, 0, x + 16, y + 16, 16, 'steel')]);
    }
    for (let i = 0; i < 300; i++) {
      map.point({ classname: 'env_explosion', targetname: 'boom', iMagnitude: '1000', spawnflags: '6', origin: `${i - 150} 0 200` });
    }
  });
  const g = quiet(() => new Game('yard', bsp, { rounds: false }));
  assert.equal(g.breakables.count, 100);
  let blasts = 0;
  const explode = g.logic.onExplode;
  g.logic.onExplode = (...a) => (blasts++, explode(...a));
  g.logic.fireAt(g.tick + 1, 'boom', null, 0);
  assert.ok(blasts >= 1 && blasts <= 3, `${blasts} blasts in a tick`);
});

// HL's trigger_multiple with wait -1 fires once and is gone (ticksOf(-1) made it fire every
// tick: de_survivor's filled the delayed queue and dropped every other delayed fire).
Deno.test('a trigger_multiple with wait -1 fires once', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'trigger_multiple', target: 'ping', wait: '-1' }, [box(-100, -100, 0, 100, 100, 100, NONE)]);
  });
  const logic = quiet(() => new Game('yard', bsp, { rounds: false })).logic;
  logic.reset(0);
  let fires = 0;
  const fire = logic.fireAt.bind(logic);
  logic.fireAt = (tick, name, ...a) => (name === 'ping' && fires++, fire(tick, name, ...a));
  for (let tick = 1; tick < 2 * TICK_RATE; tick++) logic.update(tick, [{ x: 0, y: 0, z: 36, yaw: 0 }]);
  assert.equal(fires, 1);
});

// A map with no doors and no triggers skipped the map logic altogether, so a trigger_auto's
// delayed fire never came (here: it breaks a crate by name half a second into the round).
Deno.test('delayed fires happen on a map with no doors or triggers', () => {
  const bsp = yard((map) => {
    map.point({ classname: 'trigger_auto', target: 'crate', delay: '0.5', origin: '0 0 64' });
    map.brushEntity({ classname: 'func_breakable', targetname: 'crate', material: '1', health: '40' }, [box(64, -32, 0, 128, 32, 64, 'crate08')]);
  });
  const g = quiet(() => new Game('yard', bsp, { rounds: false }));
  assert.equal(g.doors.count + g.logic.triggers.length, 0);
  g.logic.reset(g.tick);
  for (let i = 0; i < TICK_RATE; i++) g.step();
  assert.equal(g.breakables.broken[1], 1);
});

// path_corner flags as the HL SDK has them: 1 waits for a trigger, 2 teleports (the leg into
// it takes one tick), 4 fires its message once (2 was read as fire once before).
Deno.test('path_corner: teleport, wait for a trigger, fire once', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_train', target: 'c1', speed: '160', targetname: 'tram' }, [box(-32, -32, 0, 32, 32, 16, 'steel')]);
    map.point({ classname: 'path_corner', targetname: 'c1', target: 'c2', origin: '0 0 8', message: 'ding', spawnflags: '4' });
    map.point({ classname: 'path_corner', targetname: 'c2', target: 'c3', origin: '800 0 8', spawnflags: '2' });
    map.point({ classname: 'path_corner', targetname: 'c3', target: 'c1', origin: '800 300 8', spawnflags: '1' });
  });
  const { game, c, run, put, pos } = walker(bsp);
  const d = game.doors, p = d.path[0], e = game.world.ents[d.ent[0]];
  assert.equal(p.rate[0], 1, 'into the teleport corner in one tick');
  assert.deepEqual([p.wait[2], p.once[0], p.once[1]], [-1, 1, 0]);
  put(0, 0, 16); // on the train (named: it waits for a trigger)
  run(8);
  assert.equal(c.player.ps.i[PS_GROUNDENT], d.ent[0], 'riding');
  game.logic.fireAt(game.tick, 'tram', null, 0);
  run(3);
  assert.equal(d.leg[0], 1, 'at the second corner the tick it left');
  assert.ok(Math.abs(e.ox - 800) < 0.01 && e.oy < 20, `jumped there (${e.ox}, ${e.oy})`);
  // The leg into a teleport corner is all arrival: the train is set there, nobody carried
  // or shoved (GoldSrc sets its origin).
  assert.ok(Math.abs(pos()[PS_ORIGIN]) < 40 && c.alive, `its rider stayed behind (x ${pos()[PS_ORIGIN].toFixed(0)})`);
  run(Math.ceil(300 / 160 * TICK_RATE) + 2);
  assert.equal(d.leg[0], 2);
  assert.equal(d.stopped[0], 1, 'waits at the third for a trigger');
});

// CBreakable::BreakTouch: de_survivor's ice breaks a moment after someone stands on it
// (pressure), cs_assault's plate when run into fast enough (touch: speed / 100 >= health).
Deno.test('breakables: pressure breaks when stood on, touch when run into fast enough', () => {
  const bsp = yard((map) => {
    map.brushEntity({ classname: 'func_breakable', spawnflags: '4', health: '25', delay: '0.25' }, [box(-200, -100, 0, -100, 0, 8, 'glass_med')]);
    map.brushEntity({ classname: 'func_breakable', spawnflags: '2', material: '2', health: '3' }, [box(300, -64, 0, 316, 64, 96, 'steel')]);
  });
  const { game, c, run, put } = walker(bsp);
  const b = game.breakables;
  put(-150, -50, 8); // on the ice
  run(4);
  assert.equal(c.player.ps.i[PS_GROUNDENT], b.ent[1], 'standing on it');
  assert.equal(b.broken[1], 0, 'not at once');
  run(Math.round(0.25 * TICK_RATE));
  assert.equal(b.broken[1], 1, 'broke after its delay');
  // Walking into the plate (~250 u/s: 2.5 < 3) leaves it; a shove at 400 breaks it.
  put(250, 0, 0);
  run(TICK_RATE, IN_FORWARD);
  assert.equal(b.broken[2], 0, 'walking speed does not break it');
  put(280, 0, 0);
  c.player.ps.f[PS_VEL] = 400;
  run(4, IN_FORWARD);
  assert.equal(b.broken[2], 1, 'run into at 400');
  game.startRound(true);
  assert.ok(!b.broken[1] && !b.broken[2] && game.pressed.size === 0, 'back at the round start');
});

// GoldSrc's locked sound: running into a named door (only what targets it opens it) with a
// locked_sound rattles it; an unnamed one opens, a use-only one is used, one without the
// key is silent.
Deno.test('doors: which ones rattle when run into', () => {
  const door = (keys, x) => (map) => map.brushEntity({ classname: 'func_door', ...keys }, [box(x, -64, 0, x + 16, 64, 128, 'steel')]);
  const bsp = yard((map) => {
    door({ targetname: 'gate', locked_sound: '2' }, -400)(map);
    door({ locked_sound: '2' }, -200)(map);
    door({ targetname: 'hatch', locked_sound: '2', spawnflags: '256' }, 0)(map);
    door({ targetname: 'quiet' }, 200)(map);
  });
  const game = quiet(() => new Game('yard', bsp, { rounds: false }));
  const d = game.doors;
  assert.deepEqual([0, 1, 2, 3].map((k) => d.rattlesOnTouch(k)), [true, false, false, false]);
  assert.deepEqual([...d.lockedSound], [1, 1, 1, 0]);
});

// --- Fans, pendulums, crates (the 2026-11-07 parity pass) ------------------------------

const spinYard = () => yard((map) => {
  // A fan turning about z at 90 deg/s (started on), a pendulum swinging 45 deg either way at
  // up to 90 deg/s and dying away (damp 500: e^(-0.5 t)), a 32-unit crate on the floor.
  map.brushEntity({ classname: 'func_rotating', targetname: 'fan', origin: '0 300 200', speed: '90', spawnflags: '1' },
    [box(-60, 290, 192, 60, 310, 208, 'steel')]);
  map.brushEntity({ classname: 'func_pendulum', targetname: 'swing', origin: '-400 300 300', distance: '45', speed: '90',
    damp: '500' }, [box(-410, 290, 150, -390, 310, 300, 'steel')]);
  map.brushEntity({ classname: 'func_pushable', health: '1' }, [box(300, -16, 0, 332, 16, 32, 'steel')]);
});

Deno.test('func_rotating: a fan started on turns at its speed, round and round; its name stops it where it is', () => {
  const { game, run, snapshot } = walker(spinYard());
  const d = game.doors, k = d.kind.indexOf(MOVER_SPIN), t = game.tick;
  assert.ok(k >= 0 && d.dir[k] === 1, 'on');
  const quarter = (d.frac(k, t + TICK_RATE) - d.frac(k, t) + 1) % 1;
  assert.ok(Math.abs(quarter - 0.25) < 1e-9, `a quarter turn a second (${quarter})`);
  run(ticksOf(1));
  assert.ok(game.world.ents[d.ent[k]].rot, 'its collision turned');
  const m = snapshot().own.movers;
  assert.ok(Array.from(m.mover.subarray(0, m.count)).includes(k), 'in the snapshot');
  game.logic.fireAt(game.tick, 'fan', null, 0);
  run(2);
  const at = d.frac(k, game.tick);
  run(ticksOf(1));
  assert.ok(d.dir[k] === 0 && d.frac(k, game.tick) === at, 'stopped where it was');
});

Deno.test('func_pendulum: fired, it swings to its distance and back, dies away and comes to rest', () => {
  const { game, run } = walker(spinYard());
  const d = game.doors, k = d.kind.indexOf(MOVER_PENDULUM);
  assert.ok(k >= 0 && d.idle(k), 'at rest until fired');
  game.logic.fireAt(game.tick, 'swing', null, 0);
  run(2);
  assert.equal(d.dir[k], 1);
  // w = 90 / 45 = 2 rad/s: the first top at pi/4 s, at 45 deg less what it has died away.
  const top = d.swing(k, Math.PI / 4);
  assert.ok(top > 20 && top < 45, `first top ${top.toFixed(1)} deg`);
  assert.ok(Math.abs(d.swing(k, Math.PI / 2)) < 1e-9, 'back through the middle');
  run(ticksOf(d.life[k]) + 2); // ln(90 / 30) / 0.5 = 2.2 s
  assert.ok(d.idle(k), 'at rest again');
});

Deno.test('func_pushable: walked into, a crate goes ahead; it stops at a wall; standing on it moves nothing', () => {
  const { game, c, run, put } = walker(spinYard());
  const d = game.doors, k = d.kind.indexOf(MOVER_PUSH), b = k * 3;
  assert.ok(k >= 0 && d.pushables.includes(k));
  put(283, 0, 0); // against its west side
  run(ticksOf(1), IN_FORWARD, 0);
  assert.ok(d.pos[b] > 60 && d.pos[b] < 101, `shoved ${d.pos[b].toFixed(1)} east`);
  assert.ok(Math.abs(d.pos[b + 1]) < 1e-6, 'straight ahead');
  assert.ok(c.player.ps.f[PS_ORIGIN] > 283 + 50, 'the player went with it');
  run(ticksOf(12), IN_FORWARD, 0);
  assert.ok(332 + d.pos[b] <= 1024 + 1e-3 && 332 + d.pos[b] > 1000, `stopped at the wall (${(332 + d.pos[b]).toFixed(1)})`);
  const x = d.pos[b];
  put(316 + x, 0, 32); // on top
  run(ticksOf(1), IN_FORWARD, 180);
  assert.ok(d.pos[b] === x, 'not from on top');
});
