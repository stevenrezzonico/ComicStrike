// Client entry point. Online (default): joins the game server over WebTransport and
// sends 64 Hz user commands. Source-style netcode: the local player is predicted with
// the same shared simulation the server runs and reconciled against every snapshot
// (replaying unacknowledged commands); other players are interpolated cl_interp_ratio
// ticks behind the server clock, and each command tells the server which tick we were
// seeing so it can rewind them (lag compensation). Practice: the same server runs in a
// Web Worker (client/localserver.js) with bots, joined the same way. The sandbox
// (?offline) runs the player alone in the page, without game rules (noclip, give).
// The page opens on the start menu (client/menu.js); URL parameters skip it (testing):
// ?team=t|ct|spec&primary=awp&secondary=deagle&name=me joins at once (the sandbox if no
// server answers), &practice&map=de_dust2&mode=deathmatch&players=10 practices,
// &offline&map=de_dust2 opens the sandbox.
// Keys are CS:GO binds (client/binds.js); ` opens the console (client/settings.js).

import { parseBSP, parseUntrustedBSP, parseVec3, mapNameOf } from '../shared/bsp.js';
import {
  TICK_RATE, TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED, IN_SCORE,
  IN_ATTACK, IN_ATTACK2, IN_USE, IN_RELOAD, IN_DROP,
} from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, pointContents, HULL_POINT } from '../shared/trace.js';
import {
  eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_SIZE, FL_ONGROUND, FL_DUCKING, touched, touchedCount,
} from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, ShotList, giveWeapon, weaponTick, viewPunchPitch, viewPunchYaw, hash32, WS_LAST_SLOT,
  WS_EVENTS, WS_SIZE, WS_SLOTS, WS_ACTIVE, WS_ACTION, WS_ACTION_END, SLOT_C4, NUM_SLOTS, ACTION_PLANT, ACTION_DEFUSE,
  WS_ZOOM, WS_THROWN, WEV_THROW, WEV_FIRE, activeWeapon, silenced,
} from '../shared/weapons.js';
import { ARMS_RACE, DEMOLITION, levelWeapon } from '../shared/progression.js';
import {
  BombSites, PLANT_TIME, DEFUSE_TIME, DEFUSE_TIME_KIT, C4_TIMER, BOMB_DROPPED, BOMB_PLANTED, BOMB_DEFUSED,
  BOMB_EXPLODED,
} from '../shared/bomb.js';
import { Breakables } from '../shared/breakables.js';
import { Doors, MapLogic, MAX_MOVERS, MOVER_ROTATING } from '../shared/doors.js';
import { HitTargets, feetOffset } from '../shared/hitgroups.js';
import { SurfaceMap } from '../shared/surfaces.js';
import {
  Player, spawnPlayer, runCommand, resolveShots, applyDamage, ImpactList, TEAM_T, TEAM_CT, TEAM_SPECTATOR, TEAM_NAMES,
} from '../shared/player.js';
import { Grenades, FX_HE, FX_FLASH, FX_SMOKE, FX_FIRE, FX_FIZZLE } from '../shared/grenades.js';
import { HITGROUP_CHEST, HITGROUP_LEGS } from '../shared/hitgroups.js';
import {
  MAX_PLAYERS, CmdRing, SHOT_BLOOD, KILL_HEADSHOT, SNAPSHOT_HISTORY, OWN_CAN_BUY, OWN_DEFUSER, OWN_CARRYING, OWN_IMMUNE, E_ACTIVE, E_X,
  E_Y, E_Z, E_PITCH, E_YAW,
  E_FLAGS, E_DUCK, E_HEALTH, E_TEAM, E_FIELDS, dequantizeYaw,
} from '../shared/protocol.js';
import { buildMapMesh } from './mapmesh.js';
import { Renderer } from './gl/renderer.js';
import { Decals } from './gl/decals.js';
import { Debris } from './gl/debris.js';
import { Players } from './gl/players.js';
import { PlayerModels } from './gl/playermodels.js';
import { GunMeshes } from './gl/gunmeshes.js';
import { GrenadeFx } from './gl/grenadefx.js';
import { Blasts } from './gl/blast.js';
import { PASS } from './gl/gputimer.js';
import { DynamicResolution, SLOW_MS } from './dynres.js';
import { modelLight } from './gl/skinned.js';
import { crosshairLayout } from './gl/crosshair.js';
import { perspective, viewFromAngles, multiply, invert } from './gl/mat4.js';
import { Input, SELECT_LAST } from './input.js';
import { WeaponView } from './weaponview.js';
import { NetClient } from './net.js';
import { Hud } from './hud.js';
import { Sounds } from './audio.js';
import { SoundScape, gunProfile } from './soundscape.js';
import { InkWords } from './inkwords.js';
import { Spectator, SPEC_EYES, SPEC_ROAM } from './spectate.js';
import { ConsoleWindow } from './console.js';
import { takeHandoff } from './handoff.js';
import { PreviewEditor } from './previewedit.js';
import { Menu } from './menu.js';
import { Radar } from './radar.js';
import { Overview } from '../shared/overview.js';
import { Items } from '../shared/items.js';
import { Hostages } from '../shared/hostages.js';
import { NetGraph } from './netgraph.js';
import { createConsole, watch } from './settings.js';
import { releaseOf, quote } from '../shared/cvars.js';
import {
  PHASE_FREEZE, PHASE_LIVE, GAME_FFA, GAME_DM, GAME_DEMO, GAME_WINGMAN, GAME_ARMSRACE, GAME_DEMOLITION, buyError, applyBuy, itemLabel, ITEM_KEVLAR, ITEM_ASSAULTSUIT, ITEM_DEFUSER,
} from '../shared/economy.js';

const DEG = Math.PI / 180;
const FOV_Y = 73.74 * DEG; // CS:GO fov 90 at 4:3, kept vertical (Hor+)
const ZOOM_RATE = 30; // per second: how fast the view zooms in or out (approximation)
let fov = 90; // current CS:GO-style fov (horizontal at 4:3), eased toward the scope's
const scopeEl = document.getElementById('scope');
let scopeShown = '';
const NOCLIP_SPEED = 800;
const MAX_TICKS_PER_FRAME = 8;
const HISTORY = 64; // commands / predicted states kept (power of two)
const SMOOTH_RATE = 15; // 1/s: how fast a visible prediction correction is blended away
const KILLFEED_MS = 5000;

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const status = document.getElementById('status');
const debug = document.getElementById('debug');
const killfeed = document.getElementById('killfeed');
const deathNotice = document.getElementById('death');
let deathShown = ''; // its display, set only when it changes
const spectator = new Spectator();
const specAngles = new Float32Array(2);
const specTrace = new Trace();
let deadAt = 0, wasDead = false;
let wasSpecTeam = false, specFollowing = false; // last frame: on the spectator team / following someone
const lastCam = new Float32Array(5); // last spectator camera: x, y, z, pitch, yaw

// The console first: settings are read by everything below.
let conWin = null;
const { con, binds, cv } = createConsole((s) => (conWin ? conWin.print(s) : console.log(s)));
conWin = new ConsoleWindow(con);
const netGraph = new NetGraph();

const renderer = new Renderer(canvas, cv.r_lowlatency.bool);
const decals = new Decals(renderer.gl);
const debris = new Debris(renderer.gl);
const players = new Players(renderer.gl);
const guns = new GunMeshes(renderer.gl); // every gun model, shared by first and third person
const models = new PlayerModels(renderer.gl, guns);
const fx = new GrenadeFx(renderer.gl, guns);
models.pass = PASS.MODELS; // its GPU time apart from the effects' (cl_showfps 3)
const overlays = [decals, debris, players, models, fx];
const words = new InkWords(document.getElementById('fx'));
const weaponView = new WeaponView(renderer.gl, FOV_Y, cv, guns);
const input = new Input(canvas);
const hud = new Hud((item) => { // a buy from the menu closes it
  buy(item);
  closeBuyMenu();
});
const menu = new Menu(document.getElementById('menu'), con, cv, binds);
const radar = new Radar(document.getElementById('radar'), cv);
let playing = false; // in a game (online or practice); false: the start menu
const sounds = new Sounds();
const soundTrace = new Trace();
// A wall between the listener and a sound muffles it.
sounds.occluded = (x, y, z) => world !== null &&
  traceHull(world, HULL_POINT, sounds.lx, sounds.ly, sounds.lz, x, y, z, soundTrace).fraction < 0.97;
// Footstep surfaces: water (or slime, lava) at the feet splashes, deeper than the knees
// wades (de_aztec's river); else the texture under the feet (CS:GO material letters).
const liquid = (x, y, z) => {
  const c = pointContents(world, x, y, z);
  return c <= -3 && c >= -5;
};
const scape = new SoundScape(sounds, (x, y, z) => {
  if (!world) return 'hard';
  if (liquid(x, y, z + 2)) return liquid(x, y, z + 24) ? 'wade' : 'water';
  if (!world.surfaces) return 'hard';
  const gm = world.surfaces.surfaceAt(world, 0, x, y, z, 0, 0, -1)[1];
  if (gm === 77 || gm === 71) return 'metal'; // M, G (grates)
  if (gm === 87) return 'wood';
  if (gm === 68 || gm === 75 || gm === 79) return 'soft'; // dirt, snow, foliage
  return 'hard';
});

// A muzzle flash lights the walls round it for a moment (client/gl/flashes.js); a silencer
// keeps it small.
function muzzleLight(x, y, z, quiet) {
  renderer.flashes.add(x, y, z, quiet ? 140 : 260, quiet ? 0.4 : 1, 0.08, performance.now() / 1000);
}
scape.onShot = muzzleLight;
const OFFLINE_MONEY = 16000;

const player = new Player();
const ps = player.ps;
const ws = player.ws;
const shots = new ShotList();
const impacts = new ImpactList();
let tickCount = 1;
let lastButtons = 0;
let lastUseButtons = 0; // buttons of the last tick (the sandbox's +use edge)
let world = null;
const lightSample = new Float32Array(3), lightTarget = new Float32Array(3);
let itemsVersion = -1; // last weapons-on-the-ground list handed to the models
let grenadesVersion = -1; // last grenade list handed to the effects

