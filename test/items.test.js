import assert from 'node:assert/strict';
import { parseBSP } from '../shared/bsp.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';
import { IN_DROP, IN_USE } from '../shared/constants.js';
import { WEAPON_ID, WS_SLOTS, WS_ACTIVE, SLOT_PRIMARY, SLOT_SECONDARY } from '../shared/weapons.js';
import { PS_ORIGIN } from '../shared/pmove.js';
import { Writer, Reader, CmdRing, writeHello, writeCmds, writeBuy, readItems, S2C_ITEMS } from '../shared/protocol.js';
import { Items } from '../shared/items.js';
import { Game } from '../server/game.js';

let bsp = null;
try {
  bsp = parseBSP(Deno.readFileSync(new URL('../maps/de_dust2.bsp', import.meta.url)).buffer);
} catch { /* map-dependent tests skip */ }

// A game with free buying and no round flow, and helpers to drive clients.
function setup() {
  const game = new Game('de_dust2', bsp, { rounds: false });
  const w = new Writer();
  let buyId = 0;
  const join = (name, team) => {
    const sent = [];
    const c = game.connect({ send: (b) => sent.push(b.slice()), close: () => {}, closed: false });
    game.receive(c, writeHello(w, team, 0, 0, name).slice());
    c.cmds = new CmdRing();
    c.tick = 1;
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
      for (const c of players) {
        c.cmds.put(c.tick, c.next.buttons, -1, c.next.pitch, c.next.yaw, 0);
        game.receive(c, writeCmds(w, 0, c.cmds, c.tick++).slice());
      }
      game.step();
    }
  };
  const slot = (c, s) => c.player.ws.f[WS_SLOTS + s * 3];
  return { game, join, run, slot };
}

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
