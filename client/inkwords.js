// Comic sound words (cl_comicwords): BAM! on our hits, HEADSHOT! and KAPOW! on our kills,
// BLAM! / RAT-TAT-TAT! for our own gunfire, PAK! on walls we hit, KA-BOOM! on explosions,
// SMOKE! on smoke grenades, FIRE! and CRACKLE! on fires.
// A fixed pool of DOM elements, reused oldest first; the pop animation is CSS (#fx in
// index.html). Spawning happens on events, never per frame; update() only hides the
// expired ones and fades the gunfire ticker.

import { GUN_SOUNDS } from './audio.js';

const POOL = 24;
const TICKER_GAP_MS = 260; // no shot for this long ends a burst's word
const TICKER_MAX = 4; // words in one burst line ("RAT-TAT-TAT-TAT!"), then a new line
const pick = (a) => a[(Math.random() * a.length) | 0];
const rnd = (a, b) => a + Math.random() * (b - a);

const HIT = ['BAM!', 'POW!', 'WHAP!', 'THWAK!', 'BLAM!'];
const WALL = ['PAK!', 'TIK!', 'ZING!', 'PTANG!'];
// Gunfire words by gunshot voice (client/soundscape.js gunProfile): single words, or a
// ticker of beats for automatic fire.
const SHOTS = new Map([
  [GUN_SOUNDS.pistol, { words: ['BANG!', 'BLAM!', 'PAM!'], size: 44 }],
  [GUN_SOUNDS.heavy, { words: ['KA-BLAM!', 'BLAM!'], size: 54, big: true }],
  [GUN_SOUNDS.sniper, { words: ['KRA-KOOM!', 'KA-BLAM!', 'THOOM!'], size: 60, big: true }],
  [GUN_SOUNDS.shotgun, { words: ['KA-CHOW!', 'BOOM!'], size: 58, big: true }],
  [GUN_SOUNDS.silenced, { words: ['THWIP!', 'PFFT!'], size: 36 }],
  [GUN_SOUNDS.rifle, { beat: ['RAT', 'TAT'], size: 50 }],
  [GUN_SOUNDS.smg, { beat: ['BRR', 'RRT'], size: 46 }],
  [GUN_SOUNDS.mg, { beat: ['BUDD', 'BUDD'], size: 52 }],
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

export class InkWords {
  constructor(root) {
    this.root = root;
    this.enabled = true;
    this.items = [];
    this.next = 0;
    this.q = new Float32Array(4);
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('div');
      el.className = 'pop';
      el.innerHTML = '<div class="in"><i class="bk"></i><i class="fg"></i><b></b></div>';
      el.hidden = true;
      root.append(el);
      this.items.push({ el, inner: el.firstChild, bk: el.querySelector('.bk'), fg: el.querySelector('.fg'),
        b: el.querySelector('b'), end: 0 });
    }
    // The gunfire ticker: one line that grows with each shot of a burst.
    this.ticker = document.createElement('div');
    this.ticker.className = 'pop ticker';
    this.ticker.innerHTML = '<div class="in"><b></b></div>';
    this.ticker.hidden = true;
    this.tickerText = this.ticker.querySelector('b');
    root.append(this.ticker);
    this.beats = 0;
    this.lastBeat = 0;
    this.beatWords = null;
  }

  // Shows `text` at screen (x, y) (CSS px): cls is the look (hit, big, wall, spark, shot),
  // size the letter height at 720 px of window, life in ms.
  spawn(text, cls, x, y, size, life = 700) {
    if (!this.enabled) return;
    const it = this.items[this.next];
    this.next = (this.next + 1) % POOL;
    const el = it.el, s = size * innerHeight / 720;
    el.className = `pop ${cls}`;
    el.style.setProperty('--s', `${s.toFixed(1)}px`);
    el.style.setProperty('--r', `${rnd(-14, 14).toFixed(1)}deg`);
    el.style.setProperty('--life', `${life}ms`);
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    const burst = cls !== 'wall' && !cls.startsWith('shot');
    it.bk.hidden = it.fg.hidden = !burst;
    if (burst) it.bk.style.clipPath = it.fg.style.clipPath = pick(STARS);
    it.b.textContent = text;
    el.hidden = false;
    // Restart the CSS animation on a reused element.
    it.inner.style.animation = 'none';
    void it.inner.offsetWidth;
    it.inner.style.animation = '';
    it.end = performance.now() + life;
  }

  // At world point (x, y, z), projected with viewProj; nothing behind the view.
  at(viewProj, x, y, z, text, cls, size, life) {
    const m = viewProj, w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1) return;
    const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    if (sx < -1.2 || sx > 1.2 || sy < -1.2 || sy > 1.2) return;
    this.spawn(text, cls, (sx * 0.5 + 0.5) * innerWidth, (0.5 - sy * 0.5) * innerHeight, size, life);
  }

  // Our bullet hit someone at (x, y, z).
  hit(viewProj, x, y, z) {
    this.at(viewProj, x, y, z, pick(HIT), 'hit', rnd(32, 40), 760);
  }

  // We killed someone.
  kill(headshot) {
    this.spawn(headshot ? 'HEADSHOT!' : pick(['KAPOW!', 'KRAK!', 'WHAMMO!']), 'big', innerWidth * rnd(0.46, 0.54),
      innerHeight * 0.36, headshot ? 46 : 42, 900);
  }

  // Our bullet hit a wall at (x, y, z): a spark, now and then a word.
  wall(viewProj, x, y, z) {
    this.at(viewProj, x, y, z, '', 'spark', rnd(18, 26), 240);
    if (Math.random() < 0.25) this.at(viewProj, x, y, z, pick(WALL), 'wall', rnd(18, 26), 620);
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
    const t = this.ticker;
    if (this.beatWords !== s.beat || this.beats >= TICKER_MAX || now - this.lastBeat > TICKER_GAP_MS) {
      this.beats = 0;
      this.beatWords = s.beat;
      t.style.setProperty('--s', `${(s.size * innerHeight / 720).toFixed(1)}px`);
      t.style.setProperty('--r', `${rnd(-9, 3).toFixed(1)}deg`);
      t.style.transform = `translate(${(x - innerWidth * 0.1).toFixed(1)}px, ${y.toFixed(1)}px)`;
      t.classList.remove('out');
    }
    this.beats++;
    this.lastBeat = now;
    let text = s.beat[0];
    for (let i = 1; i < this.beats; i++) text += `-${s.beat[1]}`;
    this.tickerText.textContent = `${text}!`;
    t.hidden = false;
    this.tickerText.animate?.([{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { duration: 110 });
  }

  // Every frame: hides expired words and fades the ticker after a burst.
  update(now) {
    for (let i = 0; i < POOL; i++) {
      const it = this.items[i];
      if (it.end && now > it.end) {
        it.end = 0;
        it.el.hidden = true;
      }
    }
    if (!this.ticker.hidden && now - this.lastBeat > TICKER_GAP_MS) {
      if (!this.ticker.classList.contains('out')) this.ticker.classList.add('out');
      else if (now - this.lastBeat > TICKER_GAP_MS + 320) {
        this.ticker.hidden = true;
        this.beats = 0;
      }
    }
  }

  clear() {
    for (const it of this.items) {
      it.end = 0;
      it.el.hidden = true;
    }
    this.ticker.hidden = true;
    this.beats = 0;
  }
}
