// Votes (CS:GO's callvote): a player calls a vote to kick a teammate (`callvote kick <name or
// #id>`), change the map (`callvote changelevel <map>`) or restart the match (`callvote
// restartgame`); the players who may vote answer with F1 / F2 (`vote option1` / `vote
// option2`) within sv_vote_timer_duration. The caller votes yes. It passes once the yes votes
// reach sv_vote_quorum_ratio of those who may vote, and fails once it no longer can or the
// time is up. A kick is voted on by the target's team (everyone in free for all), the target
// left out, and needs two yes at least (ours: the caller alone never kicks anyone); a kicked
// player's address cannot come back for sv_vote_kick_ban_duration minutes (Host.admit).
// The cvars are CS:GO's (the quorum 0.6 here). The Host owns one: a map change ends a vote.

import {
  writeVote, VOTE_KICK, VOTE_CHANGELEVEL, VOTE_RESTART, VOTE_RUNNING, VOTE_PASSED, VOTE_FAILED,
} from '../shared/protocol.js';
import { TICK_RATE } from '../shared/constants.js';
import { addressKey, isLoopback } from './host.js';

const ISSUES = { kick: VOTE_KICK, changelevel: VOTE_CHANGELEVEL, restartgame: VOTE_RESTART };
const ALLOWED = ['sv_vote_issue_kick_allowed', 'sv_vote_issue_changelevel_allowed', 'sv_vote_issue_restart_game_allowed'];
const LABELS = ['kick', 'change the map to', 'restart the match'];
const SEND_TICKS = TICK_RATE / 2; // a running vote goes out twice a second (datagrams can be lost)
const RESULT_SENDS = 3; // the result goes out on this many ticks
const FAILED_KEEP = 256; // failed votes remembered (sv_vote_failure_timer), and callers

export class Votes {
  constructor(host) {
    this.host = host;
    // The running vote: { id, issue, key, arg, detail, caller, target, voters: Map(client ->
    // 0 undecided, 1 yes, 2 no), needed, endsAt (ms) }, or null.
    this.vote = null;
    this.id = 0; // counts votes, so a client tells a new vote from the last one's result
    this.result = null; // the last vote, with `state`, while its result goes out
    this.resultSends = 0;
    this.sentTick = -Infinity;
    // Who called (address key; a client on loopback) -> ms of the last call (sv_vote_creation_timer):
    // by address, as a reconnect is a new client and reset it.
    this.lastCall = new Map();
    this.failed = new Map(); // 'issue arg' -> ms it failed (sv_vote_failure_timer)
  }

  num(name) {
    return this.host.con.get(name).number;
  }

  // `callvote ...` or `vote ...` from client c: '' or what to tell it.
  command(c, args) {
    return args[0].toLowerCase() === 'callvote' ? this.call(c, args) : this.cast(c, (args[1] || '').toLowerCase());
  }

  call(c, args) {
    const game = this.host.game, now = this.host.now();
    if (!this.num('sv_allow_votes')) return 'Voting is off on this server.';
    const name = (args[1] || '').toLowerCase(), issue = ISSUES[name];
    if (issue === undefined) return 'callvote kick <name or #id> | changelevel <map> | restartgame';
    if (!this.num(ALLOWED[issue])) return `callvote ${name} is off on this server.`;
    if (this.vote) return 'A vote is already in progress.';
    if (!c.playing) return 'Spectators cannot call votes.';
    const address = c.session && c.session.address, who = !address || isLoopback(address) ? c : addressKey(address);
    const wait = (this.lastCall.get(who) ?? -Infinity) + this.num('sv_vote_creation_timer') * 1000 - now;
    if (wait > 0) return `You can call another vote in ${Math.ceil(wait / 1000)} s.`;
    const ffa = game.rules.teammatesAreEnemies;
    let target = null, arg = '', detail = '';
    if (issue === VOTE_KICK) {
      target = this.host.findClient(args.slice(2).join(' '));
      if (!target || target.bot) return 'callvote kick <name or #id>: no such player, or several have that name: status lists the ids (bots go with bot_kick)';
      if (target === c) return 'You cannot vote yourself out.';
      if (!ffa && target.team !== c.team) return 'Only a teammate can be voted out.';
      arg = target.name;
      // A name others share too: the panel says which one.
      if (game.clients.some((o) => o && o !== target && o.joined && o.name === arg)) detail = `${arg} (#${target.id})`;
    } else if (issue === VOTE_CHANGELEVEL) {
      arg = (args[2] || '').toLowerCase();
      if (!this.host.opts.listMaps().includes(arg)) return `callvote changelevel <map>: no map "${arg}" here (maps lists them)`;
    }
    const key = `${name} ${arg}`;
    const again = (this.failed.get(key) ?? -Infinity) + this.num('sv_vote_failure_timer') * 1000 - now;
    if (again > 0) return `That vote failed a moment ago: it can be called again in ${Math.ceil(again / 1000)} s.`;
    const voters = new Map();
    for (const o of game.clients) {
      if (o && o.joined && !o.bot && o.playing && o !== target && (issue !== VOTE_KICK || ffa || o.team === c.team)) voters.set(o, 0);
    }
    const needed = Math.max(Math.ceil(this.num('sv_vote_quorum_ratio') * voters.size - 1e-9), issue === VOTE_KICK ? 2 : 1);
    if (voters.size < needed) return 'Not enough players who can vote on that.';
    this.lastCall.delete(who); // the newest last: the oldest goes first
    if (this.lastCall.size >= FAILED_KEEP) this.lastCall.delete(this.lastCall.keys().next().value);
    this.lastCall.set(who, now);
    voters.set(c, 1);
    this.id = (this.id + 1) & 0xff;
    this.vote = {
      id: this.id, issue, key, arg, detail: detail || arg, caller: c, target, voters, needed,
      endsAt: now + this.num('sv_vote_timer_duration') * 1000,
    };
    this.result = null;
    this.resultSends = 0;
    game.printAll(`${c.name} called a vote: ${this.label(this.vote)}?`);
    console.log(`vote: ${c.name} called ${key.trim()}`);
    this.send();
    this.decide();
    return '';
  }

