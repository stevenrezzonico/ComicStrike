// Client entry point. Online (default): joins the game server over WebTransport and
// sends 64 Hz user commands. Source-style netcode: the local player is predicted with
// the same shared simulation the server runs and reconciled against every snapshot
// (replaying unacknowledged commands); other players are interpolated INTERP_TICKS
// behind the server clock, and each command tells the server which tick we were seeing
// so it can rewind them (lag compensation). Offline (?offline, or when no server
// answers): everything runs locally.
// URL: ?team=t|ct&primary=awp&secondary=deagle&name=me  offline only: &offline&map=de_dust2
// V toggles noclip (offline only). 5 draws the C4, G drops it, E defuses.

import { parseBSP, parseVec3 } from '../shared/bsp.js';
import {
  TICK_RATE, TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED, IN_SCORE,
} from '../shared/constants.js';
import { CollisionWorld } from '../shared/trace.js';
import { eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_SIZE, FL_ONGROUND, FL_DUCKING } from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, ShotList, giveWeapon, weaponTick, viewPunchPitch, viewPunchYaw, hash32, WS_LAST_SLOT,
  WS_EVENTS, WS_SIZE, WS_SLOTS, WS_ACTION, WS_ACTION_END, SLOT_C4, ACTION_PLANT, ACTION_DEFUSE,
} from '../shared/weapons.js';
import {
  BombSites, PLANT_TIME, DEFUSE_TIME, DEFUSE_TIME_KIT, C4_TIMER, BOMB_DROPPED, BOMB_PLANTED, BOMB_DEFUSED,
  BOMB_EXPLODED,
} from '../shared/bomb.js';
import { Breakables } from '../shared/breakables.js';
import { HitTargets } from '../shared/hitgroups.js';
import { SurfaceMap } from '../shared/surfaces.js';
import { Player, spawnPlayer, runCommand, resolveShots, ImpactList, TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  MAX_PLAYERS, CmdRing, SHOT_BLOOD, KILL_HEADSHOT, SNAPSHOT_HISTORY, OWN_CAN_BUY, OWN_DEFUSER, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW,
  E_FLAGS, E_DUCK, E_HEALTH, E_TEAM, E_FIELDS, dequantizeYaw,
} from '../shared/protocol.js';
import { buildMapMesh } from './mapmesh.js';
import { Renderer } from './gl/renderer.js';
import { Decals } from './gl/decals.js';
import { Debris } from './gl/debris.js';
import { Players } from './gl/players.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';
import { Input, SELECT_LAST } from './input.js';
import { WeaponView } from './weaponview.js';
import { NetClient } from './net.js';
import { Hud } from './hud.js';
import { Sounds } from './audio.js';
import { PHASE_FREEZE, buyError, applyBuy } from '../shared/economy.js';

const DEG = Math.PI / 180;
const FOV_Y = 73.74 * DEG; // CS:GO fov 90 at 4:3, kept vertical (Hor+)
const NOCLIP_SPEED = 800;
const MAX_TICKS_PER_FRAME = 8;
const HISTORY = 64; // commands / predicted states kept (power of two)
const INTERP_TICKS = 2; // CS:GO cl_interp_ratio 2 at 64 updates/s: other players shown 31 ms behind
const SMOOTH_RATE = 15; // 1/s: how fast a visible prediction correction is blended away
const KILLFEED_MS = 5000;

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const status = document.getElementById('status');
const debug = document.getElementById('debug');
const killfeed = document.getElementById('killfeed');
const deathNotice = document.getElementById('death');

const renderer = new Renderer(canvas);
const decals = new Decals(renderer.gl);
const debris = new Debris(renderer.gl);
const players = new Players(renderer.gl);
const overlays = [decals, debris, players];
const weaponView = new WeaponView(renderer.gl, FOV_Y);
const input = new Input(canvas);
const hud = new Hud((item) => buy(item));
const sounds = new Sounds();
const OFFLINE_MONEY = 16000;

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
const predictedPs = new Uint8Array(HISTORY * PS_SIZE * 4); // our state after each command
const predictedWs = new Uint8Array(HISTORY * WS_SIZE * 8);
const predictedTick = new Int32Array(HISTORY).fill(-1);
const serverBroken = new Uint32Array(8); // breakable mask of the last applied snapshot
const replayShots = new ShotList();
const smooth = new Float32Array(3); // visual offset hiding prediction corrections
const netStats = { rtt: 0, compared: 0, corrected: 0, lastErr: 0 };

