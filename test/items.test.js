import assert from 'node:assert/strict';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { IN_DROP, IN_USE } from '../shared/constants.js';
import {
  WEAPONS, WEAPON_ID, WS_SLOTS, WS_ACTIVE, SLOT_PRIMARY, SLOT_SECONDARY, SLOT_C4, grenadeCount, giveWeapon,
} from '../shared/weapons.js';
import { BOMB_DROPPED } from '../shared/bomb.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { Writer, Reader, writeBuy, readItems, S2C_ITEMS } from '../shared/protocol.js';
import { Items, MAX_ITEMS } from '../shared/items.js';
import { Game } from '../server/game.js';
import { loadMap, mapOrNull, joinClient, sendCmd } from './harness.js';
import { boxWorld, FLOOR } from './worlds.js';

const bsp = mapOrNull('de_dust2');

// A game with free buying and no round flow, and helpers to drive clients.
function setup(map = 'de_dust2', b = bsp) {
  const game = new Game(map, b, { rounds: false });
  const w = new Writer();
  let buyId = 0;
  const join = (name, team) => {
    const sent = [];
    const c = joinClient(game, w, name, team, { send: (b) => sent.push(b.slice()), close: () => {}, closed: false });
    c.sent = sent;
    c.next = { buttons: 0, pitch: 0, yaw: 0 };
    c.buy = (item) => game.receive(c, writeBuy(w, ++buyId, item).slice());
    // The newest ground list this client was sent.
    c.items = () => {
      const msg = sent.filter((b) => b instanceof Uint8Array && b[0] === S2C_ITEMS).at(-1);
      const items = new Items();
      if (msg) {
        const r = new Reader().set(msg);
        r.u8v();
        readItems(r, items);
      }
      return items;
    };
    return c;
  };
  const run = (ticks, players) => {
    for (let i = 0; i < ticks; i++) {
      for (const c of players) sendCmd(game, w, c, c.next.buttons, -1, c.next.pitch, c.next.yaw);
      game.step();
    }
  };
  const slot = (c, s) => c.player.ws.f[WS_SLOTS + s * 3];
  return { game, join, run, slot };
}

Deno.test('buying a second kind of grenade drops nothing', () => {
  const { game, join, run } = setup('de_playground', loadMap('de_playground'));
  const a = join('alpha', TEAM_T);
  run(2, [a]);
  a.buy(WEAPON_ID.hegrenade);
  run(2, [a]);
  a.buy(WEAPON_ID.flashbang);
  run(2, [a]);
  assert.equal(game.items.count, 0, 'no free copy on the ground');
  assert.equal(grenadeCount(a.player.ws, WEAPON_ID.hegrenade), 1);
  assert.equal(grenadeCount(a.player.ws, WEAPON_ID.flashbang), 1);
});

Deno.test({ name: 'weapons on the ground: buying over a pistol drops it, the ground list reaches clients', ignore: !bsp, fn: () => {
  const { game, join, run, slot } = setup();
  const a = join('alpha', TEAM_T);
  run(2, [a]);
  assert.equal(slot(a, SLOT_SECONDARY), WEAPON_ID.glock, 'Ts start with a Glock');
  a.buy(WEAPON_ID.deagle);
  run(2, [a]);
  assert.equal(slot(a, SLOT_SECONDARY), WEAPON_ID.deagle);
  assert.equal(game.items.count, 1);
  assert.equal(game.items.weapon[0], WEAPON_ID.glock, 'the Glock lies on the ground');
  assert.equal(game.items.clip[0], 20, 'with its ammunition');
  const sent = a.items();
  assert.equal(sent.count, 1);
  assert.equal(sent.weapon[0], WEAPON_ID.glock);
  const f = a.player.ps.f;
  assert.ok(Math.hypot(sent.x[0] - f[PS_ORIGIN], sent.y[0] - f[PS_ORIGIN + 1]) < 70, 'thrown just ahead');
} });

