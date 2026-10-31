// The map editor (client/editor.html): shapes and points in 2D views, a live 3D preview
// (the game page itself in an iframe, `?preview`: the sandbox flying through the map as
// printed, where shapes can be picked and dragged too), and the map compiled by our
// compiler in a worker (compile.js). Shapes come from the library (click a card then draw
// or click in a view, or drag the card onto a view); a right click or a long press opens
// the menu; tapping a measure types it. Try it hands the compiled map over
// (client/handoff.js) and opens the game in a new tab (`?fromeditor`) in demo mode. The project
// autosaves in localStorage (a convenience: Save writes a file) and saves / opens as JSON.

import {
  TEXTURES, KINDS, POINTS, SHAPES, UPS, UP_LABELS, SIDE_COUNTS, MAX_SLOPE, newProject, readProject, checkProject,
  bounds, makeBrush, piecesOf, cornersOf, slopeOf, turnFaces, mirrorFaces, slotOf, withProject, projectIn,
} from './project.js';
import { box, brushPlanes, brushPolygons } from '../../shared/bspwriter.js';
import { View2D } from './view2d.js';
import { textureRecord } from '../texcolors.js';
import { putHandoff } from '../handoff.js';
import { Tour } from './tour.js';

const STORE_KEY = 'comicstrike.editor';
const CLIP_KEY = 'comicstrike.editor.clipboard';
const LAYOUT_KEY = 'comicstrike.editor.layout';
const UNDO = 200;
const GRIDS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const SLOTS = [['all', 'All'], ['top', 'Top'], ['side', 'Sides'], ['bottom', 'Bottom']];
const PREVIEW_DELAY = 400; // ms after the last change before the 3D view is rebuilt
const T3 = (t) => ({ top: t, bottom: t, side: t });

