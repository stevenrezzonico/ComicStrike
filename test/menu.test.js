// The start menu's practice options and its room answers.
import assert from 'node:assert';
import { botOptions, Menu } from '../client/menu.js';

Deno.test('bot options follow the mode: wingman 2 a side, free for all by players, demo targets', () => {
  const quotas = (mode) => botOptions(mode)[1].map(([v]) => v);
  assert.deepEqual(quotas('competitive'), [0, 2, 4, 6, 10]);
  assert.deepEqual(quotas('wingman'), [0, 2, 4], 'mp_teamsize_max 2');
  assert.deepEqual(quotas('deathmatch'), [0, 2, 4, 6, 10]);
  assert.equal(botOptions('deathmatch')[1][1][1], '2 players');
  assert.equal(botOptions('demo')[0], 'Targets');
  for (const mode of ['competitive', 'casual', 'wingman', 'deathmatch', 'armsrace', 'demolition', 'demo']) {
    assert.equal(botOptions(mode)[1][0][0], 0, `${mode}: None first`);
  }
});

Deno.test("a room picked while the last one's answer is on its way shows its own line, not the last one's", async () => {
  // The Menu without its page: only what fetchServer reads.
  const menu = Object.create(Menu.prototype);
  Object.assign(menu, { room: 'aaaaaa', root: { classList: { contains: () => false } }, maps: null });
  const pending = []; // [url, resolve]
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => new Promise((resolve) => pending.push([url, resolve]));
  const answer = (url, body) => {
    for (const [u, resolve] of pending) if (u === url) resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  try {
    const first = menu.fetchServer();
    menu.room = 'bbbbbb';
    const second = menu.fetchServer();
    answer('/maps.json', []);
    answer('/rooms.json', { rooms: [], live: 2, max: 8 });
    // The second room's answer comes first, the first room's after it.
    answer('/connect.json?room=bbbbbb', { map: 'de_b' });
    await second;
    answer('/connect.json?room=aaaaaa', { map: 'de_a' });
    await first;
    assert.equal(menu.roomInfo.map, 'de_b');
    assert.equal(menu.roomGone, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
