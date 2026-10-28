// Flash lights: muzzle flashes and explosions brighten the world around them for a moment
// (GoldSrc's dynamic lights, printed: the light channel rises, so the shade dots there
// thin out and vanish). At most MAX_FLASHES at once, the newest replacing whichever has
// least left; WORLD_FS adds them up per pixel. Nothing allocated per frame.

export const MAX_FLASHES = 4;

export class FlashLights {
  constructor() {
    this.pos = new Float32Array(MAX_FLASHES * 4); // x, y, z, radius: the u_flash uniform
    this.k = new Float32Array(MAX_FLASHES); // strength now: u_flashK
    this.peak = new Float32Array(MAX_FLASHES);
    this.end = new Float64Array(MAX_FLASHES);
    this.dur = new Float32Array(MAX_FLASHES).fill(1);
    this.count = 0; // flashes alive after update(): the first `count` slots
  }

  // A flash at (x, y, z) reaching r units, `strength` of full light at its middle,
  // fading out over `dur` seconds from `time`.
  add(x, y, z, r, strength, dur, time) {
    let slot = 0;
    for (let i = 1; i < MAX_FLASHES; i++) if (this.end[i] < this.end[slot]) slot = i;
    this.pos[slot * 4] = x;
    this.pos[slot * 4 + 1] = y;
    this.pos[slot * 4 + 2] = z;
    this.pos[slot * 4 + 3] = r;
    this.peak[slot] = strength;
    this.dur[slot] = dur;
    this.end[slot] = time + dur;
  }

  // Fades the flashes to `time` and packs the live ones first.
  update(time) {
    let n = 0;
    for (let i = 0; i < MAX_FLASHES; i++) {
      const left = this.end[i] - time;
      if (left <= 0) continue;
      if (i !== n) { // move it down so the live ones are 0..n-1
        for (let c = 0; c < 4; c++) this.pos[n * 4 + c] = this.pos[i * 4 + c];
        this.peak[n] = this.peak[i];
        this.dur[n] = this.dur[i];
        this.end[n] = this.end[i];
        this.end[i] = 0;
      }
      this.k[n] = this.peak[n] * Math.min(1, left / this.dur[n]);
      n++;
    }
    this.count = n;
  }

  clear() {
    this.end.fill(0);
    this.count = 0;
  }
}