Deno.test({ name: 'weapons on the ground: G drops the gun in hand; walking over it with the slot free picks it up', ignore: !bsp, fn: () => {
  const { game, join, run, slot } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2, [a, b]);
  a.buy(WEAPON_ID.ak47);
  run(70, [a, b]); // deploy
  a.player.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  a.next.buttons = IN_DROP;
  run(1, [a, b]);
  a.next.buttons = 0;
  run(1, [a, b]);
  assert.equal(slot(a, SLOT_PRIMARY), 0, 'dropped');
  assert.equal(game.items.count, 1);
  assert.equal(game.items.weapon[0], WEAPON_ID.ak47);
  // The knife cannot be dropped.
  a.player.ws.f[WS_ACTIVE] = 2;
  a.next.buttons = IN_DROP;
  run(2, [a, b]);
  a.next.buttons = 0;
  assert.equal(game.items.count, 1);
  // Bravo (primary slot emptied) stands on it after the pickup delay and takes it.
  b.player.ws.f.fill(0, WS_SLOTS + SLOT_PRIMARY * 3, WS_SLOTS + SLOT_PRIMARY * 3 + 3);
  run(64, [a, b]);
  const bf = b.player.ps.f;
  bf[PS_ORIGIN] = game.items.x[0];
  bf[PS_ORIGIN + 1] = game.items.y[0];
  bf[PS_ORIGIN + 2] = game.items.z[0] + 36;
  run(3, [a, b]);
  assert.equal(slot(b, SLOT_PRIMARY), WEAPON_ID.ak47);
  assert.equal(game.items.count, 0);
} });

Deno.test({ name: 'weapons on the ground: the dead drop their primary; E swaps a pistol for the one looked at', ignore: !bsp, fn: () => {
  const { game, join, run, slot } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2, [a, b]);
  a.buy(WEAPON_ID.ak47);
  run(2, [a, b]);
  game.kill(a, a, 0, false);
  assert.equal(game.items.count, 1);
  assert.equal(game.items.weapon[0], WEAPON_ID.ak47, 'primary first');
  assert.equal(slot(a, SLOT_PRIMARY), 0);

  // Bravo (USP-S) looks down at a Deagle on the floor in front and presses E.
  game.items.clear();
  const bf = b.player.ps.f;
  game.items.add(WEAPON_ID.deagle, 7, 35, bf[PS_ORIGIN] + 40, bf[PS_ORIGIN + 1], bf[PS_ORIGIN + 2] - 36, 0, 0);
  b.next.yaw = 0;
  b.next.pitch = 50;
  b.next.buttons = IN_USE;
  run(1, [a, b]);
  b.next.buttons = 0;
  run(1, [a, b]);
  assert.equal(slot(b, SLOT_SECONDARY), WEAPON_ID.deagle, 'E took the Deagle');
  assert.equal(game.items.count, 1);
  assert.equal(game.items.weapon[0], WEAPON_ID.usp_silencer, 'and left the USP-S');
  // Holding E does not keep swapping.
  b.next.buttons = IN_USE;
  run(5, [a, b]);
  assert.equal(slot(b, SLOT_SECONDARY), WEAPON_ID.deagle);
} });

