// The demo mode's practice tools: noclip (shared, predicted, the demo or sv_cheats only),
// bot_place through the Host with the caller's view, the grenade arcs and impact boxes kept
// for drawing (client/gl/practice.js).
import assert from 'node:assert/strict';
import { TEAM_CT } from '../shared/player.js';
import { IN_JUMP, IN_FORWARD } from '../shared/constants.js';
import {
  PS_ORIGIN, PS_FLAGS, FL_NOCLIP, FL_ONGROUND, NOCLIP_SPEED, createPlayerState, noclipMove, playerMove,
} from '../shared/pmove.js';
import { traceHull, Trace, HULL_POINT, hullFits, HULL_STAND } from '../shared/trace.js';
import { Writer, Reader, writeCommand, S2C_PRINT } from '../shared/protocol.js';
import { Host } from '../server/host.js';
import { TrajectoryLog, ImpactLog, TRAIL_KEEP, IMPACT_KEEP, MAX_IMPACTS, TRAIL_POINTS } from '../client/gl/practice.js';
import { loadMap, readCfg, joinClient, sendCmd } from './harness.js';

const MAP = 'de_playground';
const bsp = loadMap(MAP);

// A Host on the playground in `mode` (the real cfg files), and a way in for players.
function setup(mode) {
  const host = new Host({
    loadMap: () => bsp, listMaps: () => [MAP], print: () => {}, now: () => 0, readCfg,
  });
  host.con.exec(mode === 'demo' ? 'game_type 2; game_mode 0' : 'game_type 0; game_mode 1');
  host.start(MAP);
  host.con.exec('rcon_password practice; bot_quota 0');
  const w = new Writer();
  let cmdId = 0;
  const join = (name, team) => {
    const sent = [];
    const c = joinClient(host.game, w, name, team, { send: (b) => sent.push(b.slice()), close() {}, closed: false });
    c.prints = () => sent.filter((b) => b[0] === S2C_PRINT).map((b) => {
      const r = new Reader().set(b);
      r.u8v();
      return r.lstr();
    });
    c.command = (text) => host.game.receive(c, writeCommand(w, ++cmdId, text).slice());
    return c;
  };
  // Every tick c holds `buttons`, looking at (pitch, yaw).
  const run = (c, ticks, buttons = 0, pitch = 0, yaw = 0) => {
    for (let i = 0; i < ticks; i++) {
      sendCmd(host.game, w, c, buttons, -1, pitch, yaw);
      host.game.step();
    }
  };
  return { host, join, run };
}

