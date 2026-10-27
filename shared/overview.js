// The radar's map overview, made from the BSP at load time (CS:GO ships a drawn image
// per map; this game loads no images). Every upward face of the world and the solid
// brush entities is rasterized top-down into up to LAYERS floor heights per pixel,
// keeping only floors a crouching player fits on. A flood fill from the spawn points
// (and hostages) then walks those floors the way a player can: onto a neighbor's highest
// floor at most a jump above, falling any distance, up ladders. Each pixel shows its
// highest reachable floor, so unreachable roofs drop out and the ground under an
// overhang shows. Flat tones by height, lighter higher, with a dark line where the floor
// ends or steps more than a stair, like CS:GO's radars. Pure JS (no canvas): the client
// puts the pixels into an image, tests read them.

import {
  entityModelIndex, faceNumEdges, facePlane, faceSide, faceTexinfo, faceVertex, modelFirstFace, modelNumFaces,
  parseVec3,
} from './bsp.js';
import { hullFits, HULL_DUCK, ENT_LADDER, ENT_NONE } from './trace.js';

const FLOOR_NZ = 0.7; // walkable slope (sv_walkable_normal)
const TEX_SPECIAL = 1; // texinfo flag: sky / water
const LAYERS = 6; // floor heights kept per pixel (the highest go first when full)
const MERGE = 16; // floors closer than this are one
const STAIR = 18; // sv_stepsize: walked up without a jump
const CLIMB = 64; // a crouch jump reaches about this high (approx.)
const STEP = 40; // a height change bigger than a stair step draws a line (approx.)
const MARGIN = 8; // pixels of empty border
const NONSOLID = new Set(['func_illusionary', 'func_ladder', 'func_water', 'func_buyzone', 'func_bomb_target',
  'func_hostage_rescue', 'func_vip_safetyzone', 'func_escapezone']);
const DOORS = new Set(['func_door', 'func_door_rotating']); // open in play: they do not cut floors
const SEEDS = new Set(['info_player_start', 'info_player_deathmatch', 'hostage_entity']);

// Floor tones (low -> high) and the outline (CS:GO's overviews: grey-beige floors).
const LOW = [86, 84, 76];
const HIGH = [196, 190, 172];
const LINE = [30, 31, 32];

export class Overview {
  // size: pixels along the longer side. `bounds` [x0, y0, x1, y1] (world): from a coarse
  // first pass (the faces' extent includes outside geometry nobody stands on).
  constructor(bsp, world, size = 512, faces = null, bounds = null) {
    const doors = [];
    for (const e of world.ents) {
      if (e.bspEntity >= 0 && DOORS.has(bsp.entities[e.bspEntity].classname) && e.kind !== ENT_NONE) {
        doors.push([e, e.kind]);
        e.kind = ENT_NONE;
      }
    }
    try {
      faces = faces || floorFaces(bsp);
      if (!bounds) bounds = new Overview(bsp, world, 96, faces, faceBounds(faces)).layerBounds();
      this.build(bsp, world, size, faces, bounds);
    } finally {
      for (const [e, kind] of doors) e.kind = kind;
    }
  }

  build(bsp, world, size, faces, [x0, y0, x1, y1]) {
    this.scale = Math.max(x1 - x0, y1 - y0, 1) / (size - 2 * MARGIN); // world units per pixel
    this.width = Math.ceil((x1 - x0) / this.scale) + 2 * MARGIN;
    this.height = Math.ceil((y1 - y0) / this.scale) + 2 * MARGIN;
    this.minX = x0 - MARGIN * this.scale; // world x of pixel column 0's left edge
    this.maxY = y1 + MARGIN * this.scale; // world y of pixel row 0's top edge (north up)
    const w = this.width, h = this.height;
    this.layers = new Float32Array(w * h * LAYERS).fill(-Infinity); // per pixel, highest first
    for (const f of faces) this.raster(f, world);

    const top = this.floor = this.reachable(bsp, world); // the floor shown per pixel, or -Infinity
    let zLo = Infinity, zHi = -Infinity;
    for (const z of top) {
      if (z === -Infinity) continue;
      zLo = Math.min(zLo, z);
      zHi = Math.max(zHi, z);
    }
    this.minZ = zLo;
    this.maxZ = zHi;
    const rgba = this.rgba = new Uint8ClampedArray(w * h * 4);
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
  }

