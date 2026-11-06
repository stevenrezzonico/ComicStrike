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
// server answers), &practice&map=de_dust2&mode=deathmatch&players=10 practices (no map: defaultMap),
// &offline&map=de_dust2 opens the sandbox.
// Keys are CS:GO binds (client/binds.js); ` opens the console (client/settings.js).

import { parseBSP, parseUntrustedBSP, mapNameOf, teamSpawns } from '../shared/bsp.js';
import { sunOf } from '../shared/sun.js';
import {
  TICK_RATE, TICK_DT, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED, IN_SCORE,
  IN_ATTACK, IN_ATTACK2, IN_USE, IN_RELOAD, IN_DROP,
} from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, pointContents, setBody, clearBodies, HULL_POINT } from '../shared/trace.js';
import {
  eyeOffset, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_SIZE, FL_ONGROUND, FL_DUCKING, FL_NOCLIP, noclipMove, touched, touchedCount,
} from '../shared/pmove.js';
import {
  WEAPONS, WEAPON_ID, ShotList, giveWeapon, weaponTick, viewPunchPitch, viewPunchYaw, hash32, WS_LAST_SLOT,
  WS_EVENTS, WS_SIZE, WS_SLOTS, WS_ACTIVE, WS_ACTION, WS_ACTION_END, SLOT_C4, NUM_SLOTS, ACTION_PLANT, ACTION_DEFUSE,
  SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, SLOT_GRENADE,
  WS_ZOOM, WS_THROWN, WEV_THROW, WEV_FIRE, activeWeapon, silenced, RECOIL, shotKick,
} from '../shared/weapons.js';
import { ARMS_RACE, DEMOLITION, levelWeapon } from '../shared/progression.js';
import {
  BombSites, PLANT_TIME, DEFUSE_TIME, DEFUSE_TIME_KIT, C4_TIMER, BOMB_DROPPED, BOMB_PLANTED, BOMB_DEFUSED,
  BOMB_EXPLODED,
} from '../shared/bomb.js';
import { Breakables, EXPLODE_RANGE, blastDamage } from '../shared/breakables.js';
import { Doors, MapLogic, Killables, MAX_MOVERS, BLAST } from '../shared/doors.js';
import { HitTargets, feetOffset } from '../shared/hitgroups.js';
import { SurfaceMap } from '../shared/surfaces.js';
import {
  Player, spawnPlayer, runCommand, resolveShots, applyDamage, ImpactList, TEAM_T, TEAM_CT, TEAM_SPECTATOR, TEAM_NAMES,
  inBombSite, canReachBomb, teamOfJoin,
} from '../shared/player.js';
import { Grenades, FX_HE, FX_FLASH, FX_SMOKE, FX_FIRE, FX_FIZZLE, FX_BLAST } from '../shared/grenades.js';
import { HITGROUP_CHEST, HITGROUP_LEGS } from '../shared/hitgroups.js';
import {
  MAX_PLAYERS, CmdRing, SHOT_BLOOD, KILL_HEADSHOT, SNAPSHOT_HISTORY, OWN_CAN_BUY, OWN_DEFUSER, OWN_CARRYING, OWN_IMMUNE, OWN_HURT, E_ACTIVE, E_X,
  CHAT_CONSOLE, CHAT_TEAM, CHAT_MAX, CHAT_RADIO, RADIO,
  E_Y, E_Z, E_PITCH, E_YAW,
  E_FLAGS, E_DUCK, E_HEALTH, E_TEAM, E_FIELDS, dequantizeYaw, dequantizePitch, PROTOCOL_VERSION,
} from '../shared/protocol.js';
import { DemoRecorder, DemoPlayer, decodeDemo, fillRecorderRow, restoreRing, demoName } from './demo.js';
import { saveDemo, loadDemo, listDemos, deleteDemo, downloadDemo } from './demostore.js';
import { buildMapMesh } from './mapmesh.js';
import { Renderer } from './gl/renderer.js';
import { Decals } from './gl/decals.js';
import { Debris } from './gl/debris.js';
import { Players } from './gl/players.js';
import { PlayerModels } from './gl/playermodels.js';
import { GunMeshes } from './gl/gunmeshes.js';
import { LOOK_GUNS, lookOf } from './models/looks.js';
import { JingleCues } from './jingles.js';
import { GrenadeFx } from './gl/grenadefx.js';
import { Blasts } from './gl/blast.js';
import { PASS } from './gl/gputimer.js';
import { DynamicResolution, SLOW_MS } from './dynres.js';
import { modelLight } from './gl/skinned.js';
import { crosshairLayout } from './gl/crosshair.js';
import { perspective, viewFromAngles, viewFromEye, multiply, invert, CLIP_ALL } from './gl/mat4.js';
import { clock } from './clock.js';
import { PracticeMarks } from './gl/practice.js';
import { Tracers } from './gl/tracers.js';
import { Input, SELECT_LAST } from './input.js';
import { keyName } from './binds.js';
import { WeaponView } from './weaponview.js';
import { NetClient } from './net.js';
import { Hud } from './hud.js';
import { Sounds } from './audio.js';
import { SoundScape, gunProfile } from './soundscape.js';
import { InkWords } from './inkwords.js';
import { Spectator, SPEC_EYES, SPEC_ROAM, SPEC_DELAY } from './spectate.js';
import { DeathPanel } from './deathpanel.js';
import { HurtIndicator } from './hurtdir.js';
import { Callouts } from './callouts.js';
import { ConsoleWindow } from './console.js';
import { Chat } from './chat.js';
import { TouchControls, altLabel } from './touch.js';
import { Gamepads } from './gamepad.js';
import { takeHandoff } from './handoff.js';
import { PreviewEditor } from './previewedit.js';
import { Menu, defaultMap } from './menu.js';
import { Radar } from './radar.js';
import { Overview } from '../shared/overview.js';
import { Items } from '../shared/items.js';
import { Hostages } from '../shared/hostages.js';
import { NetGraph } from './netgraph.js';
import { createConsole, watch } from './settings.js';
import { releaseOf, quote } from '../shared/cvars.js';
import {
  PHASE_FREEZE, PHASE_LIVE, GAME_FFA, GAME_DM, GAME_DEMO, GAME_WINGMAN, GAME_ARMSRACE, GAME_DEMOLITION, GAME_GHOST_TEAM, GAME_RETAKES, buyError, applyBuy, itemLabel, ITEM_KEVLAR, ITEM_ASSAULTSUIT, ITEM_DEFUSER,
} from '../shared/economy.js';

const DEG = Math.PI / 180;
const FOV_Y = 73.74 * DEG; // CS:GO fov 90 at 4:3, kept vertical (Hor+)
const ZOOM_RATE = 30; // per second: how fast the view zooms in or out (approximation)
// The frame's running numbers, as fields of one object rather than module variables: a
// double assigned to a module variable was a new heap number every time (a dozen a frame),
// while a field holding doubles is written in place. Created with -0 so every field holds
// doubles from the start (a field first given a whole number changes its object's map).
const clk = {
  fov: -0, // current CS:GO-style fov (horizontal at 4:3), eased toward the scope's
  serverClock: -0, // estimated newest server tick (fractional), advanced every frame; < 0: none yet
  prevEye: -0, prevPunchP: -0, prevPunchY: -0, // the eye height and aim punch at the last tick (draw lerps)
  accumulator: -0, // seconds owed to the ticks
  elapsed: -0, // this frame's seconds (frame)
  alpha: -0, // draw's: the share of a tick since the last one
  // The time since the last drawn frame, for the animations draw() advances by dt: a held frame
  // (fps_max, r_frames_ahead) adds its own, else the deaths, strides and view kick ran slow by
  // the held share (with the browser's frame limiter off, half the frames: slow motion).
  drawDt: -0,
  frameMsMax: -0, // the worst gap in the readout's window (cl_showfps)
  cpuSim: -0, cpuDraw: -0, // ms summed over the readout's window (cl_showfps 3)
};
clk.fov = 90;
clk.serverClock = -1;
const scopeEl = document.getElementById('scope');
let scopeShown = '';
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
// Last frame: dead and not flying free (free roam): the mouse turns nothing, so the dead cannot
// look round for their team.
let deadView = false;
const lastCam = new Float32Array(5); // last spectator camera: x, y, z, pitch, yaw

// The console first: settings are read by everything below.
let conWin = null;
const { con, binds, cv, configText, importConfig } = createConsole((s) => (conWin ? conWin.print(s) : console.log(s)));
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
const deathPanel = new DeathPanel(document.getElementById('deathpanel'));
const hurtDir = new HurtIndicator(document.getElementById('hurtdir'));
const callouts = new Callouts(document.getElementById('callouts'), document.getElementById('radiomenu'));
const radarPings = [];
// Where a balloon goes over player id: above the head (not ours, not the dead).
const headOf = (id, out) => {
  if (id === selfId || id < 0) return false;
  const r = id * E_FIELDS;
  if (!interp[r + E_ACTIVE] || interp[r + E_HEALTH] <= 0) return false;
  out.x = interp[r + E_X];
  out.y = interp[r + E_Y];
  out.z = interp[r + E_Z] + 54;
  return true;
};
let hurtSerial = -1; // the own block's last hit seen (OWN_HURT)
const weaponView = new WeaponView(renderer.gl, FOV_Y, cv, guns);
const input = new Input(canvas);
const hud = new Hud((item) => { // a buy from the menu closes it
  buy(item);
  closeBuyMenu();
});
const menu = new Menu(document.getElementById('menu'), con, cv, binds, { text: configText, load: importConfig });
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
}, (x, y, z) => world !== null && liquid(x, y, z));
models.liquidAt = (p) => world !== null && liquid(p[0], p[1], p[2]);

// A muzzle flash lights the walls round it for a moment (client/gl/flashes.js); a silencer
// keeps it small.
function muzzleLight(x, y, z, quiet) {
  renderer.flashes.add(x, y, z, quiet ? 140 : 260, quiet ? 0.4 : 1, 0.08, performance.now() / 1000);
}
scape.onShot = (x, y, z, quiet, id, shots, weapon) => {
  muzzleLight(x, y, z, quiet);
  const r = id * E_FIELDS;
  gunShot(x, y, z, dequantizePitch(interp[r + E_PITCH]), dequantizeYaw(interp[r + E_YAW]), quiet, shots, WEAPONS[weapon],
    NaN, 0, 0);
};
const OFFLINE_MONEY = 16000;

const player = new Player();
const ps = player.ps;
const ws = player.ws;
const shots = new ShotList();
const impacts = new ImpactList();
let tickCount = 1;
let lastButtons = 0; // buttons of the last tick (the +use edge)
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
  hurt: (_i, damage, weapon, _owner, _team, x, y) => {
    const w = WEAPONS[weapon];
    applyDamage(player, damage, w, w.grenade === 'fire' ? HITGROUP_LEGS : HITGROUP_CHEST);
    hurtDir.add(x, y, performance.now() / 1000);
    if (player.health <= 0) offlineRespawn();
  },
  blast: (x, y, z, damage, radius) => sandboxBlastBreakables(x, y, z, damage, radius),
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
    tag('flashed');
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

