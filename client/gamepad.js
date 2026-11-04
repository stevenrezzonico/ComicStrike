// Gamepads (the Gamepad API: an Xbox pad, a DualSense or DualShock, a Switch Pro pad, all
// with the browser's standard mapping; a generic pad without it is read by the same button
// indices, which most follow). Polled once a frame from main.js: `navigator.getGamepads()`
// has no events for buttons. The buttons are keys through the bind table under Source's
// names (PAD_NAMES in client/binds.js: a_button, l_trigger, start, up ...), the triggers
// pressed past TRIGGER_ON (let go under TRIGGER_OFF); the left stick moves (the wire
// carries buttons only, so it drives the digital WASD bits like the touch stick, walking on
// a small pull); the right stick looks: a radial dead zone (`joy_deadzone`), a response
// curve (`joy_response`: the deflection to that power, so the center is fine and the edge
// fast), `joy_yaw` and `joy_pitch` degrees a second at full deflection, fed into the mouse
// deltas in counts so the mouse sensitivity cancels out; `joy_invert`, `joy_swap`
// (southpaw). A pad press is no user gesture for the browser, so a pad cannot take the
// pointer lock: Input.lock goes soft while the pad is in use (`active`), as on a tablet.

import { stickButtons } from './touch.js';
import { PAD_NAMES } from './binds.js';

export const TRIGGER_ON = 0.3; // a trigger (or any button with a value) is down past this
export const TRIGGER_OFF = 0.2; // ... and up again under this
export const ACTIVE_MS = 1500; // the pad counts as in use this long after its last input
export const AXES = 4; // left x, left y, right x, right y

// A pad's state by the standard mapping: 16 button values (0..1) and 4 axes (-1..1, y down).
export function readPad(pad, out = { buttons: new Float32Array(16), axes: new Float32Array(AXES) }) {
  const b = pad.buttons || [], a = pad.axes || [];
  for (let i = 0; i < 16; i++) {
    const x = b[i];
    out.buttons[i] = x ? (typeof x === 'number' ? x : x.pressed ? 1 : x.value || 0) : 0;
  }
  for (let i = 0; i < AXES; i++) out.axes[i] = Number.isFinite(a[i]) ? Math.max(-1, Math.min(1, a[i])) : 0;
  return out;
}

// A stick (x, y) past a radial dead zone, the rest rescaled to 0..1: [x, y].
export function stickVector(x, y, dead, out = [0, 0]) {
  const m = Math.sqrt(x * x + y * y);
  if (m <= dead || m === 0) {
    out[0] = out[1] = 0;
    return out;
  }
  const k = Math.min(1, (m - dead) / (1 - dead)) / m;
  out[0] = x * k;
  out[1] = y * k;
  return out;
}

// The look response: the deflection to the `curve` power, its sign kept.
export function lookCurve(v, curve) {
  return Math.sign(v) * Math.pow(Math.abs(v), curve);
}

export class Gamepads {
  constructor(input) {
    this.input = input;
    this.onKey = () => {}; // (name, down): a button as a key (main.js: the binds, or the menu's key capture)
    this.yaw = 180; // joy_yaw: degrees a second at full deflection
    this.pitch = 120; // joy_pitch
    this.dead = 0.2; // joy_deadzone (the look stick; the move stick has the touch stick's bands)
    this.curve = 2; // joy_response
    this.invert = false; // joy_invert
    this.swap = false; // joy_swap: the sticks the other way round
    this.down = new Uint8Array(16);
    this.sticks = 0; // the movement bits held now
    this.activeAt = -Infinity; // when the pad was last used
    this.connected = false;
    this.state = { buttons: new Float32Array(16), axes: new Float32Array(AXES) };
    this.vec = [0, 0];
    this.failed = false; // getGamepads threw (an iframe without the permission): no pads
  }

  // The browser's pads, or none where the API is missing or refused.
  list() {
    if (this.failed || typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    try {
      return navigator.getGamepads();
    } catch {
      this.failed = true;
      return null;
    }
  }

  // Reads the first connected pad of `pads`; dt: seconds since the last poll (the look
  // stick turns by it); now: ms, for `active`.
  poll(pads, dt, now) {
    let pad = null;
    if (pads) for (const p of pads) if (p && p.connected !== false) { pad = p; break; }
    this.connected = pad !== null;
    if (!pad) {
      if (this.sticks) this.input.setStick(this.sticks = 0);
      return;
    }
    const s = readPad(pad, this.state);
    let used = false;
    for (let i = 0; i < 16; i++) {
      const v = s.buttons[i], was = this.down[i] === 1;
      const on = was ? v > TRIGGER_OFF : v > TRIGGER_ON;
      if (on === was) continue;
      this.down[i] = on ? 1 : 0;
      this.activeAt = now; // before the key runs: Start's togglemenu asks for the lock, which must go soft
      this.onKey(PAD_NAMES[i], on);
      used = true;
    }
    let lx = s.axes[0], ly = s.axes[1], rx = s.axes[2], ry = s.axes[3];
    if (this.swap) [lx, ly, rx, ry] = [rx, ry, lx, ly];
    const bits = stickButtons(lx, ly, 1);
    if (bits !== this.sticks) this.input.setStick(this.sticks = bits);
    if (bits) used = true;
    const v = stickVector(rx, ry, this.dead, this.vec);
    if (v[0] !== 0 || v[1] !== 0) {
      used = true;
      // Degrees this frame, as mouse counts: applyMouse multiplies by the sensitivity and
      // m_yaw / m_pitch, so those are divided out (their signs too: joy_invert is the pad's).
      const ky = this.input.sensitivity * this.input.mYaw, kp = this.input.sensitivity * this.input.mPitch;
      if (ky !== 0) this.input.mouseDX += lookCurve(v[0], this.curve) * this.yaw * dt / ky;
      if (kp !== 0) this.input.mouseDY += (this.invert ? -1 : 1) * lookCurve(v[1], this.curve) * this.pitch * dt / kp;
    }
    if (used) this.activeAt = now;
  }

  // The pad was used within ACTIVE_MS of `now`.
  active(now) {
    return now - this.activeAt < ACTIVE_MS;
  }

  // The name of a button down now (the first), for the Controls tab's key capture.
  pressed() {
    for (let i = 0; i < 16; i++) if (this.down[i]) return PAD_NAMES[i];
    return null;
  }

  // The lock went (the keys were cleared with it): the stick's bits start over. The buttons
  // keep their state, so a Start still held is not pressed again on the next poll (it
  // toggled the menu right back).
  reset() {
    if (this.sticks) this.input.setStick(this.sticks = 0);
  }
}