// Other players, interpolated between snapshots around renderTick.
let serverClock = -1; // estimated newest server tick (fractional), advanced every frame
const interp = new Float32Array(MAX_PLAYERS * E_FIELDS);
const targets = new HitTargets(MAX_PLAYERS);
const seenKills = new Int32Array(32).fill(-1);
let seenKillNext = 0;
let lastBombState = 0;
let nextBeep = 0; // ms
let lastBeep = -1e9;

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
  world.surfaces = new SurfaceMap(bsp);
  world.bombSites = new BombSites(bsp);
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
  smooth.fill(0);
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

// Decals for this tick's world hits; debris for anything our shots broke. Player hits
// show nothing until the server confirms them (blood events).
function showImpacts() {
  const melee = WEAPONS[shots.weapon[0]]?.melee;
  for (let i = 0; i < impacts.count; i++) {
    if (impacts.player[i] >= 0) continue;
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

function sameBytes(a, ao, b, n) {
  for (let i = 0; i < n; i++) if (a[ao + i] !== b[i]) return false;
  return true;
}

function storePrediction(t) {
  const k = t & (HISTORY - 1);
  predictedPs.set(player.psBytes, k * PS_SIZE * 4);
  predictedWs.set(player.wsBytes, k * WS_SIZE * 8);
  predictedTick[k] = t;
}

// Freeze time (from the newest snapshot): the same input mask the server applies.
const frozen = () => net !== null && net.own.round.phase === PHASE_FREEZE;
// The bomb as of the newest snapshot (defusing is predicted against it).
const simBomb = () => (net ? net.own.bomb : null);

// Runs our commands after `from` again on top of the state we were just given.
function replayFrom(from) {
  for (let t = from + 1; t < tickCount; t++) {
    if (!cmds.has(t)) continue;
    const k = t & cmds.mask;
    if (player.health > 0) {
      runCommand(world, player, cmds.buttons[k], cmds.select[k], cmds.pitch[k], cmds.yaw[k], t, replayShots, frozen(),
        simBomb());
    }
    storePrediction(t);
  }
}

// Buy menu: the server decides online; offline it is instant (anywhere, $16000).
function buy(item) {
  if (net) {
    if (!buyError(player, item, (net.own.flags & OWN_CAN_BUY) !== 0)) net.buy(item);
  } else if (!buyError(player, item, true)) {
    applyBuy(player, item);
  }
}

function applySnapshot() {
  const own = net.own;
  netStats.rtt = (tickCount - own.lastCmd) * TICK_DT * 1000;
  player.defuser = (own.flags & OWN_DEFUSER) !== 0; // before any replay: it sets the defuse time

  if (own.spawnCount !== player.spawnCount || !synced) {
    // (Re)spawned by the server: take its state and replay what it has not run yet.
    player.psBytes.set(own.ps);
    player.wsBytes.set(own.ws);
    player.health = own.health;
    player.spawnCount = own.spawnCount;
    player.team = own.team;
    resetView(own.spawnYaw);
    predictedTick.fill(-1);
    if (synced) replayFrom(own.lastCmd);
    synced = true;
  } else {
    // Reconciliation: compare our prediction after command lastCmd with the server's
    // result. Exact (the normal case): nothing to do. Otherwise rewind to the server's
    // state, replay every later command, and blend the visible jump away.
    const t = own.lastCmd, k = t & (HISTORY - 1);
    if (predictedTick[k] === t) {
      netStats.compared++;
      // (Health is not compared: damage from other players is never predicted.)
      const exact = sameBytes(predictedPs, k * PS_SIZE * 4, own.ps, PS_SIZE * 4) &&
        sameBytes(predictedWs, k * WS_SIZE * 8, own.ws, WS_SIZE * 8);
      predictedTick[k] = -1;
      if (!exact) {
        netStats.corrected++;
        const x = ps.f[PS_ORIGIN], y = ps.f[PS_ORIGIN + 1], z = ps.f[PS_ORIGIN + 2];
        player.psBytes.set(own.ps);
        player.wsBytes.set(own.ws);
        player.health = own.health;
        replayFrom(t);
        const dx = x - ps.f[PS_ORIGIN], dy = y - ps.f[PS_ORIGIN + 1], dz = z - ps.f[PS_ORIGIN + 2];
        netStats.lastErr = Math.hypot(dx, dy, dz);
        if (netStats.lastErr < 64) { // small: smooth it; large (teleport): snap
          smooth[0] += dx;
          smooth[1] += dy;
          smooth[2] += dz;
        }
        prevOrigin[0] -= dx;
        prevOrigin[1] -= dy;
        prevOrigin[2] -= dz;
      }
    }
  }
  player.health = own.health;
  player.armor = own.armor;
  player.helmet = own.helmet;
  player.money = own.money;

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

  // The bomb: announce the plant, blow up.
  const bomb = own.bomb;
  if (bomb.state !== lastBombState) {
    if (bomb.state === BOMB_PLANTED) {
      hud.flash('The bomb has been planted', 3000, performance.now());
      nextBeep = 0;
    } else if (bomb.state === BOMB_EXPLODED && lastBombState === BOMB_PLANTED) {
      explosion(bomb.x, bomb.y, bomb.z);
    }
    lastBombState = bomb.state;
  }

  // Keep the server clock estimate near the newest snapshot (it drifts with jitter).
  const seq = net.latestSeq;
  if (serverClock < 0 || Math.abs(seq - serverClock) > 16) serverClock = seq;
  else serverClock += (seq - serverClock) * 0.05;
}

// Other players' shots and the kill feed.
function applyEvents() {
  const ev = net.events;
  for (let k = 0; k < ev.shots; k++) {
    const x = ev.pos[k * 3], y = ev.pos[k * 3 + 1], z = ev.pos[k * 3 + 2];
    if (ev.kind[k] === SHOT_BLOOD) {
      debris.puff(x, y, z, 0.55, 0.05, 0.04, 6);
    } else if (!breakables.broken[ev.breakable[k]] || !ev.breakable[k]) {
      decals.add(x, y, z, ev.normal[k * 3], ev.normal[k * 3 + 1], ev.normal[k * 3 + 2], 1.6,
        (hash32(k * 31 + net.latestSeq) & 0xffff) / 65536, ev.breakable[k]);
    }
  }
  for (let k = 0; k < ev.kills; k++) {
    const id = ev.killId[k];
    if (seenKills.includes(id)) continue;
    seenKills[seenKillNext] = id;
    seenKillNext = (seenKillNext + 1) % seenKills.length;
    addKill(ev.killer[k], ev.victim[k], ev.weapon[k], (ev.killFlags[k] & KILL_HEADSHOT) !== 0);
  }
}

function explosion(x, y, z) {
  debris.puff(x, y, z + 24, 1.0, 0.55, 0.12, 70);
  debris.puff(x, y, z + 40, 0.25, 0.23, 0.2, 60);
  sounds.explosion(Math.min(1, Sounds.falloff(Math.hypot(x - eye[0], y - eye[1], z - eye[2]), 1500)));
}

// While planted: beep, faster and faster (approximation of CS:GO's 1.4 s down to
// 0.1 s), from the bomb's position.
function bombBeeps(now) {
  const b = net.own.bomb;
  if (b.state !== BOMB_PLANTED || now < nextBeep) return;
  const left = Math.max(0, b.ticksLeft - (serverClock - net.latestSeq)) / TICK_RATE;
  nextBeep = now + 1000 * Math.max(0.1, 0.1 + 1.3 * left / C4_TIMER);
  lastBeep = now;
  sounds.beep(Sounds.falloff(Math.hypot(b.x - eye[0], b.y - eye[1], b.z - eye[2])));
}

function teamClass(id) {
  return net.teams[id] === TEAM_CT ? 'ct' : 't';
}

function addKill(killer, victim, weapon, headshot) {
  const row = document.createElement('div');
  const name = (id) => net.names[id] || `player${id}`;
  const wname = WEAPONS[weapon] ? WEAPONS[weapon].label : 'world';
  if (killer === victim) {
    row.innerHTML = WEAPONS[weapon]?.c4 ? `[C4] <span class="${teamClass(victim)}"></span>`
      : `<span class="${teamClass(victim)}"></span> died`;
    row.querySelector('span').textContent = name(victim);
  } else {
    row.innerHTML = `<span class="${teamClass(killer)}"></span> [<span></span>]${headshot ? ' <b class="hs">HS</b>' : ''}` +
      ` <span class="${teamClass(victim)}"></span>`;
    const spans = row.querySelectorAll('span');
    spans[0].textContent = name(killer);
    spans[1].textContent = wname;
    spans[2].textContent = name(victim);
  }
  if (killer === selfId || victim === selfId) row.className = 'mine';
  killfeed.appendChild(row);
  while (killfeed.children.length > 5) killfeed.firstChild.remove();
  setTimeout(() => row.remove(), KILLFEED_MS);
  if (victim === selfId) {
    deathNotice.textContent = WEAPONS[weapon]?.c4 ? 'Killed by the bomb'
      : killer === victim ? 'You died' : `Killed by ${name(killer)}${headshot ? ' (headshot)' : ''}`;
  }
}

// Interpolated rows of the other players at server tick `at` into `out`.
function interpolatePlayers(at, out) {
  const ring = net.ring, E = ring.ents;
  let k0 = -1, k1 = -1, s0 = -Infinity, s1 = Infinity;
  for (let k = 0; k < SNAPSHOT_HISTORY; k++) {
    const s = ring.seq[k];
    if (s < 0) continue;
    if (s <= at && s > s0) {
      s0 = s;
      k0 = k;
    } else if (s > at && s < s1) {
      s1 = s;
      k1 = k;
    }
  }
  if (k0 < 0) { // older than anything we hold: use the oldest newer one
    k0 = k1;
    s0 = s1;
  }
  if (k0 < 0) return false;
  const f = k1 >= 0 && k0 !== k1 ? (at - s0) / (s1 - s0) : 0;
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const a = ring.row(k0, id), o = id * E_FIELDS;
    const b = f > 0 ? ring.row(k1, id) : a;
    if (!E[a + E_ACTIVE] || !E[b + E_ACTIVE] || E[a + E_HEALTH] === 0 !== (E[b + E_HEALTH] === 0)) {
      // Appeared, left or died between the two: no blending.
      const src = f < 0.5 ? a : b;
      for (let i = 0; i < E_FIELDS; i++) out[o + i] = E[src + i];
      continue;
    }
    const near = f < 0.5 ? a : b;
    for (let i = 0; i < E_FIELDS; i++) out[o + i] = E[near + i];
    out[o + E_X] = E[a + E_X] + (E[b + E_X] - E[a + E_X]) * f;
    out[o + E_Y] = E[a + E_Y] + (E[b + E_Y] - E[a + E_Y]) * f;
    out[o + E_Z] = E[a + E_Z] + (E[b + E_Z] - E[a + E_Z]) * f;
    out[o + E_PITCH] = E[a + E_PITCH] + (E[b + E_PITCH] - E[a + E_PITCH]) * f;
    let dyaw = E[b + E_YAW] - E[a + E_YAW];
    dyaw -= Math.round(dyaw / 65536) * 65536;
    out[o + E_YAW] = (E[a + E_YAW] + dyaw * f + 65536) % 65536;
    out[o + E_DUCK] = E[a + E_DUCK] + (E[b + E_DUCK] - E[a + E_DUCK]) * f;
  }
  return true;
}

// Hit targets from what we see (interpolated), so our shots stop at players we hit.
function buildTargets() {
  targets.clear();
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const o = id * E_FIELDS;
    if (id === selfId || !interp[o + E_ACTIVE] || !interp[o + E_HEALTH]) continue;
    targets.set(id, interp[o + E_X], interp[o + E_Y], interp[o + E_Z], dequantizeYaw(interp[o + E_YAW]),
      interp[o + E_FLAGS], interp[o + E_DUCK] / 255, interp[o + E_TEAM]);
  }
}

