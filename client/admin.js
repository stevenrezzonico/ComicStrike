// The server admin page (client/admin.html): the server's game run with buttons and forms
// instead of rcon lines. Every action is a console line (client/admincmd.js) run as rcon:
// the server's own game and a room's over HTTP (server/admin.js, the rcon password in a
// header), a practice game through the game's own tab (a BroadcastChannel to client/main.js,
// which asks its worker, client/localserver.js). The state is read once a second while the
// page shows.
//
//   /admin                 the server's own game (server/main.js serves this file there)
//   /admin?room=<code>     a room (the tab that hosts it hands the password over)
//   /admin?practice        the practice game running in another tab
//   /admin?new             a new room on one of the server's maps or a .bsp of our own (Play Online's
//                          Create a room)

import { cvarCommand, who, modeCommands, botCommands, PRACTICE_PRESET, resetCommands, GROUPS, groupOf, whenApplies, controlOf }
  from './admincmd.js';
import { MODES } from '../shared/modes.js';
import { parseUntrustedBSP, mapNameOf } from '../shared/bsp.js';

const TEAMS = ['none', 'T', 'CT', 'Spectator']; // shared/player.js: TEAM_T 1, TEAM_CT 2, TEAM_SPECTATOR 3
const TEAM_CLASS = ['', 't', 'ct', 'spec'];
const LEVELS = ['easy', 'normal', 'hard', 'expert'];
const TABS = ['Match', 'Players', 'Bots', 'Map & mode', 'Settings', 'Cheats', 'Console'];
const OWN_MAP_MAX = 24 << 20; // a room's map at most (server/rooms.js ROOM_LIMITS.bytes)

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const practice = params.has('practice');
const creating = params.has('new') && !room;
const KEY = `comicstrike.admin.${room || 'server'}`; // the password, for this tab's life only
let password = practice ? '' : sessionStorage.getItem(KEY) || '';
// The link the server prints at startup carries a password it made up after the # (never sent
// to the server, nor kept in the history: taken off the address at once).
const linked = new URLSearchParams(location.hash.slice(1)).get('password');
if (linked !== null) {
  if (!practice) password = linked;
  history.replaceState(null, '', location.pathname + location.search);
}
let catalog = []; // the server console's rows: [name, help, value, hint, min, max, default]
let state = null; // the newest Host.adminState()
let tab = sessionStorage.getItem('comicstrike.admin.tab') || 'Match';
let view = null; // the open tab: { el, update() }
let pollTimer = 0;

const $ = (id) => document.getElementById(id);

// --- Reaching the server ---------------------------------------------------------------

// The game's tabs answer on this channel (client/main.js): `hello` asks which game each
// plays and the rcon password it holds; `call` runs an op in the practice game.
const channel = new BroadcastChannel('comicstrike-admin');
const me = Math.random().toString(36).slice(2);
let calls = 0;
const waiting = new Map(); // call id -> { resolve, reject, timer }
const tabsHere = [];
channel.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'here') tabsHere.push(m);
  else if (m.type === 'reply' && waiting.has(m.req)) {
    const w = waiting.get(m.req);
    waiting.delete(m.req);
    clearTimeout(w.timer);
    if (m.error) w.reject(Object.assign(new Error(m.error), { status: 0 }));
    else w.resolve(m.result);
  }
};

function viaTab(op, command) {
  return new Promise((resolve, reject) => {
    const req = `${me}:${++calls}`;
    const timer = setTimeout(() => {
      waiting.delete(req);
      reject(Object.assign(new Error('no practice game in another tab of this browser'), { status: 0 }));
    }, 2000);
    waiting.set(req, { resolve, reject, timer });
    channel.postMessage({ type: 'call', req, op, command });
  });
}

// op: 'state', 'catalog' or 'exec' (command: the line). Throws with .status (401/403: log in).
async function call(op, command = '') {
  if (practice) return viaTab(op, command);
  const res = await fetch(`/admin/${op}${room ? `?room=${room}` : ''}`, {
    method: op === 'exec' ? 'POST' : 'GET', cache: 'no-store', body: op === 'exec' ? command : undefined,
    headers: { 'x-rcon-password': encodeURIComponent(password), ...(op === 'exec' ? { 'content-type': 'text/plain' } : {}) },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status });
  return out;
}

