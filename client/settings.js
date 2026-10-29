// The client's console: CS:GO client cvars, key binds, and the saved config (archived
// cvars + binds, kept in this browser's localStorage like CS:GO's config.cfg).

import { Console, FCVAR_ARCHIVE, FCVAR_PROTECTED } from '../shared/cvars.js';
import { Binds } from './binds.js';

const CONFIG_KEY = 'comicstrike.config.cfg';
const OLD_CONFIG_KEY = 'webcs.config.cfg'; // saved before the rename to ComicStrike: read once
const SAVE_DELAY_MS = 500;

export function createConsole(print) {
  const con = new Console(print);
  const binds = new Binds();
  let saveTimer = 0, loading = false;
  const save = () => {
    if (loading) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeConfig(), SAVE_DELAY_MS);
  };
  const writeConfig = () => {
    try {
      localStorage.setItem(CONFIG_KEY, ['// ComicStrike config (host_writeconfig)', ...con.archive(), ...binds.archive()].join('\n'));
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
  add('cl_showfps', 0, '1: frame rate, 2: plus the slowest frame, 3: plus CPU and GPU time per pass', 0, 3);
  add('r_novis', 0, '1: draw the whole world, not only what the map visibility data says can be seen (for comparisons)', 0, 1, 0);
  add('r_drawrepeat', 1, 'Draws each frame this many times (a GPU benchmark for cl_showfps 3: keeps the GPU busy, also on a hidden page)', 1, 50, 0);
  add('cl_showpos', 0, 'Position, angles and speed', 0, 1);
  add('net_graph', 0, 'Network graph: ping, loss, rates, prediction', 0, 1);
  add('cl_drawhud', 1, 'Draw the HUD', 0, 1);
  add('cl_comicwords', 1, 'Comic sound words: BAM! on hits, BLAM! on your shots, KA-BOOM! on explosions', 0, 1);
  add('sv_pausable', 1, '0: practice keeps running while the pause menu is up (for testing; online games never pause)', 0, 1, 0);
  add('cl_showhitboxes', 0, 'Draw other players as their hit boxes instead of their models', 0, 1);
  // Radar (client/radar.js).
  add('cl_radar_scale', 0.7, 'Radar zoom (smaller: more of the map)', 0.25, 1);
  add('cl_radar_rotate', 1, 'The radar turns with the view', 0, 1);
  add('cl_radar_always_centered', 1, '0: the radar stops at the map edges (when it does not turn)', 0, 1);
  add('cl_hud_radar_scale', 1, 'Radar size', 0.8, 1.3);
  // The comic print (client/gl/renderer.js).
  add('r_comic', 1, '1: ink lines and halftone dots, 0: plain lit colors', 0, 1);
  add('r_inkwidth', 1, 'Ink line width, relative to the screen height (0: no lines)', 0, 4);
  add('r_halftone', 1, 'Halftone dot size, relative to the screen height (0: flat tones)', 0, 4);
  add('r_shadebands', 0, 'Light printed in this many flat bands (0: smooth)', 0, 8);
  add('r_shadowlift', 0.3, 'Share of the shade taken away: dark corners print lighter', 0, 1);
  add('r_halftone_style', 1, 'Shade dots: 0 bold, 1 soft (finer, paler, less ink)', 0, 1);
  add('r_crosshair_clearzone', 1, 'Dots melt into flat tone round the crosshair: size of that zone (0: off)', 0, 3);
  add('r_inkfast', 0, 'Fast ink: lines from the four direct neighbors only (looks the same; saves little since the print fetches the diagonals only near edges)', 0, 1);
  add('mat_viewportscale', 1, 'Render resolution of the scene, relative to the window (the most r_dynres uses); the ink and dots are always printed at full resolution', 0.25, 1);
  add('r_dynres', 1, 'Automatic render resolution: lowers the scene resolution while frames come late (under 60 fps), raises it again when they keep up', 0, 1);
  add('r_hidpi', 0, 'Sharp: render at the screen pixel density on high-DPI screens (up to 2x; costs up to 4x the pixels)', 0, 1);
  add('r_lowlatency', 1, 'Low-latency display: frames go to the screen without the browser compositor (a frame less of mouse lag where the browser allows it; 0 if it tears during fast turns; takes effect on reload)', 0, 1);
  // View.
  add('viewmodel_fov', 60, 'Weapon model field of view', 54, 68);
  add('viewmodel_offset_x', 1, 'Weapon model offset: right', -2.5, 2.5);
  add('viewmodel_offset_y', 1, 'Weapon model offset: forward', -2, 2);
  add('viewmodel_offset_z', -1, 'Weapon model offset: up', -2, 2);
  // Sound, network, identity.
  add('volume', 1, 'Master volume', 0, 1);
  add('snd_footstep_volume', 1, 'Footstep volume (ours and other players)', 0, 2);
  add('cl_interp_ratio', 2, 'Other players are drawn this many ticks behind', 1, 2);
  add('name', 'player', 'Your name');
  add('rcon_password', '', 'Password for rcon commands', undefined, undefined, FCVAR_PROTECTED);

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
    loading = false;
    // The wheel used to jump by default; a config that still has that gets the new default
    // (weapon cycling, CS:GO's), saved.
    if (binds.get('mwheelup') === '+jump' && binds.get('mwheeldown') === '+jump') {
      con.exec('bind mwheelup invprev; bind mwheeldown invnext', { print: () => {} });
    }
  }
  return { con, binds, cv, save };
}

// Runs `fn` too when `cvar` changes (keeps its existing change handler).
export function watch(cvar, fn) {
  const prev = cvar.onChange;
  cvar.onChange = (c, old) => {
    if (prev) prev(c, old);
    fn(c, old);
  };
}
