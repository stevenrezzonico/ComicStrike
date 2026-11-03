// The movers beyond doors and buttons (shared/doors.js): lifts (func_plat), trains on
// path_corners, rotating buttons, momentary doors driven by wheels, killtarget and
// master; and what breakables set off (shared/breakables.js, server/game.js): their
// targets, their explosions, the blasts that break them.
import assert from 'node:assert/strict';
import { MapBuilder, box, NONE } from '../shared/bspwriter.js';
import { parseUntrustedBSP } from '../shared/bsp.js';
import { Trace, traceHull, hullFits, HULL_POINT, HULL_STAND, ENT_NONE, ENT_SOLID } from '../shared/trace.js';
import { PS_ORIGIN, PS_VEL, PS_GROUNDENT } from '../shared/pmove.js';
import { IN_USE, IN_ATTACK, TICK_RATE } from '../shared/constants.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { WEAPON_ID, WS_ACTIVE, giveWeapon, SLOT_PRIMARY } from '../shared/weapons.js';
import {
  Writer, Reader, CmdRing, SnapshotRing, OwnState, writeHello, writeCmds, readSnapshot, S2C_SNAPSHOT,
} from '../shared/protocol.js';
import { MOVER_PLAT, MOVER_TRAIN, MOVER_BUTTON, MOVER_MOMENTARY, MOVER_WHEEL } from '../shared/doors.js';
import { blastDamage } from '../shared/breakables.js';
import { Game } from '../server/game.js';

const TEX = { sky: [256, 256], crete3_wall02: [128, 128], '-0sand': [128, 128], steel: [64, 64], crate08: [64, 64], glass_med: [64, 64] };
const W = 'crete3_wall02';

// A walled yard 2048 x 1024 under the sky, plus `extra(map)`.
function yard(extra) {
  const map = new MapBuilder(TEX, { message: 'test' });
  map.world.push(
    box(-1024, -512, -32, 1024, 512, 0, '-0sand'),
    box(-1056, -544, -32, -1024, 544, 512, W), box(1024, -544, -32, 1056, 544, 512, W),
    box(-1024, -544, -32, 1024, -512, 512, W), box(-1024, 512, -32, 1024, 544, 512, W),
    box(-1056, -544, 512, 1056, 544, 544, 'sky'),
  );
  extra(map);
  map.point({ classname: 'info_player_deathmatch', origin: '-900 0 37', angles: '0 0 0' });
  map.point({ classname: 'info_player_start', origin: '900 0 37', angles: '0 180 0' });
  return parseUntrustedBSP(map.compile({ light: 'draft' }).bytes.buffer);
}

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

// A game on `bsp` with one player driven tick by tick (its snapshots kept for reading).
function walker(bsp, team = TEAM_T) {
  const game = quiet(() => new Game('test', bsp, { rounds: false }));
  const w = new Writer();
  const inbox = [];
  const c = game.connect({ send: (b) => inbox.push(b.slice()), close() {} });
  game.receive(c, writeHello(w, team, 0, 0, 'tester').slice());
  c.cmds = new CmdRing();
  let tick = 1;
  const run = (ticks, buttons = 0, yaw = 0, pitch = 0) => {
    for (let i = 0; i < ticks; i++) {
      c.cmds.put(tick, buttons, -1, pitch, yaw, 0);
      game.receive(c, writeCmds(w, 0, c.cmds, tick++).slice());
      game.step();
    }
  };
  const put = (x, y, feet) => {
    const f = c.player.ps.f;
    f[PS_ORIGIN] = x;
    f[PS_ORIGIN + 1] = y;
    f[PS_ORIGIN + 2] = feet + 36;
    f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
    c.player.ps.i[PS_GROUNDENT] = -1; // not riding whatever it stood on (a mover pushes its riders)
  };
  // The newest snapshot the server sent, read like the client does.
  const ring = new SnapshotRing(), own = new OwnState(), r = new Reader();
  const snapshot = () => {
    let k = -1;
    for (const bytes of inbox.splice(0)) {
      r.set(bytes);
      if (r.u8v() !== S2C_SNAPSHOT) continue;
      const s = readSnapshot(r, ring, own);
      if (s >= 0) k = s;
    }
    return { k, ring, own };
  };
  run(2);
  return { game, c, run, put, feet: () => c.player.ps.f[PS_ORIGIN + 2] - 36, pos: () => c.player.ps.f, snapshot, inbox };
}

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