fx.onEffect = (kind, weapon, x, y, z) => {
  tag(kind === FX_HE ? 'HE' : kind === FX_SMOKE ? 'smoke' : kind === FX_FIRE ? 'fire' : kind === FX_FLASH ? 'flashbang' : 'fizzle');
  if (kind === FX_HE) explosion(x, y, z, 0.45);
  else if (kind === FX_BLAST) explosion(x, y, z, Math.min(1.2, 0.3 + weapon / 250)); // a breakable: its magnitude
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
fx.onBurn = (id, x, y, z, r, k) => renderer.flashes.hold(id, x, y, z, r, k); // a fire lights the world round it
let breakables = null;
let breakableColors = null; // rgb per breakable slot, for debris
let doors = null; // doors and buttons: placed for the tick each command runs at, as on the server
let killables = null; // the other brush entities a killtarget removes
let mapLogic = null; // the sandbox runs the map's triggers itself
const sandboxRemoved = new Uint32Array(8); // the sandbox's killtargeted slots shown so far
let cmdOffset = 0; // server tick - command number (newest snapshot): when the server runs a command
const moverSeen = new Uint8Array(MAX_MOVERS);
const moverDir = new Int8Array(MAX_MOVERS); // last tick's, for sounds
const sandboxBodies = [];
const sandboxAct = { x: 0, y: 0, z: 0, yaw: 0 };
const sandboxActs = [sandboxAct];
const sandboxFire = (name, act, kill = '', src = -1) => mapLogic.fireAt(tickCount, name, act, 0, src, kill);
const sandboxHurt = (_i, damage) => { // crushed by a mover, blown up by a breakable
  applyDamage(player, damage, BLAST, HITGROUP_CHEST);
  if (player.health <= 0) offlineRespawn();
};
const sandboxBroke = []; // slots a blast broke
const spawns = { [TEAM_T]: [], [TEAM_CT]: [] }; // offline spawn points [x, y, z, yaw]
let noclip = false;

// Online state.
let net = null;
let selfId = -1;
let synced = false; // false until the first snapshot gives us our spawn

// cl_autowepswitch (CS:GO's): a gun newly in its slot (bought, picked up) that outranks the
// one in hand is drawn, by CS:GO's weapon weights: primary over pistol over C4 over grenade
// over knife. Never a grenade or the C4, never on a respawn (a new baseline), never while
// planting or defusing. The switch is an ordinary slot select, so it is predicted.
const SLOT_RANK = [];
SLOT_RANK[SLOT_PRIMARY] = 25;
SLOT_RANK[SLOT_SECONDARY] = 5;
SLOT_RANK[SLOT_C4] = 3;
SLOT_RANK[SLOT_GRENADE] = 1;
SLOT_RANK[SLOT_KNIFE] = 0;
const AUTO_SLOTS = [SLOT_PRIMARY, SLOT_SECONDARY];
const lastSlots = new Float64Array(NUM_SLOTS);
let lastSpawn = -1;
function autoSwitch() {
  const respawn = player.spawnCount !== lastSpawn;
  lastSpawn = player.spawnCount;
  for (let i = 0; i < AUTO_SLOTS.length; i++) { // (every tick: a for-of allocates in optimized code)
    const s = AUTO_SLOTS[i], id = ws.f[WS_SLOTS + s * 3];
    if (id !== lastSlots[s] && id && !respawn && cv.cl_autowepswitch.number && input.select === -1 &&
      !ws.f[WS_ACTION] && SLOT_RANK[s] > SLOT_RANK[ws.f[WS_ACTIVE]]) input.select = s;
    lastSlots[s] = id;
  }
}
const cmds = new CmdRing(HISTORY);
const predictedPs = new Uint8Array(HISTORY * PS_SIZE * 4); // our state after each command
const predictedWs = new Uint8Array(HISTORY * WS_SIZE * 8);
const predictedTick = new Int32Array(HISTORY).fill(-1);
const serverBroken = new Uint32Array(8); // breakable mask of the last applied snapshot
let roundSerial = -1; // the server's round starts (RoundState.serial) last seen
const jingleCues = new JingleCues();
let lastOwnTeam = 0; // our team in the last snapshot (a swap at a round start is the half-time)
const replayShots = new ShotList();
const smooth = new Float32Array(3); // visual offset hiding prediction corrections
const netStats = { rtt: -0, compared: 0, corrected: 0, lastErr: -0 }; // (-0: doubles from the start, see BombState)

// Other players, interpolated between snapshots around renderTick.
const interp = new Float32Array(MAX_PLAYERS * E_FIELDS);
const targets = new HitTargets(MAX_PLAYERS);
const seenKills = new Int32Array(32).fill(-1);
let seenKillNext = 0;
let lastBombState = 0;
let nextBeep = 0; // ms
let lastBeep = -1e9;

const prevOrigin = new Float32Array(3);
// The camera's own jolt per shot (weapon_recoil_view_punch_extra), decaying every frame:
// never in the weapon state, so the bullets and the server know nothing of it.
const viewKick = new Float64Array(2);
const shotKickOut = new Float64Array(2);

const eye = new Float32Array(3);
const cam = new Float64Array(2); // the camera's pitch and yaw this frame (draw), as an array: see clock.js
const lightAt = new Float64Array(3); // where the held weapon's light is sampled
const radarAt = new Float64Array(4); // the radar's center (feet) and view yaw
const angles = new Float32Array(2); // pitch, yaw (without recoil); f32 like the wire format
const proj = new Float32Array(16);
const view = new Float32Array(16);
const blasts = new Blasts(renderer.gl, view); // explosions: the fire faces this camera
overlays.push(blasts);
// Bullet tracers, behind what is nearer; casings tink where they land.
const tracers = new Tracers(renderer.gl);
overlays.push(tracers);
debris.onLand = (x, y, z) => sounds.tink(x, y, z);
const tracerTrace = new Trace();
let ownShots = 0;
// A shot fired from the eye at (ex, ey, ez) along (pitch, yaw): its casing out of the right
// side (side -1: the left, our own gun in the left hand; not the revolver's), and a tracer
// to (bx, by, bz) (NaN: the first wall along the view) on every third shot of an automatic
// gun and every shot of the others, none silenced (CS:GO's tracer frequencies, approx.).
function gunShot(ex, ey, ez, pitch, yaw, quiet, count, w, bx, by, bz, side = 1) {
  if (!w || !w.gun || !world) return;
  const p = pitch * DEG, yw = yaw * DEG, cp = Math.cos(p);
  const fx = Math.cos(yw) * cp, fy = Math.sin(yw) * cp, fz = -Math.sin(p), rx = Math.sin(yw) * side, ry = -Math.cos(yw) * side;
  if (w.name !== 'revolver') {
    const out = 90 + Math.random() * 50, up = 80 + Math.random() * 60;
    debris.casing(ex + fx * 14 + rx * 6, ey + fy * 14 + ry * 6, ez + fz * 14 - 7, rx * out - fx * 20, ry * out - fy * 20, up);
  }
  if (quiet || (w.auto && count % 3)) return;
  if (Number.isNaN(bx)) {
    traceHull(world, HULL_POINT, ex, ey, ez, ex + fx * 8192, ey + fy * 8192, ez + fz * 8192, tracerTrace);
    bx = tracerTrace.endx;
    by = tracerTrace.endy;
    bz = tracerTrace.endz;
  }
  tracers.add(ex + fx * 24 + rx * 4, ey + fy * 24 + ry * 4, ez + fz * 24 - 4, bx, by, bz);
}

// The demo's and the sandbox's practice marks (grenade arcs, impact boxes), on top of the rest.
const practice = new PracticeMarks(renderer.gl);
overlays.push(practice);
const viewProj = new Float32Array(16);
const invViewProj = new Float32Array(16);

// Maps that are not the server's maps/: files picked from the disk (name -> ArrayBuffer;
// they go nowhere unless hosted as a room), and the room (server/rooms.js) we play in or
// host: its code, and when we host it, its rcon password and console catalog.
const ownMaps = new Map();
let useOwn = false; // the game on screen plays an ownMaps file (Your map, Try it, the editor's preview), not the server's
let roomCode = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let roomRcon = '', roomNames = null;

let currentMap = '';
let overviewWorker = null, overviewJob = 0;
async function loadMap(name) {
  if (!/^[\w-]+$/.test(name)) throw new Error(`bad map name: ${name}`);
  currentMap = name;
  status.textContent = `loading ${name}...`;
  // Our own file, a room's map (from the server's memory) or the server's maps/; the first
  // two come from outside, so they are checked (parseUntrustedBSP).
  let buffer = useOwn ? ownMaps.get(name) : undefined, untrusted = true;
  const tf = performance.now();
  if (!buffer) {
    const room = net && net.room;
    const res = await fetch(room ? `/rooms/${room}/map.bsp` : `/maps/${name}.bsp`);
    if (!res.ok) throw new Error(`map ${name}: HTTP ${res.status}`);
    buffer = await res.arrayBuffer();
    untrusted = !!room;
  }
  // The radar's overview comes from a worker (it was most of the load: cs_polaris 2 of 2.4 s),
  // started first so it works while the page builds the rest; the radar shows once it is there.
  const job = ++overviewJob, copy = buffer.slice(0);
  overviewWorker ||= new Worker(new URL('./overviewworker.js', import.meta.url), { type: 'module' });
  overviewWorker.onmessage = null; // set below, once the bomb sites are known
  overviewWorker.postMessage({ id: job, buffer: copy, untrusted }, [copy]);
  const t0 = performance.now(), steps = [];
  const step = (what) => steps.push(`${what} ${(performance.now() - (steps.t || t0)).toFixed(0)}`) && (steps.t = performance.now());
  const bsp = untrusted ? parseUntrustedBSP(buffer) : parseBSP(buffer);
  step('parse');
  const mesh = buildMapMesh(bsp);
  step('mesh');
  renderer.loadMap(mesh, bsp);
  renderer.clearBroken(); // the last map's broken slots mean nothing here
  step('upload');
  models.vis = renderer.vis;
  models.setSun(sunOf(bsp.entities));
  renderer.setSky(sunOf(bsp.entities), name);
  decals.clear();
  debris.clear();
  // Every effect's program draws once now, clipped away, not on its first use in a fight.
  // The G-buffer is sized first: on the page's first map it had no attachments yet, and the
  // warm-up draws failed (GL_INVALID_FRAMEBUFFER_OPERATION, warming nothing).
  applyVideoSettings();
  renderer.gbuf.begin();
  decals.warm(renderer.gbuf);
  debris.warm();
  models.warm(renderer.gbuf);
  practice.warm(CLIP_ALL);
  practice.clear();
  tracers.screen[0] = canvas.width;
  tracers.screen[1] = canvas.height;
  tracers.warm(CLIP_ALL);
  step('warm');
  world = CollisionWorld.fromBSP(bsp);
  world.surfaces = new SurfaceMap(bsp);
  world.bombSites = new BombSites(bsp);
  step('world');
  radar.setMap(null, world.bombSites);
  const sites = world.bombSites;
  overviewWorker.onmessage = (e) => {
    if (e.data.id !== job || job !== overviewJob) return; // a map loaded since
    if (e.data.error) console.warn(`overview: ${e.data.error}`);
    else radar.setMap(Overview.from(e.data.data), sites);
  };
  breakables = new Breakables(bsp, world);
  breakableColors = mesh.breakableColors;
  doors = new Doors(bsp, world, breakables.count);
  killables = new Killables(bsp, world, breakables.count + doors.count);
  mapLogic = new MapLogic(bsp, doors, world, breakables, killables);
  mapLogic.onBreak = (slot, act) => { // the sandbox: a breakable fired by name
    if (breakables.setBroken(world, slot, true)) brokeSlot(slot, act);
  };
  moverDir.fill(0);
  sandboxRemoved.fill(0);
  renderer.setMovers(doors);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name}: ${mesh.numVerts} verts, ${(mesh.opaqueCount + mesh.cutoutCount + mesh.skyCount + mesh.transCount) / 3} tris, ` +
    `lightmap ${mesh.lightmap.width}x${mesh.lightmap.height}, ${world.ents.length} collision ents, ` +
    `${breakables.count} breakables, ${doors.count} movers, built in ${ms} ms (${steps.join(', ')}; fetched in ${(t0 - tf).toFixed(0)})`);
  Object.assign(spawns, teamSpawns(bsp));
}

function resetView(yaw) {
  angles[0] = 0;
  angles[1] = yaw;
  prevOrigin.set(ps.f.subarray(PS_ORIGIN, PS_ORIGIN + 3));
  clk.prevEye = eyeOffset(ps);
  smooth.fill(0);
  weaponView.flashUntil = 0; // no muzzle flash carried over from before the respawn
}

// A new round wipes what the last one left on the map: bullet holes, scorches, shards
// and chunks, explosions (breakables, doors, the ground and grenades come from the server).
function clearRoundMarks() {
  tag('round start');
  decals.clear();
  debris.clear();
  blasts.clear();
  renderer.flashes.clear();
}

// Offline round restart: breakables come back, we spawn at our team's first spawn.
function offlineRespawn() {
  breakables.reset(world);
  doors.reset(world);
  killables.reset(world);
  mapLogic.reset(tickCount);
  sandboxRemoved.fill(0);
  renderer.clearBroken();
  clearRoundMarks();
  localGrenades.clear();
  fx.clear();
  flash.left = 0;
  const s = spawns[player.team][0] || spawns[TEAM_T][0] || spawns[TEAM_CT][0] || [0, 0, 0, 0];
  spawnPlayer(player, s[0], s[1], s[2]);
  resetView(s[3]);
}

// The sandbox's noclip (also when dead): the shared noclip move (online it is the player's
// FL_NOCLIP, run by runCommand on both sides).
function noclipTick(buttons) {
  noclipMove(ps, buttons, angles[0], angles[1], TICK_DT);
  ps.f[PS_VEL] = ps.f[PS_VEL + 1] = ps.f[PS_VEL + 2] = 0;
}

// Decals for this tick's world hits; debris for anything our shots broke. Player hits
// show nothing until the server confirms them (blood events).
function showImpacts() {
  const melee = WEAPONS[shots.weapon[0]]?.melee;
  if (practice.showImpacts && !melee) {
    const p = impacts.pos, at = performance.now() / 1000;
    for (let i = 0; i < impacts.count; i++) practice.impacts.add(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], at);
  }
  for (let i = 0; i < impacts.count; i++) {
    if (impacts.player[i] >= 0) continue;
    if (impacts.broke[i]) {
      breakVisual(impacts.broke[i]);
      if (!net) brokeSlot(impacts.broke[i], sandboxAct); // the server runs the chain online
      continue;
    }
    const p = impacts.pos, n = impacts.normal;
    decals.add(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], n[i * 3], n[i * 3 + 1], n[i * 3 + 2], melee ? 1.2 : 1.6,
      (hash32(tickCount * 7 + i) & 0xffff) / 65536, impacts.owner[i]);
    if (!melee) {
      words.wall(viewProj, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      tag('impact');
    }
  }
}

function breakVisual(slot) {
  renderer.setBroken(slot, true);
  decals.removeOwner(slot);
  const c = breakableColors;
  debris.burst(breakables.mins, breakables.maxs, slot * 3, breakables.material[slot],
    c[slot * 3], c[slot * 3 + 1], c[slot * 3 + 2]);
}

// A slot the server's mask (or the sandbox's map logic) took away or gave back: a
// breakable shatters, a killtargeted mover or wall just goes.
function applySlot(slot, gone) {
  if (slot <= breakables.count) {
    if (!breakables.setBroken(world, slot, gone)) return;
    if (gone) breakVisual(slot);
    else renderer.setBroken(slot, false);
    return;
  }
  const m = slot - doors.slotBase - 1, q = slot - killables.slotBase - 1;
  if (m >= 0 && m < doors.count) {
    if (!doors.setDead(world, m, gone)) return;
  } else if (q < 0 || q >= killables.count || !killables.setDead(world, q, gone)) return;
  renderer.setBroken(slot, gone);
  if (gone) decals.removeOwner(slot);
}

// The sandbox's side of a break (the server's Game.brokeSlot): its target and
// killtarget, then its explosion, which may break more.
function brokeSlot(slot, act) {
  const b = breakables;
  if (b.target[slot] || b.kill[slot]) mapLogic.fireAt(tickCount, b.target[slot], act, b.delay[slot], -1, b.kill[slot]);
  const m = b.magnitude[slot];
  if (m <= 0) return;
  const c = b.center(slot, blastAt);
  localGrenades.addEffect(FX_BLAST, Math.min(255, Math.round(m)), -1, 0, c[0], c[1], c[2]);
  const d = blastDamage(m, m * EXPLODE_RANGE, Math.hypot(ps.f[PS_ORIGIN] - c[0], ps.f[PS_ORIGIN + 1] - c[1], ps.f[PS_ORIGIN + 2] - c[2]));
  if (d > 0 && player.health > 0) {
    traceHull(world, HULL_POINT, c[0], c[1], c[2], ps.f[PS_ORIGIN], ps.f[PS_ORIGIN + 1], ps.f[PS_ORIGIN + 2], blastTrace);
    if (blastTrace.fraction >= 1) sandboxHurt(0, d);
  }
  sandboxBlastBreakables(c[0], c[1], c[2], m, m * EXPLODE_RANGE);
}

function sandboxBlastBreakables(x, y, z, damage, radius) {
  const first = sandboxBroke.length;
  breakables.blast(world, x, y, z, damage, radius, sandboxBroke);
  for (const s of sandboxBroke.splice(first)) {
    breakVisual(s);
    brokeSlot(s, sandboxAct);
  }
}
const blastAt = new Float64Array(3);
const blastTrace = new Trace();

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
  if (!net || id < 0 || (gameMode() & (GAME_DM | GAME_DEMO | GAME_ARMSRACE))) return false; // respawning: the server says not now
  const phase = net.own.round.phase, r = id * E_FIELDS;
  return (phase === PHASE_FREEZE || phase === PHASE_LIVE) && interp[r + E_HEALTH] > 0 &&
    interp[r + E_TEAM] === player.team && (net.names[id] || '').startsWith('BOT ');
}
// The bomb as of the newest snapshot (defusing is predicted against it).
const simBomb = () => (net ? net.own.bomb : null);

// The other players as bodies our predicted commands collide with (shared/trace.js): the
// living ones where the newest snapshot has them (the server runs the command against
// where they are by then: a touched one that moved brings a correction), ducked or
// standing, moving at the speed between the two newest snapshots (riding a running
// teammate is predicted from it). The sandbox has nobody.
function packBodies() {
  clearBodies(world);
  if (!net || net.latest < 0) return;
  const ring = net.ring, E = ring.ents, k1 = net.latest, k0 = ring.find(net.latestSeq - 1);
  world.bodySelf = selfId;
  world.bodyTeam = player.team;
  world.solidTeam = (net.own.round.mode & GAME_GHOST_TEAM) === 0;
  for (let id = 0; id < MAX_PLAYERS; id++) {
    if (id === selfId) continue;
    const a = ring.row(k1, id);
    if (!E[a + E_ACTIVE] || E[a + E_HEALTH] <= 0 || (E[a + E_FLAGS] & FL_NOCLIP)) continue;
    let vx = 0, vy = 0, vz = 0;
    if (k0 >= 0) {
      const b = ring.row(k0, id);
      if (E[b + E_ACTIVE] && E[b + E_HEALTH] > 0) {
        vx = (E[a + E_X] - E[b + E_X]) * TICK_RATE;
        vy = (E[a + E_Y] - E[b + E_Y]) * TICK_RATE;
        vz = (E[a + E_Z] - E[b + E_Z]) * TICK_RATE;
        if (vx * vx + vy * vy + vz * vz > 4000 * 4000) vx = vy = vz = 0; // a respawn, not a move
      }
    }
    setBody(world, id, E[a + E_X], E[a + E_Y], E[a + E_Z], (E[a + E_FLAGS] & FL_DUCKING) ? 18 : 36, vx, vy, vz,
      E[a + E_TEAM]);
  }
}

// Runs our commands after `from` again on top of the state we were just given.
function replayFrom(from) {
  packBodies();
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
// CS:GO's E prompts: what holding or pressing use does here (plant, defuse, pick up a
// hostage, pick up or swap a weapon lying in front of us); the text rebuilt only when
// what it says changes.
let hintKey = 0, hintText = '';
function useHint(off) {
  let k = 0;
  if (!off && world) {
    const f = ps.f, ex = f[PS_ORIGIN], ey = f[PS_ORIGIN + 1], ez = f[PS_ORIGIN + 2] + eyeOffset(ps);
    const onGround = (ps.i[PS_FLAGS] & FL_ONGROUND) !== 0, bomb = simBomb();
    if (ws.f[WS_SLOTS + SLOT_C4 * 3] > 0 && onGround && inBombSite(world, ps)) k = 1;
    else if ((player.team === TEAM_CT || demo()) && onGround && bomb && bomb.state === BOMB_PLANTED &&
      canReachBomb(world, ps, angles[0], angles[1], bomb)) k = 2;
    else if (net && player.team === TEAM_CT && !player.carrying && net.hostages.count > 0 &&
      net.hostages.inReach(ex, ey, ez, angles[0], angles[1]) >= 0) k = 3;
    else if (net && !gunGame() && net.items.count > 0) { // (the counts first: the five doubles were boxed every frame)
      const i = net.items.inReach(ex, ey, ez, angles[0], angles[1]);
      if (i >= 0) {
        const id = net.items.weapon[i];
        k = 4 + id * 2 + (ws.f[WS_SLOTS + WEAPONS[id].slot * 3] > 0 ? 1 : 0);
      }
    }
  }
  if (k !== hintKey) {
    hintKey = k;
    let key = 'use';
    for (const [name, cmd] of binds.map) if (cmd === '+use') key = name.toUpperCase();
    hintText = k === 0 ? '' : k === 1 ? `Hold ${key}  plant the bomb` : k === 2 ? `Hold ${key}  defuse the bomb`
      : k === 3 ? `Hold ${key}  pick up the hostage`
      : `${key}  ${k & 1 ? 'swap for' : 'pick up'} ${WEAPONS[(k - 4) >> 1].label}`;
  }
  return hintText;
}

const demo = () => (gameMode() & GAME_DEMO) !== 0;
const freeBuys = () => (gameMode() & (GAME_DM | GAME_DEMO)) !== 0; // deathmatch and the demo: no money
const gunGame = () => (gameMode() & (GAME_ARMSRACE | GAME_DEMOLITION | GAME_RETAKES)) !== 0; // weapons handed out: no money
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
const graphInfo = { fps: -0, rtt: -0, compared: 0, corrected: 0, interpTicks: 0 }; // (-0: doubles from the start)
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
  if (own.flags & OWN_IMMUNE && !net.playback) hud.flash('Spawn protection', 250, performance.now()); // until we shoot
  if (own.flags & OWN_HURT && own.hurtSerial !== hurtSerial) { // a hit from somewhere: an arc toward it
    hurtSerial = own.hurtSerial;
    if (!net.playback) hurtDir.add(own.hurtFrom[0], own.hurtFrom[1], performance.now() / 1000);
  }

  if (net.playback) { // a demo: we watch, the recorder is a row of their own (client/demo.js)
    player.spawnCount = own.spawnCount;
    synced = true;
  } else if (own.spawnCount !== player.spawnCount || !synced) {
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
  player.health = net.playback ? 0 : own.health;
  player.team = net.playback ? TEAM_SPECTATOR : own.team; // jointeam without a respawn (spectators, mid-round)
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
      applySlot(i * 32 + bit, (B[base + i] & (1 << bit)) !== 0);
    }
  }

  // Wingman plays one bomb site: predict planting (and draw the radar) with that one only.
  if ((own.round.mode & GAME_WINGMAN) && world.bombSites.count > 1) {
    world.bombSites.keepOnly(1);
    radar.setSites(world.bombSites);
  }
  if (own.round.serial !== roundSerial) {
    if (roundSerial >= 0) clearRoundMarks();
    // Our side changed with the round start (not by jointeam mid-round): the half-time swap.
    const side = (t) => t === TEAM_T || t === TEAM_CT;
    if (roundSerial >= 0 && side(lastOwnTeam) && side(own.team) && own.team !== lastOwnTeam) {
      hud.flash('Half-time: switching sides', 5000, performance.now());
    }
    roundSerial = own.round.serial;
  }
  lastOwnTeam = own.team;

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
  // The comic jingles (client/jingles.js).
  const jingle = jingleCues.update(own.round, bomb, own.team);
  if (jingle) sounds.jingle(jingle);

  // Keep the server clock estimate near the newest snapshot (it drifts with jitter).
  const seq = net.latestSeq;
  if (clk.serverClock < 0 || Math.abs(seq - clk.serverClock) > 16) clk.serverClock = seq;
  else clk.serverClock += (seq - clk.serverClock) * 0.05;
}

// Doors and buttons as the server has them (those absent are closed at rest).
function applyMovers(mv) {
  moverSeen.fill(0);
  for (let m = 0; m < mv.count; m++) {
    const k = mv.mover[m];
    if (k >= doors.count) continue;
    moverSeen[k] = 1;
    doors.setState(k, mv.from[m], mv.dir[m], mv.sign[m], mv.t0[m], mv.leg[m], mv.goal[m]);
  }
  for (let k = 0; k < doors.count; k++) if (!moverSeen[k]) doors.setState(k, 0, 0, 1, 0, 0, 0);
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
      sounds.doorMove(x, y, z, left / doors.rateOf(k) * TICK_DT, doors.turns[k] !== 0);
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
  doors.update(world, t, sandboxBodies, sandboxFire, sandboxHurt);
  for (let i = 0; i < 8; i++) { // what a killtarget took away
    let diff = mapLogic.removed[i] ^ sandboxRemoved[i];
    sandboxRemoved[i] = mapLogic.removed[i];
    while (diff) {
      const bit = 31 - Math.clz32(diff);
      diff &= ~(1 << bit);
      applySlot(i * 32 + bit, (mapLogic.removed[i] & (1 << bit)) !== 0);
    }
  }
}

// GoldSrc's locked sound (approx.: only we hear ours): running into a named door (only what
// targets it opens it), or +use on a door or button that has still not moved LOCKED_WAIT
// plus a round trip later (a master holds it; the door's start comes back with the server's
// reply, so at 300 ms of ping every door used rattled), rattles where the map gives it a
// locked_sound; once a second per door at most.
const LOCKED_WAIT = 300, LOCKED_GAP = 1000;
const lockedAt = new Map(); // mover -> when it last rattled
let lockedTry = -1, lockedTryAt = 0; // a +use on a mover with a locked_sound, and when
// Mover k rattles (its locked_sound), at most once every LOCKED_GAP.
function rattle(k, now) {
  if (now - (lockedAt.get(k) ?? -Infinity) < LOCKED_GAP) return;
  lockedAt.set(k, now);
  const e = world.ents[doors.ent[k]];
  sounds.locked((e.amin[0] + e.amax[0]) / 2, (e.amin[1] + e.amax[1]) / 2, (e.amin[2] + e.amax[2]) / 2);
}
function lockedSounds(buttons) { // (every tick: no closure in it, whose context was allocated at every call)
  const now = performance.now();
  for (let i = 0; i < touchedCount; i++) {
    const k = doors.ofEnt(touched[i]);
    if (k >= 0 && doors.rattlesOnTouch(k)) rattle(k, now);
  }
  if ((buttons & IN_USE) && !(lastButtons & IN_USE)) {
    const k = usedMover();
    if (k >= 0 && doors.lockedSound[k]) {
      lockedTry = k;
      lockedTryAt = now;
    }
  }
  if (lockedTry >= 0 && now - lockedTryAt >= LOCKED_WAIT + netStats.rtt) {
    if (doors.dir[lockedTry] === 0 && doors.atBottom(lockedTry)) rattle(lockedTry, now);
    lockedTry = -1;
  }
}

function sandboxTouches(t, buttons) {
  for (let i = 0; i < touchedCount; i++) {
    const k = doors.ofEnt(touched[i]);
    if (k >= 0) doors.touch(k, t, sandboxAct);
  }
  if (!(buttons & IN_USE)) return;
  const held = (lastButtons & IN_USE) !== 0; // only a wheel keeps turning
  const k = usedMover();
  if (k >= 0 && (!held || doors.continuous(k))) doors.use(k, t, sandboxAct);
}

// The mover (door, button) our +use reaches along the view, else -1.
function usedMover() {
  const f = ps.f, cp = Math.cos(angles[0] * DEG);
  return doors.findUse(world, f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2], f[PS_ORIGIN], f[PS_ORIGIN + 1],
    f[PS_ORIGIN + 2] + eyeOffset(ps), cp * Math.cos(angles[1] * DEG), cp * Math.sin(angles[1] * DEG),
    -Math.sin(angles[0] * DEG));
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
        tag('hit');
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
  tag('explosion');
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
  const left = Math.max(0, b.ticksLeft - (clk.serverClock - net.latestSeq)) / TICK_RATE;
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
    const reach = 120; // blown off his feet: a long way back where there is room
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
  tag('kill');
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
    // CS:GO's freeze cam shows what the killer had left: their row in the newest snapshot
    const hp = killer !== victim && killer < MAX_PLAYERS && net.latest >= 0
      ? net.ring.ents[net.ring.row(net.latest, killer) + E_HEALTH] : -1;
    deathPanel.killed(killer === victim ? null : name(killer), WEAPONS[weapon] || null, headshot, killer === victim, hp);
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
  clk.prevEye = eyeOffset(ps);
  clk.prevPunchP = viewPunchPitch(ws);
  clk.prevPunchY = viewPunchYaw(ws);

  let viewTick = 0;
  if (reconnecting) return;
  if (net) {
    if (net.poll()) applySnapshot();
    drainMessages(false);
    if (net.playback && (net.changelevel || net.closed)) return leaveGame(`Demo ${demoTitle} ended`);
    if (net.changelevel || (net.closed && net.closeReason === 'changelevel')) {
      reconnect();
      return;
    }
    if (synced) applyEvents();
    if (net.closed) return leaveGame(`Disconnected: ${net.closeReason}`);
    if (!synced) return;
    viewTick = clk.serverClock - cv.cl_interp_ratio.number;
    if (interpolatePlayers(viewTick, interp)) buildTargets();
  }

  autoSwitch();
  const buttons = input.sampleButtons();
  let select = input.sampleSelect();
  if (select === SELECT_LAST) select = ws.f[WS_LAST_SLOT];
  const t = tickCount;
  const alive = player.health > 0;

  shots.count = 0;
  impacts.count = 0;
  packBodies();
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
  if (alive && !noclip) lockedSounds(buttons);
  lastButtons = buttons;
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
    if (practice.showTrails) practice.trails.record(localGrenades, performance.now() / 1000);
    flash.left = Math.max(0, flash.left - TICK_DT);
  } else if (net.grenadesVersion !== grenadesVersion) {
    grenadesVersion = net.grenadesVersion;
    fx.push(net.grenades, net.grenadeTick);
    if (practice.showTrails) practice.trails.record(net.grenades, performance.now() / 1000);
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
      tag('shot');
      shotKick(ws, shotKickOut);
      viewKick[0] += shotKickOut[0];
      viewKick[1] += shotKickOut[1];
      // Our own flash, a little ahead of the eye along the view.
      const p = angles[0] * DEG, yw = angles[1] * DEG, c = Math.cos(p) * 24;
      muzzleLight(eye[0] + Math.cos(yw) * c, eye[1] + Math.sin(yw) * c, eye[2] - Math.sin(p) * 24,
        silenced(ws, ws.f[WS_ACTIVE]));
      const ip = impacts.pos, hit = impacts.count > 0; // the first bullet's first hit
      gunShot(eye[0], eye[1], eye[2], angles[0], angles[1], silenced(ws, ws.f[WS_ACTIVE]), ++ownShots, w,
        hit ? ip[0] : NaN, hit ? ip[1] : 0, hit ? ip[2] : 0, cv.cl_righthand.bool ? 1 : -1);
    }
    scape.ownMove(ps, buttons, ps.f[PS_ORIGIN], ps.f[PS_ORIGIN + 1],
      ps.f[PS_ORIGIN + 2] - feetOffset(ps.i[PS_FLAGS]));
  }
  tickCount++;
}

let last = performance.now();
let lastDraw = last; // when the last frame was drawn (fps_max, r_frames_ahead skip frames)
let ticksSinceDraw = 0; // the ticks run since, held frames included (the benchmark's frame kinds)
let frames = 0;
let fpsTime = last;
let fps = 0;
let gpuText = '';
const dynres = new DynamicResolution(); // r_dynres
// What it reads from the GPU timer each frame (per drawn frame: r_drawrepeat draws it several times).
const gpuRead = { readings: 0, frameMs: -0, behind: -0 }; // (-0: doubles from the start)
// Where r_dynres settled, per window size, so the next map starts there: starting at full
// scale and stepping down was a stutter at every map start on a GPU that cannot keep up.
const DYNRES_KEY = 'comicstrike.dynres';
let dynresSaved = false;
const screenKey = () => `${innerWidth}x${innerHeight}@${cv.r_hidpi.bool ? Math.min(2, devicePixelRatio || 1) : 1}`;
function dynresMemory() {
  try {
    const m = JSON.parse(localStorage.getItem(DYNRES_KEY));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
function saveDynres() {
  dynresSaved = true;
  const m = dynresMemory();
  m[screenKey()] = [dynres.factor * dynres.most, dynres.print]; // the scene's scale of the canvas, whatever the most is
  try {
    localStorage.setItem(DYNRES_KEY, JSON.stringify(m));
  } catch { /* storage blocked: start from full scale next time */ }
}
// benchmark: the gaps between frames over a few seconds, then a report in the console: frame
// times, how far the GPU runs behind, the CPU by part, and every hitch with what happened in
// the frame before it (`tag`).
const bench = {
  until: 0, start: 0, seconds: 0, gaps: new Float32Array(32768), n: 0, frames: 0, cpu: 0, ctx: null,
  parts: new Float64Array(7), hitches: [], heap: 0, gpu: 0, gpuN: 0, passes: false, skipped: 0, capped: 0,
  // kind: what the frame before each gap carried: ticks (1), DOM writes (2); ticks: how many ran;
  // dom: DOM writes since the last drawn frame; alloc: heap growth between collections (the garbage).
  kind: new Uint8Array(32768), ticks: 0, dom: 0, alloc: 0, gcs: 0, gcFreed: 0, gcMax: 0, domBy: new Map(),
};
// Every DOM write in the page while a benchmark runs (the HUD, the comic words, the kill feed,
// the chat, the console), counted by the nearest element with an id: each costs a style
// recalculation on that frame (1-1.8 ms on a laptop: see Performance, Consistent frame times).
// The records arrive as a microtask right after the frame's script, so they count for the gap
// recorded next.
const domWatch = new MutationObserver((records) => {
  bench.dom += records.length;
  for (const r of records) {
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const owner = el && el.closest('[id]');
    const key = owner ? `#${owner.id}` : el ? el.tagName.toLowerCase() : 'text';
    bench.domBy.set(key, (bench.domBy.get(key) || 0) + 1);
  }
});
const CPU_PARTS = ['ticks', 'models', 'render', 'radar', 'hud', 'view', 'print'];
const HITCH_MS = 25; // a frame gap over this is listed (60 Hz misses read 33)
const MAX_HITCHES = 30;
const frameTags = []; // what happened during this frame (only while a benchmark runs)
let lapAt = 0; // lap(): the CPU time since the last lap goes to that part
function tag(what) {
  if (bench.until && frameTags.length < 8 && !frameTags.includes(what)) frameTags.push(what);
}
function lap(part) {
  if (!bench.until) return; // (performance.now() is a new heap number each: only while measuring)
  const t = performance.now();
  bench.parts[part] += t - lapAt;
  lapAt = t;
}

