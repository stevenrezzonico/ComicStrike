// Automatic render resolution (client/dynres.js): late frames lower the scale a step at a
// time down to its floor, clean stretches go back up, failed tries wait longer, and stalls
// or single hitches change nothing.
import assert from 'node:assert/strict';
import { DynamicResolution, PRINT_MIN } from '../client/dynres.js';

// Runs `seconds` of frames `gapMs` apart (or from a function of the time) from `t`.
function run(d, t, seconds, gapMs) {
  const end = t + seconds * 1000;
  while (t < end) {
    const g = typeof gapMs === 'function' ? gapMs(t) : gapMs;
    t += g;
    d.frame(g, t);
  }
  return t;
}

Deno.test('dynres: steady 60 fps keeps full resolution', () => {
  const d = new DynamicResolution();
  run(d, 0, 30, 16.7);
  assert.equal(d.factor, 1);
});

Deno.test('dynres: missed vsyncs lower the scene scale step by step to the floor, then the print', () => {
  const d = new DynamicResolution();
  d.min = 0.5;
  let t = run(d, 0, 2.5, 16.7); // past the start hold
  t = run(d, t, 0.6, 33.3);
  assert.equal(d.factor, 0.9, 'one step after the first late window');
  assert.equal(d.print, 1);
  t = run(d, t, 1.6, 33.3);
  assert.ok(d.factor < 0.9 && d.factor >= 0.7, `then one or two more: ${d.factor}`);
  t = run(d, t, 8, 33.3);
  assert.equal(d.factor, 0.5);
  run(d, t, 12, 33.3);
  assert.equal(d.factor, 0.5);
  assert.equal(d.print, PRINT_MIN, 'the print last, to its floor');
});

Deno.test('dynres: going up undoes the print steps first', () => {
  const d = new DynamicResolution();
  let t = run(d, 0, 2.5, 16.7);
  t = run(d, t, 30, 33.3);
  assert.equal(d.print, PRINT_MIN);
  // Fine from here on: the print comes back before the scene scale rises.
  const printAt = [];
  t = run(d, t, 60, () => {
    printAt.push([d.factor, d.print]);
    return 16.7;
  });
  assert.ok(printAt.some(([f, p]) => f === 0.5 && p === 1), 'print back at full while the scene is still at its floor');
  run(d, t, 200, 16.7);
  assert.equal(d.factor, 1);
  assert.equal(d.print, 1);
});

Deno.test('dynres: a clean stretch raises it again, a failed try waits twice as long', () => {
  const d = new DynamicResolution();
  let t = run(d, 0, 2.5, 16.7);
  // Late at full scale, on time at 0.9 or lower: the GPU just misses at full resolution.
  const gap = () => (d.factor > 0.9 ? 33.3 : 16.7);
  t = run(d, t, 4, gap); // 0.9
  assert.equal(d.factor, 0.9);
  const before = d.upAfter;
  t = run(d, t, 8, gap); // tries 0.95, which is late: back down, and a longer wait
  assert.equal(d.factor, 0.9);
  assert.ok(d.upAfter > before, `waits longer: ${d.upAfter}`);
  // The scene gets lighter (looking at a wall): up again to full scale.
  run(d, t, 200, 16.7);
  assert.equal(d.factor, 1);
});

Deno.test('dynres: stalls and single hitches change nothing', () => {
  const d = new DynamicResolution();
  let t = run(d, 0, 3, 16.7);
  d.frame(900, t += 900); // a hidden tab, a map load
  t = run(d, t, 3, 16.7);
  t = run(d, t, 10, (x) => (Math.floor(x / 16.7) % 30 === 0 ? 40 : 16.7)); // one late frame in 30
  assert.equal(d.factor, 1);
});

Deno.test('dynres: reset holds judgment after a map load', () => {
  const d = new DynamicResolution();
  run(d, 0, 10, 33.3);
  assert.ok(d.factor < 1);
  d.reset(20000);
  assert.equal(d.factor, 1);
  run(d, 20000, 1.5, 50); // shader compiles and first frames: inside the hold
  assert.equal(d.factor, 1);
});
