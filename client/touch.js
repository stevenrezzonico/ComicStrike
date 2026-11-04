// Touch controls under the soft lock (client/input.js: iOS and iPadOS Safari, any
// touch-first device whose browser gives no pointer lock), laid out the way mobile shooters
// lay theirs out: the left thumb moves on a floating stick, the right thumb looks by
// dragging anywhere else, buttons included, and presses the buttons laid out round where
// it rests: a big FIRE where the thumb lands (held, a drag still turns the view, so a
// target can be tracked while firing), the right mouse button beside it, named by what it
// does with the weapon in hand (SCOPE, BURST, SILENCER, FAN, STAB, LOB; gone otherwise), JUMP on the edge above, DUCK under
// that in the corner, RELOAD and NEXT either side of the ammo at the bottom (tapping the
// ammo itself is NEXT too), USE and BUY small along the top, and a second FIRE on the left
// above the stick for the left thumb while the right one tracks. The buttons are
// translucent (`touch_opacity`), sized by `touch_scale`, and the wire carries buttons only
// (no analog move), so the stick drives the digital WASD bits, walking (+speed) on a small
// pull.
//
// The buttons never take the touches themselves: client/input.js hands every finger that
// lands on the canvas to `TouchButtons.press` first (a hit test on the same rects the
// buttons are drawn from), and a finger on a right-side button goes on to look as well;
// `release` on lifting. `layoutRects` is pure (the tests check the layout), `TouchButtons`
// holds the presses (tested with a fake exec), `TouchControls` draws them.

import { IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED } from '../shared/constants.js';
import { releaseOf } from '../shared/cvars.js';

export const STICK_RADIUS = 56; // px: a full pull
export const STICK_DEAD = 0.3; // of the radius: no movement under it
export const STICK_WALK = 0.7; // of the radius: walking under it, running past
export const STICK_ZONE = 0.4; // of the canvas width: a finger landing left of it is the stick
export const STICK_BITS = IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT | IN_SPEED;
export const TOUCH_SLOP = 6; // px a finger that landed on a button travels before it turns the view (a tap must not jolt the aim)
export const MIN_BUTTON = 44; // px: the smallest touch target
// Eight sectors of 45 degrees, clockwise from forward.
const SECTORS = [
  IN_FORWARD, IN_FORWARD | IN_MOVERIGHT, IN_MOVERIGHT, IN_BACK | IN_MOVERIGHT,
  IN_BACK, IN_BACK | IN_MOVELEFT, IN_MOVELEFT, IN_FORWARD | IN_MOVELEFT,
];

// The movement bits for a stick pulled (dx, dy) screen pixels (y down) from where it
// landed: nothing in the dead zone, one of eight sectors, IN_SPEED (walk) on a small pull.
export function stickButtons(dx, dy, radius = STICK_RADIUS) {
  const d = Math.sqrt(dx * dx + dy * dy) / radius;
  if (d < STICK_DEAD) return 0;
  const a = Math.atan2(dx, -dy); // 0 forward (up the screen), clockwise
  const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return SECTORS[k] | (d < STICK_WALK ? IN_SPEED : 0);
}

// What the right mouse button does with weapon `w` in hand, as the AIM button's label:
// the scope, a burst, the silencer, the revolver's fan, the knife's stab, a grenade's lob;
// null where it does nothing (the AK, the Deagle, the C4: the button is hidden then).
export function altLabel(w) {
  if (!w) return null;
  if (w.altKind === 'scope') return 'SCOPE';
  if (w.altKind === 'burst') return 'BURST';
  if (w.altKind === 'silencer') return 'SILENCER';
  if (w.altKind === 'revolver') return 'FAN';
  if (w.melee) return 'STAB';
  if (w.grenade) return 'LOB';
  return null;
}

