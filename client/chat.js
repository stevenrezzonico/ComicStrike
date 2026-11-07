// Text chat: the lines the server delivers (S2C_CHAT) in a box over the HUD, and the line
// typed into (messagemode Y to everyone, messagemode2 U to the team), sent as a `say` /
// `say_team` console command to the server. CS:GO's prefixes: *DEAD* for a dead sender,
// *SPEC* for a spectator, (Terrorist) / (Counter-Terrorist) on team chat. Every piece of
// text goes in as textContent: names and lines never become markup.

import { CHAT_CONSOLE, CHAT_TEAM, CHAT_DEAD, CHAT_SPEC, CHAT_RADIO, CHAT_MAP, CHAT_MAX } from '../shared/protocol.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';

const CHAT_LINES = 8; // lines kept in the box
const TEAM_LABEL = { [TEAM_T]: '(Terrorist)', [TEAM_CT]: '(Counter-Terrorist)' };

export class Chat {
  // send(text, team): hands the line to the server; names(id) / teams(id) from the roster.
  constructor(box, line, send, names, teams) {
    this.box = box;
    this.line = line;
    this.send = send;
    this.names = names;
    this.teams = teams;
    this.isOpen = false;
    this.team = false;
    this.onToggle = () => {}; // (open) => void
    this.label = document.createElement('span');
    this.input = document.createElement('input');
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.maxLength = CHAT_MAX;
    line.append(this.label, this.input);
    this.input.addEventListener('keydown', (e) => this.key(e));
  }

  // A line to show: sender a player id or CHAT_CONSOLE, flags as the server sent them.
  add(sender, flags, text) {
    const row = document.createElement('div');
    const name = document.createElement('b');
    const team = this.teams(sender);
    if (sender === CHAT_CONSOLE) {
      name.textContent = 'Console';
      name.className = 'console';
    } else {
      let prefix = '';
      if (flags & CHAT_SPEC) prefix = '*SPEC* ';
      else if (flags & CHAT_DEAD) prefix = '*DEAD* ';
      if (flags & CHAT_RADIO) prefix += '(Radio) ';
      else if (flags & CHAT_TEAM) prefix += `${(flags & CHAT_SPEC) ? '(Spectator)' : TEAM_LABEL[team] || ''} `;
      name.textContent = prefix + (this.names(sender) || `player${sender}`);
      name.className = (flags & CHAT_SPEC) ? 'spec' : team === TEAM_CT ? 'ct' : team === TEAM_T ? 't' : 'spec';
    }
    if (flags & CHAT_MAP) row.append(text); // the map's own text (game_text): no name
    else row.append(name, ` : ${text}`);
    this.box.appendChild(row);
    while (this.box.children.length > CHAT_LINES) this.box.firstChild.remove();
    row.addEventListener('animationend', () => row.remove()); // its 12 s fade (chatfade in index.html), held while typing
  }

  open(team) {
    this.team = team;
    this.label.textContent = team ? 'Say (team):' : 'Say:';
    if (!this.isOpen) {
      this.isOpen = true;
      this.line.style.display = 'flex';
      this.box.classList.add('typing');
      this.onToggle(true);
    }
    this.input.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.input.value = '';
    this.input.blur();
    this.line.style.display = 'none';
    this.box.classList.remove('typing');
    this.onToggle(false);
  }

  clear() {
    this.box.replaceChildren();
    this.close();
  }

  key(e) {
    e.stopPropagation(); // the game never sees typing
    const code = e.code || e.key;
    if (code === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      e.preventDefault();
      const text = this.input.value.trim();
      if (text) this.send(text, this.team);
      this.close();
    }
  }
}