// Offline, grenades are simulated here, acting on us alone.
const localGrenades = new Grenades();
const flash = { left: 0, total: 0 }; // offline flashbang blindness (online: the snapshot's)
const selfTargets = {
  count: 1,
  alive: () => player.health > 0,
  center: (_i, out) => selfPoint(out, 0),
  eye: (_i, out) => selfPoint(out, eyeOffset(ps)),
  feet: (_i, out) => selfPoint(out, -feetOffset(ps.i[PS_FLAGS])),
  pitch: () => angles[0],
  yaw: () => angles[1],
  hurt: (_i, damage, weapon) => {
    const w = WEAPONS[weapon];
    applyDamage(player, damage, w, w.grenade === 'fire' ? HITGROUP_LEGS : HITGROUP_CHEST);
    if (player.health <= 0) offlineRespawn();
  },
  flash: (_i, seconds) => {
    if (seconds > flash.left) flash.left = flash.total = seconds;
  },
};
function selfPoint(out, dz) {
  out[0] = ps.f[PS_ORIGIN];
  out[1] = ps.f[PS_ORIGIN + 1];
  out[2] = ps.f[PS_ORIGIN + 2] + dz;
}

// Flashbangs: a comic white-out (paper over the print, a starburst where it went off, FLASH!),
// then the frozen afterimage of the moment fading with it (on the GPU: renderer.afterimage);
// the off hand shields the eyes.
const flashEl = document.getElementById('flash');
const flashBurst = flashEl.querySelector('.burst');
const starPolygon = (n, inner) => `polygon(${Array.from({ length: n * 2 }, (_, i) => {
  const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? inner : 50 - (i % 4 ? 0 : 6);
  return `${(50 + Math.cos(a) * r).toFixed(1)}% ${(50 + Math.sin(a) * r).toFixed(1)}%`;
}).join(',')})`;
flashEl.querySelector('.star').style.clipPath = starPolygon(14, 24);
flashEl.querySelector('.core').style.clipPath = starPolygon(10, 30);
const lastFlashPop = new Float64Array(4); // x, y, z, time (ms) of the newest flashbang pop
let flashShown = -1, lastFlashLeft = 0;
function showFlash(left, total) {
  if (left > lastFlashLeft + 0.05) { // a new flash: keep this frame; ears ring; the burst goes where it popped
    sounds.earRing(left);
    renderer.afterimage.capture(canvas.width, canvas.height);
    let sx = 0, sy = 0;
    if (performance.now() - lastFlashPop[3] < 1000) {
      const m = viewProj, [x, y, z] = lastFlashPop;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w > 1) {
        sx = Math.max(-0.8, Math.min(0.8, (m[0] * x + m[4] * y + m[8] * z + m[12]) / w));
        sy = Math.max(-0.8, Math.min(0.8, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w));
      }
    }
    flashBurst.style.setProperty('--x', `${(50 + sx * 50).toFixed(1)}%`);
    flashBurst.style.setProperty('--y', `${(50 - sy * 50).toFixed(1)}%`);
    flashEl.style.setProperty('--r', `${(Math.random() * 10 - 8).toFixed(1)}deg`);
  }
  lastFlashLeft = left;
  // Fully white for the first part (approx. of CS:GO's hold), then fading.
  const hold = total * 0.35, a = left <= 0 ? 0 : left > total - hold ? 1 : left / (total - hold);
  const shown = Math.round(a * 100) / 100;
  weaponView.blind = Math.min(1, shown * 1.4);
  renderer.afterimage.draw(shown * 0.6, canvas.width, canvas.height); // every frame: it is drawn into the canvas
  if (shown === flashShown) return;
  flashShown = shown;
  flashEl.style.opacity = Math.min(1, shown * 1.15);
  flashBurst.style.setProperty('--k', (0.75 + 0.35 * shown).toFixed(2));
}

fx.onEffect = (kind, _weapon, x, y, z) => {
  if (kind === FX_HE) explosion(x, y, z, 0.45);
  else if (kind === FX_FIZZLE) {
    debris.puff(x, y, z, 0.3, 0.3, 0.3, 20);
    sounds.hiss(x, y, z);
  } else if (kind === FX_FLASH || kind === FX_SMOKE || kind === FX_FIRE) {
    debris.puff(x, y, z + 4, 0.8, 0.8, 0.8, 12);
    if (kind === FX_FLASH) {
      sounds.bang(x, y, z);
      lastFlashPop[0] = x;
      lastFlashPop[1] = y;
      lastFlashPop[2] = z;
      lastFlashPop[3] = performance.now();
    }
    else if (kind === FX_SMOKE) {
      sounds.hiss(x, y, z);
      words.smoke(viewProj, x, y, z);
    }
    else {
      for (let i = 0; i < 4; i++) sounds.crackle(x, y, z + 8);
      decals.add(x, y, z + 0.5, 0, 0, 1, 60, Math.random(), 0); // scorched ground
      words.fire(viewProj, x, y, z);
    }
  }
};
fx.onBounce = (x, y, z) => sounds.bounce(x, y, z);
fx.onCrackle = (x, y, z) => words.crackle(viewProj, x, y, z);
let breakables = null;
let breakableColors = null; // rgb per breakable slot, for debris
let doors = null; // doors and buttons: placed for the tick each command runs at, as on the server
let mapLogic = null; // the sandbox runs the map's triggers itself
let cmdOffset = 0; // server tick - command number (newest snapshot): when the server runs a command
const moverSeen = new Uint8Array(MAX_MOVERS);
const moverDir = new Int8Array(MAX_MOVERS); // last tick's, for sounds
const sandboxBodies = [];
const sandboxAct = { x: 0, y: 0, z: 0, yaw: 0 };
const sandboxActs = [sandboxAct];
const sandboxFire = (name, act) => mapLogic.fireAt(tickCount, name, act, 0);
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
let roundSerial = -1; // the server's round starts (RoundState.serial) last seen
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
const blasts = new Blasts(renderer.gl, view); // explosions: the fire faces this camera
overlays.push(blasts);
const viewProj = new Float32Array(16);
const invViewProj = new Float32Array(16);

// Maps that are not the server's maps/: files picked from the disk (name -> ArrayBuffer;
// they go nowhere unless hosted as a room), and the room (server/rooms.js) we play in or
// host: its code, and when we host it, its rcon password and console catalog.
const ownMaps = new Map();
let roomCode = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let roomRcon = '', roomNames = null;