// The scene's render resolution relative to the canvas, as a percentage (r_dynres, mat_viewportscale).
const renderScale = () =>
  `${Math.round(100 * renderer.renderScale)}%${renderer.capped ? ' (capped)' : ''}${cv.r_dynres.bool && dynres.print < 1 ? `, print ${Math.round(100 * dynres.print)}%` : ''}`;

function benchmarkReport() {
  const { gaps, n, frames: n0, kind } = bench; // n: the gaps kept (the first of a long run), n0: every drawn frame
  const sorted = Array.from(gaps.subarray(0, n)).sort((a, b) => a - b);
  const quantile = (list, q) => (list.length ? list[Math.min(list.length - 1, Math.floor(list.length * q))] : 0);
  const at = (q) => quantile(sorted, q).toFixed(1);
  const low = (q) => `${(1000 / Math.max(0.01, quantile(sorted, q))).toFixed(0)} fps`;
  let slow = 0;
  for (let i = 0; i < n; i++) if (gaps[i] > SLOW_MS) slow++;
  // The frames by what they carried: at 1000 fps a tick or a DOM write is a visible share of a frame.
  const ofKind = (test) => {
    const list = [];
    for (let i = 0; i < n; i++) if (test(kind[i])) list.push(gaps[i]);
    list.sort((a, b) => a - b);
    return `median ${quantile(list, 0.5).toFixed(2)} ms (${(list.length / bench.seconds).toFixed(0)}/s)`;
  };
  const kinds = `by kind: plain ${ofKind((k) => k === 0)} · with ticks ${ofKind((k) => k & 1)}, ` +
    `${(bench.parts[0] / Math.max(1, bench.ticks)).toFixed(2)} ms a tick · with DOM writes and no tick ${ofKind((k) => k === 2)}`;
  const writers = [...bench.domBy].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
  const dom = `dom writes: ${[...bench.domBy.values()].reduce((a, b) => a + b, 0)}${writers ? ` (${writers})` : ''}`;
  const garbage = performance.memory
    ? `garbage: ${(bench.alloc / 1024 / Math.max(1, n0)).toFixed(1)} KB a frame · ${bench.gcs} collections` +
      (bench.gcs ? ` freeing ${(bench.gcFreed / bench.gcs / 1e6).toFixed(1)} MB each, the largest ${(bench.gcMax / 1e6).toFixed(1)}` : '')
    : 'garbage: no heap readings (Chrome and Edge only)';
  const t = renderer.timer;
  const gpu = bench.passes ? t.report() : t.ext && bench.gpuN ? `gpu: ${(bench.gpu / bench.gpuN).toFixed(2)} ms a frame` : '';
  const per = (ms) => (ms / Math.max(1, n0)).toFixed(2);
  const held = bench.skipped + bench.capped;
  const lines = [
    `benchmark ${bench.seconds} s: ${(n0 / bench.seconds).toFixed(1)} fps, ${(100 * slow / Math.max(1, n)).toFixed(0)}% slow ` +
      `(over ${SLOW_MS} ms), res ${renderScale()}${cv.r_dynres.bool ? ' (r_dynres)' : ''}` +
      (held ? `, ${held} frames held back (${bench.skipped} by r_frames_ahead, ${bench.capped} by fps_max)` : ''),
    `frame ms: median ${at(0.5)} · 95% ${at(0.95)} · 99% ${at(0.99)} (1% low: ${low(0.99)}) · 99.9% ${at(0.999)} ` +
      `(0.1% low: ${low(0.999)}) · worst ${at(1)}${n < n0 ? ` (the first ${n} frames)` : ''}`,
    kinds,
    dom,
    `cpu: ${per(bench.cpu)} ms a frame: ${CPU_PARTS.map((p, i) => `${p} ${per(bench.parts[i])}`).join(' · ')}`,
    garbage,
    (gpu || 'gpu: no timings') +
      (bench.passes ? '\n(timing every pass slows a GPU near its limit: compare frame rates without "passes")' : ''),
    t.behindReport() || 'gpu behind: no timings',
  ];
  const h = bench.hitches;
  lines.push(h.length ? `hitches over ${HITCH_MS} ms (${h.length}${h.length === MAX_HITCHES ? '+' : ''}):` : `no hitches over ${HITCH_MS} ms`);
  for (const [t, g, what] of h) lines.push(`  ${(t / 1000).toFixed(2)} s: ${g.toFixed(0)} ms${what ? ` after ${what}` : ''}`);
  con.out(bench.ctx, lines.join('\n'));
  bench.until = 0;
  domWatch.disconnect();
}

