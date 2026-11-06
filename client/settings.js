// The client's console: CS:GO client cvars, key binds, and the saved config (archived
// cvars + binds, kept in this browser's localStorage like CS:GO's config.cfg).

import { Console, FCVAR_ARCHIVE, FCVAR_PROTECTED, parse } from '../shared/cvars.js';
import { Binds, PAD_NAMES } from './binds.js';
import { LOOK_GUNS, LOOKS, looksOf } from './models/looks.js';

const CONFIG_KEY = 'comicstrike.config.cfg';
const OLD_CONFIG_KEY = 'webcs.config.cfg'; // saved before the rename to ComicStrike: read once
// Defaults added after configs were already being saved.
const NEW_BINDS = ['messagemode', 'messagemode2', 'noclip', 'save_pos', 'load_pos', 'bot_place', 'radio1', 'radio2', 'radio3',
  'player_ping', 'vote option1', 'vote option2'];
const SAVE_DELAY_MS = 500;
// The config's first line; a config saved under another one (before the defaults below
// changed) takes those defaults once, as it loads.
const CONFIG_HEADER = '// ComicStrike config 2 (host_writeconfig)';
// shortcut: one generation of changed defaults; on the next change, key a list of them by the header's number.
const CHANGED_DEFAULTS = 'r_halftone 0; r_crosshair_clearzone 0; r_dynres 0';

