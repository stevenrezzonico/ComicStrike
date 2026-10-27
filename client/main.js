// Client entry point. Online (default): joins the game server over WebTransport,
// sends 64 Hz user commands and draws the server's snapshots. The local player runs
// the same shared simulation as the server, immediately (prediction); Phase 6 adds
// reconciliation, interpolation and lag compensation. Offline (?offline, or when no
// server answers): everything runs locally, as in Phase 4.
// URL: ?team=t|ct&primary=awp&secondary=deagle&name=me  offline only: &offline&map=de_dust2
// V toggles noclip (offline only).

import { parseBSP, parseVec3 } from '../shared/bsp.js';
import {
  TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED,
} from '../shared/constants.js';
import { CollisionWorld } from '../shared/trace.js';
import { eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_SIZE, FL_ONGROUND, FL_DUCKING } from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, ShotList, giveWeapon, weaponTick, viewPunchPitch, viewPunchYaw, hash32, WS_LAST_SLOT,
  WS_EVENTS,
} from '../shared/weapons.js';
import { Breakables } from '../shared/breakables.js';
import { Player, spawnPlayer, runCommand, resolveShots, ImpactList, TEAM_T, TEAM_CT } from '../shared/player.js';
import { CmdRing } from '../shared/protocol.js';
import { buildMapMesh } from './mapmesh.js';
import { Renderer } from './gl/renderer.js';
import { Decals } from './gl/decals.js';
import { Debris } from './gl/debris.js';
import { Players } from './gl/players.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';
import { Input, SELECT_LAST } from './input.js';
import { WeaponView } from './weaponview.js';
import { NetClient } from './net.js';

const DEG = Math.PI / 180;
const FOV_Y = 73.74 * DEG; // CS:GO fov 90 at 4:3, kept vertical (Hor+)
const NOCLIP_SPEED = 800;
const MAX_TICKS_PER_FRAME = 8;
const HISTORY = 64; // commands / predicted states kept (power of two)

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const status = document.getElementById('status');
const debug = document.getElementById('debug');

const renderer = new Renderer(canvas);
const decals = new Decals(renderer.gl);
const debris = new Debris(renderer.gl);
const players = new Players(renderer.gl);
const overlays = [decals, debris, players];
const weaponView = new WeaponView(renderer.gl, FOV_Y);
const input = new Input(canvas);

const player = new Player();
const ps = player.ps;
const ws = player.ws;
const shots = new ShotList();
const impacts = new ImpactList();
let tickCount = 1;
let lastButtons = 0;
let world = null;
let breakables = null;
let breakableColors = null; // rgb per breakable slot, for debris
const spawns = { [TEAM_T]: [], [TEAM_CT]: [] }; // offline spawn points [x, y, z, yaw]
let noclip = false;

// Online state.
let net = null;
let selfId = -1;
let synced = false; // false until the first snapshot gives us our spawn
const cmds = new CmdRing(HISTORY);
const predicted = new Float32Array(HISTORY * PS_SIZE); // our state after each command
const predictedTick = new Int32Array(HISTORY).fill(-1);
const serverBroken = new Uint32Array(8); // breakable mask of the last applied snapshot
const replayShots = new ShotList();
const netStats = { rtt: 0, compared: 0, mismatched: 0, lastErr: 0 };

const prevOrigin = new Float32Array(3);
let prevEye = 0, prevPunchP = 0, prevPunchY = 0;

