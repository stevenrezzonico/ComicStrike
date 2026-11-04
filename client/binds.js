// Key bindings, CS:GO style: Source key names, `bind <key> "<commands>"`, and CS:GO's
// default binds. A binding starting with `+` runs its `-` twin when the key goes up.

import { quote } from '../shared/cvars.js';

// KeyboardEvent.code -> Source key name.
const CODE_NAMES = {
  Space: 'space', Tab: 'tab', Enter: 'enter', Escape: 'escape', Backspace: 'backspace', Backquote: '`',
  ShiftLeft: 'shift', ShiftRight: 'rshift', ControlLeft: 'ctrl', ControlRight: 'rctrl', AltLeft: 'alt',
  AltRight: 'ralt', CapsLock: 'capslock', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: 'semicolon', Quote: "'", Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
  ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow', ArrowRight: 'rightarrow',
  Insert: 'ins', Delete: 'del', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn', Pause: 'pause',
  Numpad0: 'kp_ins', Numpad1: 'kp_end', Numpad2: 'kp_downarrow', Numpad3: 'kp_pgdn', Numpad4: 'kp_leftarrow',
  Numpad5: 'kp_5', Numpad6: 'kp_rightarrow', Numpad7: 'kp_home', Numpad8: 'kp_uparrow', Numpad9: 'kp_pgup',
  NumpadEnter: 'kp_enter', NumpadAdd: 'kp_plus', NumpadSubtract: 'kp_minus', NumpadMultiply: 'kp_multiply',
  NumpadDivide: 'kp_slash', NumpadDecimal: 'kp_del',
};

// KeyboardEvent.key -> Source name, for events without a physical code (virtual keyboards).
const KEY_NAMES = { ' ': 'space', Escape: 'escape', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Shift: 'shift',
  Control: 'ctrl', Alt: 'alt', ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow',
  ArrowRight: 'rightarrow' };

// Source key name of a key event: by physical key (code), else by character (key).
export function keyName(code, key = '') {
  if (!code) return KEY_NAMES[key] || key.toLowerCase();
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d+$/.test(code)) return code.toLowerCase();
  return code.toLowerCase();
}

// Mouse buttons (MouseEvent.button) -> Source names.
export const MOUSE_NAMES = ['mouse1', 'mouse3', 'mouse2', 'mouse4', 'mouse5'];

// Gamepad buttons (the Gamepad API's standard mapping, by index) -> Source's names
// (client/gamepad.js polls them).
export const PAD_NAMES = ['a_button', 'b_button', 'x_button', 'y_button', 'l_shoulder', 'r_shoulder', 'l_trigger',
  'r_trigger', 'back', 'start', 'stick1', 'stick2', 'up', 'down', 'left', 'right'];
// Their default binds (after CS:GO's controller layout where it is known): the right
// trigger fires, the left one is the right mouse button, A jumps, B crouches, X reloads,
// Y the next weapon, LB uses, RB the last weapon, L3 walks, R3 the knife, the D-pad buys,
// drops, grenades and the bomb, Back the scoreboard, Start the pause menu.
export const PAD_BINDS = {
  r_trigger: '+attack', l_trigger: '+attack2', a_button: '+jump', b_button: '+duck', x_button: '+reload',
  y_button: 'invnext', l_shoulder: '+use', r_shoulder: 'lastinv', stick1: '+speed', stick2: 'slot3',
  up: 'buymenu', down: 'drop', left: 'slot4', right: 'slot5', back: '+showscores', start: 'togglemenu',
};

// Every key name bind takes, for the console's suggestions.
export const KEY_LIST = [...new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''), ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ...Object.values(CODE_NAMES), ...MOUSE_NAMES, 'mwheelup', 'mwheeldown', ...PAD_NAMES,
])];

