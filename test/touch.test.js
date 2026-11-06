// The touch controls (client/touch.js): the stick's eight digital directions, a dead zone
// and a walk band; the button layout (inside the screen, apart, big enough, FIRE under the
// resting thumb); the presses through a fake console.
import assert from 'node:assert/strict';
import { IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED } from '../shared/constants.js';
import { releaseOf } from '../shared/cvars.js';
import { WEAPON_ID, WEAPONS } from '../shared/weapons.js';
import {
  stickButtons, layoutRects, TouchButtons, BUTTONS, altLabel, STICK_RADIUS, STICK_DEAD, STICK_WALK, STICK_ZONE, MIN_BUTTON,
} from '../client/touch.js';

Deno.test('touch stick: dead zone, eight sectors, walking on a small pull', () => {
  const r = STICK_RADIUS;
  assert.equal(stickButtons(0, 0), 0);
  assert.equal(stickButtons(r * STICK_DEAD * 0.9, 0), 0, 'inside the dead zone');
  // A full pull in each direction (screen y down): no walk bit.
  assert.equal(stickButtons(0, -r), IN_FORWARD);
  assert.equal(stickButtons(r, -r), IN_FORWARD | IN_MOVERIGHT);
  assert.equal(stickButtons(r, 0), IN_MOVERIGHT);
  assert.equal(stickButtons(r, r), IN_BACK | IN_MOVERIGHT);
  assert.equal(stickButtons(0, r), IN_BACK);
  assert.equal(stickButtons(-r, r), IN_BACK | IN_MOVELEFT);
  assert.equal(stickButtons(-r, 0), IN_MOVELEFT);
  assert.equal(stickButtons(-r, -r), IN_FORWARD | IN_MOVELEFT);
  // Sector edges: 22.5 degrees either side of forward is still forward, past it a diagonal.
  const deg = Math.PI / 180;
  assert.equal(stickButtons(r * Math.sin(20 * deg), -r * Math.cos(20 * deg)), IN_FORWARD);
  assert.equal(stickButtons(r * Math.sin(25 * deg), -r * Math.cos(25 * deg)), IN_FORWARD | IN_MOVERIGHT);
  // A small pull walks; past the walk band it runs; far past the radius still runs.
  assert.equal(stickButtons(0, -r * (STICK_DEAD + STICK_WALK) / 2), IN_FORWARD | IN_SPEED);
  assert.equal(stickButtons(0, -r * STICK_WALK), IN_FORWARD);
  assert.equal(stickButtons(0, -r * 5), IN_FORWARD);
});

// A phone in landscape, a tablet, at the smallest and the biggest button size.
const SCREENS = [[812, 375], [667, 375], [1024, 768], [1180, 820]];

Deno.test('touch layout: every button on screen, apart from the others, big enough, FIRE under the thumb', () => {
  for (const [w, h] of SCREENS) {
    for (const scale of [0.7, 1, 1.4]) {
      const rects = layoutRects(w, h, scale, { fireLeft: true });
      assert.equal(rects.length, BUTTONS.length, 'every button placed');
      const discs = rects.filter((b) => !b.zone);
      for (const b of discs) {
        assert.ok(b.cx - b.r >= 0 && b.cx + b.r <= w && b.cy - b.r >= 0 && b.cy + b.r <= h, `${b.name} inside ${w}x${h} at ${scale}`);
        assert.ok(b.r * 2 >= MIN_BUTTON * Math.min(1, scale) - 1e-9, `${b.name} at least ${MIN_BUTTON} px`);
      }
      for (let i = 0; i < discs.length; i++) {
        for (let j = i + 1; j < discs.length; j++) {
          const a = discs[i], b = discs[j];
          const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
          assert.ok(d >= a.r + b.r + 4, `${a.name} and ${b.name} apart at ${w}x${h} scale ${scale} (${d.toFixed(0)})`);
        }
      }
      // FIRE is the biggest and sits where the right thumb rests: in from the corner, not in it.
      const fire = discs.find((b) => b.name === 'fire');
      for (const b of discs) assert.ok(b.r <= fire.r, `${b.name} no bigger than FIRE`);
      assert.ok(fire.cx + fire.r < w - 20 * scale && fire.cy + fire.r < h - 20 * scale, 'FIRE in from the edges');
      assert.ok(fire.cx > w - 200 * scale && fire.cy > h - 160 * scale, 'FIRE within the thumb\'s reach of the corner');
      // The right thumb's buttons look too; the left FIRE and the tap-only ones do not.
      for (const b of discs) {
        if (b.name === 'fire2') assert.ok(b.cx < w * STICK_ZONE && !b.look, 'the left FIRE over the stick zone, no look');
        else if (['next', 'buy'].includes(b.name)) assert.ok(!b.look);
        else assert.ok(b.look, `${b.name} looks`);
      }
    }
    // Without the left FIRE.
    assert.ok(!layoutRects(w, h, 1, { fireLeft: false }).some((b) => b.name === 'fire2'));
  }
});

