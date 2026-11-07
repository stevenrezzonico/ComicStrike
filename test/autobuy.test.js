// CS's autobuy and rebuy (shared/economy.js buyPicks): what each buys of a list, by team,
// money and what is already held.
import assert from 'node:assert/strict';
import { Player, TEAM_T, TEAM_CT } from '../shared/player.js';
import { WEAPON_ID, giveWeapon } from '../shared/weapons.js';
import { buyPicks, ITEM_ASSAULTSUIT, ITEM_KEVLAR, ITEM_DEFUSER } from '../shared/economy.js';

const LIST = 'm4a1 ak47 famas galilar vesthelm vest defuser'.split(' ');
function player(team, money) {
  const p = new Player();
  p.team = team;
  p.money = money;
  giveWeapon(p.ws, WEAPON_ID.knife);
  giveWeapon(p.ws, team === TEAM_CT ? WEAPON_ID.usp_silencer : WEAPON_ID.glock);
  return p;
}

Deno.test('autobuy: the first of each kind the team buys and the money covers, in the list\'s order', () => {
  assert.deepEqual(buyPicks(player(TEAM_T, 5000), LIST, true, false, true), [WEAPON_ID.ak47, ITEM_ASSAULTSUIT]);
  assert.deepEqual(buyPicks(player(TEAM_CT, 5000), LIST, true, false, true), [WEAPON_ID.m4a1, ITEM_ASSAULTSUIT, ITEM_DEFUSER]);
  assert.deepEqual(buyPicks(player(TEAM_CT, 4000), LIST, true, false, true), [WEAPON_ID.m4a1, ITEM_KEVLAR],
    'after the rifle the helmet no longer fits, the vest does, the kit not');
  assert.deepEqual(buyPicks(player(TEAM_T, 2500), LIST, true, false, true), [WEAPON_ID.galilar, ITEM_KEVLAR],
    'no AK for $2500: the Galil, then a vest');
  assert.deepEqual(buyPicks(player(TEAM_T, 5000), LIST, false, false, true), [], 'out of buy time');
});

Deno.test('autobuy: a kind already held is skipped, the default pistol is not a held pistol', () => {
  const p = player(TEAM_T, 5000);
  giveWeapon(p.ws, WEAPON_ID.awp);
  assert.deepEqual(buyPicks(p, LIST, true, false, true), [ITEM_ASSAULTSUIT], 'an AWP in hand: no rifle');
  const q = player(TEAM_T, 5000);
  assert.deepEqual(buyPicks(q, ['deagle', 'p250'], true, false, true), [WEAPON_ID.deagle], 'over the Glock, one pistol');
  giveWeapon(q.ws, WEAPON_ID.deagle);
  assert.deepEqual(buyPicks(q, ['p250'], true, false, true), [], 'not over the Deagle');
});

Deno.test('rebuy: every item again while the money lasts; free in deathmatch', () => {
  const items = [WEAPON_ID.ak47, ITEM_ASSAULTSUIT, WEAPON_ID.hegrenade, WEAPON_ID.flashbang];
  assert.deepEqual(buyPicks(player(TEAM_T, 4200), items, true), items);
  assert.deepEqual(buyPicks(player(TEAM_T, 3500), items, true), [WEAPON_ID.ak47, WEAPON_ID.hegrenade, WEAPON_ID.flashbang],
    'the armor skipped, the cheaper grenades still bought');
  assert.deepEqual(buyPicks(player(TEAM_T, 0), items, true, true), items, 'free');
});
