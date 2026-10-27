// Source-style console engine shared by the client console and the server console
// (rcon, cfg/server.cfg, stdin): console variables, commands, aliases and the command
// line parser (quotes, `;` separators, `//` comments).

export const FCVAR_ARCHIVE = 1; // saved to the config
export const FCVAR_PROTECTED = 2; // value never printed (passwords)

const MAX_ALIAS_DEPTH = 32; // alias recursion guard

export class Cvar {
  constructor(name, value, flags, help, min, max, onChange) {
    this.name = name;
    this.defaultValue = String(value);
    this.flags = flags;
    this.help = help;
    this.min = min;
    this.max = max;
    this.onChange = null;
    this.value = '';
    this.number = 0; // numeric value, read on hot paths
    this.set(value);
    this.onChange = onChange; // not for the default value
  }

  // Sets from a string or number; numbers clamp to [min, max] like Source's FCVAR bounds.
  set(v) {
    let s = String(v);
    let n = Number.parseFloat(s);
    if (Number.isFinite(n) && (this.min !== undefined || this.max !== undefined)) {
      if (this.min !== undefined && n < this.min) n = this.min;
      if (this.max !== undefined && n > this.max) n = this.max;
      if (String(n) !== s) s = String(n);
    }
    const old = this.value;
    this.value = s;
    this.number = Number.isFinite(n) ? n : 0;
    if (this.onChange && old !== s) this.onChange(this, old);
  }

  get bool() {
    return this.number !== 0;
  }
}

// Splits text into commands, each an array of tokens. `;` and newlines end a command
// (outside quotes); `//` starts a comment; quotes group a token.
export function parse(text) {
  const out = [];
  let tokens = [], tok = '', inTok = false, quoted = false;
  const endTok = () => {
    if (inTok) tokens.push(tok);
    tok = '';
    inTok = false;
  };
  const endCmd = () => {
    endTok();
    if (tokens.length) out.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') quoted = false;
      else if (c === '\n') { // an unterminated quote ends with the line
        quoted = false;
        endCmd();
      } else tok += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      inTok = true;
    } else if (c === ';' || c === '\n') {
      endCmd();
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      endCmd();
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endTok();
    } else {
      tok += c;
      inTok = true;
    }
  }
  endCmd();
  return out;
}

// Quotes a token for printing / saving when it needs it.
export const quote = (s) => `"${String(s).replaceAll('"', "'")}"`;

export class Console {
  // print(text): where output goes unless a call passes ctx.print.
  constructor(print = (s) => console.log(s)) {
    this.print = print;
    this.cvars = new Map();
    this.commands = new Map(); // name -> { fn(args, ctx), help }
    this.aliases = new Map();
    this.depth = 0;

    this.command('echo', (a, ctx) => this.out(ctx, a.slice(1).join(' ')), 'Prints its arguments');
    this.command('alias', (a, ctx) => {
      if (a.length < 2) {
        for (const [k, v] of this.aliases) this.out(ctx, `${k} : ${v}`);
      } else if (a.length === 2) {
        this.out(ctx, this.aliases.has(a[1].toLowerCase()) ? this.aliases.get(a[1].toLowerCase()) : 'no such alias');
      } else {
        this.aliases.set(a[1].toLowerCase(), a.slice(2).join(' '));
      }
    }, 'alias <name> "<commands>": a new command made of others');
    this.command('toggle', (a, ctx) => {
      const cv = this.cvars.get((a[1] || '').toLowerCase());
      if (!cv) return this.out(ctx, 'toggle <cvar> [value1 value2 ...]');
      const vals = a.length > 2 ? a.slice(2) : ['0', '1'];
      const i = vals.findIndex((v) => Number.parseFloat(v) === cv.number || v === cv.value);
      cv.set(vals[(i + 1) % vals.length] ?? vals[0]);
    }, 'toggle <cvar> [values...]: cycles a cvar (0/1 by default)');
    this.command('incrementvar', (a, ctx) => {
      const cv = this.cvars.get((a[1] || '').toLowerCase());
      if (!cv || a.length < 5) return this.out(ctx, 'incrementvar <cvar> <min> <max> <delta>');
      const lo = +a[2], hi = +a[3];
      let v = cv.number + +a[4];
      if (v > hi) v = lo;
      if (v < lo) v = hi;
      cv.set(v);
    }, 'incrementvar <cvar> <min> <max> <delta>: steps a cvar, wrapping around');
    this.command('find', (a, ctx) => {
      const q = (a[1] || '').toLowerCase();
      for (const name of this.names()) {
        const help = this.helpOf(name);
        if (name.includes(q) || help.toLowerCase().includes(q)) this.out(ctx, `${name}${help ? ` - ${help}` : ''}`);
      }
    }, 'find <text>: lists cvars and commands mentioning it');
    this.command('help', (a, ctx) => {
      const name = (a[1] || '').toLowerCase();
      if (!name) return this.out(ctx, 'help <cvar or command>; "find <text>" searches');
      if (this.cvars.has(name)) return this.describe(this.cvars.get(name), ctx);
      this.out(ctx, this.commands.has(name) ? `${name} - ${this.helpOf(name)}` : `no such cvar or command: ${name}`);
    }, 'help <name>: describes a cvar or command');
    this.command('cvarlist', (_a, ctx) => {
      for (const cv of [...this.cvars.values()].sort((x, y) => x.name.localeCompare(y.name))) {
        this.out(ctx, `${cv.name} = ${cv.flags & FCVAR_PROTECTED ? '***' : quote(cv.value)}`);
      }
    }, 'Lists every cvar and its value');
  }

