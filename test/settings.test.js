// The saved config: one saved before the defaults changed takes them once; a newer one keeps its own.
import assert from 'node:assert/strict';
import { createConsole } from '../client/settings.js';
import { parse } from '../shared/cvars.js';

function withStorage(items, fn) {
  const real = globalThis.localStorage;
  const store = new Map(Object.entries(items));
  const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    return fn(store);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true });
  }
}

Deno.test('settings: an old config takes the changed defaults once, a new one keeps its values', () => {
  const old = '// ComicStrike config (host_writeconfig)\nr_halftone "1"\nr_crosshair_clearzone "1"\nr_dynres "1"\nsensitivity "3"';
  withStorage({ 'comicstrike.config.cfg': old }, (store) => {
    const { cv } = createConsole(() => {});
    assert.equal(cv.r_halftone.number, 0);
    assert.equal(cv.r_crosshair_clearzone.number, 0);
    assert.equal(cv.r_dynres.number, 0);
    assert.equal(cv.sensitivity.number, 3); // the rest kept
    const saved = store.get('comicstrike.config.cfg');
    assert.ok(saved.includes('r_halftone "0"'), 'written back at once');
    // Chosen again after the change: kept from then on.
    const again = saved.replace('r_halftone "0"', 'r_halftone "1"');
    store.set('comicstrike.config.cfg', again);
    assert.equal(createConsole(() => {}).cv.r_halftone.number, 1);
  });
});

Deno.test('settings: an imported file runs its settings and binds only', () => {
  withStorage({}, () => {
    const { cv, binds, con, importConfig, configText } = createConsole(() => {});
    // The game's commands, which main.js registers at load: those the default binds run.
    for (const text of binds.map.values()) for (const [name] of parse(text)) if (!con.commands.has(name)) con.command(name, () => {});
    // And those that reach a server or leave the game (main.js registers them too).
    for (const name of ['say', 'say_team', 'callvote', 'map', 'disconnect', 'playback', 'record', 'retry']) con.command(name, () => {});
    const refused = ['say hi', 'callvote kick bob', 'map de_dust2', 'disconnect', 'record x'];
    const n = importConfig(refused.map((t, i) => `bind "f${i + 5}" "${t}"
`).join('') +'// a config\nsensitivity "4"; alias evil "quit"\nbind "k" "+jump"\nrcon_password secret\nviewmodel_roll 12' +
      '\nbind "m" "+jump; demo_delete clutch"\nbind "r" "rcon kick bob"\nbind "u" "kick bob"\nbind "p" "rcon_password x"\nbind "t" "sensitivity 2"');
    assert.equal(n, 4);
    assert.equal(cv.sensitivity.number, 4);
    assert.equal(binds.get('k'), '+jump');
    assert.equal(binds.get('t'), 'sensitivity 2', 'a setting is fine');
    for (const [k, text] of [['m', 'demo_delete'], ['r', 'rcon kick'], ['u', 'kick bob'], ['p', 'rcon_password']]) {
      assert.ok(!(binds.get(k) || '').includes(text), `bind ${k}: runs what a file must not`);
    }
    refused.forEach((t, i) => assert.equal(binds.get(`f${i + 5}`), undefined, `bind f${i + 5} "${t}"`));
    assert.equal(cv.viewmodel_roll.number, 12);
    assert.equal(cv.rcon_password.value, '', 'not a saved setting');
    assert.ok(!con.aliases.has('evil'), 'other commands dropped');
    // An export taken back gives the same settings.
    const text = configText();
    cv.sensitivity.set(1);
    importConfig(text);
    assert.equal(cv.sensitivity.number, 4);
    assert.equal(configText(), text);
  });
});
