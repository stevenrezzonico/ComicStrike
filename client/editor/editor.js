// The map editor (client/editor.html): boxes and points in three 2D views, a live 3D
// preview (the game page itself in an iframe, `?preview`: the sandbox flying through the
// map as printed), and the map compiled by our box compiler in a worker (compile.js).
// Play alone and Host for friends hand the compiled map over (client/handoff.js) and open
// the game in a new tab (`?fromeditor`), which starts it as a .bsp picked in Your map. The project
// autosaves in localStorage (a convenience: Save writes a file) and saves / opens as JSON.

import {
  TEXTURES, KINDS, POINTS, newProject, readProject, checkProject, bounds,
} from './project.js';
import { View2D } from './view2d.js';
import { textureRecord } from '../texcolors.js';
import { putHandoff } from '../handoff.js';

const STORE_KEY = 'comicstrike.editor';
const UNDO = 200;
const GRIDS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const MODES = [['competitive', 'Competitive'], ['casual', 'Casual'], ['wingman', 'Wingman'], ['deathmatch', 'Deathmatch'],
  ['armsrace', 'Arms Race'], ['demolition', 'Demolition'], ['demo', 'Demo']];
const BOTS = [[0, 'None'], [2, '2'], [4, '4'], [6, '6'], [10, '10']];
const TOOLS = [['select', 'Select'], ['box', 'Box'], ['info_player_deathmatch', 'T spawn'],
  ['info_player_start', 'CT spawn'], ['hostage_entity', 'Hostage']];
const SLOTS = [['all', 'All'], ['top', 'Top'], ['side', 'Sides'], ['bottom', 'Bottom']];
const PREVIEW_DELAY = 400; // ms after the last change before the 3D view is rebuilt

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

class Editor {
  constructor() {
    this.project = this.load() || newProject();
    this.selection = new Set();
    this.tool = 'select';
    this.kind = 'world';
    this.slot = 'all';
    this.texture = 'crete3_wall02';
    this.grid = 16;
    this.undoStack = [];
    this.redoStack = [];
    // The extent new boxes take along the axis a view hides: [min, max] per axis.
    this.range = [[-64, 64], [-64, 64], [0, 128]];
    this.colors = new Map();
    this.spaceHeld = false;
    this.views = [...document.querySelectorAll('.view[data-view]')].map((v) => new View2D(v, v.dataset.view, this));
    this.worker = new Worker('/client/editor/compile.js', { type: 'module' });
    this.jobs = new Map(); // id -> resolve
    this.jobId = 0;
    this.worker.onmessage = (e) => {
      const done = this.jobs.get(e.data.id);
      this.jobs.delete(e.data.id);
      if (done) done(e.data);
    };
    this.previewReady = false;
    this.previewTimer = 0;
    this.previewNext = 0; // the job whose map the 3D view shows (later answers replace it)
    this.buildChrome();
    this.renderProps();
    this.renderProblems();
    requestAnimationFrame(() => {
      this.fitAll();
      this.frame();
    });
    addEventListener('message', (e) => this.message(e));
    $('preview').src = '/?preview';
  }

  // --- Project state ---------------------------------------------------------------------

  items() {
    return [...this.project.brushes, ...this.project.points];
  }

  selected() {
    return this.items().filter((it) => this.selection.has(it.id));
  }

  boundsOf(it) {
    if (it.b) return it.b;
    const [x, y, z] = it.o;
    return [x - 16, y - 16, z, x + 16, y + 16, z + 72];
  }

  colorOf(tex) {
    if (!tex) return '#ddd';
    if (!this.colors.has(tex)) {
      const r = textureRecord(tex);
      this.colors.set(tex, r ? `rgb(${r[0]}, ${r[1]}, ${r[2]})` : tex === 'sky' ? '#9fd3ea' : '#bbb');
    }
    return this.colors.get(tex);
  }

  select(ids) {
    this.selection = new Set(ids);
    const one = this.selected();
    if (one.length === 1 && one[0].b) this.range = [0, 1, 2].map((k) => [one[0].b[k], one[0].b[k + 3]]);
    this.redraw();
    this.renderProps();
  }

  toggle(id) {
    const s = new Set(this.selection);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.select(s);
  }