  cast(c, option) {
    const vt = this.vote;
    const choice = option === 'option1' || option === 'yes' ? 1 : option === 'option2' || option === 'no' ? 2 : 0;
    if (!choice) return 'vote option1 (yes, F1) | option2 (no, F2)';
    if (!vt) return 'No vote in progress.';
    if (!vt.voters.has(c)) return 'You cannot vote on this one.';
    if (vt.voters.get(c)) return ''; // once, as in CS:GO
    vt.voters.set(c, choice);
    this.send();
    this.decide();
    return '';
  }

  label(vt) {
    return `${LABELS[vt.issue]}${vt.detail ? ` ${vt.detail}` : ''}`;
  }

  // Ends the vote once it passed, can no longer pass, ran out of time or lost its target.
  decide() {
    const vt = this.vote;
    if (!vt) return;
    let yes = 0, open = 0;
    for (const [o, x] of vt.voters) {
      if (!o.joined) vt.voters.delete(o); // left the game
      else if (x === 1) yes++;
      else if (!x) open++;
    }
    if (vt.target && !vt.target.joined) return this.end(false); // the target left: nothing to vote on
    if (yes >= vt.needed) return this.end(true);
    if (yes + open < vt.needed || this.host.now() >= vt.endsAt) this.end(false);
  }

  end(passed) {
    const vt = this.vote, host = this.host, game = host.game, now = host.now();
    this.vote = null;
    vt.state = passed ? VOTE_PASSED : VOTE_FAILED;
    this.result = vt;
    this.resultSends = RESULT_SENDS - 1;
    this.send(vt);
    game.printAll(`Vote ${passed ? 'passed' : 'failed'}: ${this.label(vt)}`);
    console.log(`vote: ${vt.key.trim()} ${passed ? 'passed' : 'failed'}`);
    if (!passed) {
      if (this.failed.size >= FAILED_KEEP) this.failed.delete(this.failed.keys().next().value);
      this.failed.set(vt.key, now);
    } else if (vt.issue === VOTE_KICK) {
      host.ban(vt.target, this.num('sv_vote_kick_ban_duration'));
      game.kick(vt.target, 'kicked by vote');
    } else if (vt.issue === VOTE_CHANGELEVEL) {
      host.changeLevel(vt.arg);
    } else {
      game.restartGame(1);
    }
  }

  // Each tick (Host.step): the time limit, the running vote twice a second, the result.
  step() {
    if (this.vote) {
      this.decide();
      if (this.vote && this.host.game.tick - this.sentTick >= SEND_TICKS) this.send();
    } else if (this.resultSends > 0) {
      this.resultSends--;
      this.send(this.result);
    }
  }

  // A new map: no vote carries over (its players reconnect).
  reset() {
    this.vote = this.result = null;
    this.resultSends = 0;
  }

  // The vote to every human: the counts, the seconds left, and the receiver's own vote.
  send(vt = this.vote) {
    const game = this.host.game, now = this.host.now();
    this.sentTick = game.tick;
    let yes = 0, no = 0;
    for (const x of vt.voters.values()) {
      if (x === 1) yes++;
      else if (x === 2) no++;
    }
    const left = vt.state ? 0 : Math.max(0, Math.ceil((vt.endsAt - now) / 1000));
    for (const c of game.clients) {
      if (!c || !c.joined || c.bot) continue;
      const mine = vt.voters.has(c) ? 1 + vt.voters.get(c) : 0;
      c.session.send(writeVote(c.writer(), vt.id, vt.state || VOTE_RUNNING, vt.issue, vt.caller.id, yes, no,
        vt.voters.size, vt.needed, left, mine, vt.detail));
    }
  }
}
