// The game modes (CS:GO's game_type / game_mode), one row each: what the server (the cfg it
// runs, its rules), the clients (what the round block's mode bit means) and the menus know of
// a mode. A new mode is a row here, its cfg/gamemode_<name>.cfg and whatever new rules it
// brings in server/game.js.
//
// name: the cfg's and the Host's; key: game_type/game_mode; label: as the menus show it;
// rule: its flag in the game rules (server/host.js rules()); bit: in the round block (none:
// it plays as competitive); respawns: the dead come back (no bot to take over); free: buying
// costs nothing (no money); earned: weapons are handed out, no buying (no money); ladder: the
// gun game's weapon list; oneSite: one bomb site (B).
import { GAME_DM, GAME_DEMO, GAME_ARMSRACE, GAME_DEMOLITION, GAME_WINGMAN, GAME_RETAKES } from './economy.js';
import { ARMS_RACE, DEMOLITION } from './progression.js';

const row = (name, key, label, rule, bit, facts = {}) => ({
  name, key, label, rule, bit, respawns: false, free: false, earned: false, ladder: null, oneSite: false, ...facts,
});

// In the menus' order.
export const MODES = [
  row('casual', '0/0', 'Casual', '', 0),
  row('competitive', '0/1', 'Competitive', '', 0),
  row('wingman', '0/2', 'Wingman', 'wingman', GAME_WINGMAN, { oneSite: true }),
  row('deathmatch', '1/2', 'Deathmatch', 'deathmatch', GAME_DM, { respawns: true, free: true }),
  row('armsrace', '1/0', 'Arms Race', 'armsRace', GAME_ARMSRACE, { respawns: true, earned: true, ladder: ARMS_RACE }),
  row('demolition', '1/1', 'Demolition', 'demolition', GAME_DEMOLITION, { earned: true, ladder: DEMOLITION }),
  row('retakes', '0/3', 'Retakes', 'retakes', GAME_RETAKES, { earned: true }),
  row('demo', '2/0', 'Demo', 'demo', GAME_DEMO, { respawns: true, free: true }),
];
const COMPETITIVE = MODES[1];

// (Index loops, no closures: the client asks every frame.)
export function modeNamed(name) {
  for (let i = 0; i < MODES.length; i++) if (MODES[i].name === name) return MODES[i];
  return COMPETITIVE;
}

// The mode a round block's bits say (casual and competitive alike: no bit).
export function modeOfBits(bits) {
  for (let i = 0; i < MODES.length; i++) if (MODES[i].bit & bits) return MODES[i];
  return COMPETITIVE;
}

// The mode game rules say (server/game.js; tests set a rule flag alone).
export function modeOfRules(rules) {
  for (let i = 0; i < MODES.length; i++) if (MODES[i].rule && rules[MODES[i].rule]) return MODES[i];
  return COMPETITIVE;
}
