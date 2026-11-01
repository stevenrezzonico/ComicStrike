// Frames in flight (client/gl/framegate.js): a frame is drawn while fewer than `ahead`
// earlier frames are still pending in the GPU pipeline, pending fences are dropped as the
// GPU passes them, and a fence that never signals is given up after STALE_MS.
import assert from 'node:assert/strict';
import { FrameGate, STALE_MS } from '../client/gl/framegate.js';

// A WebGL2 stand-in: fences signal when the test says so.
function fakeGL() {
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, SYNC_STATUS: 0x9114, SIGNALED: 0x9119, UNSIGNALED: 0x9118,
    fences: [], deleted: 0, flushes: 0,
    fenceSync() {
      const f = { signaled: false };
      gl.fences.push(f);
      return f;
    },
    getSyncParameter(f) {
      return f.signaled ? gl.SIGNALED : gl.UNSIGNALED;
    },
    deleteSync() {
      gl.deleted++;
    },
    flush() {
      gl.flushes++;
    },
  };
  return gl;
}

Deno.test('framegate: draws while fewer than `ahead` frames are pending, then holds until one passes', () => {
  const gl = fakeGL(), g = new FrameGate(gl);
  let t = 0;
  for (let i = 0; i < 3; i++) {
    assert.ok(g.ready(3, t), `frame ${i} drawn`);
    g.drawn(t);
    t += 0.5;
  }
  assert.equal(gl.flushes, 3, 'a flush behind each fence');
  assert.ok(!g.ready(3, t), 'three pending: the fourth frame waits');
  assert.ok(!g.ready(3, t + 1));
  assert.equal(g.skipped, 2);
  gl.fences[0].signaled = true;
  assert.ok(g.ready(3, t + 2), 'the oldest passed: a frame may be drawn');
  assert.equal(gl.deleted, 1);
  g.drawn(t + 2);
  gl.fences[1].signaled = gl.fences[2].signaled = gl.fences[3].signaled = true;
  assert.ok(g.ready(3, t + 3));
  assert.equal(g.size, 0, 'every passed fence dropped');
  assert.equal(gl.deleted, 4);
});

Deno.test('framegate: ahead 0 never holds a frame; a vsync-paced browser seeing fences 2 frames later never waits at 3', () => {
  const gl = fakeGL(), g = new FrameGate(gl);
  for (let i = 0; i < 5; i++) {
    assert.ok(g.ready(0, i));
    g.drawn(i);
  }
  assert.equal(g.skipped, 0);
  const g2 = new FrameGate(fakeGL());
  for (let i = 0; i < 100; i++) {
    assert.ok(g2.ready(3, i * 16.7), `frame ${i}`);
    g2.drawn(i * 16.7);
    if (i >= 1) g2.gl.fences[i - 1].signaled = true; // the fence of two frames ago, seen next poll
  }
  assert.equal(g2.skipped, 0);
});

Deno.test('framegate: a fence that never signals is given up after STALE_MS, so drawing goes on', () => {
  const gl = fakeGL(), g = new FrameGate(gl);
  for (let i = 0; i < 3; i++) {
    g.ready(3, i);
    g.drawn(i);
  }
  assert.ok(!g.ready(3, 10));
  assert.ok(g.ready(3, STALE_MS + 0.5), 'the oldest fence given up');
  assert.equal(g.stale, 1);
  assert.ok(g.ready(3, STALE_MS + 3), 'all three given up by then');
  assert.equal(g.stale, 3);
  g.reset();
  assert.equal(g.size, 0);
});