Deno.test({ name: 'weapons on the ground: G throws the gun in an arc; it lands ahead and only then can be taken', ignore: !bsp, fn: () => {
  const { game, join, run, slot } = setup();
  const a = join('alpha', TEAM_T), b = join('bravo', TEAM_CT);
  run(2, [a, b]);
  a.buy(WEAPON_ID.ak47);
  run(70, [a, b]);
  a.player.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  const f = a.player.ps.f, x0 = f[PS_ORIGIN], y0 = f[PS_ORIGIN + 1], feet = f[PS_ORIGIN + 2] - 36;
  a.next.buttons = IN_DROP;
  run(1, [a, b]);
  a.next.buttons = 0;
  const it = game.items;
  assert.equal(it.count, 1);
  assert.equal(it.flying[0], 1, 'in the air');
  const sent = a.items();
  assert.equal(sent.flying[0], 1, 'clients are told it flies');
  assert.equal(sent.owner[0], a.id, 'and who threw it');
  // Bravo (no primary) stands in its path: nothing is caught in the air.
  b.player.ws.f.fill(0, WS_SLOTS + SLOT_PRIMARY * 3, WS_SLOTS + SLOT_PRIMARY * 3 + 3);
  const heights = [];
  const bf = b.player.ps.f;
  for (let t = 0; t < 3 * 64 && it.flying[0]; t++) {
    bf[PS_ORIGIN] = it.x[0];
    bf[PS_ORIGIN + 1] = it.y[0];
    bf[PS_ORIGIN + 2] = feet + 36;
    run(1, [a, b]);
    if (it.flying[0]) assert.equal(slot(b, SLOT_PRIMARY), 0, 'not taken in the air');
    heights.push(it.z[0]);
  }
  assert.equal(it.flying[0], 0, 'it came to rest');
  const top = Math.max(...heights);
  assert.ok(top > heights[0], 'it rose first');
  assert.ok(Math.abs(it.z[0] - feet) < 2, `on the floor (${it.z[0]} vs feet ${feet})`);
  const d = Math.hypot(it.x[0] - x0, it.y[0] - y0);
  assert.ok(d > 80 && d < 400, `well ahead (${d.toFixed(0)} units)`);
  run(2, [a, b]);
  assert.equal(a.items().flying[0], 0, 'clients are told it lies still');
} });

const buzzkill = mapOrNull('fy_buzzkill');

Deno.test({ name: "weapons on the ground: fy_buzzkill's armoury_entity weapons lie out at every round start", ignore: !buzzkill, fn: () => {
  const game = new Game('fy_buzzkill', buzzkill, { rounds: false });
  const w = new Writer();
  joinClient(game, w, 'alpha', TEAM_T);
  game.step();
  const it = game.items, counts = {};
  for (let i = 0; i < it.count; i++) counts[it.weapon[i]] = (counts[it.weapon[i]] || 0) + 1;
  assert.equal(it.count, 22, '28 points, the 6 kevlar left out');
  assert.equal(counts[WEAPON_ID.mp5sd], 6);
  assert.equal(counts[WEAPON_ID.ak47], 4);
  assert.equal(counts[WEAPON_ID.m4a1], 4);
  assert.equal(counts[WEAPON_ID.awp], 2);
  assert.equal(counts[WEAPON_ID.deagle], 2);
  assert.equal(counts[WEAPON_ID.famas], 2);
  assert.equal(counts[WEAPON_ID.galilar], 2);
  for (let i = 0; i < it.count; i++) {
    assert.equal(it.clip[i], WEAPONS[it.weapon[i]].clip, 'a full magazine');
    assert.ok(it.reserve[i] > 0, 'and reserve');
    assert.equal(it.flying[i], 0, 'lying still');
    assert.ok(it.z[i] < 20 && it.z[i] > -320, `on a floor (z ${it.z[i]})`);
  }
  // Picked up and the round restarted: laid out again. mp_armoury_entities 0: none.
  it.remove(0);
  assert.equal(it.count, 21);
  game.startRound(true);
  assert.equal(game.items.count, 22, 'restocked');
  game.rules.armouryEntities = false;
  game.startRound(true);
  assert.equal(game.items.count, 0, 'turned off');
} });

