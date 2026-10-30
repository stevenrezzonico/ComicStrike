// Start and pause menu, CS:GO style: a column of actions on the left and the open panel
// beside it. Outside a game: Play (join the server on a team), Practice (a map offline),
// Settings. In a game, when the mouse is released: Resume, Choose team, Settings,
// Disconnect. Settings edit the client cvars and binds through the console (so the
// console and the menu always agree, and every change is saved with the config).

import { keyName, MOUSE_NAMES } from './binds.js';
import { drawCrosshair2d } from './gl/crosshair.js';
import { quote } from '../shared/cvars.js';

const ESCAPE_GRACE_MS = 300; // the Escape that released the mouse must not resume at once
// Game mode names (server/host.js GAME_MODES) as shown.
const MODE_LABELS = {
  casual: 'Casual', competitive: 'Competitive', wingman: 'Wingman', armsrace: 'Arms Race', demolition: 'Demolition',
  deathmatch: 'Deathmatch', demo: 'Demo',
};

// The Bots row of the practice panel by mode: [label, [[bot_quota, text], ...]]. Team modes
// fill both sides (bot_quota_mode fill: the player counts); Wingman is 2 a side
// (mp_teamsize_max 2: more would sit as spectators); free-for-all modes count players, not
// sides; the demo's bots are respawning targets on the enemy team.
export function botOptions(mode) {
  if (mode === 'demo') return ['Targets', [[0, 'None'], [2, '1 bot'], [3, '2 bots'], [6, '5 bots']]];
  if (mode === 'wingman') return ['Bots', [[0, 'None'], [2, '1 vs 1'], [4, '2 vs 2']]];
  if (mode === 'deathmatch' || mode === 'armsrace') {
    return ['Bots', [[0, 'None'], [2, '2 players'], [4, '4 players'], [6, '6 players'], [10, '10 players']]];
  }
  return ['Bots', [[0, 'None'], [2, '1 vs 1'], [4, '2 vs 2'], [6, '3 vs 3'], [10, '5 vs 5']]];
}

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
    ['window'],
    ['section', null, 'Print'],
    ['toggle', 'r_comic', 'Comic print'],
    ['slider', 'r_inkwidth', 'Ink line width', 0, 3, 0.25],
    ['slider', 'r_halftone', 'Halftone dot size', 0, 3, 0.1],
    ['select', 'r_halftone_style', 'Shade dots', ['Bold', 'Soft']],
    ['slider', 'r_crosshair_clearzone', 'No dots round the crosshair', 0, 3, 0.25],
    ['slider', 'r_shadebands', 'Shadow bands (0: smooth)', 0, 6, 1],
    ['slider', 'r_shadowlift', 'Shadow brightness', 0, 1, 0.05],
    ['section', null, 'Resolution'],
    ['toggle', 'r_dynres', 'Automatic resolution (keeps 60 fps)'],
    ['select', 'r_inkfast', 'Ink lines', ['Full', 'Fast']],
    ['slider', 'mat_viewportscale', 'Render resolution (most; over 1: supersampling)', 0.5, 2, 0.05],
    ['select', 'r_hidpi', 'High-DPI screens', ['Page pixels', 'Sharp (screen pixels)']],
    ['toggle', 'r_lowlatency', 'Low-latency display (may tear; takes effect on reload)'],
    ['section', null, 'Weapon'],
    ['slider', 'viewmodel_fov', 'Weapon field of view', 54, 68, 1],
    ['slider', 'viewmodel_offset_x', 'Weapon offset right', -2.5, 2.5, 0.1],
    ['slider', 'viewmodel_offset_y', 'Weapon offset forward', -2, 2, 0.1],
    ['slider', 'viewmodel_offset_z', 'Weapon offset up', -2, 2, 0.1],
    ['section', null, 'HUD'],
    ['toggle', 'cl_drawhud', 'Show HUD'],
    ['toggle', 'cl_comicwords', 'Comic sound words'],
    ['slider', 'cl_hud_radar_scale', 'Radar size', 0.8, 1.3, 0.05],
    ['slider', 'cl_radar_scale', 'Radar zoom', 0.25, 1, 0.05],
    ['toggle', 'cl_radar_rotate', 'Rotate the radar'],
    ['toggle', 'cl_radar_always_centered', 'Radar always centered'],
    ['section', null, 'Debug'],
    ['select', 'cl_showfps', 'Frame rate', ['Off', 'FPS', 'FPS and slowest frame', 'FPS and time per pass']],
    ['toggle', 'net_graph', 'Net graph'],
    ['toggle', 'cl_showpos', 'Show position'],
  ]],
  ['Audio', [
    ['slider', 'volume', 'Master volume', 0, 1, 0.01],
    ['slider', 'snd_footstep_volume', 'Footsteps', 0, 2, 0.01],
  ]],
  ['Controls', null],
];

