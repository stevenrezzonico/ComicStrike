// The static file check (server/static.js): the served folders and files only, however
// the path is encoded.
import assert from 'node:assert/strict';
import { staticPath } from '../server/static.js';

const DIRS = ['client/', 'shared/', 'maps/'];
const FILES = new Set(['server/game.js', 'cfg/gamemode_competitive.cfg']);
const path = (p) => staticPath(new URL(p, 'http://h/').pathname, DIRS, FILES);

Deno.test('static: the page, its folders and the listed files are served', () => {
  assert.equal(path('/'), 'client/index.html');
  assert.equal(path('/client/gl/renderer.js'), 'client/gl/renderer.js');
  assert.equal(path('/maps/de_dust2.bsp'), 'maps/de_dust2.bsp');
  assert.equal(path('/server/game.js'), 'server/game.js');
  assert.equal(path('/cfg/gamemode_competitive.cfg'), 'cfg/gamemode_competitive.cfg');
  assert.equal(path('/client/gl%2Frenderer.js'), 'client/gl/renderer.js'); // an encoded name is the same file
});

Deno.test('static: nothing outside them, however the path is encoded', () => {
  for (const p of [
    '/server/main.js', '/server/cert.js', '/cfg/server.cfg', '/certs/key.pem', '/deno.json', '/clientx/a.js',
    '/client/gl%2F..%2F..%2Fcerts%2Fkey.pem', // %2F: Deno's file URLs decode it into a separator
    '/client/gl%2F%2E%2E%2F%2E%2E%2Fcerts%2Fkey.pem',
    '/client/x%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd',
    '/client/gl%5C..%5C..%5Ccerts%5Ckey.pem', // backslashes (Windows)
    '/client/gl%252F..%252F..%252Fcerts%252Fkey.pem', // double encoding
    '/client/gl/%2e%2e/%2e%2e/certs/key.pem',
    '/client/%00.js', '/client/%E0%A4%A.js', // NUL, a broken escape
    '/client//etc/passwd',
  ]) assert.equal(path(p), null, p);
  // Dot segments the URL parser would have removed, given raw.
  for (const p of ['/client/./gl/renderer.js', '/client/../certs/key.pem']) assert.equal(staticPath(p, DIRS, FILES), null, p);
});
