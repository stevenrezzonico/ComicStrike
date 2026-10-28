// Procedural sound (zero assets): every sound is synthesized with WebAudio nodes, a
// handful per sound. Positional sounds go through a stereo pan and a distance gain
// from the listener (the eye), muffled by a low-pass behind walls or far away; a bus
// filter muffles everything while flashed. Browsers start an AudioContext suspended
// until a user gesture; resume() is called on the first click.

// Gunshot voices per weapon class: crack (noise band, level, decay), thump (sine
// frequency and decay), tail (low noise, seconds). Values are tuned by ear.
export const GUN_SOUNDS = {
  pistol: { hp: 600, lp: 7000, crack: 0.7, decay: 0.12, thump: 140, thumpDecay: 0.1, tail: 0.35 },
  heavy: { hp: 300, lp: 5000, crack: 1, decay: 0.2, thump: 90, thumpDecay: 0.18, tail: 0.6 },
  smg: { hp: 800, lp: 6500, crack: 0.6, decay: 0.09, thump: 160, thumpDecay: 0.08, tail: 0.3 },
  rifle: { hp: 400, lp: 6000, crack: 0.9, decay: 0.14, thump: 110, thumpDecay: 0.14, tail: 0.5 },
  sniper: { hp: 250, lp: 5000, crack: 1.1, decay: 0.3, thump: 70, thumpDecay: 0.3, tail: 1.0 },
  shotgun: { hp: 150, lp: 3500, crack: 1, decay: 0.25, thump: 60, thumpDecay: 0.25, tail: 0.7 },
  mg: { hp: 300, lp: 5500, crack: 0.95, decay: 0.16, thump: 95, thumpDecay: 0.15, tail: 0.6 },
  silenced: { hp: 1200, lp: 2500, crack: 0.35, decay: 0.06, thump: 0, thumpDecay: 0, tail: 0.05 },
};

// Mechanical clicks: band center (Hz), length (s), repeats.
const CLICKS = {
  dry: [4200, 0.025, 1], magout: [1800, 0.05, 1], magin: [2400, 0.04, 2], bolt: [3000, 0.035, 2],
  deploy: [2600, 0.03, 3], zoom: [5200, 0.015, 1], shell: [2000, 0.04, 1], mode: [3600, 0.02, 2],
  pin: [5600, 0.06, 1], defuse: [3200, 0.02, 1],
};

export class Sounds {
  constructor() {
    this.ctx = null;
    this.noise = null; // 1 s of white noise, shared by every noisy sound
    this.master = null; // every sound goes through it (the volume cvar)
    this.bus = null; // low-pass before the master: flashbangs muffle the world
    this.volume = 1;
    // Listener: eye position and view axes (world space), set every frame.
    this.lx = 0;
    this.ly = 0;
    this.lz = 0;
    this.rightX = 0;
    this.rightY = -1;
    this.fwdX = 1;
    this.fwdY = 0;
    this.occluded = null; // (x, y, z) -> true when a wall is between it and the listener
    this.ring = null; // the flashbang's ear ring (oscillator + gain), while it lasts
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
      this.bus = this.ctx.createBiquadFilter();
      this.bus.type = 'lowpass';
      this.bus.frequency.value = 20000;
      this.bus.connect(this.master);
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

  // The listener: eye position and view yaw (degrees).
  listen(x, y, z, yaw) {
    this.lx = x;
    this.ly = y;
    this.lz = z;
    const r = yaw * Math.PI / 180;
    this.fwdX = Math.cos(r);
    this.fwdY = Math.sin(r);
    this.rightX = Math.sin(r);
    this.rightY = -Math.cos(r);
  }

  // A voice at (x, y, z) (null: at the listener) with `volume` and distance reference
  // `ref`: returns the node to connect sources to and the start time, or null when it
  // would be inaudible. Behind walls and far away it is muffled.
  voice(x, y, z, volume, ref = 600, maxDist = 6000) {
    if (!this.ready) return null;
    const ctx = this.ctx;
    let gain = volume, pan = 0, cutoff = 20000;
    if (x !== null) {
      const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz, dist = Math.hypot(dx, dy, dz);
      if (dist > maxDist) return null;
      gain *= Sounds.falloff(dist, ref);
      const flat = Math.hypot(dx, dy) || 1;
      pan = Math.max(-1, Math.min(1, (dx * this.rightX + dy * this.rightY) / flat)) * Math.min(1, dist / 60) * 0.8;
      if ((dx * this.fwdX + dy * this.fwdY) / flat < -0.3) cutoff = 7000; // behind: a little duller
      cutoff = Math.min(cutoff, 20000 / (1 + dist / 1500));
      if (dist > 40 && this.occluded && this.occluded(x, y, z)) {
        cutoff = Math.min(cutoff, 900);
        gain *= 0.55;
      }
    }
    if (gain < 0.004) return null;
    const g = ctx.createGain();
    g.gain.value = gain;
    let head = g;
    if (cutoff < 19000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      g.connect(lp);
      head = lp;
    }
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      head.connect(p);
      head = p;
    }
    head.connect(this.bus);
    return { out: g, t: ctx.currentTime };
  }