// The ground holds MAX_ITEMS: a crafted map's 8000 armoury_entity points of 32 weapons each
// traced their floors for 244 ms at every round start. No more than that are laid out.
Deno.test('armoury weapons: no more than the ground holds', () => {
  const playground = loadMap('de_playground');
  const many = Array.from({ length: 8000 }, (_, i) => ({ classname: 'armoury_entity', item: '4', count: '32', origin: `${i % 50} 0 64` }));
  const game = new Game('de_playground', { ...playground, entities: [...playground.entities, ...many] }, { rounds: false });
  assert.equal(game.armoury.reduce((n, a) => n + a.count, 0), MAX_ITEMS);
});

// weaponTick draws the slot a command names, then drops what is in hand; the server put down
// the weapon held before the command. "slot2; drop" with an AWP in hand dropped the pistol from
// the inventory and laid a second AWP on the ground; "slot5; drop" holding the Glock took the C4
// away while its carrier kept the bomb.
Deno.test('G with a slot key in the same command drops the weapon that key drew', () => {
  const pg = loadMap('de_playground');
  {
    const game = new Game('de_playground', pg, { rounds: false }), w = new Writer();
    const a = joinClient(game, w, 'alpha', TEAM_CT);
    for (let i = 0; i < 2; i++) sendCmd(game, w, a), game.step();
    giveWeapon(a.player.ws, WEAPON_ID.awp);
    a.player.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
    for (let i = 0; i < 100; i++) sendCmd(game, w, a), game.step();
    const pistol = a.player.ws.f[WS_SLOTS + SLOT_SECONDARY * 3];
    assert.ok(pistol > 0);
    sendCmd(game, w, a, IN_DROP, SLOT_SECONDARY);
    game.step();
    assert.equal(a.player.ws.f[WS_SLOTS + SLOT_PRIMARY * 3], WEAPON_ID.awp, 'the AWP stays');
    assert.equal(a.player.ws.f[WS_SLOTS + SLOT_SECONDARY * 3], 0, 'the pistol left the hand');
    assert.equal(game.items.count, 1);
    assert.equal(game.items.weapon[0], pistol, 'and lies on the ground');
  }
  const game = new Game('de_playground', pg, { freezeTime: 0 }), w = new Writer();
  const t = joinClient(game, w, 'tee', TEAM_T), ct = joinClient(game, w, 'cee', TEAM_CT);
  for (let i = 0; i < 400 && !game.bombCarrier; i++) sendCmd(game, w, t), sendCmd(game, w, ct), game.step();
  assert.ok(game.bombCarrier === t);
  for (let i = 0; i < 100; i++) sendCmd(game, w, t), sendCmd(game, w, ct), game.step();
  const pistol = t.player.ws.f[WS_SLOTS + SLOT_SECONDARY * 3];
  assert.ok(t.player.ws.f[WS_ACTIVE] !== SLOT_C4 && pistol > 0);
  sendCmd(game, w, t, IN_DROP, SLOT_C4);
  sendCmd(game, w, ct);
  game.step();
  assert.equal(t.player.ws.f[WS_SLOTS + SLOT_C4 * 3], 0);
  assert.equal(game.bomb.state, BOMB_DROPPED, 'the bomb is down');
  assert.ok(game.bombCarrier === null);
  assert.equal(t.player.ws.f[WS_SLOTS + SLOT_SECONDARY * 3], pistol, 'the pistol stays');
  assert.equal(game.items.count, 0, 'and no copy of it lies about');
});

// E took a weapon through a wall: inReach never traced from the eye to it.
Deno.test('E reaches no weapon behind a wall', () => {
  const eye = [0, 0, 64];
  const open = boxWorld([FLOOR]), walled = boxWorld([FLOOR, { min: [16, -500, 0], max: [32, 500, 200] }]);
  const it = new Items();
  it.add(WEAPON_ID.awp, 10, 30, 44, 0, 0, 0);
  assert.equal(it.inReach(open, eye[0], eye[1], eye[2], 50, 0), 0, 'in the open it is taken');
  assert.equal(it.inReach(walled, eye[0], eye[1], eye[2], 50, 0), -1, 'behind the wall it is not');
});
