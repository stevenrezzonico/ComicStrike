// Keyboard/mouse input. Keys and mouse buttons go to `onKey(name, down)` (the bind
// table); `+` commands then hold button bits through press/release. State is a button
// bitfield plus accumulated raw mouse deltas, consumed by the frame loop.

import { keyName, MOUSE_NAMES } from './binds.js';

export const SELECT_LAST = -2; // switch to the previous weapon (lastinv)

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.buttons = 0;
    this.latched = 0; // presses since the last tick, so sub-tick taps are never lost
    this.holders = new Map(); // button bit -> Set of keys holding it (Source kbutton_t)
    this.select = -1; // pending weapon slot request
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.sensitivity = 2.5; // the sensitivity / m_yaw / m_pitch / m_rawinput cvars
    this.mYaw = 0.022; // degrees per count
    this.mPitch = 0.022;
    this.rawInput = true;
    // onKey(name, down) -> true if the key is used (its default action is then prevented).
    this.onKey = () => false;
    // True while held keys should outlive losing the mouse (the buy menu: buy on the move).
    this.keepKeys = () => false;
    // False while a click on the canvas must not take the mouse (the menu's window).
    this.canLock = () => true;

    canvas.addEventListener('click', () => {
      if (this.canLock()) this.lock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked && !this.keepKeys()) this.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (this.locked && MOUSE_NAMES[e.button]) this.onKey(MOUSE_NAMES[e.button], true);
    });
    document.addEventListener('mouseup', (e) => {
      if (MOUSE_NAMES[e.button]) this.onKey(MOUSE_NAMES[e.button], false);
    });
    // The wheel has no "up": a notch presses and releases at once (latched for the tick).
    document.addEventListener('wheel', (e) => {
      if (!this.locked || e.deltaY === 0) return;
      const name = e.deltaY < 0 ? 'mwheelup' : 'mwheeldown';
      this.onKey(name, true);
      this.onKey(name, false);
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (this.locked) e.preventDefault();
        return;
      }
      if (this.onKey(keyName(e.code, e.key), true)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      this.onKey(keyName(e.code, e.key), false);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // +command: `key` holds button `bit` (several keys may hold the same button).
  press(bit, key = 'console') {
    let set = this.holders.get(bit);
    if (!set) this.holders.set(bit, (set = new Set()));
    set.add(key);
    this.buttons |= bit;
    this.latched |= bit;
  }

  // -command: `key` lets go; the button stays down while another key holds it.
  release(bit, key = 'console') {
    const set = this.holders.get(bit);
    if (set) {
      set.delete(key);
      if (key === 'console') set.clear(); // "-attack" typed in the console releases it
      if (set.size) return;
    }
    this.buttons &= ~bit;
  }

  // A one-tick button (drop, ...).
  pulse(bit) {
    this.latched |= bit;
  }

  clear() {
    this.buttons = this.latched = 0;
    this.holders.clear();
  }

  // Buttons for one simulation tick: held keys plus anything tapped since last tick.
  sampleButtons() {
    const b = this.buttons | this.latched;
    this.latched = 0;
    return b;
  }

  // Weapon slot requested since the last tick (or -1).
  sampleSelect() {
    const s = this.select;
    this.select = -1;
    return s;
  }

  async lock() {
    if (this.locked) return;
    try {
      // Raw input: bypass OS mouse acceleration where supported (m_rawinput 1).
      if (this.rawInput) await this.canvas.requestPointerLock({ unadjustedMovement: true });
      else await this.canvas.requestPointerLock();
    } catch {
      await this.canvas.requestPointerLock();
    }
  }

  // Applies accumulated mouse motion to angles [pitch, yaw] (degrees).
  applyMouse(angles) {
    angles[1] -= this.mouseDX * this.sensitivity * this.mYaw;
    angles[0] += this.mouseDY * this.sensitivity * this.mPitch;
    if (angles[0] > 89) angles[0] = 89;
    if (angles[0] < -89) angles[0] = -89;
    angles[1] -= Math.floor(angles[1] / 360) * 360;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
