// Automatic render resolution (r_dynres): keeps the frame rate at 60 or more on a GPU that
// cannot draw every pixel in time (an integrated GPU on battery). Two stages: first the
// render scale of the scene (`factor`, down to `min`; the scene draws smaller under the
// full-resolution print, so the ink stays crisp), then, when that is not enough (a GPU where
// the print itself is the cost), the print's own resolution (`print`: the canvas, in steps of
// PRINT_STEP down to PRINT_MIN; the browser stretches it, so the ink softens). Going up undoes
// the print steps first. Steps resize the G-buffer or the canvas, so they are rare: a second
// apart at least, and never for single stalls.
//
// With GPU timings (EXT_disjoint_timer_query_webgl2: client/gl/gputimer.js, the whole frame's
// GPU time and how many frames late its result comes back) it keeps the GPU ahead of the
// frame: a step down once the GPU takes most of the frame (DOWN_SHARE) or, busy, starts running
// behind (results coming back BEHIND_RISE frames later than they ever did at ease), before any
// frame is late, as a GPU that falls behind first lets the browser queue frames (mouse lag)
// and then misses them (stutter); and a step up only when the larger scale is predicted to
// fit well within the frame (UP_SHARE, the GPU time growing with the pixels), so it never
// tries a scale that brings late frames back. A GPU at low clocks reads slower than it is
// (it clocks up when it has to), which only makes going up later, never going down sooner.
//
// Without timings (some browsers) it watches the time between frames: when too many come
// late it takes a step down, and after a while with none late it tries a step back up,
// waiting twice as long after each try that brought late frames back.
// (The fast ink used to be the first step; since the print fetches its diagonals only near
// edges it saves nothing.)

export const SLOW_MS = 21; // a frame later than this is slow (under ~48 fps; 60 Hz misses read 33)
const STALL_MS = 250; // longer gaps are a hidden tab or a load, not the GPU: ignored
const WINDOW_MS = 500; // frames are judged in windows
const SLOW_SHARE = 0.08; // a window with more slow frames than this takes a step down
const CLEAN_SHARE = 0.02; // ... and one with at most this many counts toward going up
const STEP_DOWN = 0.1;
const STEP_UP = 0.05;
const PRINT_STEP = 0.15;
export const PRINT_MIN = 0.7;
const HOLD_MS = 1000; // after a change (the resize itself makes a slow frame)
const UP_AFTER_MS = 4000; // clean time before trying higher; doubles after each failed try
const UP_AFTER_MAX_MS = 64000;
const PROBE_MS = 3000; // a lowering this soon after going up means the try failed
// With GPU timings.
const BUDGET_MS = 1000 / 60; // the frame the GPU must fit in (60 fps; slower displays: their interval)
const DOWN_SHARE = 0.8; // GPU time over this share of the frame: a step down
const OVER_SHARE = 1.0; // ... over all of it: a double step
const UP_SHARE = 0.6; // a step up when the next scale's predicted GPU time stays under this share
const BEHIND_RISE = 0.8; // frames later than at ease: the GPU falls behind (an overloaded Iris Xe: 4 against 2)
const BUSY_SHARE = 0.5; // ... which counts only with the GPU busy over this share of the frame
const GPU_STEP = 0.05; // steps with timings (they come before any frame is late: small ones do)
const MIN_READINGS = 12; // GPU frames read back since the last resize before judging
const UP_CLEAN_MS = 3000; // clean time (with room to spare) before a step up

export class DynamicResolution {
  constructor() {
    this.factor = 1; // the scene's render scale, of the largest (mat_viewportscale)
    this.most = 1; // that largest scale, of the canvas: the steps are of the canvas (0.05), so 0.05 / most of the factor
    this.print = 1; // the print's (the canvas), of the page's pixels
    this.min = 0.5;
    this.upAfter = UP_AFTER_MS;
    this.interval = BUDGET_MS; // the display's frame interval, from the gaps
    this.floor = Infinity; // frames behind at ease: the lowest seen (the browser's own readback delay)
    this.reset(0);
  }

  // Starts over at the given scales (a map load: full, or what settled last time), judging
  // nothing until `holdMs` from now.
  reset(now, holdMs = 2000, factor = 1, print = 1) {
    this.factor = Math.min(1, Math.max(this.min, factor));
    this.print = Math.min(1, Math.max(PRINT_MIN, print));
    this.upAfter = UP_AFTER_MS;
    this.raisedAt = -Infinity;
    this.raisedPrint = false; // the last step up was a print step
    this.changedAt = now;
    this.startWindow(now + holdMs);
    this.cleanSince = now + holdMs;
  }

  startWindow(at) {
    this.windowStart = at;
    this.frames = 0;
    this.slow = 0;
  }