con.command('benchmark', (a, ctx) => {
  if (!playing) return con.out(ctx, 'benchmark: start a game first');
  bench.seconds = Math.min(60, Math.max(2, +a[1] || 10));
  bench.passes = a.includes('passes');
  bench.gpu = bench.gpuN = 0;
  bench.until = performance.now() + bench.seconds * 1000;
  bench.start = performance.now();
  bench.n = bench.frames = bench.skipped = bench.capped = 0;
  bench.cpu = 0;
  bench.parts.fill(0);
  bench.hitches.length = 0;
  bench.heap = 0;
  bench.ticks = bench.dom = bench.alloc = bench.gcs = bench.gcFreed = bench.gcMax = 0;
  bench.domBy.clear();
  frameTags.length = 0;
  bench.ctx = ctx;
  domWatch.observe(document.body, { childList: true, characterData: true, attributes: true, subtree: true });
  renderer.timer.report(); // a fresh window for the GPU times
  renderer.timer.behindReport();
  con.out(ctx, `benchmark: measuring ${bench.seconds} s...`);
}, 'benchmark [seconds] [passes]: frame rate, slow frames, hitches, CPU by part, GPU time and lag over 10 s (or the given time); passes: GPU time per pass (which itself slows a GPU near its limit)');

function frame(now) {
  // The next frame first: a frame that throws (a bug) then costs one frame, not the game
  // (the error still shows in the console).
  requestAnimationFrame(frame);
  if (menu.visible) menu.frameWindow(backdrop);
  if (!playing) { // the start menu: nothing runs; the settings window shows a backdrop scene
    pollPads(0, now); // the pad's buttons still reach the menu (the key capture)
    last = now;
    clk.accumulator = 0;
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
  if (demoPlayer) { // a demo holds still under the pause menu and with demo_pause
    demoPlayer.paused = demoHeld || (menu.visible && menu.inGame);
    demoPlayer.timescale = cv.demo_timescale.number;
    if (now - demoShownAt > 1000) {
      demoShownAt = now;
      const at = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      hud.flash(`DEMO ${demoTitle}   ${at(demoPlayer.time / 1000)} / ${at(demoPlayer.length / 1000)}` +
        (demoHeld ? '   (paused)' : demoPlayer.timescale !== 1 ? `   x${demoPlayer.timescale}` : ''), 1200, now);
    }
  }
  clk.elapsed = 0; // (assigned in two branches, not a ?: : a double through a phi was a new heap number)
  if (!paused) clk.elapsed = (now - last) / 1000;
  const elapsed = clk.elapsed;
  last = now;
  if (bench.until) {
    // A heap that shrank: a garbage collection ran (Chrome's performance.memory).
    const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const grew = bench.heap ? heap - bench.heap : 0;
    if (grew < 0) {
      tag('gc');
      bench.gcs++;
      bench.gcFreed -= grew;
      bench.gcMax = Math.max(bench.gcMax, -grew);
    } else bench.alloc += grew;
    bench.heap = heap;
  }

  // Scopes: CS:GO fovs per zoom level; sensitivity scales with zoom_sensitivity_ratio_mouse.
  const held = activeWeapon(ws);
  touch.setAlt(altLabel(held));
  const zoom = held && held.altKind === 'scope' && player.health > 0 ? ws.f[WS_ZOOM] : 0;
  const fovTarget = zoom ? held.zoomFov[zoom] : 90;
  clk.fov += (fovTarget - clk.fov) * (1 - Math.exp(-Math.min(elapsed, 0.1) * ZOOM_RATE));
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
  if (sounds.music !== cv.snd_musicvolume.number) sounds.setMusic(cv.snd_musicvolume.number);
  pollPads(elapsed, now);
  if (deadView) input.mouseDX = input.mouseDY = 0;
  input.applyMouse(angles);
  // The CPU clock only while something reads it (cl_showfps 3, the benchmark): each
  // performance.now() is a new heap number.
  const timing = bench.until > 0 || cv.cl_showfps.number >= 3;
  const t0 = timing ? performance.now() : 0;
  clk.accumulator += elapsed;
  clk.drawDt += elapsed;
  if (clk.serverClock >= 0) clk.serverClock += Math.min(elapsed, 0.25) * TICK_RATE;
  let ticks = 0;
  while (clk.accumulator >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
    tick();
    clk.accumulator -= TICK_DT;
    ticks++;
  }
  if (ticks === MAX_TICKS_PER_FRAME) clk.accumulator = 0; // fell far behind (tab was hidden)
  ticksSinceDraw += ticks;
  const t1 = timing ? performance.now() : 0;
  if (bench.until) {
    bench.parts[0] += t1 - t0;
    bench.ticks += ticks;
  }
  clk.cpuSim += t1 - t0;
  // Draw this frame? A browser with vsync off calls us as fast as we return: fps_max caps
  // the rate and r_frames_ahead holds a frame back while the GPU pipeline is full (see
  // client/gl/framegate.js). The ticks and the mouse ran whatever happens here.
  const gap = now - lastDraw, fpsMax = cv.fps_max.number;
  if (!renderer.gate.ready(cv.r_frames_ahead.number, now)) {
    if (bench.until) bench.skipped++;
    return;
  }
  if (fpsMax > 0 && gap < 1000 / fpsMax - 0.5) {
    if (bench.until) bench.capped++;
    return;
  }
  lastDraw = now;
  clk.frameMsMax = Math.max(clk.frameMsMax, gap);
  if (bench.until) { // the gap, and what the frame before it carried (ticksSinceDraw, bench.dom, the tags)
    bench.frames++;
    if (ticksSinceDraw > 2) tag(`${ticksSinceDraw} ticks`);
    if (bench.dom) tag(`${bench.dom} DOM writes`);
    if (bench.n < bench.gaps.length) {
      bench.gaps[bench.n] = gap;
      bench.kind[bench.n++] = (ticksSinceDraw ? 1 : 0) | (bench.dom ? 2 : 0);
    }
    if (gap > HITCH_MS && bench.hitches.length < MAX_HITCHES) {
      bench.hitches.push([now - bench.start, gap, frameTags.join(', ')]);
    }
    frameTags.length = 0;
    bench.dom = 0;
  }
  ticksSinceDraw = 0;
  if (cv.r_dynres.bool) {
    const t = renderer.timer, repeat = cv.r_drawrepeat.number;
    gpuRead.readings = t.readings;
    gpuRead.frameMs = t.frameMs * repeat;
    gpuRead.behind = t.behind / repeat;
    if (dynres.frame(gap, now, t.ext ? gpuRead : null)) {
      tag('resolution step');
      dynresSaved = false;
    } else if (!dynresSaved && dynres.settled(now)) saveDynres();
  }
  lapAt = t1;
  renderer.timer.on = cv.cl_showfps.number >= 3 || (bench.until > 0 && bench.passes);
  if (bench.until && renderer.timer.readings) {
    bench.gpu += renderer.timer.frameMs;
    bench.gpuN++;
  }
  clk.alpha = clk.accumulator / TICK_DT;
  draw(now, Math.min(clk.drawDt, 0.1));
  clk.drawDt = 0;
  renderer.timer.endFrame();
  if (previewEdit) previewEdit.draw();
  // r_drawrepeat: the same frame again (no time passing), for the GPU readout.
  for (let i = 1; i < cv.r_drawrepeat.number; i++) {
    draw(now, 0);
    renderer.timer.endFrame();
  }
  renderer.gate.drawn(now);
  if (timing) clk.cpuDraw += performance.now() - t1;
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
      const t = renderer.timer, gpu = t.readings ? `  gpu ${t.frameMs.toFixed(1)} ms, ${t.behind.toFixed(1)} frames behind` : '';
      lines.push(`fps: ${fps.toFixed(0)}${cv.cl_showfps.number > 1 ? `  worst frame: ${clk.frameMsMax.toFixed(1)} ms  res ${renderScale()}${gpu}` : ''}`);
    }
    if (cv.cl_showfps.number >= 3) {
      // CPU: the simulation ticks, then building and sending the frame (the draw calls).
      lines.push(`cpu: sim ${(clk.cpuSim / frames).toFixed(2)} ms · frame ${(clk.cpuDraw / frames).toFixed(2)} ms`);
      if (!bench.until) gpuText = renderer.timer.report() || gpuText; // the benchmark reads its own window
      if (gpuText) lines.push(gpuText);
    }
    clk.cpuSim = clk.cpuDraw = 0;
    if (cv.cl_showpos.number) {
      lines.push(`pos: ${f[0].toFixed(0)} ${f[1].toFixed(0)} ${f[2].toFixed(0)}`,
        `ang: ${angles[0].toFixed(1)} ${angles[1].toFixed(1)}`,
        `vel: ${Math.hypot(f[PS_VEL], f[PS_VEL + 1]).toFixed(1)}  z ${f[PS_VEL + 2].toFixed(0)}` +
        `${fl & FL_ONGROUND ? '  ground' : ''}${fl & FL_DUCKING ? '  duck' : ''}${noclip || fl & FL_NOCLIP ? '  NOCLIP' : ''}`);
    }
    const text = lines.join('\n');
    if (debug.textContent !== text) debug.textContent = text;
    frames = 0;
    fpsTime = now;
    clk.frameMsMax = 0;
  }
  const gi = graphInfo;
  gi.fps = fps;
  gi.rtt = netStats.rtt;
  gi.compared = netStats.compared;
  gi.corrected = netStats.corrected;
  gi.interpTicks = cv.cl_interp_ratio.number;
  netGraph.update(cv.net_graph.bool, now, net, gi);
}

