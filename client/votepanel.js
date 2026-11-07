// The vote panel (CS:GO's): a running vote (server/votes.js, S2C_VOTE) asks its question with
// who called it, the yes and no votes against what it needs, the seconds left and the keys
// to answer while we may (F1 / F2: `vote option1` / `vote option2`); its result shows for
// RESULT_MS. Every piece of text goes in as textContent. Called every frame: the panel is
// looked at only when a new datagram came or the seconds left changed, and only the lines
// that changed are written (the server resends a running vote twice a second, each a new
// object: rebuilding the panel for each was 2 style recalculations a second, 1-1.8 ms each on
// a laptop, while nothing on it changed).

import {
  VOTE_RUNNING, VOTE_PASSED, VOTE_KICK, VOTE_CHANGELEVEL, VOTE_SURRENDER, VOTE_TIMEOUT, VOTE_SCRAMBLE, VOTE_SWAP, VOTE_PAUSE,
  VOTE_UNPAUSE,
} from '../shared/protocol.js';

// The question by issue (detail: the target, the map, or a team vote's team).
const QUESTION = {
  [VOTE_KICK]: (d) => `Kick ${d}?`,
  [VOTE_CHANGELEVEL]: (d) => `Change the map to ${d}?`,
  [VOTE_SURRENDER]: (d) => `Surrender (the ${d})?`,
  [VOTE_TIMEOUT]: (d) => `Tactical timeout (the ${d})?`,
  [VOTE_SCRAMBLE]: () => 'Scramble the teams?',
  [VOTE_SWAP]: () => 'Swap the teams?',
  [VOTE_PAUSE]: () => 'Pause the match?',
  [VOTE_UNPAUSE]: () => 'Resume the match?',
};

const RESULT_MS = 3000;
const LOST_MS = 2000; // a running vote whose result never came goes this long after its end

export class VotePanel {
  // names(id): a player's name; keyOf(command): the key bound to it ('' none).
  constructor(el, names, keyOf) {
    this.el = el;
    this.names = names;
    this.keyOf = keyOf;
    this.shown = null; // the vote datagram last shown
    this.secs = -1; // seconds left last shown (0 a result, -1 hidden)
    this.rows = []; // the line elements shown
  }

  // v: the newest vote (net.vote: a new object for each datagram, `at` when it came) or null,
  // now: ms.
  update(v, now) {
    let secs = -1;
    if (v) {
      const at = v.at, end = at + v.left * 1000;
      if (v.state === VOTE_RUNNING) {
        // (now is the frame's start, which can come before the datagram: never over the server's count)
        if (now < end + LOST_MS) secs = Math.max(1, Math.min(v.left, Math.ceil((end - now) / 1000)));
      } else if (now < at + RESULT_MS) secs = 0;
    }
    if (v === this.shown && secs === this.secs) return;
    this.shown = v;
    this.secs = secs;
    if (secs < 0) return this.clear();
    const what = QUESTION[v.issue] ? QUESTION[v.issue](v.detail) : 'Restart the match?';
    const lines = [`Vote: ${what}`, `called by ${this.names(v.caller) || `player${v.caller}`}`,
      `Yes ${v.yes} · No ${v.no} · ${v.needed} of ${v.voters} needed`];
    if (!secs) lines.push(v.state === VOTE_PASSED ? 'Vote passed' : 'Vote failed');
    else {
      lines.push(`${secs} s`);
      const key = (cmd, k) => (this.keyOf(cmd) || k).toUpperCase();
      if (v.mine === 1) lines.push(`${key('vote option1', 'f1')} Yes   ${key('vote option2', 'f2')} No`);
      else if (v.mine > 1) lines.push(`You voted ${v.mine === 2 ? 'yes' : 'no'}`);
    }
    if (lines.length !== this.rows.length) {
      this.rows = lines.map((_, i) => document.createElement(i ? 'div' : 'b'));
      this.el.replaceChildren(...this.rows);
      this.el.style.display = 'block';
    }
    for (let i = 0; i < lines.length; i++) if (this.rows[i].textContent !== lines[i]) this.rows[i].textContent = lines[i];
  }

  clear() {
    this.secs = -1;
    if (!this.rows.length) return;
    this.rows = [];
    this.el.style.display = 'none';
    this.el.replaceChildren();
  }
}
