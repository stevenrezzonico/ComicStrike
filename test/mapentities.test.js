// CS 1.6 map entities the game runs besides doors and triggers (shared/doors.js MapLogic,
// server/game.js): trigger_hurt, env_explosion, game_text, player_weaponstrip, trigger_teleport
// (shared/player.js, predicted), info_map_parameters' buying rule and game_player_equip, in
// compiled yards.
import assert from 'node:assert/strict';
import { box, NONE } from '../shared/bspwriter.js';
import { TICK_RATE } from '../shared/constants.js';
import { PS_ORIGIN, PS_VEL } from '../shared/pmove.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { Reader, Writer, S2C_CHAT, CHAT_MAP, CHAT_CONSOLE, readChat } from '../shared/protocol.js';
import { WEAPON_ID, WS_SLOTS, WS_ACTIVE, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, giveWeapon } from '../shared/weapons.js';
import { FX_BLAST } from '../shared/grenades.js';
import { mapBuying, teamMayBuy } from '../shared/economy.js';
import { Game } from '../server/game.js';
import { yard, walker, quiet, joinClient } from './harness.js';

const trigger = (map, keys, x0, y0, x1, y1) => map.brushEntity(keys, [box(x0, y0, 0, x1, y1, 100, NONE)]);
const bsp = yard((map) => {
  trigger(map, { classname: 'trigger_hurt', dmg: '20' }, -200, -500, 0, -300);
  trigger(map, { classname: 'trigger_hurt', dmg: '1000' }, -600, -500, -400, -300);
  trigger(map, { classname: 'trigger_multiple', target: 'boom' }, 200, -500, 300, -400);
  map.point({ classname: 'env_explosion', targetname: 'boom', origin: '250 -300 16', iMagnitude: '100' });
  trigger(map, { classname: 'trigger_multiple', target: 'hello' }, 400, -500, 500, -400);
  map.point({ classname: 'game_text', targetname: 'hello', message: 'Line one\\nLine two', origin: '0 0 0' });
  trigger(map, { classname: 'trigger_multiple', target: 'strip' }, 600, -500, 700, -400);
  map.point({ classname: 'game_text', targetname: 'game_playerspawn', spawnflags: '1', message: 'Welcome', origin: '0 0 0' });
  map.point({ classname: 'player_weaponstrip', targetname: 'strip', origin: '0 0 0' });
  trigger(map, { classname: 'trigger_teleport', target: 'dest' }, -200, 300, 0, 500);
  map.point({ classname: 'info_teleport_destination', targetname: 'dest', origin: '600 300 0', angles: '0 90 0' });
});
const secs = (s) => Math.round(s * TICK_RATE);

Deno.test('trigger_hurt: dmg a second in half-second doses while touched, nothing outside; a kill volume kills', () => {
  const { c, run, put } = walker(bsp);
  put(-800, 0, 0);
  run(secs(1));
  assert.equal(c.player.health, 100, 'outside: untouched');
  put(-100, -400, 0);
  run(secs(1));
  assert.equal(c.player.health, 80, 'two doses of 10 in the first second');
  run(1);
  assert.equal(c.player.health, 70, 'the third at 1 s');
  put(-500, -400, 0);
  run(1);
  assert.ok(!c.alive, 'dead in the kill volume');
  assert.equal(c.player.deaths, 1);
});

Deno.test('env_explosion: fired by name, a fireball of its magnitude and its damage round it, once a round', () => {
  const { game, c, run, put } = walker(bsp);
  put(250, -450, 0); // in the trigger, 150 from the explosion
  run(1);
  const k = Array.from(game.grenades.fxKind.subarray(0, game.grenades.fxCount)).indexOf(FX_BLAST);
  assert.ok(k >= 0, 'a fireball');
  assert.equal(game.grenades.fxWeapon[k], 100, 'sized by its magnitude');
  const hurt = 100 - c.player.health;
  assert.ok(hurt > 10 && hurt < 60, `hurt ${hurt}`);
  run(secs(1)); // still in the trigger, which fires again: not repeatable
  assert.equal(100 - c.player.health, hurt, 'once');
});

Deno.test('game_text: its lines to the player who set it off, as chat lines of the map with no sender', () => {
  const { c, run, put, inbox } = walker(bsp);
  inbox.length = 0;
  put(450, -450, 0);
  run(1);
  const r = new Reader(), lines = [];
  for (const b of inbox) {
    r.set(b);
    if (r.u8v() !== S2C_CHAT) continue;
    const m = readChat(r);
    if (m.flags & CHAT_MAP) lines.push(m);
  }
  assert.deepEqual(lines.map((m) => m.text).filter((t) => t !== 'Welcome'), ['Line one', 'Line two']);
  assert.ok(lines.every((m) => m.sender === CHAT_CONSOLE));
  assert.ok(c.alive);
});

