// The gun gallery (client/guns.html): every gun model (client/models/guns.js) in a grid,
// right side on, at one scale, printed through the game's own renderer (ink and dots), for
// comparing the models with the real guns. Each gun gets its own camera, projected into
// its cell of the canvas. Drag turns them all; a double click goes back to the side view.
// ?only=ak47,m4a1 shows just those (and larger); ?bare takes the silencers off.

import { Renderer } from './gl/renderer.js';
import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN } from './gl/skinned.js';
import { buildGun } from './models/guns.js';
import { WEAPONS } from '../shared/weapons.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';

const DEG = Math.PI / 180;
const DIST = 110; // camera distance

const params = new URLSearchParams(location.search);
const only = params.get('only')?.split(',');
const names = WEAPONS.filter((w) => w && (w.gun || w.name === 'knife') && (!only || only.includes(w.name))).map((w) => w.name);
const canvas = document.getElementById('c');
const renderer = new Renderer(canvas);
const gl = renderer.gl;
renderer.style.calm = 0;
const sr = new SkinnedRenderer(gl);

// Each model with its bounds' center (turned about it) and length.
const guns = names.map((name) => {
  const g = buildGun(name, { noSilencer: params.has('bare') });
  const p = g.mesh.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[i + k]);
      hi[k] = Math.max(hi[k], p[i + k]);
    }
  }
  return { name, mesh: new SkinnedMesh(gl, g.mesh), center: lo.map((v, k) => (v + hi[k]) / 2), length: hi[0] - lo[0],
    height: hi[2] - lo[2] };
});

// Inches across a cell at the gun's distance: all of them (the AWP is ~45 long), or what
// fits the longest and the tallest of those asked for.
const LONGEST = Math.max(...guns.map((g) => g.length)), TALLEST = Math.max(...guns.map((g) => g.height));
// The grid: as many columns as give each gun the largest cell (a gun's cell is ~2.4:1),
// recomputed when the page resizes.
let cols = 1, rows = 1;
function layout(cw, ch) {
  let best = 0;
  for (let c = 1; c <= guns.length; c++) {
    const r = Math.ceil(guns.length / c), k = Math.min(cw / c, ch / r * 2.4);
    if (k > best) [best, cols, rows] = [k, c, r];
  }
}
const labels = document.getElementById('labels');
const tags = guns.map((g) => {
  const d = document.createElement('div');
  d.textContent = `${WEAPONS.find((w) => w && w.name === g.name).label || g.name} · ${g.length.toFixed(1)} in`;
  labels.append(d);
  return d;
});

let yaw = 0, pitch = 0, dirty = true;
const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
const model = new Float32Array(16), invViewProj = new Float32Array(16), eye = new Float32Array([0, -DIST, 0]);
const light = new Float32Array([1.25, 1.25, 1.25]);
const cellVP = guns.map(() => new Float32Array(16));

// Turns about z by yaw, then about y (pitch), about the point c.
function turn(out, c) {
  const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG), cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
  // R = Ry(pitch) * Rz(yaw), column-major
  const r = [cy * cp, sy, -cy * sp, -sy * cp, cy, sy * sp, sp, 0, cp];
  out.fill(0);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) out[j * 4 + i] = r[j * 3 + i];
  for (let i = 0; i < 3; i++) out[12 + i] = -(r[i] * c[0] + r[3 + i] * c[1] + r[6 + i] * c[2]);
  out[15] = 1;
  return out;
}

const overlay = {
  draw() {
    guns.forEach((g, i) => {
      sr.begin(cellVP[i]);
      sr.draw(g.mesh, turn(model, g.center), IDENTITY_SKIN, light);
    });
    sr.end();
  },
};

function frame() {
  requestAnimationFrame(frame);
  if (!dirty) return;
  dirty = false;
  const aspect = renderer.resize(1, Math.min(2, devicePixelRatio || 1));
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  layout(cw, ch);
  const w = cw / cols, h = ch / rows;
  const span = only ? Math.max(LONGEST * 1.15, TALLEST * 1.6 * w / h) : 56;
  const fovY = 2 * Math.atan(span / (w / h) / 2 / DIST);
  viewFromAngles(view, 0, -DIST, 0, 0, 90); // looking along +y: the right side, muzzle to the right
  guns.forEach((_, i) => {
    const x = (i % cols + 0.5) * w, y = (Math.floor(i / cols) + 0.45) * h;
    perspective(proj, fovY, w / h, 4, 1000);
    proj[0] *= w / cw;
    proj[5] *= h / ch;
    proj[8] = -(x / cw * 2 - 1);
    proj[9] = y / ch * 2 - 1;
    multiply(cellVP[i], proj, view);
    tags[i].style.left = `${x}px`;
    tags[i].style.top = `${y + Math.min(h * 0.36, w * 0.17)}px`;
  });
  perspective(proj, fovY, aspect, 4, 1000);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  renderer.zoom = 1;
  renderer.begin();
  renderer.render(viewProj, invViewProj, eye, 0, [overlay]);
  renderer.composite();
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = [e.clientX, e.clientY, yaw, pitch];
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  yaw = drag[2] + (e.clientX - drag[0]) * 0.5;
  pitch = Math.max(-89, Math.min(89, drag[3] + (e.clientY - drag[1]) * 0.5));
  dirty = true;
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('dblclick', () => {
  yaw = pitch = 0;
  dirty = true;
});
addEventListener('resize', () => (dirty = true));
new ResizeObserver(() => (dirty = true)).observe(canvas);
requestAnimationFrame(frame);
