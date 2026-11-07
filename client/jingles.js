// When the comic jingles play (client/audio.js Sounds.jingle), from the round block and the
// bomb as the snapshots bring them: the round going live after the freeze ('start'), the
// bomb planted ('planted'), the last 10 seconds of the round clock or of the planted bomb's
// ('ten'), the round over ('won' / 'lost' for our side, nothing for a draw or a spectator)
// and the match over ('match' for the winners and in the modes with no sides, 'lost'
// otherwise). Pure: main.js feeds it every snapshot and plays what it returns.

import { PHASE_FREEZE, PHASE_LIVE, PHASE_OVER, END_MATCH, reasonOf, matchOver } from '../shared/economy.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { TICK_RATE } from '../shared/constants.js';
import { TEAM_T, TEAM_CT } from '../shared/player.js';

export const TEN_TICKS = 10 * TICK_RATE;

export class JingleCues {
  constructor() {
    this.reset();
  }

  // A new game or map: the next snapshot only sets the baseline.
  reset() {
    this.phase = -1;
    this.serial = -1;
    this.ticksLeft = 0;
    this.bombState = -1;
    this.bombTicks = 0;
  }

  // rs: RoundState; bomb: BombState; team: our team. Returns a jingle name or null.
  update(rs, bomb, team) {
    const first = this.phase < 0;
    const phaseWas = this.phase, ticksWas = this.ticksLeft, bombWas = this.bombState, bombTicksWas = this.bombTicks;
    const sameRound = rs.serial === this.serial;
    this.phase = rs.phase;
    this.serial = rs.serial;
    this.ticksLeft = rs.ticksLeft;
    this.bombState = bomb.state;
    this.bombTicks = bomb.ticksLeft;
    if (first) return null;
    if (rs.phase === PHASE_OVER && phaseWas !== PHASE_OVER) {
      const side = team === TEAM_T || team === TEAM_CT, winner = rs.info & 3;
      if (matchOver(rs.info)) {
        if (reasonOf(rs.info) === END_MATCH || !side) return 'match'; // no sides, or watching
        if (rs.scoreT === rs.scoreCT) return null; // a drawn match
        return winner === team ? 'match' : 'lost';
      }
      if (!side || !winner) return null;
      return winner === team ? 'won' : 'lost';
    }
    if (rs.phase === PHASE_LIVE && phaseWas === PHASE_FREEZE) return 'start';
    if (rs.phase !== PHASE_LIVE) return null;
    if (bomb.state === BOMB_PLANTED) {
      if (bombWas !== BOMB_PLANTED) return 'planted';
      if (bombTicksWas > TEN_TICKS && bomb.ticksLeft <= TEN_TICKS && bomb.ticksLeft > 0) return 'ten';
      return null;
    }
    if (sameRound && phaseWas === PHASE_LIVE && ticksWas > TEN_TICKS && rs.ticksLeft <= TEN_TICKS && rs.ticksLeft > 0) {
      return 'ten';
    }
    return null;
  }
}
