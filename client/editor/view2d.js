// One of the map editor's 2D views: top (x, y), front (x, z) or side (y, z), on a
// Canvas2D. Draws the grid, every shape by its real outline (a ramp's triangle from the
// side, a turned wall's diamond from the top) in its texture colors, zones and volumes as
// hatched tints, the points, and the selection with its handles, rotation knob and
// measures; turns mouse, pen and touch into edits through the editor (`app`): pick,
// move, resize (snapping to the grid and to other shapes' edges; Alt for neither), turn,
// draw or place a shape, tap a measure to type it, right-click / long-press for the menu,
// wheel / pinch to zoom, right or middle drag / two fingers to pan, drop a library card.

import { KINDS, POINTS, SHAPES } from './project.js';

// Screen axes per view: [horizontal, vertical] world axes; the hidden one, and which way
// is nearer the viewer (drawn last).
const AXES = {
  top: { u: 0, v: 1, w: 2, near: 1 }, // looking down: higher is nearer
  front: { u: 0, v: 2, w: 1, near: -1 }, // looking north from the south: smaller y nearer
  side: { u: 1, v: 2, w: 0, near: -1 }, // looking east from the west: smaller x nearer
};
const ZONE_COLORS = {
  func_buyzone: '#3c9a4a', func_bomb_target: '#e2402a', func_ladder: '#e08a1e', func_water: '#2f6fc4',
  func_hostage_rescue: '#2f9fc4',
};
const HANDLE = 5; // px, half size
const PICK = 4; // px of slack when picking
const SNAP_PX = 8; // px within which an edge snaps to another shape's edge
const KNOB = 26; // px from the shape to its rotation knob
const LONG_PRESS = 550; // ms

