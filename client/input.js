// Keyboard/mouse input. Keys and mouse buttons go to `onKey(name, down)` (the bind
// table); `+` commands then hold button bits through press/release. State is a button
// bitfield plus accumulated raw mouse deltas, consumed by the frame loop.

import { keyName, MOUSE_NAMES } from './binds.js';
import { stickButtons, STICK_ZONE, STICK_BITS, TOUCH_SLOP } from './touch.js';

export const SELECT_LAST = -2; // switch to the previous weapon (lastinv)
const TOUCH_COUNTS = 4; // mouse counts per pixel of a touch drag (a screen's width turns about half round)
const TOUCH_FIRST = matchMedia('(pointer: coarse)'); // a phone or tablet (iPadOS too, trackpad or not): always a soft lock

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
    this.soft = false; // locked without the Pointer Lock API (iOS, iPadOS: the cursor stays free)
    this.onLockChange = () => {}; // after a soft lock or unlock (the game's overlay)
    this.touchId = -1; // the finger that looks round, and where it was
    this.touchX = 0;
    this.touchY = 0;
    this.stickId = -1; // the finger on the movement stick (landed on the left STICK_ZONE of the canvas), and where it landed
    this.stickX = 0;
    this.stickY = 0;
    this.stickBits = 0; // the movement bits the stick holds now
    this.onStick = () => {}; // (active, x, y, dx, dy): the stick's drawing (client/touch.js)
    this.onTouchDown = () => null; // (id, x, y): the touch button under a finger landing there, pressed (client/touch.js)
    this.onTouchUp = () => {}; // (id): that finger lifted
    this.touchSlop = 0; // px the looking finger still has to travel before it turns the view (it landed on a button)
    this.sensitivity = 2.5; // the sensitivity / m_yaw / m_pitch / m_rawinput cvars
    this.mYaw = 0.022; // degrees per count
    this.mPitch = 0.022;
    this.rawInput = true;
    this.fullscreen = false; // the `fullscreen` cvar: the page fills the screen when it takes the mouse
    this.keyLocked = false; // the keyboard lock asked for (Chrome, Edge; it holds while fullscreen)
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
      this.soft = false;
      if (!this.locked && !this.keepKeys()) this.clear();
    });
    // Touch (a tablet, a phone): a finger landing on a touch button (client/touch.js)
    // presses it; one on the left STICK_ZONE of the canvas is the movement stick; the first
    // finger elsewhere drags the view round, and so does one on a right-side button (held
    // FIRE tracks a target), after a little slop so a tap never jolts the aim; more fingers
    // press buttons only. Only while locked (a soft lock there: see lock()), so the menus'
    // touches are their own.
    canvas.addEventListener('touchstart', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (const t of e.changedTouches) {
        const b = this.onTouchDown(t.identifier, t.clientX, t.clientY);
        if (b && !b.look) continue;
        if (!b && this.stickId < 0 && t.clientX < rect.left + rect.width * STICK_ZONE) {
          this.stickId = t.identifier;
          this.stickX = t.clientX;
          this.stickY = t.clientY;
          this.onStick(true, t.clientX, t.clientY, 0, 0);
        } else if (this.touchId < 0) {
          this.touchId = t.identifier;
          this.touchX = t.clientX;
          this.touchY = t.clientY;
          this.touchSlop = b ? TOUCH_SLOP : 0;
        }
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          const dx = t.clientX - this.stickX, dy = t.clientY - this.stickY;
          this.setStick(stickButtons(dx, dy));
          this.onStick(true, this.stickX, this.stickY, dx, dy);
        } else if (t.identifier === this.touchId) {
          const dx = t.clientX - this.touchX, dy = t.clientY - this.touchY;
          if (this.touchSlop > 0) {
            if (dx * dx + dy * dy < this.touchSlop * this.touchSlop) continue;
            this.touchSlop = 0;
          }
          this.mouseDX += dx * TOUCH_COUNTS;
          this.mouseDY += dy * TOUCH_COUNTS;
          this.touchX = t.clientX;
          this.touchY = t.clientY;
        }
      }
    }, { passive: false });
    const touchEnd = (e) => {
      for (const t of e.changedTouches) {
        this.onTouchUp(t.identifier);
        if (t.identifier === this.stickId) this.dropStick();
        if (t.identifier === this.touchId) this.touchId = -1;
      }
    };
    canvas.addEventListener('touchend', touchEnd);
    canvas.addEventListener('touchcancel', touchEnd);
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      // Under a soft lock the cursor is free: a click on the pause button is not a shot.
      if (this.locked && MOUSE_NAMES[e.button] && (!this.soft || e.target === canvas)) this.onKey(MOUSE_NAMES[e.button], true);
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
      const name = keyName(e.code, e.key);
      if (name === 'escape' && this.locked) { // under a keyboard lock the browser leaves Escape to the page
        this.unlock();
        return;
      }
      if (this.onKey(name, true)) e.preventDefault();
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

  // The stick's movement bits (client/touch.js stickButtons): held as the key 'stick', so
  // a keyboard holding the same button keeps it.
  setStick(bits) {
    const was = this.stickBits;
    if (bits === was) return;
    this.stickBits = bits;
    for (let b = 1; b <= STICK_BITS; b <<= 1) {
      if (!(STICK_BITS & b)) continue;
      if ((bits & b) && !(was & b)) this.press(b, 'stick');
      else if (!(bits & b) && (was & b)) this.release(b, 'stick');
    }
  }

  dropStick() {
    this.stickId = -1;
    this.setStick(0);
    this.onStick(false, 0, 0, 0, 0);
  }

  // A one-tick button (drop, ...).
  pulse(bit) {
    this.latched |= bit;
  }

  clear() {
    this.buttons = this.latched = 0;
    this.holders.clear();
    this.stickBits = 0;
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
    if (!this.canvas.requestPointerLock || TOUCH_FIRST.matches) {
      // No Pointer Lock API, or a phone or tablet (iOS and iPadOS Safari define
      // requestPointerLock but never lock; Android Chrome locks, and then showed no touch
      // controls, a drag turning the view twice: by the lock's movement and by the touch):
      // the game plays with the cursor free, the view turned by the trackpad's movement and
      // by touch, Escape or the pause button let go.
      this.softLock();
      if (this.fullscreen) await this.enterFullscreen();
      return;
    }
    // Raw input: bypass OS mouse acceleration where supported (m_rawinput 1). Asked before
    // the fullscreen request, in the same task: entering fullscreen uses up the click's
    // activation, and a pointer lock asked after it was refused (a second click took it).
    let first;
    try {
      first = this.rawInput ? this.canvas.requestPointerLock({ unadjustedMovement: true })
        : this.canvas.requestPointerLock();
    } catch (e) {
      first = Promise.reject(e); // thrown at once (a browser without the API's options)
    }
    const fullscreen = this.fullscreen ? this.enterFullscreen() : null;
    try {
      await first;
    } catch {
      await this.canvas.requestPointerLock(); // refused: the caller lets the keys go
    }
    if (fullscreen) await fullscreen;
  }

  softLock() {
    this.locked = this.soft = true;
    this.onLockChange();
  }

  // Lets the mouse go (Escape, the menus): the pause menu opens from the change.
  unlock() {
    if (this.soft) {
      this.locked = this.soft = false;
      this.touchId = -1;
      if (this.stickId >= 0) this.dropStick();
      if (!this.keepKeys()) this.clear();
      this.onLockChange();
    } else if (document.pointerLockElement) document.exitPointerLock();
  }

  // Fullscreen (the `fullscreen` cvar), from a click: the page fills the screen and, where
  // the browser has the Keyboard Lock API (Chrome, Edge), its own shortcuts (Ctrl+W, Ctrl+T,
  // Alt+Tab, the Windows key) go to the game instead: a Ctrl+W (crouch and forward) no
  // longer closes the tab. Escape then reaches the page too (handled above; held for 2 s it
  // leaves fullscreen, the browser's rule). The lock is asked for once and holds while the
  // page is fullscreen; without a user gesture the fullscreen request is refused and the
  // next click tries again.
  async enterFullscreen() {
    const doc = this.canvas.ownerDocument;
    if (navigator.keyboard && navigator.keyboard.lock && !this.keyLocked) {
      this.keyLocked = true;
      navigator.keyboard.lock().catch(() => {
        this.keyLocked = false;
      });
    }
    if (doc.fullscreenElement || !doc.documentElement.requestFullscreen) return;
    try {
      await doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch { /* no gesture, or the browser refused */ }
  }

  // Back to the window: leaving the game, or the cvar turned off.
  leaveFullscreen() {
    if (this.keyLocked && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    this.keyLocked = false;
    const doc = this.canvas.ownerDocument;
    if (doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen().catch(() => {});
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
