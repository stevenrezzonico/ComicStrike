// The C4's explosion as a moment in slow motion: a shockwave front grows from the bomb to
// the farthest the blast hurts (3.5 bomb radii), the kill zones stay marked for a few
// seconds, victims fall when the front reaches them, and the camera takes the hit as it
// passes. Visual only: the server deals the damage at once (CS:GO's rule) and the game
// goes on at full speed; the effects (the front, the fireball, debris, the victims' falls)
// run on clock.fx, which this slows down for the first seconds (`rate`). The composite
// paints the front, the zones and the dome from `front`, `marks`, `dome` and `impact`
// (renderer.style.blast). Nothing allocates per frame.

import { bombDamage, bombRangeFor } from '../shared/bomb.js';
import { clock } from './clock.js';

export const SLOW = 0.15; // the effects' speed for the first HOLD seconds: a hit-stop
export const HOLD = 0.5;
export const RAMP = 2; // then back to full speed over this long (s)
export const WAVE = 2.6; // effect seconds for the front to reach the farthest it hurts
export const MARKS = 6.5; // seconds the zones and lines show (the round restarts at 7)
export const MARKS_FADE = 1.5; // fading over the last this long
export const IMPACT_MS = 160; // the impact frame as the front passes the camera: full, then fading
const IMPACT_FULL_MS = 70;

// The effects' speed `age` seconds after the explosion: SLOW, then eased back to 1.
export function fxRate(age) {
  if (!(age >= 0)) return 1;
  if (age < HOLD) return SLOW;
  const x = Math.min(1, (age - HOLD) / RAMP);
  return SLOW + (1 - SLOW) * x * x * (3 - 2 * x);
}

// The front's radius `s` effect seconds after the explosion: fast at first, slowing to a
// stop at `range` (a blast wave decelerates), cubic ease-out over WAVE.
export function frontRadius(s, range) {
  if (!(s > 0)) return 0;
  if (s >= WAVE) return range;
  const u = 1 - s / WAVE;
  return range * (1 - u * u * u);
}

export class BombFx {
  constructor() {
    this.at = -1e9; // performance.now() of the explosion (ms)
    this.fx0 = -0; // clock.fx then
    this.x = -0;
    this.y = -0;
    this.z = -0;
    this.radius = -0; // the map's bombradius
    this.range = -0; // the farthest it hurts
    this.killArmor = -0; // the farthest it kills a player with kevlar (100 health, 100 armor)
    this.killBare = -0; // and without
    this.front = -0; // the front's radius now (0: no wave)
    this.marks = -0; // the zones' and lines' strength, 0..1
    this.dome = -0; // the dome's strength, 0..1
    this.impact = -0; // the impact frame, 0..1
    this.passAt = -1e9; // when the front passed the camera (ms)
    this.passHit = -0; // the blast's damage there over the bomb's radius, 0..1
    this.ids = new Int32Array(64); // victims waiting for the front, and their distances
    this.dist = new Float64Array(64);
    this.waiting = 0;
    this.self = false; // we died of it: our death waits for the front too
    this.selfDist = -0;
  }

  // The bomb went off at (x, y, z), radius its map's bombradius, `now` performance.now().
  start(x, y, z, radius, now) {
    this.at = now;
    this.fx0 = clock.fx;
    this.x = x;
    this.y = y;
    this.z = z;
    this.radius = radius;
    this.range = radius * 3.5;
    this.killArmor = bombRangeFor(radius, 200); // half of it reaches the health through kevlar
    this.killBare = bombRangeFor(radius, 100);
    this.front = 0;
    this.marks = 1;
    this.dome = 1;
    this.impact = 0;
    this.passAt = -1e9;
    this.passHit = 0;
    this.waiting = 0;
    this.self = false;
  }

  clear() {
    this.at = -1e9;
    this.front = 0;
    this.marks = 0;
    this.dome = 0;
    this.impact = 0;
    this.waiting = 0;
    this.self = false;
  }

  get active() {
    return this.marks > 0;
  }

  // The effects' speed at `now`.
  rate(now) {
    return now - this.at < MARKS * 1000 ? fxRate((now - this.at) / 1000) : 1;
  }

  distTo(x, y, z) {
    const dx = x - this.x, dy = y - this.y, dz = z - this.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Once a frame, after clock.fx moved: the front, the marks, the dome and the impact frame
  // for a camera at `eye`. True in the frame the front passes the camera (within its reach).
  update(now, eye) {
    if (this.at < 0) return false;
    const age = (now - this.at) / 1000;
    if (age > MARKS) { // over: whoever still waits falls now (reached), and the marks go
      this.at = -1e9;
      this.front = this.range;
      this.marks = 0;
      this.dome = 0;
      this.impact = 0;
      return false;
    }
    this.front = frontRadius(clock.fx - this.fx0, this.range);
    this.marks = age < MARKS - MARKS_FADE ? 1 : (MARKS - age) / MARKS_FADE;
    this.dome = Math.max(0, Math.min(1, (this.range - this.front) / (0.25 * this.range)));
    let passed = false;
    const d = this.distTo(eye[0], eye[1], eye[2]);
    if (this.passAt < 0 && d <= this.front && d < this.range) {
      this.passAt = now;
      this.passHit = bombDamage(this.radius, d) / this.radius;
      passed = true;
    }
    const since = now - this.passAt;
    this.impact = since < IMPACT_FULL_MS ? 1 : since < IMPACT_MS ? 1 - (since - IMPACT_FULL_MS) / (IMPACT_MS - IMPACT_FULL_MS) : 0;
    return passed;
  }

  // Player `id`, `dist` from the bomb, was killed by it: his fall waits for the front.
  hold(id, dist) {
    if (this.waiting >= this.ids.length) return false;
    this.ids[this.waiting] = id;
    this.dist[this.waiting++] = Math.min(dist, this.range); // (the front stops at the range)
    return true;
  }

  // The waiting victims the front has reached, into `out` (ids); returns how many.
  reached(out) {
    let n = 0, k = 0;
    for (let i = 0; i < this.waiting; i++) {
      if (this.dist[i] <= this.front) out[n++] = this.ids[i];
      else {
        this.ids[k] = this.ids[i];
        this.dist[k++] = this.dist[i];
      }
    }
    this.waiting = k;
    return n;
  }

  // Whether player `id` still waits for the front.
  holds(id) {
    for (let i = 0; i < this.waiting; i++) if (this.ids[i] === id) return true;
    return false;
  }

  // We died of it at `dist` from the bomb: our death panel and spectating wait for the front.
  killedSelf(dist) {
    this.self = true;
    this.selfDist = dist;
  }

  get selfWaiting() {
    return this.self && this.at >= 0 && this.front < this.selfDist;
  }

  // The camera's shake at `now`: degrees of pitch and yaw into `out`, from how hard the
  // front hit where we stood, dying away over a second.
  shake(now, out) {
    const t = (now - this.passAt) / 1000;
    if (!(t >= 0 && t < 1.2) || this.passHit <= 0) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const a = (1.5 + 4 * this.passHit) * Math.exp(-t * 4);
    out[0] = a * Math.sin(t * 61);
    out[1] = a * 0.7 * Math.sin(t * 47 + 1.3);
  }
}
