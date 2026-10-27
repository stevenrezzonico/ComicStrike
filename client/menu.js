// Start and pause menu, CS:GO style: a column of actions on the left and the open panel
// beside it. Outside a game: Play (join the server on a team), Practice (a map offline),
// Settings. In a game, when the mouse is released: Resume, Choose team, Settings,
// Disconnect. Settings edit the client cvars and binds through the console (so the
// console and the menu always agree, and every change is saved with the config).

import { keyName, MOUSE_NAMES } from './binds.js';
import { drawCrosshair2d } from './gl/crosshair.js';
import { quote } from '../shared/cvars.js';

const ESCAPE_GRACE_MS = 300; // the Escape that released the mouse must not resume at once

// Settings tabs. Rows: [kind, cvar, label, ...]: slider (min, max, step), toggle,
// select (options), or a custom row (preview, invert).
const STYLES = ['Default', 'Default static', 'Classic', 'Classic dynamic', 'Classic static', 'Legacy'];
const COLORS = ['Red', 'Green', 'Yellow', 'Blue', 'Cyan', 'Custom'];
const TABS = [
  ['Mouse', [
    ['slider', 'sensitivity', 'Sensitivity', 0.1, 8, 0.01],
    ['invert', 'm_pitch', 'Invert mouse'],
    ['slider', 'zoom_sensitivity_ratio_mouse', 'Scoped sensitivity ratio', 0.1, 3, 0.01],
    ['toggle', 'm_rawinput', 'Raw input'],
  ]],
  ['Crosshair', [
    ['preview'],
    ['toggle', 'crosshair', 'Show crosshair'],
    ['select', 'cl_crosshairstyle', 'Style', STYLES],
    ['slider', 'cl_crosshairsize', 'Length', 0, 10, 0.5],
    ['slider', 'cl_crosshairgap', 'Gap', -5, 5, 0.5],
    ['slider', 'cl_crosshairthickness', 'Thickness', 0, 3, 0.1],
    ['toggle', 'cl_crosshairdot', 'Center dot'],
    ['toggle', 'cl_crosshair_t', 'T style'],
    ['toggle', 'cl_crosshair_drawoutline', 'Outline'],
    ['slider', 'cl_crosshair_outlinethickness', 'Outline thickness', 0, 3, 1],
    ['select', 'cl_crosshaircolor', 'Color', COLORS],
    ['slider', 'cl_crosshaircolor_r', 'Red', 0, 255, 1],
    ['slider', 'cl_crosshaircolor_g', 'Green', 0, 255, 1],
    ['slider', 'cl_crosshaircolor_b', 'Blue', 0, 255, 1],
    ['toggle', 'cl_crosshairusealpha', 'Use alpha'],
    ['slider', 'cl_crosshairalpha', 'Alpha', 0, 255, 1],
  ]],
  ['Video', [
    ['slider', 'viewmodel_fov', 'Weapon field of view', 54, 68, 1],
    ['slider', 'viewmodel_offset_x', 'Weapon offset right', -2.5, 2.5, 0.1],
    ['slider', 'viewmodel_offset_y', 'Weapon offset forward', -2, 2, 0.1],
    ['slider', 'viewmodel_offset_z', 'Weapon offset up', -2, 2, 0.1],
    ['toggle', 'cl_drawhud', 'Show HUD'],
    ['select', 'cl_showfps', 'Frame rate', ['Off', 'FPS', 'FPS and slowest frame']],
    ['toggle', 'net_graph', 'Net graph'],
    ['toggle', 'cl_showpos', 'Show position'],
  ]],
  ['Audio', [
    ['slider', 'volume', 'Master volume', 0, 1, 0.01],
  ]],
  ['Controls', null],
];

