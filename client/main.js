// Client entry point. Phase 4: single-player prototype. CS:GO movement and weapons
// at a fixed 64 Hz tick, rendered with interpolation between ticks. V toggles noclip.
// URL: ?map=de_dust2&team=t|ct

import { parseBSP, parseVec3 } from '../shared/bsp.js';
import {
  TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED,
} from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, HULL_POINT } from '../shared/trace.js';
import {
  createPlayerState, copyPlayerState, playerMove, eyeOffset, fallDamage, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_EVENTS,
  PS_LAND_SPEED, FL_ONGROUND, FL_DUCKING, EV_LAND,
} from '../shared/pmove.js';
import {
  WEAPON_ID, SLOT_PRIMARY, ShotList, createWeaponState, copyWeaponState, giveWeapon, weaponTick, activeWeapon,
  viewPunchPitch, viewPunchYaw, hash32, WS_ACTIVE, WS_LAST_SLOT, WS_EVENTS,
} from '../shared/weapons.js';
import { buildMapMesh } from './mapmesh.js';
import { Renderer } from './gl/renderer.js';
import { Decals } from './gl/decals.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';
import { Input, SELECT_LAST } from './input.js';
import { WeaponView } from './weaponview.js';

const DEG = Math.PI / 180;
const FOV_Y = 73.74 * DEG; // CS:GO fov 90 at 4:3, kept vertical (Hor+)
const NOCLIP_SPEED = 800;
const MAX_TICKS_PER_FRAME = 8;

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const status = document.getElementById('status');
const debug = document.getElementById('debug');

const renderer = new Renderer(canvas);
const decals = new Decals(renderer.gl);
const weaponView = new WeaponView(renderer.gl, FOV_Y);
const input = new Input(canvas);

const ps = createPlayerState();
const ws = createWeaponState();
const shots = new ShotList();
const bulletTrace = new Trace();
const spawnOrigin = new Float32Array(3);
let spawnYaw = 0;
let ct = false;
let tickCount = 0;
let lastButtons = 0;
let health = 100;
const armor = 0; // bought with the economy in Phase 7
let world = null;
let noclip = false;

const prevOrigin = new Float32Array(3);
let prevEye = 0, prevPunchP = 0, prevPunchY = 0;