// CS:GO's default binds (config_default.cfg), the wheel cycling weapons as there (a saved
// config keeps its own binds; binddefaults).
export const DEFAULT_BINDS = {
  w: '+forward', s: '+back', a: '+moveleft', d: '+moveright', space: '+jump', ctrl: '+duck', shift: '+speed',
  e: '+use', r: '+reload', f: '+lookatweapon', g: 'drop', q: 'lastinv', b: 'buymenu', m: 'teammenu', tab: '+showscores',
  y: 'messagemode', u: 'messagemode2',
  '`': 'toggleconsole', mouse1: '+attack', mouse2: '+attack2', mwheelup: 'invprev', mwheeldown: 'invnext',
  1: 'slot1', 2: 'slot2', 3: 'slot3', 4: 'slot4', 5: 'slot5',
  ...PAD_BINDS,
};

export class Binds {
  constructor() {
    this.map = new Map(); // key name -> commands
    this.defaults();
  }

  defaults() {
    this.map.clear();
    for (const [k, v] of Object.entries(DEFAULT_BINDS)) this.map.set(String(k), v);
  }

  get(key) {
    return this.map.get(key);
  }

  // `bind`, `unbind`, `unbindall`, `binddefaults`, `key_listboundkeys` on a Console;
  // onChange() runs after every change (to save the config).
  register(con, onChange) {
    con.command('bind', (a, ctx) => {
      const key = (a[1] || '').toLowerCase();
      if (!key) return con.out(ctx, 'bind <key> "<commands>"');
      if (a.length === 2) {
        return con.out(ctx, this.map.has(key) ? `"${key}" = ${quote(this.map.get(key))}` : `"${key}" is not bound`);
      }
      this.map.set(key, a.slice(2).join(' '));
      onChange();
    }, 'bind <key> "<commands>": runs commands when the key is pressed');
    con.command('unbind', (a) => {
      this.map.delete((a[1] || '').toLowerCase());
      onChange();
    }, 'unbind <key>');
    // Suggestions: the key, then for bind the commands (with what the key does now).
    con.hint('bind', (i) => {
      if (i === 1) return KEY_LIST.map((k) => (this.map.has(k) ? [k, this.map.get(k)] : k));
      return i === 2 ? con.names() : [];
    });
    con.hint('unbind', (i) => (i === 1 ? [...this.map].sort().map(([k, v]) => [k, v]) : []));
    con.command('unbindall', () => {
      this.map.clear();
      onChange();
    }, 'Removes every key binding');
    con.command('binddefaults', () => {
      this.defaults();
      onChange();
    }, 'Restores the CS:GO default key bindings');
    con.command('key_listboundkeys', (_a, ctx) => {
      for (const [k, v] of [...this.map].sort()) con.out(ctx, `"${k}" = ${quote(v)}`);
    }, 'Lists every bound key');
  }

  // Defaults added after a config was saved (it wipes with unbindall, then lists its own
  // binds, so a new default never reached it): binds each of `commands` to its default key
  // where the config binds that command to no key and leaves the key free. Returns whether
  // anything was bound.
  adopt(commands) {
    let changed = false;
    const bound = new Set(this.map.values());
    for (const [key, cmd] of Object.entries(DEFAULT_BINDS)) {
      if (!commands.includes(cmd) || bound.has(cmd) || this.map.has(key)) continue;
      this.map.set(key, cmd);
      changed = true;
    }
    return changed;
  }

  // Keys added after a config was saved (the gamepad's): each of `keys` gets its default
  // where the config leaves it free. Returns whether anything was bound.
  adoptKeys(keys) {
    let changed = false;
    for (const key of keys) {
      if (this.map.has(key) || !DEFAULT_BINDS[key]) continue;
      this.map.set(key, DEFAULT_BINDS[key]);
      changed = true;
    }
    return changed;
  }

  // Config lines: wipe, then every binding.
  archive() {
    return ['unbindall', ...[...this.map].sort().map(([k, v]) => `bind ${quote(k)} ${quote(v)}`)];
  }
}