  out(ctx, text) {
    ((ctx && ctx.print) || this.print)(text);
  }

  // Registers a cvar. opts: { flags, help, min, max, onChange(cvar, old) }.
  cvar(name, value, opts = {}) {
    const cv = new Cvar(name.toLowerCase(), value, opts.flags || 0, opts.help || '', opts.min, opts.max, opts.onChange);
    this.cvars.set(cv.name, cv);
    return cv;
  }

  // Registers a command: fn(args, ctx) with args[0] = its name.
  command(name, fn, help = '') {
    this.commands.set(name.toLowerCase(), { fn, help });
  }

  get(name) {
    return this.cvars.get(name.toLowerCase());
  }

  names() {
    return [...this.cvars.keys(), ...this.commands.keys(), ...this.aliases.keys()].sort();
  }

  helpOf(name) {
    return this.cvars.get(name)?.help || this.commands.get(name)?.help || '';
  }

  // Names starting with `prefix`, for tab completion.
  complete(prefix) {
    const p = prefix.toLowerCase();
    return this.names().filter((n) => n.startsWith(p));
  }

  describe(cv, ctx) {
    const v = cv.flags & FCVAR_PROTECTED ? '***' : quote(cv.value);
    this.out(ctx, `"${cv.name}" = ${v} (def. ${quote(cv.defaultValue)})${cv.help ? ` - ${cv.help}` : ''}`);
  }

  // Runs a command line. ctx: { print, key, source, ... } passed to every command.
  exec(text, ctx = {}) {
    for (const args of parse(text)) this.run(args, ctx);
  }

  run(args, ctx = {}) {
    const name = args[0].toLowerCase();
    const alias = this.aliases.get(name);
    if (alias !== undefined) {
      if (this.depth >= MAX_ALIAS_DEPTH) return this.out(ctx, `alias recursion: ${name}`);
      this.depth++;
      try {
        this.exec(alias, ctx);
      } finally {
        this.depth--;
      }
      return;
    }
    const cmd = this.commands.get(name);
    if (cmd) return cmd.fn(args, ctx);
    const cv = this.cvars.get(name);
    if (cv) {
      if (args.length < 2) this.describe(cv, ctx);
      else cv.set(args[1]);
      return;
    }
    this.out(ctx, `Unknown command "${args[0]}"`);
  }

  // `name "value"` lines for every archived cvar (the config file).
  archive() {
    const lines = [];
    for (const cv of this.cvars.values()) if (cv.flags & FCVAR_ARCHIVE) lines.push(`${cv.name} ${quote(cv.value)}`);
    return lines.sort();
  }
}

// The release text of a `+` binding: every command that starts with `+` becomes `-`
// (Source runs "-jump" when the key bound to "+jump" goes up). Others are dropped.
export function releaseOf(binding) {
  return parse(binding).filter((a) => a[0][0] === '+').map((a) => ['-' + a[0].slice(1), ...a.slice(1)].map(quote).join(' '))
    .join(';');
}
