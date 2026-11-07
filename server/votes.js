// Votes (CS:GO's callvote): a player calls a vote to kick a teammate (`callvote kick <name or
// #id>`), change the map (`callvote changelevel <map>`), restart the match (`callvote
// restartgame`), scramble or swap the teams (`scrambleteams`, `swapteams`: a fresh match), pause
// or resume it at the freeze time (`pausematch`, `unpausematch`), or, voted by the caller's team
// alone, call a tactical timeout (`starttimeout`) or surrender (`surrender`: every one of them
// yes; the other team wins the match); the players who may vote (one an address) answer with F1 / F2 (`vote option1` / `vote
// option2`) within sv_vote_timer_duration. The caller votes yes. It passes once the yes votes
// reach sv_vote_quorum_ratio of those who may vote, and fails once it no longer can or the
// time is up. A kick is voted on by the target's team (everyone in free for all), the target
// left out, and needs two yes at least (ours: the caller alone never kicks anyone); a kicked
// player's address cannot come back for sv_vote_kick_ban_duration minutes (Host.admit).
// The cvars are CS:GO's (the quorum 0.6 here). The Host owns one: a map change ends a vote.

import {
  writeVote, VOTE_KICK, VOTE_CHANGELEVEL, VOTE_RESTART, VOTE_RUNNING, VOTE_PASSED, VOTE_FAILED, VOTE_SURRENDER,
  VOTE_TIMEOUT, VOTE_SCRAMBLE, VOTE_SWAP, VOTE_PAUSE, VOTE_UNPAUSE,
} from '../shared/protocol.js';
import { TICK_RATE } from '../shared/constants.js';
import { TEAM_NAMES } from '../shared/player.js';
import { PHASE_WARMUP } from '../shared/economy.js';
import { addressKey, isLoopback, remember } from './host.js';

// By callvote's word: the issue on the wire, the cvar allowing it, how the console says it;
// `team`: the caller's team votes (else everyone); `teams`: not in free for all; `rounds`: only
// in a match of rounds between teams, not in warmup.
const ISSUES = new Map([
  ['kick', { issue: VOTE_KICK, allowed: 'sv_vote_issue_kick_allowed', label: 'kick' }],
  ['changelevel', { issue: VOTE_CHANGELEVEL, allowed: 'sv_vote_issue_changelevel_allowed', label: 'change the map to' }],
  ['restartgame', { issue: VOTE_RESTART, allowed: 'sv_vote_issue_restart_game_allowed', label: 'restart the match' }],
  ['scrambleteams', { issue: VOTE_SCRAMBLE, allowed: 'sv_vote_issue_scramble_teams_allowed', label: 'scramble the teams', teams: true }],
  ['swapteams', { issue: VOTE_SWAP, allowed: 'sv_vote_issue_swap_teams_allowed', label: 'swap the teams', teams: true }],
  ['pausematch', { issue: VOTE_PAUSE, allowed: 'sv_vote_issue_pause_match_allowed', label: 'pause the match' }],
  ['unpausematch', { issue: VOTE_UNPAUSE, allowed: 'sv_vote_issue_pause_match_allowed', label: 'resume the match' }],
  ['starttimeout', { issue: VOTE_TIMEOUT, allowed: 'sv_vote_issue_timeout_allowed', label: 'call a tactical timeout', team: true, rounds: true }],
  ['surrender', { issue: VOTE_SURRENDER, allowed: 'sv_vote_issue_surrender_allowed', label: 'surrender', team: true, rounds: true }],
]);
const USAGE = `callvote ${[...ISSUES.keys()].map((k) => (k === 'kick' ? 'kick <name or #id>' : k === 'changelevel' ? 'changelevel <map>' : k)).join(' | ')}`;
const SEND_TICKS = TICK_RATE / 2; // a running vote goes out twice a second (datagrams can be lost)
const RESULT_SENDS = 3; // the result goes out on this many ticks
const FAILED_KEEP = 256; // failed votes remembered (sv_vote_failure_timer), and callers

