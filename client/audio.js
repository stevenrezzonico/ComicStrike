// Procedural sound (zero assets): every sound is synthesized with WebAudio nodes, a
// handful per sound. Positional sounds go through a stereo pan and a distance gain
// from the listener (the eye), muffled by a low-pass behind walls or far away; a bus
// filter muffles everything while flashed. Browsers start an AudioContext suspended
// until a user gesture; resume() is called on the first click.
//
// The voice is a cartoon's, not a war film's. Nothing starts with a crack: every sound
// swells in over 8-20 ms (a hard edge is what makes a step sound like a hammer), noise is
// a low "puff" (mostly under 1 kHz), and the character comes from round sine voices: a
// gunshot is a "POW" (a sine gliding down an octave or two, like a pop gun), a step a
// padded "pum". Everything also goes into a small generated room echo (wetter far away),
// a treble shelf and a gentle compressor, so loud moments round off instead of slamming.

// Gunshot voices per weapon class: pow (sine [from Hz, to Hz, seconds, level]), puff
// (low noise [low-pass Hz, level, seconds]), boom (low sine [Hz, level, seconds] or null),
// rise (s to swell in), tail (s of low rumble). Tuned by measuring rise time and spectral
// centroid of offline renders, then by ear.
export const GUN_SOUNDS = {
  pistol: { pow: [520, 170, 0.09, 0.7], puff: [900, 0.4, 0.08], boom: [110, 0.3, 0.1], rise: 0.01, tail: 0.2 },
  heavy: { pow: [380, 110, 0.13, 0.8], puff: [700, 0.55, 0.14], boom: [80, 0.55, 0.18], rise: 0.012, tail: 0.4 },
  smg: { pow: [600, 210, 0.07, 0.6], puff: [1000, 0.35, 0.06], boom: [120, 0.25, 0.07], rise: 0.009, tail: 0.15 },
  rifle: { pow: [440, 140, 0.1, 0.75], puff: [800, 0.45, 0.1], boom: [95, 0.4, 0.13], rise: 0.011, tail: 0.3 },
  sniper: { pow: [320, 90, 0.16, 0.85], puff: [600, 0.55, 0.2], boom: [70, 0.65, 0.3], rise: 0.014, tail: 0.7 },
  shotgun: { pow: [300, 85, 0.14, 0.8], puff: [500, 0.7, 0.2], boom: [65, 0.65, 0.25], rise: 0.014, tail: 0.5 },
  mg: { pow: [420, 130, 0.1, 0.75], puff: [750, 0.5, 0.11], boom: [90, 0.45, 0.14], rise: 0.011, tail: 0.35 },
  silenced: { pow: [700, 350, 0.05, 0.22], puff: [1000, 0.3, 0.07], boom: null, rise: 0.012, tail: 0 }, // "pfft"
};

// Mechanical clicks: band center (Hz), length (s), repeats. The draw (deploy) is one low soft
// click: it was three bright ones on every switch, wheel notch and buy, and tired the ear.
const CLICKS = {
  dry: [3000, 0.025, 1], magout: [1300, 0.05, 1], magin: [1700, 0.04, 2], bolt: [2100, 0.035, 2],
  deploy: [1100, 0.03, 1], zoom: [3400, 0.015, 1], shell: [1500, 0.04, 1], mode: [2500, 0.02, 2],
  pin: [3600, 0.06, 1], defuse: [2300, 0.02, 1],
};

