// Editing in the map editor's 3D view (the game page as `?preview`, client/main.js): a
// click picks the shape under the pointer (a ray against each shape's planes, as the
// editor sends them), a drag moves the selection along the floor (Shift: up and down),
// and the selection is outlined over the print. The editor owns the project: this only
// reports picks and drag deltas ('preview-pick', 'preview-move') and keys ('preview-key':
// the editor's shortcuts work with this view focused), and the rebuilt map comes back
// when the drag ends. Holding the right button looks round and flies instead.
//
// In:  preview-shapes { shapes: [{ id, zone, pieces: [{ planes: [[nx, ny, nz, d]], polys }] }] },
//      preview-select { ids, grid }

// Ctrl + these keys are the editor's (client/editor/editor.js `key`), not the browser's.
const EDITOR_CTRL_KEYS = ['a', 'c', 'd', 'e', 'o', 's', 'v', 'x', 'y', 'z', 'enter'];

export class PreviewEditor {
  // canvas: the game canvas; camera() -> { viewProj, invViewProj } (this frame's);
  // post(msg): to the editor; lock() / unlock(): the mouse for flying.
  constructor(canvas, camera, post, lock, unlock) {
    this.canvas = canvas;
    this.camera = camera;
    this.post = post;
    this.shapes = [];
    this.selection = new Set();
    this.grid = 16;
    this.drag = null; // { plane: [n, d], vertical, start: [x, y, z], delta }
    this.hover = null;
    this.overlay = document.createElement('canvas');
    Object.assign(this.overlay.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 });
    document.body.append(this.overlay);
    this.ctx = this.overlay.getContext('2d');
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (document.pointerLockElement) return;
      if (e.button === 2) {
        lock();
        return;
      }
      if (e.button !== 0) return;
      const ray = this.ray(e);
      const hit = this.pick(ray);
      this.post({ type: 'preview-pick', id: hit ? hit.id : null, add: e.shiftKey && !!hit });
      if (!hit || (e.shiftKey && this.selection.has(hit.id))) return;
      this.selection = e.shiftKey ? new Set([...this.selection, hit.id]) : this.selection.has(hit.id) ? this.selection : new Set([hit.id]);
      // The drag plane: the floor through the hit point, or (Alt) upright, facing us.
      const p = hit.point, vertical = e.altKey;
      const n = vertical ? norm([ray.d[0], ray.d[1], 0]) : [0, 0, 1];
      this.drag = { n, d: dot(n, p), vertical, start: p, delta: [0, 0, 0], sent: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (document.pointerLockElement) return;
      const ray = this.ray(e);
      if (!this.drag) {
        const hit = this.pick(ray);
        this.hover = hit ? hit.id : null;
        canvas.style.cursor = hit ? (this.selection.has(hit.id) ? 'move' : 'pointer') : 'default';
        return;
      }
      const d = this.drag, den = dot(d.n, ray.d);
      if (Math.abs(den) < 1e-6) return;
      const t = (d.d - dot(d.n, ray.o)) / den;
      if (t <= 0) return;
      const q = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
      d.delta = d.vertical ? [0, 0, q[2] - d.start[2]] : [q[0] - d.start[0], q[1] - d.start[1], 0];
      this.post({ type: 'preview-move', phase: d.sent ? 'move' : 'start', delta: d.delta });
      d.sent = true;
    });
    const end = (e) => {
      if (e.button === 2 && document.pointerLockElement) unlock();
      if (!this.drag) return;
      if (this.drag.sent) this.post({ type: 'preview-move', phase: 'end', delta: this.drag.delta });
      this.drag = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    addEventListener('mouseup', (e) => {
      if (e.button === 2 && document.pointerLockElement) unlock();
    });
    // Keys are the editor's shortcuts while this view has the focus, except while flying.
    addEventListener('keydown', (e) => {
      if (document.pointerLockElement || e.code === 'Space' || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl ? EDITOR_CTRL_KEYS.includes(e.key.toLowerCase()) : e.altKey || e.key.startsWith('Page')) e.preventDefault();
      this.post({ type: 'preview-key', key: e.key, code: e.code, ctrl, shift: e.shiftKey, alt: e.altKey });
    });
  }

  message(m) {
    if (m.type === 'preview-shapes') this.shapes = m.shapes;
    else if (m.type === 'preview-select') {
      this.selection = new Set(m.ids);
      this.grid = m.grid || this.grid;
    }
  }

  // The ray under the pointer: origin and unit direction, from this frame's camera.
  ray(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * 2 - 1, y = 1 - (e.clientY - r.top) / r.height * 2;
    const m = this.camera().invViewProj;
    const a = unproject(m, x, y, -1), b = unproject(m, x, y, 1);
    return { o: a, d: norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) };
  }

  // The nearest shape the ray enters (solid ones before zones): { id, point }.
  pick(ray) {
    let best = null, bestT = Infinity, bestZone = true;
    for (const s of this.shapes) {
      for (const pc of s.pieces) {
        const t = enter(pc.planes, ray);
        if (t === null) continue;
        if ((bestZone && !s.zone) || (s.zone === bestZone && t < bestT)) {
          best = s;
          bestT = t;
          bestZone = s.zone;
        }
      }
    }
    if (!best) return null;
    return { id: best.id, point: [ray.o[0] + ray.d[0] * bestT, ray.o[1] + ray.d[1] * bestT, ray.o[2] + ray.d[2] * bestT] };
  }

  // Outlines the selection (moved by the drag, in whole grid steps, as the editor moves
  // it) and the shape under the pointer.
  draw() {
    const c = this.overlay, dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const m = this.camera().viewProj;
    const g = this.grid;
    const off = this.drag ? this.drag.delta.map((x) => Math.round(x / g) * g) : [0, 0, 0];
    const outline = (s, color, width, moved) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.beginPath();
      for (const pc of s.pieces) {
        for (const poly of pc.polys) {
          let first = true;
          for (let i = 0; i <= poly.length; i++) {
            const v = poly[i % poly.length];
            const p = project(m, v[0] + (moved ? off[0] : 0), v[1] + (moved ? off[1] : 0), v[2] + (moved ? off[2] : 0));
            if (!p) {
              first = true;
              continue;
            }
            const sx = (p[0] + 1) / 2 * w, sy = (1 - p[1]) / 2 * h;
            if (first) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
            first = false;
          }
        }
      }
      ctx.stroke();
    };
    for (const s of this.shapes) {
      if (this.selection.has(s.id)) outline(s, '#e2402a', 2.5, true);
      else if (s.id === this.hover && !this.drag) outline(s, '#2f6fc4', 2, false);
    }
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// Where the ray enters the convex set n·p <= d of every plane (t > 0), or null.
function enter(planes, ray) {
  let t0 = 0, t1 = Infinity;
  for (const [nx, ny, nz, d] of planes) {
    const den = nx * ray.d[0] + ny * ray.d[1] + nz * ray.d[2];
    const dist = d - (nx * ray.o[0] + ny * ray.o[1] + nz * ray.o[2]);
    if (Math.abs(den) < 1e-9) {
      if (dist < 0) return null;
      continue;
    }
    const t = dist / den;
    if (den > 0) t1 = Math.min(t1, t);
    else t0 = Math.max(t0, t);
    if (t0 > t1) return null;
  }
  return t0 > 0 ? t0 : null; // (from inside a shape: not picked)
}

// Column-major 4×4 matrix times (x, y, z, 1), divided by w.
function unproject(m, x, y, z) {
  const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13];
  const Z = m[2] * x + m[6] * y + m[10] * z + m[14], W = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [X / W, Y / W, Z / W];
}

// A world point in normalized device coordinates, or null behind the camera.
function project(m, x, y, z) {
  const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13];
  const W = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (W < 1) return null;
  return [X / W, Y / W];
}
