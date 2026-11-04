// The hurt indicator (CS:GO's red arcs round the crosshair): each hit taken from somewhere
// (the own block's OWN_HURT place: a shooter's eye, a blast, the bomb; the sandbox's
// grenades) shows a red arc with an ink outline on a ring round the middle of the screen,
// pointing at that place as the view turns, at full strength for HOLD seconds and fading out
// by HURT_FADE. A pool of SLOTS SVG arcs is made once; update() touches the DOM only while
// one shows, and only when what it shows changed.

export const HURT_FADE = 1.5; // seconds an arc lasts
const HOLD = 0.4; // at full strength first
const SLOTS = 4;
const SPREAD = 24; // degrees each side of its direction
const SAME = 48; // a hit from within this of a showing arc's place renews that arc (a spray)

// The arc's place on the screen: degrees clockwise from straight up, for damage from (x, y)
// taken at (ex, ey) looking along yaw (degrees; GoldSrc turns counterclockwise from +x, so a
// place to the left of the view is counterclockwise on the screen).
export function hurtAngle(x, y, ex, ey, yaw) {
  const a = Math.atan2(y - ey, x - ex) * 180 / Math.PI;
  return ((yaw - a) % 360 + 540) % 360 - 180;
}

// A crescent pointing up in a -50..50 box: thickest in the middle, pinched at the ends.
function arcPath() {
  const pts = [], n = 12;
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i <= n; i++) {
      const u = side ? 1 - i / n : i / n, a = (u * 2 - 1) * SPREAD * Math.PI / 180;
      const t = 1 - (u * 2 - 1) ** 2, r = 42 + (side ? -1 : 1) * (0.6 + 4.4 * t);
      pts.push(`${(Math.sin(a) * r).toFixed(2)},${(-Math.cos(a) * r).toFixed(2)}`);
    }
  }
  return `M${pts.join('L')}Z`;
}

export class HurtIndicator {
  constructor(root) {
    this.root = root;
    const d = arcPath();
    this.slots = [];
    for (let i = 0; i < SLOTS; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '-50 -50 100 100');
      svg.innerHTML = `<path d="${d}"/>`;
      svg.style.display = 'none';
      root.appendChild(svg);
      this.slots.push({ el: svg, on: false, x: 0, y: 0, at: 0, angle: NaN, alpha: NaN });
    }
  }

  // A hit from (x, y) at time `now` (seconds).
  add(x, y, now) {
    let slot = null, oldest = null;
    for (const s of this.slots) {
      if (s.on && Math.hypot(s.x - x, s.y - y) < SAME) { slot = s; break; }
      if (!s.on && !slot) slot = s;
      if (!oldest || s.at < oldest.at) oldest = s;
    }
    slot ||= oldest;
    slot.x = x;
    slot.y = y;
    slot.at = now;
    if (!slot.on) {
      slot.on = true;
      slot.el.style.display = '';
    }
    this.active = true;
  }

  // Every frame: the arcs for the eye at (ex, ey) looking along yaw; `show` false hides them
  // (dead, spectating, the HUD off).
  update(now, ex, ey, yaw, show) {
    if (!this.active) return;
    let any = false;
    for (const s of this.slots) {
      if (!s.on) continue;
      const age = now - s.at;
      if (age >= HURT_FADE || !show) {
        s.on = false;
        s.el.style.display = 'none';
        s.angle = s.alpha = NaN;
        continue;
      }
      any = true;
      const angle = Math.round(hurtAngle(s.x, s.y, ex, ey, yaw) * 2) / 2;
      const alpha = age < HOLD ? 1 : Math.round((1 - (age - HOLD) / (HURT_FADE - HOLD)) * 50) / 50;
      if (angle !== s.angle) s.el.style.transform = `rotate(${s.angle = angle}deg)`;
      if (alpha !== s.alpha) s.el.style.opacity = s.alpha = alpha;
    }
    this.active = any;
  }

  clear() {
    for (const s of this.slots) {
      s.on = false;
      s.el.style.display = 'none';
      s.angle = s.alpha = NaN;
    }
    this.active = false;
  }
}