// A frame: dt seconds since the last drawn one (an argument: boxed once here, then handed on
// to a dozen callees as it is; read from a field, each call boxed it again); alpha, the
// share of a tick since the last, in clk.
function draw(now, dt) {
  const alpha = clk.alpha;
  clock.t = now / 1000;
  const f = ps.f;
  const k = Math.exp(-dt * SMOOTH_RATE);
  smooth[0] *= k;
  smooth[1] *= k;
  smooth[2] *= k;
  eye[0] = prevOrigin[0] + (f[PS_ORIGIN] - prevOrigin[0]) * alpha + smooth[0];
  eye[1] = prevOrigin[1] + (f[PS_ORIGIN + 1] - prevOrigin[1]) * alpha + smooth[1];
  eye[2] = prevOrigin[2] + (f[PS_ORIGIN + 2] - prevOrigin[2]) * alpha + smooth[2];
  eye[2] += clk.prevEye + (eyeOffset(ps) - clk.prevEye) * alpha;
  // The camera shows a fraction of the aim punch (view_recoil_tracking) plus its own
  // jolt per shot, which decays at view_punch_decay.
  const kk = Math.exp(-dt * RECOIL.viewPunchDecay);
  viewKick[0] *= kk;
  viewKick[1] *= kk;
  cam[0] = angles[0] + clk.prevPunchP + (viewPunchPitch(ws) - clk.prevPunchP) * alpha + viewKick[0];
  cam[1] = angles[1] + clk.prevPunchY + (viewPunchYaw(ws) - clk.prevPunchY) * alpha + viewKick[1];

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
  const interpolated = net && synced && interpolatePlayers(clk.serverClock - cv.cl_interp_ratio.number, interp);
  const roamedBefore = spectator.mode === SPEC_ROAM;
  const spectating = interpolated && dead &&
    spectator.update(interp, selfId, player.team, (now - deadAt) / 1000, buttons, specTeam);
  const roaming = spectating && spectator.mode === SPEC_ROAM;
  deadView = dead && !roaming;
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
    const a = roaming ? angles : specAngles;
    cam[0] = a[0];
    cam[1] = a[1];
    lastCam[0] = eye[0];
    lastCam[1] = eye[1];
    lastCam[2] = eye[2];
    lastCam[3] = cam[0];
    lastCam[4] = cam[1];
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
    models.setBomb(b.state === BOMB_DROPPED || b.state === BOMB_PLANTED || b.state === BOMB_DEFUSED, b,
      b.state === BOMB_PLANTED && now - lastBeep < 120, world && world.surfaces);
  }
  if (net && synced) bombBeeps(now);
  lap(1);

  // r_hidpi: the screen's own pixels (up to 2 per page pixel) for crisp ink on high-DPI
  // screens; lines and dots keep their size (they scale with the canvas height).
  // r_dynres: the render scale (the scene's resolution under the full-resolution print)
  // lower while frames come late, down to half the canvas.
  const aspect = applyVideoSettings();
  renderer.zoom = 90 / clk.fov;
  renderer.begin();
  const fovY = 2 * Math.atan(Math.tan(clk.fov / 2 * DEG) * 0.75);
  weaponView.fovY = fovY; // the crosshair's spread circle
  // The camera in water (or slime, lava): the print fogs over (Renderer.style.liquid), the
  // world wobbles (GoldSrc's underwater field of view, as Xash3D draws it) and the hearing
  // is muffled.
  const liquid = world ? pointContents(world, eye[0], eye[1], eye[2]) : -1;
  const under = liquid <= -3 && liquid >= -5 ? liquid : 0;
  renderer.style.liquid = under;
  sounds.setUnder(under !== 0);
  perspective(proj, fovY, aspect, 4, 16384);
  if (under) {
    const wob = 0.03 * Math.sin(1.5 * clock.t);
    proj[0] *= 0.97 + wob;
    proj[5] *= 1.03 - wob;
  }
  viewFromEye(view, eye, cam);
  multiply(viewProj, proj, view);
  invert(invViewProj, viewProj);
  debris.update(dt, world);
  fx.update(net ? clk.serverClock - cv.cl_interp_ratio.number : tickCount - 1 + alpha, world && world.surfaces);
  sounds.listen(eye, cam);
  scape.effects(fx.cur, dt);
  if (net && synced) {
    scape.others(interp, selfId, dt, rowFeet);
  }
  const practicing = !net || demo();
  practice.showTrails = practicing && cv.sv_grenade_trajectory.bool;
  practice.showImpacts = practicing && cv.sv_showimpacts.bool;
  practice.now = now / 1000;
  tracers.now = now / 1000;
  tracers.screen[0] = canvas.width;
  tracers.screen[1] = canvas.height;
  practice.screen[0] = canvas.width;
  practice.screen[1] = canvas.height;
  renderer.render(viewProj, invViewProj, eye, overlays);
  lap(2);

  // The radar centers on whoever we see the game through.
  const watched = spectating && !roaming ? spectator.target : -1, w = watched * E_FIELDS;
  radar.pings = callouts.live(now, radarPings);
  if (watched >= 0) {
    radarAt[0] = interp[w + E_X];
    radarAt[1] = interp[w + E_Y];
    radarAt[2] = interp[w + E_Z] - 36;
  } else {
    radarAt[0] = eye[0];
    radarAt[1] = eye[1];
    radarAt[2] = eye[2] - eyeOffset(ps);
  }
  radarAt[3] = cam[1];
  radar.draw(playing, radarAt, interpolated ? interp : null, selfId, watched, player.team,
    (gameMode() & GAME_FFA) !== 0, net ? net.own.bomb : null, net ? net.hostages : null, now);
  lap(3);
  hud.update(net ? net.own.round : null, net ? net.own.bomb : null, player.money, now, leader(), progress());
  hud.roundPanel(net ? net.own.round : null, net, selfId);
  document.body.classList.toggle('dm', freeBuys() || gunGame()); // no money in deathmatch, the demo, the gun games
  const action = ws.f[WS_ACTION];
  const simTime = (tickCount - 1 + alpha) * TICK_DT;
  const actionTime = action === ACTION_PLANT ? PLANT_TIME : player.defuser ? DEFUSE_TIME_KIT : DEFUSE_TIME;
  const picking = net && !action && player.health > 0 ? net.own.useProgress : 0;
  const carryC4 = ws.f[WS_SLOTS + SLOT_C4 * 3] > 0 && player.health > 0;
  hud.bombStatus(carryC4, // (the site test only with the C4: its three doubles were boxed every frame)
    carryC4 && world.bombSites.touches(f[PS_ORIGIN], f[PS_ORIGIN + 1], f[PS_ORIGIN + 2], 16, 16, 36),
    action === ACTION_PLANT ? 'Planting the bomb' : action === ACTION_DEFUSE ? 'Defusing the bomb'
    : picking > 0 ? 'Picking up the hostage' : '',
    picking > 0 ? picking : 1 - (ws.f[WS_ACTION_END] - simTime) / actionTime);
  hud.useHint(useHint(dead || specTeam || !!action || preview || frozen()));
  hud.refreshMenu(player, net ? (net.own.flags & OWN_CAN_BUY) !== 0 : true, freeBuys());
  hud.scoreboard((input.buttons & IN_SCORE) !== 0 && input.locked, net, selfId, rowAlive);

  weaponView.hidden = dead && !inEyes;
  const target = spectator.target * E_FIELDS;
  weaponView.team = inEyes ? interp[target + E_TEAM] : player.team;
  // The held weapon is lit by the map under the player, eased like other models.
  if (inEyes) {
    lightAt[0] = interp[target + E_X];
    lightAt[1] = interp[target + E_Y];
    lightAt[2] = interp[target + E_Z];
  } else {
    lightAt[0] = f[PS_ORIGIN];
    lightAt[1] = f[PS_ORIGIN + 1];
    lightAt[2] = f[PS_ORIGIN + 2];
  }
  if (world && world.surfaces.lightAtP(lightSample, lightAt)) {
    modelLight(lightTarget, lightSample);
    const k = 1 - Math.exp(-dt * 8);
    for (let c = 0; c < 3; c++) weaponView.light[c] += (lightTarget[c] - weaponView.light[c]) * k;
  }
  // Our death as a comic panel until the camera goes to someone (at most a second past
  // the spectating delay: with nobody to watch it would stay), the print easing to red.
  const dying = dead && !!net && !spectating && !specTeam && !preview && now - deadAt < (SPEC_DELAY + 1) * 1000;
  deathPanel.show(dying);
  renderer.style.dead += ((dying ? 1 : 0) - renderer.style.dead) * Math.min(1, dt * (dying ? 6 : 10));
  if (renderer.style.dead < 0.005) renderer.style.dead = 0;
  // The camera inside a smoke cloud: the print fogs over (eased, so crossing the cloud's
  // shell is a short fade, not a pop).
  const smoked = fx.cur.smokeDepthAt(eye);
  renderer.style.smoke += (smoked - renderer.style.smoke) * Math.min(1, dt * 12);
  if (renderer.style.smoke < 0.005) renderer.style.smoke = 0;
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
  lap(4);
  renderer.timer.mark(PASS.VIEW);
  weaponView.viewmodel.own = !inEyes;
  if (inEyes) {
    spectator.syncWeapon(interp, now / 1000, dt, weaponView);
    weaponView.draw(canvas.height, aspect, spectator.ws, spectator.ps, 0, now / 1000, dt,
      interp[target + E_HEALTH], player.armor);
  } else if (!preview) { // the editor's 3D view shows the map alone
    weaponView.draw(canvas.height, aspect, ws, ps, lastButtons, simTime, dt, Math.max(player.health, 0),
      player.armor);
  }
  lap(5);
  // Print the frame, then what goes over it; the flashbang's afterimage is taken from it.
  renderer.composite();
  words.enabled = cv.cl_comicwords.bool && cv.cl_drawhud.bool;
  words.update(now);
  if (hurtDir.active) hurtDir.update(clock.t, eye[0], eye[1], angles[1], !dead && !spectating && !preview);
  callouts.update(now, viewProj, headOf, playing && !preview);
  if (net) showFlash(player.health > 0 ? net.own.flashLeft : 0, net.own.flashTotal);
  else showFlash(flash.left, flash.total);
  renderer.timer.mark(PASS.OVER);
  if (!preview) weaponView.drawCrosshair(canvas.width, canvas.height);
  lap(6);
}