// The buttons: where each sits (its center from an edge or the middle, in pixels at scale
// 1: a thumb's reach is the same on any screen), its diameter, what it runs. `look`: a
// finger on it also turns the view (the right thumb's buttons); `toggle`: stays pressed
// until tapped again; `zone`: an unseen rectangle (w, h) instead of a drawn disc.
// Sizes by how often each is used: FIRE the biggest under the resting thumb, the rare
// ones small and out of the way.
export const BUTTONS = [
  { name: 'fire', label: 'FIRE', cmd: '+attack', cls: 'fire', d: 88, right: 146, bottom: 97, look: true },
  { name: 'aim', label: 'AIM', cmd: '+attack2', cls: 'aim small', d: 60, right: 216, bottom: 157, look: true },
  { name: 'jump', label: 'JUMP', cmd: '+jump', cls: '', d: 64, right: 46, bottom: 179, look: true },
  { name: 'duck', label: 'DUCK', cmd: '+duck', cls: '', d: 56, right: 46, bottom: 85, look: true, toggle: true },
  { name: 'reload', label: 'RELOAD', cmd: '+reload', cls: 'small', d: 52, mid: 100, bottom: 36, look: true },
  { name: 'next', label: 'NEXT', cmd: 'invnext', cls: 'small', d: 44, mid: -100, bottom: 36 },
  { name: 'use', label: 'USE', cmd: '+use', cls: 'small', d: 48, right: 38, top: 38, look: true },
  { name: 'buy', label: 'BUY', cmd: 'buymenu', cls: 'small', d: 44, right: 96, top: 38 },
  { name: 'ammo', cmd: 'invnext', zone: true, w: 140, h: 70, mid: 0, bottom: 35 },
  { name: 'fire2', label: 'FIRE', cmd: '+attack', cls: 'fire', d: 64, left: 114, bottom: 217, option: 'fireLeft' },
];

// The buttons placed in a w × h layer at `scale`: [{ ...spec, cx, cy, r (or w, h) }], all
// inside the layer. Options: fireLeft (the second FIRE on the left). A big scale is capped
// on a small screen (a phone), so the buttons stay apart.
export function layoutRects(w, h, scale = 1, options = {}) {
  const out = [];
  const s = Math.min(scale, w / 580, h / 320);
  for (const b of BUTTONS) {
    if (b.option && options[b.option] === false) continue;
    const cx = b.left !== undefined ? b.left * s : b.right !== undefined ? w - b.right * s : w / 2 + b.mid * s;
    const cy = b.top !== undefined ? b.top * s : h - b.bottom * s;
    if (b.zone) {
      out.push({ ...b, cx, cy, w: b.w * s, h: b.h * s });
      continue;
    }
    const r = b.d * s / 2;
    out.push({ ...b, cx: Math.min(Math.max(cx, r), w - r), cy: Math.min(Math.max(cy, r), h - r), r });
  }
  return out;
}

// The presses: `press(id, x, y)` for a finger landing at (x, y) in the layer returns the
// button it pressed ({ look } tells the caller whether that finger looks too) or null;
// `release(id)` lets it go. exec(command) runs a console command as a key would (the
// caller's ctx names the key 'touch', so held bits release right); show(button, on) draws
// the press.
export class TouchButtons {
  constructor(exec, show = () => {}) {
    this.exec = exec;
    this.show = show;
    this.rects = [];
    this.held = new Map(); // touch id -> button
    this.toggled = new Set(); // the toggle buttons on
    this.hidden = new Set(); // button names out of use now (AIM with a weapon that has no right click)
  }

  layout(w, h, scale, options) {
    this.rects = layoutRects(w, h, scale, options);
    return this.rects;
  }

  // The button under (x, y), with a little slack round the discs.
  at(x, y) {
    for (const b of this.rects) {
      if (this.hidden.has(b.name)) continue;
      if (b.zone) {
        if (Math.abs(x - b.cx) <= b.w / 2 && Math.abs(y - b.cy) <= b.h / 2) return b;
      } else {
        const dx = x - b.cx, dy = y - b.cy, reach = b.r + 6;
        if (dx * dx + dy * dy <= reach * reach) return b;
      }
    }
    return null;
  }

  press(id, x, y) {
    const b = this.at(x, y);
    if (!b) return null;
    if (b.toggle) {
      const on = !this.toggled.has(b.name);
      if (on) this.toggled.add(b.name);
      else this.toggled.delete(b.name);
      this.show(b, on);
      this.exec(on ? b.cmd : releaseOf(b.cmd));
      return b;
    }
    this.held.set(id, b);
    this.show(b, true);
    this.exec(b.cmd);
    return b;
  }

