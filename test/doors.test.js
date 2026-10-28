import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_FORWARD, IN_USE, TICK_RATE } from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_STAND, HULL_POINT } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { Doors, MOVER_ROTATING } from '../shared/doors.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { ShotList } from '../shared/weapons.js';
import { Player, runCommand, TEAM_CT } from '../shared/player.js';
import {
  S2C_SNAPSHOT, Writer, Reader, CmdRing, SnapshotRing, OwnState, writeHello, writeCmds, readSnapshot,
} from '../shared/protocol.js';
import { Game } from '../server/game.js';

const maps = {};
function loadMap(name) {
  if (!(name in maps)) {
    try {
      maps[name] = parseBSP(Deno.readFileSync(new URL(`../maps/${name}.bsp`, import.meta.url)).buffer);
    } catch {
      maps[name] = null;
    }
  }
  return maps[name];
}
const have = (...names) => names.every((n) => loadMap(n));

// A game on `map` with one player (a CT) driven by `input`.
function setup(map) {
  const g = new Game(map, loadMap(map), { rounds: false });
  const w = new Writer();
  const c = g.connect({ send() {}, close() {} });
  g.receive(c, writeHello(w, TEAM_CT, 0, 0, 'p').slice());
  c.cmds = new CmdRing();
  c.tick = 1;
  c.input = { buttons: 0, pitch: 0, yaw: 0 };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      const k = c.input;
      c.cmds.put(c.tick, k.buttons, -1, k.pitch, k.yaw, 0);
      g.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      g.step();
    }
  };
  run(2);
  return { g, c, run };
}

// Puts the player's feet on the floor under (x, y, z) (a hull center guess).
function place(g, c, x, y, z) {
  for (let dz = 0; dz < 160; dz += 2) {
    if (!hullFits(g.world, HULL_STAND, x, y, z - dz)) continue;
    const tr = traceHull(g.world, HULL_STAND, x, y, z - dz, x, y, z - dz - 200, new Trace());
    const f = c.player.ps.f;
    f[PS_ORIGIN] = x;
    f[PS_ORIGIN + 1] = y;
    f[PS_ORIGIN + 2] = tr.endz;
    f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
    return;
  }
  throw new Error(`no room at ${x} ${y} ${z}`);
}

// de_inferno's one func_door_rotating: hinge at (302, -314), 64 wide along +x, 90 degrees.
const INFERNO_SOUTH = [334, -380, 170];
const INFERNO_NORTH = [334, -250, 170];

Deno.test({ name: 'doors: a rotating door opens away from whoever runs into it, waits, then closes', ignore: !have('de_inferno'), fn: () => {
  const signs = [];
  for (const [[x, y, z], yaw] of [[INFERNO_SOUTH, 90], [INFERNO_NORTH, -90]]) {
    const { g, c, run } = setup('de_inferno');
    const d = g.doors;
    assert.equal(d.count, 1);
    assert.equal(d.kind[0], MOVER_ROTATING);
    place(g, c, x, y, z);
    c.input.yaw = yaw;
    c.input.buttons = IN_FORWARD;
    for (let i = 0; i < 64 && d.dir[0] === 0; i++) run(1);
    assert.equal(d.dir[0], 1, 'opening');
    c.input.buttons = 0;
    signs.push(d.sign[0]);
    run(Math.ceil(1 / d.rate[0]) + 1);
    assert.ok(d.atTop(0), 'fully open');
    // Pushed into the doorway's far side, the open door does not block it.
    const f = c.player.ps.f;
    assert.ok(Math.abs(f[PS_ORIGIN + 1] - -314) > 16 || hullFits(g.world, HULL_STAND, f[0], f[1], f[2]));
    place(g, c, x, y - (y - -314) * 3, z); // out of its way
    run(4 * TICK_RATE + Math.ceil(1 / d.rate[0]) + 4);
    assert.ok(d.atBottom(0), 'closed again after its 4 s wait');
  }
  assert.deepEqual(signs.sort(), [-1, 1], 'it swings away from each side');
} });

