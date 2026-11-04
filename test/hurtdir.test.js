// The hurt indicator's direction (client/hurtdir.js): degrees clockwise from straight up on
// the screen, turning with the view.
import assert from 'node:assert/strict';
import { hurtAngle } from '../client/hurtdir.js';

Deno.test('hurt indicator: in front is up, the left is counterclockwise, behind is down', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(hurtAngle(100, 0, 0, 0, 0), 0); // looking along +x, hit from ahead
  near(hurtAngle(0, 100, 0, 0, 0), -90); // +y is the left in GoldSrc
  near(hurtAngle(0, -100, 0, 0, 0), 90);
  near(Math.abs(hurtAngle(-100, 0, 0, 0, 0)), 180);
  near(hurtAngle(0, 100, 0, 0, 90), 0, 'turned toward it: ahead');
  near(hurtAngle(500, 600, 500, 500, 350), -100, 'wraps past 360: 100 to the left');
  near(Math.abs(hurtAngle(10, 10, 0, 0, -135)), 180);
});
