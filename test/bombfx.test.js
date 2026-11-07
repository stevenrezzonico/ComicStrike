// The C4's slow-motion explosion (client/bombfx.js): the kill ranges, the effects' clock, the
// front, the victims waiting for it, the camera's hit.
import assert from 'node:assert/strict';
import { bombDamage, bombRangeFor } from '../shared/bomb.js';
import { BombFx, fxRate, frontRadius, SLOW, HOLD, RAMP, WAVE, MARKS } from '../client/bombfx.js';
import { clock } from '../client/clock.js';
import { COMPOSITE_FS } from '../client/gl/shaders.js';

Deno.test('bombfx: bombRangeFor is bombDamage turned round', () => {
  for (const r of [300, 500, 650]) {
    for (const dmg of [r * 0.9, 200, 100, 30, 5]) {
      const d = bombRangeFor(r, dmg);
      if (dmg <= r * Math.exp(-4.5)) assert.equal(d, r * 3.5);
      else assert.ok(Math.abs(bombDamage(r, d) - dmg) < 1e-6, `${r} ${dmg}`);
    }
    assert.equal(bombRangeFor(r, r), 0);
    assert.equal(bombRangeFor(r, r * 2), 0);
  }
  // The default radius: kills ~790 units out through kevlar, ~1046 without, hurts to 1750.
  assert.ok(Math.abs(bombRangeFor(500, 200) - 790) < 2);
  assert.ok(Math.abs(bombRangeFor(500, 100) - 1046) < 2);
});

Deno.test('bombfx: the effects slow down, then come back to full speed', () => {
  assert.equal(fxRate(-1), 1);
  assert.equal(fxRate(NaN), 1);
  assert.equal(fxRate(0), SLOW);
  assert.equal(fxRate(HOLD - 0.01), SLOW);
  assert.ok(fxRate(HOLD + RAMP / 2) > SLOW && fxRate(HOLD + RAMP / 2) < 1);
  assert.equal(fxRate(HOLD + RAMP), 1);
  let last = 0;
  for (let t = 0; t < 4; t += 0.05) {
    assert.ok(fxRate(t) >= last);
    last = fxRate(t);
  }
});

Deno.test('bombfx: the front grows, slowing, to the range and stops there', () => {
  assert.equal(frontRadius(0, 1750), 0);
  assert.equal(frontRadius(-1, 1750), 0);
  assert.equal(frontRadius(WAVE, 1750), 1750);
  assert.equal(frontRadius(WAVE * 3, 1750), 1750);
  let last = 0, step = Infinity;
  for (let s = 0.1; s <= WAVE; s += 0.1) {
    const r = frontRadius(s, 1750);
    assert.ok(r > last && r - last <= step + 1e-9, 'growing ever slower');
    step = r - last;
    last = r;
  }
});

// Runs `bomb` from `from` to `to` seconds of real time in frames of `dt` as main does:
// the effects' clock moves at its rate, then the update.
function run(bomb, eye, from, to, dt = 1 / 60, onPass = null) {
  for (let t = from; t < to; t += dt) {
    const now = 1000 + t * 1000;
    clock.rate = bomb.rate(now);
    clock.fx += dt * clock.rate;
    if (bomb.update(now, eye) && onPass) onPass(t);
  }
}

Deno.test('bombfx: the front passes the camera once, victims fall as it reaches them', () => {
  clock.fx = 50;
  const bomb = new BombFx();
  bomb.start(0, 0, 0, 500, 1000);
  assert.equal(bomb.range, 1750);
  assert.ok(bomb.killArmor < bomb.killBare && bomb.killBare < bomb.range);
  bomb.hold(3, 200);
  bomb.hold(7, 1000);
  bomb.hold(9, 5000); // beyond the range (positions differ a little): falls at the end
  const out = [];
  let passes = 0, passedAt = -1;
  run(bomb, [600, 0, 64], 0, 0.4, 1 / 60, () => passes++);
  assert.equal(passes, 0, 'the hit-stop: the front has not come 600 units yet');
  assert.ok(bomb.front > 0 && bomb.front < 200, `front ${bomb.front}`);
  assert.equal(bomb.reached(out), 0);
  assert.ok(bomb.holds(3) && bomb.holds(7));
  const fell = new Map();
  for (let t = 0.4; t < MARKS + 1; t += 1 / 60) {
    run(bomb, [600, 0, 64], t, t + 1 / 60, 1 / 60, (at) => {
      passes++;
      passedAt = at;
    });
    const n = bomb.reached(out);
    for (let i = 0; i < n; i++) fell.set(out[i], t);
  }
  assert.equal(passes, 1);
  assert.ok(passedAt > 0.5 && passedAt < 3, `passed at ${passedAt}`);
  assert.ok(fell.get(3) < passedAt && passedAt < fell.get(7), 'nearer falls sooner');
  assert.ok(fell.has(9), 'the far one fell by the end');
  assert.equal(bomb.waiting, 0);
  assert.equal(bomb.active, false);
  assert.ok(bomb.passHit > 0.5 && bomb.passHit < 1);
  // The impact frame and the shake come and go with the pass.
  const s = [0, 0];
  bomb.shake(1000 + (passedAt + 0.05) * 1000, s);
  assert.ok(Math.abs(s[0]) + Math.abs(s[1]) > 0);
  bomb.shake(1000 + (passedAt + 2) * 1000, s);
  assert.deepEqual(s, [0, 0]);
});

Deno.test('bombfx: outside the range the camera takes no hit; our own death waits', () => {
  clock.fx = 0;
  const bomb = new BombFx();
  bomb.start(0, 0, 0, 500, 1000);
  bomb.killedSelf(900);
  assert.ok(bomb.selfWaiting);
  let passes = 0;
  run(bomb, [0, 2000, 64], 0, 2, 1 / 60, () => passes++);
  assert.equal(passes, 0);
  run(bomb, [0, 2000, 64], 2, 5, 1 / 60, () => passes++);
  assert.equal(passes, 0, 'never hit beyond the range');
  assert.equal(bomb.selfWaiting, false, 'the front reached where we died');
  bomb.clear();
  assert.equal(bomb.active, false);
});

Deno.test('bombfx: the composite paints the wave only while the bomb runs', () => {
  assert.match(COMPOSITE_FS, /if \(u_blastR\.w > 0\.0\)/);
  assert.match(COMPOSITE_FS, /uniform mat4 u_invViewProj;/);
});