Deno.test('game_playerspawn: CS 1.6 fires it a second after each spawn (a greeting the joiner sees after its WELCOME)', () => {
  const { run, inbox } = walker(bsp); // (joined two ticks ago)
  const said = () => {
    const r = new Reader(), out = [];
    for (const b of inbox.splice(0)) {
      r.set(b);
      if (r.u8v() === S2C_CHAT) out.push(readChat(r).text);
    }
    return out;
  };
  run(secs(0.9));
  assert.deepEqual(said(), [], 'not before the second');
  run(secs(0.2));
  assert.deepEqual(said(), ['Welcome']);
});

Deno.test('player_weaponstrip: everything but the knife goes', () => {
  const { c, run, put } = walker(bsp);
  giveWeapon(c.player.ws, WEAPON_ID.ak47);
  giveWeapon(c.player.ws, WEAPON_ID.hegrenade);
  put(650, -450, 0);
  run(1);
  const f = c.player.ws.f;
  assert.equal(f[WS_SLOTS + SLOT_PRIMARY * 3], 0);
  assert.equal(f[WS_SLOTS + SLOT_SECONDARY * 3], 0);
  assert.equal(f[WS_SLOTS + SLOT_KNIFE * 3], WEAPON_ID.knife);
  assert.equal(f[WS_ACTIVE], SLOT_KNIFE);
});

Deno.test('trigger_teleport: to the destination (feet a unit up), at rest, facing its yaw', () => {
  const { c, run, put } = walker(bsp);
  put(-300, 400, 0);
  run(1);
  c.player.ps.f[PS_VEL] = 0;
  put(-100, 400, 0);
  run(1);
  const f = c.player.ps.f;
  assert.ok(Math.hypot(f[PS_ORIGIN] - 600, f[PS_ORIGIN + 1] - 300) < 1, `at ${f[PS_ORIGIN]} ${f[PS_ORIGIN + 1]}`);
  assert.ok(Math.abs(f[PS_ORIGIN + 2] - 37) < 2, `z ${f[PS_ORIGIN + 2]}`);
  assert.equal(Math.hypot(f[PS_VEL], f[PS_VEL + 1]), 0);
  assert.equal(c.player.teleportYaw, 90);
});

// A yard whose info_map_parameters says `buying`, with a game_player_equip.
const shop = (buying) => yard((map) => {
  map.point({ classname: 'info_map_parameters', buying: String(buying), origin: '0 0 0' });
  map.point({ classname: 'game_player_equip', weapon_usp: '1', weapon_knife: '1', ammo_45acp: '4', origin: '0 0 0' });
});

Deno.test('info_map_parameters buying: 3 nobody, 1 only the CTs, 0 everyone (the demo ignores it)', () => {
  assert.equal(mapBuying(shop(3)), 3);
  assert.ok(!teamMayBuy(3, TEAM_T) && !teamMayBuy(3, TEAM_CT));
  assert.ok(!teamMayBuy(1, TEAM_T) && teamMayBuy(1, TEAM_CT));
  assert.ok(teamMayBuy(2, TEAM_T) && !teamMayBuy(2, TEAM_CT));
  for (const [buying, tBuys, ctBuys] of [[3, false, false], [1, false, true], [0, true, true]]) {
    const game = quiet(() => new Game('test', shop(buying), { rounds: false }));
    const w = new Writer();
    const t = joinClient(game, w, 't', TEAM_T), ct = joinClient(game, w, 'ct', TEAM_CT);
    assert.equal(game.canBuy(t), tBuys, `buying ${buying}, T`);
    assert.equal(game.canBuy(ct), ctBuys, `buying ${buying}, CT`);
  }
  const demo = quiet(() => new Game('test', shop(3), { rounds: false, demo: true }));
  assert.ok(demo.canBuy(joinClient(demo, new Writer(), 't', TEAM_T)), 'the demo buys anyway');
});

Deno.test('game_player_equip: a spawn gets its weapons instead of the default pistol', () => {
  const game = quiet(() => new Game('test', shop(0), { rounds: false }));
  const c = joinClient(game, new Writer(), 't', TEAM_T);
  const f = c.player.ws.f;
  assert.equal(f[WS_SLOTS + SLOT_SECONDARY * 3], WEAPON_ID.usp_silencer, 'the USP, not the Glock');
  assert.equal(f[WS_SLOTS + SLOT_KNIFE * 3], WEAPON_ID.knife);
  assert.equal(f[WS_ACTIVE], SLOT_SECONDARY);
  const plain = quiet(() => new Game('test', bsp, { rounds: false }));
  const d = joinClient(plain, new Writer(), 't', TEAM_T);
  assert.equal(d.player.ws.f[WS_SLOTS + SLOT_SECONDARY * 3], WEAPON_ID.glock, 'no equip: the default');
});
