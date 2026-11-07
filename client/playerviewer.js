// The player model viewer (client/players.html): the T, the CT and a hostage animated in place
// by the game's own animator (client/anim/playeranim.js) and printed by its renderer, for judging
// the gait, the holds and the shoulders. The toolbar (or ?move=run&gun=ak47&view=side&slow=1)
// picks how they move, what they hold, the camera, the zoom (2: the chest, 4: the head up close)
// and slow motion; drag turns the camera, a double click puts it back. `viewer` (on the page) lets a script pose them at a stride phase.

import { Renderer } from './gl/renderer.js';
import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN } from './gl/skinned.js';
import { MeshBuilder } from './gl/meshkit.js';
import { buildPlayer, HOLD_TIED } from './models/players.js';
import { buildGun, GUN_MAG, GUN_BOLT } from './models/guns.js';
import { PlayerAnimator, holdOf, gunInHand } from './anim/playeranim.js';
import { WEAPONS, WEAPON_ID } from '../shared/weapons.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';

const DEG = Math.PI / 180;
// How each movement goes: speed (a share of the weapon's), direction in the body frame
// (degrees, 0 ahead, 90 left), duck, on the ground.
const MOVES = {
  idle: [0, 0, 0, true], walk: [0.52, 0, 0, true], run: [1, 0, 0, true], crouch: [0.34, 0, 1, true],
  strafe: [1, 90, 0, true], back: [1, 180, 0, true], jump: [1, 0, 0, false],
};
const GUNS = ['ak47', 'm4a1', 'awp', 'glock', 'deagle', 'knife', 'hegrenade', 'c4'];
const VIEWS = { side: [0, 90], front: [0, 180], three: [10, 135], back: [0, 0], top: [55, 90] };
const SPACING = 60; // units between the figures

const params = new URLSearchParams(location.search);
const state = {
  move: MOVES[params.get('move')] ? params.get('move') : 'run',
  gun: GUNS.includes(params.get('gun')) ? params.get('gun') : 'ak47',
  view: VIEWS[params.get('view')] ? params.get('view') : 'side',
  slow: params.has('slow') ? +params.get('slow') || 0.25 : 1,
  zoom: [2, 4].includes(+params.get('zoom')) ? +params.get('zoom') : 1,
  focus: ['T', 'CT', 'H'].includes(params.get('focus')) ? params.get('focus') : 'CT', // who the camera centers on
};
const canvas = document.getElementById('c');
const renderer = new Renderer(canvas);
const gl = renderer.gl;
renderer.style.calm = 0;
const sr = new SkinnedRenderer(gl);
const light = new Float32Array([1.15, 1.15, 1.15]);

const floor = new SkinnedMesh(gl, new MeshBuilder().color([0.78, 0.7, 0.55]).box(400, 120, 2, 0, 0, -1).build());
const figures = [['T', false], ['CT', true], ['H', false]].map(([team, helmet], i) => ({
  mesh: new SkinnedMesh(gl, buildPlayer(team, helmet)), anim: new PlayerAnimator(), x: (i - 1) * SPACING,
  hostage: team === 'H', model: new Float32Array(16), gunM: new Float32Array(16), dist: 0,
}));
const gunCache = new Map();
function gun(name) {
  if (!gunCache.has(name)) {
    const g = buildGun(name), skin = new Float32Array(IDENTITY_SKIN);
    gunCache.set(name, { mesh: new SkinnedMesh(gl, g.mesh), pts: g, skin });
  }
  return gunCache.get(name);
}

// Every figure one step of dt seconds along the movement (the animator reads it from positions).
function step(dt) {
  const [share, dirDeg, duck, ground] = MOVES[state.move];
  const id = WEAPON_ID[state.gun], w = WEAPONS[id], g = gun(state.gun);
  const speed = share * (w.maxSpeed || 250), d = dirDeg * DEG;
  for (const f of figures) {
    f.dist += speed * dt;
    const a = f.anim, i = a.in;
    i[0] = dt; i[1] = Math.cos(d) * f.dist; i[2] = Math.sin(d) * f.dist; i[3] = 0; i[4] = 0; i[5] = 0; i[6] = duck;
    a.step(ground, f.hostage ? HOLD_TIED : holdOf(id), 0, 0, true, f.hostage ? null : g.pts, f.hostage ? 0 : id);
  }
}