// The library: what a card makes. size: [width (x), depth (y), height] for a click;
// shape fields; kind and keys; tex (null: the current texture); point: a point kind.
// icon: an SVG path in a 24×24 box.
export const CARDS = [
  { id: 'box', label: 'Box', size: [128, 128, 128], icon: 'M4 7h16v13H4z M4 7l4-4h16l-4 4 M20 7v13l4-4V3' },
  { id: 'wall', label: 'Wall', size: [256, 16, 192], icon: 'M2 4h20v16H2z M2 10h20 M2 15h20 M8 4v6 M15 10v5 M8 15v5' },
  { id: 'ramp', label: 'Ramp', size: [256, 128, 128], shape: { shape: 'ramp', up: 'px' }, icon: 'M2 20h20V6z' },
  { id: 'stairs', label: 'Stairs', size: [256, 128, 128], shape: { shape: 'stairs', up: 'px', step: 16 },
    icon: 'M2 20h20V4h-5v4h-5v4H7v4H2z' },
  { id: 'pillar', label: 'Pillar', size: [64, 64, 192], shape: { shape: 'pillar', sides: 8 },
    icon: 'M8 3h8l4 4v10l-4 4H8l-4-4V7z' },
  { id: 'ladder', label: 'Ladder', size: [64, 20, 256], shape: { shape: 'ladder', up: 'py' },
    icon: 'M7 2v20 M17 2v20 M7 6h10 M7 11h10 M7 16h10' },
  { id: 'crate', label: 'Crate', size: [64, 64, 64], tex: T3('crate08'), icon: 'M4 4h16v16H4z M4 4l16 16 M20 4L4 20' },
  { id: 'breakable', label: 'Breakable', size: [64, 64, 64], kind: 'func_breakable', keys: { material: '1', health: '40' },
    tex: { top: 'mltrycrtetp', bottom: 'mltrycrtetp', side: 'mltrycrtesd' }, icon: 'M4 4h16v16H4z M9 4l3 7-4 4 2 5 M15 4l-2 6 5 3' },
  { id: 'glass', label: 'Glass', size: [128, 4, 112], kind: 'func_breakable',
    keys: { material: '0', health: '20', rendermode: '2', renderamt: '110' }, tex: T3('glass_med'), icon: 'M4 3h16v18H4z M8 7l4-2 M7 12l7-5' },
  { id: 'door', label: 'Door', size: [16, 128, 128], kind: 'func_door', keys: { angle: '-1', speed: '160', wait: '3', lip: '8' },
    tex: T3('sandwlldoor'), icon: 'M6 2h12v20H6z M15 12h1' },
  { id: 'swing', label: 'Swing door', size: [12, 112, 126], kind: 'func_door_rotating',
    keys: { distance: '90', speed: '120', wait: '3', hinge: 'start' }, tex: T3('fifties_dr2'), icon: 'M6 2v20 M6 2l12 4v16l-12-0' },
  { id: 'button', label: 'Button', size: [4, 16, 16], kind: 'func_button', keys: { target: '', speed: '40', wait: '1', lip: '2' },
    tex: T3('lab1_comp3d'), icon: 'M6 6h12v12H6z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0' },
  { id: 'water', label: 'Water', size: [256, 256, 32], kind: 'func_water', tex: { top: '!watergreen', bottom: null, side: null },
    icon: 'M2 9c3-3 5 3 8 0s5 3 8 0 4 0 4 0 M2 15c3-3 5 3 8 0s5 3 8 0 4 0 4 0' },
  { id: 'buy_t', label: 'T buy zone', size: [320, 320, 128], kind: 'func_buyzone', keys: { team: '1' }, icon: 'M3 3h18v18H3z M8 8h8v8H8z' },
  { id: 'buy_ct', label: 'CT buy zone', size: [320, 320, 128], kind: 'func_buyzone', keys: { team: '2' }, icon: 'M3 3h18v18H3z M8 8h8v8H8z' },
  { id: 'site', label: 'Bomb site', size: [384, 384, 128], kind: 'func_bomb_target', icon: 'M3 3h18v18H3z M12 7v10 M7 12h10' },
  { id: 'rescue', label: 'Rescue zone', size: [256, 256, 128], kind: 'func_hostage_rescue', icon: 'M3 3h18v18H3z M7 13l3 3 7-8' },
  { id: 'info_player_deathmatch', label: 'T spawn', point: 'info_player_deathmatch', icon: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M8 9h8 M12 9v8' },
  { id: 'info_player_start', label: 'CT spawn', point: 'info_player_start', icon: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M15 9h-4v6h4' },
  { id: 'hostage_entity', label: 'Hostage', point: 'hostage_entity', icon: 'M12 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M6 22v-6a6 6 0 0 1 12 0v6' },
];
const CARD = new Map(CARDS.map((c) => [c.id, c]));

// Shortcuts of the header's controls, shown in their tips (alternatives split by '|');
// the library's first ten cards take 1-9, 0. Ctrl+N is the browser's own, so New is Alt+N.
const KEYS = {
  new: 'Alt+N', open: 'Ctrl+O', save: 'Ctrl+S', undo: 'Ctrl+Z', redo: 'Ctrl+Y|Ctrl+Shift+Z', export: 'Ctrl+E',
  try: 'Ctrl+Enter', layout: 'L', help: '?',
};
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const keyLabel = (k) => MAC ? k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥') : k;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svgIcon = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};

class Editor {
  constructor() {
    this.project = this.load() || newProject();
    this.selection = new Set();
    this.tool = 'select';
    this.slot = 'all';
    this.texture = 'crete3_wall02';
    this.grid = 16;
    this.undoStack = [];
    this.redoStack = [];
    // The extent new shapes take along the axis a view hides: [min, max] per axis.
    this.range = [[-64, 64], [-64, 64], [0, 128]];
    this.colors = new Map();
    this.outlines = new Map(); // shape key -> pieces with corners (the views draw them)
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
    this.menu = null;
    this.buildChrome();
    this.renderProps();
    this.renderProblems();
    requestAnimationFrame(() => {
      this.fitAll();
      this.frame();
    });
    addEventListener('message', (e) => this.message(e));
    $('preview').src = '/?preview';
    this.tour = new Tour(this);
    this.tour.maybeStart();
  }

  // --- Project state ---------------------------------------------------------------------

  items() {
    return [...this.project.brushes, ...this.project.points];
  }

  selected() {
    return this.items().filter((it) => this.selection.has(it.id));
  }

  byId(id) {
    return this.items().find((it) => it.id === id) || null;
  }

  // A shape's pieces with their corners (cached by what makes them).
  outline(br) {
    const key = JSON.stringify([br.b, br.shape, br.yaw, br.up, br.sides, br.step, br.kind, br.tex, br.faces]);
    let o = this.outlines.get(key);
    if (!o) {
      o = piecesOf(br).map((pc) => ({ corners: cornersOf(pc), kind: pc.kind, tex: pieceTex(pc, br) }));
      if (this.outlines.size > 4000) this.outlines.clear();
      this.outlines.set(key, o);
    }
    return o;
  }

  // Bounds of an item: a point's player box, a shape's corners.
  boundsOf(it) {
    if (it.o) {
      const [x, y, z] = it.o;
      return [x - 16, y - 16, z, x + 16, y + 16, z + 72];
    }
    if (!(SHAPES[it.shape]?.turns && it.yaw % 360)) return it.b;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const pc of this.outline(it)) {
      for (const c of pc.corners) {
        for (let k = 0; k < 3; k++) {
          b[k] = Math.min(b[k], c[k]);
          b[k + 3] = Math.max(b[k + 3], c[k]);
        }
      }
    }
    return b;
  }

  colorOf(tex) {
    if (!tex) return '#ddd';
    if (!this.colors.has(tex)) {
      const r = textureRecord(tex);
      this.colors.set(tex, r ? `rgb(${r[0]}, ${r[1]}, ${r[2]})` : tex === 'sky' ? '#9fd3ea' : tex === 'scroll_conv' ? '#333' : '#bbb');
    }
    return this.colors.get(tex);
  }

  select(ids) {
    this.selection = new Set(ids);
    const one = this.selected();
    if (one.length === 1 && one[0].b) this.range = [0, 1, 2].map((k) => [one[0].b[k], one[0].b[k + 3]]);
    this.redraw();
    this.renderProps();
    this.tellPreviewSelection();
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
    this.renderPalette();
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
    this.selection = new Set([...this.selection].filter((id) => this.byId(id)));
    this.changed();
  }

  // --- Making things -------------------------------------------------------------------

  // A new shape from a library card over box b (world), selected.
  addCard(card, b) {
    const c = CARD.get(card) || CARD.get('box');
    const kind = c.kind || 'world';
    const k = KINDS[kind];
    const tex = k.trigger ? { top: null, bottom: null, side: null } : c.tex ? { ...c.tex } : T3(this.texture);
    const br = makeBrush(this.project.nextId++, b, tex, kind, { ...(k.keys || {}), ...(c.keys || {}) }, c.shape || {});
    if (card === 'door' || card === 'swing') br.keys.targetname = '';
    this.project.brushes.push(br);
    return br;
  }

  // A card dropped or clicked at (u, v) in a view: its own size, standing on the floor
  // under it from the top, at the clicked height from the side.
  placeCard(card, ax, u, v) {
    const c = CARD.get(card);
    if (!c) return;
    if (c.point) return this.addPoint(c.point, ax, u, v);
    this.commit();
    const [sx, sy, sz] = c.size;
    const size = [sx, sy, sz];
    const b = [0, 0, 0, 0, 0, 0];
    const center = [0, 0, 0];
    center[ax.u] = u;
    center[ax.v] = v;
    center[ax.w] = Math.round((this.range[ax.w][0] + this.range[ax.w][1]) / 2 / this.grid) * this.grid;
    for (let k = 0; k < 3; k++) {
      b[k] = Math.round((center[k] - size[k] / 2) / this.grid) * this.grid;
      b[k + 3] = b[k] + size[k];
    }
    // Standing on something: from the top, the floor under it; from the side, where clicked.
    const z0 = ax.w === 2 ? this.floorUnder(center[0], center[1]) : Math.round(v / this.grid) * this.grid;
    b[2] = z0;
    b[5] = z0 + sz;
    const br = this.addCard(card, b);
    this.select([br.id]);
    this.setTool('select');
    this.changed();
  }

  // A card drawn as a rectangle in a view: its extent there; from the top its own height on
  // the floor, from the side the depth new shapes take.
  drawCard(card, ax, u0, v0, u1, v1) {
    const c = CARD.get(card);
    if (!c || c.point) return;
    this.commit();
    const b = [0, 0, 0, 0, 0, 0];
    b[ax.u] = u0;
    b[ax.u + 3] = u1;
    b[ax.v] = v0;
    b[ax.v + 3] = v1;
    if (ax.w === 2) {
      b[2] = this.floorUnder((u0 + u1) / 2, (v0 + v1) / 2);
      b[5] = b[2] + c.size[2];
    } else {
      b[ax.w] = this.range[ax.w][0];
      b[ax.w + 3] = this.range[ax.w][1];
    }
    const br = this.addCard(card, b);
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

  // The highest solid top under (x, y) within the working height (`skip`: ignore these ids).
  floorUnder(x, y, below = this.range[2][1], skip = null) {
    let z = null;
    for (const br of this.project.brushes) {
      const k = KINDS[br.kind];
      if (k.trigger || k.water || br.tex.top === 'sky' || (skip && skip.has(br.id))) continue;
      const b = this.boundsOf(br);
      if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && b[5] <= below && (z === null || b[5] > z)) z = b[5];
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

  // Copies of `items` moved by `d` ([dx, dy, dz]), selected.
  insertCopies(items, d) {
    const ids = [];
    for (const it of items) {
      const copy = JSON.parse(JSON.stringify(it));
      copy.id = this.project.nextId++;
      const t = copy.b || copy.o;
      for (let k = 0; k < 3; k++) {
        t[k] += d[k];
        if (copy.b) t[k + 3] += d[k];
      }
      if (copy.b) this.project.brushes.push(makeBrush(copy.id, copy.b, copy.tex, KINDS[copy.kind] ? copy.kind : 'world', copy.keys || {}, copy));
      else if (POINTS[copy.kind]) this.project.points.push(copy);
      ids.push(copy.id);
    }
    this.select(ids);
    this.changed();
  }

  duplicate() {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    this.insertCopies(sel, [this.grid, this.grid, 0]);
  }

  copy() {
    const sel = this.selected();
    if (!sel.length) return;
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(sel));
    } catch { /* clipboard only for this page */ }
    this.clipboard = JSON.stringify(sel);
    this.status(`Copied ${sel.length} item${sel.length > 1 ? 's' : ''}`);
  }

  // Pastes the clipboard: at (u, v) of a view (its center there), else a grid step over.
  paste(ax = null, u = 0, v = 0) {
    let text = this.clipboard;
    try {
      text = localStorage.getItem(CLIP_KEY) || text;
    } catch { /* this page's copy */ }
    if (!text) return;
    let items;
    try {
      items = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(items) || !items.length) return;
    this.commit();
    const d = [this.grid, this.grid, 0];
    if (ax) {
      const b = groupBounds(items.map((it) => this.boundsOf(it)));
      d[ax.u] = Math.round(((u - (b[ax.u] + b[ax.u + 3]) / 2)) / this.grid) * this.grid;
      d[ax.v] = Math.round(((v - (b[ax.v] + b[ax.v + 3]) / 2)) / this.grid) * this.grid;
    }
    this.insertCopies(items, d);
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

  // A quarter turn counter-clockwise (seen from the top) about the selection's center.
  rotate90() {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    const g = groupBounds(sel.map((it) => this.boundsOf(it)));
    const cx = (g[0] + g[3]) / 2, cy = (g[1] + g[4]) / 2;
    const turn = (x, y) => [cx - (y - cy), cy + (x - cx)];
    for (const it of sel) {
      if (it.o) {
        [it.o[0], it.o[1]] = turn(it.o[0], it.o[1]).map(Math.round);
        it.yaw = (it.yaw + 90) % 360;
        continue;
      }
      const b = it.b, [mx, my] = turn((b[0] + b[3]) / 2, (b[1] + b[4]) / 2), hx = (b[4] - b[1]) / 2, hy = (b[3] - b[0]) / 2;
      b[0] = Math.round(mx - hx);
      b[3] = b[0] + hx * 2;
      b[1] = Math.round(my - hy);
      b[4] = b[1] + hy * 2;
      it.up = UPS[(UPS.indexOf(it.up) + 1) % 4];
      if (it.shape === 'convex') it.faces = turnFaces(it.faces);
      if (it.kind === 'func_button' || it.kind === 'func_door') {
        const a = +it.keys.angle;
        if (a >= 0) it.keys.angle = String((a + 90) % 360);
      }
    }
    this.changed();
  }

  // Mirrors the selection east to west about its center.
  mirror() {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    const g = groupBounds(sel.map((it) => this.boundsOf(it)));
    const c2 = g[0] + g[3];
    for (const it of sel) {
      if (it.o) {
        it.o[0] = c2 - it.o[0];
        it.yaw = ((180 - it.yaw) % 360 + 360) % 360;
        continue;
      }
      [it.b[0], it.b[3]] = [c2 - it.b[3], c2 - it.b[0]];
      it.yaw = ((360 - it.yaw) % 360 + 360) % 360;
      if (it.shape === 'convex') it.faces = mirrorFaces(it.faces);
      if (it.up === 'px' || it.up === 'nx') it.up = it.up === 'px' ? 'nx' : 'px';
    }
    this.changed();
  }

  // Drops each selected item onto what is under it.
  dropToFloor() {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    const skip = new Set(sel.map((it) => it.id));
    for (const it of sel) {
      if (it.o) {
        it.o[2] = this.floorUnder(it.o[0], it.o[1], it.o[2] + 1, skip);
        continue;
      }
      const b = this.boundsOf(it);
      let z = null;
      for (const br of this.project.brushes) {
        const k = KINDS[br.kind];
        if (skip.has(br.id) || k.trigger || k.water || br.tex.top === 'sky') continue;
        const o = this.boundsOf(br);
        if (o[0] < b[3] && o[3] > b[0] && o[1] < b[4] && o[4] > b[1] && o[5] <= it.b[2] + 1 && (z === null || o[5] > z)) z = o[5];
      }
      const dz = (z ?? 0) - it.b[2];
      it.b[2] += dz;
      it.b[5] += dz;
    }
    this.changed();
  }

  setShape(shape) {
    const brushes = this.selected().filter((it) => it.b);
    if (!brushes.length) return;
    this.commit();
    for (const b of brushes) {
      b.shape = shape;
      if (KINDS[b.kind].trigger) b.kind = 'world';
      if (b.kind === 'world' && !b.tex.side) Object.assign(b.tex, T3(this.texture));
    }
    this.changed();
  }

  selectSameTexture() {
    const one = this.selected().find((it) => it.b);
    if (!one) return;
    const t = one.tex.side || one.tex.top;
    this.select(this.project.brushes.filter((b) => b.tex.side === t || b.tex.top === t).map((b) => b.id));
  }

  // A measure label tapped in a view: a box to type the number into, over the label.
  editMeasure(view, m) {
    const br = this.selected()[0];
    if (!br || !br.b) return;
    const input = el('input', 'measure');
    input.type = 'number';
    input.value = String(Math.round(m.value));
    input.style.left = `${m.x - 8}px`;
    input.style.top = `${m.y - 3}px`;
    view.el.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      input.remove();
      const val = Math.round(+input.value);
      if (!apply || !Number.isFinite(val)) return;
      this.commit();
      const b = br.b;
      if (m.axis === 'z0') {
        const dz = val - b[2];
        b[2] += dz;
        b[5] += dz;
      } else {
        const k = m.axis, size = Math.max(1, val);
        if (view.turned(br)) { // symmetric about the center (it turns about it)
          const c = (b[k] + b[k + 3]) / 2;
          b[k] = Math.round(c - size / 2);
          b[k + 3] = b[k] + size;
        } else b[k + 3] = b[k] + size;
      }
      this.changed();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // --- Menu ----------------------------------------------------------------------------

  openMenu(cx, cy, view, u, v) {
    this.closeMenu();
    const sel = this.selected();
    const menu = el('div', 'ctxmenu');
    const item = (label, key, fn, enabled = true) => {
      const b = el('button');
      b.append(el('span', '', label), el('kbd', '', keyLabel(key)));
      b.disabled = !enabled;
      b.addEventListener('click', () => {
        this.closeMenu();
        fn();
      });
      menu.append(b);
    };
    const sep = () => menu.append(el('hr'));
    let clip = this.clipboard;
    try {
      clip = localStorage.getItem(CLIP_KEY) || clip;
    } catch { /* this page's copy */ }
    if (sel.length) {
      item('Duplicate', 'Ctrl+D', () => this.duplicate());
      item('Cut', 'Ctrl+X', () => this.cut());
      item('Copy', 'Ctrl+C', () => this.copy());
      item('Paste here', 'Ctrl+V', () => this.paste(view.ax, u, v), !!clip);
      item('Delete', 'Del', () => this.remove());
      sep();
      item('Rotate 90°', 'R', () => this.rotate90());
      item('Mirror', 'M', () => this.mirror());
      item('Drop to floor', 'F', () => this.dropToFloor());
      if (sel.some((it) => it.b)) {
        sep();
        const row = el('div', 'shapes');
        for (const [id, s] of Object.entries(SHAPES)) {
          if (s.made) continue;
          const b = el('button', sel.every((it) => !it.b || it.shape === id) ? 'active' : '', s.label);
          b.addEventListener('click', () => {
            this.closeMenu();
            this.setShape(id);
          });
          row.append(b);
        }
        menu.append(row);
        item('Select same texture', '', () => this.selectSameTexture());
        item('Properties', 'dbl-click', () => this.focusProps());
      }
    } else {
      item('Paste here', 'Ctrl+V', () => this.paste(view.ax, u, v), !!clip);
      for (const card of ['box', 'ramp', 'info_player_deathmatch', 'info_player_start']) {
        item(`Add ${CARD.get(card).label.toLowerCase()} here`, '', () => this.placeCard(card, view.ax, u, v));
      }
      sep();
      item('Select all', 'Ctrl+A', () => this.selectAll(), this.items().length > 0);
      item('Frame everything', 'Home', () => this.fitAll());
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(cx, innerWidth - r.width - 4)}px`;
    menu.style.top = `${Math.min(cy, innerHeight - r.height - 4)}px`;
    this.menu = menu;
  }

  closeMenu() {
    if (this.menu) this.menu.remove();
    this.menu = null;
  }

  // --- Chrome --------------------------------------------------------------------------

  buildChrome() {
    const lib = $('library');
    const selectCard = el('button', 'card', '');
    selectCard.dataset.tool = 'select';
    selectCard.title = 'Select: pick, move and resize shapes';
    selectCard.dataset.keys = 'Esc';
    selectCard.append(svgIcon('M5 3l14 9-6 1-3 6z'), el('span', '', 'Select'));
    selectCard.addEventListener('click', () => this.setTool('select'));
    lib.append(selectCard);
    for (const [i, c] of CARDS.entries()) {
      const b = el('button', 'card');
      b.dataset.tool = c.id;
      b.draggable = true;
      b.title = c.point ? `${c.label}: click in a view` : `${c.label}: drag onto a view, or click it then draw`;
      if (i < 10) b.dataset.keys = String((i + 1) % 10);
      b.append(svgIcon(c.icon), el('span', '', c.label));
      b.addEventListener('click', () => this.setTool(this.tool === c.id ? 'select' : c.id));
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-shape', c.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      lib.append(b);
    }
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
    this.renderPalette();
    const grid = $('grid');
    for (const g of GRIDS) grid.append(new Option(String(g), String(g)));
    grid.addEventListener('change', () => this.setGrid(+grid.value));
    for (const [id, k] of Object.entries(KEYS)) $(id).dataset.keys = keyLabel(k);
    $('new').addEventListener('click', () => this.newMap());
    $('open').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', () => {
      const f = $('file').files[0];
      $('file').value = '';
      if (f) this.openFile(f);
    });
    // The example: de_inkwell, our own defusal map (tools/gen_inkwell.js writes it).
    $('example').addEventListener('click', () => {
      if (!confirm('Open the example map, de_inkwell? Save this one first if you want to keep it.')) return;
      this.openText('de_inkwell', async () => {
        const r = await fetch('/maps/de_inkwell.cmap.json');
        if (!r.ok) throw new Error(`not found (${r.status})`);
        return r.text();
      });
    });
    $('save').addEventListener('click', () => {
      this.download(new Blob([JSON.stringify(this.project, null, 1)], { type: 'application/json' }), `${this.project.name}.cmap.json`);
    });
    $('undo').addEventListener('click', () => this.undo());
    $('redo').addEventListener('click', () => this.undo(true));
    $('export').addEventListener('click', () => this.exportBsp());
    $('try').addEventListener('click', () => this.play());
    $('layout').addEventListener('click', () => this.setLayout(this.layout === 'simple' ? 'four' : 'simple'));
    $('help').addEventListener('click', () => this.tour.start());
    for (const v of this.views) {
      v.el.querySelector('.label').addEventListener('dblclick', () => {
        v.el.classList.toggle('max');
        this.redraw();
      });
    }
    addEventListener('keydown', (e) => this.key(e));
    addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
    addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target)) this.closeMenu();
    });
    let layout = 'simple';
    try {
      layout = localStorage.getItem(LAYOUT_KEY) || layout;
    } catch { /* default */ }
    this.setLayout(layout);
    this.refreshChrome();
    installTips();
  }

  newMap() {
    if (!confirm('Start a new map? Save this one first if you want to keep it.')) return;
    this.commit();
    this.project = newProject();
    this.selection.clear();
    this.changed();
    this.fitAll();
  }

  selectAll() {
    this.select(this.items().map((it) => it.id));
  }

  cut() {
    if (!this.selection.size) return;
    this.copy();
    this.remove();
  }

  setLayout(layout) {
    this.layout = layout;
    $('views').classList.toggle('simple', layout === 'simple');
    $('layout').textContent = layout === 'simple' ? 'Advanced view' : 'Simple view';
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch { /* not kept */ }
    requestAnimationFrame(() => this.redraw());
  }

  refreshChrome() {
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === this.tool);
    for (const b of document.querySelectorAll('[data-slot]')) b.classList.toggle('active', b.dataset.slot === this.slot);
    for (const b of document.querySelectorAll('[data-tex]')) b.classList.toggle('active', b.dataset.tex === this.texture);
    $('grid').value = String(this.grid);
    $('undo').disabled = !this.undoStack.length;
    $('redo').disabled = !this.redoStack.length;
  }

  setTool(t) {
    this.tool = t;
    this.refreshChrome();
    const c = CARD.get(t);
    if (c) this.status(c.point ? `${c.label}: click where it stands` : `${c.label}: draw it in a view, or click for its own size`);
  }

  setGrid(g) {
    this.grid = g;
    this.refreshChrome();
    this.redraw();
  }

  // A texture: on the chosen faces of the selected shapes, and for new ones.
  paint(name) {
    this.texture = name;
    const brushes = this.selected().filter((it) => it.b && !KINDS[it.kind].trigger);
    if (brushes.length) {
      this.commit();
      for (const b of brushes) {
        for (const s of this.slot === 'all' ? ['top', 'bottom', 'side'] : [this.slot]) {
          if (KINDS[b.kind].water && s !== 'top') continue;
          this.texFaces(b, s, name);
        }
      }
      this.changed();
    }
    this.refreshChrome();
  }

  // Texture `name` on slot s (top, bottom, side) of brush b: a convex piece's faces turned
  // that way too.
  texFaces(b, s, name) {
    b.tex[s] = name;
    if (b.shape !== 'convex') return;
    const z = [b.b[3] - b.b[0], b.b[4] - b.b[1], b.b[5] - b.b[2]]; // faces are in the box's own units
    for (const f of b.faces) if (slotOf([f[0] / z[0], f[1] / z[1], f[2] / z[2]]) === s) f[4] = name;
  }

  // The textures to pick from: the palette's, then the opened map's own.
  textureChoices() {
    return [...TEXTURES.map(([name, , , label]) => [name, label]), ...Object.keys(this.project.textures || {}).map((n) => [n, n])];
  }

  // The palette: the editor's textures, then (under its own heading) the project's own,
  // rebuilt when those change.
  renderPalette() {
    const own = Object.keys(this.project.textures || {}).sort();
    const key = own.join();
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const pal = $('palette');
    pal.replaceChildren();
    const add = (name, label) => {
      const b = el('button');
      b.dataset.tex = name;
      b.title = name;
      const sw = el('span', 'swatch');
      sw.style.background = this.colorOf(name);
      b.append(sw, el('span', '', label));
      b.addEventListener('click', () => this.paint(name));
      pal.append(b);
    };
    for (const [name, , , label] of TEXTURES) add(name, label);
    if (own.length) pal.append(el('h3', '', 'This map\'s textures'));
    for (const name of own) add(name, name);
    this.refreshChrome();
  }

  // A key: from this page, or from the 3D view's (forwarded as 'preview-key').
  key(e) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    const card = /^[0-9]$/.test(k) ? CARDS[(+k + 9) % 10] : null;
    let used = true;
    if (ctrl && lk === 'z') this.undo(e.shiftKey);
    else if (ctrl && lk === 'y') this.undo(true);
    else if (ctrl && lk === 'd') this.duplicate();
    else if (ctrl && lk === 'c') this.copy();
    else if (ctrl && lk === 'x') this.cut();
    else if (ctrl && lk === 'v') this.paste();
    else if (ctrl && lk === 'a') this.selectAll();
    else if (ctrl && lk === 's') $('save').click();
    else if (ctrl && lk === 'o') $('open').click();
    else if (ctrl && lk === 'e') this.exportBsp();
    else if (ctrl && k === 'Enter') this.play();
    else if (ctrl) used = false;
    else if (e.altKey && lk === 'n') this.newMap();
    else if (card && !e.altKey) this.setTool(this.tool === card.id ? 'select' : card.id);
    else if (lk === 'l') this.setLayout(this.layout === 'simple' ? 'four' : 'simple');
    else if (k === 'Delete' || k === 'Backspace') this.remove();
    else if (k === 'Escape') {
      this.closeMenu();
      if (this.tool !== 'select') this.setTool('select');
      else this.select([]);
    } else if (k === '[') this.setGrid(GRIDS[Math.max(0, GRIDS.indexOf(this.grid) - 1)]);
    else if (k === ']') this.setGrid(GRIDS[Math.min(GRIDS.length - 1, GRIDS.indexOf(this.grid) + 1)]);
    else if (k === 'ArrowLeft') this.nudge(0, -this.grid);
    else if (k === 'ArrowRight') this.nudge(0, this.grid);
    else if (k === 'ArrowUp') this.nudge(1, this.grid);
    else if (k === 'ArrowDown') this.nudge(1, -this.grid);
    else if (k === 'PageUp') this.nudge(2, this.grid);
    else if (k === 'PageDown') this.nudge(2, -this.grid);
    else if (k === 'q' || k === 'e') this.turn(k === 'q' ? 15 : -15);
    else if (k === 'r') this.rotate90();
    else if (k === 'm') this.mirror();
    else if (k === 'f') this.dropToFloor();
    else if (k === 'Home') this.fitAll();
    else if (k === '?') this.tour.start();
    else if (e.code === 'Space') this.spaceHeld = true;
    else used = false;
    if (used) e.preventDefault();
  }

  // Q / E: turns spawns and turnable shapes 15° (shapes rising toward a side: a quarter).
  turn(deg) {
    const sel = this.selected();
    if (!sel.length) return;
    this.commit();
    for (const it of sel) {
      if (it.o || SHAPES[it.shape].turns) it.yaw = ((it.yaw + deg) % 360 + 360) % 360;
    }
    this.changed();
  }

  hoverStatus(it) {
    if (!it) return this.status('');
    if (it.o) return this.status(`${POINTS[it.kind].label} · facing ${it.yaw}°`);
    const b = it.b;
    const size = `${b[3] - b[0]} × ${b[4] - b[1]} × ${b[5] - b[2]}`;
    const what = it.kind === 'world' ? SHAPES[it.shape].label : `${KINDS[it.kind].label} (${SHAPES[it.shape].label.toLowerCase()})`;
    const more = SHAPES[it.shape].rises ? ` · rising ${UP_LABELS[it.up]}` : it.yaw ? ` · turned ${it.yaw}°` : '';
    this.status(`${what} · ${size}${more}${it.shape === 'ramp' ? ` · ${Math.round(slopeOf(it))}°` : ''}`);
  }

  // --- Panels --------------------------------------------------------------------------

  focusProps() {
    const first = $('props').querySelector('input, select');
    if (first) first.focus();
  }

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
    const choice = (label, options, value, set) => {
      const l = el('label');
      const s = el('select');
      for (const [v, t] of options) s.append(new Option(t, String(v)));
      s.value = String(value);
      s.addEventListener('change', () => {
        this.commit();
        set(s.value);
        this.changed();
      });
      l.append(el('span', '', label), s);
      box.append(l);
      return s;
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
      box.append(el('p', 'muted', `${this.project.brushes.length} shapes, ${this.project.points.length} points, ` +
        `${b[3] - b[0]} × ${b[4] - b[1]} × ${b[5] - b[2]} units. The map is closed in a sky box round everything.`));
      box.append(el('p', 'muted', 'A player is 32 units wide and 72 tall (36 crouched); steps up to 18 are walked up, ' +
        `ramps up to ${MAX_SLOPE}°; a crouch jump reaches 64.`));
      return;
    }
    if (sel.length > 1) {
      box.append(el('h3', '', `${sel.length} selected`));
      const row = el('div', 'buttons');
      for (const [label, fn] of [['Rotate 90°', () => this.rotate90()], ['Mirror', () => this.mirror()],
        ['Drop to floor', () => this.dropToFloor()], ['Delete', () => this.remove()]]) {
        const b = el('button', '', label);
        b.addEventListener('click', fn);
        row.append(b);
      }
      box.append(row);
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
    const shape = SHAPES[it.shape];
    box.append(el('h3', '', it.kind === 'world' ? shape.label : KINDS[it.kind].label));
    choice('Kind', Object.entries(KINDS).map(([id, k]) => [id, k.label]), it.kind, (v) => {
      it.kind = v;
      it.keys = { ...KINDS[v].keys, ...it.keys };
      const k = KINDS[v];
      if (k.trigger) {
        it.tex = { top: null, bottom: null, side: null };
        it.shape = 'box';
        it.yaw = 0;
      } else if (k.water) it.tex = { top: it.tex.top || '!watergreen', bottom: null, side: null };
      else for (const s of ['top', 'bottom', 'side']) it.tex[s] = it.tex[s] || this.texture;
    });
    if (!KINDS[it.kind].trigger) {
      choice('Shape', Object.entries(SHAPES).filter(([id, s]) => !s.made || id === it.shape).map(([id, s]) => [id, s.label]), it.shape, (v) => {
        it.shape = v;
      });
    }
    numbers('From (x y z)', it.b.slice(0, 3), (k, v) => {
      it.b[k] = Math.min(v, it.b[k + 3] - 1);
    });
    numbers('Size (x y z)', [0, 1, 2].map((k) => it.b[k + 3] - it.b[k]), (k, v) => {
      it.b[k + 3] = it.b[k] + Math.max(1, v);
    });
    if (shape.turns && !KINDS[it.kind].trigger) {
      field('Turned', it.yaw, (v) => {
        it.yaw = ((Math.round(+v) || 0) % 360 + 360) % 360;
      }, 'number');
    }
    if (shape.rises) {
      choice(it.shape === 'ladder' ? 'Wall at' : 'Rises to', UPS.map((u) => [u, UP_LABELS[u]]), it.up, (v) => {
        it.up = v;
      });
    }
    if (it.shape === 'pillar') choice('Sides', SIDE_COUNTS.map((n) => [n, String(n)]), it.sides, (v) => {
      it.sides = +v;
    });
    if (it.shape === 'stairs') {
      field('Step', it.step, (v) => {
        it.step = Math.max(4, Math.min(64, Math.round(+v) || 16));
      }, 'number');
    }
    if (it.shape === 'ramp') box.append(el('p', 'help', `Slope ${Math.round(slopeOf(it))}° (walkable up to ${MAX_SLOPE}°).`));
    const kind = KINDS[it.kind];
    if (!kind.trigger && it.shape !== 'ladder') {
      for (const s of kind.water ? ['top'] : ['top', 'side', 'bottom']) {
        choice(s === 'side' ? 'Sides' : s[0].toUpperCase() + s.slice(1),
          [['', '(none)'], ...this.textureChoices()], it.tex[s] || '', (v) => {
            this.texFaces(it, s, v || null);
          });
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

  // Replaces the project with one read from text() (a file, the example), undoably.
  async openText(name, text) {
    try {
      const p = readProject(await text());
      this.commit();
      this.project = p;
      this.selection.clear();
      this.changed();
      this.fitAll();
      this.status(`Opened ${name}`);
    } catch (err) {
      this.status(`${name}: ${err.message}`, true);
    }
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
    this.toPreview({ type: 'preview-map', name: this.project.name, bytes: r.bytes }, [r.bytes]);
    this.tellPreviewShapes();
  }

  toPreview(msg, transfer = []) {
    const w = $('preview').contentWindow;
    if (w) w.postMessage(msg, location.origin, transfer);
  }

  // The 3D view picks and drags shapes itself: it gets their outlines (convex corner sets)
  // and the selection.
  tellPreviewShapes() {
    if (!this.previewReady) return;
    const shapes = this.items().map((it) => {
      const brushes = it.o ? [box(...this.boundsOf(it), T3('x'))] : piecesOf(it).map((pc) => pc.brush);
      return {
        id: it.id, zone: !!it.b && !!(KINDS[it.kind].trigger || KINDS[it.kind].water),
        pieces: brushes.map((br) => {
          const planes = brushPlanes(br);
          return { planes: planes.map((p) => [p.n[0], p.n[1], p.n[2], p.d]), polys: brushPolygons(planes) };
        }),
      };
    });
    this.toPreview({ type: 'preview-shapes', shapes });
    this.tellPreviewSelection();
  }

  tellPreviewSelection() {
    if (this.previewReady) this.toPreview({ type: 'preview-select', ids: [...this.selection], grid: this.grid });
  }

  // The compiled map, carrying its project (withProject: the editor opens it again exactly).
  async exportBsp() {
    this.status('Compiling...');
    const r = await this.compile('full');
    if (r.error) return this.status(r.error, true);
    const bytes = await withProject(new Uint8Array(r.bytes), this.project);
    this.download(new Blob([bytes], { type: 'application/octet-stream' }), `${this.project.name}.bsp`);
    this.status(`Exported ${this.project.name}.bsp (${Math.round(bytes.length / 1024)} KB)`);
  }

  // A file picked with Open: a project (.cmap.json), or a map (.bsp, version 30): one the
  // editor exported opens as its project, any other is decompiled in the worker.
  async openFile(f) {
    const buf = await f.arrayBuffer();
    if (buf.byteLength < 4 || new DataView(buf).getInt32(0, true) !== 30) return this.openText(f.name, () => new TextDecoder().decode(buf));
    const own = await projectIn(new Uint8Array(buf));
    if (own) return this.openText(f.name, () => own);
    this.status(`Opening ${f.name}...`);
    const id = ++this.jobId;
    const r = await new Promise((resolve) => {
      this.jobs.set(id, resolve);
      this.worker.postMessage({ id, open: buf, name: f.name }, [buf]);
    });
    if (r.error) return this.status(`${f.name}: ${r.error}`, true);
    await this.openText(f.name, () => r.project);
    const left = Object.entries(r.report.dropped).sort((a, b) => b[1] - a[1]);
    const count = left.reduce((n, [, k]) => n + k, 0);
    this.status(`Opened ${f.name}: ${r.report.shapes} shapes, ${r.report.points} points` +
      (count ? `; left out ${count} entities the editor does not make (${left.slice(0, 4).map(([c]) => c).join(', ')}${left.length > 4 ? ', ...' : ''})` : ''));
  }

  // Hands the map over and opens the game in a new tab, which takes it (client/handoff.js).
  async play() {
    this.status('Compiling...');
    const r = await this.compile('full');
    if (r.error) return this.status(r.error, true);
    try {
      await putHandoff({
        name: this.project.name, bytes: r.bytes, mode: 'demo', players: 0, difficulty: 1, team: +$('team').value,
      });
    } catch (err) {
      return this.status(`Could not hand the map over: ${err.message}`, true);
    }
    if (!open('/?fromeditor', '_blank')) return this.status('The browser blocked the new tab: allow pop-ups for this site', true);
    this.status('Trying it in a new tab');
  }

  message(e) {
    if (e.origin !== location.origin || e.source !== $('preview').contentWindow) return;
    const m = e.data;
    if (!m) return;
    if (m.type === 'preview-ready') {
      this.previewReady = true;
      this.updatePreview();
    } else if (m.type === 'preview-pick') {
      if (m.id === null) this.select([]);
      else if (m.add) this.toggle(m.id);
      else this.select([m.id]);
    } else if (m.type === 'preview-key') {
      this.key({ key: m.key, code: m.code, ctrlKey: m.ctrl, metaKey: false, shiftKey: m.shift, altKey: m.alt, target: null,
        preventDefault() {} });
    } else if (m.type === 'preview-move') { // dragged in the 3D view: by whole grid steps from where it began
      if (m.phase === 'start') {
        this.drag3d = this.selected().map((it) => [it, (it.b || it.o).slice()]);
        this.commit();
      }
      if (!this.drag3d) return;
      const d = m.delta.map((x) => Math.round(x / this.grid) * this.grid);
      for (const [it, o] of this.drag3d) {
        const t = it.b || it.o;
        for (let k = 0; k < 3; k++) {
          t[k] = o[k] + d[k];
          if (it.b) t[k + 3] = o[k + 3] + d[k];
        }
      }
      if (m.phase === 'end') {
        this.drag3d = null;
        this.changed(true);
      } else this.changed(false);
    }
  }
}

// The textures a piece shows in the 2D views (a ladder's board its ladder).
function pieceTex(pc, br) {
  if (br.shape === 'ladder' && pc.kind === 'world') return { top: '{ladder1', side: '{ladder1', bottom: null };
  return br.tex;
}

function groupBounds(list) {
  const g = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of list) for (let k = 0; k < 3; k++) (g[k] = Math.min(g[k], b[k])), (g[k + 3] = Math.max(g[k + 3], b[k + 3]));
  return g;
}

// Tips: a control with a title (or a shortcut, data-keys) shows it in an ink caption under
// it once the mouse rests there, the shortcut as keys; the browser's own tooltip is held
// back (the title moves to data-tip).
function installTips() {
  const tip = el('div', 'tip');
  document.body.append(tip);
  let target = null, timer = 0;
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('show');
    target = null;
  };
  const show = (t) => {
    if (!t.isConnected) return;
    tip.replaceChildren();
    if (t.dataset.tip) tip.append(el('span', '', t.dataset.tip));
    if (t.dataset.keys) {
      const keys = el('span', 'tipkeys');
      t.dataset.keys.split('|').forEach((alt, i) => {
        if (i) keys.append(' or ');
        alt.split(/\+(?=.)/).forEach((part, j) => {
          if (j) keys.append('+');
          keys.append(el('kbd', '', part));
        });
      });
      tip.append(keys);
    }
    const r = t.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const below = r.bottom + 6 + h < innerHeight;
    tip.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - h - 6}px`;
    tip.classList.add('show');
  };
  addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = e.target instanceof Element ? e.target.closest('[title], [data-tip], [data-keys]') : null;
    if (t === target) return;
    hide();
    if (!t) return;
    if (t.title) {
      t.dataset.tip = t.title;
      t.setAttribute('aria-description', t.title);
      t.removeAttribute('title');
    }
    target = t;
    timer = setTimeout(() => show(t), 350);
  });
  addEventListener('pointerdown', hide, true);
  addEventListener('keydown', hide, true);
  addEventListener('blur', hide);
}

globalThis.editor = new Editor();