// --- Simulation -------------------------------------------------------------------

function tick() {
  prevOrigin[0] = ps.f[PS_ORIGIN];
  prevOrigin[1] = ps.f[PS_ORIGIN + 1];
  prevOrigin[2] = ps.f[PS_ORIGIN + 2];
  prevEye = eyeOffset(ps);
  prevPunchP = viewPunchPitch(ws);
  prevPunchY = viewPunchYaw(ws);

  let viewTick = 0;
  if (net) {
    if (net.poll()) applySnapshot();
    if (synced) applyEvents();
    if (net.closed) status.textContent = `disconnected: ${net.closeReason}`;
    if (!synced || net.closed) return;
    viewTick = serverClock - INTERP_TICKS;
    if (interpolatePlayers(viewTick, interp)) buildTargets();
  }

  const buttons = input.sampleButtons();
  let select = input.sampleSelect();
  if (select === SELECT_LAST) select = ws.f[WS_LAST_SLOT];
  lastButtons = buttons;
  const t = tickCount;
  const alive = player.health > 0;

  shots.count = 0;
  impacts.count = 0;
  if (noclip && !net) {
    noclipTick(buttons);
    weaponTick(ws, ps, buttons, select, angles[0], angles[1], t, shots);
  } else if (alive) {
    const died = runCommand(world, player, buttons, select, angles[0], angles[1], t, shots, frozen(), simBomb());
    if (died && !net) offlineRespawn();
  }
  if (shots.count) {
    resolveShots(world, breakables, ws, shots, impacts, net ? targets : null, selfId, player.team);
    showImpacts();
  }

  if (net) {
    // Dead players keep sending commands: the server uses them up, and they carry acks.
    cmds.put(t, buttons, select, angles[0], angles[1], viewTick);
    storePrediction(t);
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
  if (serverClock >= 0) serverClock += Math.min(elapsed, 0.25) * TICK_RATE;
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
          `prediction: ${netStats.compared - netStats.corrected}/${netStats.compared} exact` +
          `${netStats.corrected ? `  last correction ${netStats.lastErr.toFixed(2)} u` : ''}`
        : 'offline');
    frames = 0;
    fpsTime = now;
    frameMsMax = 0;
  }
  requestAnimationFrame(frame);
}

