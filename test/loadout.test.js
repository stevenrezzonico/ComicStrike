// The HUD's weapon column (client/loadout.js): its rows from a weapon state.

import assert from 'node:assert/strict';
import { loadoutRows, slotCommand, LoadoutPanel } from '../client/loadout.js';
import { createWeaponState, giveWeapon, WEAPON_ID, WS_ACTIVE, WS_SLOTS, SLOT_SECONDARY, SLOT_GRENADE } from '../shared/weapons.js';

const rows = (ws) => {
  const out = new Float64Array(64), n = loadoutRows(ws, out), r = [];
  for (let i = 0; i < n; i++) r.push([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
  return r;
};

Deno.test('loadout rows: slot order, a row per grenade kind with its count, the one in hand', () => {
  const ws = createWeaponState();
  assert.deepEqual(rows(ws), [], 'nothing carried');
  for (const name of ['c4', 'flashbang', 'knife', 'ak47', 'flashbang', 'hegrenade', 'glock', 'taser']) giveWeapon(ws, WEAPON_ID[name]);
  ws.f[WS_ACTIVE] = SLOT_SECONDARY;
  const ids = rows(ws).map((r) => r[0]);
  const he = ids.indexOf(WEAPON_ID.hegrenade), flash = ids.indexOf(WEAPON_ID.flashbang);
  assert.deepEqual(ids.slice(0, 4), [WEAPON_ID.ak47, WEAPON_ID.glock, WEAPON_ID.knife, WEAPON_ID.taser]);
  assert.ok(he >= 4 && flash >= 4 && ids.at(-1) === WEAPON_ID.c4, 'the grenades, then the C4');
  assert.equal(rows(ws)[flash][1], 2, 'two flashbangs on one row');
  assert.deepEqual(rows(ws).map((r) => r[2]), ids.map((id) => (id === WEAPON_ID.glock ? 1 : 0)), 'the pistol in hand');
  // The grenade in hand: the kind the grenade slot shows, the other kind not.
  ws.f[WS_ACTIVE] = SLOT_GRENADE;
  ws.f[WS_SLOTS + SLOT_GRENADE * 3] = WEAPON_ID.hegrenade;
  const on = rows(ws).filter((r) => r[2]).map((r) => r[0]);
  assert.deepEqual(on, [WEAPON_ID.hegrenade]);
});

Deno.test('loadout taps: a row draws its weapon by its slot command, with a little slack, not while faded', () => {
  assert.deepEqual(['ak47', 'glock', 'knife', 'taser', 'hegrenade', 'c4'].map((n) => slotCommand(WEAPON_ID[n])),
    ['slot1', 'slot2', 'slot3', 'slot6', 'slot4', 'slot5']);
  // Three rows side by side (the touch layout), 20 px wide with 10 px gaps, 14 px tall at y 300.
  const row = (left, cmd) => ({ dataset: { cmd }, getBoundingClientRect: () => ({ left, right: left + 20, top: 300, bottom: 314 }) });
  const panel = Object.create(LoadoutPanel.prototype);
  panel.el = { children: [row(100, 'slot1'), row(130, 'slot2'), row(160, 'slot3')] };
  panel.faded = false;
  assert.equal(panel.commandAt(110, 307), 'slot1');
  assert.equal(panel.commandAt(126, 290), 'slot2', 'a little left of and over the pistol');
  assert.equal(panel.commandAt(180, 328), 'slot3', 'under the knife');
  assert.equal(panel.commandAt(140, 340), null, 'too far under');
  assert.equal(panel.commandAt(60, 307), null, 'left of every row');
  panel.faded = true;
  assert.equal(panel.commandAt(110, 307), null, 'faded out: nothing to tap');
});
