import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_FORWARD, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_ATTACK } from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_POINT, HULL_STAND } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { PS_ORIGIN, eyeOffset } from '../shared/pmove.js';
import { ShotList } from '../shared/weapons.js';
import { Player, runCommand, TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  MAX_DATAGRAM, S2C_WELCOME, S2C_SNAPSHOT, SHOT_BLOOD, SHOT_IMPACT, KILL_HEADSHOT, Writer, Reader, CmdRing,
  SnapshotRing, OwnState, EventList, writeHello, writeCmds, readWelcome, readSnapshot, E_ACTIVE, E_TEAM,
} from '../shared/protocol.js';
import { Game } from '../server/game.js';

async function loadBSP(t, name) {
  try {
    return parseBSP((await Deno.readFile(new URL(`../maps/${name}.bsp`, import.meta.url))).buffer);
  } catch {
    await t.step({ name: `skipped: maps/${name}.bsp missing`, fn: () => {}, ignore: true });
    return null;
  }
}

// A client as the browser runs it, minus rendering: it predicts with the shared
// simulation and talks to the Game through a fake session.
class FakeClient {
  constructor(game, bsp, name, team) {
    this.inbox = [];
    this.session = { send: (b) => this.inbox.push(b.slice()), close: () => {} };
    this.game = game;
    this.client = game.connect(this.session);
    this.world = CollisionWorld.fromBSP(bsp);
    this.breakables = new Breakables(bsp, this.world);
    this.player = new Player();
    this.cmds = new CmdRing();
    this.ring = new SnapshotRing();
    this.own = new OwnState();
    this.latest = -1;
    this.latestSeq = 0;
    this.welcome = null;
    this.synced = false;
    this.tick = 1;
    this.w = new Writer();
    this.r = new Reader();
    this.shots = new ShotList();
    this.sizes = [];
    this.events = new EventList();
    this.blood = 0;
    this.impactEvents = 0;
    this.kills = new Map(); // killId -> { killer, victim, headshot }
    game.receive(this.client, writeHello(this.w, team, 0, 0, name).slice());
  }

  poll() {
    for (const bytes of this.inbox.splice(0)) {
      this.sizes.push(bytes.length);
      const r = this.r.set(bytes);
      const type = r.u8v();
      if (type === S2C_WELCOME) this.welcome = readWelcome(r);
      if (type !== S2C_SNAPSHOT) continue;
      const ev = this.events;
      ev.shots = ev.kills = 0;
      const k = readSnapshot(r, this.ring, this.own, ev);
      for (let i = 0; i < ev.shots; i++) ev.kind[i] === SHOT_BLOOD ? this.blood++ : this.impactEvents++;
      for (let i = 0; i < ev.kills; i++) {
        this.kills.set(ev.killId[i], { killer: ev.killer[i], victim: ev.victim[i], headshot: !!(ev.killFlags[i] & KILL_HEADSHOT) });
      }
      if (k < 0 || this.ring.seq[k] <= this.latestSeq) continue;
      this.latest = k;
      this.latestSeq = this.ring.seq[k];
      if (!this.synced) { // first snapshot: adopt the server's spawn
        this.player.psBytes.set(this.own.ps);
        this.player.wsBytes.set(this.own.ws);
        this.synced = true;
      }
    }
  }

  // One client tick: run a command locally and send it (unless `drop`). `view`: the
  // server tick we claim to be seeing other players at (lag compensation).
  play(buttons, yaw, drop = false, pitch = 0, view = 0) {
    this.poll();
    if (!this.synced) return;
    const t = this.tick++;
    this.cmds.put(t, buttons, -1, pitch, yaw, view);
    runCommand(this.world, this.player, buttons, -1, Math.fround(pitch), Math.fround(yaw), t, this.shots);
    const bytes = writeCmds(this.w, this.latestSeq, this.cmds, t).slice();
    if (!drop) this.game.receive(this.client, bytes);
  }
}