// The rcon password a game tab of this browser holds for this server or room, or ''.
async function passwordFromTab() {
  channel.postMessage({ type: 'hello' });
  await new Promise((r) => setTimeout(r, 300));
  const t = tabsHere.find((m) => m.rcon && (room ? m.kind === 'room' && m.room === room : m.kind === 'online'));
  return t ? t.rcon : '';
}

// Runs a console line on the server; its output goes to the log (and `also`, the console tab).
async function run(command, also = null) {
  log(`> ${command}`);
  try {
    const { output } = await call('exec', command);
    if (output) log(output);
    if (also) also(output || '(done)');
  } catch (err) {
    log(err.message, true);
    if (also) also(err.message);
    if (err.status === 401 || err.status === 403) showLogin(err.message);
  }
  poll();
}

function log(text, error = false) {
  const el = $('log');
  el.append(h('span', { class: error ? 'err' : '' }, `${text}\n`));
  while (el.childNodes.length > 200) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

const sure = (question) => confirm(question);

// --- Starting, logging in, polling ---------------------------------------------------

async function start() {
  if (creating) return newRoom();
  if (!practice && !password) password = await passwordFromTab();
  if (!practice && !password) return showLogin('');
  try {
    catalog = await call('catalog');
  } catch (err) {
    if (err.status === 401 || err.status === 403) return showLogin(err.message);
    $('summary').textContent = err.message;
    setTimeout(start, 2000);
    return;
  }
  if (!practice) sessionStorage.setItem(KEY, password);
  $('login').classList.add('hidden');
  $('tabs').classList.remove('hidden');
  $('logout').classList.toggle('hidden', practice);
  renderTabs();
  poll();
}

function showLogin(error) {
  clearTimeout(pollTimer);
  sessionStorage.removeItem(KEY);
  $('tabs').classList.add('hidden');
  $('body').replaceChildren();
  $('logout').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('login-what').textContent = room ? `Room ${room}: its rcon password (the console of the tab that hosts it knows it).`
    : 'This server.';
  $('login-error').textContent = error || '';
  $('summary').textContent = 'not logged in';
  $('password').focus();
}

$('login-go').onclick = () => {
  password = $('password').value;
  $('password').value = '';
  start();
};
$('password').addEventListener('keydown', (e) => { // (an onkeydown returning false cancels every other key)
  if (e.key === 'Enter') $('login-go').click();
});
$('logout').onclick = () => {
  password = '';
  showLogin('');
};

async function poll() {
  clearTimeout(pollTimer);
  try {
    state = await call('state');
    summary();
    if (view) view.update();
  } catch (err) {
    if (err.status === 401 || err.status === 403) return showLogin(err.message);
    $('summary').textContent = err.message;
  }
  pollTimer = setTimeout(poll, document.hidden ? 5000 : 1000);
}
document.addEventListener('visibilitychange', () => !document.hidden && state && poll());

const modeLabel = (name) => (MODES.find((m) => m.name === name) || { label: name }).label;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function summary() {
  const s = state, r = s.round, bots = s.players.filter((p) => p.bot).length;
  $('summary').replaceChildren(
    `${s.hostname} · ${s.map} · ${modeLabel(s.mode)} · ${r.phase}${r.phase === 'warmup' ? '' : ` ${r.round}`}`,
    h('span', { class: 'score' }, h('span', { class: 't' }, `T ${r.scoreT}`), ' : ', h('span', { class: 'ct' }, `${r.scoreCT} CT`)),
    `${clock(r.secondsLeft)}${r.paused ? ' · PAUSED' : ''}${r.cheats ? ' · cheats on' : ''} · ` +
      `${s.players.length - bots} players, ${bots} bots`,
  );
}

// --- Page building ---------------------------------------------------------------------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v; // (an input's list is read-only: its attribute)
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const btn = (label, onclick, cls = '', title = null) => h('button', { class: cls, onclick, title }, label);
const card = (...kids) => h('div', { class: 'card' }, ...kids);
const row = (...kids) => h('div', { class: 'row' }, ...kids);
const rowOf = (name) => catalog.find((r) => r[0] === name);
const isCvar = (r) => r[6] !== null || r[0] === 'sv_password'; // (a protected cvar sends no default; commands none)

function renderTabs() {
  $('tabs').replaceChildren(...TABS.map((t) => btn(t, () => {
    tab = t;
    sessionStorage.setItem('comicstrike.admin.tab', t);
    renderTabs();
  }, t === tab ? 'active' : '')));
  view = BUILD[tab]();
  $('body').replaceChildren(view.el);
  if (state) view.update();
}

// A setting's line (a catalog row): its control, when it applies, its help and default. Its
// field is left alone while it has the focus (the state comes back every second).
function setting(r) {
  const [name, help, , hint, min, max, def] = r, kind = controlOf(r), when = whenApplies(name);
  let input, value = null;
  if (kind === 'switch') {
    input = btn('', () => run(cvarCommand(name, value === '1' ? 0 : 1)), 'small');
  } else if (Array.isArray(hint) && kind === 'text') {
    input = h('select', { onchange: () => run(cvarCommand(name, input.value)) },
      hint.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, `${o[0]}: ${o[1]}`) : h('option', { value: o }, o))));
  } else {
    input = h('input', { type: r[2] === null ? 'password' : kind === 'number' ? 'number' : 'text', autocomplete: 'off',
      onchange: () => run(cvarCommand(name, input.value)), placeholder: r[2] === null ? '(hidden: type a new one)' : null });
    if (kind === 'number') {
      input.step = 'any';
      if (min !== null) input.min = min;
      if (max !== null) input.max = max;
    }
  }
  const el = h('div', { class: 'setting', 'data-name': name },
    h('div', {}, h('code', {}, name), when ? h('span', { class: 'when' }, when) : null),
    h('div', {}, input),
    h('div', { class: 'help' }, help, def !== null ? h('span', { class: 'note' }, ` (default ${def}) `) : null,
      def !== null ? btn('reset', () => run(cvarCommand(name, def)), 'small') : null));
  return {
    el, name,
    update() {
      const v = state.cvars[name];
      if (v === undefined) return; // protected (sv_password): never sent
      value = v;
      if (kind === 'switch') {
        input.textContent = v === '1' ? 'ON' : 'OFF';
        input.classList.toggle('on', v === '1');
      } else if (document.activeElement !== input) input.value = v;
      el.classList.toggle('changed', def !== null && v !== def);
    },
  };
}

