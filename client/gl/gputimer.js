// GPU time per pass of a frame (cl_showfps 3), to see where a frame goes before tuning it.
// mark(pass) ends the running pass and starts the next one (a pass may run several times a
// frame: its times add up); endFrame() closes the last. EXT_disjoint_timer_query_webgl2
// queries come back a few frames later and are averaged over the readout's window; where the
// extension is missing (Chrome hides it on some systems) each mark waits for the GPU with
// gl.finish and times that on the CPU, which is coarser and slows the frame down. The first
// pass ('clear') also counts whatever else the browser's GPU process runs before our frame
// (~0.9 ms at 720p on an Iris Xe whether the color targets are cleared or not).

export const PASS = { CLEAR: 0, WORLD: 1, SKY: 2, MODELS: 3, EFFECTS: 4, GLASS: 5, VIEW: 6, PRINT: 7, OVER: 8 };
const LABELS = ['clear', 'world', 'sky', 'models', 'effects', 'glass', 'view', 'print', 'over'];
const PENDING = 256; // queries in flight (a frame makes ~15; results lag 2-4 frames)

export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.on = false;
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
    this.part = new Float64Array(LABELS.length);
    this.sum = new Float64Array(LABELS.length);
    this.frames = 0;
  }

  mark(pass) {
    if (!this.on) return;
    this.stop();
    if (this.ext) {
      if (this.size === PENDING) return; // results stopped coming back: skip
      const i = (this.head + this.size) % PENDING;
      if (!this.query[i]) this.query[i] = this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query[i]);
      this.pass[i] = pass;
      this.frameOf[i] = this.frame;
      this.size++;
      this.cur = pass;
    } else {
      this.gl.finish();
      this.started = performance.now();
      this.cur = pass;
    }
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
    if (!this.on || gl.getParameter(this.ext.GPU_DISJOINT_EXT)) this.drop(); // the clock jumped: worthless
    while (this.size) {
      const q = this.query[this.head];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const f = this.frameOf[this.head], pass = this.pass[this.head];
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.head = (this.head + 1) % PENDING;
      this.size--;
      if (f < this.validFrom) continue;
      if (f !== this.partFrame) {
        if (this.partFrame >= 0) this.addFrame();
        this.partFrame = f;
      }
      this.part[pass] += ns / 1e6;
    }
  }

  addFrame() {
    for (let i = 0; i < LABELS.length; i++) {
      this.sum[i] += this.part[i];
      this.part[i] = 0;
    }
    this.frames++;
  }

  // Forgets the queries in flight (their results are thrown away as they come back).
  drop() {
    this.validFrom = this.frame;
    this.part.fill(0);
    this.partFrame = -1;
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