Deno.test('server: two players join, move, and the client prediction matches the server bit for bit', async (t) => {
  const bsp = await loadBSP(t, 'de_dust2');
  if (!bsp) return;
  const game = new Game('de_dust2', bsp);
  const a = new FakeClient(game, bsp, 'alice', TEAM_T);
  const b = new FakeClient(game, bsp, 'bob', TEAM_CT);
  assert.equal(a.inbox.length, 1, 'welcome sent');
  game.step();
  a.poll();
  b.poll();
  assert.equal(a.welcome.map, 'de_dust2');
  assert.notEqual(a.welcome.playerId, b.welcome.playerId);

  // Run, strafe, jump, shoot; a third of a's command datagrams are lost.
  for (let i = 0; i < 192; i++) {
    const buttons = IN_FORWARD | (i % 64 < 20 ? IN_MOVELEFT : 0) | (i % 50 === 10 ? IN_JUMP : 0) |
      (i % 40 < 5 ? IN_ATTACK : 0);
    a.play(buttons, 30 + i * 0.7, i % 3 === 1);
    b.play(IN_FORWARD, 200);
    game.step();
  }
  // Drain: let the server catch up with the commands it has.
  for (let i = 0; i < 4; i++) game.step();
  a.poll();
  b.poll();

  for (const c of [a, b]) {
    const server = c.client.player;
    assert.equal(c.own.lastCmd, c.tick - 1, 'server ran every command');
    assert.deepEqual(server.psBytes, c.player.psBytes, 'player state diverged');
    assert.deepEqual(server.wsBytes, c.player.wsBytes, 'weapon state diverged');
    assert.ok(Math.hypot(server.ps.f[PS_ORIGIN] - c.player.ps.f[PS_ORIGIN]) === 0);
  }
  // Each sees the other (and not itself) with the right team.
  const rowB = a.ring.row(a.latest, b.welcome.playerId);
  assert.equal(a.ring.ents[rowB + E_ACTIVE], 1);
  assert.equal(a.ring.ents[rowB + E_TEAM], TEAM_CT);
  assert.equal(a.ring.ents[a.ring.row(a.latest, a.welcome.playerId) + E_ACTIVE], 0);
  assert.ok(Math.max(...a.sizes) <= MAX_DATAGRAM);
});

Deno.test('server: a client cannot run commands faster than real time', async (t) => {
  const bsp = await loadBSP(t, 'de_dust2');
  if (!bsp) return;
  const game = new Game('de_dust2', bsp);
  const a = new FakeClient(game, bsp, 'speedy', TEAM_T);
  game.step();
  a.poll();
  // 64 commands arrive in one burst (a speedhack, or a long stall): the server runs
  // them no faster than its clock allows, plus a small jitter bank.
  for (let i = 0; i < 64; i++) a.play(IN_FORWARD, 0);
  game.step();
  assert.ok(a.client.lastCmd <= 2 + 8, `ran ${a.client.lastCmd} commands in one tick`);
  for (let i = 0; i < 70; i++) game.step();
  assert.equal(a.client.lastCmd, 64, 'all of them run eventually');
});

Deno.test('server: commands lost beyond the redundancy window are replaced, not waited for', async (t) => {
  const bsp = await loadBSP(t, 'de_dust2');
  if (!bsp) return;
  const game = new Game('de_dust2', bsp);
  const a = new FakeClient(game, bsp, 'lossy', TEAM_T);
  game.step();
  a.poll();
  for (let i = 0; i < 30; i++) {
    a.play(IN_FORWARD, 0, i >= 10 && i < 18); // 8 datagrams in a row lost
    game.step();
  }
  game.step();
  assert.equal(a.client.lastCmd, 30);
});

// Places shooter `a` and target `b` in the open, 200-350 units apart with a clear
// line of fire and room for b to strafe; returns the yaw from b to a.
function faceOff(game, a, b) {
  const tr = new Trace();
  const put = (c, x, y, z) => {
    for (const ps of [c.client.player.ps, c.player.ps]) {
      ps.f[PS_ORIGIN] = x;
      ps.f[PS_ORIGIN + 1] = y;
      ps.f[PS_ORIGIN + 2] = z;
    }
  };
  for (const [bx, by, bz] of [...game.spawns[TEAM_CT], ...game.spawns[TEAM_T]]) {
    for (const dist of [250, 200, 350]) {
      for (let deg = 0; deg < 360; deg += 15) {
        const r = deg * Math.PI / 180;
        const ax = bx + Math.cos(r) * dist, ay = by + Math.sin(r) * dist;
        if (!hullFits(game.world, HULL_STAND, ax, ay, bz)) continue;
        let clear = true;
        for (const side of [-70, 0, 70]) { // the strafe lane must be visible and walkable
          const sx = bx - Math.sin(r) * side, sy = by + Math.cos(r) * side;
          traceHull(game.world, HULL_POINT, ax, ay, bz + 28, sx, sy, bz + 14, tr);
          if (tr.fraction < 1 || !hullFits(game.world, HULL_STAND, sx, sy, bz)) clear = false;
        }
        traceHull(game.world, HULL_POINT, bx, by, bz, bx, by, bz - 64, tr);
        if (!clear || tr.fraction === 1) continue; // b must stand on the ground
        put(a, ax, ay, bz);
        put(b, bx, by, bz);
        return deg;
      }
    }
  }
  throw new Error('no open spot');
}

