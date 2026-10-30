// The developer console window (` key): scrolling output, a command line with history
// and suggestions as you type (shared/cvars.js Console.suggest: command names with their
// value and help, then each command's arguments). Runs commands on a shared Console.
// The window moves by its title bar and resizes from its corner; where it was is kept in
// localStorage (a convenience: the console works the same without it).

const MAX_LINES = 400;
const HISTORY = 50;
const MIN_W = 320, MIN_H = 160;
const GEOMETRY_KEY = 'comicstrike.console';

export class ConsoleWindow {
  constructor(con) {
    this.con = con;
    this.isOpen = false;
    this.history = [];
    this.historyPos = 0;
    this.onToggle = () => {}; // (open) => void
    this.items = []; // the suggestions shown
    this.start = 0; // where the token they replace begins
    this.sel = -1; // the highlighted one, -1 none
    this.geometry = null; // { x, y, w, h } once moved or resized

    const div = (cls, parent) => {
      const d = document.createElement('div');
      d.className = cls;
      if (parent) parent.appendChild(d);
      return d;
    };
    this.el = document.createElement('div');
    this.el.id = 'console';
    const bar = div('bar', this.el);
    div('title', bar).textContent = 'Console';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close (` or Escape)';
    close.addEventListener('click', () => this.toggle(false));
    bar.appendChild(close);
    this.out = div('out', this.el);
    const line = div('line', this.el);
    this.input = document.createElement('input');
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    line.appendChild(this.input);
    this.list = div('suggest', line);
    const grip = div('grip', this.el);
    grip.title = 'Resize';
    document.body.appendChild(this.el);

    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('input', () => this.refresh());
    // A click on a suggestion takes it; mousedown would take the focus from the input.
    this.list.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = e.target.closest('.item');
      if (row) this.accept(+row.dataset.i);
    });
    this.drag(bar, (g, dx, dy) => ({ ...g, x: g.x + dx, y: g.y + dy }));
    this.drag(grip, (g, dx, dy) => ({ ...g, w: g.w + dx, h: g.h + dy }));
    addEventListener('resize', () => {
      if (this.geometry) this.place(this.geometry);
    });
    try {
      const saved = JSON.parse(localStorage.getItem(GEOMETRY_KEY) || 'null');
      if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) this.geometry = saved;
    } catch { /* no storage: the default place */ }
  }

  // Dragging `handle` changes the geometry by `apply(start, dx, dy)`.
  drag(handle, apply) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const r = this.el.getBoundingClientRect();
      const from = { x: r.left, y: r.top, w: r.width, h: r.height };
      const x0 = e.clientX, y0 = e.clientY;
      const move = (m) => this.place(apply(from, m.clientX - x0, m.clientY - y0));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        try {
          localStorage.setItem(GEOMETRY_KEY, JSON.stringify(this.geometry));
        } catch { /* not kept */ }
        this.input.focus();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // Puts the window at `g`, kept inside the page (its bar always reachable).
  place(g) {
    const vw = innerWidth, vh = innerHeight;
    const w = Math.round(Math.min(Math.max(g.w, Math.min(MIN_W, vw)), vw));
    const h = Math.round(Math.min(Math.max(g.h, Math.min(MIN_H, vh)), vh));
    const x = Math.round(Math.min(Math.max(g.x, 0), vw - w));
    const y = Math.round(Math.min(Math.max(g.y, 0), vh - h));
    this.geometry = { x, y, w, h };
    const s = this.el.style;
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.width = `${w}px`;
    s.height = `${h}px`;
    this.el.classList.add('moved');
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
      if (this.geometry) this.place(this.geometry);
      this.input.focus();
      this.out.scrollTop = this.out.scrollHeight;
      this.refresh();
    } else {
      this.input.blur();
      this.show([]);
    }
    this.onToggle(open);
  }

  key(e) {
    e.stopPropagation(); // the game never sees typing
    const code = e.code || e.key; // virtual keyboards send no code; their key names match these
    const listed = this.items.length > 0;
    if (code === 'Escape' && listed) {
      e.preventDefault();
      this.show([]);
    } else if (code === 'Backquote' || code === 'Escape' || code === '`') {
      e.preventDefault();
      this.toggle(false);
    } else if ((code === 'Enter' || code === 'NumpadEnter') && this.sel >= 0) {
      e.preventDefault();
      this.accept(this.sel);
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      const line = this.input.value.trim();
      this.input.value = '';
      this.show([]);
      if (!line) return;
      this.print(`] ${line}`, 'echo');
      if (this.history.at(-1) !== line) this.history.push(line);
      if (this.history.length > HISTORY) this.history.shift();
      this.historyPos = this.history.length;
      this.con.exec(line, { source: 'console' });
    } else if ((code === 'ArrowUp' || code === 'ArrowDown') && listed && this.input.value) {
      // With suggestions shown, the arrows walk them (history: an empty line, or Escape first).
      e.preventDefault();
      const n = this.items.length;
      this.sel = code === 'ArrowDown' ? (this.sel + 1) % n : (this.sel <= 0 ? n : this.sel) - 1;
      this.highlight();
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      e.preventDefault();
      this.historyPos = Math.min(Math.max(this.historyPos + (code === 'ArrowUp' ? -1 : 1), 0), this.history.length);
      this.input.value = this.history[this.historyPos] ?? '';
      this.show([]);
    } else if (code === 'Tab') {
      e.preventDefault();
      this.complete();
    }
  }

  // The suggestions for the line as typed.
  refresh() {
    const { start, items } = this.con.suggest(this.input.value);
    this.start = start;
    this.show(items);
  }

  // Tab: takes the highlighted suggestion, else the only one, else completes to what all
  // of them share.
  complete() {
    if (!this.items.length) this.refresh();
    const items = this.items;
    if (!items.length) return;
    if (this.sel >= 0 || items.length === 1) return this.accept(Math.max(this.sel, 0));
    const typed = this.input.value.slice(this.start).toLowerCase();
    let p = items[0].text.toLowerCase();
    for (const it of items) while (!it.text.toLowerCase().startsWith(p)) p = p.slice(0, -1);
    if (p.length > typed.length) {
      this.input.value = this.input.value.slice(0, this.start) + p;
      this.refresh();
    }
  }

  // Puts suggestion i in place of the token being typed, then shows what may follow.
  accept(i) {
    const it = this.items[i];
    if (!it) return;
    const text = /[\s;"]/.test(it.text) ? `"${it.text}"` : it.text;
    this.input.value = `${this.input.value.slice(0, this.start)}${text} `;
    this.input.focus();
    this.refresh();
  }

  show(items) {
    this.items = items;
    this.sel = -1;
    this.list.replaceChildren();
    this.list.style.display = items.length ? 'block' : 'none';
    // Under the line, or over it when the window sits low on the page.
    if (items.length) this.list.classList.toggle('up', this.input.getBoundingClientRect().bottom + 260 > innerHeight);
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'item';
      row.dataset.i = i;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = it.text;
      row.appendChild(name);
      if (it.value !== '') {
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = it.value;
        row.appendChild(value);
      }
      if (it.help) {
        const help = document.createElement('span');
        help.className = 'help';
        help.textContent = it.help;
        row.appendChild(help);
      }
      this.list.appendChild(row);
    });
  }

  highlight() {
    [...this.list.children].forEach((row, i) => row.classList.toggle('sel', i === this.sel));
    if (this.sel >= 0) this.list.children[this.sel].scrollIntoView({ block: 'nearest' });
  }
}