// Settings lines for `names` (those the server has), in a card.
function settings(names) {
  const lines = names.map(rowOf).filter((r) => r && isCvar(r)).map(setting);
  return { el: h('div', {}, lines.map((l) => l.el)), update: () => lines.forEach((l) => l.update()) };
}

// Rebuilds `el` from `make()` only when `key()` changed (a table rebuilt every second loses
// a hovered button's click).
function region(key, make) {
  const el = h('div');
  let last = null;
  return {
    el,
    update() {
      const k = key();
      if (k === last) return;
      last = k;
      el.replaceChildren(make());
    },
  };
}

// The room's invite: its link with a Copy button and a way in.
function invite() {
  const link = h('input', { value: `${location.origin}/?room=${room}`, readOnly: true, style: 'flex: 1; min-width: 240px',
    onfocus: () => link.select() });
  const copy = btn('Copy', () => {
    link.select();
    if (navigator.clipboard) navigator.clipboard.writeText(link.value).then(() => (copy.textContent = 'Copied'), () => {});
  });
  return h('div', {}, row(link, copy, h('a', { href: `/?room=${room}#rcon=${encodeURIComponent(password)}`, target: '_blank',
    title: 'Your game tab gets the room\'s console too (bot_add, mp_restartgame, ... no rcon needed)' }, 'Play in this room')),
    h('p', { class: 'note' }, 'Friends who open the link join the room. sv_listed 1 lists it in Play Online; with 0 only the ' +
      'link brings players in. The room closes a couple of minutes after its last player leaves.'));
}

// --- A new room (/admin?new): one of the server's maps or, on the Your map tile beside them, a
// .bsp of our own, a mode, bots, public or link only, a join password; made by POST /rooms
// (server/main.js: openRoom for a server map, createRoom uploading our own), then managed here
// with the room's rcon password, which comes back with it.

