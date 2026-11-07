// When the comic jingles play (client/jingles.js JingleCues): the round going live, the
// bomb planted, the last 10 seconds of the round or the bomb, the round and the match over
// for our side, nothing more than once.
import assert from 'node:assert/strict';
import { JingleCues, TEN_TICKS } from '../client/jingles.js';
import { RoundState } from '../shared/protocol.js';
import { BombState, BOMB_PLANTED, BOMB_CARRIED } from '../shared/bomb.js';
import {
  PHASE_WARMUP, PHASE_FREEZE, PHASE_LIVE, PHASE_OVER, END_ELIMINATION, END_MATCH, END_DRAW, END_SURRENDER, ROUND_FINAL,
} from '../shared/economy.js';
import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';

function game(team = TEAM_CT) {
  const cues = new JingleCues(), rs = new RoundState(), bomb = new BombState();
  bomb.state = BOMB_CARRIED;
  const heard = [];
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      const j = cues.update(rs, bomb, team);
      if (j) heard.push(j);
      if (rs.ticksLeft > 0) rs.ticksLeft--;
      if (bomb.state === BOMB_PLANTED && bomb.ticksLeft > 0) bomb.ticksLeft--;
    }
  };
  const phase = (p, ticks = 0) => {
    rs.phase = p;
    rs.ticksLeft = ticks;
  };
  return { rs, bomb, heard, step, phase };
}

Deno.test('jingles: the round goes live, its last 10 seconds, our side wins', () => {
  const g = game(TEAM_CT);
  g.phase(PHASE_WARMUP);
  g.step(10);
  assert.deepEqual(g.heard, [], 'warmup: nothing');
  g.phase(PHASE_FREEZE, 64 * 15);
  g.rs.serial = 1;
  g.step(64 * 15);
  assert.deepEqual(g.heard, []);
  g.phase(PHASE_LIVE, TEN_TICKS + 64);
  g.step(1);
  assert.deepEqual(g.heard, ['start']);
  g.step(64 * 3);
  assert.deepEqual(g.heard, ['start', 'ten'], 'once, as the clock passes 10 s');
  g.phase(PHASE_OVER, 64 * 7);
  g.rs.info = TEAM_CT | (END_ELIMINATION << 2);
  g.step(64);
  assert.deepEqual(g.heard, ['start', 'ten', 'won']);
});

Deno.test('jingles: the bomb planted and its last 10 seconds; the other side loses', () => {
  const g = game(TEAM_T);
  g.phase(PHASE_LIVE, 64 * 100);
  g.step(5); // the baseline: no 'start' without the freeze before it
  assert.deepEqual(g.heard, []);
  g.bomb.state = BOMB_PLANTED;
  g.bomb.ticksLeft = 64 * 40;
  g.step(64 * 31);
  assert.deepEqual(g.heard, ['planted', 'ten']);
  // The round clock stops counting while the bomb ticks: no second 'ten' from it.
  g.phase(PHASE_OVER, 64 * 7);
  g.rs.info = TEAM_CT | (END_ELIMINATION << 2);
  g.step(5);
  assert.deepEqual(g.heard, ['planted', 'ten', 'lost']);
});

Deno.test('jingles: the match over, a draw, a spectator', () => {
  let g = game(TEAM_CT);
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.phase(PHASE_OVER, 64);
  g.rs.info = TEAM_CT | (END_ELIMINATION << 2) | ROUND_FINAL;
  g.rs.scoreCT = 16;
  g.step();
  assert.deepEqual(g.heard, ['match']);
  g = game(TEAM_T);
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.phase(PHASE_OVER, 64);
  g.rs.info = TEAM_CT | (END_ELIMINATION << 2) | ROUND_FINAL;
  g.rs.scoreCT = 16;
  g.step();
  assert.deepEqual(g.heard, ['lost'], 'the losers of the match get the lost cadence');
  g.rs.scoreT = 16; // (the same round's end, seen anew as a drawn match: nothing)
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.heard.length = 0;
  g.phase(PHASE_OVER, 64);
  g.step();
  assert.deepEqual(g.heard, [], 'a drawn match: no jingle');
  g.rs.info = TEAM_CT | (END_SURRENDER << 2) | ROUND_FINAL; // (the Ts surrendered at 15-16: the CTs' round ties it)
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.heard.length = 0;
  g.phase(PHASE_OVER, 64);
  g.step();
  assert.deepEqual(g.heard, ['lost'], 'a surrender that ties the score still has its winner');
  g = game(TEAM_T);
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.phase(PHASE_OVER, 64);
  g.rs.info = END_MATCH << 2; // deathmatch's time limit: no sides
  g.step();
  assert.deepEqual(g.heard, ['match']);
  g = game(TEAM_CT);
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.phase(PHASE_OVER, 64);
  g.rs.info = END_DRAW << 2;
  g.step();
  assert.deepEqual(g.heard, [], 'a draw: nothing');
  g = game(TEAM_SPECTATOR);
  g.phase(PHASE_LIVE, 640);
  g.step();
  g.phase(PHASE_OVER, 64);
  g.rs.info = TEAM_CT | (END_ELIMINATION << 2);
  g.step();
  assert.deepEqual(g.heard, [], 'a spectator: no side to cheer');
});

Deno.test('jingles: joining mid-round or after a reset plays nothing for what was already so', () => {
  const g = game(TEAM_CT);
  g.phase(PHASE_LIVE, 300);
  g.bomb.state = BOMB_PLANTED;
  g.bomb.ticksLeft = 300;
  g.step(); // the first snapshot: the baseline
  assert.deepEqual(g.heard, []);
  g.step(5);
  assert.deepEqual(g.heard, []);
});