// The video cvars into the renderer, sizing the canvas and the G-buffer; returns the aspect.
function applyVideoSettings() {
  const most = cv.mat_viewportscale.number;
  dynres.most = most;
  dynres.min = Math.min(1, 0.5 / most);
  renderer.maxPixels = cv.r_supersample_max.number * 1e6;
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
  models.sunOn = cv.r_playershadows.bool;
  style.inkaa = cv.r_inkaa.bool;
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
  clock.t = now / 1000;
  renderer.render(viewProj, invViewProj, eye, null);
  renderer.composite();
}

// Hidden tabs get no animation frames (and timers at most once a second): keep
// applying snapshots and events so the world is current when we come back.
setInterval(() => {
  if (!document.hidden || !net || !synced) return;
  if (net.poll()) applySnapshot();
  applyEvents();
  drainMessages(true);
}, 250);

// The console lines, chat lines and pings the net client queued. A hidden tab takes them as
// they come (on return, minutes of them showed as new: old radio balloons, every ping's
// notes at once), its pings dropped.
function drainMessages(hidden) {
  while (net.prints.length) conWin.print(net.prints.shift());
  while (net.chats.length) addChat(net.chats.shift());
  while (net.pings.length) {
    const p = net.pings.shift();
    if (hidden) continue;
    callouts.ping(p.x, p.y, p.z, performance.now());
    sounds.ping();
  }
}

// --- Console commands and key binds ------------------------------------------------

