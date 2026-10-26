// Client entry point. Phase 3: local player with CS:GO movement at a fixed 64 Hz tick,
// rendered with interpolation between ticks. V toggles noclip.

import { parseBSP, parseVec3 } from '../shared/bsp.js';
import {
  TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED,
} from '../shared/constants.js';
import { CollisionWorld } from '../shared/trace.js';
import {
  createPlayerState, playerMove, eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, FL_ONGROUND, FL_DUCKING,
} from '../shared/pmove.js';
import { buildMapMesh } from './mapmesh.js';
import { Renderer } from './gl/renderer.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';
import { Input } from './input.js';

const DEG = Math.PI / 180;
const FOV_Y = 73.74 * DEG; // CS:GO fov 90 at 4:3, kept vertical (Hor+)
const KNIFE_SPEED = 250;
const NOCLIP_SPEED = 800;
const MAX_TICKS_PER_FRAME = 8;

const canvas = document.getElementById('view');
const status = document.getElementById('status');
const hud = document.getElementById('debug');

const renderer = new Renderer(canvas);
const input = new Input(canvas);

const ps = createPlayerState();
const prevOrigin = new Float32Array(3);
let prevEye = 0;
let world = null;
let noclip = false;

const eye = new Float32Array(3);
const angles = new Float32Array(2); // pitch, yaw
const proj = new Float32Array(16);
const view = new Float32Array(16);
const viewProj = new Float32Array(16);
const invViewProj = new Float32Array(16);

async function loadMap(name) {
  if (!/^[\w-]+$/.test(name)) throw new Error(`bad map name: ${name}`);
  status.textContent = `loading ${name}...`;
  const res = await fetch(`/maps/${name}.bsp`);
  if (!res.ok) throw new Error(`map ${name}: HTTP ${res.status}`);
  const t0 = performance.now();
  const bsp = parseBSP(await res.arrayBuffer());
  const mesh = buildMapMesh(bsp);
  renderer.loadMap(mesh);
  world = CollisionWorld.fromBSP(bsp);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name}: ${mesh.numVerts} verts, ${(mesh.opaqueCount + mesh.transCount) / 3} tris, ` +
    `lightmap ${mesh.lightmap.width}x${mesh.lightmap.height}, ${world.ents.length} collision ents, built in ${ms} ms`);

  const spawn = bsp.entities.find((e) => e.classname === 'info_player_start') ||
    bsp.entities.find((e) => e.classname === 'info_player_deathmatch');
  if (spawn) {
    parseVec3(spawn.origin, ps.f, PS_ORIGIN);
    angles[1] = spawn.angles ? +spawn.angles.trim().split(/\s+/)[1] || 0 : +(spawn.angle || 0);
  }
  prevOrigin.set(ps.f.subarray(PS_ORIGIN, PS_ORIGIN + 3));
  prevEye = eyeOffset(ps);
  status.textContent = 'click to play';
}

function noclipTick(buttons) {
  const fwd = ((buttons & IN_FORWARD) ? 1 : 0) - ((buttons & IN_BACK) ? 1 : 0);
  const side = ((buttons & IN_MOVERIGHT) ? 1 : 0) - ((buttons & IN_MOVELEFT) ? 1 : 0);
  const up = ((buttons & IN_JUMP) ? 1 : 0) - ((buttons & IN_DUCK) ? 1 : 0);
  const speed = NOCLIP_SPEED * ((buttons & IN_SPEED) ? 0.3 : 1) * TICK_DT;
  const sp = Math.sin(angles[0] * DEG), cp = Math.cos(angles[0] * DEG);
  const sy = Math.sin(angles[1] * DEG), cy = Math.cos(angles[1] * DEG);
  const f = ps.f;
  f[PS_ORIGIN] += (fwd * cp * cy + side * sy) * speed;
  f[PS_ORIGIN + 1] += (fwd * cp * sy - side * cy) * speed;
  f[PS_ORIGIN + 2] += (-fwd * sp + up) * speed;
  f[PS_VEL] = f[PS_VEL + 1] = f[PS_VEL + 2] = 0;
}

function tick() {
  prevOrigin[0] = ps.f[PS_ORIGIN];
  prevOrigin[1] = ps.f[PS_ORIGIN + 1];
  prevOrigin[2] = ps.f[PS_ORIGIN + 2];
  prevEye = eyeOffset(ps);
  const buttons = input.sampleButtons();
  if (noclip) noclipTick(buttons);
  else playerMove(world, ps, buttons, angles[0], angles[1], TICK_DT, KNIFE_SPEED);
}

let last = performance.now();
let accumulator = 0;
let frames = 0;
let fpsTime = last;
let frameMsMax = 0;

function frame(now) {
  const elapsed = (now - last) / 1000;
  frameMsMax = Math.max(frameMsMax, now - last);
  last = now;

  input.applyMouse(angles);
  accumulator += elapsed;
  let ticks = 0;
  while (accumulator >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
    tick();
    accumulator -= TICK_DT;
    ticks++;
  }
  if (ticks === MAX_TICKS_PER_FRAME) accumulator = 0; // fell far behind (tab was hidden)

  draw(now, accumulator / TICK_DT);

  frames++;
  if (now - fpsTime >= 250) {
    const f = ps.f;
    const fl = ps.i[PS_FLAGS];
    hud.textContent = `${Math.round(frames * 1000 / (now - fpsTime))} fps  worst ${frameMsMax.toFixed(1)} ms\n` +
      `pos ${f[0].toFixed(0)} ${f[1].toFixed(0)} ${f[2].toFixed(0)}  ang ${angles[0].toFixed(1)} ${angles[1].toFixed(1)}\n` +
      `vel ${Math.hypot(f[PS_VEL], f[PS_VEL + 1]).toFixed(1)}  z ${f[PS_VEL + 2].toFixed(0)}` +
      `${fl & FL_ONGROUND ? '  ground' : ''}${fl & FL_DUCKING ? '  duck' : ''}${noclip ? '  NOCLIP' : ''}`;
    frames = 0;
    fpsTime = now;
    frameMsMax = 0;
  }
  requestAnimationFrame(frame);
}

function draw(now, alpha) {
  const f = ps.f;
  eye[0] = prevOrigin[0] + (f[PS_ORIGIN] - prevOrigin[0]) * alpha;
  eye[1] = prevOrigin[1] + (f[PS_ORIGIN + 1] - prevOrigin[1]) * alpha;
  eye[2] = prevOrigin[2] + (f[PS_ORIGIN + 2] - prevOrigin[2]) * alpha;
  eye[2] += prevEye + (eyeOffset(ps) - prevEye) * alpha;

  const aspect = renderer.resize(1);
  perspective(proj, FOV_Y, aspect, 4, 16384);
  viewFromAngles(view, eye[0], eye[1], eye[2], angles[0], angles[1]);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  renderer.render(viewProj, invViewProj, eye, now / 1000);
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && input.locked && !e.repeat) noclip = !noclip;
});
document.addEventListener('pointerlockchange', () => {
  status.style.display = document.pointerLockElement ? 'none' : '';
});

const mapName = new URLSearchParams(location.search).get('map') || 'de_dust2';
loadMap(mapName)
  .then(() => requestAnimationFrame(frame))
  .catch((err) => {
    status.textContent = String(err.message || err);
    console.error(err);
  });

// Dev hook for inspecting the scene from the console.
globalThis.webcs = {
  ps,
  angles,
  input,
  tick,
  draw: () => draw(performance.now(), 1),
  setNoclip: (on) => { noclip = on; },
};
