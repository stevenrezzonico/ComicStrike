// Keyboard/mouse input. State is a button bitfield plus accumulated raw mouse
// deltas, consumed by the frame loop; event handlers never allocate.

import {
  IN_ATTACK, IN_ATTACK2, IN_JUMP, IN_DUCK, IN_FORWARD, IN_BACK, IN_MOVELEFT,
  IN_MOVERIGHT, IN_USE, IN_RELOAD, IN_SCORE, IN_SPEED, IN_DROP,
} from '../shared/constants.js';

const KEY_BINDS = {
  KeyW: IN_FORWARD,
  KeyS: IN_BACK,
  KeyA: IN_MOVELEFT,
  KeyD: IN_MOVERIGHT,
  Space: IN_JUMP,
  ControlLeft: IN_DUCK,
  ShiftLeft: IN_SPEED,
  KeyE: IN_USE,
  KeyR: IN_RELOAD,
  Tab: IN_SCORE,
  KeyG: IN_DROP,
};

// Weapon slot keys; SELECT_LAST switches to the previous weapon (Q).
export const SELECT_LAST = -2;
const SLOT_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, KeyQ: SELECT_LAST };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.buttons = 0;
    this.latched = 0; // presses since the last tick, so sub-tick taps are never lost
    this.select = -1; // pending weapon slot request
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.sensitivity = 2.0; // CS:GO "sensitivity"
    this.mYaw = 0.022; // degrees per count
    this.mPitch = 0.022;

    canvas.addEventListener('click', () => this.lock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.buttons = this.latched = 0;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.press(IN_ATTACK);
      else if (e.button === 2) this.press(IN_ATTACK2);
    });
    // Mouse wheel jumps for one tick (the classic bunnyhop bind).
    document.addEventListener('wheel', (e) => {
      if (this.locked && e.deltaY !== 0) this.latched |= IN_JUMP;
    }, { passive: true });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.buttons &= ~IN_ATTACK;
      else if (e.button === 2) this.buttons &= ~IN_ATTACK2;
    });
    document.addEventListener('keydown', (e) => {
      if (this.locked && SLOT_KEYS[e.code] !== undefined && !e.repeat) this.select = SLOT_KEYS[e.code];
      const bit = KEY_BINDS[e.code];
      if (bit === undefined || !this.locked) return;
      if (!e.repeat) this.press(bit);
      e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      const bit = KEY_BINDS[e.code];
      if (bit !== undefined) this.buttons &= ~bit;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  press(bit) {
    this.buttons |= bit;
    this.latched |= bit;
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
      // Raw input: bypass OS mouse acceleration where supported.
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
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
