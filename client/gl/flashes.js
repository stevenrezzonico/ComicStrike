// Flash lights: muzzle flashes and explosions brighten the world around them for a moment
// (GoldSrc's dynamic lights, printed: the light channel rises, so the shade dots there
// thin out and vanish), and a burning fire holds a steady, flickering one. At most
// MAX_FLASHES lights at once: the held ones first (at most MAX_HELD), then the flashes,
// the newest replacing whichever has least left; WORLD_FS adds them up per pixel. Nothing
// allocated per frame.

export const MAX_FLASHES = 4;
export const MAX_HELD = 2;

export class FlashLights {
  constructor() {
    this.pos = new Float32Array(MAX_FLASHES * 4); // x, y, z, radius: the u_flash uniform
    this.k = new Float32Array(MAX_FLASHES); // strength now: u_flashK
    this.count = 0; // lights alive after update(): the first `count` of pos / k
    // The flashes, in their own slots.
    this.fpos = new Float32Array(MAX_FLASHES * 4);
    this.peak = new Float32Array(MAX_FLASHES);
    this.end = new Float64Array(MAX_FLASHES);
    this.dur = new Float32Array(MAX_FLASHES).fill(1);
    // The held lights: a key each, kept while hold() is called for it between updates.
    this.hkey = new Float64Array(MAX_HELD);
    this.hpos = new Float32Array(MAX_HELD * 4);
    this.hk = new Float32Array(MAX_HELD);
    this.hfresh = new Uint8Array(MAX_HELD); // held since the last update
    this.hn = 0;
  }

  // A flash at (x, y, z) reaching r units, `strength` of full light at its middle,
  // fading out over `dur` seconds from `time`.
  add(x, y, z, r, strength, dur, time) {
    let slot = 0;
    for (let i = 1; i < MAX_FLASHES; i++) if (this.end[i] < this.end[slot]) slot = i;
    this.fpos[slot * 4] = x;
    this.fpos[slot * 4 + 1] = y;
    this.fpos[slot * 4 + 2] = z;
    this.fpos[slot * 4 + 3] = r;
    this.peak[slot] = strength;
    this.dur[slot] = dur;
    this.end[slot] = time + dur;
  }

  // A steady light under `key` (a burning fire's id): kept while hold() is called for it
  // every frame, dropped at the first update() it was not; a new one when MAX_HELD are
  // held already is left out.
  hold(key, x, y, z, r, strength) {
    let slot = -1;
    for (let i = 0; i < this.hn; i++) if (this.hkey[i] === key) slot = i;
    if (slot < 0) {
      if (this.hn === MAX_HELD) return;
      slot = this.hn++;
      this.hkey[slot] = key;
    }
    this.hpos[slot * 4] = x;
    this.hpos[slot * 4 + 1] = y;
    this.hpos[slot * 4 + 2] = z;
    this.hpos[slot * 4 + 3] = r;
    this.hk[slot] = strength;
    this.hfresh[slot] = 1;
  }

  // Fades the flashes to `time`, drops the held lights not refreshed since the last
  // update, and packs the live ones: held first, then the flashes while there is room.
  update(time) {
    let n = 0;
    for (let i = 0; i < this.hn; i++) {
      if (!this.hfresh[i]) continue;
      if (i !== n) {
        this.hkey[n] = this.hkey[i];
        for (let c = 0; c < 4; c++) this.hpos[n * 4 + c] = this.hpos[i * 4 + c];
        this.hk[n] = this.hk[i];
      }
      this.hfresh[n] = 0;
      n++;
    }
    this.hn = n;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) this.pos[i * 4 + c] = this.hpos[i * 4 + c];
      this.k[i] = this.hk[i];
    }
    for (let i = 0; i < MAX_FLASHES && n < MAX_FLASHES; i++) {
      const left = this.end[i] - time;
      if (left <= 0) continue;
      for (let c = 0; c < 4; c++) this.pos[n * 4 + c] = this.fpos[i * 4 + c];
      this.k[n] = this.peak[i] * Math.min(1, left / this.dur[i]);
      n++;
    }
    this.count = n;
  }

  clear() {
    this.end.fill(0);
    this.hn = 0;
    this.hfresh.fill(0);
    this.count = 0;
  }
}