  // Flood fill over the floor layers from the spawn points; returns the highest reached
  // floor per pixel. Maps without spawns show every standable floor.
  reachable(bsp, world) {
    const w = this.width, h = this.height, L = this.layers, n = w * h;
    const reached = new Uint8Array(n * LAYERS);
    const queue = new Int32Array(n * LAYERS);
    let head = 0, tail = 0;
    const visit = (cell) => {
      if (reached[cell]) return;
      reached[cell] = 1;
      queue[tail++] = cell;
    };
    // The highest floor of pixel i at most `limit` high, as a cell (pixel * LAYERS + layer), or -1.
    const landing = (i, limit) => {
      for (let k = 0; k < LAYERS; k++) {
        const z = L[i * LAYERS + k];
        if (z === -Infinity) return -1;
        if (z <= limit) return i * LAYERS + k;
      }
      return -1;
    };
    const o = new Float32Array(3);
    for (const e of bsp.entities) {
      if (!SEEDS.has(e.classname)) continue;
      parseVec3(e.origin, o);
      const px = Math.floor(this.px(o[0])), py = Math.floor(this.py(o[1]));
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const cell = landing(py * w + px, o[2] + 8);
      if (cell >= 0) visit(cell);
    }
    if (!tail) return this.topLayer();
    const ladder = this.ladders(world); // per pixel: the top of a ladder there, or -Infinity
    while (head < tail) {
      const cell = queue[head++], i = Math.floor(cell / LAYERS), z = L[cell];
      const limit = (ladder[i] > z - CLIMB ? Math.max(z, ladder[i]) : z) + CLIMB;
      const px = i % w, py = (i - px) / w;
      // Onto a neighbor: the floor we walk or fall onto (its highest at most a stair up),
      // and any floor a jump (or the ladder) reaches above it.
      for (let s = 0; s < 4; s++) {
        if ((s === 0 && px === 0) || (s === 1 && px === w - 1) || (s === 2 && py === 0) || (s === 3 && py === h - 1)) continue;
        const j = i + (s === 0 ? -1 : s === 1 ? 1 : s === 2 ? -w : w);
        const c = landing(j, z + STAIR);
        if (c >= 0) visit(c);
        for (let k = 0; k < LAYERS; k++) {
          const z2 = L[j * LAYERS + k];
          if (z2 > z + STAIR && z2 <= limit) visit(j * LAYERS + k);
        }
      }
      if (ladder[i] > -Infinity) { // on a ladder: every floor of this pixel up to its top
        for (let k = 0; k < LAYERS; k++) if (L[i * LAYERS + k] > z && L[i * LAYERS + k] <= limit) visit(i * LAYERS + k);
      }
    }
    const top = new Float32Array(n).fill(-Infinity);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < LAYERS; k++) {
        if (reached[i * LAYERS + k]) {
          top[i] = L[i * LAYERS + k];
          break;
        }
      }
    }
    return top;
  }

  // Per pixel: the highest ladder top over it (a pixel of slack around each ladder).
  ladders(world) {
    const w = this.width, h = this.height, out = new Float32Array(w * h).fill(-Infinity);
    for (const e of world.ents) {
      if (e.kind !== ENT_LADDER) continue;
      const a = Math.floor(this.px(e.ox + e.mins[0])) - 1, b = Math.floor(this.px(e.ox + e.maxs[0])) + 1;
      const c = Math.floor(this.py(e.oy + e.maxs[1])) - 1, d = Math.floor(this.py(e.oy + e.mins[1])) + 1;
      for (let py = Math.max(0, c); py <= Math.min(h - 1, d); py++) {
        for (let px = Math.max(0, a); px <= Math.min(w - 1, b); px++) {
          out[py * w + px] = Math.max(out[py * w + px], e.oz + e.maxs[2]);
        }
      }
    }
    return out;
  }

  topLayer() {
    const n = this.width * this.height, top = new Float32Array(n);
    for (let i = 0; i < n; i++) top[i] = this.layers[i * LAYERS];
    return top;
  }

  // World bounds [x0, y0, x1, y1] of every standable floor (a pixel of slack around).
  layerBounds() {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let py = 0; py < this.height; py++) {
      for (let px = 0; px < this.width; px++) {
        if (this.layers[(py * this.width + px) * LAYERS] === -Infinity) continue;
        a = Math.min(a, px);
        c = Math.max(c, px + 1);
        b = Math.min(b, py);
        d = Math.max(d, py + 1);
      }
    }
    if (a === Infinity) return [0, 0, 1, 1];
    const s = this.scale;
    return [this.minX + (a - 1) * s, this.maxY - (d + 1) * s, this.minX + (c + 1) * s, this.maxY - (b - 1) * s];
  }

  // World (x, y) to pixel coordinates (fractional).
  px(x) {
    return (x - this.minX) / this.scale;
  }

  py(y) {
    return (this.maxY - y) / this.scale;
  }

  // The floor shown under world (x, y), or -Infinity.
  floorAt(x, y) {
    const px = Math.floor(this.px(x)), py = Math.floor(this.py(y));
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return -Infinity;
    return this.floor[py * this.width + px];
  }

  // Scanline fill of a convex polygon: each pixel center inside gets the face's height
  // there as a floor layer if a crouching player fits on it.
  raster(f, world) {
    const { xs, ys, nx, ny, nz, d } = f, n = xs.length, w = this.width;
    let pyMin = Infinity, pyMax = -Infinity;
    for (let i = 0; i < n; i++) {
      pyMin = Math.min(pyMin, this.py(ys[i]));
      pyMax = Math.max(pyMax, this.py(ys[i]));
    }
    for (let py = Math.max(0, Math.ceil(pyMin - 0.5)); py <= Math.min(this.height - 1, Math.floor(pyMax - 0.5)); py++) {
      const wy = this.maxY - (py + 0.5) * this.scale;
      let xa = Infinity, xb = -Infinity;
      for (let i = 0; i < n; i++) {
        const ax = xs[i], ay = ys[i], bx = xs[(i + 1) % n], by = ys[(i + 1) % n];
        if ((ay > wy) === (by > wy)) continue;
        const x = ax + (wy - ay) / (by - ay) * (bx - ax);
        xa = Math.min(xa, x);
        xb = Math.max(xb, x);
      }
      if (xa > xb) continue;
      for (let px = Math.max(0, Math.ceil(this.px(xa) - 0.5)); px <= Math.min(w - 1, Math.floor(this.px(xb) - 0.5)); px++) {
        const wx = this.minX + (px + 0.5) * this.scale;
        const z = (d - nx * wx - ny * wy) / nz;
        if (this.hasLayer(py * w + px, z)) continue;
        if (this.fits(world, wx, wy, z)) this.addLayer(py * w + px, z);
      }
    }
  }

  // Does a crouching player fit on floor z at (x, y)? Uneven ground (terrain, curbs)
  // lifts him by up to a stair step, so the hull is tried a little higher too.
  fits(world, x, y, z) {
    for (let up = 0; up <= STAIR; up += STAIR / 2) {
      if (hullFits(world, HULL_DUCK, x, y, z + 19 + up)) return true; // duck hull center 18 above the feet
    }
    return false;
  }

  hasLayer(i, z) {
    for (let k = 0; k < LAYERS; k++) if (Math.abs(this.layers[i * LAYERS + k] - z) < MERGE) return true;
    return false;
  }

  // Inserts floor z into pixel i's layers (highest first); when full the highest goes.
  addLayer(i, z) {
    const L = this.layers, o = i * LAYERS;
    let k = LAYERS - 1;
    if (L[o + k] !== -Infinity) { // full: drop the highest
      if (z > L[o]) return;
      L.copyWithin(o, o + 1, o + LAYERS);
      L[o + k] = -Infinity;
    }
    while (k > 0 && L[o + k - 1] < z) {
      L[o + k] = L[o + k - 1];
      k--;
    }
    L[o + k] = z;
  }
}