function draw(now, alpha, dt) {
  const f = ps.f;
  const k = Math.exp(-dt * SMOOTH_RATE);
  smooth[0] *= k;
  smooth[1] *= k;
  smooth[2] *= k;
  eye[0] = prevOrigin[0] + (f[PS_ORIGIN] - prevOrigin[0]) * alpha + smooth[0];
  eye[1] = prevOrigin[1] + (f[PS_ORIGIN + 1] - prevOrigin[1]) * alpha + smooth[1];
  eye[2] = prevOrigin[2] + (f[PS_ORIGIN + 2] - prevOrigin[2]) * alpha + smooth[2];
  eye[2] += prevEye + (eyeOffset(ps) - prevEye) * alpha;
  // The camera shows a fraction of the aim punch (view_recoil_tracking).
  const pitch = angles[0] + prevPunchP + (viewPunchPitch(ws) - prevPunchP) * alpha;
  const yaw = angles[1] + prevPunchY + (viewPunchYaw(ws) - prevPunchY) * alpha;

  if (net && synced && interpolatePlayers(serverClock - INTERP_TICKS, interp)) {
    players.update(interp, 0, selfId);
    const b = net.own.bomb;
    if (b.state === BOMB_DROPPED || b.state === BOMB_PLANTED || b.state === BOMB_DEFUSED) {
      players.addBomb(b.x, b.y, b.z, 0, b.state === BOMB_PLANTED && now - lastBeep < 120);
    }
  }
  if (net && synced) bombBeeps(now);

  const aspect = renderer.resize(1);
  perspective(proj, FOV_Y, aspect, 4, 16384);
  viewFromAngles(view, eye[0], eye[1], eye[2], pitch, yaw);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  debris.update(dt, world);
  renderer.render(viewProj, invViewProj, eye, now / 1000, overlays);

  hud.update(net ? net.own.round : null, net ? net.own.bomb : null, player.money, now);
  const action = ws.f[WS_ACTION];
  const simTime = (tickCount - 1 + alpha) * TICK_DT;
  const actionTime = action === ACTION_PLANT ? PLANT_TIME : player.defuser ? DEFUSE_TIME_KIT : DEFUSE_TIME;
  hud.bombStatus(ws.f[WS_SLOTS + SLOT_C4 * 3] > 0 && player.health > 0,
    world.bombSites.touches(f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2], 16, 16, 36),
    action === ACTION_PLANT ? 'Planting the bomb' : action === ACTION_DEFUSE ? 'Defusing the bomb' : '',
    1 - (ws.f[WS_ACTION_END] - simTime) / actionTime);
  hud.refreshMenu(player, net ? (net.own.flags & OWN_CAN_BUY) !== 0 : true);
  hud.scoreboard((input.buttons & IN_SCORE) !== 0 && input.locked, net, selfId,
    (id) => id === selfId ? player.health > 0 : interp[id * E_FIELDS + E_HEALTH] > 0);

  const dead = player.health <= 0;
  weaponView.hidden = dead;
  deathNotice.style.display = dead && net ? 'block' : 'none';
  weaponView.draw(canvas.width, canvas.height, aspect, ws, ps, lastButtons, simTime, dt, Math.max(player.health, 0),
    player.armor);
}

// Hidden tabs get no animation frames (and timers at most once a second): keep
// applying snapshots and events so the world is current when we come back.
setInterval(() => {
  if (!document.hidden || !net || !synced) return;
  if (net.poll()) applySnapshot();
  applyEvents();
}, 250);

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && input.locked && !e.repeat && !net) noclip = !noclip;
  if (e.repeat) return;
  if (e.code === 'KeyB' && (input.locked || hud.menuOpen)) hud.toggleMenu();
  else if (e.code === 'Escape' && hud.menuOpen) hud.toggleMenu(false);
  else if (hud.menuOpen && /^Digit[1-9]$/.test(e.code)) hud.menuKey(+e.code.slice(5));
});
canvas.addEventListener('click', () => {
  sounds.resume(); // audio may only start after a user gesture
  if (hud.menuOpen) hud.toggleMenu(false);
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
    player.money = OFFLINE_MONEY;
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
  interp,
  targets,
  hud,
  buy,
  sounds,
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
