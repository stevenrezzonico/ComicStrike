// CS:GO rounds and economy: competitive timings, money rules, the buy menu and buy
// zones. Shared so the server enforces exactly what the client's buy menu shows.

import { entityModelIndex, parseVec3 } from './bsp.js';
import { WEAPONS, WEAPON_ID, giveWeapon, WS_SLOTS } from './weapons.js';
import { TEAM_T, TEAM_CT } from './player.js';

// Round phases.
export const PHASE_WARMUP = 0; // waiting for both teams: free respawns
export const PHASE_FREEZE = 1; // round start: cannot move or shoot, can buy
export const PHASE_LIVE = 2;
export const PHASE_OVER = 3; // round decided: mp_round_restart_delay

// Competitive convars (seconds unless noted).
export const FREEZE_TIME = 15; // mp_freezetime
export const ROUND_TIME = 115; // mp_roundtime_defuse 1:55
export const BUY_TIME = 20; // mp_buytime, counted from the end of the freeze
export const ROUND_END_DELAY = 7; // mp_round_restart_delay
export const MAX_ROUNDS = 30; // mp_maxrounds: halftime after 15, first to 16 wins
export const WARMUP_RESPAWN = 2;

export const START_MONEY = 800; // mp_startmoney
export const MAX_MONEY = 16000; // mp_maxmoney
export const WIN_REWARD = 3250; // elimination / time
export const BOMB_WIN_REWARD = 3500; // target bombed / bomb defused
export const PLANT_REWARD = 300; // to the planter
export const DEFUSE_REWARD = 300; // to the defuser
export const PLANT_LOSS_BONUS = 800; // to every T when they plant and still lose
export const LOSS_BONUS = 1400; // first loss, +500 per further consecutive loss
export const LOSS_BONUS_STEP = 500;
export const LOSS_STREAK_MAX = 4; // 1400 .. 3400
export const TEAMKILL_PENALTY = 300;

// Why a round ended (snapshot `roundInfo` >> 2).
export const END_ELIMINATION = 1;
export const END_TIME = 2;
export const END_DRAW = 3;
export const END_BOMB = 4; // target bombed
export const END_DEFUSE = 5;

export const lossBonus = (streak) => LOSS_BONUS + LOSS_BONUS_STEP * Math.min(Math.max(streak - 1, 0), LOSS_STREAK_MAX);

// --- Buying -------------------------------------------------------------------

export const ITEM_KEVLAR = 100;
export const ITEM_ASSAULTSUIT = 101;
export const ITEM_DEFUSER = 102;
export const GEAR = {
  [ITEM_KEVLAR]: { label: 'Kevlar Vest', price: 650 },
  [ITEM_ASSAULTSUIT]: { label: 'Kevlar + Helmet', price: 1000 },
  [ITEM_DEFUSER]: { label: 'Defuse Kit', price: 400 },
};
const HELMET_ONLY = 350; // assault suit with a full vest already on

const ids = (...names) => names.map((n) => WEAPON_ID[n]);
export const BUY_MENU = [
  ['Pistols', ids('glock', 'hkp2000', 'usp_silencer', 'p250', 'elite', 'fiveseven', 'tec9', 'cz75a', 'deagle',
    'revolver')],
  ['Heavy', ids('nova', 'xm1014', 'sawedoff', 'mag7', 'm249', 'negev')],
  ['SMGs', ids('mac10', 'mp9', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon')],
  ['Rifles', ids('galilar', 'famas', 'ak47', 'm4a1', 'm4a1_silencer', 'ssg08', 'sg556', 'aug', 'awp', 'g3sg1',
    'scar20')],
  ['Gear', [ITEM_KEVLAR, ITEM_ASSAULTSUIT, ITEM_DEFUSER]],
];

export function itemLabel(item) {
  return GEAR[item] ? GEAR[item].label : WEAPONS[item] ? WEAPONS[item].label : '?';
}

// Price for this player right now (helmet-only upgrade), or -1 if not for sale to them.
export function itemPrice(p, item) {
  if (item === ITEM_ASSAULTSUIT) return p.armor >= 100 ? (p.helmet ? -1 : HELMET_ONLY) : GEAR[item].price;
  if (item === ITEM_KEVLAR) return p.armor >= 100 ? -1 : GEAR[item].price;
  if (item === ITEM_DEFUSER) return p.team !== TEAM_CT || p.defuser ? -1 : GEAR[item].price;
  const w = WEAPONS[item];
  if (!w || !w.gun || !(w.teams & (p.team === TEAM_CT ? 2 : 1))) return -1;
  if (p.ws.f[WS_SLOTS + w.slot * 3] === item) return -1; // already have it
  return w.price;
}

// Why `p` cannot buy `item` now ('' = it can). `canBuyNow`: in a buy zone in buy time.
export function buyError(p, item, canBuyNow) {
  if (!canBuyNow) return 'not in a buy zone or out of buy time';
  if (p.health <= 0) return 'dead';
  const price = itemPrice(p, item);
  if (price < 0) return 'not available';
  if (price > p.money) return 'not enough money';
  return '';
}

// Buys `item` (checked with buyError first). A weapon replaces the one in its slot.
export function applyBuy(p, item) {
  p.money -= itemPrice(p, item);
  if (item === ITEM_KEVLAR || item === ITEM_ASSAULTSUIT) {
    p.armor = 100;
    if (item === ITEM_ASSAULTSUIT) p.helmet = true;
  } else if (item === ITEM_DEFUSER) {
    p.defuser = true;
  } else {
    giveWeapon(p.ws, item);
  }
}

// --- Buy zones ----------------------------------------------------------------

const SPAWN_ZONE_RADIUS = 400; // maps without func_buyzone: around the team's spawns

export class BuyZones {
  constructor(bsp) {
    this.zones = []; // [minx, miny, minz, maxx, maxy, maxz, teamMask]
    const o = new Float32Array(3);
    for (const e of bsp.entities) {
      if (e.classname !== 'func_buyzone') continue;
      const m = entityModelIndex(e);
      if (m <= 0) continue;
      parseVec3(e.origin, o);
      const team = +(e.team || 0); // 0 both, 1 T, 2 CT
      const f = bsp.modelsF;
      this.zones.push([f[m * 16] + o[0], f[m * 16 + 1] + o[1], f[m * 16 + 2] + o[2], f[m * 16 + 3] + o[0],
        f[m * 16 + 4] + o[1], f[m * 16 + 5] + o[2], team === 1 ? 1 : team === 2 ? 2 : 3]);
    }
    if (this.zones.length) return;
    const r = SPAWN_ZONE_RADIUS;
    for (const e of bsp.entities) {
      const team = e.classname === 'info_player_deathmatch' ? 1 : e.classname === 'info_player_start' ? 2 : 0;
      if (!team) continue;
      parseVec3(e.origin, o);
      this.zones.push([o[0] - r, o[1] - r, o[2] - r, o[0] + r, o[1] + r, o[2] + r, team]);
    }
  }

  contains(team, x, y, z) {
    const bit = team === TEAM_CT ? 2 : team === TEAM_T ? 1 : 0;
    for (const b of this.zones) {
      if ((b[6] & bit) && x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]) return true;
    }
    return false;
  }
}