async function newRoom() {
  $('summary').textContent = 'New room';
  let maps = [], count = null;
  try {
    [maps, count] = await Promise.all([fetch('/maps.json').then((r) => r.json()), fetch('/rooms.json').then((r) => r.json())]);
  } catch {
    // shown as no maps
  }
  let picked = maps.includes('de_dust2') ? 'de_dust2' : maps[0] || '';
  let own = null; // a .bsp of our own, { name, bytes }: the room's map while `picked` is null
  const error = h('p', { class: 'note', style: 'color: var(--red)' });
  const grid = h('div', { class: 'maps' });
  const pickOwn = async (file) => {
    if (!file) return;
    error.textContent = '';
    try {
      if (file.size > OWN_MAP_MAX) throw new Error(`${file.name} is too large (${OWN_MAP_MAX >> 20} MB at most)`);
      const bytes = await file.arrayBuffer();
      try {
        parseUntrustedBSP(bytes); // the server checks it again
      } catch (err) {
        throw new Error(`${file.name} is not a map this game can play (${err.message})`);
      }
      own = { name: mapNameOf(file.name), bytes };
      picked = null;
      go.disabled = full;
    } catch (err) {
      error.textContent = err.message;
    }
    draw();
  };
  const drop = h('label', {
    class: 'drop', title: 'Any GoldSrc map (CS 1.6, BSP version 30) you have',
    ondragover: (e) => {
      e.preventDefault();
      drop.classList.add('over');
    },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      pickOwn(e.dataTransfer.files[0]);
    },
  }, h('input', { type: 'file', accept: '.bsp', onchange: (e) => pickOwn(e.target.files[0]) }), h('span'));
  const tile = (label, on, pick) => h('button', { class: on ? 'on' : '', title: label, onclick: () => {
    pick();
    draw();
  } }, label);
  const draw = () => {
    drop.lastChild.textContent = own ? 'Another .bsp...' : 'Your map (.bsp)...';
    grid.replaceChildren(drop, ...(own ? [tile(`${own.name} (yours)`, picked === null, () => (picked = null))] : []),
      ...maps.map((m) => tile(m, m === picked, () => (picked = m))));
  };
  draw();
  const mode = h('select', {}, MODES.map((m) => h('option', { value: m.name }, m.label)));
  mode.value = 'competitive';
  const bots = h('select', {}, [['0', 'no bots'], ['2', '1 vs 1'], ['4', '2 vs 2'], ['6', '3 vs 3'], ['10', '5 vs 5']]
    .map(([v, l]) => h('option', { value: v }, l)));
  bots.value = '10';
  const level = h('select', {}, LEVELS.map((l, i) => h('option', { value: String(i) }, l)));
  level.value = '1';
  const armoury = h('input', { type: 'checkbox', checked: true });
  const listed = h('input', { type: 'radio', name: 'visibility', checked: true });
  const hidden = h('input', { type: 'radio', name: 'visibility' });
  const password = h('input', { type: 'password', maxLength: 63, placeholder: 'none', autocomplete: 'new-password' });
  const full = !!count && count.live >= count.max;
  const go = btn('Create the room', async () => {
    go.disabled = true;
    error.textContent = '';
    try {
      let res;
      if (picked === null) { // our own map: the file is the body, the join password a header (URI-encoded)
        const q = new URLSearchParams({ file: `${own.name}.bsp`, mode: mode.value, players: bots.value,
          difficulty: level.value, armoury: armoury.checked ? '1' : '0', listed: listed.checked ? '1' : '0' });
        const headers = { 'content-type': 'application/octet-stream' };
        if (password.value) headers['x-room-password'] = encodeURIComponent(password.value);
        go.textContent = `Sending ${own.name}...`;
        res = await fetch(`/rooms?${q}`, { method: 'POST', body: own.bytes, headers });
      } else {
        res = await fetch('/rooms', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ map: picked, mode: mode.value, players: +bots.value, difficulty: +level.value,
            armoury: armoury.checked, listed: listed.checked, password: password.value }),
        });
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      location.replace(`/admin?room=${out.code}#password=${encodeURIComponent(out.rcon)}`); // logs in (start)
    } catch (err) {
      error.textContent = err.message;
      go.textContent = 'Create the room';
      go.disabled = false;
    }
  }, 'go');
  go.disabled = full || !picked;
  const label = (input, text) => h('label', {}, input, ` ${text}`);
  $('body').replaceChildren(h('div', {},
    h('h2', {}, 'New room'),
    card(
      h('p', { class: 'note' }, `A game of its own on this server${count ? `: ${count.live} of its ${count.max} rooms are taken` : ''}. ` +
        'It closes a couple of minutes after its last player leaves, or 10 minutes after it is made if nobody comes.'),
      row('Mode', mode, 'Bots', bots, 'Difficulty', level, label(armoury, 'the map\'s own weapons')),
      row('Who sees it', label(listed, 'public: listed in Play Online'), label(hidden, 'private: only its link brings players in')),
      row('Join password', password, h('span', { class: 'note' }, '(optional)')),
      row(go), error,
      full ? h('p', { class: 'note' }, 'Every room on this server is taken: try again when one closes.') : null),
    h('h2', {}, 'Map'), card(grid, maps.length ? null : h('p', { class: 'note' }, 'No maps answered: bring your own.'),
      h('p', { class: 'note' }, 'Your map: a .bsp of your own, sent to this server, which keeps it in memory only while ' +
        'people play in the room.'))));
}

