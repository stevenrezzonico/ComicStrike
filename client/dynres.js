// Automatic render resolution (r_dynres): keeps the frame rate at 60 or more on a GPU that
// cannot draw every pixel in time (an integrated GPU on battery). It watches the time
// between frames: when too many come late it takes the render scale a step down (a tenth
// at a time; the scene draws smaller under the full-resolution print, so the ink stays
// crisp), and after a while with none late it tries a step back up, waiting twice as
// long after each try that brought late frames back. Frame times work in every browser
// (GPU timer queries do not). Scale steps resize the G-buffer, so steps are rare: a
// second apart at least, and never for single stalls. (The fast ink used to be the first
// step; since the print fetches its diagonals only near edges it saves nothing.)

export const SLOW_MS = 21; // a frame later than this is slow (under ~48 fps; 60 Hz misses read 33)
const STALL_MS = 250; // longer gaps are a hidden tab or a load, not the GPU: ignored
const WINDOW_MS = 500; // frames are judged in windows
const SLOW_SHARE = 0.08; // a window with more slow frames than this takes a step down
const CLEAN_SHARE = 0.02; // ... and one with at most this many counts toward going up
const STEP_DOWN = 0.1;
const STEP_UP = 0.05;
const HOLD_MS = 1000; // after a change (the resize itself makes a slow frame)
const UP_AFTER_MS = 4000; // clean time before trying higher; doubles after each failed try
const UP_AFTER_MAX_MS = 64000;
const PROBE_MS = 3000; // a lowering this soon after going up means the try failed

export class DynamicResolution {
  constructor() {
    this.factor = 1; // of the largest render scale (mat_viewportscale)
    this.min = 0.5;
    this.upAfter = UP_AFTER_MS;
    this.reset(0);
  }

  // Starts over at full scale, judging nothing until `holdMs` from now (a map load).
  reset(now, holdMs = 2000) {
    this.factor = 1;
    this.upAfter = UP_AFTER_MS;
    this.raisedAt = -Infinity;
    this.startWindow(now + holdMs);
    this.cleanSince = now + holdMs;
  }

  startWindow(at) {
    this.windowStart = at;
    this.frames = 0;
    this.slow = 0;
  }

  // One frame `gapMs` after the last, at `now` (ms). Returns true when the factor changed.
  frame(gapMs, now) {
    if (now < this.windowStart) return false;
    if (gapMs > STALL_MS) { // a stall: start the window again
      this.startWindow(now);
      this.cleanSince = now;
      return false;
    }
    this.frames++;
    if (gapMs > SLOW_MS) this.slow++;
    if (now - this.windowStart < WINDOW_MS) return false;
    const share = this.slow / this.frames;
    this.startWindow(now);
    if (share > SLOW_SHARE) {
      this.cleanSince = now;
      if (now - this.raisedAt < PROBE_MS) { // the try failed: back to the step that kept up
        this.upAfter = Math.min(this.upAfter * 2, UP_AFTER_MAX_MS);
        this.raisedAt = -Infinity;
        return this.set(this.factor - STEP_UP, now);
      }
      return this.factor > this.min && this.set(this.factor - STEP_DOWN, now);
    }
    if (share > CLEAN_SHARE) {
      this.cleanSince = now;
      return false;
    }
    if (this.factor >= 1 || now - this.cleanSince < this.upAfter) return false;
    this.raisedAt = now;
    this.cleanSince = now;
    return this.set(this.factor + STEP_UP, now);
  }

  set(f, now) {
    const next = Math.min(1, Math.max(this.min, Math.round(f * 20) / 20));
    if (next === this.factor) return false;
    this.factor = next;
    this.startWindow(now + HOLD_MS);
    return true;
  }
}