export function createConsole(print) {
  const con = new Console(print);
  const binds = new Binds();
  let saveTimer = 0, loading = false;
  const save = () => {
    if (loading) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeConfig(), SAVE_DELAY_MS);
  };
  const configText = () => [CONFIG_HEADER, ...con.archive(), ...binds.archive()].join('\n');
  const writeConfig = () => {
    try {
      localStorage.setItem(CONFIG_KEY, configText());
      return true;
    } catch {
      return false; // storage blocked (private window): settings last for this page only
    }
  };

  const cv = {};
  const add = (name, value, help, min, max, flags = FCVAR_ARCHIVE) => {
    cv[name] = con.cvar(name, value, { help, min, max, flags, onChange: flags & FCVAR_ARCHIVE ? save : undefined });
  };
  // Mouse.
  add('sensitivity', 2.5, 'Mouse sensitivity', 0.0001, 1000);
  add('m_yaw', 0.022, 'Degrees per mouse count, horizontal', 0.001, 1);
  add('m_pitch', 0.022, 'Degrees per mouse count, vertical', -1, 1);
  add('m_rawinput', 1, 'Raw mouse input (no OS acceleration)', 0, 1);
  add('zoom_sensitivity_ratio_mouse', 1, 'Scoped sensitivity, relative to the zoom', 0.001, 20);
  // Crosshair (CS:GO defaults).
  add('crosshair', 1, 'Draw the crosshair', 0, 1);
  add('cl_crosshairstyle', 2, '0 default, 1 default static, 2 classic, 3 classic dynamic, 4 classic static, 5 legacy',
    0, 5);
  add('cl_crosshairsize', 5, 'Arm length', 0, 100);
  add('cl_crosshairgap', 1, 'Space between the arms', -20, 20);
  add('cl_crosshairthickness', 0.5, 'Arm thickness', 0, 10);
  add('cl_crosshairdot', 0, 'Center dot', 0, 1);
  add('cl_crosshair_t', 0, 'T style: no top arm', 0, 1);
  add('cl_crosshair_drawoutline', 1, 'Black outline', 0, 1);
  add('cl_crosshair_outlinethickness', 1, 'Outline thickness (px)', 0, 3);
  add('cl_crosshaircolor', 1, '0 red, 1 green, 2 yellow, 3 blue, 4 cyan, 5 custom (cl_crosshaircolor_r/g/b)', 0, 5);
  add('cl_crosshaircolor_r', 50, 'Custom color red', 0, 255);
  add('cl_crosshaircolor_g', 250, 'Custom color green', 0, 255);
  add('cl_crosshaircolor_b', 50, 'Custom color blue', 0, 255);
  add('cl_crosshairusealpha', 1, 'Use cl_crosshairalpha', 0, 1);
  add('cl_crosshairalpha', 200, 'Crosshair opacity', 0, 255);
  // HUD and diagnostics.
  add('cl_showfps', 0, '1: frame rate, 2: plus the slowest frame, resolution, GPU time and lag, 3: plus CPU and GPU time per pass (timing every pass slows a GPU near its limit)', 0, 3);
  add('r_novis', 0, '1: draw the whole world, not only what the map visibility data says can be seen (for comparisons)', 0, 1, 0);
  add('r_drawrepeat', 1, 'Draws each frame this many times (a GPU benchmark for cl_showfps 3: keeps the GPU busy, also on a hidden page)', 1, 50, 0);
  add('cl_showpos', 0, 'Position, angles and speed', 0, 1);
  add('net_graph', 0, 'Network graph: ping, loss, rates, prediction', 0, 1);
  add('cl_drawhud', 1, 'Draw the HUD', 0, 1);
  add('cl_autowepswitch', 1, 'Switch to a weapon you buy or pick up when it is better than the one in hand (CS:GO)', 0, 1);
  add('cl_comicwords', 1, 'Comic sound words: BAM! on hits, BLAM! on your shots, KA-BOOM! on explosions', 0, 1);
  add('sv_pausable', 1, '0: practice keeps running while the pause menu is up (for testing; online games never pause)', 0, 1, 0);
  add('r_playershadows', 1, 'Players and hostages cast shadows along the sun where they stand in sunlight', 0, 1);
  add('r_lod_dist', 520, 'Players farther than this (units) draw as their coarse models (0: always; the models pass is triangle-bound)', 0, 100000, 0);
  add('cl_showhitboxes', 0, 'Draw other players as their hit boxes instead of their models', 0, 1);
  add('demo_timescale', 1, 'Demo playback speed', 0.1, 4, 0);
  // Practice marks (client/gl/practice.js): the demo mode and the sandbox only.
  add('sv_grenade_trajectory', 1, 'The demo and the sandbox: every grenade\'s arc as a line, kept 3 s after it lands', 0, 1);
  add('sv_showimpacts', 1, 'The demo and the sandbox: your bullets\' impacts as small red boxes for 2 s', 0, 1);
  // Radar (client/radar.js).
  add('cl_radar_scale', 0.7, 'Radar zoom (smaller: more of the map)', 0.25, 1);
  add('cl_radar_rotate', 1, 'The radar turns with the view', 0, 1);
  add('cl_radar_always_centered', 1, '0: the radar stops at the map edges (when it does not turn)', 0, 1);
  add('cl_hud_radar_scale', 1, 'Radar size', 0.8, 1.3);
  // The comic print (client/gl/renderer.js).
  add('r_comic', 1, '1: the comic print (ink lines, shade in flat tones or halftone dots), 0: plain lit colors', 0, 1);
  add('r_inkwidth', 1, 'Ink line width, relative to the screen height (0: no lines)', 0, 4);
  add('r_halftone', 0, 'Halftone dot size, relative to the screen height (0: flat tones)', 0, 4);
  add('r_shadebands', 0, 'Light printed in this many flat bands (0: smooth)', 0, 8);
  add('r_shadowlift', 0.3, 'Share of the shade taken away: dark corners print lighter', 0, 1);
  add('r_halftone_style', 1, 'Shade dots: 0 bold, 1 soft (finer, paler, less ink)', 0, 1);
  add('r_crosshair_clearzone', 0, 'Dots melt into flat tone round the crosshair: size of that zone (0: off)', 0, 3);
  add('r_inkaa', 1, 'Smooth ink lines: at the full render resolution the steps of a slanted line get grey corners (below it the lines are filtered anyway)', 0, 1);
  add('mat_viewportscale', 2, 'Render resolution of the scene, relative to the window (the most r_dynres uses; over 1 supersamples: smoother edges and lines, for a strong GPU; capped by the GPU and r_supersample_max); the dots are always printed at the window resolution', 0.25, 8);
  add('r_supersample_max', 64, 'Supersampling: the most megapixels the scene is rendered at (the GPU memory it takes: ~15 bytes a pixel)', 1, 512);
  add('r_dynres', 0, 'Automatic render resolution: lowers the scene resolution while frames come late (under 60 fps), raises it again when they keep up', 0, 1);
  add('r_hidpi', 0, 'Sharp: render at the screen pixel density on high-DPI screens (up to 2x; costs up to 4x the pixels)', 0, 1);
  add('r_lowlatency', 1, 'Low-latency display: frames go to the screen without the browser compositor (a frame less of mouse lag where the browser allows it; 0 if it tears during fast turns; takes effect on reload)', 0, 1);
  add('fullscreen', 0, 'Fullscreen while playing: the page fills the screen when it takes the mouse; in Chrome and Edge the keyboard is locked too, so Ctrl+W, Ctrl+T and Alt+Tab stay in the game (hold Escape 2 s to leave)', 0, 1);
  // Gamepads (client/gamepad.js).
  add('joy_yaw', 180, 'Gamepad: degrees a second the view turns at full deflection of the look stick', 10, 720);
  add('joy_pitch', 120, 'Gamepad: degrees a second the view pitches at full deflection', 10, 720);
  add('joy_deadzone', 0.2, 'Gamepad: the look stick does nothing within this much of its travel', 0, 0.9);
  add('joy_response', 2, 'Gamepad: the look stick\'s response curve, the deflection to this power (1 linear; 2 fine near the center)', 0.5, 4);
  add('joy_invert', 0, 'Gamepad: invert the look stick\'s pitch', 0, 1);
  add('joy_swap', 0, 'Gamepad: swap the sticks (move with the right, look with the left)', 0, 1);
  // Touch controls (client/touch.js).
  add('touch_opacity', 0.45, 'Touch buttons: how opaque (a pressed one is always solid)', 0.1, 1);
  add('touch_scale', 1, 'Touch buttons: size', 0.7, 1.4);
  add('touch_fire_left', 1, 'Touch: a second FIRE button on the left, above the stick, for the left thumb', 0, 1);
  add('fps_max', 400, 'Frame rate cap (0: none); matters only where the browser runs with vsync off, else frames come at the display rate', 0, 1000);
  add('r_frames_ahead', 3, 'Frames the browser may hold in its GPU pipeline before the next is drawn (0: no limit); a browser with vsync off otherwise queues frames (mouse lag) and stalls once the queue is full', 0, 8);
  // View.
  add('viewmodel_fov', 60, 'Weapon model field of view', 54, 68);
  add('viewmodel_offset_x', 1, 'Weapon model offset: right', -2.5, 2.5);
  add('viewmodel_offset_y', 1, 'Weapon model offset: forward', -2, 2);
  add('viewmodel_offset_z', -1, 'Weapon model offset: up', -2, 2);
  add('viewmodel_pitch', 0, 'Weapon model turned: muzzle up (degrees)', -30, 30);
  add('viewmodel_yaw', 0, 'Weapon model turned: muzzle toward the middle of the screen (degrees)', -30, 30);
  add('viewmodel_roll', 0, 'Weapon model tilted: top toward the middle of the screen (degrees)', -45, 45);
  add('cl_righthand', 1, 'Weapon in the right hand (0: the left, the first-person view mirrored)', 0, 1);
  // Sound, network, identity.
  add('volume', 1, 'Master volume', 0, 1);
  add('snd_footstep_volume', 1, 'Footstep volume (ours and other players)', 0, 2);
  add('snd_musicvolume', 0.5, 'Comic jingles: round start and end, bomb planted, the last 10 seconds, match end (0: off)', 0, 1);
  add('cl_interp_ratio', 2, 'Other players are drawn this many ticks behind', 1, 2);
  add('name', 'player', 'Your name');
  add('rcon_password', '', 'Password for rcon commands', undefined, undefined, FCVAR_PROTECTED);
  add('password', '', 'The server\'s password (its sv_password), sent on joining', undefined, undefined, FCVAR_PROTECTED);
  // Our guns' looks (client/models/looks.js; Settings, Weapons).
  for (const name of LOOK_GUNS) {
    const looks = looksOf(name).map((k, i) => `${i} ${LOOKS[k].label}`).join(', ');
    add(`cl_finish_${name}`, 0, `Finish of your ${name}: ${looks}`, 0, looksOf(name).length - 1);
  }

  binds.register(con, save);
  con.command('host_writeconfig', (_a, ctx) => {
    clearTimeout(saveTimer);
    con.out(ctx, writeConfig() ? 'config saved' : 'could not save the config (storage blocked)');
  }, 'Saves settings and binds now (they also save on every change)');

  // Saved settings over the defaults.
  let saved = null;
  try {
    saved = localStorage.getItem(CONFIG_KEY) ?? localStorage.getItem(OLD_CONFIG_KEY);
  } catch { /* storage blocked */ }
  if (saved) {
    loading = true;
    con.exec(saved, { print: () => {} });
    // Every archived cvar is saved, so an old config holds the old defaults (dots, automatic resolution).
    const old = !saved.startsWith(CONFIG_HEADER);
    if (old) con.exec(CHANGED_DEFAULTS, { print: () => {} });
    loading = false;
    // The wheel used to jump by default; a config that still has that gets the new default
    // (weapon cycling, CS:GO's), saved.
    if (binds.get('mwheelup') === '+jump' && binds.get('mwheeldown') === '+jump') {
      con.exec('bind mwheelup invprev; bind mwheeldown invnext', { print: () => {} });
    }
    // Binds that came after the first configs (the chat keys): on their default keys where
    // the config left those free.
    if (binds.adopt(NEW_BINDS)) save();
    // The gamepad's keys (added later too) on their defaults where the config leaves them free.
    if (binds.adoptKeys(PAD_NAMES)) save();
    if (old) writeConfig();
  }
  // What a bind from a file may run when its key is pressed: the game's own commands and
  // settings, nothing that reaches a server (rcon, or a name the client does not know, which
  // goes to a practice server or our room with its password), deletes a recording or binds and
  // defines more: a shared file's `bind mouse1 "+attack; demo_delete clutch"` ran on the shot.
  const BIND_REFUSED = new Set(['rcon', 'demo_delete', 'alias', 'exec', 'bind', 'unbind', 'unbindall', 'binddefaults',
    'map', 'changelevel', 'say', 'say_team', 'callvote', 'disconnect', 'playback', 'record', 'retry']);
  const bindable = (text) => parse(text).every((a) => {
    const n = a[0].toLowerCase(), cvar = con.cvars.get(n);
    return !BIND_REFUSED.has(n) && (con.commands.has(n) || con.aliases.has(n) || (cvar && !(cvar.flags & FCVAR_PROTECTED)));
  });
  // A file from Export settings (or written by hand): only what a config holds, archived
  // cvars and binds, is run; any other command in it is dropped. Returns how many ran.
  const importConfig = (text) => {
    let n = 0;
    for (const args of parse(text)) {
      const name = args[0].toLowerCase(), cvar = con.cvars.get(name);
      if (name !== 'bind' && name !== 'unbindall' && !(cvar && cvar.flags & FCVAR_ARCHIVE)) continue;
      if (name === 'bind' && args.length > 2 && !bindable(args.slice(2).join(' '))) continue;
      con.run(args, { print: () => {} });
      n++;
    }
    return n;
  };
  return { con, binds, cv, save, configText, importConfig };
}

// Runs `fn` too when `cvar` changes (keeps its existing change handler).
export function watch(cvar, fn) {
  const prev = cvar.onChange;
  cvar.onChange = (c, old) => {
    if (prev) prev(c, old);
    fn(c, old);
  };
}