  // Filtered noise burst into `out`: band hp..lp, level, attack to decay.
  burst(out, t, hp, lp, level, decay, delay = 0) {
    const ctx = this.ctx, src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const h = ctx.createBiquadFilter(), l = ctx.createBiquadFilter(), g = ctx.createGain();
    h.type = 'highpass';
    h.frequency.value = hp;
    l.type = 'lowpass';
    l.frequency.value = lp;
    const t0 = t + delay;
    g.gain.setValueAtTime(level, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + decay);
    src.connect(h).connect(l).connect(g).connect(out);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + decay + 0.02);
  }

  // Sine sweep into `out`: f0 -> f1 over the decay.
  tone(out, t, f0, f1, level, decay, delay = 0, type = 'sine') {
    const ctx = this.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    const t0 = t + delay;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + decay);
    g.gain.setValueAtTime(level, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + decay);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + decay + 0.02);
  }

  // A gunshot of profile `p` (GUN_SOUNDS) at (x, y, z) (null: our own gun). `pitch`
  // varies weapons of a class.
  gun(p, x, y, z, volume = 1, pitch = 1) {
    const v = this.voice(x, y, z, volume * 0.55, 900, 8000);
    if (!v) return;
    this.burst(v.out, v.t, p.hp * pitch, p.lp * pitch, p.crack, p.decay);
    if (p.thump) this.tone(v.out, v.t, p.thump * pitch, p.thump * 0.4, p.crack * 0.9, p.thumpDecay);
    if (p.tail > 0.1) this.burst(v.out, v.t, 80, 900, p.crack * 0.18, p.tail, 0.02);
  }

  // Mechanical click `name` (CLICKS) at (x, y, z) (null: ours), after `delay` seconds.
  click(name, x = null, y = 0, z = 0, volume = 1, delay = 0) {
    const v = this.voice(x, y, z, volume * 0.35, 250, 1200);
    if (!v) return;
    const [f, len, n] = CLICKS[name];
    for (let i = 0; i < n; i++) this.burst(v.out, v.t, f * 0.6, f * 1.6, 0.8, len, delay + i * 0.06);
    if (name === 'pin') this.tone(v.out, v.t, 2400, 2300, 0.15, 0.25, delay);
  }

  // A footstep on a surface kind: 'soft' (sand, dirt), 'metal', 'wood', else hard.
  step(kind, x = null, y = 0, z = 0, volume = 1) {
    const v = this.voice(x, y, z, volume * 0.5, 220, 1300);
    if (!v) return;
    const lp = kind === 'soft' ? 500 : kind === 'wood' ? 900 : 1300;
    this.burst(v.out, v.t, 60, lp * (0.85 + Math.random() * 0.3), 0.9, kind === 'soft' ? 0.09 : 0.06);
    if (kind === 'metal') this.tone(v.out, v.t, 900 + Math.random() * 300, 700, 0.12, 0.15);
    if (kind === 'wood') this.tone(v.out, v.t, 180, 120, 0.3, 0.08);
  }

  // Landing from a jump or fall.
  land(volume = 1) {
    const v = this.voice(null, 0, 0, volume * 0.6);
    if (!v) return;
    this.burst(v.out, v.t, 40, 600, 1, 0.12);
    this.tone(v.out, v.t, 90, 50, 0.6, 0.12);
  }

  // Knife or throw through the air.
  swish(x = null, y = 0, z = 0, volume = 1) {
    const v = this.voice(x, y, z, volume * 0.35, 250, 1200);
    if (!v) return;
    const ctx = this.ctx, src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    src.loop = true;
    bp.type = 'bandpass';
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(700, v.t);
    bp.frequency.exponentialRampToValueAtTime(2600, v.t + 0.18);
    g.gain.setValueAtTime(0.001, v.t);
    g.gain.exponentialRampToValueAtTime(0.9, v.t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, v.t + 0.22);
    src.connect(bp).connect(g).connect(v.out);
    src.start(v.t);
    src.stop(v.t + 0.25);
  }

  // Our bullet hit a player: a dull thwack; a helmet rings.
  hit(helmet, volume = 1) {
    const v = this.voice(null, 0, 0, volume * 0.45);
    if (!v) return;
    if (helmet) {
      this.tone(v.out, v.t, 4200, 4000, 0.35, 0.35);
      this.tone(v.out, v.t, 6400, 6200, 0.2, 0.25);
    } else {
      this.burst(v.out, v.t, 80, 900, 1, 0.1);
      this.tone(v.out, v.t, 140, 80, 0.5, 0.1);
    }
  }

  // A bullet striking the world near us.
  impact(x, y, z) {
    const v = this.voice(x, y, z, 0.25, 150, 700);
    if (!v) return;
    this.burst(v.out, v.t, 1500, 6000, 0.7, 0.05);
  }

  // A grenade bouncing.
  bounce(x, y, z) {
    const v = this.voice(x, y, z, 0.45, 200, 1200);
    if (!v) return;
    this.tone(v.out, v.t, 1400 + Math.random() * 400, 900, 0.5, 0.12, 0, 'triangle');
    this.burst(v.out, v.t, 600, 3000, 0.4, 0.05);
  }

  // A flashbang going off.
  bang(x, y, z) {
    const v = this.voice(x, y, z, 1.2, 600, 6000);
    if (!v) return;
    this.burst(v.out, v.t, 900, 9000, 1, 0.3);
    this.tone(v.out, v.t, 1300, 900, 0.4, 0.4);
  }

  // A smoke grenade's hiss.
  hiss(x, y, z) {
    const v = this.voice(x, y, z, 0.6, 300, 2000);
    if (!v) return;
    this.burst(v.out, v.t, 2500, 9000, 0.5, 2.5);
  }

  // One crackle of a fire.
  crackle(x, y, z) {
    const v = this.voice(x, y, z, 0.35, 200, 1500);
    if (!v) return;
    this.burst(v.out, v.t, 900 + Math.random() * 1500, 5000, 0.6 + Math.random() * 0.4, 0.04 + Math.random() * 0.05);
  }

  // A door moving for `seconds`: a sliding door rumbles, a swinging one creaks (pitch
  // wandering) over a softer rumble.
  doorMove(x, y, z, seconds, swinging) {
    const v = this.voice(x, y, z, 0.5, 300, 2500);
    if (!v) return;
    const ctx = this.ctx, t = v.t, end = t + Math.min(Math.max(seconds, 0.2), 6);
    const src = ctx.createBufferSource(), l = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    src.loop = true;
    l.type = 'lowpass';
    l.frequency.value = swinging ? 300 : 500;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(swinging ? 0.25 : 0.6, t + 0.08);
    g.gain.setValueAtTime(swinging ? 0.25 : 0.6, end - 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, end);
    src.connect(l).connect(g).connect(v.out);
    src.start(t, Math.random() * 0.5);
    src.stop(end + 0.02);
    if (!swinging) return;
    const osc = ctx.createOscillator(), og = ctx.createGain(), bp = ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    const f = 150 + Math.random() * 60;
    osc.frequency.setValueAtTime(f, t);
    for (let k = 1, tk = t + 0.15; tk < end; k++, tk += 0.15) osc.frequency.linearRampToValueAtTime(f * (k & 1 ? 1.35 : 0.85), tk);
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 2;
    og.gain.setValueAtTime(0.001, t);
    og.gain.exponentialRampToValueAtTime(0.12, t + 0.1);
    og.gain.setValueAtTime(0.12, end - 0.15);
    og.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(bp).connect(og).connect(v.out);
    osc.start(t);
    osc.stop(end + 0.02);
  }

  // A door or button reaching the end of its travel.
  doorStop(x, y, z) {
    const v = this.voice(x, y, z, 0.7, 300, 2500);
    if (!v) return;
    this.burst(v.out, v.t, 60, 700, 0.8, 0.18);
    this.tone(v.out, v.t, 140, 60, 0.5, 0.15);
  }

  // Flashed for `seconds`: a ringing in the ears, the world muffled meanwhile.
  earRing(seconds) {
    if (!this.ready || seconds <= 0) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this.ring) {
      this.ring.osc.stop();
      this.ring = null;
    }
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = 3500;
    g.gain.setValueAtTime(0.06 * Math.min(1, seconds / 3), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds + 0.5);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.6);
    this.ring = { osc };
    osc.onended = () => {
      if (this.ring && this.ring.osc === osc) this.ring = null;
    };
    const f = this.bus.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(500, t);
    f.exponentialRampToValueAtTime(20000, t + seconds + 0.5);
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
    osc.connect(gain).connect(this.bus);
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
    src.connect(lp).connect(gain).connect(this.bus);
    src.start(t);
    src.stop(t + 3);
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.8);
    og.gain.setValueAtTime(0.8 * volume, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc.connect(og).connect(this.bus);
    osc.start(t);
    osc.stop(t + 1);
  }
}