// The print settings the Video tab's window compares against their defaults while the
// compare button is held.
const PRINT_CVARS = ['r_comic', 'r_inkwidth', 'r_halftone', 'r_halftone_style', 'r_crosshair_clearzone',
  'r_shadebands', 'r_shadowlift', 'mat_viewportscale', 'r_inkfast'];

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
    this.online = false; // in game: on a remote server (else practice or the sandbox)
    this.server = false; // in game: server rules (online or practice), so spectating works
    this.practiceMode = 'competitive';
    this.practicePlayers = 10; // bot_quota fill: bots make up the rest
    this.demoPlayers = 0; // the demo: no bots unless asked for (targets)
    this.practiceDifficulty = 1;
    this.panel = ''; // open panel: '', 'play', 'practice', 'demo', 'own', 'team', 'settings'
    this.room = ''; // a room's code (a hosted map, server/rooms.js): Play joins it
    this.roomGone = false; // the room's code did not answer (it closed)
    this.ownMap = ''; // the map file picked in Your map (its name; the page holds the bytes)
    this.ownError = '';
    this.tab = 0;
    this.shownAt = 0;
    this.server = null; // connect.json, once fetched
    this.maps = null; // maps.json
    this.practiceMap = '';
    this.practiceTeam = 2;
    this.message = '';
    this.capture = null; // the key cell waiting for a key: { command, key }
    this.refreshers = []; // settings rows to update from their cvars
    // The Video tab's window: a hole clipped through the menu over the game canvas, so the
    // live print shows every setting as it changes (the game at the start menu is a backdrop
    // scene the page draws while the window is open: `onWindow`).
    this.hole = null; // the window's inner element while the Video tab is up
    this.holeRect = ''; // the clip-path last set
    this.holeBounds = null; // the hole's page rectangle while a scene shows through it
    this.windowOpen = false;
    this.windowReady = false; // a scene is drawn under it (else the note shows)
    this.comparing = null; // the print cvar values put back when the compare button is released
    // Set by the game.
    this.onPlay = (_team) => {};
    this.onPractice = (_map, _team) => {};
    this.onResume = () => {};
    this.onLeave = () => {};
    this.onTeam = (_team) => {};
    this.onMapFile = (_file) => Promise.resolve(''); // a map file picked: its name, or rejects with why not
    this.onHost = (_map, _team, _opts) => {};
    this.onLeaveRoom = () => {};
    this.onWindow = (_open) => {}; // the Video tab's window opened or closed

    root.innerHTML = '';
    this.side = el('div', 'menu-side');
    const logo = el('div', 'menu-logo');
    const mark = el('img');
    mark.src = '/client/favicon.svg';
    mark.alt = '';
    logo.append(mark, el('h1', '', 'ComicStrike'));
    this.side.append(logo);
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
  showStart(message = '', panel = '') {
    this.inGame = false;
    this.message = message;
    this.panel = panel;
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
    this.updateWindow();
  }

  // Tells the game when the Video tab's window comes and goes.
  updateWindow() {
    const open = this.visible && this.panel === 'settings' && this.hole !== null && this.hole.isConnected;
    if (open === this.windowOpen) return;
    this.windowOpen = open;
    if (!open) {
      this.compare(false);
      this.clip(null);
    }
    this.onWindow(open);
  }

  // Every frame while the menu is up: keeps the hole where the window is (the panel
  // scrolls and the page resizes). `ready`: a scene is drawn under it.
  frameWindow(ready) {
    if (!this.windowOpen) return;
    if (ready !== this.windowReady) {
      this.windowReady = ready;
      this.hole.classList.toggle('ready', ready);
    }
    this.clip(ready ? this.hole.getBoundingClientRect() : null);
  }

  clip(r) {
    const path = r && r.width > 0 ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ` +
      `${r.left}px ${r.top}px, ${r.left}px ${r.bottom}px, ${r.right}px ${r.bottom}px, ${r.right}px ${r.top}px, ` +
      `${r.left}px ${r.top}px)` : '';
    this.holeBounds = path ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
    if (path === this.holeRect) return;
    this.holeRect = path;
    this.root.style.clipPath = path;
  }

  // Held: the print settings at their defaults, to see what the changes do.
  compare(on) {
    if (on && !this.comparing) {
      this.comparing = PRINT_CVARS.map((n) => [this.cv[n], this.cv[n].value]);
      for (const [cv] of this.comparing) cv.set(cv.defaultValue);
    } else if (!on && this.comparing) {
      for (const [cv, v] of this.comparing) cv.set(v);
      this.comparing = null;
    }
    this.refresh();
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
    const room = this.room;
    try {
      const [server, maps] = await Promise.all([
        fetch(room ? `/connect.json?room=${room}` : '/connect.json').then((r) => {
          this.roomGone = !!room && r.status === 404;
          return this.roomGone ? fetch('/connect.json').then((m) => m.json()) : r.json();
        }),
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
      item('Demo', 'demo');
      item('Your map', 'own');
      item('Map editor', '', () => open('/client/editor.html', '_blank'));
      item('Settings', 'settings');
    }
    this.note.textContent = this.message;
    this.note.classList.toggle('error', /^(could not|disconnected|failed)/i.test(this.message));

    const body = this.body;
    body.innerHTML = '';
    if (this.panel === 'play') this.renderPlay(body);
    else if (this.panel === 'practice') this.renderPractice(body);
    else if (this.panel === 'demo') this.renderPractice(body, 'demo');
    else if (this.panel === 'own') this.renderPractice(body, 'own');
    else if (this.panel === 'team') this.renderTeam(body, (team) => this.onTeam(team));
    else if (this.panel === 'settings') this.renderSettings(body);
    else if (!this.inGame) this.renderWelcome(body);
    else if (this.room && this.online) this.renderInvite(body);
    body.classList.toggle('empty', !this.panel && this.inGame && !(this.room && this.online));
    this.updateWindow();
  }

  // The start page: what the game is, the server line, the name.
  renderWelcome(body) {
    body.append(el('h2', '', 'A comic strip you can shoot in'));
    body.append(el('p', 'menu-tagline', 'CS:GO’s movement, guns and economy on the classic CS 1.6 maps, ' +
      'printed live as a comic: flat colors, ink lines, halftone dots. Nothing to install: it runs in this tab.'));
    const feats = el('ul', 'menu-features');
    for (const t of [
      'Play online against others, or practice against bots in your browser.',
      'Competitive, casual, wingman, deathmatch, arms race, demolition and a demo playground.',
      'Procedural everything: no textures, models or sounds are downloaded.',
    ]) feats.append(el('li', '', t));
    body.append(feats);
    const s = this.server;
    body.append(el('p', 'menu-server', s
      ? `Server: ${s.hostname} · ${s.map} · ${MODE_LABELS[s.mode] || s.mode || 'Competitive'} · ` +
        `${s.players}/${s.maxPlayers} players`
      : this.server === null && this.maps ? 'No server answered: practice works offline.' : 'Looking for the server...'));
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
    body.append(el('p', 'menu-hint', 'In a game: Esc opens this menu, B buys, Tab shows the scores, ` opens the console.'));
  }

  renderPlay(body) {
    body.append(el('h2', '', this.room && !this.roomGone ? `Room ${this.room}` : 'Play online'));
    if (this.room) {
      body.append(el('p', 'menu-hint', this.roomGone
        ? `Room ${this.room} has closed (rooms close once nobody plays in them). This is the server's own game.`
        : 'A game on a map someone brought, on this server. Share this page\'s address to invite more players.'));
      body.append(button(this.roomGone ? 'OK' : 'Play the server\'s own game instead', () => this.onLeaveRoom()));
    }
    const s = this.server;
    body.append(el('p', 'menu-server', s
      ? `${s.hostname} · ${s.map} · ${MODE_LABELS[s.mode] || s.mode || 'Competitive'} · ${s.players}/${s.maxPlayers} players`
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
    if (auto || this.server) row.append(button('Spectate', () => pick(1), 'spec'));
    body.append(row);
  }

  // In a room: the link that brings friends in.
  renderInvite(body) {
    body.append(el('h2', '', `Room ${this.room}`));
    body.append(el('p', 'menu-hint', 'Friends who open this link join your room:'));
    const row = el('div', 'menu-row menu-invite');
    const link = el('input');
    link.readOnly = true;
    link.value = `${location.origin}/?room=${this.room}`;
    link.addEventListener('focus', () => link.select());
    const copy = button('Copy', () => {
      link.select();
      const done = () => {
        copy.textContent = 'Copied';
      };
      if (navigator.clipboard) navigator.clipboard.writeText(link.value).then(done, () => {});
      else if (document.execCommand('copy')) done();
    });
    row.append(link, copy);
    body.append(row);
    body.append(el('p', 'menu-hint', 'The server holds the map in memory only and drops it a couple of minutes ' +
      'after the last player leaves.'));
  }

  // Your map: a .bsp from the disk, played alone (practice: nothing leaves the page) or
  // hosted for friends (a room on the server).
  renderOwn(body) {
    body.append(el('p', 'menu-hint', 'Play any GoldSrc map (CS 1.6, BSP version 30) you have: alone against bots, ' +
      'all in this page, or host it for friends. Hosting sends the file to this server, which keeps it in memory ' +
      'only while people play.'));
    const pick = el('label', 'menu-drop');
    const input = el('input');
    input.type = 'file';
    input.accept = '.bsp';
    const take = (file) => {
      if (!file) return;
      this.ownError = '';
      pick.classList.add('busy');
      this.onMapFile(file).then((name) => {
        this.ownMap = name;
      }, (err) => {
        this.ownError = err.message || String(err);
      }).finally(() => this.render());
    };
    input.addEventListener('change', () => take(input.files[0]));
    pick.addEventListener('dragover', (e) => {
      e.preventDefault();
      pick.classList.add('over');
    });
    pick.addEventListener('dragleave', () => pick.classList.remove('over'));
    pick.addEventListener('drop', (e) => {
      e.preventDefault();
      pick.classList.remove('over');
      take(e.dataTransfer.files[0]);
    });
    pick.append(input, el('span', '', this.ownMap ? `${this.ownMap}.bsp (drop or click for another)` :
      'Drop a .bsp file here, or click to choose one'));
    body.append(pick);
    if (this.ownError) body.append(el('p', 'menu-hint menu-error', this.ownError));
  }

  // Practice, (demo) the demo mode: the same panel without the mode choice, bots optional
  // (targets), or (own) a map of the player's own: a file instead of the list of maps.
  renderPractice(body, kind = 'practice') {
    const demo = kind === 'demo', own = kind === 'own';
    body.append(el('h2', '', demo ? 'Demo' : own ? 'Your map' : 'Practice'));
    if (demo) {
      body.append(el('p', 'menu-hint', 'Try everything out: buy anything for free, anywhere, infinite ammo and ' +
        'grenades, you cannot die, plant and defuse the bomb yourself. Targets are enemy bots that respawn.'));
    }
    if (own) {
      this.renderOwn(body);
      if (!this.ownMap) return;
    }
    const maps = own ? [this.ownMap] : this.maps || [];
    if (!maps.length) {
      body.append(el('p', 'menu-hint', this.maps ? 'No maps found in maps/.' : 'Loading maps...'));
      return;
    }
    if (demo && !this.demoMapPicked && maps.includes('de_playground')) { // the demo opens on its playground
      this.practiceMap = 'de_playground';
      this.demoMapPicked = true;
    }
    if (!own && !maps.includes(this.practiceMap)) this.practiceMap = maps.includes('de_dust2') ? 'de_dust2' : maps[0];
    const grid = el('div', 'menu-maps');
    for (const m of own ? [] : maps) {
      const b = button(m, () => {
        this.practiceMap = m;
        this.render();
      });
      b.title = m;
      if (m === this.practiceMap) b.classList.add('active');
      grid.append(b);
    }
    if (!own) body.append(grid);
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
    const choice = (label, options, value, set) => { // a row of buttons, one picked
      const row = el('div', 'menu-row menu-choice');
      row.append(el('span', '', label));
      const opts = el('div', 'menu-opts'); // wraps onto more lines in a narrow panel
      for (const [v, text] of options) {
        const b = button(text, () => {
          set(v);
          this.render();
        });
        if (v === value) b.classList.add('active');
        opts.append(b);
      }
      row.append(opts);
      body.append(row);
    };
    if (!demo) {
      choice('Mode', [['casual', 'Casual'], ['competitive', 'Competitive'], ['wingman', 'Wingman'],
        ['deathmatch', 'Deathmatch'], ['armsrace', 'Arms Race'], ['demolition', 'Demolition']], this.practiceMode, (v) => {
        this.practiceMode = v;
      });
    }
    const [botLabel, botOpts] = botOptions(demo ? 'demo' : this.practiceMode);
    let players = demo ? this.demoPlayers : this.practicePlayers;
    if (!botOpts.some(([v]) => v === players)) { // the mode changed under a count it has not
      players = botOpts[botOpts.length - 1][0];
      if (demo) this.demoPlayers = players;
      else this.practicePlayers = players;
    }
    choice(botLabel, botOpts, players, (v) => {
      if (demo) this.demoPlayers = v;
      else this.practicePlayers = v;
    });
    if (players) {
      choice('Difficulty', [[0, 'Easy'], [1, 'Normal'], [2, 'Hard'], [3, 'Expert']], this.practiceDifficulty, (v) => {
        this.practiceDifficulty = v;
      });
    }
    const opts = { mode: demo ? 'demo' : this.practiceMode, players, difficulty: this.practiceDifficulty };
    if (!own) {
      body.append(button('Start', () => this.onPractice(this.practiceMap, this.practiceTeam, opts), 'menu-go'));
      return;
    }
    const go = el('div', 'menu-teams');
    go.append(button('Play alone', () => this.onPractice(this.ownMap, this.practiceTeam, opts), 'menu-go'));
    const host = button('Host for friends', () => this.onHost(this.ownMap, this.practiceTeam, opts), 'menu-go');
    host.disabled = !this.server;
    if (!this.server) host.title = 'Hosting needs the server, which did not answer';
    go.append(host);
    body.append(go);
  }

  // --- Settings ------------------------------------------------------------------------

  renderSettings(body) {
    this.hole = null;
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
    // The Video tab's window (the start menu only: in a game the print is right there)
    // stays put above the list, which scrolls under it.
    if (rows && !this.inGame) for (const row of rows) if (row[0] === 'window') body.append(this.settingRow(row));
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
    for (const row of rows) if (row[0] !== 'window') list.append(this.settingRow(row));
    body.append(button('Restore defaults', () => {
      for (const row of rows) if (row[1]) this.cv[row[1]].set(this.cv[row[1]].defaultValue);
      this.refresh();
    }, 'menu-reset'));
    this.refresh();
  }

  settingRow([kind, name, label, a, b, step]) {
    const cv = this.cv[name];
    if (kind === 'section') return el('h3', '', label);
    if (kind === 'window') {
      const wrap = el('div', 'menu-window');
      this.hole = el('div', 'hole');
      this.hole.append(el('span', 'note', 'Loading the preview scene...'));
      wrap.append(this.hole);
      const row = el('div', 'menu-row menu-compare');
      const hold = button('Hold to compare with the defaults', () => {}, 'menu-hold');
      for (const ev of ['mousedown', 'touchstart']) hold.addEventListener(ev, () => this.compare(true));
      for (const ev of ['mouseup', 'mouseleave', 'touchend', 'touchcancel']) {
        hold.addEventListener(ev, () => this.compare(false));
      }
      row.append(hold, el('span', 'menu-hint', 'The window shows the game as printed with the settings below.'));
      const box = el('div', 'menu-window-box');
      box.append(wrap, row);
      return box;
    }
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