  // One frame `gapMs` after the last, at `now` (ms); `gpu`: the GPU timer's readings
  // ({ readings, frameMs, behind } per frame), or null without timings. Returns true when a
  // scale changed.
  frame(gapMs, now, gpu = null) {
    if (now < this.windowStart) return false;
    if (gapMs > STALL_MS) { // a stall: start the window again
      this.startWindow(now);
      this.cleanSince = now;
      return false;
    }
    // The display's interval: eased over the frames that came on time.
    if (gapMs < this.interval * 1.5) this.interval += (gapMs - this.interval) * 0.05;
    this.frames++;
    if (gapMs > SLOW_MS) this.slow++;
    const timed = gpu && gpu.readings >= MIN_READINGS;
    // At ease: the lowest seen, in whole frames (readbacks are whole frames late; the eased
    // reading dips between them).
    if (timed) this.floor = Math.min(this.floor, Math.max(0, Math.round(gpu.behind)));
    if (now - this.windowStart < WINDOW_MS) return false;
    const share = this.slow / this.frames;
    this.startWindow(now);
    return timed ? this.judgeTimed(share, now, gpu) : this.judgeGaps(share, now);
  }

  // With GPU timings: down before frames come late, up only when it will fit.
  judgeTimed(share, now, gpu) {
    const budget = Math.max(BUDGET_MS, this.interval), ms = gpu.frameMs;
    // Falling behind counts only with the GPU busy (a late readback alone can be the browser's).
    const behind = ms > budget * BUSY_SHARE ? gpu.behind - this.floor : 0;
    if (share > SLOW_SHARE || ms > budget * DOWN_SHARE || behind > BEHIND_RISE) {
      this.cleanSince = now;
      if (now - this.raisedAt < PROBE_MS) this.upAfter = Math.min(this.upAfter * 2, UP_AFTER_MAX_MS);
      this.raisedAt = -Infinity;
      const step = (share > SLOW_SHARE || ms > budget * OVER_SHARE ? 2 * GPU_STEP : GPU_STEP) / this.most;
      if (this.factor > this.min) return this.set(this.factor - step, now);
      return this.print > PRINT_MIN && this.setPrint(this.print - PRINT_STEP, now);
    }
    if (share > CLEAN_SHARE || behind > BEHIND_RISE / 2) {
      this.cleanSince = now;
      return false;
    }
    if ((this.factor >= 1 && this.print >= 1) || now - this.cleanSince < Math.max(UP_CLEAN_MS, this.upAfter - UP_AFTER_MS)) {
      return false;
    }
    // The next scale's GPU time, growing with the pixels (the print's only partly: conservative).
    const raisePrint = this.print < 1;
    const up = GPU_STEP / this.most;
    const k = raisePrint ? Math.min(1, this.print + PRINT_STEP) / this.print : Math.min(1, this.factor + up) / this.factor;
    if (ms * k * k > budget * UP_SHARE) return false;
    this.raisedAt = now;
    this.cleanSince = now;
    this.raisedPrint = raisePrint;
    return raisePrint ? this.setPrint(this.print + PRINT_STEP, now) : this.set(this.factor + up, now);
  }

  // Without timings: late frames take a step down, clean stretches try a step up.
  judgeGaps(share, now) {
    if (share > SLOW_SHARE) {
      this.cleanSince = now;
      if (now - this.raisedAt < PROBE_MS) { // the try failed: back to the step that kept up
        this.upAfter = Math.min(this.upAfter * 2, UP_AFTER_MAX_MS);
        this.raisedAt = -Infinity;
        return this.raisedPrint ? this.setPrint(this.print - PRINT_STEP, now) : this.set(this.factor - STEP_UP / this.most, now);
      }
      if (this.factor > this.min) return this.set(this.factor - STEP_DOWN / this.most, now);
      return this.print > PRINT_MIN && this.setPrint(this.print - PRINT_STEP, now);
    }
    if (share > CLEAN_SHARE) {
      this.cleanSince = now;
      return false;
    }
    if ((this.factor >= 1 && this.print >= 1) || now - this.cleanSince < this.upAfter) return false;
    this.raisedAt = now;
    this.cleanSince = now;
    this.raisedPrint = this.print < 1;
    return this.raisedPrint ? this.setPrint(this.print + PRINT_STEP, now) : this.set(this.factor + STEP_UP / this.most, now);
  }

  // Held for `ms` without a change: the scales are worth remembering for the next map.
  settled(now, ms = 10000) {
    return now - this.changedAt >= ms;
  }

  set(f, now) {
    const n = 20 * this.most; // whole steps of the canvas
    const next = Math.min(1, Math.max(this.min, Math.round(f * n) / n));
    if (next === this.factor) return false;
    this.factor = next;
    this.changed(now);
    return true;
  }

  setPrint(p, now) {
    const next = Math.min(1, Math.max(PRINT_MIN, Math.round(p * 20) / 20));
    if (next === this.print) return false;
    this.print = next;
    this.changed(now);
    return true;
  }

  changed(now) {
    this.changedAt = now;
    this.startWindow(now + HOLD_MS);
  }
}