Deno.test('practice: noclip flies through everything, only in the demo or with sv_cheats', () => {
  const comp = setup('competitive');
  const a = comp.join('player', TEAM_CT);
  comp.run(a, 64);
  a.command('noclip');
  assert.ok(!(a.player.ps.i[PS_FLAGS] & FL_NOCLIP));
  assert.ok(a.prints().some((s) => /Can't use cheat command noclip/.test(s)));

  const demo = setup('demo');
  assert.ok(demo.host.game.rules.demo);
  const p = demo.join('player', TEAM_CT);
  demo.run(p, 64);
  assert.ok(p.alive);
  p.command('noclip');
  assert.ok(p.player.ps.i[PS_FLAGS] & FL_NOCLIP);
  assert.ok(p.prints().includes('noclip ON'));
  // Up through the sky box, one second at NOCLIP_SPEED.
  const z0 = p.player.ps.f[PS_ORIGIN + 2];
  demo.run(p, 64, IN_JUMP);
  assert.ok(Math.abs(p.player.ps.f[PS_ORIGIN + 2] - z0 - NOCLIP_SPEED) < 1, `${p.player.ps.f[PS_ORIGIN + 2] - z0}`);
  assert.ok(!(p.player.ps.i[PS_FLAGS] & FL_ONGROUND));
  p.command('noclip');
  assert.ok(!(p.player.ps.i[PS_FLAGS] & FL_NOCLIP));
  assert.ok(p.prints().includes('noclip OFF'));
});

Deno.test('practice: the noclip move is the shared one, so prediction matches it', () => {
  const a = createPlayerState(), b = createPlayerState();
  a.f[PS_ORIGIN + 2] = b.f[PS_ORIGIN + 2] = 100;
  a.i[PS_FLAGS] = b.i[PS_FLAGS] = FL_NOCLIP | FL_ONGROUND;
  for (let i = 0; i < 50; i++) {
    playerMove(null, a, IN_FORWARD, 20 + i, 30 - i, 1 / 64, 250); // as runCommand does it
    noclipMove(b, IN_FORWARD, 20 + i, 30 - i, 1 / 64);
  }
  assert.deepEqual([...a.i], [...b.i], 'bit for bit');
  assert.ok(a.f[PS_ORIGIN] > 100, 'moved along the view');
});

Deno.test('practice: bot_place puts bots where the player looks, facing him', () => {
  const s = setup('demo');
  const p = s.join('player', TEAM_CT);
  s.host.con.exec('bot_stop 1; bot_add_t; bot_add_t');
  s.run(p, 64);
  const bots = s.host.game.bots.list.map((b) => b.c);
  assert.equal(bots.length, 2);
  // Looking a little down along +x from where we stand: the floor ahead.
  const pitch = 20, yaw = 0;
  s.run(p, 2, 0, pitch, yaw);
  const f = p.player.ps.f, tr = new Trace();
  const ez = f[PS_ORIGIN + 2] + 28, dz = -Math.sin(pitch * Math.PI / 180), dx = Math.cos(pitch * Math.PI / 180);
  traceHull(s.host.game.world, HULL_POINT, f[PS_ORIGIN], f[PS_ORIGIN + 1], ez, f[PS_ORIGIN] + dx * 8192, f[PS_ORIGIN + 1],
    ez + dz * 8192, tr);
  const out = s.host.rcon(p, 'practice', 'bot_place');
  assert.equal(out, 'placed 1 bot(s)');
  const placed = bots.find((c) => Math.hypot(c.player.ps.f[PS_ORIGIN] - tr.endx, c.player.ps.f[PS_ORIGIN + 1] - tr.endy) < 40);
  assert.ok(placed, 'a bot where we look');
  const bf = placed.player.ps.f;
  assert.ok(hullFits(s.host.game.world, HULL_STAND, bf[PS_ORIGIN], bf[PS_ORIGIN + 1], bf[PS_ORIGIN + 2]));
  // It stays there (bot_stop) and stands on the floor.
  s.run(p, 32, 0, pitch, yaw);
  assert.ok(Math.hypot(bf[PS_ORIGIN] - tr.endx, bf[PS_ORIGIN + 1] - tr.endy) < 40);
  assert.ok(placed.player.ps.i[PS_FLAGS] & FL_ONGROUND);
  // All: both, in a row across the view.
  assert.equal(s.host.rcon(p, 'practice', 'bot_place all'), 'placed 2 bot(s)');
  const [b0, b1] = bots.map((c) => c.player.ps.f);
  assert.ok(Math.abs(Math.hypot(b0[PS_ORIGIN] - b1[PS_ORIGIN], b0[PS_ORIGIN + 1] - b1[PS_ORIGIN + 1]) - 40) < 1);
  // Not in a competitive game without sv_cheats.
  const comp = setup('competitive');
  const q = comp.join('player', TEAM_CT);
  comp.host.con.exec('bot_add_t');
  comp.run(q, 4);
  assert.match(comp.host.rcon(q, 'practice', 'bot_place'), /needs sv_cheats/);
  // From the server's own console: nobody's view to use.
  const lines = [];
  s.host.con.exec('bot_place', { print: (t) => lines.push(t) });
  assert.match(lines.join(), /run it as a player/);
});

Deno.test('practice: grenade arcs are kept until 3 s after landing, impacts for 2 s', () => {
  const log = new TrajectoryLog();
  const list = { count: 1, id: [7], weapon: [44], pos: new Float64Array(3), resting: [0] };
  for (let i = 0; i < 40; i++) {
    list.pos[0] = i * 10;
    list.pos[2] = 100 + i * (20 - i);
    log.record(list, i / 64);
  }
  const t = log.trails.get(7);
  assert.equal(t.n, 40);
  assert.equal(t.landedAt, -1, 'still flying');
  assert.deepEqual([t.pts[39 * 3], t.pts[39 * 3 + 2]], [390, 100 + 39 * -19]);
  list.count = 0; // gone: it went off
  log.record(list, 1);
  assert.equal(log.trails.get(7).landedAt, 1);
  log.record(list, 1 + TRAIL_KEEP - 0.01);
  assert.ok(log.trails.has(7));
  log.expire(1 + TRAIL_KEEP + 0.01);
  assert.ok(!log.trails.has(7));
  // A long flight keeps its shape in TRAIL_POINTS (every other point once full).
  list.count = 1;
  list.id[0] = 8;
  for (let i = 0; i < TRAIL_POINTS + 10; i++) {
    list.pos[0] = i;
    log.record(list, 5);
  }
  const long = log.trails.get(8);
  assert.ok(long.n <= TRAIL_POINTS && long.n > TRAIL_POINTS / 2);
  assert.equal(long.pts[0], 0);
  assert.equal(long.pts[(long.n - 1) * 3], TRAIL_POINTS + 9, 'the newest point last');
  // Resting (a smoke rolled to a stop): landed where it lies.
  list.resting[0] = 1;
  log.record(list, 6);
  assert.equal(long.landedAt, 6);

  const imp = new ImpactLog();
  for (let i = 0; i < MAX_IMPACTS + 5; i++) imp.add(i, 0, 0, i < 5 ? 0 : 10);
  const seen = [];
  assert.equal(imp.each(10.5, (x) => seen.push(x)), MAX_IMPACTS, 'the newest MAX_IMPACTS');
  assert.ok(!seen.includes(0));
  assert.equal(imp.each(10 + IMPACT_KEEP + 0.01, () => {}), 0, 'gone after IMPACT_KEEP');
});