Deno.test('touch buttons: presses and releases, a toggle, two fingers on one button, reset', () => {
  const ran = [], shown = [];
  const tb = new TouchButtons((cmd) => ran.push(cmd), (b, on) => shown.push(`${b.name}:${on ? 1 : 0}`));
  const rects = tb.layout(812, 375, 1, { fireLeft: true });
  const at = (name) => rects.find((b) => b.name === name);
  assert.equal(tb.press(1, 10, 10), null, 'nothing in the open');
  assert.equal(tb.at(at('fire').cx + at('fire').r + 5, at('fire').cy).name, 'fire', 'a little slack round a disc');
  // FIRE held: +attack, released: -attack.
  const fire = tb.press(1, at('fire').cx, at('fire').cy);
  assert.equal(fire.name, 'fire');
  assert.ok(fire.look);
  assert.deepEqual(ran, ['+attack']);
  // A second finger on the same button: the release of the first keeps it held.
  tb.press(2, at('fire').cx + 10, at('fire').cy);
  tb.release(1);
  assert.deepEqual(ran, ['+attack', '+attack']);
  tb.release(2);
  assert.deepEqual(ran, ['+attack', '+attack', releaseOf('+attack')]);
  assert.deepEqual(shown, ['fire:1', 'fire:1', 'fire:0']);
  // The left FIRE runs the same +attack: lifting it while FIRE is held keeps firing.
  tb.press(7, at('fire').cx, at('fire').cy);
  tb.press(8, at('fire2').cx, at('fire2').cy);
  ran.length = 0;
  tb.release(8);
  assert.deepEqual(ran, []);
  tb.release(7);
  assert.deepEqual(ran, [releaseOf('+attack')]);
  // A tap-only button runs its command once, nothing on lifting.
  ran.length = 0;
  const next = tb.press(3, at('next').cx, at('next').cy);
  assert.ok(!next.look);
  tb.release(3);
  assert.deepEqual(ran, ['invnext']);
  // The ammo zone is NEXT too.
  ran.length = 0;
  tb.press(4, 812 / 2, 375 - 20);
  tb.release(4);
  assert.deepEqual(ran, ['invnext']);
  // DUCK toggles: on at a tap, off at the next, nothing on lifting.
  ran.length = 0;
  shown.length = 0;
  tb.press(5, at('duck').cx, at('duck').cy);
  tb.release(5);
  assert.deepEqual(ran, ['+duck']);
  tb.press(6, at('duck').cx, at('duck').cy);
  tb.release(6);
  assert.deepEqual(ran, ['+duck', releaseOf('+duck')]);
  assert.deepEqual(shown, ['duck:1', 'duck:0']);
  // Reset: a held button and a toggle shown off, nothing run (the lock cleared the keys).
  ran.length = 0;
  shown.length = 0;
  tb.press(7, at('jump').cx, at('jump').cy);
  tb.press(8, at('duck').cx, at('duck').cy);
  tb.reset();
  assert.deepEqual(ran, ['+jump', '+duck']);
  assert.deepEqual(shown, ['jump:1', 'duck:1', 'jump:0', 'duck:0']);
  assert.equal(tb.held.size, 0);
  assert.equal(tb.toggled.size, 0);
});

Deno.test('touch AIM button: named by what the right click does, gone where it does nothing', () => {
  const w = (name) => WEAPONS[WEAPON_ID[name]];
  assert.equal(altLabel(w('awp')), 'SCOPE');
  assert.equal(altLabel(w('aug')), 'SCOPE');
  assert.equal(altLabel(w('glock')), 'BURST');
  assert.equal(altLabel(w('famas')), 'BURST');
  assert.equal(altLabel(w('usp_silencer')), 'SILENCER');
  assert.equal(altLabel(w('m4a1_silencer')), 'SILENCER');
  assert.equal(altLabel(w('revolver')), 'FAN');
  assert.equal(altLabel(w('knife')), 'STAB');
  assert.equal(altLabel(w('hegrenade')), 'LOB');
  for (const name of ['ak47', 'm4a1', 'deagle', 'p250', 'nova', 'c4']) assert.equal(altLabel(w(name)), null, name);
  assert.equal(altLabel(null), null);
  // A hidden button is not pressed.
  const ran = [];
  const tb = new TouchButtons((cmd) => ran.push(cmd));
  const rects = tb.layout(812, 375, 1, {});
  const aim = rects.find((b) => b.name === 'aim');
  tb.hidden.add('aim');
  assert.equal(tb.press(1, aim.cx, aim.cy), null);
  tb.hidden.delete('aim');
  assert.equal(tb.press(1, aim.cx, aim.cy).name, 'aim');
  assert.deepEqual(ran, ['+attack2']);
});
