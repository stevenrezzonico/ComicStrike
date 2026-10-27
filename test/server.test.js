import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { IN_FORWARD, IN_MOVELEFT, IN_JUMP, IN_ATTACK } from '../shared/constants.js';
import { CollisionWorld } from '../shared/trace.js';
import { Breakables } from '../shared/breakables.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { ShotList } from '../shared/weapons.js';
import { Player, runCommand, TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  MAX_DATAGRAM, S2C_WELCOME, S2C_SNAPSHOT, Writer, Reader, CmdRing, SnapshotRing, OwnState, writeHello, writeCmds,
  readWelcome, readSnapshot, E_ACTIVE, E_TEAM,
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
    game.receive(this.client, writeHello(this.w, team, 0, 0, name).slice());
  }

  poll() {
    for (const bytes of this.inbox.splice(0)) {
      this.sizes.push(bytes.length);
      const r = this.r.set(bytes);
      const type = r.u8v();
      if (type === S2C_WELCOME) this.welcome = readWelcome(r);
      if (type !== S2C_SNAPSHOT) continue;
      const k = readSnapshot(r, this.ring, this.own);
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

  // One client tick: run a command locally and send it (unless `drop`).
  play(buttons, yaw, drop = false) {
    this.poll();
    if (!this.synced) return;
    const t = this.tick++;
    this.cmds.put(t, buttons, -1, 0, yaw);
    runCommand(this.world, this.player, buttons, -1, 0, Math.fround(yaw), t, this.shots);
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