const eye = new Float32Array(3);
const angles = new Float32Array(2); // pitch, yaw (without recoil); f32 like the wire format
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
  debris.clear();
  world = CollisionWorld.fromBSP(bsp);
  breakables = new Breakables(bsp, world);
  breakableColors = mesh.breakableColors;
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name}: ${mesh.numVerts} verts, ${(mesh.opaqueCount + mesh.skyCount + mesh.transCount) / 3} tris, ` +
    `lightmap ${mesh.lightmap.width}x${mesh.lightmap.height}, ${world.ents.length} collision ents, ` +
    `${breakables.count} breakables, built in ${ms} ms`);

  const o = new Float32Array(3);
  spawns[TEAM_T].length = spawns[TEAM_CT].length = 0;
  for (const e of bsp.entities) {
    const team = e.classname === 'info_player_deathmatch' ? TEAM_T : e.classname === 'info_player_start' ? TEAM_CT : 0;
    if (!team) continue;
    parseVec3(e.origin, o);
    spawns[team].push([o[0], o[1], o[2], e.angles ? +e.angles.trim().split(/\s+/)[1] || 0 : +(e.angle || 0)]);
  }
}

function resetView(yaw) {
  angles[0] = 0;
  angles[1] = yaw;
  prevOrigin.set(ps.f.subarray(PS_ORIGIN, PS_ORIGIN + 3));
  prevEye = eyeOffset(ps);
}

// Offline round restart: breakables come back, we spawn at our team's first spawn.
function offlineRespawn() {
  breakables.reset(world);
  renderer.clearBroken();
  debris.clear();
  const s = spawns[player.team][0] || spawns[TEAM_T][0] || spawns[TEAM_CT][0] || [0, 0, 0, 0];
  spawnPlayer(player, s[0], s[1], s[2]);
  resetView(s[3]);
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

// Decals for this tick's hits; debris for anything our shots broke.
function showImpacts() {
  const melee = WEAPONS[shots.weapon[0]]?.melee;
  for (let i = 0; i < impacts.count; i++) {
    if (impacts.broke[i]) {
      breakVisual(impacts.broke[i]);
      continue;
    }
    const p = impacts.pos, n = impacts.normal;
    decals.add(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], n[i * 3], n[i * 3 + 1], n[i * 3 + 2], melee ? 1.2 : 1.6,
      (hash32(tickCount * 7 + i) & 0xffff) / 65536, impacts.owner[i]);
  }
}

function breakVisual(slot) {
  renderer.setBroken(slot, true);
  decals.removeOwner(slot);
  const c = breakableColors;
  debris.burst(breakables.mins, breakables.maxs, slot * 3, breakables.material[slot],
    c[slot * 3], c[slot * 3 + 1], c[slot * 3 + 2]);
}

// --- Snapshots -------------------------------------------------------------------

function applySnapshot() {
  const own = net.own;
  player.health = own.health;
  player.armor = own.armor;
  netStats.rtt = (tickCount - own.lastCmd) * TICK_DT * 1000;

  if (own.spawnCount !== player.spawnCount || !synced) {
    // (Re)spawned by the server: take its state, then replay our commands it has
    // not run yet so we stay ahead of it.
    player.psBytes.set(own.ps);
    player.wsBytes.set(own.ws);
    player.spawnCount = own.spawnCount;
    player.team = own.team;
    resetView(own.spawnYaw);
    predictedTick.fill(-1);
    if (synced) {
      for (let t = own.lastCmd + 1; t < tickCount; t++) {
        if (!cmds.has(t)) continue;
        const k = t & cmds.mask;
        runCommand(world, player, cmds.buttons[k], cmds.select[k], cmds.pitch[k], cmds.yaw[k], t, replayShots);
      }
    }
    synced = true;
  } else {
    // Prediction check: our state after command lastCmd vs the server's.
    const t = own.lastCmd, k = t & (HISTORY - 1);
    if (predictedTick[k] === t) {
      const sp = own.psF;
      const o = k * PS_SIZE;
      const err = Math.hypot(sp[PS_ORIGIN] - predicted[o + PS_ORIGIN], sp[PS_ORIGIN + 1] - predicted[o + PS_ORIGIN + 1],
        sp[PS_ORIGIN + 2] - predicted[o + PS_ORIGIN + 2]);
      netStats.compared++;
      if (err > 0) {
        netStats.mismatched++;
        netStats.lastErr = err;
      }
      predictedTick[k] = -1;
    }
  }

  // Breakables: apply what changed on the server since the last snapshot (our own
  // predicted breaks stay as they are).
  const B = net.ring.broken, base = net.latest * 8;
  for (let i = 0; i < 8; i++) {
    let diff = B[base + i] ^ serverBroken[i];
    serverBroken[i] = B[base + i];
    while (diff) {
      const bit = 31 - Math.clz32(diff);
      diff &= ~(1 << bit);
      const slot = i * 32 + bit;
      const broken = (B[base + i] & (1 << bit)) !== 0;
      if (!breakables.setBroken(world, slot, broken)) continue;
      if (broken) breakVisual(slot);
      else renderer.setBroken(slot, false);
    }
  }

  players.update(net.ring.ents, net.ring.row(net.latest, 0), selfId);
}

// --- Simulation -------------------------------------------------------------------

function tick() {
  prevOrigin[0] = ps.f[PS_ORIGIN];
  prevOrigin[1] = ps.f[PS_ORIGIN + 1];
  prevOrigin[2] = ps.f[PS_ORIGIN + 2];
  prevEye = eyeOffset(ps);
  prevPunchP = viewPunchPitch(ws);
  prevPunchY = viewPunchYaw(ws);

  if (net) {
    if (net.poll()) applySnapshot();
    if (net.closed) status.textContent = `disconnected: ${net.closeReason}`;
    if (!synced || net.closed) return;
  }

  const buttons = input.sampleButtons();
  let select = input.sampleSelect();
  if (select === SELECT_LAST) select = ws.f[WS_LAST_SLOT];
  lastButtons = buttons;
  const t = tickCount;

  if (noclip && !net) {
    noclipTick(buttons);
    weaponTick(ws, ps, buttons, select, angles[0], angles[1], t, shots);
  } else {
    const died = runCommand(world, player, buttons, select, angles[0], angles[1], t, shots);
    if (died && !net) offlineRespawn();
  }
  resolveShots(world, breakables, ws, shots, impacts);
  showImpacts();

  if (net) {
    cmds.put(t, buttons, select, angles[0], angles[1]);
    predicted.set(ps.f, (t & (HISTORY - 1)) * PS_SIZE);
    predictedTick[t & (HISTORY - 1)] = t;
    net.sendCmds(cmds, t);
  }
  weaponView.onTick(ws.f[WS_EVENTS], t * TICK_DT);
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
      `${fl & FL_ONGROUND ? '  ground' : ''}${fl & FL_DUCKING ? '  duck' : ''}${noclip ? '  NOCLIP' : ''}\n` +
      (net
        ? `net: player ${selfId}  rtt ${netStats.rtt.toFixed(0)} ms  snapshots ${net.received} (${net.dropped} undecodable)\n` +
          `prediction: ${netStats.compared - netStats.mismatched}/${netStats.compared} exact` +
          `${netStats.mismatched ? `  last error ${netStats.lastErr.toFixed(3)} u` : ''}`
        : 'offline');
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
  debris.update(dt, world);
  renderer.render(viewProj, invViewProj, eye, now / 1000, overlays);

  const simTime = (tickCount - 1 + alpha) * TICK_DT;
  weaponView.draw(canvas.width, canvas.height, aspect, ws, ps, lastButtons, simTime, dt, player.health, player.armor);
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && input.locked && !e.repeat && !net) noclip = !noclip;
});
document.addEventListener('pointerlockchange', () => {
  status.style.display = document.pointerLockElement ? 'none' : '';
});

async function start() {
  const team = params.get('team') === 'ct' ? TEAM_CT : params.get('team') === 't' ? TEAM_T : 0;
  const primary = WEAPON_ID[params.get('primary')] || 0;
  const secondary = WEAPON_ID[params.get('secondary')] || 0;
  if (!params.has('offline')) {
    try {
      status.textContent = 'connecting...';
      net = new NetClient();
      await net.connect();
      const welcome = await net.join(team, primary, secondary, params.get('name') || '');
      selfId = welcome.playerId;
      await loadMap(welcome.map);
    } catch (err) {
      console.warn(`playing offline: ${err.message}`);
      net = null;
    }
  }
  if (!net) {
    player.team = team || TEAM_T;
    player.primary = primary;
    player.secondary = secondary;
    await loadMap(params.get('map') || 'de_dust2');
    offlineRespawn();
  }
  status.textContent = net ? 'click to play' : 'click to play (offline)';
  requestAnimationFrame(frame);
}

start().catch((err) => {
  status.textContent = String(err.message || err);
  console.error(err);
});

// Dev hook for inspecting the scene from the console.
globalThis.webcs = {
  player,
  ps,
  ws,
  renderer,
  decals,
  angles,
  input,
  tick,
  draw: () => draw(performance.now(), 1, 1 / 60),
  get net() {
    return net;
  },
  netStats,
  setNoclip: (on) => {
    noclip = on && !net;
  },
  get breakables() {
    return breakables;
  },
  // Offline only: equip any weapon by name, e.g. webcs.give('negev').
  give: (name) => {
    const id = WEAPON_ID[name];
    if (!id || net) return net ? 'online: the server owns your weapons' : Object.keys(WEAPON_ID).filter((n) => n !== 'none');
    giveWeapon(ws, id);
    input.select = WEAPONS[id].slot;
    return WEAPONS[id].label;
  },
};