// Angles from the shooter's eye to point (x, y, z), CS:GO convention (pitch down > 0).
function aimAt(shooter, x, y, z) {
  const f = shooter.client.player.ps.f;
  const dx = x - f[PS_ORIGIN], dy = y - f[PS_ORIGIN + 1], dz = z - (f[PS_ORIGIN + 2] + eyeOffset(shooter.client.player.ps));
  return [-Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI, Math.atan2(dy, dx) * 180 / Math.PI];
}

// b strafes for 30 ticks; then a fires once at where b was 20 ticks ago, claiming to
// see that tick (view). Returns b's health afterwards and how far b had moved.
async function strafeAndShoot(t, viewFromPast) {
  const bsp = await loadBSP(t, 'de_dust2');
  if (!bsp) return null;
  const game = new Game('de_dust2', bsp);
  const a = new FakeClient(game, bsp, 'shooter', TEAM_T);
  const b = new FakeClient(game, bsp, 'target', TEAM_CT);
  game.step();
  a.poll();
  b.poll();
  const deg = faceOff(game, a, b);
  const seen = new Map();
  for (let i = 0; i < 30; i++) {
    a.play(0, deg + 180);
    b.play(IN_MOVERIGHT, deg);
    game.step();
    seen.set(game.tick, [...b.client.player.ps.f.subarray(PS_ORIGIN, PS_ORIGIN + 3)]);
  }
  const past = game.tick - 20;
  const [x, y, z] = seen.get(past);
  const [pitch, yaw] = aimAt(a, x, y, z + 14); // chest
  a.play(IN_ATTACK, yaw, false, pitch, viewFromPast ? past : game.tick);
  b.play(0, deg);
  game.step();
  game.step();
  a.poll();
  b.poll();
  const now = b.client.player.ps.f;
  return { health: b.client.player.health, moved: Math.hypot(now[0] - x, now[1] - y), a, b };
}

Deno.test('lag compensation: a shot where the target was on the shooter screen hits', async (t) => {
  const r = await strafeAndShoot(t, true);
  if (!r) return;
  assert.ok(r.moved > 40, `target only moved ${r.moved} units`);
  assert.ok(r.health < 100 && r.health > 0, `target health ${r.health}`);
  assert.ok(r.a.blood >= 1 && r.b.blood >= 1, 'both see the blood');
});

Deno.test('lag compensation: the same shot claimed at the current tick misses', async (t) => {
  const r = await strafeAndShoot(t, false);
  if (!r) return;
  assert.equal(r.health, 100);
  assert.ok(r.b.impactEvents >= 1, 'the target sees the bullet hit the wall');
  assert.equal(r.a.impactEvents, 0, 'the shooter already drew its own impact');
});

Deno.test('a headshot kills; everyone gets the kill; the victim respawns after 2 s', async (t) => {
  const bsp = await loadBSP(t, 'de_dust2');
  if (!bsp) return;
  const game = new Game('de_dust2', bsp);
  const a = new FakeClient(game, bsp, 'shooter', TEAM_T);
  const b = new FakeClient(game, bsp, 'target', TEAM_CT);
  game.step();
  a.poll();
  b.poll();
  const deg = faceOff(game, a, b);
  a.play(0, deg + 180);
  b.play(0, deg);
  game.step();
  const bp = b.client.player.ps.f;
  const [pitch, yaw] = aimAt(a, bp[PS_ORIGIN], bp[PS_ORIGIN + 1], bp[PS_ORIGIN + 2] + 28); // head
  a.play(IN_ATTACK, yaw, false, pitch, game.tick);
  b.play(0, deg);
  game.step();
  a.poll();
  b.poll();
  assert.equal(b.client.player.health, 0);
  for (const c of [a, b]) {
    const kills = [...c.kills.values()];
    assert.equal(kills.length, 1);
    assert.deepEqual(kills[0], { killer: a.welcome.playerId, victim: b.welcome.playerId, headshot: true });
  }
  assert.equal(b.own.health, 0);
  const spawnCount = b.own.spawnCount;
  for (let i = 0; i < 130; i++) {
    a.play(0, 0);
    b.play(0, 0);
    game.step();
  }
  b.poll();
  assert.equal(b.own.health, 100, 'respawned');
  assert.notEqual(b.own.spawnCount, spawnCount);
});
