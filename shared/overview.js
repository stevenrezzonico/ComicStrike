// The radar's map overview, made from the BSP at load time (CS:GO ships a drawn image
// per map; this game loads no images): the floors players can reach (shared/floorgrid.js,
// doors drawn open), each pixel showing its highest one, so roofs and the outside drop
// out and the ground under an overhang shows. Flat tones by height, lighter higher, with
// a dark line where the floor ends or steps more than a stair, like CS:GO's radars.
// Where walkable floors lie over one another (de_nuke's site B under A, de_vertigo's
// storeys) the map is cut into levels by altitude, as CS:GO's vertical sections do, and
// each level draws its own floors (`levels`, lowest first; `levelOf(z)`); `floor` and
// `rgba` keep the all-levels view (the highest floor everywhere).
// Pure JS (no canvas): the client puts the pixels into an image, tests read them.

import { FloorGrid, LAYERS, floorFaces, faceBounds } from './floorgrid.js';

const STEP = 40; // a height change bigger than a stair step draws a line (approx.)
const MARGIN = 8; // pixels of empty border
// Levels: two reached floors of a cell more than GAP apart (a standing player fits
// between) overlap; with OVERLAP_SHARE of the reached cells overlapping the map is cut
// at the altitude that separates the most of them, each side again while it still
// overlaps that much, up to MAX_LEVELS (approx.: CS:GO's sections are set by hand).
// Measured: de_nuke 32 % (cut at -576; CS:GO's lower section ends at -495), de_vertigo
// 36 %, cs_assault 15 % (the upper floor), cs_italy 5 %, de_train 4 %, de_dust2 none.
const GAP = 96;
const OVERLAP_SHARE = 0.1;
const MAX_LEVELS = 3;
const LEVEL_SHARE = 0.1; // of the reached floors a level must hold
const BIN = 32; // altitude bins of the split search

// Floor tones (low -> high) and the outline: printed paper tones and ink, like the game.
const LOW = [138, 124, 100];
const HIGH = [246, 238, 219];
const LINE = [23, 19, 15];

export class Overview {
  // size: pixels along the longer side.
  constructor(bsp, world, size = 512) {
    const faces = floorFaces(bsp);
    // A coarse pass finds the floors' extent (the faces' includes outside geometry).
    const [x0, y0, x1, y1] = new FloorGrid(bsp, world, Math.max(...extent(faceBounds(faces))) / 96,
      { faces, doorsOpen: true }).layerBounds();
    const scale = Math.max(x1 - x0, y1 - y0, 1) / (size - 2 * MARGIN);
    const grid = this.grid = new FloorGrid(bsp, world, scale, { bounds: [x0, y0, x1, y1], margin: MARGIN, faces,
      doorsOpen: true });
    this.scale = scale; // world units per pixel
    this.width = grid.w;
    this.height = grid.h;
    this.minX = grid.minX; // world x of pixel column 0's left edge
    this.maxY = grid.maxY; // world y of pixel row 0's top edge (north up)
    this.layers = grid.layers; // per pixel, LAYERS (6) floor heights (highest first)
    const top = this.floor = grid.topReached(); // the floor shown per pixel, or -Infinity

    let zLo = Infinity, zHi = -Infinity;
    for (const z of top) {
      if (z === -Infinity) continue;
      zLo = Math.min(zLo, z);
      zHi = Math.max(zHi, z);
    }
    this.rgba = paint(top, this.width, this.height, zLo, zHi);

    // The levels: altitude ranges [zMin, zMax), each drawn from its own highest floors.
    const cuts = this.cuts = findCuts(grid);
    this.levels = [];
    for (let l = 0; l <= cuts.length; l++) {
      const zMin = l === 0 ? -Infinity : cuts[l - 1], zMax = l === cuts.length ? Infinity : cuts[l];
      const floor = new Float32Array(top.length).fill(-Infinity);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < floor.length; i++) {
        for (let k = 0; k < LAYERS; k++) {
          const z = grid.layers[i * LAYERS + k];
          if (z === -Infinity) break;
          if (!grid.reached[i * LAYERS + k] || z < zMin || z >= zMax) continue;
          floor[i] = z;
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
          break;
        }
      }
      this.levels.push({ zMin, zMax, floor, rgba: cuts.length ? paint(floor, this.width, this.height, lo, hi) : this.rgba });
    }
  }

  // World (x, y) to pixel coordinates (fractional).
  px(x) {
    return (x - this.minX) / this.scale;
  }

  py(y) {
    return (this.maxY - y) / this.scale;
  }

  // The floor shown under world (x, y), or -Infinity (`level`: that level's).
  floorAt(x, y, level = -1) {
    const i = this.grid.index(x, y);
    return i < 0 ? -Infinity : level < 0 ? this.floor[i] : this.levels[level].floor[i];
  }

  // What the radar draws from, as plain data (client/overviewworker.js sends it to the
  // page): the levels' images and ranges, the scale and placement; not the floor grid.
  data() {
    const { scale, width, height, minX, maxY, cuts } = this;
    return { scale, width, height, minX, maxY, cuts, levels: this.levels.map(({ zMin, zMax, rgba }) => ({ zMin, zMax, rgba })) };
  }

  // An overview from data(): px, py and levelOf work; floorAt needs the grid it left behind.
  static from(data) {
    return Object.assign(Object.create(Overview.prototype), data);
  }

  // The level (index into `levels`) of a player whose feet are at altitude z.
  levelOf(z) {
    let l = 0;
    while (l < this.cuts.length && z >= this.cuts[l]) l++;
    return l;
  }
}