function faceBounds(faces) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of faces) {
    for (let i = 0; i < f.xs.length; i++) {
      x0 = Math.min(x0, f.xs[i]);
      x1 = Math.max(x1, f.xs[i]);
      y0 = Math.min(y0, f.ys[i]);
      y1 = Math.max(y1, f.ys[i]);
    }
  }
  return faces.length ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

// Upward faces (floor-like) of the world and solid brush entities, in world space:
// { xs, ys (corners), nx, ny, nz, d (plane: n . p = d) }.
function floorFaces(bsp) {
  const models = [[0, 0, 0, 0]];
  const o = new Float32Array(3);
  for (const e of bsp.entities) {
    const m = entityModelIndex(e), cls = e.classname || '';
    if (m <= 0 || !cls.startsWith('func_') || NONSOLID.has(cls)) continue;
    parseVec3(e.origin, o);
    models.push([m, o[0], o[1], o[2]]);
  }
  const out = [];
  for (const [m, ox, oy, oz] of models) {
    const first = modelFirstFace(bsp, m), count = modelNumFaces(bsp, m);
    for (let f = first; f < first + count; f++) {
      const ti = faceTexinfo(bsp, f);
      if (bsp.texinfoI[ti * 10 + 9] & TEX_SPECIAL) continue;
      const p = facePlane(bsp, f), s = faceSide(bsp, f) ? -1 : 1;
      const nx = bsp.planesF[p * 5] * s, ny = bsp.planesF[p * 5 + 1] * s, nz = bsp.planesF[p * 5 + 2] * s;
      if (nz < FLOOR_NZ) continue;
      const n = faceNumEdges(bsp, f), xs = new Float32Array(n), ys = new Float32Array(n);
      let d = 0;
      for (let i = 0; i < n; i++) {
        const v = faceVertex(bsp, f, i);
        xs[i] = bsp.vertices[v * 3] + ox;
        ys[i] = bsp.vertices[v * 3 + 1] + oy;
        if (i === 0) d = nx * xs[0] + ny * ys[0] + nz * (bsp.vertices[v * 3 + 2] + oz);
      }
      out.push({ xs, ys, nx, ny, nz, d });
    }
  }
  return out;
}