const ATTACK = 0.008; // s a noise burst takes to swell to its level (tones: 3/4 of it)
const ROOM = 0.18; // room echo send near the listener
const ROOM_FAR = 0.35; // more of it far away
const MUSIC_LEVEL = 0.6; // the jingles at snd_musicvolume 1: their chords stay under the compressor's knee
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// The comic jingles (client/jingles.js says when): short synthesized stingers, each under 2 s,
// played by Sounds.jingle into `out` from time t; each returns its length. A cartoon
// brass section (two detuned saws through a lowpass that opens on the attack), plucks,
// a drone, ticks.
export const JINGLES = {
  // The round goes live: a two-note brass hit, up a fourth, on a soft kick.
  start(out, t) {
    this.brass(out, t, 67, 0.1, 0.07);
    for (const m of [72, 76]) this.brass(out, t + 0.13, m, 0.38, m === 72 ? 0.08 : 0.05);
    this.tone(out, t, 110, 55, 0.22, 0.18, 0.13);
    return 0.7;
  },
  // The bomb is planted: a low drone on A with its fifth, pulsing, under a ticking clock.
  planted(out, t) {
    this.drone(out, t, 45, 1.6, 0.11);
    this.drone(out, t, 52, 1.6, 0.05);
    for (let i = 0; i < 6; i++) this.tone(out, t, 1500, 1500, 0.05, 0.03, 0.15 + i * 0.25, 'triangle');
    return 1.75;
  },
  // The last 10 seconds: a rising run of plucks over a rising swish.
  ten(out, t) {
    [72, 74, 76, 79, 81, 84].forEach((m, i) => this.pluck(out, t + i * 0.08, m, 0.06));
    this.riser(out, t, 0.65, 0.05);
    return 0.85;
  },
  // Our side won the round: a major cadence, IV - V - I.
  won(out, t) {
    this.chord(out, t, [65, 69, 72], 0.18, 0.055);
    this.chord(out, t + 0.22, [67, 71, 74], 0.18, 0.055);
    this.chord(out, t + 0.44, [72, 76, 79], 0.62, 0.055);
    return 1.2;
  },
  // Our side lost: the minor one, iv - V - i, duller, the last chord sagging.
  lost(out, t) {
    this.chord(out, t, [65, 68, 72], 0.22, 0.05, 0.7);
    this.chord(out, t + 0.27, [67, 71, 74], 0.22, 0.05, 0.7);
    this.chord(out, t + 0.54, [60, 63, 67], 0.5, 0.055, 0.6, -60);
    return 1.2;
  },
  // The match is over (won, or a mode without sides): a fanfare up the C major triad to a
  // held chord with a cymbal.
  match(out, t) {
    [[67, 0, 0.1], [72, 0.13, 0.1], [76, 0.26, 0.1], [79, 0.39, 0.22], [76, 0.66, 0.12]]
      .forEach(([m, at, d]) => this.brass(out, t + at, m, d, 0.07));
    this.chord(out, t + 0.84, [72, 76, 79, 84], 0.75, 0.045);
    this.tone(out, t, 110, 50, 0.22, 0.25, 0.84);
    this.burst(out, t, 5000, 12000, 0.05, 0.9, 0.84);
    return 1.85;
  },
};

export class Sounds {
  constructor() {
    this.ctx = null;
    this.noise = null; // 1 s of white noise, shared by every noisy sound
    this.master = null; // every sound goes through it (the volume cvar)
    this.bus = null; // low-pass before the master: flashbangs muffle the world
    this.room = null; // the room echo (a convolver), fed by every voice
    this.stepVolume = 1; // footsteps, ours and others' (snd_footstep_volume)
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
    this.music = 0.5; // snd_musicvolume: the jingles
    this.musicBus = null;
    this.jingleOut = null; // the jingle playing (its gain), until jingleEnd
    this.jingleEnd = 0;
  }

