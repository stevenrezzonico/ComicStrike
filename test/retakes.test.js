// Retakes (cfg/gamemode_retakes.cfg, Game.retakeSetup): the round starts with the bomb
// planted in a site, the Ts round it and the CTs further off facing it, no buying,
// loadouts by round and a kit for every CT; the bomb ticks from the end of the freeze. On
// de_playground (two sites), so no Valve map is needed.
import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { WS_SLOTS, SLOT_PRIMARY, SLOT_C4, WEAPONS, WEAPON_ID } from '../shared/weapons.js';
import { PHASE_FREEZE, GAME_RETAKES } from '../shared/economy.js';
import { TICK_RATE } from '../shared/constants.js';
import { Writer } from '../shared/protocol.js';
import { Host } from '../server/host.js';
import { loadMap, readCfg, joinClient, sendCmd } from './harness.js';

const bsp = loadMap('de_playground');

Deno.test('retakes: the bomb is planted in a site, Ts round it, CTs further off, loadouts and kits', () => {
  const host = new Host({ loadMap: () => bsp, listMaps: () => ['de_playground'], readCfg, print: () => {} });
  host.con.exec('game_type 0; game_mode 3');
  host.start('de_playground');
  const game = host.game, w = new Writer(), humans = [];
  assert.equal(host.modeName, 'retakes');
  assert.ok(!game.rules.giveC4 && game.rules.freezeTime === 3, 'the mode cfg ran');
  const join = (name, team) => {
    const c = joinClient(game, w, name, team);
    humans.push(c);
    return c;
  };
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of humans) sendCmd(game, w, c);
      game.step();
    }
  };
  const ts = [join('t1', TEAM_T), join('t2', TEAM_T)], cts = [join('ct1', TEAM_CT), join('ct2', TEAM_CT)];
  run(4);
  for (let round = 0; round < 3; round++) {
    if (round) game.startRound(false);
    assert.equal(game.phase, PHASE_FREEZE);
    assert.equal(game.round.mode & GAME_RETAKES, GAME_RETAKES);
    const b = game.bomb;
    assert.equal(b.state, BOMB_PLANTED, 'planted at the start');
    assert.ok(game.bombSites.boxes.some((s) => b.x >= s[0] && b.x <= s[3] && b.y >= s[1] && b.y <= s[4]), 'in a site');
    const full = (game.rules.freezeTime + game.rules.c4Timer) * TICK_RATE;
    assert.ok(b.ticksLeft <= full && b.ticksLeft > full - 8, `ticking from the end of the freeze: ${b.ticksLeft} of ${full}`);
    const off = (c) => Math.hypot(c.player.ps.f[PS_ORIGIN] - b.x, c.player.ps.f[PS_ORIGIN + 1] - b.y);
    for (const c of ts) assert.ok(off(c) >= 150 && off(c) <= 700, `a T round the bomb: ${off(c).toFixed(0)}`);
    for (const c of cts) assert.ok(off(c) >= 1000 && off(c) <= 1800, `a CT at the entrances: ${off(c).toFixed(0)}`);
    for (const c of [...ts, ...cts]) {
      assert.ok(!game.canBuy(c), 'no buying');
      assert.equal(c.player.armor, 100);
      const primary = WEAPONS[c.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3]];
      if (game.round.round <= 2) assert.ok(!primary, 'pistols the first rounds');
      else assert.ok(primary && c.player.helmet, `a rifle or an SMG and a helmet: ${primary?.name}`);
    }
    for (const c of cts) assert.ok(c.player.defuser, 'a kit for every CT');
    for (const c of ts) assert.ok(!c.player.ws.f[WS_SLOTS + SLOT_C4 * 3], 'nobody carries a bomb');
  }
  assert.ok(WEAPON_ID.mp9 && WEAPON_ID.mac10);
});