const eye = new Float32Array(3);
const angles = new Float32Array(2); // pitch, yaw (without recoil)
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
  decals.clear();
  world = CollisionWorld.fromBSP(bsp);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name}: ${mesh.numVerts} verts, ${(mesh.opaqueCount + mesh.skyCount + mesh.transCount) / 3} tris, ` +
    `lightmap ${mesh.lightmap.width}x${mesh.lightmap.height}, ${world.ents.length} collision ents, built in ${ms} ms`);

  ct = params.get('team') === 'ct';
  const spawn = bsp.entities.find((e) => e.classname === (ct ? 'info_player_start' : 'info_player_deathmatch')) ||
    bsp.entities.find((e) => /^info_player_(start|deathmatch)$/.test(e.classname));
  if (spawn) {
    parseVec3(spawn.origin, spawnOrigin);
    spawnYaw = spawn.angles ? +spawn.angles.trim().split(/\s+/)[1] || 0 : +(spawn.angle || 0);
  }
  respawn();
  status.textContent = 'click to play';
}

function respawn() {
  copyPlayerState(ps, createPlayerState());
  ps.f.set(spawnOrigin, PS_ORIGIN);
  copyWeaponState(ws, createWeaponState());
  giveWeapon(ws, WEAPON_ID.knife);
  giveWeapon(ws, ct ? WEAPON_ID.usp_silencer : WEAPON_ID.glock);
  giveWeapon(ws, ct ? WEAPON_ID.m4a1 : WEAPON_ID.ak47);
  angles[0] = 0;
  angles[1] = spawnYaw;
  ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  health = 100;
  prevOrigin.set(spawnOrigin);
  prevEye = eyeOffset(ps);
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

// Bullets and knife swings: trace against the world, mark impacts.
function resolveShots() {
  for (let i = 0; i < shots.count; i++) {
    const ox = shots.origin[i * 3], oy = shots.origin[i * 3 + 1], oz = shots.origin[i * 3 + 2];
    const r = shots.range[i];
    traceHull(world, HULL_POINT, ox, oy, oz,
      ox + shots.dir[i * 3] * r, oy + shots.dir[i * 3 + 1] * r, oz + shots.dir[i * 3 + 2] * r, bulletTrace);
    const t = bulletTrace;
    if (t.fraction < 1 && !t.startsolid) {
      const melee = activeWeapon(ws).melee;
      decals.add(t.endx, t.endy, t.endz, t.nx, t.ny, t.nz, melee ? 1.2 : 1.6, (hash32(tickCount * 7 + i) & 0xffff) / 65536);
    }
  }
}

function tick() {
  prevOrigin[0] = ps.f[PS_ORIGIN];
  prevOrigin[1] = ps.f[PS_ORIGIN + 1];
  prevOrigin[2] = ps.f[PS_ORIGIN + 2];
  prevEye = eyeOffset(ps);
  prevPunchP = viewPunchPitch(ws);
  prevPunchY = viewPunchYaw(ws);

  const buttons = input.sampleButtons();
  let select = input.sampleSelect();
  if (select === SELECT_LAST) select = ws.f[WS_LAST_SLOT];
  lastButtons = buttons;

  const weapon = activeWeapon(ws);
  if (noclip) noclipTick(buttons);
  else playerMove(world, ps, buttons, angles[0], angles[1], TICK_DT, weapon ? weapon.maxSpeed : 250);

  if (ps.i[PS_EVENTS] & EV_LAND) {
    health -= Math.round(fallDamage(ps.f[PS_LAND_SPEED]));
    if (health <= 0) respawn();
  }

  weaponTick(ws, ps, buttons, select, angles[0], angles[1], tickCount, shots);
  resolveShots();
  weaponView.onTick(ws.f[WS_EVENTS], tickCount * TICK_DT);
  tickCount++;
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

  draw(now, accumulator / TICK_DT, Math.min(elapsed, 0.1));

  frames++;
  if (now - fpsTime >= 250) {
    const f = ps.f;
    const fl = ps.i[PS_FLAGS];
    debug.textContent = `${Math.round(frames * 1000 / (now - fpsTime))} fps  worst ${frameMsMax.toFixed(1)} ms\n` +
      `pos ${f[0].toFixed(0)} ${f[1].toFixed(0)} ${f[2].toFixed(0)}  ang ${angles[0].toFixed(1)} ${angles[1].toFixed(1)}\n` +
      `vel ${Math.hypot(f[PS_VEL], f[PS_VEL + 1]).toFixed(1)}  z ${f[PS_VEL + 2].toFixed(0)}` +
      `${fl & FL_ONGROUND ? '  ground' : ''}${fl & FL_DUCKING ? '  duck' : ''}${noclip ? '  NOCLIP' : ''}`;
    frames = 0;
    fpsTime = now;
    frameMsMax = 0;
  }
  requestAnimationFrame(frame);
}

function draw(now, alpha, dt) {
  const f = ps.f;
  eye[0] = prevOrigin[0] + (f[PS_ORIGIN] - prevOrigin[0]) * alpha;
  eye[1] = prevOrigin[1] + (f[PS_ORIGIN + 1] - prevOrigin[1]) * alpha;
  eye[2] = prevOrigin[2] + (f[PS_ORIGIN + 2] - prevOrigin[2]) * alpha;
  eye[2] += prevEye + (eyeOffset(ps) - prevEye) * alpha;
  // The camera shows a fraction of the aim punch (view_recoil_tracking).
  const pitch = angles[0] + prevPunchP + (viewPunchPitch(ws) - prevPunchP) * alpha;
  const yaw = angles[1] + prevPunchY + (viewPunchYaw(ws) - prevPunchY) * alpha;

  const aspect = renderer.resize(1);
  perspective(proj, FOV_Y, aspect, 4, 16384);
  viewFromAngles(view, eye[0], eye[1], eye[2], pitch, yaw);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  renderer.render(viewProj, invViewProj, eye, now / 1000, decals);

  const simTime = (tickCount - 1 + alpha) * TICK_DT;
  weaponView.draw(canvas.width, canvas.height, aspect, ws, ps, lastButtons, simTime, dt, health, armor);
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && input.locked && !e.repeat) noclip = !noclip;
});
document.addEventListener('pointerlockchange', () => {
  status.style.display = document.pointerLockElement ? 'none' : '';
});

loadMap(params.get('map') || 'de_dust2')
  .then(() => requestAnimationFrame(frame))
  .catch((err) => {
    status.textContent = String(err.message || err);
    console.error(err);
  });

// Dev hook for inspecting the scene from the console.
globalThis.webcs = {
  ps,
  ws,
  renderer,
  decals,
  angles,
  input,
  tick,
  draw: () => draw(performance.now(), 1, 1 / 60),
  setNoclip: (on) => { noclip = on; },
};
