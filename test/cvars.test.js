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

Deno.test('unknown commands go to the unknown hook first (a practice server takes them)', () => {
  const out = [], taken = [];
  const con = new Console((s) => out.push(s));
  con.exec('mp_respawn_immunitytime 2');
  assert.deepEqual(out, ['Unknown command "mp_respawn_immunitytime"']);
  con.unknown = (args) => {
    if (!args[0].startsWith('mp_')) return false;
    taken.push(args.join(' '));
    return true;
  };
  con.exec('mp_respawn_immunitytime 2; nonsense');
  assert.deepEqual(taken, ['mp_respawn_immunitytime 2']);
  assert.equal(out.at(-1), 'Unknown command "nonsense"');
});

Deno.test('suggest: names by prefix then substring, with values and help', () => {
  const { con } = make();
  con.cvar('sensitivity', 2.5, { help: 'Mouse sensitivity' });
  con.cvar('m_sensitivity_x', 1);
  con.cvar('rcon_password', 'secret', { flags: FCVAR_PROTECTED });
  con.command('say', () => {}, 'say <text>');
  const s = con.suggest('sens');
  assert.equal(s.start, 0);
  assert.deepEqual(s.items.map((i) => i.text), ['sensitivity', 'm_sensitivity_x'], 'prefix first, then contains');
  assert.deepEqual(s.items[0], { text: 'sensitivity', value: '2.5', help: 'Mouse sensitivity' });
  assert.equal(con.suggest('rcon_p').items[0].value, '***', 'protected values hidden');
  assert.deepEqual(con.suggest('').items, [], 'nothing typed: no list');
  assert.deepEqual(con.suggest('s').items.map((i) => i.text), ['say', 'sensitivity'], 'one letter: prefix only');
  assert.equal(con.suggest('echo hi; sen').start, 9, 'the last command of the line');
  assert.equal(con.suggest('sens', 1).items.length, 1, 'capped');
});

Deno.test('suggest: arguments from hints, cvar values, prefixes and remote names', () => {
  const { con } = make();
  con.cvar('cl_drawhud', 1, { min: 0, max: 1 });
  con.cvar('fov', 90, { min: 60, max: 120 });
  con.command('jointeam', () => {});
  con.hint('jointeam', [['1', 'Spectators'], ['2', 'Terrorists'], ['3', 'Counter-Terrorists']]);
  con.command('pick', () => {});
  con.hint('pick', (i, args) => (i === 1 ? ['alpha', 'beta'] : i === 2 ? [`after_${args[1]}`] : []));
  const team = con.suggest('jointeam ');
  assert.equal(team.start, 9);
  assert.deepEqual(team.items.map((i) => [i.text, i.help]), [['1', 'Spectators'], ['2', 'Terrorists'], ['3', 'Counter-Terrorists']]);
  assert.deepEqual(con.suggest('jointeam 2').items.map((i) => i.text), ['2'], 'filtered by what is typed');
  assert.deepEqual(con.suggest('pick b').items.map((i) => i.text), ['beta']);
  assert.deepEqual(con.suggest('pick beta ').items.map((i) => i.text), ['after_beta'], 'later arguments see earlier ones');
  assert.deepEqual(con.suggest('cl_drawhud ').items.map((i) => i.text), ['0', '1'], 'a switch: 0 / 1');
  con.get('fov').set(100);
  assert.deepEqual(con.suggest('fov ').items.map((i) => [i.text, i.help]), [['100', 'current'], ['90', 'default']]);
  assert.deepEqual(con.suggest('help cl_d').items.map((i) => i.text), ['cl_drawhud'], 'help takes names');
  con.prefixes.add('rcon');
  con.remote = new Map([['bot_add', { help: 'adds a bot', value: null, hint: ['t', 'ct'] }],
    ['mp_freezetime', { help: 'Freeze', value: '15', hint: null }]]);
  assert.deepEqual(con.suggest('rcon bot').items.map((i) => [i.text, i.help]), [['bot_add', 'adds a bot']]);
  assert.deepEqual(con.suggest('rcon bot_add ').items.map((i) => i.text), ['t', 'ct'], 'remote hints');
  assert.deepEqual(con.suggest('mp_freezetime ').items.map((i) => [i.text, i.help]), [['15', 'current']]);
  assert.equal(con.suggest('mp_fr').items[0].value, '15', 'remote values');
});

Deno.test('catalog: names, help, values and hints for another console', () => {
  const { con } = make();
  con.cvar('bot_quota', 3, { help: 'Bots' });
  con.cvar('rcon_password', 'x', { flags: FCVAR_PROTECTED });
  con.command('map', () => {}, 'map <name>');
  con.hint('map', (i) => (i === 1 ? ['de_dust2'] : []));
  const cat = new Map(con.catalog().map(([n, ...rest]) => [n, rest]));
  assert.deepEqual(cat.get('bot_quota'), ['Bots', '3', null]);
  assert.deepEqual(cat.get('map'), ['map <name>', null, ['de_dust2']]);
  assert.equal(cat.get('rcon_password')[1], null, 'protected values stay out');
});
