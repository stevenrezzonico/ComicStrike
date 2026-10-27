// The server host: owns the running Game and the server console (CS:GO-style cvars and
// commands, run from cfg/server.cfg, the terminal and rcon), and switches maps.
// Transport-agnostic: sessions only need send(bytes) and close(reason).

import { Console, FCVAR_PROTECTED } from '../shared/cvars.js';
import { writeChangelevel, MAX_PLAYERS } from '../shared/protocol.js';
import { TEAM_CT } from '../shared/player.js';
import { PHASE_WARMUP } from '../shared/economy.js';
import { Game, DEFAULT_RULES } from './game.js';

const PHASE_NAMES = ['warmup', 'freeze time', 'live', 'round over'];
const CHANGELEVEL_CLOSE_MS = 500;

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
    this.game = this.newGame(mapName, this.opts.loadMap(mapName));
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

  status() {
    const g = this.game, rs = g.round;
    const lines = [
      `hostname: ${this.hostname.value}`,
      `map     : ${g.mapName}  ${PHASE_NAMES[rs.phase]}${rs.phase === PHASE_WARMUP ? '' : `, round ${rs.round}`}` +
      `  T ${rs.scoreT} - ${rs.scoreCT} CT`,
      `players : ${g.playerCount}/${MAX_PLAYERS}`,
      '# id  name                 team  kills deaths money  alive',
    ];
    for (const c of g.clients) {
      if (!c || !c.joined) continue;
      lines.push(`# ${String(c.id).padEnd(3)} ${c.name.padEnd(20).slice(0, 20)} ${c.team === TEAM_CT ? 'CT' : 'T '}    ` +
        `${String(c.kills).padStart(5)} ${String(c.deaths).padStart(6)} ${String(c.player.money).padStart(6)}  ${c.alive ? 'yes' : 'no'}`);
    }
    return lines.join('\n');
  }
}
