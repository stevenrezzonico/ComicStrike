import assert from 'node:assert/strict';
import { Console, parse, releaseOf, FCVAR_ARCHIVE, FCVAR_PROTECTED } from '../shared/cvars.js';

function make() {
  const lines = [];
  const con = new Console((s) => lines.push(s));
  return { con, lines };
}

Deno.test('parser: quotes, semicolons, comments, newlines', () => {
  assert.deepEqual(parse('bind "w" "+forward"; echo hi there // comment\nsensitivity 2.5'), [
    ['bind', 'w', '+forward'],
    ['echo', 'hi', 'there'],
    ['sensitivity', '2.5'],
  ]);
  assert.deepEqual(parse('alias jt "+jump;-attack"'), [['alias', 'jt', '+jump;-attack']], 'quotes protect ;');
  assert.deepEqual(parse('say ""'), [['say', '']], 'an empty quoted token is a token');
  assert.deepEqual(parse('  ;; // nothing\n'), []);
  assert.deepEqual(parse('echo "unterminated\necho next'), [['echo', 'unterminated'], ['echo', 'next']]);
});

Deno.test('cvars: set, clamp, print, change callbacks, archive', () => {
  const { con, lines } = make();
  let changed = 0;
  const sens = con.cvar('sensitivity', 2.5, { flags: FCVAR_ARCHIVE, min: 0.0001, max: 1000, help: 'mouse', onChange: () => changed++ });
  con.cvar('rcon_password', '', { flags: FCVAR_PROTECTED });
  con.exec('sensitivity 1.8');
  assert.equal(sens.number, 1.8);
  assert.equal(changed, 1);
  con.exec('Sensitivity -5'); // names are case-insensitive
  assert.equal(sens.number, 0.0001, 'clamped to min');
  con.exec('sensitivity');
  assert.match(lines.at(-1), /"sensitivity" = "0.0001" \(def. "2.5"\) - mouse/);
  con.exec('rcon_password secret; rcon_password');
  assert.ok(!lines.at(-1).includes('secret'), 'protected values never print');
  assert.deepEqual(con.archive(), ['sensitivity "0.0001"']);
  con.exec('nonsense 1');
  assert.equal(lines.at(-1), 'Unknown command "nonsense"');
});

Deno.test('commands, aliases (with recursion guard), toggle, incrementvar', () => {
  const { con, lines } = make();
  const got = [];
  con.command('+jump', (a) => got.push(a.join(' ')));
  con.command('-jump', (a) => got.push(a.join(' ')));
  con.exec('alias +jt "+jump; echo up"; alias -jt "-jump"; +jt; -jt');
  assert.deepEqual(got, ['+jump', '-jump']);
  assert.equal(lines.at(-1), 'up');
  con.exec('alias loop "loop"; loop');
  assert.match(lines.at(-1), /alias recursion/);

  const cv = con.cvar('cl_showfps', 0);
  con.exec('toggle cl_showfps');
  assert.equal(cv.number, 1);
  con.exec('toggle cl_showfps');
  assert.equal(cv.number, 0);
  con.exec('toggle cl_showfps 0 1 2; toggle cl_showfps 0 1 2');
  assert.equal(cv.number, 2);
  con.exec('incrementvar cl_showfps 0 2 1');
  assert.equal(cv.number, 0, 'wraps past max');
});

Deno.test('command context, completion and find', () => {
  const { con } = make();
  let key = null;
  con.command('+attack', (_a, ctx) => {
    key = ctx.key;
  });
  con.exec('+attack', { key: 'mouse1' });
  assert.equal(key, 'mouse1');
  con.cvar('cl_crosshairsize', 5, { help: 'arm length' });
  con.cvar('cl_crosshairgap', 1);
  assert.deepEqual(con.complete('cl_crossh'), ['cl_crosshairgap', 'cl_crosshairsize']);
  const out = [];
  con.exec('find arm', { print: (s) => out.push(s) });
  assert.deepEqual(out, ['cl_crosshairsize - arm length']);
});

Deno.test('a + binding releases its + commands', () => {
  assert.equal(releaseOf('+forward'), '"-forward"');
  assert.equal(releaseOf('+jump; +duck; echo hi'), '"-jump";"-duck"');
  assert.equal(releaseOf('slot1'), '');
});
