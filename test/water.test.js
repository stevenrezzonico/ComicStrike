// Drowning, slime and lava (server/game.js updateLiquid, after HL's CBasePlayer::WaterMove),
// in a compiled yard with a tank of each liquid standing on its floor, 256 deep.
import assert from 'node:assert/strict';
import { box } from '../shared/bspwriter.js';
import { CONTENTS_WATER, CONTENTS_SLIME, CONTENTS_LAVA } from '../shared/bsp.js';
import { TICK_RATE } from '../shared/constants.js';
import { yard, walker, W } from './harness.js';

const TANKS = { water: 0, slime: 300, lava: 600 }; // x of each tank's west side
const bsp = yard((map) => {
  for (const [kind, x] of Object.entries(TANKS)) {
    const contents = kind === 'water' ? CONTENTS_WATER : kind === 'slime' ? CONTENTS_SLIME : CONTENTS_LAVA;
    map.brushEntity({ classname: 'func_water', skin: String(contents) }, [
      box(x, -128, 0, x + 256, 128, 256, { top: W, bottom: null, side: null }),
    ], { contents });
  }
  map.brushEntity({ classname: 'func_water', skin: String(CONTENTS_WATER) }, [ // a pool 14 deep, the playground's shallow end
    box(-800, -128, 0, -500, 128, 14, { top: W, bottom: null, side: null }),
  ], { contents: CONTENTS_WATER });
});
const secs = (s) => Math.round(s * TICK_RATE);

Deno.test('water: 12 s of air, then drowning 3, 4, 5, 5 a second through armor, given back once out', () => {
  const { c, run, put } = walker(bsp);
  c.player.armor = 100;
  put(128, 0, 0);
  run(secs(11.5));
  assert.equal(c.player.health, 100, 'air left');
  run(secs(4));
  assert.equal(c.player.health, 100 - 3 - 4 - 5 - 5, 'drowned four times');
  assert.equal(c.player.armor, 100, 'armor untouched');
  put(-300, 0, 0); // out on the sand
  run(secs(0.5));
  assert.equal(c.player.health, 83, 'nothing back at once');
  run(secs(1.5));
  assert.equal(c.player.health, 93, 'ten back 2 s after the last drowning');
  run(secs(4));
  assert.equal(c.player.health, 100, 'all of it back, no more');
});

Deno.test('water: staying under drowns, a death of the player\'s own', () => {
  const { c, run, put } = walker(bsp);
  put(128, 0, 0);
  let t = 0;
  while (c.alive && t < secs(60)) {
    run(1);
    t++;
  }
  assert.ok(!c.alive, 'drowned');
  assert.ok(t > secs(30) && t < secs(40), `after ${t / TICK_RATE} s`);
  assert.equal(c.player.deaths, 1);
  assert.equal(c.player.kills, -1, 'a suicide: a kill less, as in CS');
});

// HL's PM_CheckFalling: no fall damage at a water level over 0, however shallow.
Deno.test('water: a fall into a shallow pool hurts nobody, the same fall onto sand does', () => {
  for (const [x, onSand] of [[-650, false], [-300, true]]) {
    const { c, run, put } = walker(bsp);
    put(x, 0, 400);
    run(secs(1.5));
    assert.equal(c.player.health < 100, onSand, `health ${c.player.health} after the fall at x ${x}`);
  }
});

Deno.test('water: slime burns 4 and lava 10 a second per water level', () => {
  for (const [kind, per] of [['slime', 4], ['lava', 10]]) {
    const { c, run, put } = walker(bsp);
    put(TANKS[kind] + 128, 0, 0);
    run(secs(2.5)); // burns as it goes in, then after 1 and 2 s, three levels deep
    assert.equal(c.player.health, Math.max(0, 100 - 3 * 3 * per), kind);
  }
});
