// The map editor's introduction: a short tour that points at each part of the page in
// turn (a cut-out over the dimmed page and a bubble of text), shown on the first visit
// and again from the ? button. Enter or → goes on, ← back, Esc closes. Whether it was seen
// is kept in localStorage (a convenience: without it the tour shows each visit).

const SEEN_KEY = 'comicstrike.editor.tour';

// [selector of what to point at (null: the middle of the page), title, text].
const STEPS = [
  [null, 'Build a map, play it', 'Put shapes together, see the map printed live, then play it against bots or with ' +
    'friends. This tour takes a minute; the ? button brings it back.'],
  ['#library', 'Shapes', 'Drag a shape onto a view, or click it and draw a rectangle (a click alone puts it at its ' +
    'own size, standing on the floor). Boxes, walls, ramps, stairs, pillars, ladders, crates, doors, water, zones.'],
  ['.view[data-view=top]', 'Move, resize, turn', 'Click a shape to select it and drag it to move it. The yellow ' +
    'squares resize it, the blue knob turns walls and pillars in 15° steps (Shift: freely). Shift+click adds to the ' +
    'selection; drag on empty ground to select several.'],
  ['.view[data-view=top]', 'Measures and snapping', 'Tap a yellow number to type a size. Everything snaps to the grid ' +
    '(its size is in the bar above) and to the edges of other shapes: a red line shows them lining up. Hold Alt to ' +
    'place freely.'],
  ['.view[data-view=top]', 'The menu', 'Right click (or long press on a touch screen) for the menu: duplicate, copy ' +
    'and paste, rotate 90°, mirror, drop to the floor, or turn a box into a ramp, stairs, a pillar or a ladder.'],
  ['[data-tool=ramp]', 'Ramps, stairs, ladders', `Players walk up ramps up to 45° and steps up to 18 units; steeper ` +
    'ones show in Problems. A ladder goes against a wall: set which side the wall is on in its settings, then climb ' +
    'it with W.'],
  ['#palette', 'Textures', 'Choose which faces (all, top, sides, bottom), then click a texture: it goes on the ' +
    'selected shapes and on the next ones you make. They are Counter-Strike 1.6 textures, printed in their own colors.'],
  ['[data-tool=info_player_deathmatch]', 'Spawns and zones', 'Every map needs T and CT spawns, five each for full ' +
    'teams. Buy zones, bomb sites and hostages are in the library too.'],
  ['#view3d', 'The 3D view', 'The map as the game prints it, rebuilt a moment after each change. Click a shape to ' +
    'select it, drag to move it (Alt: up and down). Hold the right button to look round and fly with WASD, Space ' +
    'and Ctrl.'],
  ['#problems', 'Problems', 'What would keep the map from playing well, such as missing spawns or a spawn stuck in a ' +
    'wall. Click one to select the shape at fault.'],
  ['#play', 'Play it', 'Play alone against bots in a new tab, host it for friends (the server keeps your map in memory ' +
    'while people play and gives you a link), or export the .bsp. Your work saves itself in this browser; Save ' +
    'writes a file.'],
];

export class Tour {
  constructor(app) {
    this.app = app;
    this.step = -1;
    this.el = null;
    this.onKey = (e) => {
      if (this.step < 0) return;
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') this.go(this.step + 1);
      else if (e.key === 'ArrowLeft') this.go(this.step - 1);
      else return;
      e.preventDefault();
    };
    this.onResize = () => this.place();
  }

  // On the first visit.
  maybeStart() {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch { /* show it */ }
    if (!seen) setTimeout(() => this.start(), 900);
  }

  start() {
    if (this.step >= 0) return;
    this.el = document.createElement('div');
    this.el.className = 'tour';
    this.el.innerHTML = '<div class="tour-hole"></div><div class="tour-bubble" role="dialog" aria-live="polite">' +
      '<div class="tour-count"></div><h4></h4><p></p><div class="tour-buttons">' +
      '<button type="button" data-act="skip">Skip</button><span></span>' +
      '<button type="button" data-act="back">Back</button><button type="button" data-act="next" class="go">Next</button></div></div>';
    this.el.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'skip') this.close();
      else if (act === 'back') this.go(this.step - 1);
      else if (act === 'next') this.go(this.step + 1);
    });
    document.body.append(this.el);
    addEventListener('keydown', this.onKey, true);
    addEventListener('resize', this.onResize);
    this.go(0);
  }

  go(i) {
    if (i < 0) return;
    if (i >= STEPS.length) return this.close();
    this.step = i;
    const [, title, text] = STEPS[i];
    const b = this.el.querySelector('.tour-bubble');
    b.querySelector('.tour-count').textContent = `${i + 1} / ${STEPS.length}`;
    b.querySelector('h4').textContent = title;
    b.querySelector('p').textContent = text;
    b.querySelector('[data-act=back]').disabled = i === 0;
    b.querySelector('[data-act=next]').textContent = i === STEPS.length - 1 ? 'Start building' : 'Next';
    this.place();
    b.querySelector('[data-act=next]').focus();
  }

  // The cut-out over the step's target, the bubble beside it (below, else above, else
  // over the middle of it), kept on the page.
  place() {
    if (this.step < 0) return;
    const hole = this.el.querySelector('.tour-hole'), b = this.el.querySelector('.tour-bubble');
    const sel = STEPS[this.step][0];
    const target = sel && document.querySelector(sel);
    const r = target && target.getBoundingClientRect();
    if (!r || !r.width) {
      Object.assign(hole.style, { left: '50%', top: '40%', width: '0px', height: '0px' });
      b.style.left = `${Math.max(8, (innerWidth - b.offsetWidth) / 2)}px`;
      b.style.top = `${Math.max(8, innerHeight * 0.3)}px`;
      return;
    }
    const pad = 6;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px` });
    const bw = b.offsetWidth, bh = b.offsetHeight;
    let x = r.left + r.width / 2 - bw / 2, y = r.bottom + 14;
    if (r.right + 14 + bw < innerWidth && r.height > bh) { // beside a tall target
      x = r.right + 14;
      y = r.top + 10;
    } else if (y + bh > innerHeight) y = r.top - bh - 14;
    if (y < 8) y = Math.max(8, r.top + r.height / 2 - bh / 2);
    b.style.left = `${Math.min(Math.max(8, x), innerWidth - bw - 8)}px`;
    b.style.top = `${Math.min(Math.max(8, y), innerHeight - bh - 8)}px`;
  }

  close() {
    this.step = -1;
    if (this.el) this.el.remove();
    this.el = null;
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('resize', this.onResize);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch { /* it shows again next time */ }
  }
}
