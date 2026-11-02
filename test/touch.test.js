// The touch stick (client/touch.js): eight digital directions, a dead zone, a walk band.
import assert from 'node:assert/strict';
import { IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED } from '../shared/constants.js';
import { stickButtons, STICK_RADIUS, STICK_DEAD, STICK_WALK } from '../client/touch.js';

Deno.test('touch stick: dead zone, eight sectors, walking on a small pull', () => {
  const r = STICK_RADIUS;
  assert.equal(stickButtons(0, 0), 0);
  assert.equal(stickButtons(r * STICK_DEAD * 0.9, 0), 0, 'inside the dead zone');
  // A full pull in each direction (screen y down): no walk bit.
  assert.equal(stickButtons(0, -r), IN_FORWARD);
  assert.equal(stickButtons(r, -r), IN_FORWARD | IN_MOVERIGHT);
  assert.equal(stickButtons(r, 0), IN_MOVERIGHT);
  assert.equal(stickButtons(r, r), IN_BACK | IN_MOVERIGHT);
  assert.equal(stickButtons(0, r), IN_BACK);
  assert.equal(stickButtons(-r, r), IN_BACK | IN_MOVELEFT);
  assert.equal(stickButtons(-r, 0), IN_MOVELEFT);
  assert.equal(stickButtons(-r, -r), IN_FORWARD | IN_MOVELEFT);
  // Sector edges: 22.5 degrees either side of forward is still forward, past it a diagonal.
  const deg = Math.PI / 180;
  assert.equal(stickButtons(r * Math.sin(20 * deg), -r * Math.cos(20 * deg)), IN_FORWARD);
  assert.equal(stickButtons(r * Math.sin(25 * deg), -r * Math.cos(25 * deg)), IN_FORWARD | IN_MOVERIGHT);
  // A small pull walks; past the walk band it runs; far past the radius still runs.
  assert.equal(stickButtons(0, -r * (STICK_DEAD + STICK_WALK) / 2), IN_FORWARD | IN_SPEED);
  assert.equal(stickButtons(0, -r * STICK_WALK), IN_FORWARD);
  assert.equal(stickButtons(0, -r * 5), IN_FORWARD);
});
