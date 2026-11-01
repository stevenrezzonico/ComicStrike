// Frames in flight: how many drawn frames the browser's GPU pipeline may hold before the
// page draws another (a native engine's "max pre-rendered frames"). A browser with its
// vsync off runs requestAnimationFrame as fast as the page returns; the page then fills the
// GPU process's command buffer faster than it is executed, every queued frame is a frame of
// mouse lag, and once the buffer is full the next GL call blocks the page for tens of ms
// (measured on a gaming PC: frames 0.5 ms apart, 7+ frames queued, a 25-50 ms stall twice a
// second). A fence (SYNC_GPU_COMMANDS_COMPLETE) goes in after each drawn frame; the GPU has
// passed it once its status reads SIGNALED (Chrome updates that a task later, which is why
// it cannot measure lag, but it gates well: the next frame's poll sees it). With `ahead`
// fences still pending the frame is not drawn (the ticks and the mouse still run).
//
// At ease a vsync-paced browser sees a frame's fence 1-2 frames later, so `ahead` 3 never
// holds a frame back there; it only bites when frames pile up. A fence older than STALE_MS
// is given up (a lost context, a driver that never signals: the game must keep drawing).

export const STALE_MS = 500;
const RING = 16;

export class FrameGate {
  constructor(gl) {
    this.gl = gl;
    this.fences = new Array(RING).fill(null);
    this.at = new Float64Array(RING); // when each fence went in
    this.head = 0;
    this.size = 0;
    this.skipped = 0; // frames not drawn (counted for the benchmark)
    this.stale = 0; // fences given up
  }

  // Drops the fences the GPU has passed. True when a frame may be drawn with at most
  // `ahead` still pending (0: no gate).
  ready(ahead, now) {
    const gl = this.gl;
    while (this.size) {
      const f = this.fences[this.head];
      const passed = gl.getSyncParameter(f, gl.SYNC_STATUS) === gl.SIGNALED;
      if (!passed && now - this.at[this.head] < STALE_MS) break;
      if (!passed) this.stale++;
      gl.deleteSync(f);
      this.fences[this.head] = null;
      this.head = (this.head + 1) % RING;
      this.size--;
    }
    if (ahead <= 0 || this.size < ahead) return true;
    this.skipped++;
    return false;
  }

  // After a drawn frame: a fence behind its commands.
  drawn(now) {
    if (this.size === RING) return;
    const gl = this.gl, i = (this.head + this.size) % RING;
    this.fences[i] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.at[i] = now;
    this.size++;
    gl.flush(); // the fence reaches the GPU with the frame, not with the next one's commands
  }

  // Forgets every fence (a context loss).
  reset() {
    for (let i = 0; i < RING; i++) {
      if (this.fences[i]) this.gl.deleteSync(this.fences[i]);
      this.fences[i] = null;
    }
    this.head = this.size = 0;
  }
}
