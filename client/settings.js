// The client's console: CS:GO client cvars, key binds, and the saved config (archived
// cvars + binds, kept in this browser's localStorage like CS:GO's config.cfg).

import { Console, FCVAR_ARCHIVE, FCVAR_PROTECTED } from '../shared/cvars.js';
import { Binds } from './binds.js';

const CONFIG_KEY = 'webcs.config.cfg';
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
      localStorage.setItem(CONFIG_KEY, ['// WebCS config (host_writeconfig)', ...con.archive(), ...binds.archive()].join('\n'));
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
  add('cl_showfps', 0, '1: frame rate, 2: plus the slowest frame', 0, 2);
  add('cl_showpos', 0, 'Position, angles and speed', 0, 1);
  add('net_graph', 0, 'Network graph: ping, loss, rates, prediction', 0, 1);
  add('cl_drawhud', 1, 'Draw the HUD', 0, 1);
  add('cl_showhitboxes', 0, 'Draw other players as their hit boxes instead of their models', 0, 1);
  // View.
  add('viewmodel_fov', 60, 'Weapon model field of view', 54, 68);
  add('viewmodel_offset_x', 1, 'Weapon model offset: right', -2.5, 2.5);
  add('viewmodel_offset_y', 1, 'Weapon model offset: forward', -2, 2);
  add('viewmodel_offset_z', -1, 'Weapon model offset: up', -2, 2);
  // Sound, network, identity.
  add('volume', 1, 'Master volume', 0, 1);
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
    saved = localStorage.getItem(CONFIG_KEY);
  } catch { /* storage blocked */ }
  if (saved) {
    loading = true;
    con.exec(saved, { print: () => {} });
    loading = false;
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