const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
const invViewProj = new Float32Array(16), eye = new Float32Array(3), handM = new Float32Array(16), qGun = new Float32Array(8);
let camYaw = 0, camPitch = 0;

const overlay = {
  draw(vp) {
    sr.begin(vp);
    sr.draw(floor, IDENTITY_SKIN, IDENTITY_SKIN, light);
    const g = gun(state.gun), across = state.view === 'front' || state.view === 'back'; // (side by side to the camera)
    for (const f of figures) {
      const m = f.model;
      m.set(IDENTITY_SKIN.subarray(0, 16));
      m[across ? 13 : 12] = f.x;
      sr.draw(f.mesh, m, f.anim.pose.skin, light);
      if (f.hostage) continue;
      multiply(f.gunM, m, gunInHand(f.anim.pose, handM, qGun));
      const md = g.pts.magDir, a = f.anim;
      g.skin[GUN_MAG * 16 + 12] = md ? md[0] * a.magOff : 0;
      g.skin[GUN_MAG * 16 + 13] = md ? md[1] * a.magOff : 0;
      g.skin[GUN_MAG * 16 + 14] = md ? md[2] * a.magOff : 0;
      g.skin[GUN_BOLT * 16 + 12] = -a.boltOff;
      sr.draw(g.mesh, f.gunM, g.skin, light);
    }
    sr.end();
  },
};

function draw() {
  const aspect = renderer.resize(1, Math.min(2, devicePixelRatio || 1));
  const [vp, vy] = VIEWS[state.view], pitch = vp + camPitch, yaw = vy + camYaw;
  const dist = 230 / state.zoom, cp = Math.cos(pitch * DEG), at = state.zoom > 2 ? 63 : state.zoom > 1 ? 54 : 36; // (the chest, the head)
  const across = state.view === 'front' || state.view === 'back', off = (['T', 'CT', 'H'].indexOf(state.focus) - 1) * SPACING;
  eye[0] = -Math.cos(yaw * DEG) * cp * dist + (across ? 0 : off);
  eye[1] = -Math.sin(yaw * DEG) * cp * dist + (across ? off : 0);
  eye[2] = at + Math.sin(pitch * DEG) * dist;
  viewFromAngles(view, eye[0], eye[1], eye[2], pitch, yaw);
  perspective(proj, 40 * DEG, aspect, 4, 2000);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  renderer.zoom = 1;
  renderer.begin();
  renderer.render(viewProj, invViewProj, eye, [overlay]);
  renderer.composite();
}

let last = performance.now(), paused = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) step(dt * state.slow);
  draw();
}

// The toolbar: one row of buttons per choice.
const bar = document.getElementById('bar');
function buttons(key, list) {
  for (const v of list) {
    const b = document.createElement('button');
    b.textContent = v;
    b.dataset.key = key;
    b.dataset.v = v;
    b.onclick = () => {
      state[key] = key === 'slow' || key === 'zoom' ? +v : v;
      sync();
    };
    bar.append(b);
  }
  bar.append(document.createElement('span'));
}
function sync() {
  for (const b of bar.querySelectorAll('button')) b.classList.toggle('on', String(state[b.dataset.key]) === b.dataset.v);
}
buttons('move', Object.keys(MOVES));
buttons('gun', GUNS);
buttons('view', Object.keys(VIEWS));
buttons('slow', ['1', '0.25', '0.1']);
buttons('zoom', ['1', '2', '4']);
buttons('focus', ['T', 'CT', 'H']);
sync();

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = [e.clientX, e.clientY, camYaw, camPitch];
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  camYaw = drag[2] - (e.clientX - drag[0]) * 0.4;
  camPitch = Math.max(-30, Math.min(80, drag[3] + (e.clientY - drag[1]) * 0.4));
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('dblclick', () => (camYaw = camPitch = 0));

// For scripts (screenshots): settle the figures into a movement, then pose them at a stride
// phase (0..1) and hold.
globalThis.viewer = {
  state,
  set(move, gunName = state.gun, viewName = state.view, zoom = state.zoom, focus = state.focus) {
    Object.assign(state, { move, gun: gunName, view: viewName, zoom, focus });
    sync();
    for (let i = 0; i < 120; i++) step(1 / 60);
  },
  phase(p) {
    paused = true;
    for (let i = 0; i < 2000; i++) {
      step(1 / 240);
      if (Math.abs(figures[0].anim.phase - p) < 0.004) break;
    }
  },
  play() {
    paused = false;
  },
};
requestAnimationFrame(frame);
