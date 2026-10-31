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

// With GPU timings: a GPU whose frame takes `ms(factor, print)` and whose results come back
// `behind(factor)` frames late; every frame is on time (the gaps alone would see nothing).
function runTimed(d, t, seconds, ms, behind = () => 2, log = null) {
  const end = t + seconds * 1000;
  const gpu = { readings: 100, frameMs: 0, behind: 0 };
  while (t < end) {
    t += 16.7;
    gpu.frameMs = ms(d.factor, d.print);
    gpu.behind = behind(d.factor);
    if (d.frame(16.7, t, gpu) && log) log.push([t, d.factor, d.print]);
  }
  return t;
}

Deno.test('dynres timed: a GPU taking most of the frame steps down before any frame is late, then holds', () => {
  const d = new DynamicResolution();
  const log = [];
  runTimed(d, 0, 60, (f) => 15 * f * f, undefined, log);
  assert.equal(d.factor, 0.9, `settles where it fits with room: ${d.factor}`);
  assert.ok(log.length <= 2, `no back and forth: ${JSON.stringify(log)}`);
});

Deno.test('dynres timed: results coming back later than at ease (frames queued) step down', () => {
  const d = new DynamicResolution();
  let t = runTimed(d, 0, 5, () => 4); // at ease first (a lighter view): readbacks 2 frames late
  assert.equal(d.factor, 1);
  // Under the GPU-time limit (low clocks read low), but busy and falling behind above 0.8.
  const log = [];
  t = runTimed(d, t, 60, (f) => 12.5 * f * f, (f) => (f > 0.8 ? 3 : 2), log);
  assert.ok(log.some(([, f]) => f === 0.8), `down while behind: ${JSON.stringify(log)}`);
  assert.ok(d.factor <= 0.85 && log.every(([, f]) => f >= 0.75), `and no further: ${JSON.stringify(log)}`);
  const tries = log.filter(([, f], i) => i > 0 && f > log[i - 1][1]).map(([at]) => at);
  for (let i = 2; i < tries.length; i++) assert.ok(tries[i] - tries[i - 1] > tries[i - 1] - tries[i - 2], `each failed try waits longer: ${tries}`);
  const idle = new DynamicResolution();
  runTimed(idle, 0, 30, () => 4, () => 3);
  assert.equal(idle.factor, 1, "a late readback with an idle GPU is the browser's own, not lag");
});

Deno.test('dynres timed: goes up only as far as the predicted GPU time fits', () => {
  const d = new DynamicResolution();
  d.reset(0, 2000, 0.5, 1);
  const log = [];
  runTimed(d, 0, 120, (f) => 12 * f * f, undefined, log);
  assert.equal(d.factor, 0.9, `up to where 0.95 would not fit: ${d.factor}`);
  for (let i = 1; i < log.length; i++) assert.ok(log[i][1] > log[i - 1][1], 'never a step down on the way');
  const light = new DynamicResolution();
  light.reset(0, 2000, 0.5, 1);
  runTimed(light, 0, 120, (f) => 6 * f * f);
  assert.equal(light.factor, 1, 'a light GPU load climbs back to full');
});

Deno.test('dynres timed: the print steps go last down and first up', () => {
  const d = new DynamicResolution();
  // A print-bound GPU: 14 ms of print at full print size whatever the scene scale.
  runTimed(d, 0, 30, (f, p) => 3 * f * f + 14 * p * p);
  assert.equal(d.factor, 0.5, 'the scene first, to its floor');
  assert.ok(d.print < 1, `then the print: ${d.print}`);
});

Deno.test('dynres timed: reset starts at the remembered scales', () => {
  const d = new DynamicResolution();
  d.reset(0, 2000, 0.75, 0.85);
  assert.equal(d.factor, 0.75);
  assert.equal(d.print, 0.85);
  assert.ok(!d.settled(5000) && d.settled(10000));
});
