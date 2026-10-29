// Weapon progressions of the gun game modes. Arms Race: every kill gives the next weapon at
// once, the knife last, and a kill with it wins the match; a knife kill also takes a level
// from the victim. Demolition: a round with a kill gives the next weapon for the next
// round. No buying in either. CS:GO's lists (gamemodes.txt) changed over the years; these
// follow their shape (approx.): Arms Race from SMGs through rifles, snipers, heavy guns
// and pistols to the knife, Demolition from rifles down to pistols. An entry is one weapon
// for both teams, or [CT, T] where CS:GO gave each side its own.

import {
  WEAPON_ID, WEAPONS, giveWeapon, equip, WS_SLOTS, WS_ACTIVE, WS_ALT, WS_GRENADES, GRENADE_IDS, SLOT_PRIMARY,
  SLOT_SECONDARY, SLOT_GRENADE, SLOT_KNIFE,
} from './weapons.js';

export const ARMS_RACE = [
  'mp7', 'p90', 'ump45', ['mp9', 'mac10'], 'bizon',
  ['m4a1', 'ak47'], ['famas', 'galilar'], ['aug', 'sg556'],
  'ssg08', 'awp',
  'nova', 'xm1014', 'negev',
  'deagle', ['fiveseven', 'tec9'], 'p250', ['hkp2000', 'glock'],
  'knife',
];

export const DEMOLITION = [
  ['m4a1', 'ak47'], ['famas', 'galilar'], 'ssg08', 'nova', 'mp7', 'p90',
  'deagle', ['fiveseven', 'tec9'], 'p250', ['hkp2000', 'glock'],
];

// The weapon id of `level` (clamped to the list) for a CT (`ct`) or a T.
export function levelWeapon(list, level, ct) {
  const e = list[Math.max(0, Math.min(level, list.length - 1))];
  return WEAPON_ID[typeof e === 'string' ? e : e[ct ? 0 : 1]];
}

// Arms a player for `level`: the knife and that level's weapon, in hand, and nothing else
// (other guns and grenades go; the C4 stays). `time` > 0 draws it then (after a kill);
// 0 has it ready (a spawn).
export function armLevel(ws, list, level, ct, time = 0) {
  const f = ws.f;
  for (const s of [SLOT_PRIMARY, SLOT_SECONDARY, SLOT_GRENADE]) {
    f[WS_SLOTS + s * 3] = f[WS_SLOTS + s * 3 + 1] = f[WS_SLOTS + s * 3 + 2] = 0;
    f[WS_ALT] = f[WS_ALT] & ~(1 << s);
  }
  f.fill(0, WS_GRENADES, WS_GRENADES + GRENADE_IDS.length);
  if (!f[WS_SLOTS + SLOT_KNIFE * 3]) giveWeapon(ws, WEAPON_ID.knife);
  const id = levelWeapon(list, level, ct);
  if (time > 0) equip(ws, id, time);
  else {
    giveWeapon(ws, id);
    f[WS_ACTIVE] = WEAPONS[id].slot;
  }
}