const extent = ([x0, y0, x1, y1]) => [x1 - x0, y1 - y0];

// The pixels of a floor map: tones from zLo (LOW) to zHi (HIGH), LINE where it ends or
// steps more than STEP, transparent where there is none.
function paint(top, w, h, zLo, zHi) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const span = Math.max(zHi - zLo, 1);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = py * w + px, z = top[i];
      if (z === -Infinity) continue;
      const edge = px === 0 || py === 0 || px === w - 1 || py === h - 1 ||
        !(Math.abs(top[i - 1] - z) <= STEP) || !(Math.abs(top[i + 1] - z) <= STEP) ||
        !(Math.abs(top[i - w] - z) <= STEP) || !(Math.abs(top[i + w] - z) <= STEP);
      const t = (z - zLo) / span, o = i * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = edge ? LINE[k] : LOW[k] + (HIGH[k] - LOW[k]) * t;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

// The altitudes that cut the map into levels, ascending (none: one level). Overlap
// pairs: consecutive reached floors of a cell more than GAP apart; a cut separates a pair
// when it lies between them.
export function findCuts(grid) {
  const n = grid.w * grid.h, pairs = [];
  let cells = 0;
  for (let i = 0; i < n; i++) {
    let last = -Infinity, any = false;
    for (let k = LAYERS - 1; k >= 0; k--) { // lowest first
      const z = grid.layers[i * LAYERS + k];
      if (z === -Infinity || !grid.reached[i * LAYERS + k]) continue;
      any = true;
      if (last !== -Infinity && z - last > GAP) pairs.push(last, z);
      last = z;
    }
    if (any) cells++;
  }
  const cuts = [];
  const ranges = [[-Infinity, Infinity]]; // ranges still to look at
  while (ranges.length && cuts.length < MAX_LEVELS - 1) {
    const [a, b] = ranges.pop();
    // The pairs inside this range; candidate cuts c_j = lo + j BIN (j >= 1) separate a
    // pair when low < c_j <= high (the floor at the cut goes to the upper level).
    let lo = Infinity, hi = -Infinity, count = 0;
    for (let p = 0; p < pairs.length; p += 2) {
      if (pairs[p] < a || pairs[p + 1] >= b) continue;
      lo = Math.min(lo, pairs[p]);
      hi = Math.max(hi, pairs[p + 1]);
      count++;
    }
    if (count < cells * OVERLAP_SHARE) continue;
    const bins = Math.floor((hi - lo) / BIN) + 1, hits = new Int32Array(bins + 2);
    for (let p = 0; p < pairs.length; p += 2) {
      if (pairs[p] < a || pairs[p + 1] >= b) continue;
      hits[Math.floor((pairs[p] - lo) / BIN) + 1]++;
      hits[Math.floor((pairs[p + 1] - lo) / BIN) + 1]--;
    }
    // Each side of the cut must hold a fair share of the range's cells (a cell counts on
    // a side when one of its reached floors lies there), or the level would be a sliver
    // (cs_italy's upper floors over the streets).
    const lows = new Int32Array(bins + 2), highs = new Int32Array(bins + 2);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let zMin = Infinity, zMax = -Infinity;
      for (let k = 0; k < LAYERS; k++) {
        const z = grid.layers[i * LAYERS + k];
        if (z === -Infinity) break;
        if (!grid.reached[i * LAYERS + k] || z < a || z >= b) continue;
        zMin = Math.min(zMin, z);
        zMax = Math.max(zMax, z);
      }
      if (zMin === Infinity) continue;
      total++;
      lows[Math.min(bins + 1, Math.max(0, Math.floor((zMin - lo) / BIN) + 1))]++;
      highs[Math.min(bins + 1, Math.max(0, Math.floor((zMax - lo) / BIN) + 1))]++;
    }
    let best = -1, bestHits = 0, run = 0, below = lows[0], above = total - highs[0];
    for (let j = 1; j <= bins; j++) { // the cut c_j = lo + j BIN: bins up to j lie below it
      run += hits[j];
      below += lows[j];
      above -= highs[j];
      if (run > bestHits && below >= total * LEVEL_SHARE && above >= total * LEVEL_SHARE) {
        bestHits = run;
        best = j;
      }
    }
    if (best < 0) continue;
    const cut = lo + best * BIN;
    if (findCuts.log) findCuts.log(a, b, count, cells, bestHits, cut);
    cuts.push(cut);
    ranges.push([a, cut], [cut, b]);
  }
  return cuts.sort((p, q) => p - q);
}
