// The start menu's practice options.
import assert from 'node:assert';
import { botOptions } from '../client/menu.js';

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
