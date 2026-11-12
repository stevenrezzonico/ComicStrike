// The admin page's commands (client/admin.html): every button and field becomes a console
// line the server runs as rcon would, so the page adds no rules of its own. Pure, for the
// tests (test/admin.test.js).

import { quote } from '../shared/cvars.js';
import { MODES } from '../shared/modes.js';

// `name value`, the value quoted (a quote in it becomes ', control characters spaces).
export const cvarCommand = (name, value) => `${name} ${quote(value)}`;

// A player by id (status lists them): a name can be shared or hold `;` and quotes.
export const who = (id) => `#${id}`;

// An id is a slot, taken by the next player at once: before an action by id (after its
// dialog), the newest state must still hold the player `p` (a row of the table) there.
export const samePlayer = (players, p) => players.some((q) => q.id === p.id && q.name === p.name && q.bot === p.bot);

// What the players' table's rows and buttons are made of (their numbers change every second
// and are written in place: a table rebuilt every second loses clicks and the focus).
export const playerRowsKey = (state) => JSON.stringify([
  state.players.map((p) => [p.id, p.name, p.team, p.alive, p.bot, p.difficulty, p.address]), state.bans]);

// The ban prompt's minutes: a number of at least 0, else null ("30m" is no 0, which bans
// until the server restarts).
export function banMinutes(text) {
  const m = String(text).trim() === '' ? NaN : Number(text);
  return Number.isFinite(m) && m >= 0 ? m : null;
}

// Seconds as m:ss; '-' for a phase with no end (null from a room's JSON, Infinity from practice).
export const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '-');

// The map change into mode `name` (a MODES row's name): the mode's cvars, then the map,
// whose load runs the mode's cfgs (server/host.js loadMode).
export function modeCommands(name, map) {
  const row = MODES.find((m) => m.name === name) || MODES[1];
  const [type, mode, flags = 0] = row.key.split('/');
  return `game_type ${type}; game_mode ${mode}; sv_game_mode_flags ${flags}; changelevel ${quote(map)}`;
}

// `count` bots for `team` ('t', 'ct' or '' for the smaller side) at `difficulty`
// (easy...expert), each line naming `name` when given (the server numbers no names: one bot).
export function botCommands(team, difficulty, count, name = '') {
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  const line = `bot_add${team ? ` ${team}` : ''} ${difficulty}${name ? ` ${quote(name)}` : ''}`;
  return Array(name ? 1 : n).fill(line).join('; ');
}

// Long rounds, money and buying anywhere, cheats on, a new match: after CS:GO players'
// practice configs. Undone by the mode's own cfg (resetCommands).
export const PRACTICE_PRESET = 'sv_cheats 1; mp_warmuptime 0; mp_freezetime 0; mp_roundtime 60; mp_roundtime_defuse 60; ' +
  'mp_roundtime_hostage 60; mp_buytime 3600; mp_buy_anywhere 1; mp_startmoney 16000; mp_maxmoney 65535; ' +
  'mp_restartgame 1';

// Back to the mode's settings (its cfgs reset what they set) with cheats off, and a new match.
export const resetCommands = (mode) => `sv_cheats 0; exec gamemode_${mode}; exec gamemode_${mode}_server; mp_restartgame 1`;

// The settings' groups, in the page's order: the first whose test a name passes. Names the
// other tabs show (bots, the mode) are left out of the settings.
export const GROUPS = [
  ['Server', /^(hostname|sv_password|sv_listed|sv_cheats|sv_talk_)/],
  ['Rounds', /^mp_(freezetime|roundtime|buytime|round_restart|maxrounds|c4timer|warmuptime|halftime|overtime|match_restart|timelimit|ignore_round|team_timeout)/],
  ['Economy', /^mp_(startmoney|maxmoney|buy_|free_armor|death_drop|give_player_c4|armoury)/],
  ['Teams', /^(mp_(limitteams|autoteambalance|teamsize_max|solid_teammates|teammates_are_enemies|friendlyfire)|ff_)/],
  ['Spawns', /^mp_(respawn|randomspawn|hostages)/],
  ['Votes', /^sv_(allow_votes|vote_)/],
  [null, /^(bot_|game_type|game_mode|sv_game_mode_flags|rcon_password)/],
  ['Other', /./],
];
export function groupOf(name) {
  for (const [label, test] of GROUPS) if (test.test(name)) return label;
  return 'Other';
}

// When a setting takes effect: the mode's at the next map, the round rules at the next round.
export function whenApplies(name) {
  if (/^(game_type|game_mode|sv_game_mode_flags)$/.test(name)) return 'next map';
  if (/^(mp_|ff_)/.test(name) && !/^mp_(teammates_are_enemies|solid_teammates)$/.test(name)) return 'next round';
  return '';
}

// The control a catalog row ([name, help, value, hint, min, max, default]) gets: a switch for
// 0..1 on-off settings, a number field when it has limits, else text. (The shares of friendly
// fire are 0..1 too, but fractions.)
export function controlOf(row) {
  const [name, , value, , min, max] = row;
  if (min === 0 && max === 1 && !/^ff_/.test(name) && (value === '0' || value === '1' || value === null)) return 'switch';
  if (min !== null || max !== null) return 'number';
  return 'text';
}
