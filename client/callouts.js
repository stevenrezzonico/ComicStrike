// Teammates' radio lines and pings over the scene: a radio line is a speech balloon over
// its speaker's head for BALLOON_MS (CS:GO shows an icon there), a ping a comic "!" where
// it was marked for PING_MS (the radar shows it too: client/radar.js). Pools of DOM
// elements made once in #callouts; update() places the ones showing every frame and hides
// those behind the view. The radio menu (Z / X / C: radio1-3) is the paper list the number
// keys pick from (main routes them here while it is open).

import { RADIO, RADIO_MENUS } from '../shared/protocol.js';

export const BALLOON_MS = 2500, PING_MS = 3000;
const BALLOONS = 6, PINGS = 4;

// The world point o (its x, y, z) on the screen in CSS pixels into out, or false behind the
// camera. (The point as an object: three doubles as arguments were boxed at every call.)
function toScreen(m, o, out) {
  const x = o.x, y = o.y, z = o.z;
  const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13];
  const W = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (W < 1) return false;
  out[0] = (X / W * 0.5 + 0.5) * innerWidth;
  out[1] = (0.5 - Y / W * 0.5) * innerHeight;
  return true;
}

export class Callouts {
  constructor(root, menuEl) {
    this.root = root;
    this.menuEl = menuEl;
    this.menu = -1; // the radio menu open (0-2), -1 none
    this.pt = new Float32Array(2);
    const make = (cls) => {
      const el = document.createElement('div');
      el.className = cls;
      el.style.display = 'none';
      root.appendChild(el);
      return { el, until: -0, id: -1, x: -0, y: -0, z: -0, shown: false, px: 0, py: 0 }; // (-0: doubles from the start)
    };
    this.balloons = Array.from({ length: BALLOONS }, () => make('balloon'));
    this.pings = Array.from({ length: PINGS }, () => make('pingmark'));
    for (const p of this.pings) p.el.textContent = '!';
  }

  // Player `id` said `text` on the radio.
  say(id, text, now) {
    const b = this.balloons.find((o) => o.id === id) || this.balloons.reduce((a, o) => (o.until < a.until ? o : a));
    b.id = id;
    b.until = now + BALLOON_MS;
    b.el.textContent = text;
  }

  // A teammate marked (x, y, z).
  ping(x, y, z, now) {
    const p = this.pings.reduce((a, o) => (o.until < a.until ? o : a));
    Object.assign(p, { x, y, z, until: now + PING_MS });
  }

  // The pings still showing (the radar's): [x, y] pairs.
  // (Index loops in these two, every frame: a for-of made an iterator and a result per
  // step in the optimized code the browser keeps them in.)
  live(now, out) {
    out.length = 0;
    for (let i = 0; i < this.pings.length; i++) {
      const p = this.pings[i];
      if (p.until > now) out.push(p.x, p.y);
    }
    return out;
  }

  // Every frame: speakers' heads from headOf(id, out) (false: not to be shown).
  update(now, viewProj, headOf, show) {
    const pt = this.pt;
    for (let i = 0; i < this.balloons.length; i++) {
      const b = this.balloons[i];
      this.place(b, show && b.until > now && headOf(b.id, b) && toScreen(viewProj, b, pt));
    }
    for (let i = 0; i < this.pings.length; i++) {
      const p = this.pings[i];
      this.place(p, show && p.until > now && toScreen(viewProj, p, pt));
    }
  }

  place(o, on) {
    if (on !== o.shown) {
      o.shown = on;
      o.el.style.display = on ? '' : 'none';
    }
    if (!on) return;
    const px = Math.round(this.pt[0]), py = Math.round(this.pt[1]);
    if (px === o.px && py === o.py) return; // (a new string and a style write only when it moved a pixel)
    o.px = px;
    o.py = py;
    o.el.style.transform = `translate(${px}px, ${py}px)`;
  }

  clear() {
    for (const o of [...this.balloons, ...this.pings]) {
      o.until = 0;
      this.place(o, false);
    }
    this.close();
  }

  // The radio menu k (0-2), or closed if it was open.
  open(k) {
    if (this.menu === k) return this.close();
    this.menu = k;
    const [a, b] = RADIO_MENUS[k];
    this.menuEl.replaceChildren(...RADIO.slice(a, b).map(([, text], i) => {
      const row = document.createElement('div');
      row.textContent = `${i + 1}. ${text}`;
      return row;
    }));
    this.menuEl.style.display = 'block';
  }

  close() {
    this.menu = -1;
    this.menuEl.style.display = 'none';
  }

  // A number key while the menu is open: the radio command picked (its console name), or
  // null (0: closed).
  pick(n) {
    const [a, b] = RADIO_MENUS[this.menu];
    this.close();
    return n >= 1 && a + n - 1 < b ? RADIO[a + n - 1][0] : null;
  }
}