// The convex hull of 2D points (monotone chain), counter-clockwise.
function hull2d(pts) {
  // Corners shared by several faces come back a hair apart: one point each (to 1/100 px).
  const seen = new Set(), p = [];
  for (const [x, y] of pts) {
    const q = [Math.round(x * 100) / 100, Math.round(y * 100) / 100], key = `${q[0]},${q[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      p.push(q);
    }
  }
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function inPolygon(poly, x, y, slack = 0) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  if (inside || !slack) return inside;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { // near an edge
    const [x0, y0] = poly[j], [x1, y1] = poly[i], dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2));
    if (Math.hypot(x0 + dx * t - x, y0 + dy * t - y) <= slack) return true;
  }
  return false;
}

// A solid shape wearing only sky (an opened map's sky brushes).
const skyOnly = (br) => br.kind === 'world' && (br.tex.top || br.tex.side || br.tex.bottom) === 'sky' &&
  ['top', 'side', 'bottom'].every((s) => !br.tex[s] || br.tex[s] === 'sky');

export class View2D {
  constructor(el, name, app) {
    this.el = el;
    this.name = name;
    this.app = app;
    this.ax = AXES[name];
    this.canvas = el.querySelector('canvas');
    this.coords = el.querySelector('.coords');
    this.ctx = this.canvas.getContext('2d');
    this.cu = 0; // world point at the canvas center
    this.cv = 0;
    this.scale = 0.25; // px per unit
    this.drag = null; // the gesture under way
    this.fitBox = null; // what fit() framed, until the user pans or zooms
    this.userMoved = false;
    this.mouse = null; // last pointer position on the canvas [x, y]
    this.hover = null; // the item under the pointer
    this.guides = []; // snap lines to draw: ['u' | 'v', world value]
    this.measures = []; // tappable measure labels: { x, y, w, h, axis, value }
    this.touches = new Map(); // touch pointers: id -> [x, y]
    this.pinch = null;
    this.dirty = true;
    new ResizeObserver(() => {
      const r = el.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (this.fitBox && !this.userMoved) this.fit(this.fitBox); // framed before the canvas had its size
      this.dirty = true;
    }).observe(el);
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.coords.textContent = '';
      if (this.hover) {
        this.hover = null;
        this.dirty = true;
      }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.local(e);
      this.zoomAt(x, y, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const [x, y] = this.local(e);
      const hit = this.pick(x, y);
      if (hit) this.app.focusProps();
    });
    // Library cards dragged in: a shape dropped where they land.
    c.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/x-shape')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    c.addEventListener('drop', (e) => {
      const card = e.dataTransfer.getData('text/x-shape');
      if (!card) return;
      e.preventDefault();
      const [x, y] = this.local(e);
      const [u, v] = this.toWorld(x, y);
      this.app.placeCard(card, this.ax, this.snap(u), this.snap(v));
    });
  }

  get w() {
    return this.canvas.width / (devicePixelRatio || 1);
  }

  get h() {
    return this.canvas.height / (devicePixelRatio || 1);
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  toScreen(u, v) {
    return [(u - this.cu) * this.scale + this.w / 2, this.h / 2 - (v - this.cv) * this.scale];
  }

  toWorld(x, y) {
    return [(x - this.w / 2) / this.scale + this.cu, (this.h / 2 - y) / this.scale + this.cv];
  }

  zoomAt(x, y, f) {
    const [u, v] = this.toWorld(x, y);
    this.userMoved = true;
    this.scale = Math.min(8, Math.max(0.01, this.scale * f));
    const [u2, v2] = this.toWorld(x, y); // keep the point under the pointer
    this.cu += u - u2;
    this.cv += v - v2;
    this.dirty = true;
  }

  // Frames [x0, y0, z0, x1, y1, z1].
  fit(b) {
    this.fitBox = b;
    this.userMoved = false;
    const { u, v } = this.ax;
    const du = Math.max(64, b[u + 3] - b[u]), dv = Math.max(64, b[v + 3] - b[v]);
    this.cu = (b[u] + b[u + 3]) / 2;
    this.cv = (b[v] + b[v + 3]) / 2;
    this.scale = Math.min(this.w / du, this.h / dv) * 0.85 || 0.25;
    this.dirty = true;
  }

  snap(x) {
    const g = this.app.grid;
    return Math.round(x / g) * g;
  }

  // An item's outline pieces on this view: [{ poly (screen points), kind, tex, near }].
  shapes(it) {
    const { u, v, w, near } = this.ax;
    if (it.o) {
      const b = this.app.boundsOf(it);
      const [x0, y1] = this.toScreen(b[u], b[v]), [x1, y0] = this.toScreen(b[u + 3], b[v + 3]);
      return [{ poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], kind: 'point', near: near > 0 ? b[w + 3] : -b[w] }];
    }
    return this.app.outline(it).map((pc) => {
      let n = -Infinity;
      for (const c of pc.corners) n = Math.max(n, near > 0 ? c[w] : -c[w]);
      return { poly: hull2d(pc.corners.map((c) => this.toScreen(c[u], c[v]))), kind: pc.kind, tex: pc.tex, near: n };
    });
  }

  // --- Drawing -------------------------------------------------------------------------

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.ctx, dpr = devicePixelRatio || 1, W = this.w, H = this.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fffaf0';
    ctx.fillRect(0, 0, W, H);
    this.drawGrid();
    const app = this.app, p = app.project;
    const drawn = p.brushes.map((br) => ({ br, pieces: this.shapes(br) }));
    for (const d of drawn) d.near = Math.max(...d.pieces.map((pc) => pc.near));
    drawn.sort((a, b) => a.near - b.near); // farther first
    for (const { br, pieces } of drawn) {
      for (const pc of pieces) this.drawPiece(br, pc);
      if (br.kind !== 'world' || (br.shape !== 'box' && br.shape !== 'convex')) this.drawLabel(br, pieces);
    }
    for (const q of p.points) this.drawPoint(q);
    if (this.hover && !app.selection.has(this.hover.id)) {
      ctx.strokeStyle = '#2f6fc4';
      ctx.lineWidth = 2;
      for (const pc of this.shapes(this.hover)) this.path(pc.poly), ctx.stroke();
    }
    ctx.strokeStyle = '#e2402a';
    ctx.lineWidth = 2.5;
    const sel = app.selected();
    for (const it of sel) for (const pc of this.shapes(it)) this.path(pc.poly), ctx.stroke();
    this.measures = [];
    if (sel.length === 1 && sel[0].b) this.drawHandles(sel[0]);
    // Snap guides.
    ctx.strokeStyle = '#e2402a';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const [axis, val] of this.guides) {
      ctx.beginPath();
      if (axis === 'u') {
        const x = this.toScreen(val, 0)[0];
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      } else {
        const y = this.toScreen(0, val)[1];
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // The rubber band or the shape being drawn.
    const d = this.drag;
    if (d && (d.type === 'band' || d.type === 'create') && d.cur) {
      const [ax, ay] = this.toScreen(d.u0, d.v0), [bx, by] = this.toScreen(d.cur[0], d.cur[1]);
      ctx.setLineDash(d.type === 'band' ? [4, 3] : []);
      ctx.strokeStyle = d.type === 'band' ? '#2f6fc4' : '#e2402a';
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
      if (d.type === 'create') {
        ctx.fillStyle = '#17130f';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(`${Math.abs(d.cur[0] - d.u0)} × ${Math.abs(d.cur[1] - d.v0)}`, Math.max(ax, bx) + 6, Math.min(ay, by) - 4);
      }
    }
  }

  path(poly) {
    const ctx = this.ctx;
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  drawPiece(br, pc) {
    const ctx = this.ctx;
    const kind = KINDS[pc.kind];
    this.path(pc.poly);
    if (skyOnly(br)) { // an opened map's sky: an outline, so it hides nothing under it
      ctx.strokeStyle = '#6fb3d6';
      ctx.setLineDash([2, 4]);
    } else if (kind.trigger || kind.water) {
      const col = ZONE_COLORS[pc.kind] || '#888';
      ctx.fillStyle = col + '33';
      ctx.fill();
      ctx.save();
      ctx.clip();
      const xs = pc.poly.map((q) => q[0]), ys = pc.poly.map((q) => q[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      ctx.strokeStyle = col + '66';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = -(y1 - y0); k < x1 - x0; k += 10) {
        ctx.moveTo(x0 + k, y1);
        ctx.lineTo(x0 + k + (y1 - y0), y0);
      }
      ctx.stroke();
      ctx.restore();
      this.path(pc.poly);
      ctx.strokeStyle = col;
      ctx.setLineDash([5, 3]);
    } else {
      const t = pc.tex || {};
      const tex = this.name === 'top' ? t.top || t.side : t.side || t.top;
      ctx.fillStyle = this.app.colorOf(tex);
      ctx.fill();
      ctx.strokeStyle = '#17130f';
      ctx.setLineDash(br.kind === 'world' ? [] : [6, 3]);
    }
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // A shape's name inside it when there is room (entities, and shapes other than boxes).
  drawLabel(br, pieces) {
    const xs = pieces.flatMap((pc) => pc.poly.map((q) => q[0])), ys = pieces.flatMap((pc) => pc.poly.map((q) => q[1]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 - x0 < 44 || y1 - y0 < 14) return;
    const ctx = this.ctx;
    ctx.fillStyle = '#17130f';
    ctx.font = '11px sans-serif';
    const name = br.kind === 'world' ? SHAPES[br.shape].label : KINDS[br.kind].label;
    ctx.fillText(name, x0 + 4, y0 + 12, x1 - x0 - 8);
  }

  drawGrid() {
    const ctx = this.ctx, W = this.w, H = this.h;
    let g = this.app.grid;
    while (g * this.scale < 8) g *= 2;
    const [u0, v1] = this.toWorld(0, 0), [u1, v0] = this.toWorld(W, H);
    ctx.lineWidth = 1;
    const lines = (step, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let a = Math.ceil(u0 / step) * step; a <= u1; a += step) {
        const x = Math.round(this.toScreen(a, 0)[0]) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let a = Math.ceil(v0 / step) * step; a <= v1; a += step) {
        const y = Math.round(this.toScreen(0, a)[1]) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
    };
    lines(g, '#eee4cf');
    lines(Math.max(g * 8, 1024), '#d9cbb0');
    const [ox, oy] = this.toScreen(0, 0);
    ctx.strokeStyle = '#b8a888';
    ctx.beginPath();
    ctx.moveTo(Math.round(ox) + 0.5, 0);
    ctx.lineTo(Math.round(ox) + 0.5, H);
    ctx.moveTo(0, Math.round(oy) + 0.5);
    ctx.lineTo(W, Math.round(oy) + 0.5);
    ctx.stroke();
  }

  drawPoint(q) {
    const ctx = this.ctx, { u, v } = this.ax;
    const top = this.name === 'top';
    const cu = q.o[u], cv = top ? q.o[v] : q.o[v] + 36;
    const [x, y] = this.toScreen(cu, cv);
    const color = q.kind === 'info_player_deathmatch' ? '#e2402a' : q.kind === 'info_player_start' ? '#2f6fc4' : '#3c9a4a';
    ctx.fillStyle = color;
    ctx.strokeStyle = '#17130f';
    ctx.lineWidth = 1.5;
    if (top) {
      const r = Math.max(6, 16 * this.scale);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const a = q.yaw * Math.PI / 180; // the way it faces
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * r * 1.8, y - Math.sin(a) * r * 1.8);
      ctx.stroke();
    } else {
      const hw = Math.max(5, 16 * this.scale), hh = Math.max(10, 36 * this.scale);
      ctx.fillRect(x - hw, y - hh, hw * 2, hh * 2);
      ctx.strokeRect(x - hw, y - hh, hw * 2, hh * 2);
    }
    ctx.fillStyle = '#fffaf0';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(POINTS[q.kind].mark, x, y);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // Is the brush turned in this view (resized and measured along its own axes)?
  turned(br) {
    return this.name === 'top' && SHAPES[br.shape].turns && br.yaw % 360 !== 0;
  }

  // A point of the brush's own frame (local u, v about its center) on screen, in this view.
  frame(br) {
    const { u, v } = this.ax, b = br.b;
    const cu = (b[u] + b[u + 3]) / 2, cv = (b[v] + b[v + 3]) / 2;
    const a = this.turned(br) ? br.yaw * Math.PI / 180 : 0, c = Math.cos(a), s = Math.sin(a);
    return {
      cu, cv, hu: (b[u + 3] - b[u]) / 2, hv: (b[v + 3] - b[v]) / 2, c, s,
      at: (lu, lv) => this.toScreen(cu + lu * c - lv * s, cv + lu * s + lv * c),
      toLocal: (wu, wv) => [(wu - cu) * c + (wv - cv) * s, -(wu - cu) * s + (wv - cv) * c],
    };
  }

  // Handles: [x, y, du, dv] (which sides they move: -1, 0, 1), in the brush's own frame.
  handles(br) {
    const f = this.frame(br);
    const turnedSide = !this.turned(br) && SHAPES[br.shape].turns && br.yaw % 360 && this.name !== 'top';
    const out = [];
    for (const du of [-1, 0, 1]) {
      for (const dv of [-1, 0, 1]) {
        if (!du && !dv) continue;
        if (turnedSide && du) continue; // a turned shape seen from the side: its height only
        const [x, y] = f.at(du * f.hu, dv * f.hv);
        out.push([x, y, du, dv]);
      }
    }
    return out;
  }

  knob(br) {
    if (this.name !== 'top' || !SHAPES[br.shape].turns) return null;
    const f = this.frame(br);
    return f.at(0, f.hv + KNOB / this.scale);
  }

  drawHandles(br) {
    const ctx = this.ctx;
    ctx.fillStyle = '#ffd23a';
    ctx.strokeStyle = '#17130f';
    ctx.lineWidth = 1.5;
    for (const [hx, hy] of this.handles(br)) {
      ctx.fillRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
      ctx.strokeRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
    }
    const k = this.knob(br);
    if (k) {
      const f = this.frame(br), [ex, ey] = f.at(0, f.hv);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(k[0], k[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(k[0], k[1], 7, 0, Math.PI * 2);
      ctx.fillStyle = '#2f6fc4';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#17130f';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${Math.round(((br.yaw % 360) + 360) % 360)}°`, k[0] + 10, k[1] + 4);
    }
    // Measures: the width under the shape, the height beside it; from the side its
    // elevation too. Tapping one types it.
    const f = this.frame(br);
    const { u, v } = this.ax;
    const label = (text, x, y, axis, value) => {
      ctx.font = 'bold 12px sans-serif';
      const w = ctx.measureText(text).width + 10, h = 18;
      ctx.fillStyle = '#17130f';
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      ctx.fillStyle = '#ffd23a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      this.measures.push({ x: x - w / 2, y: y - h / 2, w, h, axis, value });
    };
    const corners = [f.at(-f.hu, -f.hv), f.at(f.hu, -f.hv), f.at(f.hu, f.hv), f.at(-f.hu, f.hv)];
    const below = Math.max(...corners.map((q) => q[1])), right = Math.max(...corners.map((q) => q[0]));
    const [mx, my] = f.at(0, 0);
    const sideTurned = this.name !== 'top' && SHAPES[br.shape].turns && br.yaw % 360; // its width is not this one
    if (!sideTurned) label(String(Math.round(f.hu * 2)), mx, below + 16, u, f.hu * 2);
    label(String(Math.round(f.hv * 2)), right + 24, my, v, f.hv * 2);
    if (v === 2) label(`↑ ${br.b[2]}`, Math.min(...corners.map((q) => q[0])) - 26, below - 9, 'z0', br.b[2]);
  }

  // --- Input ---------------------------------------------------------------------------

  down(e) {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, [x, y]);
      if (this.touches.size === 2) { // two fingers: pinch and pan, nothing else
        this.cancelDrag();
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
        return;
      }
      if (this.touches.size > 2) return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    const [wu, wv] = this.toWorld(x, y);
    const app = this.app;
    this.closeMenus();
    // A tapped measure: type it.
    const m = this.measures.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (m && e.button === 0) {
      app.editMeasure(this, m);
      return;
    }
    if (e.button === 1 || e.button === 2 || app.spaceHeld) {
      this.drag = { type: 'pan', x, y, cu: this.cu, cv: this.cv, button: e.button, moved: false, cx: e.clientX, cy: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') { // a long press opens the menu
      const cx = e.clientX, cy = e.clientY;
      this.longPress = setTimeout(() => {
        this.cancelDrag();
        this.menuAt(x, y, cx, cy);
      }, LONG_PRESS);
    }
    const tool = app.tool;
    if (tool !== 'select') {
      this.drag = { type: 'create', u0: this.snap(wu), v0: this.snap(wv), cur: null, x, y };
      return;
    }
    // Select: the rotation knob, a handle of the single selected shape, the selection's body, else pick.
    const sel = app.selected();
    if (sel.length === 1 && sel[0].b) {
      const k = this.knob(sel[0]);
      if (k && Math.hypot(k[0] - x, k[1] - y) <= 10) {
        this.drag = { type: 'turn', item: sel[0], orig: sel[0].yaw, moved: false };
        return;
      }
      for (const [hx, hy, du, dv] of this.handles(sel[0])) {
        if (Math.abs(hx - x) <= HANDLE + 3 && Math.abs(hy - y) <= HANDLE + 3) {
          this.drag = { type: 'resize', du, dv, start: [wu, wv], orig: sel[0].b.slice(), item: sel[0], moved: false };
          return;
        }
      }
    }
    const hit = this.pick(x, y);
    if (hit && !e.shiftKey && !app.selection.has(hit.id)) app.select([hit.id]);
    else if (hit && e.shiftKey) app.toggle(hit.id);
    if (hit && app.selection.has(hit.id)) {
      this.drag = { type: 'move', start: [wu, wv], orig: app.selected().map((it) => [it, (it.b || it.o).slice()]), moved: false };
      return;
    }
    if (!e.shiftKey) app.select([]);
    this.drag = { type: 'band', u0: wu, v0: wv, cur: null, add: e.shiftKey };
  }

  cancelDrag() {
    clearTimeout(this.longPress);
    const d = this.drag;
    if (d && d.moved && (d.type === 'move' || d.type === 'resize' || d.type === 'turn')) this.app.changed(true);
    this.drag = null;
    this.guides = [];
    this.dirty = true;
  }

  closeMenus() {
    this.app.closeMenu();
  }

  menuAt(x, y, cx, cy) {
    const hit = this.pick(x, y);
    if (hit && !this.app.selection.has(hit.id)) this.app.select([hit.id]);
    const [u, v] = this.toWorld(x, y);
    this.app.openMenu(cx, cy, this, this.snap(u), this.snap(v));
  }

  move(e) {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [x, y]);
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        this.cu -= (mx - this.pinch.mx) / this.scale;
        this.cv += (my - this.pinch.my) / this.scale;
        this.zoomAt(mx, my, d / (this.pinch.d || d));
        this.pinch = { d, mx, my };
        return;
      }
    }
    const [wu, wv] = this.toWorld(x, y);
    this.mouse = [x, y];
    const { u, v } = this.ax;
    const L = 'xyz';
    this.coords.textContent = `${L[u]} ${Math.round(wu)}  ${L[v]} ${Math.round(wv)}`;
    const d = this.drag;
    const app = this.app;
    if (d && d.x !== undefined && Math.hypot(x - d.x, y - d.y) > 6) clearTimeout(this.longPress);
    if (!d) {
      const hit = app.tool === 'select' ? this.pick(x, y) : null;
      if (hit !== this.hover) {
        this.hover = hit;
        this.dirty = true;
        app.hoverStatus(hit);
      }
      this.canvas.style.cursor = this.cursorAt(x, y, hit);
      return;
    }
    clearTimeout(this.longPress);
    const free = e.altKey; // Alt: no snapping at all
    const snap = (val) => (free ? Math.round(val) : this.snap(val));
    if (d.type === 'pan') {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 4) d.moved = true;
      this.cu = d.cu - (x - d.x) / this.scale;
      this.cv = d.cv + (y - d.y) / this.scale;
      this.userMoved = true;
      this.dirty = true;
    } else if (d.type === 'create' || d.type === 'band') {
      d.cur = d.type === 'create' ? [snap(wu), snap(wv)] : [wu, wv];
      this.dirty = true;
    } else if (d.type === 'move') {
      let du = snap(wu - d.start[0]), dv = snap(wv - d.start[1]);
      if (!free) [du, dv] = this.snapToShapes(d.orig, du, dv, wu - d.start[0], wv - d.start[1]);
      if (!d.moved && !du && !dv) return;
      if (!d.moved) app.commit();
      d.moved = true;
      for (const [it, o] of d.orig) {
        const t = it.b || it.o;
        t[u] = o[u] + du;
        t[v] = o[v] + dv;
        if (it.b) {
          t[u + 3] = o[u + 3] + du;
          t[v + 3] = o[v + 3] + dv;
        }
      }
      app.changed(false);
    } else if (d.type === 'resize') {
      this.resize(d, wu, wv, free);
    } else if (d.type === 'turn') {
      const f = this.frame(d.item);
      const [cx, cy] = this.toScreen(f.cu, f.cv);
      let yaw = Math.atan2(-(y - cy), x - cx) * 180 / Math.PI - 90;
      if (!e.shiftKey) yaw = Math.round(yaw / 15) * 15;
      yaw = Math.round(((yaw % 360) + 360) % 360);
      if (yaw === d.item.yaw) return;
      if (!d.moved) app.commit();
      d.moved = true;
      d.item.yaw = yaw;
      app.changed(false);
    }
  }

  // Resizes along the brush's own axes (turned shapes from the top): the dragged sides
  // follow the pointer, the opposite ones stay where they are in the world.
  resize(d, wu, wv, free) {
    const app = this.app, br = d.item, o = d.orig, { u, v } = this.ax, g = free ? 1 : app.grid;
    const orig = { ...br, b: o };
    const f = this.frame(orig);
    const [lu, lv] = f.toLocal(wu, wv), [su, sv] = f.toLocal(d.start[0], d.start[1]);
    const q = (x) => Math.round(x / g) * g;
    let u0 = -f.hu, u1 = f.hu, v0 = -f.hv, v1 = f.hv;
    if (d.du < 0) u0 = Math.min(-f.hu + q(lu - su), u1 - g);
    if (d.du > 0) u1 = Math.max(f.hu + q(lu - su), u0 + g);
    if (d.dv < 0) v0 = Math.min(-f.hv + q(lv - sv), v1 - g);
    if (d.dv > 0) v1 = Math.max(f.hv + q(lv - sv), v0 + g);
    if (u0 === -f.hu && u1 === f.hu && v0 === -f.hv && v1 === f.hv && !d.moved) return;
    if (!d.moved) app.commit();
    d.moved = true;
    // The new center, back in the world (the frame turns about the old one).
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    const cu = f.cu + mu * f.c - mv * f.s, cv = f.cv + mu * f.s + mv * f.c;
    const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
    const b = br.b;
    b[u] = Math.round(cu - hu);
    b[u + 3] = b[u] + Math.round(hu * 2);
    b[v] = Math.round(cv - hv);
    b[v + 3] = b[v] + Math.round(hv * 2);
    app.changed(false);
  }

  // A move's snapped deltas pulled onto another shape's edge within SNAP_PX (the edges the
  // selection lines up with are drawn as guides).
  snapToShapes(orig, du, dv, rawU, rawV) {
    const { u, v } = this.ax, app = this.app, tol = SNAP_PX / this.scale;
    const ids = new Set(orig.map(([it]) => it.id));
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const [it, o] of orig) {
      const b = it.b ? { ...it, b: o } : { ...it, o };
      const bb = app.boundsOf(b);
      lo = [Math.min(lo[0], bb[u]), Math.min(lo[1], bb[v])];
      hi = [Math.max(hi[0], bb[u + 3]), Math.max(hi[1], bb[v + 3])];
    }
    const edges = [[], []];
    for (const it of app.items()) {
      if (ids.has(it.id)) continue;
      const bb = app.boundsOf(it);
      edges[0].push(bb[u], bb[u + 3]);
      edges[1].push(bb[v], bb[v + 3]);
    }
    this.guides = [];
    const pull = (k, raw, snapped, axis) => {
      let best = snapped, bestD = tol;
      for (const e of edges[k]) {
        for (const s of [lo[k], hi[k]]) {
          const dd = Math.abs(s + raw - e);
          if (dd < bestD) {
            bestD = dd;
            best = e - s;
          }
        }
      }
      if (best !== snapped) {
        for (const s of [lo[k], hi[k]]) if (edges[k].includes(s + best)) this.guides.push([axis, s + best]);
      }
      return best;
    };
    return [pull(0, rawU, du, 'u'), pull(1, rawV, dv, 'v')];
  }

  cursorAt(x, y, hit) {
    if (this.measures.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return 'text';
    const app = this.app;
    if (app.tool !== 'select') return 'crosshair';
    const sel = app.selected();
    if (sel.length === 1 && sel[0].b) {
      const k = this.knob(sel[0]);
      if (k && Math.hypot(k[0] - x, k[1] - y) <= 10) return 'grab';
      for (const [hx, hy, du, dv] of this.handles(sel[0])) {
        if (Math.abs(hx - x) <= HANDLE + 3 && Math.abs(hy - y) <= HANDLE + 3) {
          return du && dv ? 'nwse-resize' : du ? 'ew-resize' : 'ns-resize';
        }
      }
    }
    return hit ? (app.selection.has(hit.id) ? 'move' : 'pointer') : 'default';
  }

  up(e, cancelled = false) {
    clearTimeout(this.longPress);
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch) {
        if (this.touches.size < 2) this.pinch = null;
        return;
      }
    }
    const d = this.drag;
    this.drag = null;
    this.guides = [];
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d || cancelled) {
      if (d && d.moved) this.app.changed(true);
      this.dirty = true;
      return;
    }
    const app = this.app;
    if (d.type === 'pan' && d.button === 2 && !d.moved) { // a right click: the menu
      const [x, y] = this.local(e);
      this.menuAt(x, y, e.clientX, e.clientY);
    } else if (d.type === 'create') {
      const cur = d.cur;
      if (!cur || (cur[0] === d.u0 && cur[1] === d.v0)) app.placeCard(app.tool, this.ax, d.u0, d.v0); // a click: its own size
      else {
        const u0 = Math.min(d.u0, cur[0]), u1 = Math.max(d.u0, cur[0]);
        const v0 = Math.min(d.v0, cur[1]), v1 = Math.max(d.v0, cur[1]);
        if (u1 > u0 && v1 > v0) app.drawCard(app.tool, this.ax, u0, v0, u1, v1);
      }
    } else if (d.type === 'band' && d.cur) {
      const { u, v } = this.ax;
      const lo = [Math.min(d.u0, d.cur[0]), Math.min(d.v0, d.cur[1])], hi = [Math.max(d.u0, d.cur[0]), Math.max(d.v0, d.cur[1])];
      const ids = [];
      for (const it of app.items()) {
        const b = app.boundsOf(it);
        if (b[u] >= lo[0] && b[u + 3] <= hi[0] && b[v] >= lo[1] && b[v + 3] <= hi[1]) ids.push(it.id);
      }
      app.select(d.add ? [...app.selection, ...ids] : ids);
    } else if ((d.type === 'move' || d.type === 'resize' || d.type === 'turn') && d.moved) {
      app.changed(true);
    }
    this.dirty = true;
  }

  // The item under (x, y): points first, then the nearest solid shape whose outline holds
  // the spot (zones last; the smaller when as near: a crate on a floor).
  pick(x, y) {
    const app = this.app;
    for (const q of app.project.points.slice().reverse()) {
      if (inPolygon(this.shapes(q)[0].poly, x, y, PICK)) return q;
    }
    let best = null, bestKey = -Infinity;
    for (const br of app.project.brushes) {
      for (const pc of this.shapes(br)) {
        if (!inPolygon(pc.poly, x, y, PICK)) continue;
        const zone = KINDS[pc.kind].trigger || KINDS[pc.kind].water;
        const xs = pc.poly.map((q) => q[0]), ys = pc.poly.map((q) => q[1]);
        const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) / (this.scale * this.scale);
        const key = (skyOnly(br) ? -2e15 : zone ? -1e15 : 0) + pc.near * 1e6 - area / 1e6; // solid first, nearer, then the smaller
        if (key > bestKey) {
          bestKey = key;
          best = br;
        }
      }
    }
    return best;
  }
}