const BUILD = {
  Match() {
    const info = region(() => JSON.stringify([state.round, state.map, state.mode, state.players.length]), () => {
      const r = state.round;
      return h('table', {}, [
        ['Map', state.map], ['Mode', modeLabel(state.mode)], ['Phase', r.paused ? `${r.phase} (paused)` : r.phase],
        ['Round', r.phase === 'warmup' ? '-' : r.round], ['Score', `T ${r.scoreT} : ${r.scoreCT} CT`],
        ['Time left', clock(r.secondsLeft)], ['Cheats', r.cheats ? 'on' : 'off'], ['Join password', state.password ? 'yes' : 'none'],
      ].map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v)))));
    });
    const roomOpts = room ? settings(['sv_listed', 'sv_password']) : null;
    const say = h('input', { placeholder: 'a message to everyone', maxLength: 127, style: 'flex: 1; min-width: 200px' });
    const send = () => {
      if (say.value.trim()) run(`say ${say.value}`);
      say.value = '';
    };
    say.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    return {
      el: h('div', {},
        room ? [h('h2', {}, `Room ${room}`), card(invite(), roomOpts.el)] : null,
        h('h2', {}, 'Match'), card(info.el),
        h('h2', {}, 'Rounds'),
        card(
          row(btn('Restart match', () => sure('Restart the match? Scores and money start over.') && run('mp_restartgame 1'), 'go'),
            btn('End warmup', () => run('mp_warmup_end')), btn('Start warmup', () => run('mp_warmup_start'))),
          row(btn('Pause match', () => run('mp_pause_match'), '', 'Holds the freeze time (now, or the next one)'),
            btn('Unpause', () => run('mp_unpause_match')),
            btn('Timeout T', () => run('timeout_terrorist_start')), btn('Timeout CT', () => run('timeout_ct_start'))),
          row(btn('Swap teams', () => sure('Everyone to the other side, and a new match?') && run('mp_swapteams')),
            btn('Scramble teams', () => sure('Shuffle the players over both sides, and a new match?') && run('mp_scrambleteams'))),
        ),
        h('h2', {}, 'Chat'), card(row(say, btn('Say', send))),
      ),
      update() {
        info.update();
        if (roomOpts) roomOpts.update();
      },
    };
  },

  Players() {
    const table = region(() => JSON.stringify([state.players, state.bans]), () => {
      const players = [...state.players].sort((a, b) => a.team - b.team || b.score - a.score || a.id - b.id);
      const action = (p) => [
        ...[[1, 't', 'T'], [2, 'ct', 'CT'], [3, 'spec', 'Spec']].map(([team, arg, label]) =>
          h('button', { class: 'small', disabled: p.team === team, onclick: () => run(`switchteam ${arg} ${who(p.id)}`) }, label)),
        ' ',
        p.alive && p.team !== 3 ? btn('Slay', () => run(`slay ${who(p.id)}`), 'small') : null,
        p.bot ? btn('Kick', () => run(`bot_kick ${who(p.id)}`), 'small')
          : btn('Kick', () => sure(`Kick ${p.name}?`) && run(`kick ${who(p.id)}`), 'small'),
        p.bot ? null : btn('Ban', () => {
          const m = prompt(`Ban ${p.name} for how many minutes? (0: until the server restarts)`, '60');
          if (m !== null && m.trim() !== '') run(`banid ${Number(m) || 0} ${who(p.id)}`);
        }, 'small'),
      ];
      return h('div', {},
        h('table', {},
          h('tr', {}, ['#', 'Name', 'Team', 'K', 'A', 'D', 'Score', 'Money', 'HP', 'Address', ''].map((t, i) =>
            h('th', { class: i >= 3 && i <= 8 ? 'num' : '' }, t))),
          players.map((p) => h('tr', { class: p.alive || p.team === 3 ? '' : 'dead' },
            h('td', {}, String(p.id)),
            h('td', {}, p.name, p.bot ? h('span', { class: 'note' }, ` ${LEVELS[p.difficulty] || ''}`) : null),
            h('td', { class: TEAM_CLASS[p.team] }, TEAMS[p.team]),
            ...[p.kills, p.assists, p.deaths, p.score, `$${p.money}`, p.alive ? p.health : 'dead'].map((v) =>
              h('td', { class: 'num' }, String(v))),
            h('td', { class: 'note' }, p.bot ? 'bot' : p.address || '-'),
            h('td', {}, action(p))))),
        players.length ? null : h('p', { class: 'note' }, 'Nobody is on the server.'),
        h('h2', {}, 'Bans'),
        state.bans.length ? h('table', {}, state.bans.map((b) => h('tr', {},
          h('td', {}, b.address), h('td', {}, b.minutes === null ? 'until the server restarts' : `${b.minutes} min left`),
          h('td', {}, btn('Unban', () => run(`removeip ${b.address}`), 'small')))))
          : h('p', { class: 'note' }, 'No bans. Bans last until their time is up or the server restarts.'));
    });
    return { el: h('div', {}, h('h2', {}, 'Players'), card(table.el)), update: () => table.update() };
  },

  Bots() {
    const team = h('select', {}, h('option', { value: '' }, 'smaller team'), h('option', { value: 't' }, 'Terrorists'),
      h('option', { value: 'ct' }, 'Counter-Terrorists'));
    const level = h('select', {}, LEVELS.map((l) => h('option', { value: l }, l)));
    level.value = LEVELS[Number(rowOf('bot_difficulty')?.[2]) || 1];
    const count = h('input', { type: 'number', value: 1, min: 1, max: 20 });
    const name = h('input', { placeholder: 'name (optional)', maxLength: 31 });
    const opts = settings(catalog.map((r) => r[0]).filter((n) => /^bot_/.test(n)));
    const list = region(() => JSON.stringify(state.players.filter((p) => p.bot).map((p) => [p.id, p.name, p.team, p.alive])), () => {
      const bots = state.players.filter((p) => p.bot);
      if (!bots.length) return h('p', { class: 'note' }, 'No bots.');
      return h('table', {}, bots.map((p) => h('tr', {},
        h('td', {}, p.name), h('td', { class: TEAM_CLASS[p.team] }, TEAMS[p.team]), h('td', { class: 'note' }, LEVELS[p.difficulty]),
        h('td', {}, btn('Kick', () => run(`bot_kick ${who(p.id)}`), 'small'),
          p.alive ? btn('Kill', () => run(`bot_kill ${who(p.id)}`), 'small') : null))));
    });
    return {
      el: h('div', {},
        h('h2', {}, 'Add bots'),
        card(row('Team', team, 'Difficulty', level, 'How many', count, name,
          btn('Add', () => run(botCommands(team.value, level.value, +count.value, name.value.trim())), 'go'))),
        h('h2', {}, 'Remove bots'),
        card(row(btn('Kick all', () => run('bot_kick all')), btn('Kick T', () => run('bot_kick t')),
          btn('Kick CT', () => run('bot_kick ct')), btn('Kill all', () => run('bot_kill all'))), list.el),
        h('h2', {}, 'Bot settings'), card(opts.el)),
      update() {
        list.update();
        opts.update();
      },
    };
  },

  'Map & mode'() {
    const mode = h('select', {}, MODES.map((m) => h('option', { value: m.name }, m.label)));
    mode.value = state ? state.mode : 'competitive';
    let picked = state ? state.map : '';
    const grid = h('div', { class: 'maps' });
    const go = btn('Change map', () => {
      if (!picked) return;
      if (sure(`Change to ${picked} (${modeLabel(mode.value)})? Every player reconnects.`)) run(modeCommands(mode.value, picked));
    }, 'go');
    const draw = () => {
      grid.replaceChildren(...(state ? state.maps : []).map((m) =>
        h('button', { class: [m === picked ? 'on' : '', m === state.map ? 'current' : ''].join(' '), onclick: () => {
          picked = m;
          draw();
        } }, m)));
      go.textContent = picked ? `Change to ${picked}` : 'Change map';
    };
    let mapsKey = '';
    return {
      el: h('div', {},
        h('h2', {}, 'Mode'), card(row(mode, go),
          h('p', { class: 'note' }, 'The mode takes effect with the map change. Its cfg (cfg/gamemode_<mode>.cfg) resets the ' +
            'round settings at every map change; put lasting changes in cfg/gamemode_<mode>_server.cfg.')),
        h('h2', {}, 'Map'), card(grid)),
      update() {
        const k = `${state.maps.join()}|${state.map}`;
        if (k === mapsKey) return;
        if (!picked) picked = state.map;
        if (!mapsKey) mode.value = state.mode;
        mapsKey = k;
        draw();
      },
    };
  },

  Settings() {
    const search = h('input', { placeholder: 'search', style: 'width: 240px' });
    const groups = GROUPS.filter(([label]) => label).map(([label]) => {
      const s = settings(catalog.filter((r) => groupOf(r[0]) === label).map((r) => r[0]));
      return { label, s, el: h('div', {}, h('h2', {}, label), card(s.el)) };
    }).filter((g) => g.s.el.childNodes.length);
    search.oninput = () => {
      const q = search.value.toLowerCase();
      for (const g of groups) {
        let shown = 0;
        for (const line of g.s.el.childNodes) {
          const on = !q || line.textContent.toLowerCase().includes(q);
          line.classList.toggle('hidden', !on);
          shown += on;
        }
        g.el.classList.toggle('hidden', !shown);
      }
    };
    return {
      el: h('div', {}, row(search, h('span', { class: 'note' }, 'Red names differ from their default.')), groups.map((g) => g.el)),
      update: () => groups.forEach((g) => g.s.update()),
    };
  },

  Cheats() {
    const opts = settings(['sv_cheats', 'mp_buy_anywhere', 'mp_free_armor', 'mp_respawn_on_death_t', 'mp_respawn_on_death_ct',
      'mp_ignore_round_win_conditions', 'mp_solid_teammates', 'bot_stop', 'bot_dont_shoot']);
    return {
      el: h('div', {},
        h('h2', {}, 'Practice'),
        card(row(btn('Practice settings', () => sure('Cheats on, long rounds, money, buying anywhere, and a new match?') &&
          run(PRACTICE_PRESET), 'go'),
          btn('Back to the mode\'s settings', () => sure('The mode\'s own settings, cheats off, and a new match?') &&
            run(resetCommands(state.mode)))),
        h('p', { class: 'note' }, 'With sv_cheats 1 every player can use noclip (N), setpos and bot_place (H) from their own ' +
          'console. The Demo mode (Map & mode) adds infinite ammo and grenades, and nobody dies.')),
        h('h2', {}, 'Switches'), card(opts.el)),
      update: () => opts.update(),
    };
  },

  Console() {
    const out = h('pre', { id: 'console-out' });
    const list = h('datalist', { id: 'admin-names' }, catalog.map((r) => h('option', { value: r[0] }, r[1])));
    const input = h('input', { list: 'admin-names', placeholder: 'a console command, as rcon (status, bot_add t hard, ...)',
      style: 'flex: 1; min-width: 260px', autocomplete: 'off' });
    const history = [];
    let back = 0;
    const print = (s) => {
      out.append(`${s}\n`);
      out.scrollTop = out.scrollHeight;
    };
    const send = () => {
      const line = input.value.trim();
      if (!line) return;
      history.push(line);
      back = history.length;
      input.value = '';
      print(`> ${line}`);
      run(line, print);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') send();
      else if (e.key === 'ArrowUp' && back > 0) input.value = history[--back];
      else if (e.key === 'ArrowDown' && back < history.length) input.value = history[++back] || '';
    };
    return { el: h('div', {}, h('h2', {}, 'Console'), card(out, row(input, btn('Run', send)), list)), update() {} };
  },
};

start();