// The controls tab: [label, command] per action, in groups.
const ACTIONS = [
  ['Movement', [['Forward', '+forward'], ['Back', '+back'], ['Strafe left', '+moveleft'], ['Strafe right', '+moveright'],
    ['Jump', '+jump'], ['Crouch', '+duck'], ['Walk', '+speed']]],
  ['Weapons', [['Fire', '+attack'], ['Secondary fire', '+attack2'], ['Reload', '+reload'], ['Inspect', '+lookatweapon'],
    ['Drop weapon', 'drop'], ['Last weapon', 'lastinv'], ['Next weapon', 'invnext'], ['Previous weapon', 'invprev'],
    ['Primary', 'slot1'], ['Pistol', 'slot2'], ['Knife', 'slot3'], ['Grenades', 'slot4'], ['Bomb', 'slot5']]],
  ['Game', [['Use', '+use'], ['Buy menu', 'buymenu'], ['Scoreboard', '+showscores'], ['Team menu', 'teammenu'],
    ['Console', 'toggleconsole']]],
];
const KEY_COLUMNS = 2;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (text, onClick, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

export class Menu {
  // con, cv, binds: the client console (client/settings.js).
  constructor(root, con, cv, binds) {
    this.root = root;
    this.con = con;
    this.cv = cv;
    this.binds = binds;
    this.inGame = false; // pause menu (in a game) or start menu
    this.online = false; // in game: on a server (else practice)
    this.panel = ''; // open panel: '', 'play', 'practice', 'team', 'settings'
    this.tab = 0;
    this.shownAt = 0;
    this.server = null; // connect.json, once fetched
    this.maps = null; // maps.json
    this.practiceMap = '';
    this.practiceTeam = 2;
    this.message = '';
    this.capture = null; // the key cell waiting for a key: { command, key }
    this.refreshers = []; // settings rows to update from their cvars
    // Set by the game.
    this.onPlay = (_team) => {};
    this.onPractice = (_map, _team) => {};
    this.onResume = () => {};
    this.onLeave = () => {};
    this.onTeam = (_team) => {};

    root.innerHTML = '';
    this.side = el('div', 'menu-side');
    this.side.append(el('h1', '', 'WebCS'));
    this.nav = el('nav', 'menu-nav');
    this.side.append(this.nav);
    this.note = el('div', 'menu-note');
    this.side.append(this.note);
    this.body = el('div', 'menu-panel');
    root.append(this.side, this.body);

    // Escape steps back; while waiting for a key, every key and button goes to the cell.
    globalThis.addEventListener('keydown', (e) => {
      if (!this.visible) return;
      if (this.capture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) this.captured(keyName(e.code, e.key));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.back();
      }
    }, true);
    globalThis.addEventListener('mousedown', (e) => {
      if (!this.capture || !MOUSE_NAMES[e.button]) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.captured(MOUSE_NAMES[e.button]);
    }, true);
    globalThis.addEventListener('wheel', (e) => {
      if (!this.capture || e.deltaY === 0) return;
      e.stopImmediatePropagation();
      this.captured(e.deltaY < 0 ? 'mwheelup' : 'mwheeldown');
    }, { capture: true, passive: true });
    globalThis.addEventListener('resize', () => this.drawPreview());
  }

  get visible() {
    return this.root.classList.contains('open');
  }

  // The start menu (no game running); `message` explains why we are here (an error).
  showStart(message = '') {
    this.inGame = false;
    this.message = message;
    this.panel = '';
    this.open();
    this.fetchServer();
  }

  // The pause menu over the game, optionally with a panel open ('team', 'settings').
  showPause(panel = '') {
    if (this.visible && this.inGame && !panel) return;
    this.inGame = true;
    this.message = '';
    this.panel = panel;
    this.open();
  }

  hide() {
    this.cancelCapture();
    this.root.classList.remove('open', 'pause');
  }

  // Busy text while connecting or loading (buttons stay, the note says what happens).
  busy(text) {
    this.message = text;
    this.note.textContent = text;
  }

  open() {
    this.cancelCapture();
    this.shownAt = performance.now();
    this.root.classList.add('open');
    this.root.classList.toggle('pause', this.inGame);
    this.render();
  }

  back() {
    if (this.capture) return this.cancelCapture();
    if (this.panel) {
      this.panel = '';
      this.render();
    } else if (this.inGame && performance.now() - this.shownAt > ESCAPE_GRACE_MS) {
      this.onResume();
    }
  }

  async fetchServer() {
    try {
      const [server, maps] = await Promise.all([
        fetch('/connect.json').then((r) => r.json()),
        fetch('/maps.json').then((r) => r.json()),
      ]);
      this.server = server;
      this.maps = maps;
    } catch {
      this.server = null;
      this.maps = this.maps || [];
    }
    if (this.visible && !this.inGame) this.render();
  }

  // --- Layout --------------------------------------------------------------------------

  render() {
    this.refreshers = [];
    const nav = this.nav;
    nav.innerHTML = '';
    const item = (label, panel, action) => {
      const b = button(label, action || (() => {
        this.panel = this.panel === panel ? '' : panel;
        this.render();
      }));
      if (panel && panel === this.panel) b.classList.add('active');
      nav.append(b);
    };
    if (this.inGame) {
      item('Resume', '', () => this.onResume());
      item('Choose team', 'team');
      item('Settings', 'settings');
      item(this.online ? 'Disconnect' : 'Quit practice', '', () => this.onLeave());
    } else {
      item('Play', 'play');
      item('Practice', 'practice');
      item('Settings', 'settings');
    }
    this.note.textContent = this.message;
    this.note.classList.toggle('error', /^(could not|disconnected|failed)/i.test(this.message));

    const body = this.body;
    body.innerHTML = '';
    body.classList.toggle('empty', !this.panel && this.inGame);
    if (this.panel === 'play') this.renderPlay(body);
    else if (this.panel === 'practice') this.renderPractice(body);
    else if (this.panel === 'team') this.renderTeam(body, (team) => this.onTeam(team));
    else if (this.panel === 'settings') this.renderSettings(body);
    else if (!this.inGame) this.renderWelcome(body);
  }

  renderWelcome(body) {
    body.append(el('h2', '', 'Welcome'));
    const row = el('label', 'menu-row');
    row.append(el('span', '', 'Name'));
    const name = el('input');
    name.maxLength = 31;
    name.value = this.cv.name.value;
    name.addEventListener('change', () => {
      const v = name.value.trim().slice(0, 31);
      if (v) this.cv.name.set(v);
      name.value = this.cv.name.value;
    });
    row.append(name);
    body.append(row);
    body.append(el('p', 'menu-hint', 'Play joins the server; Practice runs a map on your own, offline. ' +
      'Esc in game brings this menu back; ` opens the console.'));
  }

  renderPlay(body) {
    body.append(el('h2', '', 'Play online'));
    const s = this.server;
    body.append(el('p', 'menu-server', s
      ? `${s.hostname} · ${s.map} · ${s.players}/${s.maxPlayers} players`
      : 'No server answered.'));
    if (!s) return;
    this.renderTeam(body, (team) => this.onPlay(team), true);
  }

  // Team buttons, CS:GO jointeam numbers: 1 spectators (online only), 2 Terrorists,
  // 3 Counter-Terrorists; 0 auto-select.
  renderTeam(body, pick, auto = false) {
    if (!auto) body.append(el('h2', '', 'Choose team'));
    const row = el('div', 'menu-teams');
    row.append(button('Terrorists', () => pick(2), 't'));
    row.append(button('Counter-Terrorists', () => pick(3), 'ct'));
    if (auto) row.append(button('Auto-select', () => pick(0)));
    if (auto || this.online) row.append(button('Spectate', () => pick(1), 'spec'));
    body.append(row);
  }

  renderPractice(body) {
    body.append(el('h2', '', 'Practice'));
    const maps = this.maps || [];
    if (!maps.length) {
      body.append(el('p', 'menu-hint', this.maps ? 'No maps found in maps/.' : 'Loading maps...'));
      return;
    }
    if (!maps.includes(this.practiceMap)) this.practiceMap = maps.includes('de_dust2') ? 'de_dust2' : maps[0];
    const grid = el('div', 'menu-maps');
    for (const m of maps) {
      const b = button(m, () => {
        this.practiceMap = m;
        this.render();
      });
      b.title = m;
      if (m === this.practiceMap) b.classList.add('active');
      grid.append(b);
    }
    body.append(grid);
    const teams = el('div', 'menu-teams');
    for (const [n, label, cls] of [[2, 'Terrorists', 't'], [3, 'Counter-Terrorists', 'ct']]) {
      const b = button(label, () => {
        this.practiceTeam = n;
        this.render();
      }, cls);
      if (n === this.practiceTeam) b.classList.add('active');
      teams.append(b);
    }
    body.append(teams);
    body.append(button('Start', () => this.onPractice(this.practiceMap, this.practiceTeam), 'menu-go'));
  }

  // --- Settings ------------------------------------------------------------------------

  renderSettings(body) {
    const tabs = el('div', 'menu-tabs');
    TABS.forEach(([name], i) => {
      const b = button(name, () => {
        this.tab = i;
        this.render();
      });
      if (i === this.tab) b.classList.add('active');
      tabs.append(b);
    });
    body.append(tabs);
    const [, rows] = TABS[this.tab];
    const list = el('div', 'menu-settings');
    body.append(list);
    if (!rows) {
      this.renderControls(list);
      body.append(button('Restore default keys', () => {
        this.con.exec('binddefaults');
        this.render();
      }, 'menu-reset'));
      return;
    }
    for (const row of rows) list.append(this.settingRow(row));
    body.append(button('Restore defaults', () => {
      for (const row of rows) if (row[1]) this.cv[row[1]].set(this.cv[row[1]].defaultValue);
      this.refresh();
    }, 'menu-reset'));
    this.refresh();
  }

  settingRow([kind, name, label, a, b, step]) {
    const cv = this.cv[name];
    if (kind === 'preview') {
      const wrap = el('div', 'menu-preview');
      this.preview = el('canvas');
      wrap.append(this.preview);
      this.refreshers.push(() => this.drawPreview());
      return wrap;
    }
    const row = el('label', 'menu-row');
    row.title = `${name}: ${cv.help || ''}`;
    row.append(el('span', '', label));
    if (kind === 'slider') {
      const range = el('input');
      range.type = 'range';
      const num = el('input', 'num');
      num.type = 'number';
      for (const input of [range, num]) {
        input.min = a;
        input.max = b;
        input.step = step;
        input.addEventListener('input', () => {
          if (input.value !== '' && Number.isFinite(+input.value)) this.set(cv, input.value);
        });
      }
      num.addEventListener('change', () => this.refresh());
      row.append(range, num);
      this.refreshers.push(() => {
        range.value = cv.number;
        if (document.activeElement !== num) num.value = +cv.number.toFixed(4);
      });
    } else if (kind === 'toggle' || kind === 'invert') {
      row.classList.add('check');
      const box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        if (kind === 'invert') this.set(cv, (box.checked ? -1 : 1) * Math.abs(cv.number));
        else this.set(cv, box.checked ? 1 : 0);
      });
      row.append(box);
      this.refreshers.push(() => {
        box.checked = kind === 'invert' ? cv.number < 0 : cv.bool;
      });
    } else if (kind === 'select') {
      const sel = el('select');
      a.forEach((text, i) => sel.append(new Option(text, i)));
      sel.addEventListener('change', () => this.set(cv, sel.value));
      row.append(sel);
      this.refreshers.push(() => {
        sel.value = cv.number;
      });
    }
    return row;
  }

  set(cv, value) {
    cv.set(value);
    this.refresh();
  }

  refresh() {
    for (const f of this.refreshers) f();
  }

  drawPreview() {
    const c = this.preview;
    if (!c || !c.isConnected) return;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    // A sunlit wall and a shadowed one, to judge the color on both.
    ctx.fillStyle = '#b9a27a';
    ctx.fillRect(0, 0, w / 2, h);
    ctx.fillStyle = '#4b4f55';
    ctx.fillRect(w / 2, 0, w - w / 2, h);
    // Same size as in game: crosshair units scale with the game's screen height.
    drawCrosshair2d(ctx, this.cv, w, h, globalThis.innerHeight);
  }

  // --- Key binds -----------------------------------------------------------------------

  // Keys bound to exactly `command`: keyboard keys first, then mouse buttons, the wheel last
  // (the saved config lists binds alphabetically).
  keysOf(command) {
    const rank = (k) => (k.startsWith('mwheel') ? 2 : k.startsWith('mouse') ? 1 : 0);
    const keys = [];
    for (const [k, v] of this.binds.map) if (v === command) keys.push(k);
    return keys.sort((a, b) => rank(a) - rank(b));
  }

  renderControls(list) {
    for (const [group, actions] of ACTIONS) {
      list.append(el('h3', '', group));
      for (const [label, command] of actions) {
        const row = el('div', 'menu-row menu-bind');
        row.title = command;
        row.append(el('span', '', label));
        const keys = this.keysOf(command);
        for (let i = 0; i < KEY_COLUMNS; i++) {
          const key = keys[i] || '';
          const cell = button(key ? key.toUpperCase() : '-', () => this.startCapture(cell, command, key), 'key');
          row.append(cell);
        }
        list.append(row);
      }
    }
    list.append(el('p', 'menu-hint', 'Click a key, then press the new key or mouse button. Backspace clears it, ' +
      'Escape cancels. Everything else is in the console (bind, unbind).'));
  }

  startCapture(cell, command, key) {
    this.cancelCapture();
    cell.textContent = 'press a key';
    cell.classList.add('waiting');
    // The click that started this must not be taken as the new key.
    setTimeout(() => {
      if (cell.isConnected) this.capture = { cell, command, key };
    }, 0);
  }

  cancelCapture() {
    if (!this.capture) return;
    this.capture = null;
    if (this.panel === 'settings') this.render();
  }

  captured(name) {
    const { command, key } = this.capture;
    this.capture = null;
    if (name !== 'escape') {
      if (key) this.con.exec(`unbind ${quote(key)}`);
      if (name !== 'backspace' && name !== 'del') this.con.exec(`bind ${quote(name)} ${quote(command)}`);
    }
    this.render();
  }
}