  release(id) {
    const b = this.held.get(id);
    if (!b) return;
    this.held.delete(id);
    let still = false; // another finger on the same button keeps it
    for (const o of this.held.values()) if (o === b) still = true;
    if (still) return;
    this.show(b, false);
    const r = releaseOf(b.cmd);
    if (r) this.exec(r);
  }

  // The mouse let go (the menus): every press and toggle off (the keys are cleared with the
  // lock, so nothing runs).
  reset() {
    for (const b of this.held.values()) this.show(b, false);
    this.held.clear();
    for (const name of this.toggled) {
      const b = this.rects.find((r) => r.name === name) || BUTTONS.find((r) => r.name === name);
      if (b) this.show(b, false);
    }
    this.toggled.clear();
  }
}

export class TouchControls {
  // root: the #touch layer (the stick's ring and knob; the buttons are made here);
  // exec(command) runs a console command as a key would.
  constructor(root, input, exec) {
    this.root = root;
    this.ring = root.querySelector('.stick');
    this.knob = root.querySelector('.knob');
    this.scale = 1;
    this.options = { fireLeft: true };
    this.left = 0; // the layer's place on the page (the fingers come in page coordinates)
    this.top = 0;
    this.alt = undefined; // the AIM button's label now (setAlt)
    this.els = new Map(); // button name -> element
    for (const b of BUTTONS) {
      if (b.zone) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = b.cls;
      el.textContent = b.label;
      el.dataset.name = b.name;
      root.append(el);
      this.els.set(b.name, el);
    }
    this.buttons = new TouchButtons(exec, (b, on) => {
      const el = this.els.get(b.name);
      if (el) el.classList.toggle('on', on);
    });
    input.onTouchDown = (id, x, y) => this.buttons.press(id, x - this.left, y - this.top);
    input.onTouchUp = (id) => this.buttons.release(id);
    input.onStick = (active, x, y, dx, dy) => this.drawStick(active, x, y, dx, dy);
    new ResizeObserver(() => this.layout()).observe(root);
    this.layout();
  }

  // Opacity and size (the touch_* cvars, main.js).
  setOptions({ opacity, scale, fireLeft }) {
    if (opacity !== undefined) this.root.style.setProperty('--touch-alpha', String(opacity));
    if (scale !== undefined) {
      this.scale = scale;
      this.root.style.setProperty('--touch-scale', String(scale));
    }
    if (fireLeft !== undefined) this.options.fireLeft = fireLeft;
    this.layout();
  }

  // The AIM button says what the right mouse button does with the weapon in hand
  // (`altLabel`), and goes when it does nothing.
  setAlt(label) {
    if (label === this.alt) return;
    this.alt = label;
    const el = this.els.get('aim');
    el.textContent = label || '';
    el.classList.toggle('gone', !label);
    el.classList.toggle('long', !!label && label.length > 5);
    if (label) this.buttons.hidden.delete('aim');
    else this.buttons.hidden.add('aim');
  }

  layout() {
    const rect = this.root.getBoundingClientRect();
    this.left = rect.left;
    this.top = rect.top;
    const rects = this.buttons.layout(rect.width, rect.height, this.scale, this.options);
    for (const el of this.els.values()) el.style.display = 'none';
    for (const b of rects) {
      const el = this.els.get(b.name);
      if (!el) continue;
      el.style.display = 'block';
      el.style.left = `${b.cx - b.r}px`;
      el.style.top = `${b.cy - b.r}px`;
      el.style.width = el.style.height = `${b.r * 2}px`;
    }
  }

  // The ring where the finger landed, the knob under the finger (clamped to the ring).
  drawStick(active, x, y, dx, dy) {
    this.ring.style.display = active ? 'block' : 'none';
    if (!active) return;
    const d = Math.sqrt(dx * dx + dy * dy), k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
    this.ring.style.left = `${x - this.left}px`;
    this.ring.style.top = `${y - this.top}px`;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  // The mouse let go (the menus): every press and toggle off, the stick hidden.
  reset() {
    this.buttons.reset();
    this.ring.style.display = 'none';
  }
}