// Who a client votes and calls as: his address (addressKey), one voter an address (a machine
// may hold 5 sessions: two tabs passed a kick alone); on loopback the client (development
// plays a tab per player).
function voterOf(c) {
  const address = c.session && c.session.address;
  return !address || isLoopback(address) ? c : addressKey(address);
}

export class Votes {
  constructor(host) {
    this.host = host;
    // The running vote: { id, issue, label, key, arg, detail, caller, target, voters: Map(client ->
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
    const name = (args[1] || '').toLowerCase(), row = ISSUES.get(name);
    if (!row) return USAGE;
    if (!this.num(row.allowed)) return `callvote ${name} is off on this server.`;
    const issue = row.issue;
    if (this.vote) return 'A vote is already in progress.';
    if (!c.playing) return 'Spectators cannot call votes.';
    const who = voterOf(c);
    const wait = (this.lastCall.get(who) ?? -Infinity) + this.num('sv_vote_creation_timer') * 1000 - now;
    if (wait > 0) return `You can call another vote in ${Math.ceil(wait / 1000)} s.`;
    const ffa = game.rules.teammatesAreEnemies;
    if ((row.teams || row.rounds) && ffa) return `callvote ${name}: not in free for all.`;
    if (row.rounds && (!game.rules.rounds || game.rules.ignoreWinConditions)) return `callvote ${name}: only in a match of rounds.`;
    if (row.rounds && game.phase === PHASE_WARMUP) return `callvote ${name}: not in warmup.`;
    if (issue === VOTE_TIMEOUT && (game.timeoutTeam || game.tick < game.timeoutEnd)) return 'A timeout is already on.';
    if (issue === VOTE_TIMEOUT && !game.timeoutsLeft(c.team)) return 'Your team has no timeouts left (mp_team_timeout_max).';
    if (issue === VOTE_PAUSE && game.paused) return 'The match is paused already.';
    if (issue === VOTE_UNPAUSE && !game.paused) return 'The match is not paused.';
    let target = null, arg = '', detail = row.team ? `${TEAM_NAMES[c.team]}s` : '';
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
    // A team vote is its team's: one team's failed timeout does not hold the other's back.
    const key = arg ? `${name} ${arg}` : row.team ? `${name} ${c.team}` : name;
    const again = (this.failed.get(key) ?? -Infinity) + this.num('sv_vote_failure_timer') * 1000 - now;
    if (again > 0) return `That vote failed a moment ago: it can be called again in ${Math.ceil(again / 1000)} s.`;
    const voters = new Map([[c, 0]]), seen = new Set([who]);
    for (const o of game.clients) {
      if (!o || !o.joined || o.bot || !o.playing || o === target || ((row.team || issue === VOTE_KICK) && !ffa && o.team !== c.team)) continue;
      const k = voterOf(o);
      if (seen.has(k)) continue; // (another session of an address already in)
      seen.add(k);
      voters.set(o, 0);
    }
    const needed = issue === VOTE_SURRENDER ? Math.max(voters.size, 2) // every one of the team, two at least (one among bots ended everyone's match)
      : Math.max(Math.ceil(this.num('sv_vote_quorum_ratio') * voters.size - 1e-9), issue === VOTE_KICK ? 2 : 1);
    if (voters.size < needed) return 'Not enough players who can vote on that.';
    remember(this.lastCall, who, now, FAILED_KEEP);
    voters.set(c, 1);
    this.id = (this.id + 1) & 0xff;
    this.vote = {
      id: this.id, issue, label: row.label, key, arg, detail: detail || arg, caller: c, team: c.team, teamOnly: !!row.team,
      target, voters, needed,
      endsAt: now + this.num('sv_vote_timer_duration') * 1000,
    };
    this.result = null;
    this.resultSends = 0;
    this.tell(this.vote, `${c.name} called a vote: ${this.label(this.vote)}?`);
    console.log(`vote: ${c.name} called ${key}`);
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

  // A console line about vote vt: a team's vote (surrender, timeout) to its voters alone, as
  // CS:GO keeps it from the other side; the rest to everyone.
  tell(vt, text) {
    if (!vt.teamOnly) return this.host.game.printAll(text);
    for (const o of vt.voters.keys()) if (o.joined) this.host.game.print(o, text);
  }

  label(vt) {
    if (vt.issue === VOTE_TIMEOUT || vt.issue === VOTE_SURRENDER) return `${vt.label} (the ${vt.detail})`;
    return `${vt.label}${vt.detail ? ` ${vt.detail}` : ''}`;
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
    // A team's vote whose side changed (the half-time swap within its 15 s) would hand its
    // result to the other players: it ends, not counted as failed.
    if (vt.teamOnly && vt.caller.team !== vt.team) return this.end(false, false);
    if (yes >= vt.needed) return this.end(true);
    if (yes + open < vt.needed || this.host.now() >= vt.endsAt) this.end(false);
  }

  end(passed, counted = true) {
    const vt = this.vote, host = this.host, game = host.game, now = host.now();
    this.vote = null;
    vt.state = passed ? VOTE_PASSED : VOTE_FAILED;
    this.result = vt;
    this.resultSends = RESULT_SENDS - 1;
    this.send(vt);
    this.tell(vt, `Vote ${passed ? 'passed' : counted ? 'failed' : 'called off'}: ${this.label(vt)}`);
    console.log(`vote: ${vt.key} ${passed ? 'passed' : counted ? 'failed' : 'called off'}`);
    if (!passed) {
      if (counted) remember(this.failed, vt.key, now, FAILED_KEEP);
    } else if (vt.issue === VOTE_KICK) {
      host.ban(vt.target, this.num('sv_vote_kick_ban_duration'));
      game.kick(vt.target, 'kicked by vote');
    } else if (vt.issue === VOTE_CHANGELEVEL) {
      // Through the console's changelevel: the practice worker's fetches the map first. A
      // reply while this game still runs says why it did not change (now, or once fetched).
      host.con.run(['changelevel', vt.arg], { source: 'vote', print: (s) => host.game === game && this.unpass(vt, s) });
    } else if (vt.issue === VOTE_RESTART) {
      game.restartGame(1);
    } else if (vt.issue === VOTE_SCRAMBLE || vt.issue === VOTE_SWAP) {
      game.scheduleTeams(vt.issue === VOTE_SWAP ? 'swap' : 'scramble');
    } else if (vt.issue === VOTE_PAUSE || vt.issue === VOTE_UNPAUSE) {
      game.pauseMatch(vt.issue === VOTE_PAUSE);
    } else if (vt.issue === VOTE_TIMEOUT) {
      game.callTimeout(vt.team);
    } else if (vt.issue === VOTE_SURRENDER) {
      game.surrender(vt.team);
    }
  }

  // A passed changelevel that did not happen (too soon after the last change, a map that does
  // not load): everyone is told it failed, and why.
  unpass(vt, why) {
    vt.state = VOTE_FAILED;
    this.host.game.printAll(`Vote failed: ${this.label(vt)} (${why})`);
    console.log(`vote: ${vt.key} failed: ${why}`);
    if (this.result !== vt) return; // a newer vote is on the panels
    this.resultSends = RESULT_SENDS - 1;
    this.send(vt);
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
      if (!c || !c.joined || c.bot || (vt.teamOnly && !vt.voters.has(c))) continue; // (a team's vote: its own)
      const mine = vt.voters.has(c) ? 1 + vt.voters.get(c) : 0;
      c.session.send(writeVote(c.writer(), vt.id, vt.state || VOTE_RUNNING, vt.issue, vt.caller.id, yes, no,
        vt.voters.size, vt.needed, left, mine, vt.detail));
    }
  }
}
