// GPU time per pass of a frame (cl_showfps 3), to see where a frame goes before tuning it,
// and how far the GPU runs behind (always, for r_dynres and the benchmark).
// mark(pass) ends the running pass and starts the next one (a pass may run several times a
// frame: its times add up); endFrame() closes the last. EXT_disjoint_timer_query_webgl2
// queries come back a few frames later and are averaged over the readout's window; where the
// extension is missing (Chrome hides it on some systems) each mark waits for the GPU with
// gl.finish and times that on the CPU, which is coarser and slows the frame down. The first
// pass ('clear') also counts whatever else the browser's GPU process runs before our frame
// (~0.9 ms at 720p on an Iris Xe whether the color targets are cleared or not).
//
// With the per-pass readout off (`on` false) and the extension present, one query covers the
// whole frame (`light`): its GPU time (`frameMs`) and how many frames old its result is when
// it comes back (`behind`). A GPU that cannot keep up lets the browser queue frames ahead of
// it: every queued frame is a frame more between the mouse and the screen, long before any
// frame comes late. Both are eased over a few frames.

export const PASS = { CLEAR: 0, WORLD: 1, SKY: 2, MODELS: 3, EFFECTS: 4, GLASS: 5, VIEW: 6, INK: 7, PRINT: 8, OVER: 9 };
const LABELS = ['clear', 'world', 'sky', 'models', 'effects', 'glass', 'view', 'ink', 'print', 'over'];
const WHOLE = LABELS.length; // the light mode's one query a frame
const PENDING = 256; // queries in flight (a frame makes ~15; results lag 2-4 frames)
const EASE = 0.1; // share of a new frame's reading in frameMs / behind

export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.on = false;
    this.light = !!this.ext; // the whole frame's time and lag, while `on` is off
    this.cur = -1; // the running pass
    // Pending queries, a ring: the query, its pass and frame.
    this.query = [];
    this.pass = new Int8Array(PENDING);
    this.frameOf = new Int32Array(PENDING);
    this.head = 0;
    this.size = 0;
    this.frame = 0;
    this.started = 0; // fallback: when the running pass started
    // Per frame being read back, then summed over the window.
    this.partFrame = -1;
    this.validFrom = 0; // results of earlier frames are thrown away (turned off, clock jump)
    this.part = new Float64Array(WHOLE + 1);
    this.sum = new Float64Array(LABELS.length);
    this.frames = 0;
    // Eased readings (0 before any came back): GPU ms a frame, frames behind.
    this.frameMs = 0;
    this.behind = 0;
    this.readings = 0; // frames read back since the last reset()
    // Frames behind of each result, counted for the benchmark (index: frames, capped).
    this.behindCount = new Int32Array(8);
  }

  mark(pass) {
    if (!this.on) {
      // Light: one query from the frame's first mark to endFrame.
      if (this.light && this.cur < 0) this.begin(WHOLE);
      return;
    }
    this.stop();
    if (this.ext) this.begin(pass);
    else {
      this.gl.finish();
      this.started = performance.now();
      this.cur = pass;
    }
  }

  begin(pass) {
    if (this.size === PENDING) return; // results stopped coming back: skip
    const i = (this.head + this.size) % PENDING;
    if (!this.query[i]) this.query[i] = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query[i]);
    this.pass[i] = pass;
    this.frameOf[i] = this.frame;
    this.size++;
    this.cur = pass;
  }

  stop() {
    if (this.cur < 0) return;
    if (this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    else {
      this.gl.finish();
      this.part[this.cur] += performance.now() - this.started;
    }
    this.cur = -1;
  }

  endFrame() {
    this.stop();
    if (!this.ext) {
      if (this.on) this.addFrame();
      return;
    }
    this.frame++;
    if (!this.size) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) this.drop(); // the clock jumped: worthless
    let late = -1;
    while (this.size) {
      const q = this.query[this.head];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const f = this.frameOf[this.head], pass = this.pass[this.head];
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.head = (this.head + 1) % PENDING;
      this.size--;
      if (f < this.validFrom) continue;
      late = this.frame - f;
      if (f !== this.partFrame) {
        if (this.partFrame >= 0) this.addFrame();
        this.partFrame = f;
      }
      this.part[pass] += ns / 1e6;
    }
    // The oldest frame read back this time: how far the GPU runs behind.
    if (late >= 0) {
      this.behind = this.readings ? this.behind + (late - this.behind) * EASE : late;
      this.behindCount[Math.min(late, this.behindCount.length - 1)]++;
    }
  }

  addFrame() {
    let total = this.part[WHOLE];
    for (let i = 0; i < LABELS.length; i++) {
      total += this.part[i];
      this.sum[i] += this.part[i];
      this.part[i] = 0;
    }
    this.part[WHOLE] = 0;
    this.frameMs = this.readings ? this.frameMs + (total - this.frameMs) * EASE : total;
    this.readings++;
    if (this.on) this.frames++;
  }

  // Forgets the queries in flight (their results are thrown away as they come back).
  drop() {
    this.validFrom = this.frame;
    this.part.fill(0);
    this.partFrame = -1;
  }

  // Starts the eased readings over (a resize or a map load changes the GPU's work).
  reset() {
    this.drop();
    this.readings = 0;
    this.frameMs = 0;
    this.behind = 0;
  }

  // Frames behind over the benchmark: mean and the 95th percentile ('' with none), counts zeroed.
  behindReport() {
    const c = this.behindCount;
    let n = 0, sum = 0;
    for (let i = 0; i < c.length; i++) {
      n += c[i];
      sum += c[i] * i;
    }
    if (!n) return '';
    let acc = 0, p95 = 0;
    for (let i = 0; i < c.length; i++) {
      acc += c[i];
      if (acc >= n * 0.95) {
        p95 = i;
        break;
      }
    }
    c.fill(0);
    return `gpu behind: ${(sum / n).toFixed(2)} frames mean · 95% ${p95}${p95 === c.length - 1 ? '+' : ''}`;
  }

  // The window's averages as text ('' before any came back), and a new window.
  report() {
    if (!this.frames) return this.on ? 'gpu: waiting for timings' : '';
    let total = 0, s = '';
    for (let i = 0; i < LABELS.length; i++) {
      const ms = this.sum[i] / this.frames;
      total += ms;
      s += `${i ? ' · ' : ''}${LABELS[i]} ${ms.toFixed(2)}`;
    }
    this.sum.fill(0);
    this.frames = 0;
    return `gpu${this.ext ? '' : ' (finish)'}: ${total.toFixed(2)} ms\n${s}`;
  }
}