let currentMap = '';
async function loadMap(name) {
  if (!/^[\w-]+$/.test(name)) throw new Error(`bad map name: ${name}`);
  currentMap = name;
  status.textContent = `loading ${name}...`;
  // Our own file, a room's map (from the server's memory) or the server's maps/; the first
  // two come from outside, so they are checked (parseUntrustedBSP).
  let buffer = ownMaps.get(name), untrusted = true;
  if (!buffer) {
    const room = net && net.room;
    const res = await fetch(room ? `/rooms/${room}/map.bsp` : `/maps/${name}.bsp`);
    if (!res.ok) throw new Error(`map ${name}: HTTP ${res.status}`);
    buffer = await res.arrayBuffer();
    untrusted = !!room;
  }
  const t0 = performance.now();
  const bsp = untrusted ? parseUntrustedBSP(buffer) : parseBSP(buffer);
  const mesh = buildMapMesh(bsp);
  renderer.loadMap(mesh, bsp);
  decals.clear();
  debris.clear();
  world = CollisionWorld.fromBSP(bsp);
  world.surfaces = new SurfaceMap(bsp);
  world.bombSites = new BombSites(bsp);
  radar.setMap(new Overview(bsp, world), world.bombSites);
  breakables = new Breakables(bsp, world);
  breakableColors = mesh.breakableColors;
  doors = new Doors(bsp, world, breakables.count);
  mapLogic = new MapLogic(bsp, doors);
  moverDir.fill(0);
  renderer.setMovers(doors);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name}: ${mesh.numVerts} verts, ${(mesh.opaqueCount + mesh.cutoutCount + mesh.skyCount + mesh.transCount) / 3} tris, ` +
    `lightmap ${mesh.lightmap.width}x${mesh.lightmap.height}, ${world.ents.length} collision ents, ` +
    `${breakables.count} breakables, ${doors.count} doors / buttons, built in ${ms} ms`);

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
  weaponView.flashUntil = 0; // no muzzle flash carried over from before the respawn
}

// A new round wipes what the last one left on the map: bullet holes, scorches, shards
// and chunks, explosions (breakables, doors, the ground and grenades come from the server).
function clearRoundMarks() {
  decals.clear();
  debris.clear();
  blasts.clear();
  renderer.flashes.clear();
}

// Offline round restart: breakables come back, we spawn at our team's first spawn.
function offlineRespawn() {
  breakables.reset(world);
  doors.reset(world);
  mapLogic.reset(tickCount);
  renderer.clearBroken();
  clearRoundMarks();
  localGrenades.clear();
  fx.clear();
  flash.left = 0;
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
    if (!melee) words.wall(viewProj, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
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
// The dot-free zone round the crosshair (px, before r_crosshair_clearzone): just past the
// arms (they open with the spread, last frame's), the middle of a scope; none when nothing
// is aimed with.
const calmLayout = {};
function calmRadius(height) {
  if (weaponView.scoped) return height * 0.04;
  if (weaponView.hidden || weaponView.spread < 0 || !cv.crosshair.bool) return 0;
  const L = crosshairLayout(cv, height, weaponView.spread, calmLayout);
  return Math.max(height * 0.02, (L.gap + L.len + Math.max(L.outline, 0)) * 1.6 + 4);
}
// Can we take control of player `id` (a living bot of our team, mid-round, not deathmatch)?
function canTakeOver(id) {
  if (!net || id < 0 || (gameMode() & (GAME_DM | GAME_DEMO))) return false;
  const phase = net.own.round.phase, r = id * E_FIELDS;
  return (phase === PHASE_FREEZE || phase === PHASE_LIVE) && interp[r + E_HEALTH] > 0 &&
    interp[r + E_TEAM] === player.team && (net.names[id] || '').startsWith('BOT ');
}
// The bomb as of the newest snapshot (defusing is predicted against it).
const simBomb = () => (net ? net.own.bomb : null);

// Runs our commands after `from` again on top of the state we were just given.
function replayFrom(from) {
  for (let t = from + 1; t < tickCount; t++) {
    if (!cmds.has(t)) continue;
    const k = t & cmds.mask;
    if (player.health > 0) {
      doors.apply(world, t + cmdOffset);
      runCommand(world, player, cmds.buttons[k], cmds.select[k], cmds.pitch[k], cmds.yaw[k], t, replayShots, frozen(),
        simBomb(), demo());
    }
    storePrediction(t);
  }
}

// Buy menu: the server decides online; offline it is instant (anywhere, $16000).
// The server's game mode (GAME_* bits; offline: none).
const gameMode = () => (net ? net.own.round.mode : 0);
const demo = () => (gameMode() & GAME_DEMO) !== 0;
const freeBuys = () => (gameMode() & (GAME_DM | GAME_DEMO)) !== 0; // deathmatch and the demo: no money
const gunGame = () => (gameMode() & (GAME_ARMSRACE | GAME_DEMOLITION)) !== 0; // weapons earned by kills: no money
// Our place in the gun game modes' weapon list for the round bar ('' in the others), rebuilt
// only when it changes.
const progressKey = [-1, -1, -1];
let progressText = '';
function progress() {
  const mode = gameMode() & (GAME_ARMSRACE | GAME_DEMOLITION);
  const list = mode & GAME_ARMSRACE ? ARMS_RACE : mode & GAME_DEMOLITION ? DEMOLITION : null;
  const level = list && net && selfId >= 0 ? Math.min(net.scores[selfId] || 0, list.length - 1) : -1;
  const K = progressKey;
  if (K[0] === mode && K[1] === level && K[2] === player.team) return progressText;
  K[0] = mode;
  K[1] = level;
  K[2] = player.team;
  if (level < 0) return (progressText = '');
  const next = level + 1 < list.length ? `next: ${itemLabel(levelWeapon(list, level + 1, player.team === TEAM_CT))}`
    : mode & GAME_ARMSRACE ? 'the knife: one kill to win' : 'the last weapon';
  return (progressText = `level ${level + 1}/${list.length}   ${next}`);
}

// The top scorer (deathmatch): { name, score, self, tied } or null.
// Per-frame arguments and callbacks, made once (no garbage per frame).
const graphInfo = { fps: 0, rtt: 0, compared: 0, corrected: 0, interpTicks: 0 };
const leaderInfo = { name: '', score: 0, self: false, tied: false };
const rowFeet = (rows, r) => rows[r + E_Z] - feetOffset(rows[r + E_FLAGS]);
const rowAlive = (id) => id === selfId ? player.health > 0 : interp[id * E_FIELDS + E_HEALTH] > 0;
const specSight = (x0, y0, z0, x1, y1, z1) => traceHull(world, HULL_POINT, x0, y0, z0, x1, y1, z1, specTrace).fraction;
let specKey = -3; // what the spectator notice says (-2 nothing, -1 roaming, else target and HP)

function leader() {
  if (!net) return null;
  let best = -1, tied = false;
  for (let id = 0; id < MAX_PLAYERS; id++) {
    if (!net.names[id] || net.teams[id] === TEAM_SPECTATOR) continue;
    if (best >= 0 && net.scores[id] === net.scores[best]) tied = true;
    else if (best < 0 || net.scores[id] > net.scores[best]) {
      best = id;
      tied = false;
    }
  }
  if (best < 0) return null;
  const L = leaderInfo;
  L.name = net.names[best];
  L.score = net.scores[best];
  L.self = best === selfId;
  L.tied = tied;
  return L;
}

function buy(item) {
  if (net) {
    if (!buyError(player, item, (net.own.flags & OWN_CAN_BUY) !== 0, freeBuys())) net.buy(item);
  } else if (!buyError(player, item, true)) {
    applyBuy(player, item);
  }
}

function applySnapshot() {
  const own = net.own;
  netStats.rtt = (tickCount - own.lastCmd) * TICK_DT * 1000;
  cmdOffset = net.latestSeq - own.lastCmd;
  applyMovers(own.movers);
  player.defuser = (own.flags & OWN_DEFUSER) !== 0; // before any replay: it sets the defuse time
  player.carrying = (own.flags & OWN_CARRYING) !== 0; // and this the speed
  if (own.flags & OWN_IMMUNE) hud.flash('Spawn protection', 250, performance.now()); // until we shoot

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
  player.team = own.team; // jointeam without a respawn (spectators, mid-round)
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

  // Wingman plays one bomb site: predict planting (and draw the radar) with that one only.
  if ((own.round.mode & GAME_WINGMAN) && world.bombSites.count > 1) {
    world.bombSites.keepOnly(1);
    radar.setSites(world.bombSites);
  }
  if (own.round.serial !== roundSerial) {
    if (roundSerial >= 0) clearRoundMarks();
    roundSerial = own.round.serial;
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

// Doors and buttons as the server has them (those absent are closed at rest).
function applyMovers(mv) {
  moverSeen.fill(0);
  for (let m = 0; m < mv.count; m++) {
    const k = mv.mover[m];
    if (k >= doors.count) continue;
    moverSeen[k] = 1;
    doors.setState(k, mv.from[m], mv.dir[m], mv.sign[m], mv.t0[m]);
  }
  for (let k = 0; k < doors.count; k++) if (!moverSeen[k]) doors.setState(k, 0, 0, 1, 0);
}

// A door starting or stopping: its sound; one that starts moving loses its decals.
function moverSounds() {
  for (let k = 0; k < doors.count; k++) {
    const dir = doors.dir[k], was = moverDir[k];
    if (dir === was) continue;
    moverDir[k] = dir;
    const e = world.ents[doors.ent[k]];
    const x = (e.amin[0] + e.amax[0]) / 2, y = (e.amin[1] + e.amax[1]) / 2, z = (e.amin[2] + e.amax[2]) / 2;
    if (was === 0) {
      decals.removeOwner(doors.slot(k));
      const left = dir > 0 ? 1 - doors.from[k] : doors.from[k];
      sounds.doorMove(x, y, z, left / doors.rate[k] * TICK_DT, doors.kind[k] === MOVER_ROTATING);
    } else if (dir === 0) {
      sounds.doorStop(x, y, z);
    }
  }
}

// Sandbox: the map's triggers and doors run here (touch, +use), the player pushed by them.
function sandboxDoors(t, alive) {
  const f = ps.f;
  sandboxAct.x = f[PS_ORIGIN];
  sandboxAct.y = f[PS_ORIGIN + 1];
  sandboxAct.z = f[PS_ORIGIN + 2];
  sandboxAct.yaw = angles[1];
  sandboxBodies.length = 0;
  if (alive && !noclip) sandboxBodies.push(ps);
  mapLogic.update(t, alive ? sandboxActs : []);
  doors.update(world, t, sandboxBodies, sandboxFire);
}

function sandboxTouches(t, buttons) {
  for (let i = 0; i < touchedCount; i++) {
    const k = doors.ofEnt(touched[i]);
    if (k >= 0) doors.touch(k, t, sandboxAct);
  }
  if (!(buttons & IN_USE) || (lastUseButtons & IN_USE)) return;
  const f = ps.f, cp = Math.cos(angles[0] * DEG);
  const k = doors.findUse(world, f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2], f[PS_ORIGIN], f[PS_ORIGIN + 1],
    f[PS_ORIGIN + 2] + eyeOffset(ps), cp * Math.cos(angles[1] * DEG), cp * Math.sin(angles[1] * DEG),
    -Math.sin(angles[0] * DEG));
  if (k >= 0) doors.use(k, t, sandboxAct);
}

// Other players' shots and the kill feed.
function applyEvents() {
  const ev = net.events;
  for (let k = 0; k < ev.shots; k++) {
    const x = ev.pos[k * 3], y = ev.pos[k * 3 + 1], z = ev.pos[k * 3 + 2];
    if (ev.kind[k] === SHOT_BLOOD) {
      debris.puff(x, y, z, 0.55, 0.05, 0.04, 6);
      if (ev.shooter[k] === selfId) { // we hit someone
        sounds.hit(false);
        words.hit(viewProj, x, y, z);
      }
    } else if (!breakables.broken[ev.breakable[k]] || !ev.breakable[k]) {
      sounds.impact(x, y, z);
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
    killBody(ev.killer[k], ev.victim[k], (ev.killFlags[k] & KILL_HEADSHOT) !== 0, id);
    if (ev.killer[k] === selfId && (ev.killFlags[k] & KILL_HEADSHOT)) sounds.hit(true);
    if (ev.killer[k] === selfId && ev.victim[k] !== selfId) words.kill((ev.killFlags[k] & KILL_HEADSHOT) !== 0);
  }
}

// A comic explosion: the fireball and smoke (client/gl/blast.js), dark chunks and embers,
// for the bomb a scorch on the ground under it.
function explosion(x, y, z, size = 1) {
  blasts.add(x, y, z, size, world && world.surfaces);
  renderer.flashes.add(x, y, z + 40 * size, 700 * size, 1, 0.25 + 0.35 * size, performance.now() / 1000);
  debris.puff(x, y, z + 24 * size, 0.2, 0.16, 0.12, Math.round(40 * size));
  debris.puff(x, y, z + 40 * size, 1.0, 0.6, 0.12, Math.round(25 * size));
  if (size >= 1) decals.add(x, y, z + 0.5, 0, 0, 1, 72, Math.random(), 0);
  sounds.explosion(Math.min(1, size * Sounds.falloff(Math.hypot(x - eye[0], y - eye[1], z - eye[2]), 1500)));
  words.explosion(viewProj, x, y, z + 300 * size, size); // above the fireball
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

// How the victim's body dies (client/anim/playeranim.js die): the shot's direction from
// the killer (ours from the eye), and for a headshot how far it may be thrown back before
// a wall (one trace at chest height) and how far down the floor is there (a second one;
// no floor within 72 units: not thrown). A death without a shooter collapses in place.
const bodyTrace = new Trace();
function killBody(killer, victim, headshot, seed) {
  if (victim === selfId || killer === victim || !world) return;
  const r = victim * E_FIELDS, vx = interp[r + E_X], vy = interp[r + E_Y], vz = rowFeet(interp, r);
  let kx, ky;
  if (killer === selfId) {
    kx = eye[0];
    ky = eye[1];
  } else {
    const kr = killer * E_FIELDS;
    if (!interp[kr + E_ACTIVE]) return;
    kx = interp[kr + E_X];
    ky = interp[kr + E_Y];
  }
  let dx = vx - kx, dy = vy - ky;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  dx /= len;
  dy /= len;
  let dist = 0, drop = 0;
  if (headshot) {
    const reach = 48;
    traceHull(world, HULL_POINT, vx, vy, vz + 36, vx + dx * reach, vy + dy * reach, vz + 36, bodyTrace);
    dist = Math.max(0, bodyTrace.fraction * reach - 6);
    const lx = vx + dx * dist, ly = vy + dy * dist;
    traceHull(world, HULL_POINT, lx, ly, vz + 36, lx, ly, vz - 72, bodyTrace);
    if (bodyTrace.fraction === 1) dist = 0;
    else drop = Math.max(0, vz - bodyTrace.endz);
  }
  models.anim[victim].die(dx, dy, headshot, dist, drop, seed);
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
  if (!playing) return;
  prevOrigin[0] = ps.f[PS_ORIGIN];
  prevOrigin[1] = ps.f[PS_ORIGIN + 1];
  prevOrigin[2] = ps.f[PS_ORIGIN + 2];
  prevEye = eyeOffset(ps);
  prevPunchP = viewPunchPitch(ws);
  prevPunchY = viewPunchYaw(ws);

  let viewTick = 0;
  if (reconnecting) return;
  if (net) {
    if (net.poll()) applySnapshot();
    while (net.prints.length) conWin.print(net.prints.shift());
    if (net.changelevel || (net.closed && net.closeReason === 'changelevel')) {
      reconnect();
      return;
    }
    if (synced) applyEvents();
    if (net.closed) return leaveGame(`Disconnected: ${net.closeReason}`);
    if (!synced) return;
    viewTick = serverClock - cv.cl_interp_ratio.number;
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
  if (net) doors.apply(world, t + cmdOffset);
  else sandboxDoors(t, alive);
  if (noclip && !net) {
    noclipTick(buttons);
    weaponTick(ws, ps, buttons, select, angles[0], angles[1], t, shots);
  } else if (alive) {
    const died = runCommand(world, player, buttons, select, angles[0], angles[1], t, shots, frozen(), simBomb(), demo());
    if (!net) sandboxTouches(t, buttons);
    if (died && !net) offlineRespawn();
  }
  lastUseButtons = buttons;
  moverSounds();
  if (shots.count) {
    // Free for all: bullets stop at everyone (team 0 skips nobody), as on the server.
    resolveShots(world, breakables, ws, shots, impacts, net ? targets : null, selfId,
      gameMode() & GAME_FFA ? 0 : player.team);
    showImpacts();
  }
  if (!net) { // offline grenades
    if (ws.f[WS_EVENTS] & WEV_THROW) {
      const thrown = ws.f[WS_THROWN];
      localGrenades.throw(world, Math.floor(thrown / 4), 0, player.team, ps.f[PS_ORIGIN], ps.f[PS_ORIGIN + 1],
        ps.f[PS_ORIGIN + 2] + eyeOffset(ps), angles[0], angles[1], ps.f[PS_VEL], ps.f[PS_VEL + 1], ps.f[PS_VEL + 2],
        thrown & 3);
    }
    localGrenades.update(world, selfTargets);
    fx.push(localGrenades, t);
    flash.left = Math.max(0, flash.left - TICK_DT);
  } else if (net.grenadesVersion !== grenadesVersion) {
    grenadesVersion = net.grenadesVersion;
    fx.push(net.grenades, net.grenadeTick);
  }

  if (net) {
    // Dead players keep sending commands: the server uses them up, and they carry acks.
    cmds.put(t, buttons, select, angles[0], angles[1], viewTick);
    storePrediction(t);
    net.sendCmds(cmds, t);
  }
  // The weapon's events of this tick: none when its tick did not run (dead: the state keeps
  // the last command's events, and a shot there kept the muzzle flash lit until respawn).
  const ran = alive || (noclip && !net);
  weaponView.onTick(ran ? ws.f[WS_EVENTS] : 0, t * TICK_DT);
  if (alive) {
    scape.ownEvents(ws.f[WS_EVENTS], activeWeapon(ws), silenced(ws, ws.f[WS_ACTIVE]));
    const w = activeWeapon(ws);
    if ((ws.f[WS_EVENTS] & WEV_FIRE) && w && w.gun) {
      words.shot(gunProfile(w, silenced(ws, ws.f[WS_ACTIVE])), performance.now());
      // Our own flash, a little ahead of the eye along the view.
      const p = angles[0] * DEG, yw = angles[1] * DEG, c = Math.cos(p) * 24;
      muzzleLight(eye[0] + Math.cos(yw) * c, eye[1] + Math.sin(yw) * c, eye[2] - Math.sin(p) * 24,
        silenced(ws, ws.f[WS_ACTIVE]));
    }
    scape.ownMove(ps, buttons & IN_SPEED, ps.f[PS_ORIGIN], ps.f[PS_ORIGIN + 1],
      ps.f[PS_ORIGIN + 2] - feetOffset(ps.i[PS_FLAGS]));
  }
  tickCount++;
}

let last = performance.now();
let accumulator = 0;
let frames = 0;
let fpsTime = last;
let frameMsMax = 0;
let fps = 0;
let cpuSim = 0, cpuDraw = 0; // ms summed over the readout's window (cl_showfps 3)
let gpuText = '';
const dynres = new DynamicResolution(); // r_dynres
// benchmark: the gaps between frames over a few seconds, then a report in the console.
const bench = { until: 0, seconds: 0, gaps: new Float32Array(8192), n: 0, cpu: 0, ctx: null };

// The scene's render resolution relative to the canvas, as a percentage (r_dynres, mat_viewportscale).
const renderScale = () =>
  `${Math.round(100 * renderer.renderScale)}%${cv.r_dynres.bool && dynres.print < 1 ? `, print ${Math.round(100 * dynres.print)}%` : ''}${renderer.style.fast ? ', fast ink' : ''}`;

function benchmarkReport() {
  const { gaps, n } = bench;
  const sorted = Array.from(gaps.subarray(0, n)).sort((a, b) => a - b);
  const at = (q) => (n ? sorted[Math.min(n - 1, Math.floor(n * q))] : 0).toFixed(1);
  let slow = 0;
  for (let i = 0; i < n; i++) if (gaps[i] > SLOW_MS) slow++;
  const gpu = renderer.timer.report();
  con.out(bench.ctx, [
    `benchmark ${bench.seconds} s: ${(n / bench.seconds).toFixed(1)} fps, ${(100 * slow / Math.max(1, n)).toFixed(0)}% slow ` +
      `(over ${SLOW_MS} ms), res ${renderScale()}${cv.r_dynres.bool ? ' (r_dynres)' : ''}`,
    `frame ms: median ${at(0.5)} · 95% ${at(0.95)} · 99% ${at(0.99)} · worst ${at(1)}`,
    `cpu: ${(bench.cpu / Math.max(1, n)).toFixed(2)} ms a frame (ticks + building the frame)`,
    gpu || 'gpu: no timings',
  ].join('\n'));
  bench.until = 0;
}

con.command('benchmark', (a, ctx) => {
  if (!playing) return con.out(ctx, 'benchmark: start a game first');
  bench.seconds = Math.min(60, Math.max(2, +a[1] || 10));
  bench.until = performance.now() + bench.seconds * 1000;
  bench.n = 0;
  bench.cpu = 0;
  bench.ctx = ctx;
  renderer.timer.report(); // a fresh window for the GPU times
  con.out(ctx, `benchmark: measuring ${bench.seconds} s...`);
}, 'benchmark [seconds]: frame rate, slow frames, CPU and GPU time per pass over 10 s (or the given time)');

function frame(now) {
  // The next frame first: a frame that throws (a bug) then costs one frame, not the game
  // (the error still shows in the console).
  requestAnimationFrame(frame);
  if (menu.visible) menu.frameWindow(backdrop);
  if (!playing) { // the start menu: nothing runs; the settings window shows a backdrop scene
    last = now;
    accumulator = 0;
    if (backdrop) drawBackdrop(now);
    return;
  }
  // Practice pauses with the pause menu, like a listen server: the worker's ticks stop
  // (bots, the round clock, timeouts) and so do ours; the frame still draws. sv_pausable 0
  // keeps it running (testing: the game goes on while the menu is up or the mouse is lost).
  const paused = localWorker !== null && menu.visible && menu.inGame && cv.sv_pausable.bool;
  if (paused !== localPaused) {
    localPaused = paused;
    if (localWorker) localWorker.postMessage({ type: 'pause', on: paused });
  }
  const gap = now - last;
  const elapsed = paused ? 0 : gap / 1000;
  frameMsMax = Math.max(frameMsMax, gap);
  if (cv.r_dynres.bool) dynres.frame(gap, now);
  if (bench.until && bench.n < bench.gaps.length) bench.gaps[bench.n++] = gap;
  last = now;

  // Scopes: CS:GO fovs per zoom level; sensitivity scales with zoom_sensitivity_ratio_mouse.
  const held = activeWeapon(ws);
  const zoom = held && held.altKind === 'scope' && player.health > 0 ? ws.f[WS_ZOOM] : 0;
  const fovTarget = zoom ? held.zoomFov[zoom] : 90;
  fov += (fovTarget - fov) * (1 - Math.exp(-Math.min(elapsed, 0.1) * ZOOM_RATE));
  input.sensitivity = cv.sensitivity.number * (zoom ? cv.zoom_sensitivity_ratio_mouse.number * fovTarget / 90 : 1);
  const scope = zoom ? (held.name === 'aug' || held.name === 'sg556' ? 'dot' : 'cross') : '';
  if (scope !== scopeShown) {
    scopeShown = scope;
    scopeEl.className = scope;
    weaponView.scoped = scope !== '';
  }
  input.mYaw = cv.m_yaw.number;
  input.mPitch = cv.m_pitch.number;
  input.rawInput = cv.m_rawinput.bool;
  if (sounds.volume !== cv.volume.number) sounds.setVolume(cv.volume.number);
  sounds.stepVolume = cv.snd_footstep_volume.number;
  input.applyMouse(angles);
  const t0 = performance.now();
  accumulator += elapsed;
  if (serverClock >= 0) serverClock += Math.min(elapsed, 0.25) * TICK_RATE;
  let ticks = 0;
  while (accumulator >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
    tick();
    accumulator -= TICK_DT;
    ticks++;
  }
  if (ticks === MAX_TICKS_PER_FRAME) accumulator = 0; // fell far behind (tab was hidden)

  const t1 = performance.now();
  renderer.timer.on = cv.cl_showfps.number >= 3 || bench.until > 0;
  draw(now, accumulator / TICK_DT, Math.min(elapsed, 0.1));
  renderer.timer.endFrame();
  if (previewEdit) previewEdit.draw();
  // r_drawrepeat: the same frame again (no time passing), for the GPU readout.
  for (let i = 1; i < cv.r_drawrepeat.number; i++) {
    draw(now, accumulator / TICK_DT, 0);
    renderer.timer.endFrame();
  }
  cpuSim += t1 - t0;
  cpuDraw += performance.now() - t1;
  if (bench.until) {
    bench.cpu += performance.now() - t0;
    if (now >= bench.until) benchmarkReport();
  }

  frames++;
  if (now - fpsTime >= 250) {
    fps = frames * 1000 / (now - fpsTime);
    // cl_showfps / cl_showpos (top left).
    const f = ps.f;
    const fl = ps.i[PS_FLAGS];
    const lines = [];
    if (cv.cl_showfps.number) {
      lines.push(`fps: ${fps.toFixed(0)}${cv.cl_showfps.number > 1 ? `  worst frame: ${frameMsMax.toFixed(1)} ms  res ${renderScale()}` : ''}`);
    }
    if (cv.cl_showfps.number >= 3) {
      // CPU: the simulation ticks, then building and sending the frame (the draw calls).
      lines.push(`cpu: sim ${(cpuSim / frames).toFixed(2)} ms · frame ${(cpuDraw / frames).toFixed(2)} ms`);
      if (!bench.until) gpuText = renderer.timer.report() || gpuText; // the benchmark reads its own window
      if (gpuText) lines.push(gpuText);
    }
    cpuSim = cpuDraw = 0;
    if (cv.cl_showpos.number) {
      lines.push(`pos: ${f[0].toFixed(0)} ${f[1].toFixed(0)} ${f[2].toFixed(0)}`,
        `ang: ${angles[0].toFixed(1)} ${angles[1].toFixed(1)}`,
        `vel: ${Math.hypot(f[PS_VEL], f[PS_VEL + 1]).toFixed(1)}  z ${f[PS_VEL + 2].toFixed(0)}` +
        `${fl & FL_ONGROUND ? '  ground' : ''}${fl & FL_DUCKING ? '  duck' : ''}${noclip ? '  NOCLIP' : ''}`);
    }
    const text = lines.join('\n');
    if (debug.textContent !== text) debug.textContent = text;
    frames = 0;
    fpsTime = now;
    frameMsMax = 0;
  }
  const gi = graphInfo;
  gi.fps = fps;
  gi.rtt = netStats.rtt;
  gi.compared = netStats.compared;
  gi.corrected = netStats.corrected;
  gi.interpTicks = cv.cl_interp_ratio.number;
  netGraph.update(cv.net_graph.bool, now, net, gi);
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
  let pitch = angles[0] + prevPunchP + (viewPunchPitch(ws) - prevPunchP) * alpha;
  let yaw = angles[1] + prevPunchY + (viewPunchYaw(ws) - prevPunchY) * alpha;

  // Dead: after a moment, follow a living player (client/spectate.js). The spectator
  // team follows anyone at once or roams free.
  const dead = player.health <= 0;
  if (dead && !wasDead) deadAt = now;
  const specTeam = player.team === TEAM_SPECTATOR;
  if (specTeam && !wasSpecTeam) { // just joined the spectators: roam from our eye (or a spawn)
    const s = spawns[TEAM_CT][0] || spawns[TEAM_T][0];
    if (!wasDead) spectator.place(eye[0], eye[1], eye[2]);
    else if (s) spectator.place(s[0], s[1], s[2] + 28); // spawn origins are hull centers; eye 28 up
  }
  wasSpecTeam = specTeam;
  wasDead = dead;
  const buttons = input.locked ? input.buttons : 0;
  const interpolated = net && synced && interpolatePlayers(serverClock - cv.cl_interp_ratio.number, interp);
  const roamedBefore = spectator.mode === SPEC_ROAM;
  const spectating = interpolated && dead &&
    spectator.update(interp, selfId, player.team, (now - deadAt) / 1000, buttons, specTeam);
  const roaming = spectating && spectator.mode === SPEC_ROAM;
  if (roaming && !roamedBefore && specFollowing) { // from following someone: go on from that view
    spectator.place(lastCam[0], lastCam[1], lastCam[2]);
    angles[0] = lastCam[3];
    angles[1] = lastCam[4];
  }
  const inEyes = spectating && spectator.mode === SPEC_EYES;
  // CS:GO's bot takeover: E while watching a living bot of our team (the server checks).
  const takeable = spectating && !roaming && !specTeam && canTakeOver(spectator.target);
  if (takeable && spectator.use) net.command(`takeover ${spectator.target}`);
  if (spectating) {
    if (roaming) spectator.fly(buttons, angles[0], angles[1], dt);
    spectator.camera(interp, eye, specAngles, specSight);
    pitch = roaming ? angles[0] : specAngles[0];
    yaw = roaming ? angles[1] : specAngles[1];
    lastCam[0] = eye[0];
    lastCam[1] = eye[1];
    lastCam[2] = eye[2];
    lastCam[3] = pitch;
    lastCam[4] = yaw;
  }
  specFollowing = spectating && !roaming;
  // Spectators have no health, armor, ammo or money of their own to show.
  document.body.classList.toggle('spectator', specTeam);
  document.body.classList.toggle('nostats', specTeam && !inEyes);

  if (interpolated) {
    const boxes = cv.cl_showhitboxes.bool;
    const hidden = inEyes ? spectator.target : selfId; // not our own model, nor the one we see through
    players.update(interp, 0, hidden, boxes);
    models.update(interp, 0, hidden, dt, world && world.surfaces, !boxes);
    if (net.itemsVersion !== itemsVersion) {
      itemsVersion = net.itemsVersion;
      models.setItems(net.items, world && world.surfaces, now);
    }
    models.updateItems(now, selfId);
    models.updateHostages(net.hostages, dt, world && world.surfaces);
    const b = net.own.bomb;
    models.setBomb(b.state === BOMB_DROPPED || b.state === BOMB_PLANTED || b.state === BOMB_DEFUSED, b.x, b.y, b.z, 0,
      b.state === BOMB_PLANTED && now - lastBeep < 120, world && world.surfaces);
  }
  if (net && synced) bombBeeps(now);

  // r_hidpi: the screen's own pixels (up to 2 per page pixel) for crisp ink on high-DPI
  // screens; lines and dots keep their size (they scale with the canvas height).
  // r_dynres: the render scale (the scene's resolution under the full-resolution print)
  // lower while frames come late, down to half the canvas.
  const aspect = applyVideoSettings();
  renderer.zoom = 90 / fov;
  renderer.begin();
  const fovY = 2 * Math.atan(Math.tan(fov / 2 * DEG) * 0.75);
  weaponView.fovY = fovY; // the crosshair's spread circle
  perspective(proj, fovY, aspect, 4, 16384);
  viewFromAngles(view, eye[0], eye[1], eye[2], pitch, yaw);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  debris.update(dt, world);
  blasts.update(now / 1000);
  fx.update(net ? serverClock - cv.cl_interp_ratio.number : tickCount - 1 + alpha, world && world.surfaces);
  sounds.listen(eye[0], eye[1], eye[2], yaw);
  scape.effects(fx.cur, now / 1000, dt);
  if (net && synced) {
    scape.others(interp, selfId, dt, rowFeet);
  }
  renderer.render(viewProj, invViewProj, eye, now / 1000, overlays);

  // The radar centers on whoever we see the game through.
  const watched = spectating && !roaming ? spectator.target : -1, w = watched * E_FIELDS;
  radar.draw(playing, watched >= 0 ? interp[w + E_X] : eye[0], watched >= 0 ? interp[w + E_Y] : eye[1],
    watched >= 0 ? interp[w + E_Z] : eye[2], yaw, interpolated ? interp : null, selfId, watched, player.team,
    (gameMode() & GAME_FFA) !== 0, net ? net.own.bomb : null, net ? net.hostages : null, now);
  hud.update(net ? net.own.round : null, net ? net.own.bomb : null, player.money, now, leader(), progress());
  document.body.classList.toggle('dm', freeBuys() || gunGame()); // no money in deathmatch, the demo, the gun games
  const action = ws.f[WS_ACTION];
  const simTime = (tickCount - 1 + alpha) * TICK_DT;
  const actionTime = action === ACTION_PLANT ? PLANT_TIME : player.defuser ? DEFUSE_TIME_KIT : DEFUSE_TIME;
  const picking = net && !action && player.health > 0 ? net.own.useProgress : 0;
  hud.bombStatus(ws.f[WS_SLOTS + SLOT_C4 * 3] > 0 && player.health > 0,
    world.bombSites.touches(f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2], 16, 16, 36),
    action === ACTION_PLANT ? 'Planting the bomb' : action === ACTION_DEFUSE ? 'Defusing the bomb'
    : picking > 0 ? 'Picking up the hostage' : '',
    picking > 0 ? picking : 1 - (ws.f[WS_ACTION_END] - simTime) / actionTime);
  hud.refreshMenu(player, net ? (net.own.flags & OWN_CAN_BUY) !== 0 : true, freeBuys());
  hud.scoreboard((input.buttons & IN_SCORE) !== 0 && input.locked, net, selfId, rowAlive);

  weaponView.hidden = dead && !inEyes;
  const target = spectator.target * E_FIELDS;
  weaponView.team = inEyes ? interp[target + E_TEAM] : player.team;
  // The held weapon is lit by the map under the player, eased like other models.
  const lx = inEyes ? interp[target + E_X] : f[PS_ORIGIN], ly = inEyes ? interp[target + E_Y] : f[PS_ORIGIN + 1];
  const lz = inEyes ? interp[target + E_Z] : f[PS_ORIGIN + 2];
  if (world && world.surfaces.lightAt(lightSample, lx, ly, lz)) {
    modelLight(lightTarget, lightSample);
    const k = 1 - Math.exp(-dt * 8);
    for (let c = 0; c < 3; c++) weaponView.light[c] += (lightTarget[c] - weaponView.light[c]) * k;
  }
  const deathDisplay = dead && net ? 'block' : 'none';
  if (deathDisplay !== deathShown) deathNotice.style.display = deathShown = deathDisplay;
  // The spectator notice, rebuilt only when what it says changes.
  const key = ((!spectating ? -2 : roaming ? -1 : spectator.target * 1024 + interp[target + E_HEALTH]) * 2 +
    (specTeam ? 1 : 0)) * 2 + (takeable ? 1 : 0);
  if (key !== specKey) {
    specKey = key;
    const modes = specTeam ? 'Jump: eyes / chase / free roam' : 'Jump: eyes / chase';
    const spec = !spectating ? '' : roaming ? `Free roam\nMouse1 / Mouse2: follow a player · ${modes}`
      : `Spectating ${net.names[spectator.target] || 'player'} · ${interp[target + E_HEALTH]} HP\n` +
        (takeable ? `E: take control of ${net.names[spectator.target]}\n` : '') +
        `Mouse1 / Mouse2: next / previous · ${modes}`;
    deathNotice.style.whiteSpace = 'pre';
    if (spec) deathNotice.textContent = spec;
  }
  renderer.timer.mark(PASS.VIEW);
  if (inEyes) {
    spectator.syncWeapon(interp, now / 1000, dt, weaponView);
    weaponView.draw(canvas.height, aspect, spectator.ws, spectator.ps, 0, now / 1000, dt,
      interp[target + E_HEALTH], player.armor);
  } else if (!preview) { // the editor's 3D view shows the map alone
    weaponView.draw(canvas.height, aspect, ws, ps, lastButtons, simTime, dt, Math.max(player.health, 0),
      player.armor);
  }
  // Print the frame, then what goes over it; the flashbang's afterimage is taken from it.
  renderer.composite();
  words.enabled = cv.cl_comicwords.bool && cv.cl_drawhud.bool;
  words.update(now);
  if (net) showFlash(player.health > 0 ? net.own.flashLeft : 0, net.own.flashTotal);
  else showFlash(flash.left, flash.total);
  renderer.timer.mark(PASS.OVER);
  if (!preview) weaponView.drawCrosshair(canvas.width, canvas.height);
}

// The video cvars into the renderer, sizing the canvas and the G-buffer; returns the aspect.
function applyVideoSettings() {
  const most = cv.mat_viewportscale.number;
  dynres.min = Math.min(1, 0.5 / most);
  const aspect = renderer.resize(most * (cv.r_dynres.bool ? dynres.factor : 1),
    (cv.r_hidpi.bool ? Math.min(2, devicePixelRatio || 1) : 1) * (cv.r_dynres.bool ? dynres.print : 1));
  const style = renderer.style;
  style.comic = cv.r_comic.bool;
  style.ink = cv.r_inkwidth.number;
  style.dots = cv.r_halftone.number;
  style.bands = cv.r_shadebands.number;
  style.lift = cv.r_shadowlift.number;
  style.soft = cv.r_halftone_style.number >= 1;
  style.calm = calmRadius(canvas.height) * cv.r_crosshair_clearzone.number;
  renderer.novis = cv.r_novis.bool;
  models.farLod = cv.r_lod_dist.number;
  style.fast = cv.r_inkfast.bool;
  return aspect;
}

// The Video tab's window at the start menu: a map drawn behind the menu from a spawn,
// the view swaying slowly, nothing else running (no players, ticks or sounds). The map
// stays loaded; a game loads its own. `backdrop` is set while the window is open.
let backdrop = false;
let backdropLoading = false;
input.canLock = () => !menu.visible; // a click in the window (a hole in the menu) stays a menu click
menu.onWindow = (open) => {
  if (playing) return;
  if (!open) {
    backdrop = false;
    return;
  }
  if (world) {
    backdrop = true;
    return;
  }
  if (backdropLoading) return;
  backdropLoading = true;
  const maps = menu.maps || [];
  const map = maps.includes('de_playground') ? 'de_playground' : maps.includes('de_dust2') ? 'de_dust2' : maps[0];
  (map ? loadMap(map) : Promise.reject(new Error('no maps'))).then(() => {
    if (!playing && menu.windowOpen) backdrop = true;
  }).catch((err) => console.warn(`no preview scene: ${err.message}`)).finally(() => {
    backdropLoading = false;
  });
};
// The settings window's aspect when it is open, else the canvas's.
function windowAspect(aspect) {
  const hb = menu.holeBounds;
  return hb ? hb.width / hb.height : aspect;
}
// Moves and shrinks a perspective projection (made with the window's aspect) so the view
// lands in the window's rectangle of the canvas.
function projectIntoWindow(proj) {
  const hb = menu.holeBounds;
  if (!hb) return;
  const cw = canvas.clientWidth || 1, ch = canvas.clientHeight || 1;
  proj[0] *= hb.width / cw;
  proj[5] *= hb.height / ch;
  proj[8] = -((hb.left + hb.width / 2) / cw * 2 - 1);
  proj[9] = (hb.top + hb.height / 2) / ch * 2 - 1;
}
function drawBackdrop(now) {
  const s = spawns[TEAM_CT][0] || spawns[TEAM_T][0] || [0, 0, 0, 0];
  const o = spawns[TEAM_T][0] || s; // looking toward the other spawn: the map, not a spawn wall
  const toward = o === s ? s[3] : Math.atan2(o[1] - s[1], o[0] - s[0]) / DEG;
  const aspect = applyVideoSettings();
  renderer.zoom = 1;
  renderer.begin();
  // The window is a hole in the menu over part of the canvas: the view is projected into
  // it (its own aspect, the frame's center moved to the hole's), so it sees the whole scene.
  const fovY = 2 * Math.atan(Math.tan(45 * DEG) * 0.75);
  perspective(proj, fovY, windowAspect(aspect), 4, 16384);
  projectIntoWindow(proj);
  eye[0] = s[0];
  eye[1] = s[1];
  eye[2] = s[2] + 28; // the spawn origin is the hull center: the eye 28 above it
  const yaw = toward + 18 * Math.sin(now / 5000);
  viewFromAngles(view, eye[0], eye[1], eye[2], 4, yaw);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  renderer.render(viewProj, invViewProj, eye, now / 1000, null);
  renderer.composite();
}

// Hidden tabs get no animation frames (and timers at most once a second): keep
// applying snapshots and events so the world is current when we come back.
setInterval(() => {
  if (!document.hidden || !net || !synced) return;
  if (net.poll()) applySnapshot();
  applyEvents();
}, 250);

// --- Console commands and key binds ------------------------------------------------

// Keys run their binds (the console window takes keys while it is open; the buy menu
// takes Escape and its number keys). `+` binds only act while playing (mouse captured),
// or with the buy menu open, where we keep moving (not shooting: the mouse is the menu's).
const MENU_HELD = new Set(['+attack', '+attack2']);
input.keepKeys = () => hud.menuOpen;
input.onKey = (key, down) => {
  if (conWin.isOpen) return false;
  if (hud.menuOpen && down && (key === 'escape' || /^[0-9]$/.test(key))) {
    if (key === 'escape') closeBuyMenu();
    else hud.menuKey(+key || 10);
    return true;
  }
  const b = binds.get(key);
  if (b === undefined) return false;
  if (menu.visible && b !== 'toggleconsole') return false; // the menu takes the keys (typing a name)
  if (down) {
    if (b[0] === '+' && !input.locked && !(hud.menuOpen && playing && !MENU_HELD.has(b))) return false;
    con.exec(b, { key });
  } else {
    const release = releaseOf(b);
    if (release) con.exec(release, { key });
  }
  return true;
};

for (const [name, bit] of [['forward', IN_FORWARD], ['back', IN_BACK], ['moveleft', IN_MOVELEFT],
  ['moveright', IN_MOVERIGHT], ['jump', IN_JUMP], ['duck', IN_DUCK], ['speed', IN_SPEED], ['attack', IN_ATTACK],
  ['attack2', IN_ATTACK2], ['use', IN_USE], ['reload', IN_RELOAD], ['showscores', IN_SCORE]]) {
  con.command(`+${name}`, (_a, ctx) => input.press(bit, ctx.key), `Hold: ${name}`);
  con.command(`-${name}`, (_a, ctx) => input.release(bit, ctx.key), `Release: ${name}`);
}
con.command('+lookatweapon', () => weaponView.inspect((tickCount - 1) * TICK_DT), 'Inspect the weapon');
con.command('-lookatweapon', () => {});
for (let n = 1; n <= NUM_SLOTS; n++) {
  con.command(`slot${n}`, () => {
    input.select = n - 1;
  }, `Weapon slot ${n}`);
}
con.command('lastinv', () => {
  input.select = SELECT_LAST;
}, 'Previous weapon');
const cycleSlot = (dir) => { // next/previous slot that holds a weapon
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const s = (ws.f[WS_ACTIVE] + dir * i + NUM_SLOTS) % NUM_SLOTS;
    if (ws.f[WS_SLOTS + s * 3] > 0) return (input.select = s);
  }
};
con.command('invnext', () => cycleSlot(1), 'Next weapon');
con.command('invprev', () => cycleSlot(-1), 'Previous weapon in the slot order');
con.command('drop', () => input.pulse(IN_DROP), 'Drop the active weapon (the C4 for now)');
con.command('buymenu', () => {
  if (hud.menuOpen) closeBuyMenu();
  else if (gunGame()) hud.flash('No buying in this mode: kills earn the next weapon', 2500, performance.now());
  else if (playing && player.team !== TEAM_SPECTATOR) hud.toggleMenu(true);
}, 'Opens the buy menu');
con.command('teammenu', () => {
  if (!playing) return;
  if (document.pointerLockElement) document.exitPointerLock();
  menu.showPause('team');
}, 'Opens the team menu');
const BUY_NAMES = { vest: ITEM_KEVLAR, vesthelm: ITEM_ASSAULTSUIT, defuser: ITEM_DEFUSER };
con.command('buy', (a, ctx) => {
  const item = BUY_NAMES[a[1]] || WEAPON_ID[a[1]];
  if (!item) return con.out(ctx, 'buy <ak47 | m4a1 | m4a1_silencer | awp | deagle | ... | vest | vesthelm | defuser>');
  const err = buyError(player, item, net ? (net.own.flags & OWN_CAN_BUY) !== 0 : true, freeBuys());
  if (err) return con.out(ctx, `${itemLabel(item)}: ${err}`);
  buy(item);
}, 'buy <item>: buys a weapon or gear');
con.hint('buy', (i) => (i === 1 ? [...Object.keys(BUY_NAMES), ...Object.keys(WEAPON_ID).filter((n) => n !== 'none')] : []));
con.command('toggleconsole', () => conWin.toggle(), 'Opens or closes the console');
con.command('drawradar', () => {
  radar.hidden = false;
}, 'Shows the radar');
con.command('hideradar', () => {
  radar.hidden = true;
}, 'Hides the radar');
con.command('clear', () => conWin.clear(), 'Clears the console');
con.command('noclip', (_a, ctx) => {
  if (net) return con.out(ctx, 'noclip: offline only');
  noclip = !noclip;
  con.out(ctx, `noclip ${noclip ? 'ON' : 'OFF'}`);
}, 'Fly through walls (offline)');
con.command('setpos', (a, ctx) => {
  const v = a.slice(1, 4).map(Number);
  if (v.length < 3 || !v.every(Number.isFinite)) return con.out(ctx, 'setpos <x> <y> <z>: moves your feet there (sv_cheats online)');
  if (net) return net.command(`setpos ${v.join(' ')}`);
  ps.f[PS_ORIGIN] = v[0];
  ps.f[PS_ORIGIN + 1] = v[1];
  ps.f[PS_ORIGIN + 2] = v[2] + feetOffset(ps.i[PS_FLAGS]);
}, 'setpos <x> <y> <z>: moves your feet there (online: needs sv_cheats 1 on the server)');
con.command('setang', (a, ctx) => {
  if (a.length < 3) return con.out(ctx, 'setang <pitch> <yaw>');
  angles[0] = Math.max(-89, Math.min(89, +a[1] || 0));
  angles[1] = +a[2] || 0;
}, 'setang <pitch> <yaw>: sets your view angles');
con.hint('jointeam', [['1', 'Spectators'], ['2', 'Terrorists'], ['3', 'Counter-Terrorists']]);
con.command('jointeam', (a, ctx) => {
  const n = +a[1];
  if (n !== 1 && n !== 2 && n !== 3) {
    return con.out(ctx, 'jointeam 1 (Spectators), 2 (Terrorists) or 3 (Counter-Terrorists)');
  }
  if (net) return net.command(`jointeam ${n}`);
  if (n === 1) return con.out(ctx, 'jointeam 1: spectating needs a server');
  player.team = n === 3 ? TEAM_CT : TEAM_T;
  offlineRespawn();
}, 'jointeam <1|2|3>: watch, or switch to the Terrorists or Counter-Terrorists');
con.command('kill', () => {
  if (net) net.command('kill');
  else offlineRespawn();
}, 'Suicide');
con.command('rcon', (a, ctx) => {
  if (!net) return con.out(ctx, 'rcon: not connected');
  const password = net.localRcon || cv.rcon_password.value; // practice: the worker's own
  if (!password) return con.out(ctx, 'set rcon_password first');
  if (a.length < 2) return con.out(ctx, 'rcon <command>');
  // One argument goes as is (rcon "mp_freezetime 3; mp_restartgame 1"); several are re-quoted.
  const command = a.length === 2 ? a[1] : a.slice(1).map((s) => (/[\s;"]/.test(s) || !s ? quote(s) : s)).join(' ');
  net.command(`rcon ${quote(password)} ${command}`);
}, 'rcon <command>: runs a command on the server (needs rcon_password)');
con.command('status', (_a, ctx) => {
  if (!net) return con.out(ctx, `offline  map: ${currentMap}`);
  const lines = [`map: ${currentMap}  you: #${selfId}  ping: ${netStats.rtt.toFixed(0)} ms`, '# id  name  team  kills deaths'];
  for (let id = 0; id < MAX_PLAYERS; id++) {
    if (!net.names[id]) continue;
    lines.push(`# ${id}  ${net.names[id]}  ${TEAM_NAMES[net.teams[id]]}  ${net.kills[id]} ${net.deaths[id]}`);
  }
  con.out(ctx, lines.join('\n'));
}, 'Players on the server (rcon status shows the server side)');
con.command('disconnect', () => {
  if (playing) leaveGame();
}, 'Leaves the server (or the practice) for the start menu');
con.command('retry', () => reconnect(), 'Reconnects to the server');
con.command('map', (a, ctx) => {
  if (!a[1]) return con.out(ctx, 'map <name>');
  if (net && net.localRcon) return net.command(`rcon ${quote(net.localRcon)} map ${quote(a[1])}`);
  if (net) return con.out(ctx, 'online, the server picks the map: rcon map <name>');
  if (playing) run(() => startSandbox(a[1], player.team === TEAM_CT ? 3 : 2));
  else run(() => startPractice(a[1], 2));
}, 'map <name>: changes the practice map (online: rcon map <name>)');
// The map names for its suggestions, fetched the first time they are asked for (the list
// shows them from the next key on).
let mapNames = null;
con.hint('map', (i) => {
  if (i !== 1) return [];
  if (!mapNames) {
    mapNames = [];
    fetch('/maps.json').then((r) => r.json()).then((l) => { mapNames = l; }, () => { mapNames = null; });
  }
  return mapNames;
});
con.prefixes.add('rcon'); // rcon <server command>: suggested like the command itself
// Server settings and commands (mp_*, bot_*, ...) typed into the console: in practice the
// server is ours, so they go to it (as on a CS:GO listen server); online they need rcon.
con.unknown = (args, ctx) => {
  const line = args.map((s) => (/[\s;"]/.test(s) || !s ? quote(s) : s)).join(' ');
  if (net && net.localRcon) {
    net.command(`rcon ${quote(net.localRcon)} ${line}`);
    return true;
  }
  if (!net || !/^(mp_|bot_|sv_|game_)/i.test(args[0])) return false;
  con.out(ctx, `"${args[0]}" is a server setting: rcon ${line}`);
  return true;
};
watch(cv.name, () => {
  if (net) net.command(`name ${quote(cv.name.value)}`);
});
const applyDrawHud = () => document.body.classList.toggle('nohud', !cv.cl_drawhud.bool);
watch(cv.cl_drawhud, applyDrawHud);
applyDrawHud();

// --- Menus ----------------------------------------------------------------------------

// In a game, releasing the mouse (Escape) opens the pause menu, unless the console or
// the buy menu took it; closing those takes the mouse back (the key press allows it).
function updateOverlay() {
  if (preview) return menu.hide(); // the editor's 3D view: Escape only lets the mouse go
  if (!playing) return;
  if (document.pointerLockElement) menu.hide();
  else if (!conWin.isOpen && !hud.menuOpen) menu.showPause();
}
// The overlay is decided once the lock request settles: asked at once, the mouse was not
// back yet and the pause menu flashed up for a frame.
function closeBuyMenu() {
  hud.toggleMenu(false);
  input.lock().catch(() => input.clear()).finally(updateOverlay); // no mouse back (Escape): the held keys let go
}
// At the start menu the console opens over the menu (hiding it bared the empty canvas).
conWin.onToggle = (open) => {
  if (!playing) return;
  if (open) menu.hide();
  else if (!hud.menuOpen) input.lock().catch(() => {}).finally(updateOverlay);
  else updateOverlay();
};
document.addEventListener('pointerlockchange', updateOverlay);
document.addEventListener('pointerdown', () => sounds.resume()); // audio may only start after a user gesture

menu.onPlay = (team) => {
  if (menu.roomGone) setRoom(''); // the link's room closed: the Play panel shows the server's own game
  run(() => startOnline(team));
};
menu.onMapFile = (file) => addOwnMap(file);
menu.onHost = (map, team, opts) => run(() => hostRoom(map, team, opts));
menu.onLeaveRoom = () => {
  setRoom('');
  menu.fetchServer();
};
menu.room = roomCode;
menu.onPractice = (map, team, opts) => run(() => startPractice(map, team, opts));
menu.onResume = () => input.lock().catch(() => {});
menu.onLeave = () => leaveGame();
menu.onTeam = (team) => {
  con.exec(`jointeam ${team}`);
  menu.hide();
  input.lock().catch(() => {}).finally(updateOverlay); // no mouse yet: the pause menu again
};
// A menu action, its failure shown on the start menu.
let starting = false;
async function run(action) {
  if (starting) return;
  starting = true;
  try {
    await action();
  } catch (err) {
    leaveGame(`Could not start: ${err.message || err}`);
  }
  starting = false;
}

const primary = WEAPON_ID[params.get('primary')] || 0;
const secondary = WEAPON_ID[params.get('secondary')] || 0;

async function joinServer(team) {
  menu.busy('Connecting...');
  net = new NetClient();
  if (localWorker) net.connectLocal(localWorker, localRcon);
  else {
    await net.connect(roomCode);
    if (roomCode && roomRcon) net.localRcon = roomRcon; // our room: its console is ours, like practice
  }
  const welcome = await net.join(team, primary, secondary, cv.name.value);
  selfId = welcome.playerId;
  menu.busy(`Loading ${welcome.map}...`);
  await loadMap(welcome.map);
}

const NO_ITEMS = new Items(), NO_HOSTAGES = new Hostages();

// Forgets everything from the last game (server state, other players, effects).
function resetSession() {
  synced = false;
  roundSerial = -1;
  words.clear();
  blasts.clear();
  serverClock = -1;
  predictedTick.fill(-1);
  serverBroken.fill(0);
  smooth.fill(0);
  seenKills.fill(-1);
  lastBombState = 0;
  netStats.compared = netStats.corrected = 0;
  noclip = false;
  wasDead = true; // no body to start a free roam camera from
  interp.fill(0);
  players.update(interp, 0, -1, false);
  models.update(interp, 0, -1, 0, null, false);
  models.setItems(NO_ITEMS);
  models.updateHostages(NO_HOSTAGES, 0, null);
  itemsVersion = grenadesVersion = -1;
  models.setBomb(false);
  fx.clear();
  if (hud.menuOpen) {
    hud.toggleMenu(false);
    input.clear();
  }
}

// Play: join the server on a team (CS:GO numbers: 1 spectators, 2 T, 3 CT; 0 auto).
async function startOnline(team) {
  if (playing) leaveGame();
  resetSession();
  try {
    await joinServer(team === 3 ? TEAM_CT : team === 2 ? TEAM_T : team === 1 ? TEAM_SPECTATOR : 0);
  } catch (err) {
    if (net) net.close('failed');
    net = null;
    throw new Error(`could not connect (${err.message})`);
  }
  if (roomCode && roomNames) { // our room: its console's cvars and commands join the suggestions
    con.remote = new Map(roomNames.map(([name, help, value, hint]) => [name, { help, value, hint }]));
  }
  conWin.print(roomCode ? `connected: room ${roomCode}, ${currentMap}` : `connected: ${currentMap}`);
  if (roomCode && roomRcon) conWin.print('your room: its console is yours (bot_add, mp_restartgame, ... no rcon needed)');
  enterGame();
}

// A map file picked in the menu (Your map): checked here first (parseUntrustedBSP), so a
// file that is not a playable map is refused before anything starts. Returns its name.
async function addOwnMap(file) {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > OWN_MAP_MAX) throw new Error(`${file.name} is too large (${OWN_MAP_MAX >> 20} MB at most)`);
  try {
    parseUntrustedBSP(buffer);
  } catch (err) {
    throw new Error(`${file.name} is not a map this game can play (${err.message})`);
  }
  const name = mapNameOf(file.name);
  ownMaps.clear(); // one at a time
  ownMaps.set(name, buffer);
  return name;
}
const OWN_MAP_MAX = 24 << 20; // the server's room limit (server/rooms.js ROOM_LIMITS.bytes)

// Host for friends: uploads our own map to the server, which runs a room on it (held in
// its memory only, server/rooms.js), then joins it. The page's address becomes the
// invite link.
async function hostRoom(map, team, { mode = 'competitive', players = 0, difficulty = 1 } = {}) {
  const bytes = ownMaps.get(map);
  if (!bytes) throw new Error('pick a map file first');
  if (playing) leaveGame();
  menu.busy(`Uploading ${map}...`);
  const q = new URLSearchParams({ file: `${map}.bsp`, mode, players: String(players), difficulty: String(difficulty) });
  const res = await fetch(`/rooms?${q}`, { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the upload failed (HTTP ${res.status})`);
  setRoom(out.code, out.rcon, out.names);
  await startOnline(team);
}

// The room the Play panel and the next join go to ('' the server's own game), kept in the
// page's address (the link to share; a reload joins it again).
function setRoom(code, rcon = '', names = null) {
  roomCode = code;
  roomRcon = rcon;
  roomNames = names;
  menu.room = code;
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

// Practice: the game server in a Web Worker (client/localserver.js) on `map` in `mode`,
// bots filling the teams to `players` at `difficulty` (bot_quota fill, bot_difficulty);
// then join it like a server, on `team` (2 T, 3 CT, 1 spectators, 0 auto).
let localWorker = null, localRcon = '', localPaused = false;
async function startPractice(map, team, { mode = 'competitive', players = 10, difficulty = 1 } = {}) {
  if (playing) leaveGame();
  resetSession();
  localPaused = false; // the new worker starts running
  menu.busy(`Starting a practice game on ${map}...`);
  const worker = new Worker('/client/localserver.js', { type: 'module' });
  try {
    localRcon = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          // The practice server's cvars and commands join the console's suggestions.
          con.remote = new Map((e.data.names || []).map(([name, help, value, hint]) => [name, { help, value, hint }]));
          resolve(e.data.rcon);
        }
        else if (e.data.type === 'failed') reject(new Error(e.data.error));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'the practice server did not start'));
      worker.postMessage({ type: 'start', map, mode, players, difficulty, bytes: ownMaps.get(map) }); // bytes: copied
    });
  } catch (err) {
    worker.terminate();
    throw err;
  }
  worker.onmessage = worker.onerror = null;
  localWorker = worker;
  await joinServer(team === 3 ? TEAM_CT : team === 2 ? TEAM_T : team === 1 ? TEAM_SPECTATOR : 0);
  conWin.print(`practice: ${currentMap} (${mode}); rcon works without a password (bot_add, map ...)`);
  enterGame();
}

// The sandbox: a map in the page alone, without game rules (noclip, give), on a team.
async function startSandbox(map, team) {
  if (playing) leaveGame();
  resetSession();
  menu.busy(`Loading ${map}...`);
  player.team = team === 3 ? TEAM_CT : TEAM_T;
  player.primary = primary;
  player.secondary = secondary;
  player.money = OFFLINE_MONEY;
  await loadMap(map);
  offlineRespawn();
  enterGame();
}

function enterGame() {
  playing = true;
  backdrop = false;
  dynres.reset(performance.now()); // full resolution again, judged after the first seconds
  menu.online = net !== null && !localWorker; // Disconnect, or Quit practice
  menu.server = net !== null; // spectating needs server rules
  menu.busy('');
  menu.hide();
  input.lock().catch(() => {});
  if (!document.pointerLockElement && !preview) menu.showPause(); // locking may need a click: Resume
}

// Back to the start menu (disconnect, quit practice, or the server went away).
function leaveGame(message = '') {
  if (net && !net.closed) net.close('disconnect');
  net = null;
  if (localWorker) {
    localWorker.terminate();
    localWorker = null;
  }
  con.remote = new Map();
  playing = false;
  backdrop = false;
  resetSession();
  if (document.pointerLockElement) document.exitPointerLock();
  menu.showStart(message);
}

// Map change (the server closed us with "changelevel"), or `retry`: join again on our
// current team; the WELCOME names the map.
let reconnecting = false;
async function reconnect() {
  if (reconnecting || !net) return;
  reconnecting = true;
  const team = player.team;
  if (net && !net.closed) net.close('reconnect');
  resetSession();
  status.textContent = 'reconnecting...';
  status.style.display = '';
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await joinServer(team);
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    status.style.display = 'none';
    menu.busy('');
    conWin.print(`connected: ${currentMap}`);
    reconnecting = false;
  } catch (err) {
    reconnecting = false;
    leaveGame(`Disconnected: ${err.message}`);
  }
}

// The map editor (client/editor.html) and this page:
//  * ?preview: the editor's 3D view, in an iframe. The sandbox flies (noclip) through the
//    map the editor sends ('preview-map' { name, bytes }), keeping the camera when a rebuilt
//    map comes in; no menus, no HUD.
//  * ?fromeditor: a tab the editor's Try it opened; it takes the map the editor handed
//    over (client/handoff.js) and starts a practice game on it (the demo mode).
const preview = params.has('preview');
async function previewMap(name, bytes) {
  ownMaps.clear();
  ownMaps.set(name, bytes);
  if (!playing) {
    await startSandbox(name, 2);
    noclip = true;
    return;
  }
  const keep = ps.f.slice(PS_ORIGIN, PS_ORIGIN + 3), pitch = angles[0], yaw = angles[1];
  await loadMap(name);
  ps.f.set(keep, PS_ORIGIN);
  ps.f[PS_VEL] = ps.f[PS_VEL + 1] = ps.f[PS_VEL + 2] = 0;
  resetView(yaw);
  angles[0] = pitch;
}
let previewEdit = null; // picking and dragging shapes in the editor's 3D view (client/previewedit.js)
function startPreview() {
  document.body.classList.add('nohud');
  menu.hide();
  input.canLock = () => false; // a click picks; the right button held looks round and flies
  previewEdit = new PreviewEditor(canvas, () => ({ viewProj, invViewProj }),
    (msg) => parent.postMessage(msg, location.origin), () => input.lock().catch(() => {}), () => document.exitPointerLock());
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== parent || !e.data) return;
    if (e.data.type === 'preview-map') previewMap(e.data.name, e.data.bytes).catch((err) => console.warn(`preview: ${err.message}`));
    else previewEdit.message(e.data);
  });
  parent.postMessage({ type: 'preview-ready' }, location.origin);
}
async function startFromEditor() {
  history.replaceState(null, '', '/'); // a reload opens the menu
  const m = await takeHandoff().catch(() => null);
  if (!m) return menu.showStart('The map from the editor was not found: press Try it in the editor again.');
  ownMaps.clear();
  ownMaps.set(m.name, m.bytes);
  menu.ownMap = m.name;
  const opts = { mode: m.mode, players: m.players, difficulty: m.difficulty };
  await run(() => startPractice(m.name, m.team, opts));
}

async function start() {
  if (params.get('name')) cv.name.set(params.get('name').slice(0, 31));
  status.style.display = 'none';
  requestAnimationFrame(frame);
  if (preview && parent !== globalThis) return startPreview();
  if (params.has('fromeditor')) return startFromEditor();
  // URL parameters skip the menu (testing): join at once (the sandbox if no server
  // answers), practice, or the sandbox.
  // A room link (?room=code) opens on the Play panel: that room's teams.
  if (!['team', 'offline', 'map', 'practice'].some((p) => params.has(p))) return menu.showStart('', roomCode ? 'play' : '');
  const team = { spec: 1, t: 2, ct: 3 }[params.get('team')] || 0;
  const map = params.get('map') || 'de_dust2';
  if (params.has('practice')) {
    return await startPractice(map, team, { mode: params.get('mode') || 'competitive',
      players: +(params.get('players') ?? 10), difficulty: +(params.get('difficulty') ?? 1) });
  }
  if (!params.has('offline')) {
    try {
      return await startOnline(team);
    } catch (err) {
      console.warn(`no server, sandbox: ${err.message}`);
    }
  }
  await startSandbox(map, team === 3 ? 3 : 2);
}

start().catch((err) => {
  leaveGame(String(err.message || err));
  console.error(err);
});

// Dev hook for inspecting the scene from the console.
globalThis.comicstrike = {
  player,
  ps,
  ws,
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
  menu,
  weaponView,
  spectator,
  radar,
  buy,
  sounds,
  con,
  cv,
  binds,
  setNoclip: (on) => {
    noclip = on && !net;
  },
  get breakables() {
    return breakables;
  },
  get world() {
    return world;
  },
  get doors() {
    return doors;
  },
  overlays, // objects drawn with draw(viewProj, gbuffer) after the opaque world
  models, // other players' animated models
  renderer, // the comic print (style, flash lights, GPU timer)
  // Offline only: equip any weapon by name, e.g. comicstrike.give('negev').
  give: (name) => {
    const id = WEAPON_ID[name];
    if (!id || net) return net ? 'online: the server owns your weapons' : Object.keys(WEAPON_ID).filter((n) => n !== 'none');
    giveWeapon(ws, id);
    input.select = WEAPONS[id].slot;
    return WEAPONS[id].label;
  },
};
