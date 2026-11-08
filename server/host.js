// The server host: owns the running Game and the server console (CS:GO-style cvars and
// commands, run from rcon, the admin page and cfgs), and switches maps.
// Transport-agnostic: sessions only need send(bytes) and close(reason).

import { Console, FCVAR_PROTECTED } from '../shared/cvars.js';
import { writeChangelevel, cleanName, MAX_PLAYERS } from '../shared/protocol.js';
import { TEAM_NAMES, TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import { PHASE_WARMUP } from '../shared/economy.js';
import { Game, DEFAULT_RULES, CHAT_FLOOD_TICKS } from './game.js';
import { Votes } from './votes.js';
import { MODES } from '../shared/modes.js';
import { TICK_RATE } from '../shared/constants.js';

const PHASE_NAMES = ['warmup', 'freeze time', 'live', 'round over'];
const RCON_MAX_FAILS = 5; // bad passwords from one address before it is ignored for a while
const RCON_BLOCK_MS = 60000;
// Bad passwords from everyone in a minute, then rcon refuses everyone for the rest of it (the
// terminal still works): an IPv6 /48, free from tunnel brokers, is 65,536 addresses of 5
// guesses a minute each, ~327k guesses a minute against the per-address count alone.
const RCON_FAILS_PER_MINUTE = 60;
// Commands one rcon line may run, aliases and cfgs included: `alias x "x;x"; x` ran 2^33
// and froze the server. A room's uploader holds its rcon password.
const RCON_BUDGET = 256;
const RCON_MAP_GAP_MS = 1000; // rcon map changes: each builds a new game (40 in a line were 70 ms)
// Characters of output one rcon line sends back: a line of `find;find;...` printed ~1 MB,
// ~1,400 PRINT datagrams encoded on the thread every game shares.
const RCON_OUTPUT = 65536;
// sv_password's most: what a HELLO carries (Writer.str, shared/protocol.js). Longer, it never
// matched, and every try counted as a bad guess.
export const PASSWORD_BYTES = 63;

// CS:GO game modes by game_type / game_mode (shared/modes.js). A mode is a cfg of mode
// convars run when a map loads (cfg/gamemode_<name>.cfg, then cfg/gamemode_<name>_server.cfg
// for the server's own overrides, as in CS:GO), plus its rule flag in the game rules.
export const GAME_MODES = Object.fromEntries(MODES.map((m) => [m.key, m.name]));

// The part of an address rcon guesses are counted by: an IPv4 address, or an IPv6 address's
// /64 (one machine gets a whole /64 and can use any address in it).
// The machine itself: never limited or banned (development plays a browser tab per player).
export function isLoopback(address) {
  return /^127\./.test(addressKey(address)) || address === '::1';
}

export function addressKey(address) {
  if (!address || !address.includes(':')) return address || '';
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); // IPv4 mapped
  if (v4) return v4[1];
  const [head, tail] = address.replace(/%.*$/, '').split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

// Sets `key` in a Map that keeps the newest `max` keys: the key goes last, the oldest out
// (a flood of new keys pushes out old ones; clearing them all lifted every block).
export function remember(map, key, value, max) {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

// Live game sessions per address (addressKey): one machine opening 20 sessions took every
// player slot. `add(address)` is false when the address has `max` already; loopback is
// free (development opens a browser tab per player).
export class AddressCounts {
  constructor(max) {
    this.max = max;
    this.counts = new Map();
  }

  key(address) {
    return isLoopback(address) ? null : addressKey(address);
  }

  add(address) {
    const key = this.key(address);
    if (key === null) return true;
    const n = this.counts.get(key) || 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  remove(address) {
    const key = this.key(address);
    if (key === null || !this.counts.has(key)) return;
    const n = this.counts.get(key) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
  }
}

// A game's fixed-rate loop on the monotonic clock (the server's games, the practice worker's):
// each wakeup runs every tick due at `now` since `entry.epoch` (the ms tick 0 was due), so
// timer jitter never accumulates into drift; after a long stall the game skips ahead. entry:
// { host, epoch }. Returns when the next tick is due.
export const TICK_MS = 1000 / TICK_RATE;
export function runDue(entry, now) {
  const game = entry.host.game;
  const due = Math.floor((now - entry.epoch) / TICK_MS);
  let ran = 0;
  while (game.tick < due && ran < 8) {
    entry.host.step(game);
    ran++;
  }
  if (game.tick < due) entry.epoch = performance.now() - game.tick * TICK_MS; // fell behind: resync
  return entry.epoch + (game.tick + 1) * TICK_MS;
}

// Bad password guesses (rcon_password, sv_password: one of these each) by the sender's
// address (sessions without one share a key): counted here, not per player, so reconnecting
// does not reset them, and kept across map changes. RCON_MAX_FAILS from one address block it
// for RCON_BLOCK_MS; RCON_FAILS_PER_MINUTE from everyone refuse everyone for the rest of the
// minute, except the addresses that gave the right password before (else anyone with a dozen
// addresses kept a password server closed to its own players, every map change throwing them
// out).
const ADDRESSES_KEEP = 4096; // addresses remembered: guesses, right passwords, bans
class Guesses {
  constructor(now) {
    this.now = now;
    this.byKey = new Map(); // address key -> { fails, blockedUntil }
    this.since = -Infinity; // the minute the server-wide count is for
    this.fails = 0;
    this.good = new Map(); // address keys that gave the right password -> true
  }

  // Why a guess from `key` is not even tried now: 'address' or 'server'; '' to try it.
  refused(key) {
    const now = this.now(), g = this.byKey.get(key);
    if (g && now < g.blockedUntil) return 'address';
    if (this.good.has(key)) return '';
    if (now - this.since >= 60000) {
      this.since = now;
      this.fails = 0;
    }
    return this.fails >= RCON_FAILS_PER_MINUTE ? 'server' : '';
  }

  fail(key) {
    this.fails++;
    let g = this.byKey.get(key);
    if (!g) remember(this.byKey, key, g = { fails: 0, blockedUntil: 0 }, ADDRESSES_KEEP);
    if (++g.fails >= RCON_MAX_FAILS) {
      g.fails = 0;
      g.blockedUntil = this.now() + RCON_BLOCK_MS;
    }
  }

  ok(key) {
    this.byKey.delete(key);
    remember(this.good, key, true, ADDRESSES_KEEP);
  }
}

export class Host {
  // opts: loadMap(name) -> parsed BSP (throws if missing), listMaps() -> names,
  //       readCfg(name) -> text or null, print(text), rules (test overrides),
  //       now() -> ms (default performance.now),
  //       mapGapMs (ms between two rcon map changes; rooms: their upload cooldown, as each
  //       rebuilds the game and its bots' navigation)
  constructor(opts) {
    this.opts = opts;
    this.now = opts.now || (() => performance.now());
    this.game = null;
    this.rconGuesses = new Guesses(this.now);
    this.joinGuesses = new Guesses(this.now); // sv_password
    this.bans = new Map(); // address key -> ms: voted out (sv_vote_kick_ban_duration) or banned (banid) until then
    this.votes = new Votes(this);
    this.failedTicks = 0; // ticks that threw since the last report
    this.failReportAt = -Infinity;
    this.mapChangedAt = -Infinity; // the last map change by rcon
    this.execCtx = null; // the rcon line running, so a cvar's refusal reaches its caller
    // Who said (the rcon player; the terminal and cfgs as one: the console) -> ms of the line.
    this.saidAt = new WeakMap();
    const con = this.con = new Console(opts.print || ((s) => console.log(s)));
    const apply = () => this.applyRules();
    const num = (name, value, help, min, max) => con.cvar(name, value, { help, min, max, onChange: apply });

    this.hostname = con.cvar('hostname', 'ComicStrike', { help: 'Server name' });
    this.password = con.cvar('rcon_password', '', { flags: FCVAR_PROTECTED, help: 'Remote console password (empty: rcon off)' });
    this.joinPassword = con.cvar('sv_password', '', {
      flags: FCVAR_PROTECTED, help: `Password to join the server (empty: none; at most ${PASSWORD_BYTES} bytes)`,
      onChange: (cv, old) => {
        if (new TextEncoder().encode(cv.value).length <= PASSWORD_BYTES) return;
        cv.set(old);
        con.out(this.execCtx, `sv_password: at most ${PASSWORD_BYTES} bytes (a HELLO carries no more): unchanged`);
      },
    });
    num('mp_freezetime', DEFAULT_RULES.freezeTime, 'Freeze time at round start (s)', 0, 60);
    num('mp_roundtime', 1.92, 'Round time (min)', 1, 60);
    num('mp_roundtime_defuse', 1.92, 'Round time on bomb maps (min; 0: mp_roundtime)', 0, 60);
    num('mp_roundtime_hostage', 1.92, 'Round time on hostage maps (min; 0: mp_roundtime)', 0, 60);
    num('mp_buytime', DEFAULT_RULES.buyTime, 'Buy time after the freeze (s)', 0, 3600);
    num('mp_round_restart_delay', DEFAULT_RULES.roundEndDelay, 'Delay between rounds (s)', 0, 14);
    num('mp_maxrounds', DEFAULT_RULES.maxRounds, 'Rounds per match (halftime after half)', 1, 100);
    num('mp_c4timer', DEFAULT_RULES.c4Timer, 'Bomb timer (s)', 10, 90);
    num('mp_startmoney', DEFAULT_RULES.startMoney, 'Money at the start of a half', 0, 65535);
    num('mp_maxmoney', DEFAULT_RULES.maxMoney, 'Money cap', 0, 65535);
    num('mp_warmuptime', DEFAULT_RULES.warmupTime, 'Warmup length once both teams have players (s)', 0, 3600);
    num('sv_cheats', 0, 'Allow cheat commands (setpos)', 0, 1);
    num('sv_talk_enemy_dead', 1, 'The living see dead enemies\' all chat', 0, 1);
    num('sv_talk_enemy_living', 1, 'The living see living enemies\' all chat', 0, 1);
    // Votes (server/votes.js), CS:GO's cvars.
    num('sv_allow_votes', 1, 'Players may call votes (callvote kick, changelevel, restartgame)', 0, 1);
    num('sv_vote_timer_duration', 15, 'Seconds a vote runs', 5, 120);
    num('sv_vote_quorum_ratio', 0.6, 'Share of the players who may vote whose yes passes a vote', 0.5, 1);
    num('sv_vote_creation_timer', 150, 'Seconds before a player may call another vote', 0, 3600);
    num('sv_vote_failure_timer', 300, 'Seconds before a failed vote may be called again', 0, 3600);
    num('sv_vote_issue_kick_allowed', 1, 'callvote kick is allowed', 0, 1);
    num('sv_vote_issue_changelevel_allowed', 1, 'callvote changelevel is allowed', 0, 1);
    num('sv_vote_issue_restart_game_allowed', 1, 'callvote restartgame is allowed', 0, 1);
    num('sv_vote_issue_scramble_teams_allowed', 1, 'callvote scrambleteams is allowed', 0, 1);
    num('sv_vote_issue_swap_teams_allowed', 1, 'callvote swapteams is allowed', 0, 1);
    num('sv_vote_issue_pause_match_allowed', 1, 'callvote pausematch and unpausematch are allowed', 0, 1);
    num('sv_vote_issue_timeout_allowed', 1, 'callvote starttimeout is allowed', 0, 1);
    num('sv_vote_issue_surrender_allowed', 1, 'callvote surrender is allowed', 0, 1);
    num('sv_vote_kick_ban_duration', 15, 'Minutes a player voted out cannot come back (0: none)', 0, 1440);
    // Game modes (cfg/gamemode_*.cfg set these).
    con.cvar('game_type', 0, { help: 'Game type (0 classic, 1 gun game family); applies on the next map', min: 0, max: 3 });
    con.cvar('game_mode', 1, {
      help: 'Game mode (game_type/game_mode: 0/0 casual, 0/1 competitive, 0/2 wingman, 0/3 retakes, 1/0 arms race, ' +
        '1/1 demolition, 1/2 deathmatch, 2/0 demo); applies on the next map',
      min: 0, max: 3,
    });
    num('sv_game_mode_flags', 0, 'Game mode flags (32: a short match, with game_mode 1); applies on the next map', 0, 255);
    num('mp_teammates_are_enemies', 0, 'Everyone is an enemy (free for all)', 0, 1);
    num('mp_solid_teammates', 1, 'Teammates block each other (enemies always do)', 0, 1);
    num('mp_respawn_on_death_t', 0, 'Terrorists respawn after dying', 0, 1);
    num('mp_respawn_on_death_ct', 0, 'Counter-Terrorists respawn after dying', 0, 1);
    num('mp_randomspawn', 0, 'Spawn at any spawn point, away from enemies', 0, 1);
    num('mp_ignore_round_win_conditions', 0, 'Rounds never end by elimination or objectives', 0, 1);
    num('mp_timelimit', 0, 'Match length when rounds never end (min; 0: none)', 0, 600);
    num('mp_buy_anywhere', 0, 'Buy outside the buy zones', 0, 1);
    num('mp_free_armor', 0, 'Spawn with kevlar and a helmet', 0, 1);
    num('mp_buy_allow_grenades', 1, 'Grenades in the buy menu (CS:GO\'s; deathmatch 0)', 0, 1);
    num('mp_give_player_c4', 1, 'A terrorist gets the bomb each round', 0, 1);
    num('mp_hostages_max', 2, 'Hostages per round on hostage maps', 0, 4);
    num('mp_respawn_immunitytime', 0, 'Seconds a respawned player cannot be hurt (until he shoots)', 0, 60);
    num('mp_match_restart_delay', 15, 'Seconds between the end of a match and the next', 1, 300);
    num('mp_death_drop_gun', 1, 'The dead drop their best gun', 0, 1);
    num('mp_death_drop_grenade', 2, 'The dead drop a grenade: 0 none, 1 their best, 2 the one in hand, else their best', 0, 2);
    num('mp_death_drop_defuser', 1, 'Dead CTs drop their defuse kit', 0, 1);
    // Friendly fire (CS:GO's; the competitive and wingman cfgs turn it on, with their shares).
    num('mp_friendlyfire', 0, 'Teammates hurt each other (by the ff_damage_reduction_* shares)', 0, 1);
    num('ff_damage_reduction_bullets', 0.1, "Share of a bullet's damage a teammate takes", 0, 1);
    num('ff_damage_reduction_grenade', 0.25, "Share of a grenade's damage a teammate takes", 0, 1);
    num('ff_damage_reduction_grenade_self', 1, "Share of his own grenade's damage the thrower takes", 0, 1);
    num('ff_damage_reduction_other', 0.25, 'Share of other damage a teammate set off (a blast) a teammate takes', 0, 1);
    num('mp_limitteams', 2, 'Most players one team may have over the other when joining (0: no limit)', 0, 30);
    num('mp_autoteambalance', 1, 'Teams two or more players apart are evened out at the round start', 0, 1);
    num('mp_team_timeout_max', DEFAULT_RULES.timeoutMax, 'Tactical timeouts a team may call in a match', 0, 10);
    num('mp_team_timeout_time', DEFAULT_RULES.timeoutTime, 'Seconds a tactical timeout adds to the freeze time', 1, 300);
    num('mp_armoury_entities', 1, "The map's own weapons lie out at every round start (armoury_entity, the fy_ maps)", 0, 1);
    num('mp_halftime', 1, 'Teams swap sides after half the rounds', 0, 1);
    num('mp_overtime_enable', 1, 'A tied match goes to overtime', 0, 1);
    num('mp_overtime_maxrounds', DEFAULT_RULES.overtimeRounds, 'Rounds per overtime period (swap after half, first past half wins)', 2, 30);
    num('mp_overtime_startmoney', DEFAULT_RULES.overtimeMoney, 'Money at the start of each overtime half', 0, 65535);
    // Ours (CS:GO's Wingman servers simply have 4 slots): players a team may have, 0 no limit.
    num('mp_teamsize_max', 0, 'Most players on one team (0: no limit)', 0, MAX_PLAYERS);
    this.modeName = 'competitive'; // of the running map
    // Bots (server/bots.js).
    num('bot_quota', 0, 'Bots on the server (bot_add / bot_kick change it)', 0, MAX_PLAYERS);
    con.cvar('bot_quota_mode', 'normal', { help: 'normal: bot_quota bots; fill: bots fill up to bot_quota players',
      onChange: apply });
    num('bot_join_after_player', 0, 'Bots join only once a human plays, and leave with the last one', 0, 1);
    num('bot_difficulty', 1, 'New bots: 0 easy, 1 normal, 2 hard, 3 expert', 0, 3);
    con.cvar('bot_join_team', 'any', { help: 'Team new bots join: any, t, ct', onChange: apply });
    num('bot_stop', 0, 'Bots stand still', 0, 1);
    num('bot_dont_shoot', 0, 'Bots do not shoot', 0, 1);
    const DIFFICULTY = { easy: 0, normal: 1, hard: 2, expert: 3 };
    const botAdd = (team, args, ctx) => { // [easy|normal|hard|expert] [name]
      let difficulty = -1, name = '';
      for (const a of args) {
        if (a.toLowerCase() in DIFFICULTY) difficulty = DIFFICULTY[a.toLowerCase()];
        else name = cleanName(a);
      }
      const c = this.game.bots.add(team, difficulty, name);
      if (!c) return con.out(ctx, 'bot_add: the server is full');
      this.syncBotQuota();
      con.out(ctx, `added ${c.name} (${c.team === TEAM_CT ? 'CT' : 'T'})`);
    };
    con.command('bot_add', (a, ctx) => {
      const t = (a[1] || '').toLowerCase(), team = t === 't' ? TEAM_T : t === 'ct' ? TEAM_CT : 0;
      botAdd(team, a.slice(team ? 2 : 1), ctx);
    }, 'bot_add [t|ct] [easy|normal|hard|expert] [name]: adds a bot');
    con.command('bot_add_t', (a, ctx) => botAdd(TEAM_T, a.slice(1), ctx), 'bot_add_t [difficulty] [name]');
    con.command('bot_add_ct', (a, ctx) => botAdd(TEAM_CT, a.slice(1), ctx), 'bot_add_ct [difficulty] [name]');
    con.command('bot_kick', (a, ctx) => {
      const q = a.slice(1).join(' '), bots = this.game.bots;
      const which = q === 'all' || !q ? bots.list.map((b) => b.c)
        : q.toLowerCase() === 't' || q.toLowerCase() === 'ct'
        ? bots.list.filter((b) => b.c.team === (q.toLowerCase() === 't' ? TEAM_T : TEAM_CT)).map((b) => b.c)
        : bots.list.filter((b) => b.c.name === q || b.c.name === `BOT ${q}` || q === `#${b.c.id}`).map((b) => b.c);
      for (const c of which) bots.kick(c);
      this.syncBotQuota();
      con.out(ctx, which.length ? `kicked ${which.length} bot(s)` : 'bot_kick [name|t|ct|all]: no such bot');
    }, 'bot_kick [name|#id|t|ct|all]: removes bots');
    con.command('bot_kill', (a, ctx) => {
      const q = a.slice(1).join(' ');
      for (const b of this.game.bots.list) {
        if ((!q || q === 'all' || b.c.name === q || b.c.name === `BOT ${q}` || q === `#${b.c.id}`) && b.c.alive) this.game.kill(b.c, b.c, 0, false);
      }
      con.out(ctx, 'bots killed');
    }, 'bot_kill [name|#id|all]: kills bots');

    con.command('bot_place', (a, ctx) => {
      const r = this.rules();
      if (!r.cheats) return con.out(ctx, 'bot_place: needs sv_cheats 1 (or the demo mode)');
      con.out(ctx, this.game.placeBots(ctx && ctx.client, (a[1] || '').toLowerCase() === 'all'));
    }, 'bot_place [all]: puts the next bot (all: every bot, in a row) where you look, facing you (bot_stop 1 keeps them there)');
    con.command('map', (a, ctx) => this.changeLevel(a[1], ctx), 'map <name>: switches to another map');
    con.command('changelevel', (a, ctx) => this.changeLevel(a[1], ctx), 'changelevel <name>: same as map');
    con.command('maps', (_a, ctx) => con.out(ctx, opts.listMaps().join('\n')), 'Lists the maps on the server');
    con.command('status', (_a, ctx) => con.out(ctx, this.status()), 'Server and player status');
    con.command('mp_restartgame', (a) => this.game.restartGame(+a[1] || 1), 'mp_restartgame <seconds>: new match');
    con.command('mp_warmup_end', (_a, ctx) => {
      const err = this.game.endWarmup();
      if (err) con.out(ctx, err);
    }, 'Ends the warmup now');
    con.command('mp_warmup_start', () => this.game.startWarmup(!this.rules().warmupTime),
      'Starts a warmup (until mp_warmup_end, or mp_warmuptime seconds)');
    con.command('mp_pause_match', () => this.game.pauseMatch(true), 'Holds the freeze time (now, or the next one) until mp_unpause_match');
    con.command('mp_unpause_match', () => this.game.pauseMatch(false), 'Lets the freeze time run on');
    con.command('mp_swapteams', () => this.game.scheduleTeams('swap'), 'Everyone to the other side, and a new match');
    con.command('mp_scrambleteams', () => this.game.scheduleTeams('scramble'), 'The players shuffled over both sides, and a new match');
    for (const [cmd, team] of [['timeout_terrorist_start', TEAM_T], ['timeout_ct_start', TEAM_CT]]) {
      con.command(cmd, (_a, ctx) => {
        if (!this.game.callTimeout(team)) con.out(ctx, `${cmd}: a timeout is on already, or none is left (mp_team_timeout_max)`);
      }, `A tactical timeout for the ${team === TEAM_T ? 'Terrorists' : 'Counter-Terrorists'} (mp_team_timeout_time)`);
    }
    con.command('kick', (a, ctx) => {
      const c = this.findClient(a.slice(1).join(' '));
      if (!c) return con.out(ctx, 'kick <name or #id>: no such player, or several have that name (status lists the ids)');
      this.game.kick(c, 'kicked by the server');
    }, 'kick <name or #id>');
    // The admin page's player management (client/admin.html), also for the console and rcon.
    const JOIN = { t: 2, ct: 3, spec: 1 };
    con.command('switchteam', (a, ctx) => {
      const c = this.findClient(a.slice(2).join(' ')), n = JOIN[(a[1] || '').toLowerCase()];
      if (!c || !n) return con.out(ctx, 'switchteam <t|ct|spec> <name or #id>: no such player or team');
      this.game.joinTeam(c, n, true);
      con.out(ctx, `${c.name} is on the ${c.team === TEAM_SPECTATOR ? 'spectators' : `${TEAM_NAMES[c.team]}s`}`);
    }, 'switchteam <t|ct|spec> <name or #id>: moves a player to a team, past the team limits');
    con.command('slay', (a, ctx) => {
      const c = this.findClient(a.slice(1).join(' '));
      if (!c) return con.out(ctx, 'slay <name or #id>: no such player');
      if (!c.alive) return con.out(ctx, `slay: ${c.name} is not alive`);
      this.game.kill(c, c, 0, false); // as the player's own kill command
      con.out(ctx, `slayed ${c.name}`);
    }, 'slay <name or #id>: kills a player (counted as his own death)');
    con.command('banid', (a, ctx) => {
      const minutes = Number(a[1]), c = this.findClient(a.slice(2).join(' '));
      if (!(minutes >= 0) || !c) return con.out(ctx, 'banid <minutes (0: until the server restarts)> <name or #id>');
      if (c.bot) return con.out(ctx, 'banid: a bot (bot_kick removes it)');
      const why = this.ban(c, minutes || Infinity, true);
      this.game.kick(c, minutes ? `banned for ${minutes} min` : 'banned');
      con.out(ctx, why ? `kicked ${c.name}, not banned: ${why}` : `banned ${c.name}${minutes ? ` for ${minutes} min` : ''}`);
    }, 'banid <minutes> <name or #id>: kicks a player and keeps his address out (0: until the server restarts)');
    con.command('removeip', (a, ctx) => {
      con.out(ctx, this.bans.delete(a[1] || '') ? `unbanned ${a[1]}` : 'removeip <address>: not banned (listip lists them)');
    }, 'removeip <address>: lifts a ban');
    con.command('listip', (_a, ctx) => {
      const list = this.banList();
      con.out(ctx, list.length ? list.map((b) => `${b.address}  ${b.minutes === null ? 'until restart' : `${b.minutes} min`}`).join('\n') : 'no bans');
    }, 'Lists the banned addresses');
    // One line per CHAT_FLOOD_TICKS per caller, as the players' chat: a room's uploader holds
    // its rcon password, and one line of `say a;say a;...` sent ~160 chat lines to everyone.
    con.command('say', (a, ctx) => {
      const who = ctx.client || con, now = this.now();
      if (now - (this.saidAt.get(who) ?? -Infinity) < CHAT_FLOOD_TICKS * TICK_MS) {
        if (!ctx.saidTooFast) con.out(ctx, `say: one line every ${(CHAT_FLOOD_TICKS / TICK_RATE).toFixed(2)} s, the rest dropped`);
        ctx.saidTooFast = true;
        return;
      }
      this.saidAt.set(who, now);
      this.game.chat(null, a.slice(1).join(' '));
    }, 'say <text>: a chat line from Console to everyone');
    con.command('exec', (a, ctx) => this.execCfg(a[1], ctx), 'exec <file>: runs cfg/<file>.cfg');

    // Argument suggestions (the client console's list; a practice server sends them over).
    const levels = Object.keys(DIFFICULTY);
    const botNames = (i) => (i === 1 ? ['all', 't', 'ct', ...(this.game ? this.game.bots.list.map((b) => b.c.name.replace(/^BOT /, '')) : [])] : []);
    con.hint('bot_add', ['t', 'ct', ...levels]);
    con.hint('bot_add_t', levels);
    con.hint('bot_add_ct', levels);
    con.hint('bot_kick', botNames);
    con.hint('bot_kill', botNames);
    con.hint('bot_join_team', [['any', 'either team'], ['t', 'Terrorists'], ['ct', 'Counter-Terrorists']]);
    con.hint('bot_quota_mode', [['normal', 'bot_quota bots'], ['fill', 'bots fill up to bot_quota players']]);
    con.hint('bot_difficulty', levels.map((l, i) => [String(i), l]));
    con.hint('game_type', [['0', 'classic'], ['1', 'gun game, deathmatch'], ['2', 'demo']]);
    con.hint('game_mode', [['0', 'casual / arms race / demo'], ['1', 'competitive / demolition'], ['2', 'wingman / deathmatch'],
      ['3', 'retakes']]);
    const mapNames = (i) => (i === 1 ? opts.listMaps() : []);
    con.hint('map', mapNames);
    con.hint('changelevel', mapNames);
    con.hint('switchteam', ['t', 'ct', 'spec']);
    con.hint('removeip', (i) => (i === 1 ? this.banList().map((b) => b.address) : []));
  }

  // bot_add / bot_kick change bot_quota to what is there now (fill: bots and the humans
  // on teams), as in CS:GO.
  syncBotQuota() {
    const g = this.game, fill = this.con.get('bot_quota_mode').value === 'fill';
    let humans = 0;
    for (const c of g.clients) if (c && c.joined && !c.bot && c.playing) humans++;
    this.con.get('bot_quota').set(g.bots.list.length + (fill ? humans : 0));
  }

  // Starts the first map.
  start(mapName) {
    const bsp = this.opts.loadMap(mapName);
    this.loadMode();
    this.game = this.newGame(mapName, bsp);
  }

  // Runs the game mode's cfgs (game_type / game_mode) for the map about to start.
  loadMode() {
    const base = `${this.con.get('game_type').number}/${this.con.get('game_mode').number}`;
    const flags = this.con.get('sv_game_mode_flags').number, key = flags && GAME_MODES[`${base}/${flags}`] ? `${base}/${flags}` : base;
    this.modeName = GAME_MODES[key] || 'competitive';
    if (!GAME_MODES[key]) this.con.out({}, `game_type / game_mode ${key} is not supported: competitive`);
    const quiet = { print: () => {} };
    this.execCfg(`gamemode_${this.modeName}`, quiet);
    this.execCfg(`gamemode_${this.modeName}_server`, quiet);
  }

  newGame(mapName, bsp) {
    const game = new Game(mapName, bsp, { ...this.rules(), ...this.opts.rules });
    game.rules = { ...game.rules, ...this.roundTimeFor(game) };
    game.rcon = (c, password, command) => this.rcon(c, password, command);
    game.admit = (c, password) => this.admit(c, password);
    game.voteCommand = (c, args) => this.votes.command(c, args);
    this.votes.reset();
    return game;
  }

  // Game rules from the mp_* cvars.
  rules() {
    const v = (n) => this.con.get(n).number;
    return {
      freezeTime: v('mp_freezetime'),
      roundTime: Math.round(v('mp_roundtime') * 60),
      buyTime: v('mp_buytime'),
      roundEndDelay: v('mp_round_restart_delay'),
      c4Timer: v('mp_c4timer'),
      maxRounds: v('mp_maxrounds'),
      startMoney: v('mp_startmoney'),
      maxMoney: v('mp_maxmoney'),
      warmupTime: v('mp_warmuptime'),
      cheats: v('sv_cheats') !== 0 || this.modeName === 'demo', // the demo allows the cheat commands
      talkEnemyDead: v('sv_talk_enemy_dead') !== 0,
      talkEnemyLiving: v('sv_talk_enemy_living') !== 0,
      ...Object.fromEntries(MODES.filter((m) => m.rule).map((m) => [m.rule, this.modeName === m.name])), // deathmatch, demo, ...
      halftime: v('mp_halftime') !== 0,
      overtime: v('mp_overtime_enable') !== 0,
      overtimeRounds: v('mp_overtime_maxrounds'),
      overtimeMoney: v('mp_overtime_startmoney'),
      teamSizeMax: v('mp_teamsize_max'),
      teammatesAreEnemies: v('mp_teammates_are_enemies') !== 0,
      solidTeammates: v('mp_solid_teammates') !== 0,
      respawnT: v('mp_respawn_on_death_t') !== 0,
      respawnCT: v('mp_respawn_on_death_ct') !== 0,
      randomSpawn: v('mp_randomspawn') !== 0,
      ignoreWinConditions: v('mp_ignore_round_win_conditions') !== 0,
      timeLimit: Math.round(v('mp_timelimit') * 60),
      buyAnywhere: v('mp_buy_anywhere') !== 0,
      freeArmor: v('mp_free_armor') !== 0,
      buyGrenades: v('mp_buy_allow_grenades') !== 0,
      giveC4: v('mp_give_player_c4') !== 0,
      hostagesMax: v('mp_hostages_max'),
      immunityTime: v('mp_respawn_immunitytime'),
      matchRestartDelay: v('mp_match_restart_delay'),
      deathDropGun: v('mp_death_drop_gun') !== 0,
      deathDropGrenade: v('mp_death_drop_grenade'),
      deathDropDefuser: v('mp_death_drop_defuser') !== 0,
      friendlyFire: v('mp_friendlyfire') !== 0,
      ffBullets: v('ff_damage_reduction_bullets'),
      ffGrenade: v('ff_damage_reduction_grenade'),
      ffGrenadeSelf: v('ff_damage_reduction_grenade_self'),
      ffOther: v('ff_damage_reduction_other'),
      limitTeams: v('mp_limitteams'),
      autoTeamBalance: v('mp_autoteambalance') !== 0,
      timeoutMax: v('mp_team_timeout_max'),
      timeoutTime: v('mp_team_timeout_time'),
      armouryEntities: v('mp_armoury_entities') !== 0,
      botQuota: v('bot_quota'),
      botQuotaMode: this.con.get('bot_quota_mode').value === 'fill' ? 'fill' : 'normal',
      botJoinAfterPlayer: v('bot_join_after_player') !== 0,
      botDifficulty: v('bot_difficulty'),
      botJoinTeam: this.con.get('bot_join_team').value.toLowerCase(),
      botStop: v('bot_stop') !== 0,
      botDontShoot: v('bot_dont_shoot') !== 0,
    };
  }

  // CS:GO: bomb and hostage maps have their own round time cvars.
  roundTimeFor(game) {
    const v = (n) => this.con.get(n).number;
    const special = game.bombSites.count ? v('mp_roundtime_defuse') : game.timeWinner ? v('mp_roundtime_hostage') : 0;
    return { roundTime: Math.round((special || v('mp_roundtime')) * 60) };
  }

  // A cvar changed: takes effect from the next round (as in CS:GO).
  applyRules() {
    if (!this.game) return;
    this.game.rules = { ...this.game.rules, ...this.rules(), ...this.opts.rules, ...this.roundTimeFor(this.game) };
  }

  // Switches maps: every client is told to reconnect, then a new game starts there.
  changeLevel(name, ctx) {
    if (!name || !/^[\w-]+$/.test(name)) return this.con.out(ctx, 'map <name>');
    if (ctx.source === 'rcon' || ctx.source === 'vote') { // (a passed vote is limited alike)
      const now = this.now();
      if (now - this.mapChangedAt < (this.opts.mapGapMs ?? RCON_MAP_GAP_MS)) return this.con.out(ctx, 'map: too soon after the last change');
      this.mapChangedAt = now;
    }
    let bsp;
    try {
      bsp = this.opts.loadMap(name);
    } catch (err) {
      return this.con.out(ctx, `map ${name}: ${err.message}`);
    }
    // The notice goes out three times (datagrams), before the sessions close (the transport
    // lets what was sent go out first: server/transport.js CLOSE_MS).
    for (const c of this.game.clients) {
      if (!c) continue;
      if (c.joined) for (let i = 0; i < 3; i++) c.session.send(writeChangelevel(c.writer(), name));
      c.joined = false;
      c.session.close('changelevel');
    }
    this.loadMode();
    this.game = this.newGame(name, bsp);
    this.con.out(ctx, `changelevel to ${name}`);
  }

  execCfg(name, ctx) {
    if (!name || !/^[\w.-]+$/.test(name)) return this.con.out(ctx, 'exec <file>');
    const text = this.opts.readCfg ? this.opts.readCfg(name.endsWith('.cfg') ? name : `${name}.cfg`) : null;
    if (text === null) return this.con.out(ctx, `exec: couldn't exec ${name}`);
    this.con.exec(text, ctx);
  }

  // One tick of `game`. A tick that throws (a bug) is logged, at most once a second, and
  // the game goes on (step() counts the tick first): one bad tick must not stop the server
  // for everyone. Uncaught, it ended the Deno process and froze the practice worker.
  step(game) {
    try {
      game.step();
      if (game === this.game) this.votes.step();
    } catch (err) {
      this.failedTicks++;
      const now = this.now();
      if (now - this.failReportAt < 1000) return;
      this.failReportAt = now;
      const more = this.failedTicks > 1 ? ` (${this.failedTicks} failed ticks since the last report)` : '';
      this.failedTicks = 0;
      console.error(`tick ${game.tick} failed${more}:`, err);
    }
  }

  // rcon from a client: null if the password is wrong, else the command's output (or
  // why it was not run).
  rcon(c, password, command) {
    return this.rconAs(c.session && c.session.address, `player ${c.id} "${c.name}"`, password, command, c);
  }

  // rcon from `address` (a player's console; the admin page, client null), `who` naming the
  // caller in the log: null if the password is wrong, else the output or why it was not run.
  rconAs(address, who, password, command, client = null) {
    const refused = this.rconRefusal(address, password, who);
    if (refused !== '') return refused;
    console.log(`rcon from ${who}: ${command}`);
    return this.capture(command, client);
  }

  // Why rcon from `address` with `password` may not run now: '' when it may, null for a
  // wrong password (counted against the address), else the reason.
  rconRefusal(address, password, who) {
    const pw = this.password.value;
    if (!pw) return 'rcon is disabled on this server (no rcon_password)';
    const key = addressKey(address);
    const refused = this.rconGuesses.refused(key);
    if (refused) return `rcon: too many bad passwords${refused === 'server' ? ' on this server' : ''}, try later`;
    if (password !== pw) {
      this.rconGuesses.fail(key);
      console.log(`rcon: bad password from ${who}${key ? ` (${key})` : ''}`);
      return null;
    }
    this.rconGuesses.ok(key);
    return '';
  }

  // Runs a command line as rcon does (its budget, its output cut at RCON_OUTPUT) and returns
  // what it printed. `client`: the player it runs as (bot_place), or null.
  capture(command, client = null) {
    const out = [];
    let left = RCON_OUTPUT;
    const print = (s) => {
      if (left > 0) out.push(s.length <= left ? s : `${s.slice(0, left)}\n(the rest cut: ${RCON_OUTPUT} characters at most)`);
      left -= s.length + 1; // and its line break
    };
    const ctx = this.execCtx = { print, source: 'rcon', client, budget: RCON_BUDGET };
    try {
      this.con.exec(command, ctx);
    } finally {
      this.execCtx = null;
    }
    return out.join('\n');
  }

  // A player by `#id` or by name; null when no one, or several, have that name (everyone
  // who never changed it is "player": the first of them was kicked).
  findClient(q) {
    const g = this.game;
    if (q.startsWith('#')) return g.clients[+q.slice(1)] || null;
    const named = g.clients.filter((c) => c && c.joined && c.name === q);
    return named.length === 1 ? named[0] : null;
  }

  // sv_password for a joining session: '' to let it in, else why not (its HELLO is refused).
  // Guesses are limited like rcon's.
  admit(c, password) {
    // (a bot sends no password: on a server with one, every bot_add left a bot in the list
    // with no player behind it)
    if (c.bot) return '';
    const key = addressKey(c.session && c.session.address), until = this.bans.get(key);
    if (until !== undefined) {
      if (this.now() < until) return until === Infinity ? 'banned from this server' : `banned: you can come back in ${Math.ceil((until - this.now()) / 60000)} min`;
      this.bans.delete(key);
    }
    const pw = this.joinPassword.value;
    if (!pw) return '';
    if (!password) return 'this server has a password'; // asks nothing: not counted as a guess
    const refused = this.joinGuesses.refused(key);
    if (refused) return 'too many bad passwords, try later';
    if (password !== pw) {
      this.joinGuesses.fail(key);
      console.log(`bad sv_password from ${key || 'a session'}`);
      return 'bad password';
    }
    this.joinGuesses.ok(key);
    return '';
  }

  // A player voted out: his address cannot join for `minutes` (loopback never). Not while
  // another human from that address stays in the game: a housemate would be refused at the
  // next map change, every player rejoining then (`force`, banid: the server's own choice).
  // Returns '' when banned, else why not.
  ban(c, minutes, force = false) {
    const address = c.session && c.session.address, key = addressKey(address);
    if (!(minutes > 0) || !address) return 'no address';
    if (isLoopback(address)) return 'this machine (loopback) is never banned';
    const shared = (o) => o && o !== c && o.joined && !o.bot && o.session && addressKey(o.session.address) === key;
    if (!force && this.game.clients.some(shared)) {
      console.log(`vote: ${key} not banned, another player shares it`);
      return 'another player shares the address';
    }
    remember(this.bans, key, this.now() + minutes * 60000, ADDRESSES_KEEP);
    return '';
  }

  // The bans in force: { address, minutes left (null: until the server restarts) }.
  banList() {
    const now = this.now(), out = [];
    for (const [address, until] of this.bans) {
      if (until > now) out.push({ address, minutes: until === Infinity ? null : Math.ceil((until - now) / 60000) });
    }
    return out;
  }

  // What the start menu shows before joining (connect.json).
  info() {
    return {
      hostname: this.hostname.value, map: this.game.mapName, mode: this.modeName, players: this.game.playerCount,
      maxPlayers: MAX_PLAYERS, password: !!this.joinPassword.value,
    };
  }

  // What the admin page shows (client/admin.html; server/admin.js serves it): the server,
  // the round, every player, the cvars' values (not the protected ones) and the bans.
  adminState() {
    const g = this.game, rs = g.round, players = [], cvars = {};
    for (const c of g.clients) {
      if (!c || !c.joined) continue;
      const p = c.player;
      players.push({
        id: c.id, name: c.name, team: c.team, bot: !!c.bot, difficulty: c.bot ? c.bot.difficulty : -1, alive: c.alive,
        health: Math.max(0, p.health), armor: p.armor, helmet: p.helmet, money: p.money, kills: c.kills,
        assists: c.assists, deaths: c.deaths, score: c.score, mvps: c.mvps, level: c.level,
        address: c.bot || !c.session ? '' : addressKey(c.session.address),
      });
    }
    for (const cv of this.con.cvars.values()) if (!(cv.flags & FCVAR_PROTECTED)) cvars[cv.name] = cv.value;
    return {
      hostname: this.hostname.value, map: g.mapName, mode: this.modeName, maps: this.opts.listMaps(), maxPlayers: MAX_PLAYERS,
      round: {
        phase: PHASE_NAMES[rs.phase], round: rs.round, scoreT: rs.scoreT, scoreCT: rs.scoreCT,
        secondsLeft: Math.max(0, Math.ceil((g.phaseEnd - g.tick) / TICK_RATE)), paused: g.paused,
        cheats: this.rules().cheats,
      },
      players, cvars, bans: this.banList(), password: !!this.joinPassword.value,
    };
  }

  status() {
    const g = this.game, rs = g.round;
    const lines = [
      `hostname: ${this.hostname.value}`,
      `mode    : ${this.modeName}`,
      `map     : ${g.mapName}  ${PHASE_NAMES[rs.phase]}${rs.phase === PHASE_WARMUP ? '' : `, round ${rs.round}`}` +
      `  T ${rs.scoreT} - ${rs.scoreCT} CT`,
      `players : ${g.playerCount}/${MAX_PLAYERS}`,
      '# id  name                 team  kills deaths money  alive',
    ];
    for (const c of g.clients) {
      if (!c || !c.joined) continue;
      lines.push(`# ${String(c.id).padEnd(3)} ${c.name.padEnd(20).slice(0, 20)} ${TEAM_NAMES[c.team].padEnd(4)}  ` +
        `${String(c.kills).padStart(5)} ${String(c.deaths).padStart(6)} ${String(c.player.money).padStart(6)}  ${c.alive ? 'yes' : 'no'}`);
    }
    return lines.join('\n');
  }
}
