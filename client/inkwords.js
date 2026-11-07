// Comic sound words (cl_comicwords): BAM! on our hits, HEADSHOT! and KAPOW! on our kills,
// BLAM! / RATA-TA-TA! for our own gunfire, PAK! on walls we hit, KA-BOOM! on explosions,
// SMOKE! on smoke grenades, FIRE! and CRACKLE! on fires. Nothing covers the crosshair:
// our own hits land under it, so their words go beside it (they hid the target in a fight).
// A fixed pool of DOM elements, reused oldest first; the look is CSS (#fx in index.html),
// the pop a Web Animation of transform and opacity with the word's place and turn in its
// keyframes, which the compositor runs (a CSS animation reading var(--r) in its keyframes
// may not be), ending invisible. A spawn writes only what differs from the slot's last
// word: each write is a style recalculation that frame. Spawning happens on events, never
// per frame; update() only fades the gunfire lines.

import { GUN_SOUNDS } from './audio.js';

const POOL = 24;
const TICKER_GAP_MS = 260; // no shot for this long ends a burst's word
const LINE_BEATS = 6; // shots in one line of a spray ("RATA-TA-TA-TA-TA!"), then a new line above it
const LINES = 3; // lines of one spray on screen at once, the oldest fading
const CLEAR = 0.15; // radius round the crosshair, of the window height, kept free of words
const pick = (a) => a[(Math.random() * a.length) | 0];
const rnd = (a, b) => a + Math.random() * (b - a);

const HIT = ['BAM!', 'POW!', 'WHAP!', 'THWAK!', 'BLAM!'];
const WALL = ['PAK!', 'TIK!', 'ZING!', 'PTANG!'];
// Gunfire words by gunshot voice (client/soundscape.js gunProfile): single words, or for
// automatic fire a line that grows with each shot (text(n): the line after n shots).
const SHOTS = new Map([
  [GUN_SOUNDS.pistol, { words: ['BANG!', 'BLAM!', 'PAM!'], size: 44 }],
  [GUN_SOUNDS.heavy, { words: ['KA-BLAM!', 'BLAM!'], size: 54, big: true }],
  [GUN_SOUNDS.sniper, { words: ['KRA-KOOM!', 'KA-BLAM!', 'THOOM!'], size: 60, big: true }],
  [GUN_SOUNDS.shotgun, { words: ['KA-CHOW!', 'BOOM!'], size: 58, big: true }],
  [GUN_SOUNDS.silenced, { words: ['THWIP!', 'PFFT!'], size: 36 }],
  [GUN_SOUNDS.taser, { words: ['BZZT!', 'ZAP!', 'KRZZT!'], size: 50 }],
  [GUN_SOUNDS.rifle, { text: (n) => (n === 1 ? 'RA' : `RATA${'-TA'.repeat(n - 2)}`), size: 52 }],
  [GUN_SOUNDS.smg, { text: (n) => `B${'R'.repeat(n + 1)}AP`, size: 46 }],
  [GUN_SOUNDS.mg, { text: (n) => `BUDDA${'-DA'.repeat(n - 1)}`, size: 52 }],
]);

// Jagged burst outlines behind hit words, made once.
const STARS = Array.from({ length: 6 }, () => {
  const n = 11 + ((Math.random() * 5) | 0), pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? rnd(28, 36) : rnd(46, 50);
    pts.push(`${(50 + Math.cos(a) * r).toFixed(1)}% ${(50 + Math.sin(a) * r).toFixed(1)}%`);
  }
  return `polygon(${pts.join(',')})`;
});
// A long jagged balloon behind a spray's line: many small spikes, so it stays jagged
// however far the line stretches it.
const BANNER = (() => {
  const n = 34, pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? 0.87 : 1;
    pts.push(`${(50 + Math.cos(a) * r * 50).toFixed(1)}% ${(50 + Math.sin(a) * r * 50).toFixed(1)}%`);
  }
  return `polygon(${pts.join(',')})`;
})();

// A spray line's kick per shot: a few jolts to pick from.
const JOLTS = [-3, -1.8, -0.6, 0.6, 1.8, 3].map((j) => [
  { transform: `scale(1.28) translate(${j}px, ${-Math.abs(j)}px) rotate(${j}deg)` }, { transform: 'scale(1)' }]);
const JOLT_TIMING = { duration: 120 };
// The pop: scales up past full size, settles, then drifts up and fades (each segment eased,
// as a CSS animation's timing function is).
const EASE = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'linear' : 'cubic-bezier(0.2, 0.9, 0.3, 1.2)';
function popFrames(x, y, r) {
  const at = `translate(${x}px, ${y}px) translate(-50%, `;
  return [
    { transform: `${at}-50%) rotate(${r}deg) scale(0.2)`, opacity: 1, offset: 0, easing: EASE },
    { transform: `${at}-50%) rotate(${r}deg) scale(1.18)`, offset: 0.14, easing: EASE },
    { transform: `${at}-50%) rotate(${r}deg) scale(1)`, offset: 0.26, easing: EASE },
    { opacity: 1, offset: 0.72, easing: EASE },
    { transform: `${at}-78%) rotate(${r}deg) scale(0.92)`, opacity: 0, offset: 1 },
  ];
}