  setMusic(v) {
    this.music = v;
    if (this.musicBus) this.musicBus.gain.value = v * MUSIC_LEVEL;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  resume() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.attach(new AC());
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Builds the output chain on an audio context (an OfflineAudioContext renders sounds
  // for measuring): bus (flash muffle) -> treble shelf -> compressor -> master.
  attach(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    comp.connect(this.master);
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 4500;
    shelf.gain.value = -6;
    shelf.connect(comp);
    this.bus = ctx.createBiquadFilter();
    this.bus.type = 'lowpass';
    this.bus.frequency.value = 20000;
    this.bus.connect(shelf);
    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    // The room: a convolver over a generated impulse (0.7 s of dark noise dying away,
    // each ear its own), fed by every voice's send, back into the bus.
    const len = Math.round(n * 0.7), ir = ctx.createBuffer(2, len, n), k = 1 - Math.exp(-2 * Math.PI * 2200 / n);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      let lo = 0;
      for (let i = 0; i < len; i++) {
        lo += k * (Math.random() * 2 - 1 - lo);
        ch[i] = lo * Math.exp(-i / (n * 0.16)) * Math.min(1, i / (n * 0.006));
      }
    }
    this.room = ctx.createConvolver();
    this.room.buffer = ir;
    this.room.connect(this.bus);
    // The jingles: dry, through the same chain as the game (muffled by a flash too).
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.music * MUSIC_LEVEL;
    this.musicBus.connect(this.bus);
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
    let gain = volume, pan = 0, cutoff = 20000, wet = ROOM;
    if (x !== null) {
      const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz, dist = Math.hypot(dx, dy, dz);
      if (dist > maxDist) return null;
      gain *= Sounds.falloff(dist, ref);
      wet += ROOM_FAR * dist / (dist + 1500);
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
    if (this.room) {
      const send = ctx.createGain();
      send.gain.value = wet;
      head.connect(send).connect(this.room);
    }
    return { out: g, t: ctx.currentTime };
  }

  // Filtered noise burst into `out`: band hp..lp, swelling to `level` over `attack`,
  // then dying away over `decay`.
  burst(out, t, hp, lp, level, decay, delay = 0, attack = ATTACK) {
    const ctx = this.ctx, src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const h = ctx.createBiquadFilter(), l = ctx.createBiquadFilter(), g = ctx.createGain();
    h.type = 'highpass';
    h.frequency.value = hp;
    l.type = 'lowpass';
    l.frequency.value = lp;
    const t0 = t + delay, end = t0 + attack + decay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.001, end);
    src.connect(h).connect(l).connect(g).connect(out);
    src.start(t0, Math.random() * 0.5);
    src.stop(end + 0.02);
  }

  // Sine sweep into `out`: f0 -> f1, swelling over `attack`, dying over `decay`.
  tone(out, t, f0, f1, level, decay, delay = 0, type = 'sine', attack = ATTACK * 0.75) {
    const ctx = this.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    const t0 = t + delay, end = t0 + attack + decay;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), end);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(end + 0.02);
  }

  // A gunshot of profile `p` (GUN_SOUNDS) at (x, y, z) (null: our own gun). `pitch`
  // varies weapons of a class.
  gun(p, x, y, z, volume = 1, pitch = 1) {
    const v = this.voice(x, y, z, volume * 0.6, 900, 8000);
    if (!v) return;
    const [f0, f1, powTime, powLevel] = p.pow, [lp, puffLevel, puffTime] = p.puff;
    this.tone(v.out, v.t, f0 * pitch, f1 * pitch, powLevel, powTime, 0, 'sine', p.rise);
    this.burst(v.out, v.t, 50, lp * pitch, puffLevel, puffTime, 0, p.rise * 1.4);
    if (p.boom) this.tone(v.out, v.t, p.boom[0], p.boom[0] * 0.6, p.boom[1], p.boom[2], 0, 'sine', p.rise * 1.6);
    if (p.tail) this.burst(v.out, v.t, 50, 450, puffLevel * 0.2, p.tail, 0.01, 0.04);
  }

  // Mechanical click `name` (CLICKS) at (x, y, z) (null: ours), after `delay` seconds.
  click(name, x = null, y = 0, z = 0, volume = 1, delay = 0) {
    const v = this.voice(x, y, z, volume * 0.35, 250, 1200);
    if (!v) return;
    const [f, len, n] = CLICKS[name];
    for (let i = 0; i < n; i++) { // a wooden "clok" more than a metal click
      this.burst(v.out, v.t, f * 0.4, f, 0.3, len, delay + i * 0.06, 0.005);
      this.tone(v.out, v.t, f * 0.45, f * 0.38, 0.35, len * 1.5, delay + i * 0.06, 'sine', 0.004);
    }
    if (name === 'pin') this.tone(v.out, v.t, 1800, 1750, 0.12, 0.25, delay);
  }

  // A footstep on a surface kind: 'soft' (sand, dirt), 'metal', 'wood', 'water' (a
  // splash), 'wade' (a bigger one), else hard. Heard
  // all game long, so it is quiet, dark and never quite the same twice: a heel and a toe
  // scuff (two low noise puffs 30-50 ms apart, each swelling in over ~20 ms; a sharp start
  // sounds like a hammer) and no repeated note, which is what tires the ear. Wood adds a
  // faint hollow knock, metal a faint ring. `stepVolume` is the snd_footstep_volume cvar.
  step(kind, x = null, y = 0, z = 0, volume = 1) {
    const v = this.voice(x, y, z, volume * this.stepVolume * 0.45, 220, 1300);
    if (!v) return;
    const r = 0.85 + Math.random() * 0.3;
    if (kind === 'water' || kind === 'wade') return this.splash(v.out, v.t, kind === 'wade' ? 1 : 0.4, r);
    const lp = (kind === 'soft' ? 300 : kind === 'wood' ? 420 : kind === 'metal' ? 520 : 380) * r;
    this.burst(v.out, v.t, 60, lp, 0.5, 0.06, 0, 0.02);
    this.burst(v.out, v.t, 90, lp * 1.25, 0.3, 0.05, 0.03 + Math.random() * 0.02, 0.018);
    if (kind === 'wood') this.tone(v.out, v.t, 210 * r, 190 * r, 0.05, 0.07, 0, 'sine', 0.015);
    if (kind === 'metal') this.tone(v.out, v.t, 480 * r, 470 * r, 0.03, 0.2, 0, 'sine', 0.015);
  }

  // A cartoon splash into `out`, `size` 0.4 (a step in shallow water: "splish") to 1
  // (wading: "sploosh") or more (landing): noise through a band-pass sweeping down from
  // bright to dull, swelling in like every step, and two or three bubbles, quick rising
  // sine "plips", at random moments in it. `r` varies the pitch from step to step.
  splash(out, t, size, r) {
    const ctx = this.ctx, src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    const len = 0.1 + 0.15 * size;
    src.buffer = this.noise;
    src.loop = true;
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(1500 * r, t);
    bp.frequency.exponentialRampToValueAtTime(450 * r, t + len);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3 + 0.25 * size, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.02 + len);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.05);
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const f = (500 + Math.random() * 400) * (1 - 0.25 * Math.min(size, 1.4));
      this.tone(out, t, f, f * 1.6, 0.04 + 0.03 * size, 0.035, 0.03 + Math.random() * len, 'sine', 0.006);
    }
  }

  // Landing from a jump or fall; in water (`kind` 'water' / 'wade') a big splash.
  land(volume = 1, kind = 'hard') {
    const v = this.voice(null, 0, 0, volume * 0.5);
    if (!v) return;
    if (kind === 'water' || kind === 'wade') {
      this.splash(v.out, v.t, 1.4, 0.9 + Math.random() * 0.2);
      this.tone(v.out, v.t, 220, 120, 0.25, 0.12, 0, 'sine', 0.015); // "bloop"
      return;
    }
    this.burst(v.out, v.t, 40, 400, 0.8, 0.14, 0, 0.02);
    this.tone(v.out, v.t, 100, 55, 0.6, 0.14, 0, 'sine', 0.018);
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
    bp.frequency.exponentialRampToValueAtTime(1800, v.t + 0.18);
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
    if (helmet) { // a cartoon "ding"
      this.tone(v.out, v.t, 2600, 2500, 0.3, 0.4);
      this.tone(v.out, v.t, 3900, 3800, 0.1, 0.25);
    } else { // a padded "thup"
      this.burst(v.out, v.t, 80, 600, 0.75, 0.1, 0, 0.012);
      this.tone(v.out, v.t, 180, 90, 0.55, 0.12, 0, 'sine', 0.01);
    }
  }

  // A bullet striking the world near us.
  impact(x, y, z) {
    const v = this.voice(x, y, z, 0.25, 150, 700);
    if (!v) return;
    this.burst(v.out, v.t, 600, 2000, 0.35, 0.05, 0, 0.008);
    this.tone(v.out, v.t, 420, 300, 0.25, 0.06, 0, 'sine', 0.007); // "tok"
  }

  // A spent casing landing: a small high "tink".
  tink(x, y, z) {
    const v = this.voice(x, y, z, 0.12, 100, 500);
    if (!v) return;
    const f = 2400 + Math.random() * 500;
    this.tone(v.out, v.t, f, f * 0.96, 0.2, 0.05);
  }

  // A grenade bouncing.
  bounce(x, y, z) {
    const v = this.voice(x, y, z, 0.45, 200, 1200);
    if (!v) return;
    const f = 850 + Math.random() * 250; // "bonk"
    this.tone(v.out, v.t, f, f * 0.75, 0.4, 0.12);
    this.burst(v.out, v.t, 300, 1200, 0.2, 0.05, 0, 0.008);
  }

  // A flashbang going off.
  bang(x, y, z) {
    const v = this.voice(x, y, z, 0.9, 600, 6000);
    if (!v) return;
    this.burst(v.out, v.t, 250, 2000, 0.8, 0.35, 0, 0.025); // "POOF"
    this.tone(v.out, v.t, 700, 280, 0.45, 0.35, 0, 'sine', 0.02);
  }

  // A smoke grenade's hiss.
  hiss(x, y, z) {
    const v = this.voice(x, y, z, 0.6, 300, 2000);
    if (!v) return;
    this.burst(v.out, v.t, 1500, 5000, 0.35, 2.4, 0, 0.15);
  }

  // One crackle of a fire.
  crackle(x, y, z) {
    const v = this.voice(x, y, z, 0.35, 200, 1500);
    if (!v) return;
    this.burst(v.out, v.t, 500 + Math.random() * 600, 1800, 0.4 + Math.random() * 0.3, 0.04 + Math.random() * 0.05, 0, 0.007);
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
    this.burst(v.out, v.t, 60, 600, 0.7, 0.18, 0, 0.01);
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
    osc.frequency.value = 2800;
    g.gain.setValueAtTime(0.04 * Math.min(1, seconds / 3), t);
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

  // Jingle `name` (JINGLES; client/jingles.js), unless the music is off or a flashbang's
  // ringing is on: one at a time, a new one cutting the last short. Returns whether it plays.
  jingle(name) {
    if (!this.ready || this.music <= 0 || !JINGLES[name] || this.ring) return false;
    const ctx = this.ctx, t = ctx.currentTime + 0.02;
    if (this.jingleOut && t < this.jingleEnd) {
      const g = this.jingleOut.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(1, t);
      g.linearRampToValueAtTime(0, t + 0.06);
    }
    const out = ctx.createGain();
    out.connect(this.musicBus);
    this.jingleOut = out;
    this.jingleEnd = t + JINGLES[name].call(this, out, t);
    return true;
  }

  // A brass note (midi) into `out` at t for dur s: two saws a little apart through a
  // lowpass that opens on the attack (`bright` scales it), swelling in, settling, dying
  // after; `bend`: cents it sags by the end.
  brass(out, t, midi, dur, level, bright = 1, bend = 0) {
    const ctx = this.ctx, f = mtof(midi), end = t + dur + 0.15;
    const g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(f * 1.2, t);
    lp.frequency.linearRampToValueAtTime(f * 5 * bright, t + 0.035);
    lp.frequency.exponentialRampToValueAtTime(f * 2.5 * bright, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.02);
    g.gain.linearRampToValueAtTime(level * 0.75, t + Math.min(0.12, dur));
    g.gain.setValueAtTime(level * 0.75, t + dur);
    g.gain.exponentialRampToValueAtTime(0.001, end);
    lp.connect(g).connect(out);
    for (const det of [-8, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.setValueAtTime(det, t);
      if (bend) o.detune.linearRampToValueAtTime(det + bend, t + dur);
      o.connect(lp);
      o.start(t);
      o.stop(end + 0.02);
    }
  }

  chord(out, t, notes, dur, level, bright = 1, bend = 0) {
    for (const m of notes) this.brass(out, t, m, dur, level, bright, bend);
  }

  // A plucked note: a triangle and a quieter octave over it, dying fast.
  pluck(out, t, midi, level, decay = 0.25) {
    const f = mtof(midi);
    this.tone(out, t, f, f, level, decay, 0, 'triangle');
    this.tone(out, t, f * 2, f * 2, level * 0.3, decay * 0.6);
  }

  // A low drone (midi) for dur s: a saw under a dark lowpass, swelling in, pulsing four
  // times a second, dying at the end.
  drone(out, t, midi, dur, level) {
    const ctx = this.ctx, o = ctx.createOscillator(), lp = ctx.createBiquadFilter();
    const trem = ctx.createGain(), lfo = ctx.createOscillator(), depth = ctx.createGain(), env = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    trem.gain.value = 0.7;
    lfo.frequency.value = 4;
    depth.gain.value = 0.3;
    lfo.connect(depth).connect(trem.gain);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.4);
    env.gain.setValueAtTime(level, t + dur - 0.3);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(trem).connect(env).connect(out);
    for (const s of [o, lfo]) {
      s.start(t);
      s.stop(t + dur + 0.02);
    }
  }

  // Noise through a band that rises from 400 Hz to 4 kHz over dur s, swelling and fading.
  riser(out, t, dur, level) {
    const ctx = this.ctx, src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    src.loop = true;
    bp.type = 'bandpass';
    bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(4000, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // The C4's beep: a short triangle-wave chirp.
  beep(volume = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 1700;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16 * volume, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  // Explosion: a round "BOOM": low-passed noise swelling in with a long tail, plus a
  // falling sine.
  explosion(volume = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 2.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.7 * volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 3);
    src.connect(lp).connect(gain).connect(this.bus);
    src.start(t);
    src.stop(t + 3);
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.frequency.setValueAtTime(75, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.7 * volume, t + 0.015);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc.connect(og).connect(this.bus);
    osc.start(t);
    osc.stop(t + 1);
  }
}
