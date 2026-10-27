// Procedural sound (zero assets): every sound is synthesized with WebAudio nodes.
// Browsers start an AudioContext suspended until a user gesture; resume() is called
// on the first click.

export class Sounds {
  constructor() {
    this.ctx = null;
    this.noise = null; // 1 s of white noise, shared by every noisy sound
    this.master = null; // every sound goes through it (the volume cvar)
    this.volume = 1;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  resume() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      const n = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  // Volume for a sound at distance `dist` (units).
  static falloff(dist, ref = 400) {
    return ref / (ref + dist);
  }

  // The C4's beep: a short square-wave chirp.
  beep(volume = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 2100;
    gain.gain.setValueAtTime(0.12 * volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  // Explosion: low-passed noise with a long tail, plus a thump.
  explosion(volume = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 2.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9 * volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 3);
    src.connect(lp).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 3);
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.8);
    og.gain.setValueAtTime(0.8 * volume, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 1);
  }
}