// Keys run their binds (the console window takes keys while it is open; the buy menu
// takes Escape and its number keys). `+` binds only act while playing (mouse captured),
// or with the buy menu open, where we keep moving (not shooting: the mouse is the menu's).
const MENU_HELD = new Set(['+attack', '+attack2']);
input.keepKeys = () => hud.menuOpen;
input.onKey = (key, down) => {
  if (conWin.isOpen || chat.isOpen) return false;
  if (callouts.menu >= 0 && down && (key === 'escape' || /^[0-9]$/.test(key))) { // the radio menu takes them
    const cmd = key === 'escape' ? callouts.close() : callouts.pick(+key);
    if (cmd) con.exec(cmd);
    return true;
  }
  if (hud.menuOpen && down && (key === 'escape' || /^[0-9]$/.test(key))) {
    if (key === 'escape') closeBuyMenu();
    else hud.menuKey(+key || 10);
    return true;
  }
  const b = binds.get(key);
  if (b === undefined) return false;
  if (menu.visible && b !== 'toggleconsole' && b !== 'togglemenu') return false; // the menu takes the keys (typing a name)
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
con.command('togglemenu', () => { // Escape's job for a gamepad's Start: the pause menu, or back to the game
  if (!playing) return;
  if (input.locked) input.unlock();
  else if (!conWin.isOpen && !hud.menuOpen) input.lock();
}, 'Opens the pause menu, or resumes the game');
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
  input.unlock();
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
// Chat (client/chat.js): the typed line goes to the server as say / say_team; its lines
// come back as CHAT messages for the box (and the console).
// The text goes as the rest of the command line, as typed (the server reads it raw: a `;`
// or quotes in it are text, not commands; the console's own `say` joins its arguments).
const say = (text, team) => {
  if (net) net.command(`${team ? 'say_team' : 'say'} ${text}`);
  else addChat({ sender: selfId, flags: team ? CHAT_TEAM : 0, text: text.slice(0, CHAT_MAX) }); // the sandbox: nobody else to hear
};
const chat = new Chat(document.getElementById('chat'), document.getElementById('chatline'), say,
  (id) => (net ? net.names[id] : cv.name.value), (id) => (net ? net.teams[id] : player.team));
chat.onToggle = (open) => {
  if (open) input.clear(); // the held keys let go (the mouse stays captured)
};
function addChat(m) {
  chat.add(m.sender, m.flags, m.text);
  if (m.flags & CHAT_RADIO) callouts.say(m.sender, m.text, performance.now());
  const name = m.sender === CHAT_CONSOLE ? 'Console' : (net ? net.names[m.sender] : cv.name.value) || `player${m.sender}`;
  conWin.print(`${(m.flags & CHAT_RADIO) ? '(radio) ' : (m.flags & CHAT_TEAM) ? '(team) ' : ''}${name} : ${m.text}`);
}
const sayCommand = (a, ctx, team) => {
  const text = a.slice(1).join(' ').trim();
  if (!text) return con.out(ctx, `${team ? 'say_team' : 'say'} <text>`);
  say(text, team);
};
con.command('say', (a, ctx) => sayCommand(a, ctx, false), 'say <text>: chat to everyone');
con.command('say_team', (a, ctx) => sayCommand(a, ctx, true), 'say_team <text>: chat to your team');
con.command('messagemode', () => {
  if (playing && !menu.visible) chat.open(false);
}, 'Types a chat line to everyone (Y)');
con.command('messagemode2', () => {
  if (playing && !menu.visible) chat.open(true);
}, 'Types a chat line to your team (U)');
// Radio (CS:GO's): each line's own command, the three menus (Z / X / C), and the ping.
for (const [cmd, text] of RADIO) {
  con.command(cmd, () => {
    if (net) net.command(cmd);
  }, `Radio: "${text}"`);
}
for (let k = 0; k < 3; k++) {
  con.command(`radio${k + 1}`, () => {
    if (playing && !menu.visible) callouts.open(k);
  }, `Opens radio menu ${k + 1} (${'ZXC'[k]}): a number key sends a line`);
}
con.command('player_ping', () => {
  if (net) net.command('player_ping');
}, 'Marks the place you look at for your team (middle mouse)');
con.command('drawradar', () => {
  radar.hidden = false;
}, 'Shows the radar');
con.command('hideradar', () => {
  radar.hidden = true;
}, 'Hides the radar');
con.command('clear', () => conWin.clear(), 'Clears the console');
con.command('noclip', (_a, ctx) => {
  if (net) return net.command('noclip'); // the server's (the demo, or sv_cheats 1)
  noclip = !noclip;
  con.out(ctx, `noclip ${noclip ? 'ON' : 'OFF'}`);
}, 'Fly through walls (the sandbox; online the demo mode or sv_cheats 1)');
// Practice positions (CS:GO players' configs): where we stand and look, per map and slot,
// in localStorage; load_pos goes back there with setpos / setang (the demo, the sandbox,
// sv_cheats).
const posKey = (slot) => `comicstrike.pos.${currentMap}.${slot}`;
const posSlot = (a) => Math.max(1, Math.min(9, Math.floor(+a[1]) || 1));
con.command('save_pos', (a, ctx) => {
  if (!world || player.health <= 0) return con.out(ctx, 'save_pos: in a game, alive');
  const slot = posSlot(a), f = ps.f, r = (v) => Math.round(v * 100) / 100;
  const pos = [r(f[PS_ORIGIN]), r(f[PS_ORIGIN + 1]), r(f[PS_ORIGIN + 2] - feetOffset(ps.i[PS_FLAGS]))];
  try {
    localStorage.setItem(posKey(slot), JSON.stringify({ pos, ang: [r(angles[0]), r(angles[1])] }));
  } catch {
    return con.out(ctx, 'save_pos: storage is blocked');
  }
  con.out(ctx, `position ${slot} saved: ${pos.join(' ')}`);
  hud.flash(`Position ${slot} saved`, 1200, performance.now());
}, 'save_pos [1-9]: keeps where you stand and look on this map (load_pos brings you back)');
con.command('load_pos', (a, ctx) => {
  const slot = posSlot(a);
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(posKey(slot)));
  } catch { /* storage blocked or spoiled */ }
  const ok = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  if (!saved || !ok(saved.pos, 3) || !ok(saved.ang, 2)) return con.out(ctx, `load_pos: no position ${slot} saved on ${currentMap}`);
  con.exec(`setpos ${saved.pos.join(' ')}; setang ${saved.ang.join(' ')}`, ctx);
}, 'load_pos [1-9]: back to a position saved with save_pos (the demo, the sandbox, sv_cheats 1)');
con.command('setpos', (a, ctx) => {
  const v = a.slice(1, 4).map(Number);
  if (v.length < 3 || !v.every(Number.isFinite)) return con.out(ctx, 'setpos <x> <y> <z>: moves your feet there (sv_cheats online)');
  if (net) return net.command(`setpos ${v.join(' ')}`);
  ps.f[PS_ORIGIN] = v[0];
  ps.f[PS_ORIGIN + 1] = v[1];
  ps.f[PS_ORIGIN + 2] = v[2] + feetOffset(ps.i[PS_FLAGS]);
}, 'setpos <x> <y> <z>: moves your feet there (online: needs sv_cheats 1 on the server)');
// Demos (client/demo.js): record a game we are in, play one back (a spectator, free).
let recorder = null; // DemoRecorder while recording
let demoPlayer = null; // DemoPlayer while a demo plays
let demoTitle = '', demoHeld = false, demoShownAt = 0;
const recorderState = { pitch: 0, yaw: 0, shots: 0, lastCmd: -1 }; // the recorder's row between snapshots
function stopRecording() {
  if (!recorder) return;
  const r = recorder, bytes = r.finish();
  recorder = null;
  if (net) net.recorder = null;
  saveDemo({ name: r.name, map: r.map, seconds: r.seconds }, bytes).then(
    () => {
      conWin.print(`demo ${r.name} saved: ${r.seconds.toFixed(1)} s, ${(bytes.length / 1024).toFixed(0)} KB (playback ${r.name})`);
      if (!demoList.includes(r.name)) demoList.push(r.name);
    },
    (err) => {
      conWin.print(`could not keep demo ${r.name} (${err.message || err}): downloading it`);
      downloadDemo(r.name, bytes);
    });
}
async function playDemo(name, bytes) {
  const demo = decodeDemo(bytes);
  if (demo.header.protocol !== PROTOCOL_VERSION) {
    throw new Error(`recorded with protocol ${demo.header.protocol}, this game speaks ${PROTOCOL_VERSION}`);
  }
  if (playing) leaveGame();
  resetSession();
  menu.busy(`Loading demo ${name}...`);
  demoTitle = name;
  demoHeld = false;
  Object.assign(recorderState, { pitch: 0, yaw: 0, shots: 0, lastCmd: -1 });
  const dp = demoPlayer = new DemoPlayer(demo);
  dp.paused = true; // the kept state at once, the rest once the map is in
  net = new NetClient();
  net.playback = true;
  const n = net;
  net.onSnapshot = (k, own) => fillRecorderRow(n.ring, k, n.welcome ? n.welcome.playerId : -1, own, dp.cmds, recorderState);
  restoreRing(net.ring, dp.ring); // the first deltas' bases
  net.connectLocal(dp, '');
  const welcome = await net.join(TEAM_SPECTATOR, 0, 0, cv.name.value); // the HELLO goes nowhere: the WELCOME is the demo's
  selfId = -1; // nobody is us: the recorder is one of the players
  menu.busy(`Loading ${welcome.map}...`);
  useOwn = false;
  await loadMap(welcome.map);
  spectator.mode = SPEC_ROAM;
  conWin.print(`playing demo ${name}: ${demo.header.map}, ${(dp.length / 1000).toFixed(1)} s (demo_pause, demo_timescale; jump: eyes, chase, free)`);
  enterGame();
}
// The start menu's Recordings.
menu.onDemoList = () => listDemos();
menu.onDemoPlay = (name) => playback(['playback', name], { print: (s) => (menu.demoError = s) });
menu.onDemoDownload = (name) => loadDemo(name).then((b) => b && downloadDemo(name, b));
menu.onDemoDelete = (name) => deleteDemo(name).then(() => (demoList = demoList.filter((n) => n !== name)));
menu.onDemoFile = (file) => {
  menu.demoError = '';
  file.arrayBuffer().then(async (buf) => {
    const bytes = new Uint8Array(buf), demo = decodeDemo(bytes); // a bad file goes no further
    const base = demoName(demo.header.name) || demoName(file.name.replace(/\.csdemo$/i, '').replace(/[^\w-]/g, '_').slice(0, 40)) || 'demo';
    // A name of its own: saveDemo replaces a demo of the same name (a file named after one
    // of ours overwrote it), and the header's seconds as a number (a string broke `demos`).
    const saved = new Set((await listDemos().catch(() => [])).map((d) => d.name));
    let name = base;
    for (let n = 2; saved.has(name); n++) name = `${base.slice(0, 36)}-${n}`;
    await saveDemo({ name, map: demo.header.map, seconds: Math.max(0, +demo.header.seconds || 0) }, bytes).catch(() => {});
    if (!demoList.includes(name)) demoList.push(name);
    run(() => playDemo(name, bytes));
  }).catch((err) => {
    menu.demoError = `That file is not a demo this game can play: ${err.message || err}`;
    menu.render();
  });
};
con.command('record', (a, ctx) => {
  const name = demoName(a[1]);
  if (!name) return con.out(ctx, 'record <name>: letters, digits, _ and - (up to 40)');
  if (!net || net.playback || !synced) return con.out(ctx, 'record: in a game (online or practice)');
  if (useOwn || net.room) return con.out(ctx, 'record: a room or your own map cannot be played back (the demo keeps only the map name)');
  if (recorder) return con.out(ctx, `record: already recording ${recorder.name} (stop first)`);
  recorder = net.recorder = new DemoRecorder(net, name, currentMap, performance.now());
  con.out(ctx, `recording ${name} (stop ends it)`);
  hud.flash(`Recording ${name}`, 1500, performance.now());
}, 'record <name>: records this game as a demo, until stop (playback <name> plays it)');
con.command('stop', (_a, ctx) => {
  if (!recorder) return con.out(ctx, 'stop: not recording');
  stopRecording();
}, 'Ends the demo recording and keeps it (demos lists them)');
const playback = (a, ctx) => {
  const name = demoName(a[1]);
  if (!name) return con.out(ctx, 'playback <name>: a demo from demos');
  loadDemo(name).then((bytes) => {
    if (!bytes) return con.out(ctx, `playback: no demo ${name} (demos lists them)`);
    run(() => playDemo(name, bytes));
  }, (err) => con.out(ctx, `playback: ${err.message || err}`));
};
con.command('playback', playback, 'playback <name>: plays a recorded demo (as a spectator: free camera, jump to watch players)');
con.command('playdemo', playback, 'playdemo <name>: same as playback (CS:GO)');
con.command('demos', (_a, ctx) => {
  listDemos().then((list) => con.out(ctx, list.length ? list.map((d) =>
    `${d.name}  ${d.map}  ${(+d.seconds || 0).toFixed(1)} s  ${(d.size / 1024).toFixed(0)} KB  ${new Date(d.at).toLocaleString()}`).join('\n')
    : 'no demos (record <name> in a game)'), (err) => con.out(ctx, `demos: ${err.message || err}`));
}, 'Lists the recorded demos');
con.command('demo_download', (a, ctx) => {
  const name = demoName(a[1]);
  if (!name) return con.out(ctx, 'demo_download <name>');
  loadDemo(name).then((bytes) => bytes ? downloadDemo(name, bytes) : con.out(ctx, `no demo ${name}`),
    (err) => con.out(ctx, `demo_download: ${err.message || err}`));
}, 'demo_download <name>: saves a demo as a .csdemo file');
con.command('demo_delete', (a, ctx) => {
  const name = demoName(a[1]);
  if (!name) return con.out(ctx, 'demo_delete <name>');
  deleteDemo(name).then(() => {
    demoList = demoList.filter((n) => n !== name);
    con.out(ctx, `demo ${name} deleted`);
  }, (err) => con.out(ctx, `demo_delete: ${err.message || err}`));
}, 'demo_delete <name>: removes a recorded demo');
con.command('demo_pause', (_a, ctx) => {
  if (!demoPlayer) return con.out(ctx, 'demo_pause: no demo playing');
  demoHeld = !demoHeld;
}, 'Pauses or resumes the demo playing');
const demoNames = (i) => (i === 1 ? demoList : []);
let demoList = []; // the names for suggestions, refreshed when the console opens a demo command
for (const name of ['playback', 'playdemo', 'demo_download', 'demo_delete']) con.hint(name, demoNames);
listDemos().then((l) => (demoList = l.map((d) => d.name)), () => {});
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
  document.body.classList.toggle('softplay', input.locked && input.soft && !pads.connected); // the pause button and the touch controls (not for a pad's soft lock)
  if (!input.locked) {
    touch.reset();
    pads.reset();
  }
  if (preview) return menu.hide(); // the editor's 3D view: Escape only lets the mouse go
  if (!playing) return;
  if (input.locked) menu.hide();
  else if (!conWin.isOpen && !hud.menuOpen) menu.showPause();
}
input.onLockChange = updateOverlay;
// Touch controls (client/touch.js) under the soft lock: the stick, and buttons that run
// commands as a key named 'touch' would (held bits release with it).
const touch = new TouchControls(document.getElementById('touch'), input, (cmd) => con.exec(cmd, { key: 'touch' }));
// Gamepads (client/gamepad.js): polled every frame; the buttons are keys through the binds
// (or the Controls tab's key capture), the sticks move and look; a pad in use makes the
// lock soft (a pad press cannot take the pointer lock).
const pads = new Gamepads(input);
pads.onKey = (name, down) => {
  if (menu.capture) {
    if (down) menu.captured(name);
    return;
  }
  input.onKey(name, down);
};
input.padActive = () => pads.active(performance.now());
function pollPads(dt, now) {
  pads.yaw = cv.joy_yaw.number;
  pads.pitch = cv.joy_pitch.number;
  pads.dead = cv.joy_deadzone.number;
  pads.curve = cv.joy_response.number;
  pads.invert = cv.joy_invert.bool;
  pads.swap = cv.joy_swap.bool;
  pads.poll(pads.list(), dt, now);
}
const applyTouch = () => touch.setOptions({
  opacity: cv.touch_opacity.number, scale: cv.touch_scale.number, fireLeft: cv.touch_fire_left.bool,
});
for (const c of [cv.touch_opacity, cv.touch_scale, cv.touch_fire_left]) watch(c, applyTouch);
applyTouch();
// A tablet with a keyboard (iPadOS: the lock is soft, trackpad or not): the touch controls
// hide once a bound key plays, and come back at the next touch on the canvas.
document.addEventListener('keydown', (e) => {
  if (input.soft && !e.repeat && binds.get(keyName(e.code, e.key)) !== undefined) document.body.classList.add('keysonly');
});
canvas.addEventListener('touchstart', () => document.body.classList.remove('keysonly'), { passive: true });
document.getElementById('pausebtn').addEventListener('click', () => input.unlock());
// The pause button sits beside the round bar: its width goes to CSS as the bar's text changes
// (on the button itself: set on body, each write restyled the whole page, 102 elements in
// 1-1.8 ms, once a second as the clock's text changed width).
new ResizeObserver((entries) => {
  document.getElementById('pausebtn').style.setProperty('--roundbar-w', `${entries[entries.length - 1].borderBoxSize?.[0]?.inlineSize ??
    entries[entries.length - 1].target.offsetWidth}px`);
}).observe(document.getElementById('roundbar'));
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
menu.onRoom = (code) => { // a listed room picked in the Play panel
  setRoom(code);
  menu.fetchServer();
};
menu.room = roomCode;
menu.onPractice = (map, team, opts) => run(() => startPractice(map, team, opts));
menu.onPracticeOwn = (map, team, opts) => run(() => startPractice(map, team, { ...opts, own: true }));
menu.onResume = () => input.lock().catch(() => {}).finally(updateOverlay); // already soft-locked: the menu still goes
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
  const welcome = await net.join(team, primary, secondary, cv.name.value, cv.password.value);
  selfId = welcome.playerId;
  menu.busy(`Loading ${welcome.map}...`);
  await loadMap(welcome.map);
}

