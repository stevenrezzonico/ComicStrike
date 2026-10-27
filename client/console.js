// The developer console window (` key): scrolling output, a command line with history
// and tab completion. Runs commands on a shared Console (shared/cvars.js).

const MAX_LINES = 400;
const HISTORY = 50;

export class ConsoleWindow {
  constructor(con) {
    this.con = con;
    this.isOpen = false;
    this.history = [];
    this.historyPos = 0;
    this.onToggle = () => {}; // (open) => void

    this.el = document.createElement('div');
    this.el.id = 'console';
    this.out = document.createElement('div');
    this.out.className = 'out';
    this.input = document.createElement('input');
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.el.append(this.out, this.input);
    document.body.appendChild(this.el);

    this.input.addEventListener('keydown', (e) => this.key(e));
  }

  // One or more lines of output; `cls` styles them (err, echo).
  print(text, cls = '') {
    for (const line of String(text).split('\n')) {
      const div = document.createElement('div');
      div.textContent = line;
      if (cls) div.className = cls;
      this.out.appendChild(div);
    }
    while (this.out.childElementCount > MAX_LINES) this.out.firstChild.remove();
    this.out.scrollTop = this.out.scrollHeight;
  }

  clear() {
    this.out.replaceChildren();
  }

  toggle(open = !this.isOpen) {
    if (open === this.isOpen) return;
    this.isOpen = open;
    this.el.style.display = open ? 'flex' : 'none';
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.input.focus();
      this.out.scrollTop = this.out.scrollHeight;
    } else {
      this.input.blur();
    }
    this.onToggle(open);
  }

  key(e) {
    e.stopPropagation(); // the game never sees typing
    const code = e.code || e.key; // virtual keyboards send no code; their key names match these
    if (code === 'Backquote' || code === 'Escape' || code === '`') {
      e.preventDefault();
      this.toggle(false);
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      const line = this.input.value.trim();
      this.input.value = '';
      if (!line) return;
      this.print(`] ${line}`, 'echo');
      if (this.history.at(-1) !== line) this.history.push(line);
      if (this.history.length > HISTORY) this.history.shift();
      this.historyPos = this.history.length;
      this.con.exec(line, { source: 'console' });
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      e.preventDefault();
      this.historyPos = Math.min(Math.max(this.historyPos + (code === 'ArrowUp' ? -1 : 1), 0), this.history.length);
      this.input.value = this.history[this.historyPos] ?? '';
    } else if (code === 'Tab') {
      e.preventDefault();
      this.complete();
    }
  }

  // Completes the command word to the longest common prefix; lists the candidates.
  complete() {
    const v = this.input.value;
    if (!v || v.includes(' ')) return;
    const names = this.con.complete(v);
    if (!names.length) return;
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    this.input.value = names.length === 1 ? `${p} ` : p;
    if (names.length > 1) this.print(names.slice(0, 40).join('  '));
  }
}
