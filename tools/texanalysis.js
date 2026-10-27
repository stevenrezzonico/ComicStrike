// Offline texture analysis for tools/gen_texturedata.js (never shipped to the browser):
// measures what the flat procedural materials need from an original GoldSrc texture,
// its main color and whether it repeats in lines (bricks, tiles, planks), without
// keeping any pixels.

const MAX_SIZE = 256; // analysis resolution cap (box-downsampled)
const MAX_COUNT = 32; // most lines per texture axis
const FOLD = 32; // bins of a period-folded profile

const STAGGER_RANDOM = 255;

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Box-downsamples to at most MAX_SIZE per axis (power-of-two textures stay exact).
function shrink(t) {
  let { w, h, rgba } = t;
  while (w > MAX_SIZE || h > MAX_SIZE) {
    const fx = w > MAX_SIZE ? 2 : 1, fy = h > MAX_SIZE ? 2 : 1;
    const nw = w / fx | 0, nh = h / fy | 0;
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) s += rgba[((y * fy + j) * w + x * fx + i) * 4 + c];
          out[(y * nw + x) * 4 + c] = Math.round(s / (fx * fy));
        }
      }
    }
    w = nw;
    h = nh;
    rgba = out;
  }
  return { w, h, rgba };
}

// Cosine / sine tables per profile length.
const trig = new Map();
function table(n) {
  let t = trig.get(n);
  if (!t) {
    t = { cos: new Float64Array(n), sin: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      t.cos[i] = Math.cos(2 * Math.PI * i / n);
      t.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    trig.set(n, t);
  }
  return t;
}

// Power of the periodic profile p (circular) at integer frequency k.
function power(p, k) {
  const n = p.length, t = table(n);
  let re = 0, im = 0;
  for (let i = 0, j = 0; i < n; i++, j = (j + k) % n) {
    re += p[i] * t.cos[j];
    im -= p[i] * t.sin[j];
  }
  return (re * re + im * im) / (n * n);
}

// Spectrum (k = 0..n/2) of a profile, or the sum of several profiles' spectra.
function spectrum(profiles) {
  const n = profiles[0].length;
  const out = new Float64Array((n >> 1) + 1);
  for (const p of profiles) for (let k = 1; k < out.length; k++) out[k] += power(p, k);
  return out;
}

// Best line count of a spectrum: the fundamental n >= 2 whose harmonics (up to periods
// of 4 samples) hold the most energy beyond the 1/n a featureless spectrum would put
// there, where the fundamental itself is strong.
// Returns { n, share } (share: that excess, 0..1). A single line per texture (n = 1:
// every tiling profile is periodic over the whole texture) is returned with share 1
// when nothing repeats; the caller then judges its shape.
function bestCount(spec, len) {
  let best = 0, bestS = 0;
  const top = Math.min(MAX_COUNT, len >> 2);
  let total = 0;
  for (let k = 1; k <= len >> 2; k++) total += spec[k];
  // From the most lines down: a coarser count (whose harmonics include the finer one's)
  // has to be clearly better to win.
  for (let n = top; n >= 2; n--) {
    let e = 0, peak = 0;
    for (let k = n; k <= len >> 2; k += n) {
      e += spec[k];
      if (spec[k] > peak) peak = spec[k];
    }
    if (spec[n] < 0.5 * peak || total <= 0) continue;
    const base = Math.floor((len >> 2) / n) / (len >> 2); // a flat spectrum's share
    const sc = (e / total - base) / (1 - base);
    if (sc > bestS * 1.15) {
      best = n;
      bestS = sc;
    }
  }
  if (bestS < 0.25) return { n: total > 0 ? 1 : 0, share: 1 };
  return { n: best, share: bestS };
}

// Folds profile p into FOLD bins over one period of n lines starting at offset `shift`
// (in samples). Returns the folded means.
function fold(p, n, shift = 0) {
  const len = p.length;
  const sum = new Float64Array(FOLD), cnt = new Float64Array(FOLD);
  for (let i = 0; i < len; i++) {
    let f = ((i + 0.5 - shift) * n / len) % 1;
    if (f < 0) f += 1;
    const b = Math.min(FOLD - 1, f * FOLD | 0);
    sum[b] += p[i];
    cnt[b]++;
  }
  for (let b = 0; b < FOLD; b++) sum[b] = cnt[b] ? sum[b] / cnt[b] : NaN;
  // Empty bins (short profiles): copy the nearest filled neighbour.
  for (let b = 0; b < FOLD; b++) {
    if (!Number.isNaN(sum[b])) continue;
    for (let d = 1; d < FOLD; d++) {
      const v = sum[(b + d) % FOLD];
      if (!Number.isNaN(v)) {
        sum[b] = v;
        break;
      }
    }
  }
  return sum;
}

// Line of a folded profile: its phase (bin center / FOLD), half width (fraction of the
// period) and depth (median minus the extreme, signed: > 0 dark lines, < 0 bright).
function lineOf(f) {
  const sorted = Float64Array.from(f).sort();
  const med = sorted[FOLD >> 1];
  let lo = 0, hi = 0;
  for (let b = 1; b < FOLD; b++) {
    if (f[b] < f[lo]) lo = b;
    if (f[b] > f[hi]) hi = b;
  }
  const dark = med - f[lo] >= f[hi] - med;
  const at = dark ? lo : hi;
  const depth = dark ? med - f[lo] : -(f[hi] - med);
  // Width: contiguous bins around the extreme past half the depth.
  const half = med - depth / 2;
  let wd = 1;
  for (let d = 1; d < FOLD / 2; d++) {
    const a = f[(at + d) % FOLD], b = f[(at - d + FOLD) % FOLD];
    const inA = dark ? a < half : a > half, inB = dark ? b < half : b > half;
    if (!inA && !inB) break;
    wd += (inA ? 1 : 0) + (inB ? 1 : 0);
  }
  return { phase: (at + 0.5) / FOLD, width: Math.min(0.5, wd / FOLD / 2), depth };
}

// Grid search on a scalar field f (w*h): rows of lines, then columns per row band.
function findGrid(f, w, h) {
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += f[y * w + x];
    rows[y] = s / w;
  }
  const g = { ny: 0, nx: 0, phaseY: 0, phaseX: 0, widthY: 0, widthX: 0, depthY: 0, depthX: 0, stagger: 0, shareY: 0, shareX: 0 };
  const ry = bestCount(spectrum([rows]), h);
  if (ry.n) {
    const l = lineOf(fold(rows, ry.n));
    Object.assign(g, { ny: ry.n, phaseY: l.phase, widthY: l.width, depthY: l.depth, shareY: ry.share });
  }

  // Bands: the rows between horizontal lines (the whole texture without them).
  const bands = [];
  const nb = g.ny || 1;
  for (let b = 0; b < nb; b++) {
    const y0 = (b + g.phaseY + g.widthY) * h / nb, y1 = (b + 1 + g.phaseY - g.widthY) * h / nb;
    const p = new Float64Array(w);
    let cnt = 0;
    for (let yy = Math.ceil(y0); yy < y1; yy++) {
      const y = yy % h;
      for (let x = 0; x < w; x++) p[x] += f[y * w + x];
      cnt++;
    }
    if (!cnt) continue;
    for (let x = 0; x < w; x++) p[x] /= cnt;
    bands.push(p);
  }
  if (!bands.length) return g;
  const rx = bestCount(spectrum(bands), w);
  if (!rx.n) return g;

  // Per band phase; the stagger is their consistent step (else random offsets).
  const phases = bands.map((p) => lineOf(fold(p, rx.n)).phase);
  let sx = 0, sy = 0;
  for (let b = 1; b < phases.length; b++) {
    const a = 2 * Math.PI * (phases[b] - phases[b - 1]);
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const steps = phases.length - 1;
  let stagger = 0;
  if (steps > 0) {
    const r = Math.hypot(sx, sy) / steps;
    stagger = r > 0.7 ? ((Math.atan2(sy, sx) / (2 * Math.PI)) % 1 + 1) % 1 : STAGGER_RANDOM;
    if (stagger !== STAGGER_RANDOM && (stagger < 0.04 || stagger > 0.96)) stagger = 0;
  }
  // Re-fold every band aligned to its own phase for one shared line shape.
  const aligned = new Float64Array(FOLD);
  bands.forEach((p, b) => {
    const shift = stagger === STAGGER_RANDOM ? (phases[b] - phases[0]) * w / rx.n : stagger * b * w / rx.n;
    const fp = fold(p, rx.n, shift);
    for (let i = 0; i < FOLD; i++) aligned[i] += fp[i] / bands.length;
  });
  const l = lineOf(aligned);
  Object.assign(g, { nx: rx.n, phaseX: l.phase, widthX: l.width, depthX: l.depth, stagger, shareX: rx.share });
  return g;
}

const MAX_BANDS = 2;

// Color bands: stretches of rows (axis 0) or columns (axis 1) whose mean color departs
// from the rest, like a wooden wainscot under a plaster wall or a trim strip. Returns
// { axis, bands: [{ start, end, color }] } (start / end: fractions, end may wrap below
// start) for the axis where the bands carry more of the texture.
function findBands(rgba, A, w, h) {
  let best = { axis: 0, bands: [], score: 0 };
  for (const axis of [0, 1]) {
    const len = axis ? w : h, across = axis ? h : w;
    const col = [];
    for (let a = 0; a < len; a++) {
      const c = [0, 0, 0];
      let k = 0;
      for (let b = 0; b < across; b++) {
        const i = axis ? b * w + a : a * w + b;
        if (A[i] <= 0.5) continue;
        for (let ch = 0; ch < 3; ch++) c[ch] += rgba[i * 4 + ch];
        k++;
      }
      col.push(k ? c.map((v) => v / k) : null);
    }
    if (col.some((c) => !c)) continue;
    const base = [0, 1, 2].map((ch) => col.map((c) => c[ch]).sort((p, q) => p - q)[len >> 1]);
    const dist = col.map((c) => Math.hypot(c[0] - base[0], c[1] - base[1], c[2] - base[2]));
    const sorted = [...dist].sort((p, q) => p - q);
    const thr = Math.max(20, 3 * sorted[len >> 1]);
    // Runs of departing lines (circular), bridging one-line gaps.
    const on = dist.map((d) => d > thr);
    for (let a = 0; a < len; a++) if (!on[a] && on[(a - 1 + len) % len] && on[(a + 1) % len]) on[a] = true;
    if (on.every(Boolean) || !on.some(Boolean)) continue;
    const first = on.findIndex((v) => !v); // start scanning at a base line
    const runs = [];
    for (let k = 0; k < len; k++) {
      const a = (first + k) % len;
      if (on[a] && !on[(a - 1 + len) % len]) runs.push({ s: a, n: 0, d: 0 });
      if (on[a]) {
        runs.at(-1).n++;
        runs.at(-1).d += dist[a];
      }
    }
    const bands = runs.filter((r) => r.n >= Math.max(3, len * 0.04)).sort((p, q) => q.d - p.d).slice(0, MAX_BANDS);
    const score = bands.reduce((t, r) => t + r.d, 0) / len;
    if (score > best.score) {
      best = {
        axis, score,
        bands: bands.map((r) => {
          const c = [0, 0, 0];
          for (let k = 0; k < r.n; k++) for (let ch = 0; ch < 3; ch++) c[ch] += col[(r.s + k) % len][ch] / r.n;
          return { start: r.s / len, end: ((r.s + r.n) % len) / len, color: c, s: r.s, n: r.n };
        }),
      };
    }
  }
  return best;
}

// Analyzes one texture { name, w, h, rgba } -> { mean, ny, nx, bands } or null (fully
// transparent). mean is the main surface's average color: color bands (a wooden
// wainscot under a plaster wall, a trim strip) are left out of it. ny / nx count the
// repeating lines of rows and per row (0 when none show).
export function analyze(tex) {
  const { w, h, rgba } = shrink(tex);
  const n = w * h;
  const alphaTex = tex.name[0] === '{';
  const L = new Float64Array(n), A = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = lum(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    A[i] = rgba[i * 4 + 3] / 255;
  }
  const bands = alphaTex ? { axis: 0, bands: [] } : findBands(rgba, A, w, h);
  const main = new Uint8Array(n); // opaque and outside the bands
  for (let i = 0; i < n; i++) main[i] = A[i] > 0.5 ? 1 : 0;
  for (const b of bands.bands) {
    for (let j = 0; j < b.n; j++) {
      const a = (b.s + j) % (bands.axis ? w : h);
      for (let o = 0; o < (bands.axis ? h : w); o++) main[bands.axis ? o * w + a : a * w + o] = 0;
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += main[i];
  if (count < n * 0.2 && bands.bands.length) { // mostly bands: one plain surface
    bands.bands = [];
    for (let i = 0; i < n; i++) main[i] = A[i] > 0.5 ? 1 : 0;
    count = 0;
    for (let i = 0; i < n; i++) count += main[i];
  }
  if (!count) return null;

  const mean = [0, 0, 0];
  let lm = 0, l2 = 0;
  for (let i = 0; i < n; i++) {
    if (!main[i]) continue;
    for (let c = 0; c < 3; c++) mean[c] += rgba[i * 4 + c] / count;
    lm += L[i] / count;
    l2 += L[i] * L[i] / count;
  }
  // Repeating lines, judged on luminance in units of the texture's own contrast
  // (alpha-tested textures on their alpha).
  const unit = 1.75 * Math.max(2, Math.sqrt(Math.max(0, l2 - lm * lm)));
  const N = new Float64Array(n);
  for (let i = 0; i < n; i++) N[i] = main[i] ? (L[i] - lm) / unit : 0;
  const g = findGrid(alphaTex ? A : N, w, h);
  const min = alphaTex ? 0.25 : 0.35;
  const ny = g.ny >= 2 && Math.abs(g.depthY) >= min && g.shareY > 0.3 ? g.ny : 0;
  const nx = g.nx >= 2 && Math.abs(g.depthX) >= min && g.shareX > 0.3 ? g.nx : 0;
  return { mean, ny, nx, bands: bands.bands.map(({ start, end, color }) => ({ start, end, color })), bandAxis: bands.axis };
}
