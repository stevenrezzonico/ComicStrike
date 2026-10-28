// The server host: owns the running Game and the server console (CS:GO-style cvars and
// commands, run from cfg/server.cfg, the terminal and rcon), and switches maps.
// Transport-agnostic: sessions only need send(bytes) and close(reason).

import { Console, FCVAR_PROTECTED } from '../shared/cvars.js';
import { writeChangelevel, MAX_PLAYERS } from '../shared/protocol.js';
import { TEAM_NAMES, TEAM_T, TEAM_CT } from '../shared/player.js';
import { PHASE_WARMUP } from '../shared/economy.js';
import { Game, DEFAULT_RULES } from './game.js';

const PHASE_NAMES = ['warmup', 'freeze time', 'live', 'round over'];
const CHANGELEVEL_CLOSE_MS = 500;

// CS:GO game modes by game_type / game_mode. A mode is a cfg of mode convars run when a
// map loads (cfg/gamemode_<name>.cfg, then cfg/gamemode_<name>_server.cfg for the
// server's own overrides, as in CS:GO); deathmatch also switches to free weapons and
// points instead of money.
export const GAME_MODES = { '0/1': 'competitive', '1/2': 'deathmatch' };

export class Host {
  // opts: loadMap(name) -> parsed BSP (throws if missing), listMaps() -> names,
  //       readCfg(name) -> text or null, quit(), print(text), rules (test overrides),
  //       defer(fn, ms) (default setTimeout)
  constructor(opts) {
    this.opts = opts;
    this.game = null;
    const con = this.con = new Console(opts.print || ((s) => console.log(s)));
    const apply = () => this.applyRules();
    const num = (name, value, help, min, max) => con.cvar(name, value, { help, min, max, onChange: apply });

    this.hostname = con.cvar('hostname', 'WebCS', { help: 'Server name' });
    this.password = con.cvar('rcon_password', '', { flags: FCVAR_PROTECTED, help: 'Remote console password (empty: rcon off)' });
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
    // Game modes (cfg/gamemode_*.cfg set these).
    con.cvar('game_type', 0, { help: 'Game type (0 classic, 1 gun game family); applies on the next map', min: 0, max: 3 });
    con.cvar('game_mode', 1, { help: 'Game mode (0/1 competitive, 1/2 deathmatch); applies on the next map', min: 0, max: 3 });
    num('mp_teammates_are_enemies', 0, 'Everyone is an enemy (free for all)', 0, 1);
    num('mp_respawn_on_death_t', 0, 'Terrorists respawn after dying', 0, 1);
    num('mp_respawn_on_death_ct', 0, 'Counter-Terrorists respawn after dying', 0, 1);
    num('mp_randomspawn', 0, 'Spawn at any spawn point, away from enemies', 0, 1);
    num('mp_ignore_round_win_conditions', 0, 'Rounds never end by elimination or objectives', 0, 1);
    num('mp_timelimit', 0, 'Match length when rounds never end (min; 0: none)', 0, 600);
    num('mp_buy_anywhere', 0, 'Buy outside the buy zones', 0, 1);
    num('mp_free_armor', 0, 'Spawn with kevlar and a helmet', 0, 1);
    num('mp_give_player_c4', 1, 'A terrorist gets the bomb each round', 0, 1);
    num('mp_hostages_max', 2, 'Hostages per round on hostage maps', 0, 4);
    num('mp_respawn_immunitytime', 0, 'Seconds a respawned player cannot be hurt (until he shoots)', 0, 60);
    num('mp_match_restart_delay', 15, 'Seconds between the end of a match and the next', 1, 300);
    num('mp_death_drop_gun', 1, 'The dead drop their best gun', 0, 1);
    this.modeName = 'competitive'; // of the running map
    // Bots (server/bots.js).
    num('bot_quota', 0, 'Bots on the server (bot_add / bot_kick change it)', 0, MAX_PLAYERS);
    con.cvar('bot_quota_mode', 'normal', { help: 'normal: bot_quota bots; fill: bots fill up to bot_quota players',
      onChange: apply });
    num('bot_difficulty', 1, 'New bots: 0 easy, 1 normal, 2 hard, 3 expert', 0, 3);
    con.cvar('bot_join_team', 'any', { help: 'Team new bots join: any, t, ct', onChange: apply });
    num('bot_stop', 0, 'Bots stand still', 0, 1);
    num('bot_dont_shoot', 0, 'Bots do not shoot', 0, 1);
    const DIFFICULTY = { easy: 0, normal: 1, hard: 2, expert: 3 };
    const botAdd = (team, args, ctx) => { // [easy|normal|hard|expert] [name]
      let difficulty = -1, name = '';
      for (const a of args) {
        if (a.toLowerCase() in DIFFICULTY) difficulty = DIFFICULTY[a.toLowerCase()];
        else name = a.slice(0, 31);
      }
      const c = this.game.bots.add(team, difficulty, name);
      if (!c) return con.out(ctx, 'bot_add: the server is full');
      this.con.get('bot_quota').set(this.game.bots.list.length);
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
        : bots.list.filter((b) => b.c.name === q || b.c.name === `BOT ${q}`).map((b) => b.c);
      for (const c of which) bots.kick(c);
      this.con.get('bot_quota').set(bots.list.length);
      con.out(ctx, which.length ? `kicked ${which.length} bot(s)` : 'bot_kick [name|t|ct|all]: no such bot');
    }, 'bot_kick [name|t|ct|all]: removes bots');
    con.command('bot_kill', (a, ctx) => {
      const q = a.slice(1).join(' ');
      for (const b of this.game.bots.list) {
        if ((!q || q === 'all' || b.c.name === q || b.c.name === `BOT ${q}`) && b.c.alive) this.game.kill(b.c, b.c, 0, false);
      }
      con.out(ctx, 'bots killed');
    }, 'bot_kill [name|all]: kills bots');

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
    con.command('kick', (a, ctx) => {
      const c = this.findClient(a.slice(1).join(' '));
      if (!c) return con.out(ctx, 'kick <name or #id>: no such player');
      this.game.kick(c, 'kicked by the server');
    }, 'kick <name or #id>');
    con.command('say', (a) => this.game.printAll(`Console: ${a.slice(1).join(' ')}`), 'say <text>: message to everyone');
    con.command('exec', (a, ctx) => this.execCfg(a[1], ctx), 'exec <file>: runs cfg/<file>.cfg');
    con.command('quit', () => opts.quit && opts.quit(), 'Stops the server');
    con.command('exit', () => opts.quit && opts.quit(), 'Stops the server');
  }

  // Starts the first map.
  start(mapName) {
    const bsp = this.opts.loadMap(mapName);
    this.loadMode();
    this.game = this.newGame(mapName, bsp);
  }

  // Runs the game mode's cfgs (game_type / game_mode) for the map about to start.
  loadMode() {
    const key = `${this.con.get('game_type').number}/${this.con.get('game_mode').number}`;
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
      cheats: v('sv_cheats') !== 0,
      deathmatch: this.modeName === 'deathmatch',
      teammatesAreEnemies: v('mp_teammates_are_enemies') !== 0,
      respawnT: v('mp_respawn_on_death_t') !== 0,
      respawnCT: v('mp_respawn_on_death_ct') !== 0,
      randomSpawn: v('mp_randomspawn') !== 0,
      ignoreWinConditions: v('mp_ignore_round_win_conditions') !== 0,
      timeLimit: Math.round(v('mp_timelimit') * 60),
      buyAnywhere: v('mp_buy_anywhere') !== 0,
      freeArmor: v('mp_free_armor') !== 0,
      giveC4: v('mp_give_player_c4') !== 0,
      hostagesMax: v('mp_hostages_max'),
      immunityTime: v('mp_respawn_immunitytime'),
      matchRestartDelay: v('mp_match_restart_delay'),
      deathDropGun: v('mp_death_drop_gun') !== 0,
      botQuota: v('bot_quota'),
      botQuotaMode: this.con.get('bot_quota_mode').value === 'fill' ? 'fill' : 'normal',
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
    let bsp;
    try {
      bsp = this.opts.loadMap(name);
    } catch (err) {
      return this.con.out(ctx, `map ${name}: ${err.message}`);
    }
    // The notice goes out three times (datagrams); the sessions close a moment later so
    // it is not lost with them (browsers do not see the close reason).
    const old = this.game;
    const sessions = [];
    for (const c of old.clients) {
      if (!c) continue;
      if (c.joined) for (let i = 0; i < 3; i++) c.session.send(writeChangelevel(c.writer(), name));
      c.joined = false;
      sessions.push(c.session);
    }
    (this.opts.defer || setTimeout)(() => {
      for (const s of sessions) s.close('changelevel');
    }, CHANGELEVEL_CLOSE_MS);
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

  // rcon from a client: null if the password is wrong, else the command's output.
  rcon(c, password, command) {
    const pw = this.password.value;
    if (!pw) return 'rcon is disabled on this server (no rcon_password)';
    if (password !== pw) return null;
    console.log(`rcon from player ${c.id} "${c.name}": ${command}`);
    const out = [];
    this.con.exec(command, { print: (s) => out.push(s), source: 'rcon' });
    return out.join('\n');
  }

  findClient(q) {
    const g = this.game;
    if (q.startsWith('#')) return g.clients[+q.slice(1)] || null;
    return g.clients.find((c) => c && c.joined && c.name === q) || null;
  }

  // What the start menu shows before joining (connect.json).
  info() {
    return {
      hostname: this.hostname.value, map: this.game.mapName, mode: this.modeName, players: this.game.playerCount,
      maxPlayers: MAX_PLAYERS,
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