  // Remembers the project as it is, before a change (undo).
  commit() {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  // After a change: redraw; `final` (the end of a gesture or an edit) also refreshes the
  // panels, saves and rebuilds the 3D view.
  changed(final = true) {
    this.redraw();
    if (!final) return;
    this.renderProps();
    this.renderProblems();
    this.save();
    this.schedulePreview();
  }

  redraw() {
    for (const v of this.views) v.dirty = true;
  }

  undo(redo = false) {
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
    if (!from.length) return;
    to.push(JSON.stringify(this.project));
    this.project = JSON.parse(from.pop());
    this.selection = new Set([...this.selection].filter((id) => this.items().some((it) => it.id === id)));
    this.changed();
  }

  addBox(ax, u0, v0, u1, v1) {
    this.commit();
    const b = [0, 0, 0, 0, 0, 0];
    b[ax.u] = u0;
    b[ax.u + 3] = u1;
    b[ax.v] = v0;
    b[ax.v + 3] = v1;
    b[ax.w] = this.range[ax.w][0];
    b[ax.w + 3] = this.range[ax.w][1];
    const kind = KINDS[this.kind];
    const t = this.texture;
    const tex = kind.trigger ? { top: null, bottom: null, side: null }
      : kind.water ? { top: '!watergreen', bottom: null, side: null } : { top: t, bottom: t, side: t };
    const br = { id: this.project.nextId++, b, tex, kind: this.kind, keys: { ...kind.keys } };
    this.project.brushes.push(br);
    this.select([br.id]);
    this.changed();
  }

  // A point at (u, v) in a view: from the top, on the highest floor under it within the
  // working height; from the side, its feet where clicked.
  addPoint(kind, ax, u, v) {
    this.commit();
    const o = [0, 0, 0];
    o[ax.u] = u;
    o[ax.v] = v;
    if (ax.w === 2) o[2] = this.floorUnder(u, v);
    else o[ax.w] = Math.round((this.range[ax.w][0] + this.range[ax.w][1]) / 2 / this.grid) * this.grid;
    const q = { id: this.project.nextId++, kind, o, yaw: kind === 'info_player_start' ? 180 : 0 };
    this.project.points.push(q);
    this.select([q.id]);
    this.changed();
  }

  floorUnder(x, y) {
    let z = null;
    for (const br of this.project.brushes) {
      const k = KINDS[br.kind];
      if (k.trigger || k.water || br.tex.top === 'sky') continue;
      const b = br.b;
      if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && b[5] <= this.range[2][1] && (z === null || b[5] > z)) z = b[5];
    }
    return z ?? 0;
  }

  remove() {
    if (!this.selection.size) return;
    this.commit();
    this.project.brushes = this.project.brushes.filter((b) => !this.selection.has(b.id));
    this.project.points = this.project.points.filter((q) => !this.selection.has(q.id));
    this.selection.clear();
    this.changed();
  }

  duplicate() {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    const ids = [];
    for (const it of sel) {
      const copy = JSON.parse(JSON.stringify(it));
      copy.id = this.project.nextId++;
      const t = copy.b || copy.o;
      t[0] += this.grid;
      t[1] += this.grid;
      if (copy.b) {
        t[3] += this.grid;
        t[4] += this.grid;
        this.project.brushes.push(copy);
      } else this.project.points.push(copy);
      ids.push(copy.id);
    }
    this.select(ids);
    this.changed();
  }

  nudge(axis, d) {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    for (const it of sel) {
      const t = it.b || it.o;
      t[axis] += d;
      if (it.b) t[axis + 3] += d;
    }
    this.changed();
  }

  // --- Chrome --------------------------------------------------------------------------

