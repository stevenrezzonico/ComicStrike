// One of the map editor's 2D views: top (x, y), front (x, z) or side (y, z), on a
// Canvas2D. Draws the grid, the boxes in their texture colors (zones and volumes as
// hatched tints), the points, and the selection with its handles; turns the mouse into
// edits through the editor (`app`): pick, move, resize, draw a box, place a point, pan, zoom.

import { KINDS, POINTS } from './project.js';

// Screen axes per view: [horizontal, vertical] world axes; `depth`: the hidden one, and
// which way is nearer the viewer (drawn last).
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
    this.dirty = true;
    new ResizeObserver(() => {
      const r = el.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (this.fitBox && !this.userMoved) this.fit(this.fitBox); // framed before the canvas had its size
      this.dirty = true;
    }).observe(el);
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.coords.textContent = '';
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.local(e);
      const [u, v] = this.toWorld(x, y);
      this.userMoved = true;
      this.scale = Math.min(8, Math.max(0.01, this.scale * Math.pow(1.0015, -e.deltaY)));
      const [u2, v2] = this.toWorld(x, y); // keep the point under the cursor
      this.cu += u - u2;
      this.cv += v - v2;
      this.dirty = true;
    }, { passive: false });
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

  // --- Drawing -------------------------------------------------------------------------

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.ctx, dpr = devicePixelRatio || 1, W = this.w, H = this.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fffaf0';
    ctx.fillRect(0, 0, W, H);
    this.drawGrid();
    const { u, v, w, near } = this.ax;
    const app = this.app, p = app.project;
    // Farther first: by the near edge along the hidden axis.
    const order = p.brushes.slice().sort((a, b) => (near > 0 ? a.b[w + 3] - b.b[w + 3] : b.b[w] - a.b[w]));
    for (const br of order) {
      const [x0, y1] = this.toScreen(br.b[u], br.b[v]);
      const [x1, y0] = this.toScreen(br.b[u + 3], br.b[v + 3]);
      const kind = KINDS[br.kind];
      const zone = kind.trigger || kind.water;
      if (zone) {
        const col = ZONE_COLORS[br.kind] || '#888';
        ctx.fillStyle = col + '33';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.strokeStyle = col + '66';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let d = -(y1 - y0); d < x1 - x0; d += 10) {
          ctx.moveTo(x0 + d, y1);
          ctx.lineTo(x0 + d + (y1 - y0), y0);
        }
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = col;
        ctx.setLineDash([5, 3]);
      } else {
        const tex = this.name === 'top' ? br.tex.top || br.tex.side : br.tex.side || br.tex.top;
        ctx.fillStyle = app.colorOf(tex);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = '#17130f';
        ctx.setLineDash(br.kind === 'world' ? [] : [6, 3]);
      }
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      if (br.kind !== 'world' && x1 - x0 > 40 && y1 - y0 > 14) {
        ctx.fillStyle = '#17130f';
        ctx.font = '11px sans-serif';
        ctx.fillText(kind.label, x0 + 4, y0 + 12, x1 - x0 - 8);
      }
    }
    for (const q of p.points) this.drawPoint(q);
    // The selection over everything, with handles on a single box.
    const sel = app.selected();
    ctx.strokeStyle = '#e2402a';
    ctx.lineWidth = 2.5;
    for (const it of sel) {
      const b = app.boundsOf(it);
      const [x0, y1] = this.toScreen(b[u], b[v]);
      const [x1, y0] = this.toScreen(b[u + 3], b[v + 3]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (sel.length === 1 && sel[0].b) {
      ctx.fillStyle = '#ffd23a';
      ctx.strokeStyle = '#17130f';
      ctx.lineWidth = 1.5;
      for (const [hx, hy] of this.handles(sel[0].b)) {
        ctx.fillRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.strokeRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
      }
    }
    // The rubber band or the box being drawn.
    const d = this.drag;
    if (d && (d.type === 'band' || d.type === 'create') && d.cur) {
      const [ax, ay] = this.toScreen(d.u0, d.v0), [bx, by] = this.toScreen(d.cur[0], d.cur[1]);
      ctx.setLineDash(d.type === 'band' ? [4, 3] : []);
      ctx.strokeStyle = d.type === 'band' ? '#2f6fc4' : '#e2402a';
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
    }
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

  // Handle positions of box b on screen: [x, y, du, dv] (which edges it moves: -1, 0, 1).
  handles(b) {
    const { u, v } = this.ax;
    const [x0, y1] = this.toScreen(b[u], b[v]);
    const [x1, y0] = this.toScreen(b[u + 3], b[v + 3]);
    const out = [];
    for (const du of [-1, 0, 1]) {
      for (const dv of [-1, 0, 1]) {
        if (!du && !dv) continue;
        out.push([du < 0 ? x0 : du > 0 ? x1 : (x0 + x1) / 2, dv < 0 ? y1 : dv > 0 ? y0 : (y0 + y1) / 2, du, dv]);
      }
    }
    return out;
  }

  // --- Input ---------------------------------------------------------------------------

  snap(x) {
    const g = this.app.grid;
    return Math.round(x / g) * g;
  }

  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.local(e);
    const [wu, wv] = this.toWorld(x, y);
    const app = this.app;
    if (e.button === 1 || e.button === 2 || app.spaceHeld) {
      this.drag = { type: 'pan', x, y, cu: this.cu, cv: this.cv };
      this.userMoved = true;
      return;
    }
    if (e.button !== 0) return;
    const tool = app.tool;
    if (tool === 'box') {
      this.drag = { type: 'create', u0: this.snap(wu), v0: this.snap(wv), cur: null };
      return;
    }
    if (POINTS[tool]) {
      app.addPoint(tool, this.ax, this.snap(wu), this.snap(wv));
      return;
    }
    // Select tool: a handle of the single selected box, the selection's body, else pick.
    const sel = app.selected();
    if (sel.length === 1 && sel[0].b) {
      for (const [hx, hy, du, dv] of this.handles(sel[0].b)) {
        if (Math.abs(hx - x) <= HANDLE + 2 && Math.abs(hy - y) <= HANDLE + 2) {
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

  move(e) {
    const [x, y] = this.local(e);
    const [wu, wv] = this.toWorld(x, y);
    this.mouse = [x, y];
    const { u, v } = this.ax;
    const L = 'xyz';
    this.coords.textContent = `${L[u]} ${Math.round(wu)}  ${L[v]} ${Math.round(wv)}`;
    const d = this.drag;
    if (!d) return;
    const app = this.app;
    if (d.type === 'pan') {
      this.cu = d.cu - (x - d.x) / this.scale;
      this.cv = d.cv + (y - d.y) / this.scale;
      this.dirty = true;
    } else if (d.type === 'create' || d.type === 'band') {
      d.cur = d.type === 'create' ? [this.snap(wu), this.snap(wv)] : [wu, wv];
      this.dirty = true;
    } else if (d.type === 'move') {
      const du = this.snap(wu - d.start[0]), dv = this.snap(wv - d.start[1]);
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
      const du = this.snap(wu) - this.snap(d.start[0]), dv = this.snap(wv) - this.snap(d.start[1]);
      if (!d.moved && !du && !dv) return;
      if (!d.moved) app.commit();
      d.moved = true;
      const b = d.item.b, o = d.orig, g = app.grid;
      if (d.du < 0) b[u] = Math.min(o[u] + du, o[u + 3] - g);
      if (d.du > 0) b[u + 3] = Math.max(o[u + 3] + du, o[u] + g);
      if (d.dv < 0) b[v] = Math.min(o[v] + dv, o[v + 3] - g);
      if (d.dv > 0) b[v + 3] = Math.max(o[v + 3] + dv, o[v] + g);
      app.changed(false);
    }
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    const app = this.app;
    if (d.type === 'create' && d.cur) {
      const u0 = Math.min(d.u0, d.cur[0]), u1 = Math.max(d.u0, d.cur[0]);
      const v0 = Math.min(d.v0, d.cur[1]), v1 = Math.max(d.v0, d.cur[1]);
      if (u1 > u0 && v1 > v0) app.addBox(this.ax, u0, v0, u1, v1);
    } else if (d.type === 'band' && d.cur) {
      const { u, v } = this.ax;
      const lo = [Math.min(d.u0, d.cur[0]), Math.min(d.v0, d.cur[1])], hi = [Math.max(d.u0, d.cur[0]), Math.max(d.v0, d.cur[1])];
      const ids = [];
      for (const it of app.items()) {
        const b = app.boundsOf(it);
        if (b[u] >= lo[0] && b[u + 3] <= hi[0] && b[v] >= lo[1] && b[v + 3] <= hi[1]) ids.push(it.id);
      }
      app.select(d.add ? [...app.selection, ...ids] : ids);
    } else if ((d.type === 'move' || d.type === 'resize') && d.moved) {
      app.changed(true);
    }
    this.dirty = true;
  }

  // The item under (x, y): points first, then the nearest box along the hidden axis that
  // contains the spot (the smallest when several are as near: a crate on a floor).
  pick(x, y) {
    const app = this.app, { u, v, w, near } = this.ax;
    for (const q of app.project.points.slice().reverse()) {
      const b = app.boundsOf(q);
      const [x0, y1] = this.toScreen(b[u], b[v]), [x1, y0] = this.toScreen(b[u + 3], b[v + 3]);
      if (x >= x0 - PICK && x <= x1 + PICK && y >= y0 - PICK && y <= y1 + PICK) return q;
    }
    let best = null, bestKey = -Infinity;
    for (const br of app.project.brushes) {
      const [x0, y1] = this.toScreen(br.b[u], br.b[v]), [x1, y0] = this.toScreen(br.b[u + 3], br.b[v + 3]);
      if (x < x0 - PICK || x > x1 + PICK || y < y0 - PICK || y > y1 + PICK) continue;
      const nearness = near > 0 ? br.b[w + 3] : -br.b[w];
      const area = (br.b[u + 3] - br.b[u]) * (br.b[v + 3] - br.b[v]);
      const zone = KINDS[br.kind].trigger || KINDS[br.kind].water;
      const key = (zone ? -1e15 : 0) + nearness * 1e6 - area / 1e6; // solid first, nearer, then the smaller
      if (key > bestKey) {
        bestKey = key;
        best = br;
      }
    }
    return best;
  }
}