Deno.test({ name: 'doors: open and closed doors trace like their turned brushes', ignore: !have('de_inferno'), fn: () => {
  const { g } = setup('de_inferno');
  const d = g.doors, tr = new Trace();
  // Closed: a point straight through the doorway's middle hits the door's south face.
  traceHull(g.world, HULL_POINT, 334, -340, 170, 334, -290, 170, tr);
  assert.equal(tr.ent, d.ent[0]);
  assert.ok(Math.abs(tr.ny + 1) < 1e-6, `normal ${tr.nx} ${tr.ny} ${tr.nz}`);
  // Opened (as from the south): the doorway is clear, and the door now lies along +y
  // from the hinge, its faces pointing along x.
  d.goUp(0, g.tick, { x: 334, y: -380, z: 170, yaw: 90 });
  d.apply(g.world, g.tick + Math.ceil(1 / d.rate[0]));
  traceHull(g.world, HULL_POINT, 334, -340, 170, 334, -290, 170, tr);
  assert.equal(tr.fraction, 1, 'doorway clear');
  traceHull(g.world, HULL_POINT, 330, -280, 170, 290, -280, 170, tr);
  assert.equal(tr.ent, d.ent[0], 'the swung door is in the way along x');
  assert.ok(Math.abs(Math.abs(tr.nx) - 1) < 1e-6);
} });

Deno.test({ name: 'doors: closing doors push players out of the way, or go back when they cannot', ignore: !have('de_inferno', 'de_nuke'), fn: () => {
  { // de_inferno: the swinging door sweeps a player in the doorway out of it
    const { g, c, run } = setup('de_inferno');
    const d = g.doors;
    place(g, c, ...INFERNO_SOUTH);
    c.input.yaw = 90;
    c.input.buttons = IN_FORWARD;
    for (let i = 0; i < 64 && d.dir[0] === 0; i++) run(1);
    c.input.buttons = 0;
    run(Math.ceil(1 / d.rate[0]) + 1);
    place(g, c, 334, -300, 170); // in the doorway
    run(4 * TICK_RATE + Math.ceil(1 / d.rate[0]) + 8);
    assert.ok(d.atBottom(0), 'closed');
    const f = c.player.ps.f;
    assert.ok(hullFits(g.world, HULL_STAND, f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2]), 'not stuck in it');
    assert.ok(f[PS_ORIGIN + 1] < -330, 'swept out to the south');
  }
  { // de_nuke: the sliding glass doors close on a player between them and go back
    const { g, c, run } = setup('de_nuke');
    const d = g.doors, k = d.name.indexOf('GlassDoor2');
    place(g, c, 218, -980, -690);
    run(2);
    run(Math.ceil(1 / d.rate[k]) + 1);
    assert.ok(d.atTop(k));
    place(g, c, 240, -980, -690); // in the doorway
    for (let i = 0; i < 12 * TICK_RATE && d.dir[k] >= 0; i++) run(1);
    assert.equal(d.dir[k], -1, 'closing after its wait');
    let reopened = false;
    for (let i = 0; i < 2 * TICK_RATE && !reopened; i++) {
      run(1);
      reopened = d.dir[k] === 1;
    }
    assert.ok(reopened, 'blocked: it went back');
    const f = c.player.ps.f;
    assert.ok(hullFits(g.world, HULL_STAND, f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2]), 'not stuck in it');
  }
} });

