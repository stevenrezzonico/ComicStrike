// Gamepads (client/gamepad.js): buttons as keys with edges and the triggers' hysteresis,
// the left stick's movement bits, the right stick's look (dead zone, response curve, the
// mouse sensitivity divided out, invert, swapped sticks), the key capture and the reset.
import assert from 'node:assert/strict';
import { IN_FORWARD, IN_SPEED, IN_MOVERIGHT } from '../shared/constants.js';
import { Gamepads, readPad, stickVector, lookCurve, TRIGGER_ON, TRIGGER_OFF, ACTIVE_MS } from '../client/gamepad.js';
import { PAD_NAMES, PAD_BINDS, DEFAULT_BINDS, KEY_LIST } from '../client/binds.js';

function fakePad() {
  return {
    connected: true, mapping: 'standard',
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
}
function fakeInput() {
  return { mouseDX: 0, mouseDY: 0, sensitivity: 2.5, mYaw: 0.022, mPitch: 0.022, stick: 0, setStick(b) { this.stick = b; } };
}
const B = Object.fromEntries(PAD_NAMES.map((n, i) => [n, i]));

Deno.test('gamepad: the names are keys with default binds', () => {
  assert.equal(PAD_NAMES.length, 16);
  for (const n of PAD_NAMES) {
    assert.ok(KEY_LIST.includes(n), `${n} in the key list`);
    assert.equal(DEFAULT_BINDS[n], PAD_BINDS[n]);
  }
  assert.equal(PAD_BINDS.r_trigger, '+attack');
  assert.equal(PAD_BINDS.start, 'togglemenu');
});

Deno.test('gamepad: buttons press and release once each, triggers with hysteresis', () => {
  const input = fakeInput(), g = new Gamepads(input), keys = [];
  g.onKey = (n, d) => keys.push(`${n}:${d ? 1 : 0}`);
  const pad = fakePad();
  g.poll([pad], 1 / 60, 1000);
  assert.deepEqual(keys, []);
  assert.ok(g.connected);
  assert.ok(!g.active(1000), 'nothing used yet');
  pad.buttons[B.a_button].pressed = true;
  g.poll([pad], 1 / 60, 1016);
  g.poll([pad], 1 / 60, 1032);
  assert.deepEqual(keys, ['a_button:1'], 'held: one press');
  assert.ok(g.active(1032));
  assert.equal(g.pressed(), 'a_button');
  pad.buttons[B.a_button].pressed = false;
  g.poll([pad], 1 / 60, 1048);
  assert.deepEqual(keys, ['a_button:1', 'a_button:0']);
  assert.ok(g.active(1048 + ACTIVE_MS - 1) && !g.active(1048 + ACTIVE_MS));
  // A trigger by its value: down past TRIGGER_ON, not up again until under TRIGGER_OFF.
  keys.length = 0;
  pad.buttons[B.r_trigger].value = TRIGGER_ON - 0.05;
  g.poll([pad], 1 / 60, 2000);
  assert.deepEqual(keys, []);
  pad.buttons[B.r_trigger].value = TRIGGER_ON + 0.05;
  g.poll([pad], 1 / 60, 2016);
  pad.buttons[B.r_trigger].value = (TRIGGER_ON + TRIGGER_OFF) / 2;
  g.poll([pad], 1 / 60, 2032);
  assert.deepEqual(keys, ['r_trigger:1'], 'still down between the thresholds');
  pad.buttons[B.r_trigger].value = TRIGGER_OFF - 0.05;
  g.poll([pad], 1 / 60, 2048);
  assert.deepEqual(keys, ['r_trigger:1', 'r_trigger:0']);
  // A reset (the lock went) keeps a held button held, so it is not pressed again; unplugged:
  // nothing more.
  pad.buttons[B.x_button].pressed = true;
  g.poll([pad], 1 / 60, 3000);
  keys.length = 0;
  g.reset();
  g.poll([pad], 1 / 60, 3016);
  assert.deepEqual(keys, []);
  assert.equal(g.pressed(), 'x_button');
  keys.length = 0;
  g.poll([null], 1 / 60, 3032);
  assert.ok(!g.connected);
  assert.deepEqual(keys, ['x_button:0']); // a pad that drops lets go of what it held
});

Deno.test('gamepad: the left stick moves in eight directions, walking on a small pull', () => {
  const input = fakeInput(), g = new Gamepads(input);
  const pad = fakePad();
  pad.axes[1] = -1; // up: forward
  g.poll([pad], 1 / 60, 0);
  assert.equal(input.stick, IN_FORWARD);
  pad.axes[1] = -0.5;
  g.poll([pad], 1 / 60, 16);
  assert.equal(input.stick, IN_FORWARD | IN_SPEED, 'a half pull walks');
  pad.axes[0] = 0.8;
  pad.axes[1] = -0.8;
  g.poll([pad], 1 / 60, 32);
  assert.equal(input.stick, IN_FORWARD | IN_MOVERIGHT);
  pad.axes[0] = pad.axes[1] = 0;
  g.poll([pad], 1 / 60, 48);
  assert.equal(input.stick, 0);
  // Swapped sticks: the right one moves.
  g.swap = true;
  pad.axes[3] = -1;
  g.poll([pad], 1 / 60, 64);
  assert.equal(input.stick, IN_FORWARD);
  assert.equal(input.mouseDX, 0);
});

Deno.test('gamepad: the right stick looks by joy_yaw and joy_pitch a second, the sensitivity divided out', () => {
  const input = fakeInput(), g = new Gamepads(input);
  const pad = fakePad();
  // Full right for a second: 180 degrees of yaw once applyMouse multiplies by sensitivity and m_yaw.
  pad.axes[2] = 1;
  for (let i = 0; i < 60; i++) g.poll([pad], 1 / 60, i * 16);
  assert.ok(Math.abs(input.mouseDX * input.sensitivity * input.mYaw - 180) < 1e-3, `${input.mouseDX}`);
  assert.equal(input.mouseDY, 0);
  assert.equal(input.stick, 0, 'the left stick is still');
  // Pitch: down on the stick looks down (a positive mouse delta); inverted, up.
  input.mouseDX = 0;
  pad.axes[2] = 0;
  pad.axes[3] = 1;
  g.poll([pad], 1, 2000);
  assert.ok(Math.abs(input.mouseDY * input.sensitivity * input.mPitch - 120) < 1e-3);
  g.invert = true;
  input.mouseDY = 0;
  g.poll([pad], 1, 3000);
  assert.ok(Math.abs(input.mouseDY * input.sensitivity * input.mPitch + 120) < 1e-3);
  // An inverted mouse (m_pitch < 0) changes nothing for the pad.
  g.invert = false;
  input.mPitch = -0.022;
  input.mouseDY = 0;
  g.poll([pad], 1, 4000);
  assert.ok(Math.abs(input.mouseDY * input.sensitivity * input.mPitch - 120) < 1e-3);
  // The dead zone and the curve: within the dead zone nothing, half way the curve's share.
  input.mouseDX = 0;
  pad.axes[3] = 0;
  pad.axes[2] = 0.15;
  g.poll([pad], 1, 5000);
  assert.equal(input.mouseDX, 0, 'inside the dead zone');
  pad.axes[2] = 0.6;
  g.poll([pad], 1, 6000);
  const share = Math.pow((0.6 - 0.2) / 0.8, 2);
  assert.ok(Math.abs(input.mouseDX * input.sensitivity * input.mYaw - 180 * share) < 1e-3);
});

Deno.test('gamepad: the stick math and a generic pad', () => {
  assert.deepEqual(stickVector(0.1, 0.1, 0.2), [0, 0]);
  const v = stickVector(1, 0, 0.2);
  assert.ok(Math.abs(v[0] - 1) < 1e-9 && v[1] === 0);
  const d = stickVector(0.6, 0.8, 0.2); // magnitude 1 at 37 degrees: the direction kept
  assert.ok(Math.abs(d[0] / d[1] - 0.75) < 1e-9 && Math.abs(Math.hypot(d[0], d[1]) - 1) < 1e-9);
  assert.equal(lookCurve(-0.5, 2), -0.25);
  assert.equal(lookCurve(0.5, 1), 0.5);
  // A pad without the standard mapping and fewer buttons: read by index, the rest 0;
  // numbers as buttons too, axes clamped.
  const s = readPad({ mapping: '', buttons: [1, { pressed: true }, { value: 0.5 }], axes: [2, -2, 0.5] });
  assert.deepEqual([...s.buttons.slice(0, 4)], [1, 1, 0.5, 0]);
  assert.deepEqual([...s.axes], [1, -1, 0.5, 0]);
});