export class InkWords {
  constructor(root) {
    this.root = root;
    this.enabled = true;
    this.items = [];
    this.next = 0;
    this.sx = 0; // project()'s result: screen position (CSS px)
    this.sy = 0;
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('div');
      el.className = 'pop';
      el.innerHTML = '<div class="in"><i class="bk"></i><i class="fg"></i><b></b></div>';
      el.hidden = true;
      root.append(el);
      // Each slot keeps one burst outline (set once: a new clip path every spawn restyled it).
      const it = { el, inner: el.firstChild, bk: el.querySelector('.bk'), fg: el.querySelector('.fg'),
        b: el.querySelector('b'), anim: null, cls: '', size: '' };
      it.bk.style.clipPath = it.fg.style.clipPath = STARS[i % STARS.length];
      this.items.push(it);
    }
    // Automatic fire: a line that grows with each shot of a spray; a long spray stacks new
    // lines above it, tilted the other way, the older ones fading.
    this.lines = Array.from({ length: LINES }, () => {
      const el = document.createElement('div');
      el.className = 'pop ticker';
      el.innerHTML = '<div class="in"><i class="bk"></i><i class="fg"></i><b></b></div>';
      el.hidden = true;
      for (const i of el.querySelectorAll('i')) i.style.clipPath = BANNER;
      root.append(el);
      return { el, b: el.querySelector('b'), x: 0, y: 0 };
    });
    this.line = 0; // the line growing now
    this.beats = 0; // shots in it
    this.lineCount = 0; // lines this spray
    this.lastBeat = 0;
    this.burst = null; // the SHOTS entry of the spray
  }

  // Shows `text` at screen (x, y) (CSS px): cls is the look (hit, big, wall, shot),
  // size the letter height at 720 px of window, life in ms.
  spawn(text, cls, x, y, size, life = 700) {
    if (!this.enabled) return;
    const it = this.items[this.next];
    this.next = (this.next + 1) % POOL;
    const el = it.el, s = (size * innerHeight / 720).toFixed(1);
    if (cls !== it.cls) {
      it.cls = cls;
      el.className = `pop ${cls}`;
      const burst = cls !== 'wall' && !cls.startsWith('shot');
      it.bk.hidden = it.fg.hidden = !burst;
    }
    if (s !== it.size) {
      it.size = s;
      el.style.setProperty('--s', `${s}px`);
    }
    if (it.b.textContent !== text) it.b.textContent = text;
    if (el.hidden) el.hidden = false;
    if (it.anim) it.anim.cancel();
    it.anim = it.inner.animate(popFrames(x.toFixed(1), y.toFixed(1), rnd(-14, 14).toFixed(1)), { duration: life, fill: 'forwards' });
  }

  // World point (x, y, z) on the screen (this.sx, this.sy, CSS px) with viewProj; false
  // behind the view or well off it.
  project(viewProj, x, y, z) {
    const m = viewProj, w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1) return false;
    const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    if (sx < -1.2 || sx > 1.2 || sy < -1.2 || sy > 1.2) return false;
    this.sx = (sx * 0.5 + 0.5) * innerWidth;
    this.sy = (0.5 - sy * 0.5) * innerHeight;
    return true;
  }

  // Moves (this.sx, this.sy) out of the clear disc round the crosshair to its edge, up and
  // to the side it was on (either, from the middle), where a comic puts the sound beside the
  // action. False if it had to move.
  aside() {
    const cx = innerWidth / 2, cy = innerHeight / 2, r = CLEAR * innerHeight;
    const dx = this.sx - cx, dy = this.sy - cy;
    if (dx * dx + dy * dy >= r * r) return true;
    const side = dx > 4 ? 1 : dx < -4 ? -1 : Math.random() < 0.5 ? -1 : 1;
    const a = rnd(35, 60) * Math.PI / 180; // from straight up
    this.sx = cx + side * Math.sin(a) * r;
    this.sy = cy - Math.cos(a) * r;
    return false;
  }

  // At world point (x, y, z), projected with viewProj; nothing behind the view.
  at(viewProj, x, y, z, text, cls, size, life) {
    if (this.project(viewProj, x, y, z)) this.spawn(text, cls, this.sx, this.sy, size, life);
  }

  // Our bullet hit someone at (x, y, z): the word beside them, not over them.
  hit(viewProj, x, y, z) {
    if (!this.project(viewProj, x, y, z)) return;
    this.aside();
    this.spawn(pick(HIT), 'hit', this.sx, this.sy, rnd(32, 40), 760);
  }

  // We killed someone: above the crosshair, clear of it.
  kill(headshot) {
    this.spawn(headshot ? 'HEADSHOT!' : pick(['KAPOW!', 'KRAK!', 'WHAMMO!']), 'big', innerWidth * rnd(0.46, 0.54),
      innerHeight * 0.29, headshot ? 46 : 42, 900);
  }

  // Our bullet hit a wall at (x, y, z): now and then a word, beside the crosshair. No spark:
  // the bullet hole marks the hit, and a burst over the view only hid what we shot at.
  wall(viewProj, x, y, z) {
    if (!this.project(viewProj, x, y, z)) return;
    this.aside();
    if (Math.random() < 0.25) this.spawn(pick(WALL), 'wall', this.sx, this.sy, rnd(18, 26), 620);
  }

  // An explosion of the given size (1 = the C4) at (x, y, z): bare lettering, the fireball
  // (client/gl/blast.js) is its burst.
  explosion(viewProj, x, y, z, size = 1) {
    this.at(viewProj, x, y, z, pick(['KA-BOOM!', 'KRA-KOOM!', 'BOOOM!']), 'shot big', 40 + 30 * size, 1100);
  }

  // A smoke grenade popped at (x, y, z): the word rises out of the cloud.
  smoke(viewProj, x, y, z) {
    this.at(viewProj, x, y, z + 110, pick(['SMOKE!', 'FSSSHH!', 'POOF!']), 'shot big', 58, 1400);
  }

  // A fire caught at (x, y, z).
  fire(viewProj, x, y, z) {
    this.at(viewProj, x, y, z + 40, pick(['FIRE!', 'FWOOSH!']), 'shot big', 66, 1400);
  }

  // A burning fire crackles at (x, y, z).
  crackle(viewProj, x, y, z) {
    this.at(viewProj, x, y, z, pick(['CRACKLE!', 'CRACK!', 'WHOOSH!']), 'shot', rnd(26, 34), 900);
  }

  // We fired a gun with gunshot voice `profile`.
  shot(profile, now) {
    const s = SHOTS.get(profile);
    if (!s || !this.enabled) return;
    const x = innerWidth * 0.8 + rnd(-50, 20), y = innerHeight * 0.64 + rnd(-30, 25);
    if (s.words) {
      this.spawn(pick(s.words), s.big ? 'shot big' : 'shot', x, y, s.size * rnd(0.9, 1.1), 650);
      return;
    }
    const size = s.size * innerHeight / 720;
    if (this.burst !== s || now - this.lastBeat > TICKER_GAP_MS) { // a new spray
      for (const l of this.lines) l.el.hidden = true;
      this.burst = s;
      this.lineCount = 0;
      this.beats = LINE_BEATS;
    }
    if (this.beats >= LINE_BEATS) { // a new line above the others (the oldest reused)
      for (const l of this.lines) {
        if (l.el.hidden) continue;
        l.y -= size * 0.95;
        l.el.classList.add('old');
        l.el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
      }
      this.line = this.lineCount++ % LINES;
      const l = this.lines[this.line];
      l.x = innerWidth * 0.5 + (this.lineCount % 2 ? 0 : size * 0.8) + rnd(-10, 10);
      l.y = innerHeight * 0.8 + rnd(-6, 6);
      l.el.className = 'pop ticker';
      l.el.style.setProperty('--s', `${size.toFixed(1)}px`);
      l.el.style.setProperty('--r', `${((this.lineCount % 2 ? -1 : 1) * rnd(3, 8)).toFixed(1)}deg`);
      l.el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
      this.beats = 0;
    }
    const l = this.lines[this.line];
    this.beats++;
    this.lastBeat = now;
    l.b.textContent = `${s.text(this.beats)}!`;
    l.el.hidden = false;
    // Each shot kicks the line: a jolt and a little shake (keyframes made once).
    l.b.animate?.(pick(JOLTS), JOLT_TIMING);
  }

  // Every frame: fades a spray's lines after it (a word's pop ends invisible by itself).
  update(now) {
    if (this.burst && now - this.lastBeat > TICKER_GAP_MS) {
      const gone = now - this.lastBeat > TICKER_GAP_MS + 320;
      for (const l of this.lines) {
        if (l.el.hidden) continue;
        if (gone) l.el.hidden = true;
        else if (!l.el.classList.contains('out')) l.el.classList.add('out');
      }
      if (gone) this.burst = null;
    }
  }

  clear() {
    for (const it of this.items) {
      if (it.anim) it.anim.cancel();
      it.anim = null;
      it.el.hidden = true;
    }
    for (const l of this.lines) l.el.hidden = true;
    this.burst = null;
  }
}