Deno.test({ name: 'doors: a trigger opens de_nuke\'s glass doors; +use on cs_office\'s button raises the garage door', ignore: !have('de_nuke', 'cs_office'), fn: () => {
  {
    const { g, c, run } = setup('de_nuke');
    const d = g.doors, glass = [];
    for (let k = 0; k < d.count; k++) if (d.name[k] === 'GlassDoor2') glass.push(k);
    assert.ok(glass.length >= 2);
    place(g, c, 218, -980, -690); // reaching into the trigger in their doorway
    run(2);
    for (const k of glass) assert.equal(d.dir[k], 1, `glass door ${k} opening`);
  }
  {
    const { g, c, run } = setup('cs_office');
    const d = g.doors, button = d.target.indexOf('door1');
    const garage = d.name.indexOf('door1');
    assert.ok(button >= 0 && garage >= 0);
    const e = g.world.ents[d.ent[button]];
    const bx = (e.amin[0] + e.amax[0]) / 2, by = (e.amin[1] + e.amax[1]) / 2;
    // Stand in front of it on whichever side has room, facing it.
    const side = hullFits(g.world, HULL_STAND, bx, by + 40, -270) ? 1 : -1;
    place(g, c, bx, by + side * 40, -260);
    c.input.yaw = side > 0 ? -90 : 90;
    c.input.pitch = 20;
    run(4);
    assert.ok(d.atBottom(garage));
    c.input.buttons = IN_USE;
    run(2);
    c.input.buttons = 0;
    run(2);
    assert.equal(d.dir[garage], 1, 'the garage door goes up');
  }
} });

// The browser's way: doors placed from the snapshots' mover states, for the tick the
// server runs each command at.
class DoorClient {
  constructor(g, bsp) {
    this.inbox = [];
    this.c = g.connect({ send: (b) => this.inbox.push(b.slice()), close() {} });
    this.g = g;
    this.world = CollisionWorld.fromBSP(bsp);
    this.breakables = new Breakables(bsp, this.world);
    this.doors = new Doors(bsp, this.world, this.breakables.count);
    this.player = new Player();
    this.cmds = new CmdRing();
    this.ring = new SnapshotRing();
    this.own = new OwnState();
    this.w = new Writer();
    this.r = new Reader();
    this.shots = new ShotList();
    this.tick = 1;
    this.latestSeq = 0;
    this.synced = false;
    g.receive(this.c, writeHello(this.w, TEAM_CT, 0, 0, 'd').slice());
  }

  poll() {
    for (const bytes of this.inbox.splice(0)) {
      const r = this.r.set(bytes);
      if (r.u8v() !== S2C_SNAPSHOT) continue;
      const k = readSnapshot(r, this.ring, this.own);
      if (k < 0 || this.ring.seq[k] <= this.latestSeq) continue;
      this.latestSeq = this.ring.seq[k];
      const mv = this.own.movers, d = this.doors;
      for (let m = 0; m < d.count; m++) d.setState(m, 0, 0, 1, 0);
      for (let m = 0; m < mv.count; m++) d.setState(mv.mover[m], mv.from[m], mv.dir[m], mv.sign[m], mv.t0[m]);
      if (!this.synced) {
        this.player.psBytes.set(this.own.ps);
        this.player.wsBytes.set(this.own.ws);
        this.synced = true;
      }
    }
  }

  play(buttons, yaw) {
    this.poll();
    if (!this.synced) return;
    const t = this.tick++;
    this.cmds.put(t, buttons, -1, 0, yaw, 0);
    this.doors.apply(this.world, t + this.latestSeq - this.own.lastCmd);
    runCommand(this.world, this.player, buttons, -1, 0, Math.fround(yaw), t, this.shots);
    this.g.receive(this.c, writeCmds(this.w, this.latestSeq, this.cmds, t).slice());
  }
}

Deno.test({ name: 'doors: the client predicts walking through an opening door bit for bit', ignore: !have('de_inferno'), fn: () => {
  const bsp = loadMap('de_inferno');
  const g = new Game('de_inferno', bsp, { rounds: false });
  const a = new DoorClient(g, bsp);
  g.step();
  a.poll();
  place(g, a.c, ...INFERNO_SOUTH);
  g.step();
  a.inbox.length = 0;
  a.synced = false;
  g.step();
  a.poll();
  let opened = false;
  for (let i = 0; i < 160; i++) {
    a.play(IN_FORWARD, 90);
    g.step();
    opened ||= g.doors.dir[0] === 1;
  }
  for (let i = 0; i < 4; i++) g.step();
  a.poll();
  assert.ok(opened, 'the door opened');
  assert.ok(a.player.ps.f[PS_ORIGIN + 1] > -250, 'and we went through');
  assert.equal(a.own.lastCmd, a.tick - 1);
  assert.deepEqual(a.c.player.psBytes, a.player.psBytes, 'prediction diverged');
} });
