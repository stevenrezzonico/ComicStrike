// The saved config: one saved before the defaults changed takes them once; a newer one keeps its own.
import assert from 'node:assert/strict';
import { createConsole } from '../client/settings.js';

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
    const n = importConfig('// a config\nsensitivity "4"; alias evil "quit"\nbind "k" "+jump"\nrcon_password secret\nviewmodel_roll 12');
    assert.equal(n, 3);
    assert.equal(cv.sensitivity.number, 4);
    assert.equal(binds.get('k'), '+jump');
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