  buildChrome() {
    const tools = $('tools');
    for (const [id, label] of TOOLS) {
      const b = el('button', '', label);
      b.dataset.tool = id;
      b.addEventListener('click', () => this.setTool(id));
      tools.append(b);
    }
    const kind = $('kind');
    for (const [id, k] of Object.entries(KINDS)) kind.append(new Option(k.label, id));
    kind.addEventListener('change', () => {
      this.kind = kind.value;
      this.setTool('box');
    });
    const slots = $('slots');
    for (const [id, label] of SLOTS) {
      const b = el('button', '', label);
      b.dataset.slot = id;
      b.title = 'Which faces a texture goes on';
      b.addEventListener('click', () => {
        this.slot = id;
        this.refreshChrome();
      });
      slots.append(b);
    }
    const pal = $('palette');
    for (const [name, , , label] of TEXTURES) {
      const b = el('button');
      b.dataset.tex = name;
      b.title = name;
      const sw = el('span', 'swatch');
      sw.style.background = this.colorOf(name);
      b.append(sw, el('span', '', label));
      b.addEventListener('click', () => this.paint(name));
      pal.append(b);
    }
    const grid = $('grid');
    for (const g of GRIDS) grid.append(new Option(String(g), String(g)));
    grid.addEventListener('change', () => this.setGrid(+grid.value));
    for (const [v, l] of MODES) $('mode').append(new Option(l, v));
    for (const [v, l] of BOTS) $('bots').append(new Option(l, String(v)));
    $('bots').value = '10';
    $('new').addEventListener('click', () => {
      if (!confirm('Start a new map? Save this one first if you want to keep it.')) return;
      this.commit();
      this.project = newProject();
      this.selection.clear();
      this.changed();
      this.fitAll();
    });
    $('open').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', async () => {
      const f = $('file').files[0];
      $('file').value = '';
      if (!f) return;
      try {
        const p = readProject(await f.text());
        this.commit();
        this.project = p;
        this.selection.clear();
        this.changed();
        this.fitAll();
        this.status(`Opened ${f.name}`);
      } catch (err) {
        this.status(`${f.name}: ${err.message}`, true);
      }
    });
    $('save').addEventListener('click', () => {
      this.download(new Blob([JSON.stringify(this.project, null, 1)], { type: 'application/json' }), `${this.project.name}.cmap.json`);
    });
    $('undo').addEventListener('click', () => this.undo());
    $('redo').addEventListener('click', () => this.undo(true));
    $('export').addEventListener('click', () => this.exportBsp());
    $('play').addEventListener('click', () => this.play('practice'));
    $('host').addEventListener('click', () => this.play('host'));
    addEventListener('keydown', (e) => this.key(e));
    addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
    this.refreshChrome();
  }

  refreshChrome() {
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === this.tool);
    for (const b of document.querySelectorAll('[data-slot]')) b.classList.toggle('active', b.dataset.slot === this.slot);
    for (const b of document.querySelectorAll('[data-tex]')) b.classList.toggle('active', b.dataset.tex === this.texture);
    $('kind').value = this.kind;
    $('grid').value = String(this.grid);
    $('undo').disabled = !this.undoStack.length;
    $('redo').disabled = !this.redoStack.length;
  }

  setTool(t) {
    this.tool = t;
    this.refreshChrome();
  }

  setGrid(g) {
    this.grid = g;
    this.refreshChrome();
    this.redraw();
  }

  // A texture: on the chosen faces of the selected boxes, and for new boxes.
  paint(name) {
    this.texture = name;
    const boxes = this.selected().filter((it) => it.b && !KINDS[it.kind].trigger);
    if (boxes.length) {
      this.commit();
      for (const b of boxes) {
        for (const s of this.slot === 'all' ? ['top', 'bottom', 'side'] : [this.slot]) {
          if (KINDS[b.kind].water && s !== 'top') continue;
          b.tex[s] = name;
        }
      }
      this.changed();
    }
    this.refreshChrome();
  }

  key(e) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let used = true;
    if (ctrl && (k === 'z' || k === 'Z')) this.undo(e.shiftKey);
    else if (ctrl && (k === 'y' || k === 'Y')) this.undo(true);
    else if (ctrl && (k === 'd' || k === 'D')) this.duplicate();
    else if (ctrl && (k === 's' || k === 'S')) $('save').click();
    else if (k === 'Delete' || k === 'Backspace') this.remove();
    else if (k === 'Escape') this.select([]);
    else if (k === '[') this.setGrid(GRIDS[Math.max(0, GRIDS.indexOf(this.grid) - 1)]);
    else if (k === ']') this.setGrid(GRIDS[Math.min(GRIDS.length - 1, GRIDS.indexOf(this.grid) + 1)]);
    else if (k === 'ArrowLeft') this.nudge(0, -this.grid);
    else if (k === 'ArrowRight') this.nudge(0, this.grid);
    else if (k === 'ArrowUp') this.nudge(1, this.grid);
    else if (k === 'ArrowDown') this.nudge(1, -this.grid);
    else if (k === 'PageUp') this.nudge(2, this.grid);
    else if (k === 'PageDown') this.nudge(2, -this.grid);
    else if (k === 'q' || k === 'e') this.turn(k === 'q' ? 45 : -45);
    else if (k >= '1' && k <= '5' && !ctrl) this.setTool(TOOLS[+k - 1][0]);
    else if (e.code === 'Space') this.spaceHeld = true;
    else used = false;
    if (used) e.preventDefault();
  }

  turn(deg) {
    const pts = this.selected().filter((it) => it.o);
    if (!pts.length) return;
    this.commit();
    for (const q of pts) q.yaw = ((q.yaw + deg) % 360 + 360) % 360;
    this.changed();
  }

  // --- Panels --------------------------------------------------------------------------

  renderProps() {
    const box = $('props');
    box.replaceChildren();
    const sel = this.selected();
    const field = (label, value, set, type = 'text') => {
      const l = el('label');
      const i = el('input');
      i.type = type;
      i.value = value;
      i.addEventListener('change', () => {
        this.commit();
        set(i.value);
        this.changed();
      });
      l.append(el('span', '', label), i);
      box.append(l);
      return i;
    };
    const numbers = (label, values, set) => {
      box.append(el('div', 'help', label));
      const row = el('div', 'xyz');
      values.forEach((v, k) => {
        const i = el('input');
        i.type = 'number';
        i.step = String(this.grid);
        i.value = String(v);
        i.addEventListener('change', () => {
          if (!Number.isFinite(+i.value)) return this.renderProps();
          this.commit();
          set(k, Math.round(+i.value));
          this.changed();
        });
        row.append(i);
      });
      box.append(row);
    };
    if (!sel.length) {
      box.append(el('h3', '', 'Map'));
      field('Name', this.project.name, (v) => {
        this.project.name = v.replace(/[^\w-]/g, '_').slice(0, 31) || 'my_map';
      });
      const b = bounds(this.project);
      box.append(el('p', 'muted', `${this.project.brushes.length} boxes, ${this.project.points.length} points, ` +
        `${b[3] - b[0]} × ${b[4] - b[1]} × ${b[5] - b[2]} units. The map is closed in a sky box round everything.`));
      box.append(el('p', 'muted', 'A player is 32 units wide and 72 tall (36 crouched); steps up to 18 are walked up; ' +
        'a crouch jump reaches 64.'));
      return;
    }
    if (sel.length > 1) {
      box.append(el('h3', '', `${sel.length} selected`));
      const del = el('button', '', 'Delete');
      del.addEventListener('click', () => this.remove());
      box.append(del);
      return;
    }
    const it = sel[0];
    if (it.o) {
      box.append(el('h3', '', POINTS[it.kind].label));
      numbers('Feet (x y z)', it.o, (k, v) => {
        it.o[k] = v;
      });
      field('Facing', it.yaw, (v) => {
        it.yaw = ((Math.round(+v) || 0) % 360 + 360) % 360;
      }, 'number');
      box.append(el('p', 'help', 'Facing: degrees, 0 east, 90 north (Q / E turn it).'));
      return;
    }
    box.append(el('h3', '', KINDS[it.kind].label));
    const kl = el('label');
    const ks = el('select');
    for (const [id, k] of Object.entries(KINDS)) ks.append(new Option(k.label, id));
    ks.value = it.kind;
    ks.addEventListener('change', () => {
      this.commit();
      it.kind = ks.value;
      it.keys = { ...KINDS[it.kind].keys, ...it.keys };
      const k = KINDS[it.kind];
      if (k.trigger) it.tex = { top: null, bottom: null, side: null };
      else if (k.water) it.tex = { top: it.tex.top || '!watergreen', bottom: null, side: null };
      else for (const s of ['top', 'bottom', 'side']) it.tex[s] = it.tex[s] || this.texture;
      this.changed();
    });
    kl.append(el('span', '', 'Kind'), ks);
    box.append(kl);
    numbers('From (x y z)', it.b.slice(0, 3), (k, v) => {
      it.b[k] = Math.min(v, it.b[k + 3] - 1);
    });
    numbers('To (x y z)', it.b.slice(3), (k, v) => {
      it.b[k + 3] = Math.max(v, it.b[k] + 1);
    });
    const kind = KINDS[it.kind];
    if (!kind.trigger) {
      for (const s of kind.water ? ['top'] : ['top', 'side', 'bottom']) {
        const l = el('label');
        const sel2 = el('select');
        sel2.append(new Option('(none)', ''));
        for (const [name, , , label] of TEXTURES) sel2.append(new Option(label, name));
        sel2.value = it.tex[s] || '';
        sel2.addEventListener('change', () => {
          this.commit();
          it.tex[s] = sel2.value || null;
          this.changed();
        });
        l.append(el('span', '', s === 'side' ? 'Sides' : s[0].toUpperCase() + s.slice(1)), sel2);
        box.append(l);
      }
    }
    const keys = Object.keys({ ...kind.keys, ...it.keys });
    if (keys.length) box.append(el('h3', '', 'Settings'));
    for (const k of keys) {
      field(k, it.keys[k] ?? '', (v) => {
        it.keys[k] = v.replace(/"/g, "'").slice(0, 128);
      });
    }
    if (kind.help) box.append(el('p', 'help', kind.help));
  }

  renderProblems() {
    const { errors, warnings } = checkProject(this.project);
    const list = $('problems');
    list.replaceChildren();
    for (const [items, cls] of [[errors, 'error'], [warnings, 'warn']]) {
      for (const p of items) {
        const li = el('li', cls, p.text);
        if (p.id) li.addEventListener('click', () => this.select([p.id]));
        list.append(li);
      }
    }
    if (!errors.length && !warnings.length) list.append(el('li', '', 'None: ready to play.'));
    this.refreshChrome();
  }

  status(text, error = false) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', error);
  }

  fitAll() {
    const b = bounds(this.project);
    for (const v of this.views) v.fit(b);
  }

  frame() {
    for (const v of this.views) v.draw();
    requestAnimationFrame(() => this.frame());
  }

  // --- Saving --------------------------------------------------------------------------

  load() {
    try {
      const text = localStorage.getItem(STORE_KEY);
      return text ? readProject(text) : null;
    } catch {
      return null;
    }
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.project));
    } catch { /* not kept: Save still writes a file */ }
  }

  download(blob, name) {
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // --- Compiling, preview, play --------------------------------------------------------

  compile(light) {
    const id = ++this.jobId;
    return new Promise((resolve) => {
      this.jobs.set(id, resolve);
      this.worker.postMessage({ id, project: this.project, light });
    }).then((r) => ({ ...r, id }));
  }

  schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.updatePreview(), PREVIEW_DELAY);
  }

  async updatePreview() {
    if (!this.previewReady) return;
    const r = await this.compile('draft');
    if (r.id < this.previewNext) return; // an older answer than one shown already
    this.previewNext = r.id;
    if (r.error) return this.status(r.error, true);
    this.status(`${r.stats.faces} faces, compiled in ${Math.round(r.ms)} ms`);
    $('preview').contentWindow.postMessage({ type: 'preview-map', name: this.project.name, bytes: r.bytes }, location.origin,
      [r.bytes]);
  }

  async exportBsp() {
    this.status('Compiling...');
    const r = await this.compile('full');
    if (r.error) return this.status(r.error, true);
    this.download(new Blob([r.bytes], { type: 'application/octet-stream' }), `${this.project.name}.bsp`);
    this.status(`Exported ${this.project.name}.bsp (${Math.round(r.bytes.byteLength / 1024)} KB)`);
  }

  // Hands the map over and opens the game in a new tab, which takes it (client/handoff.js).
  async play(action) {
    this.status('Compiling...');
    const r = await this.compile('full');
    if (r.error) return this.status(r.error, true);
    try {
      await putHandoff({
        action, name: this.project.name, bytes: r.bytes, mode: $('mode').value, players: +$('bots').value, difficulty: 1,
        team: +$('team').value,
      });
    } catch (err) {
      return this.status(`Could not hand the map over: ${err.message}`, true);
    }
    if (!open('/?fromeditor', '_blank')) return this.status('The browser blocked the new tab: allow pop-ups for this site', true);
    this.status(action === 'host' ? 'Hosting in a new tab' : 'Playing in a new tab');
  }

  message(e) {
    if (e.origin !== location.origin) return;
    const m = e.data;
    if (m && m.type === 'preview-ready' && e.source === $('preview').contentWindow) {
      this.previewReady = true;
      this.updatePreview();
    }
  }
}

globalThis.editor = new Editor();