const NO_ITEMS = new Items(), NO_HOSTAGES = new Hostages();

// Forgets everything from the last game (server state, other players, effects).
function resetSession() {
  synced = false;
  practice.clear();
  roundSerial = -1;
  jingleCues.reset();
  lastOwnTeam = 0;
  words.clear();
  hurtDir.clear();
  callouts.clear();
  blasts.clear();
  chat.clear();
  deathPanel.show(false);
  renderer.style.dead = 0;
  renderer.style.smoke = 0;
  renderer.style.liquid = 0;
  sounds.setUnder(false);
  clk.serverClock = -1;
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
  useOwn = false;
  if (playing) leaveGame();
  resetSession();
  try {
    await joinServer(teamOfJoin(team));
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
async function hostRoom(map, team, { mode = 'competitive', players = 0, difficulty = 1, armoury = true, listed = false } = {}) {
  const bytes = ownMaps.get(map);
  if (!bytes) throw new Error('pick a map file first');
  if (playing) leaveGame();
  menu.busy(`Uploading ${map}...`);
  const q = new URLSearchParams({ file: `${map}.bsp`, mode, players: String(players), difficulty: String(difficulty),
    armoury: armoury ? '1' : '0', listed: listed ? '1' : '0' });
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
async function startPractice(map, team, { mode = 'competitive', players = 10, difficulty = 1, armoury = true, own = false } = {}) {
  useOwn = own;
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
      worker.postMessage({ type: 'start', map, mode, players, difficulty, armoury, bytes: own ? ownMaps.get(map) : undefined }); // bytes: copied
    });
  } catch (err) {
    worker.terminate();
    throw err;
  }
  worker.onmessage = worker.onerror = null;
  localWorker = worker;
  await joinServer(teamOfJoin(team));
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
  // Where it settled last time on this window size (else full), judged after the first seconds.
  const settled = dynresMemory()[screenKey()];
  dynres.reset(performance.now(), 2000, Array.isArray(settled) ? (+settled[0] || dynres.most) / dynres.most : 1,
    Array.isArray(settled) ? +settled[1] || 1 : 1);
  dynresSaved = true;
  menu.online = net !== null && !localWorker; // Disconnect, or Quit practice
  menu.server = net !== null; // spectating needs server rules
  menu.busy('');
  menu.hide();
  input.lock().catch(() => {});
  if (!input.locked && !preview) menu.showPause(); // locking may need a click: Resume (a soft lock is on at once)
}

// Back to the start menu (disconnect, quit practice, or the server went away).
let gameSerial = 0; // counts leaveGame: a reconnect still retrying gives up when it changed
function leaveGame(message = '') {
  gameSerial++;
  stopRecording();
  if (demoPlayer) demoPlayer.stop();
  demoPlayer = null;
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
  input.unlock();
  input.leaveFullscreen();
  menu.showStart(message);
}

// Map change (the server closed us with "changelevel"), or `retry`: join again on our
// current team; the WELCOME names the map.
let reconnecting = false;
async function reconnect() {
  if (reconnecting || !net || net.playback) return;
  reconnecting = true;
  const serial = gameSerial; // quitting meanwhile must not let a retry join the server
  stopRecording(); // a demo holds one map
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
        if (attempt >= 4 || serial !== gameSerial) throw err;
        await new Promise((r) => setTimeout(r, 500));
        if (serial !== gameSerial) throw err;
      }
    }
    if (serial !== gameSerial) throw new Error('left'); // quit while the map loaded
    status.style.display = 'none';
    menu.busy('');
    conWin.print(`connected: ${currentMap}`);
    reconnecting = false;
  } catch (err) {
    reconnecting = false;
    if (serial === gameSerial) leaveGame(`Disconnected: ${err.message}`);
  }
}

// The map editor (client/editor.html) and this page:
//  * ?preview: the editor's 3D view, in an iframe. The sandbox flies (noclip) through the
//    map the editor sends ('preview-map' { name, bytes }), keeping the camera when a rebuilt
//    map comes in; no menus, no HUD.
//  * ?fromeditor: a tab the editor's Try it opened; it takes the map the editor handed
//    over (client/handoff.js) and starts a practice game on it (the demo mode).
const preview = params.has('preview');
// The `fullscreen` cvar (Video tab): the page fills the screen when it takes the mouse,
// and in Chrome and Edge the keyboard is locked (Input.enterFullscreen). Not in the
// editor's 3D view.
const applyFullscreen = () => {
  input.fullscreen = cv.fullscreen.bool && !preview;
  if (!input.fullscreen) input.leaveFullscreen();
};
watch(cv.fullscreen, applyFullscreen);

// Our guns' looks (client/models/looks.js, Settings, Weapons): each mesh built when chosen.
for (const name of LOOK_GUNS) {
  const c = cv[`cl_finish_${name}`], apply = () => guns.setLook(WEAPON_ID[name], lookOf(name, c.number));
  apply();
  watch(c, apply);
}
applyFullscreen();
// Where the keyboard is not locked (Firefox; Chrome out of fullscreen) a Ctrl+W (crouch
// and forward) closes the tab: while a game runs with the mouse captured the browser asks
// first. Not at the menus, so a tab left from the pause menu closes without a question.
addEventListener('beforeunload', (e) => {
  if (!playing || !input.locked || preview) return;
  e.preventDefault();
  e.returnValue = ''; // Safari and older Chrome want this one
});
async function previewMap(name, bytes) {
  useOwn = true;
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
    (msg) => parent.postMessage(msg, location.origin), () => input.lock().catch(() => {}), () => input.unlock());
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
  const opts = { mode: m.mode, players: m.players, difficulty: m.difficulty, own: true };
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
  const map = params.get('map') || defaultMap(await fetch('/maps.json').then((r) => r.json(), () => [])) || 'de_dust2';
  if (params.has('practice')) {
    return await startPractice(map, team, { mode: params.get('mode') || 'deathmatch',
      players: +(params.get('players') ?? 10), difficulty: +(params.get('difficulty') ?? 1), armoury: params.get('armoury') !== '0' });
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
  debris,
  tracers,
  angles,
  input,
  tick,
  draw: () => draw(performance.now(), 1 / 60),
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
  words, // the comic words (measuring their DOM writes)
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
