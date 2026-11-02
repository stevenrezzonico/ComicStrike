// Touch controls under the soft lock (client/input.js: iOS and iPadOS Safari, any
// touch-first device whose browser gives no pointer lock): a floating stick on the left
// of the canvas moves, the rest of the canvas looks (one finger), and two columns of paper
// buttons up the right edge do what the mouse and keys do elsewhere: a big FIRE under the
// thumb, AIM (the right mouse button: the scope, a burst, the silencer), JUMP, DUCK, RELOAD,
// USE, NEXT weapon, the BUY menu. The wire carries buttons only (no analog move), so the
// stick drives the digital WASD bits, walking (+speed) on a small pull.

import { IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED } from '../shared/constants.js';
import { releaseOf } from '../shared/cvars.js';

export const STICK_RADIUS = 56; // px: a full pull
export const STICK_DEAD = 0.3; // of the radius: no movement under it
export const STICK_WALK = 0.7; // of the radius: walking under it, running past
export const STICK_ZONE = 0.4; // of the canvas width: a finger landing left of it is the stick
export const STICK_BITS = IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT | IN_SPEED;
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

export class TouchControls {
  // root: the #touch layer (the stick's ring and knob, the buttons with data-cmd; a
  // data-toggle button stays pressed until tapped again); exec(command) runs a console
  // command as a key would (its ctx names the key 'touch', so held bits release right).
  constructor(root, input, exec) {
    this.root = root;
    this.ring = root.querySelector('.stick');
    this.knob = root.querySelector('.knob');
    this.exec = exec;
    this.toggled = new Map(); // toggle button -> on
    const stop = (e) => e.preventDefault(); // no emulated mouse events, no scroll or zoom
    for (const b of root.querySelectorAll('button[data-cmd]')) {
      const cmd = b.dataset.cmd, toggle = b.dataset.toggle !== undefined;
      b.addEventListener('touchstart', (e) => {
        stop(e);
        if (toggle) {
          const on = !this.toggled.get(b);
          this.toggled.set(b, on);
          b.classList.toggle('on', on);
          exec(on ? cmd : releaseOf(cmd));
        } else {
          b.classList.add('on');
          exec(cmd);
        }
      }, { passive: false });
      const end = (e) => {
        stop(e);
        if (toggle) return;
        b.classList.remove('on');
        const r = releaseOf(cmd);
        if (r) exec(r);
      };
      b.addEventListener('touchend', end, { passive: false });
      b.addEventListener('touchcancel', end, { passive: false });
    }
    input.onStick = (active, x, y, dx, dy) => this.drawStick(active, x, y, dx, dy);
  }

  // The ring where the finger landed, the knob under the finger (clamped to the ring).
  drawStick(active, x, y, dx, dy) {
    this.ring.style.display = active ? 'block' : 'none';
    if (!active) return;
    const d = Math.sqrt(dx * dx + dy * dy), k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
    this.ring.style.left = `${x}px`;
    this.ring.style.top = `${y}px`;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  // The mouse let go (the menus): every toggle off, the stick hidden.
  reset() {
    for (const [b, on] of this.toggled) {
      if (!on) continue;
      this.toggled.set(b, false);
      b.classList.remove('on');
    }
    this.ring.style.display = 'none';
  }
}
