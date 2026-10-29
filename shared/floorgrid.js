// Where players can stand and walk, on a grid over the map (top-down), made from the BSP:
// every upward face of the world and the solid brush entities is rasterized into up to
// LAYERS floor heights per cell, keeping only floors a crouching player fits on. A flood
// fill from the spawn points (and hostages) then walks those floors the way a player
// can (`moves`): onto a neighbor's floor at most a stair up or any distance down (the
// floor he walks or falls onto, when his hull really drops there), onto anything a
// crouch jump reaches, up ladders. Used
// by the radar's overview (shared/overview.js) and the bots' navigation (shared/nav.js).

import {
  entityModelIndex, faceNumEdges, facePlane, faceSide, faceTexinfo, faceVertex, modelFirstFace, modelNumFaces,
  parseVec3,
} from './bsp.js';
import { hullFits, traceHull, Trace, HULL_DUCK, ENT_LADDER, ENT_NONE } from './trace.js';

export const LAYERS = 6; // floor heights kept per cell (the highest go first when full)
export const STAIR = 18; // sv_stepsize: walked up without a jump
export const CLIMB = 64; // a crouch jump reaches about this high (approx.)
export const MOVE_WALK = 0; // walk, or fall
export const MOVE_JUMP = 1; // up more than a stair: a (crouch) jump
export const MOVE_LADDER = 2; // up a ladder
const FLOOR_NZ = 0.7; // walkable slope (sv_walkable_normal)
const TEX_SPECIAL = 1; // texinfo flag: sky / water
const MERGE = 16; // floors closer than this are one
const NONSOLID = new Set(['func_illusionary', 'func_ladder', 'func_water', 'func_buyzone', 'func_bomb_target',
  'func_hostage_rescue', 'func_vip_safetyzone', 'func_escapezone']);
const DOORS = new Set(['func_door', 'func_door_rotating']);
const SEEDS = new Set(['info_player_start', 'info_player_deathmatch', 'hostage_entity']);

export class FloorGrid {
  // cell: world units per cell; bounds [x0, y0, x1, y1] (world; default: every upward
  // face); margin: empty cells around; doorsOpen: doors do not cut floors (true: every
  // door, as the radar draws rooms behind them; or a test of the door's bsp entity index:
  // navigation opens the doors players can open, shared/doors.js); strictFalls: a fall is
  // a move only where the hull really drops (`drops`; the navigation: a bot must not walk
  // against a railing or a crate's side), else wherever there is room over the neighbor
  // (the overview keeps the floors a player gets to somehow, over a railing or off a crate).
  constructor(bsp, world, cell, { bounds = null, margin = 0, doorsOpen = false, faces = null, strictFalls = false } = {}) {
    faces = faces || floorFaces(bsp);
    const [x0, y0, x1, y1] = bounds || faceBounds(faces);
    this.cell = cell;
    this.w = Math.ceil((x1 - x0) / cell) + 2 * margin;
    this.h = Math.ceil((y1 - y0) / cell) + 2 * margin;
    this.minX = x0 - margin * cell; // world x of column 0's left edge
    this.maxY = y1 + margin * cell; // world y of row 0's top edge (north up)
    this.layers = new Float32Array(this.w * this.h * LAYERS).fill(-Infinity); // per cell, highest first
    const doors = [];
    if (doorsOpen) {
      for (const e of world.ents) {
        if (e.bspEntity >= 0 && DOORS.has(bsp.entities[e.bspEntity].classname) && e.kind !== ENT_NONE &&
          (doorsOpen === true || doorsOpen(e.bspEntity))) {
          doors.push([e, e.kind]);
          e.kind = ENT_NONE;
        }
      }
    }
    this.world = world;
    this.strictFalls = strictFalls;
    try {
      for (const f of faces) this.raster(f, world);
      this.ladder = this.ladders(world); // per cell: the top of a ladder there, or -Infinity
      this.reached = this.flood(bsp);
    } finally {
      for (const [e, kind] of doors) e.kind = kind;
    }
  }

  // World (x, y) to grid coordinates (fractional), and back (cell centers).
  px(x) {
    return (x - this.minX) / this.cell;
  }

  py(y) {
    return (this.maxY - y) / this.cell;
  }

  centerX(i) {
    return this.minX + (i % this.w + 0.5) * this.cell;
  }

  centerY(i) {
    return this.maxY - (Math.floor(i / this.w) + 0.5) * this.cell;
  }

  // The cell index under world (x, y), or -1.
  index(x, y) {
    const px = Math.floor(this.px(x)), py = Math.floor(this.py(y));
    return px < 0 || py < 0 || px >= this.w || py >= this.h ? -1 : py * this.w + px;
  }

  // The highest floor of cell i at most `limit` high, as a slot (i * LAYERS + layer), or -1.
  landing(i, limit) {
    const L = this.layers;
    for (let k = 0; k < LAYERS; k++) {
      const z = L[i * LAYERS + k];
      if (z === -Infinity) return -1;
      if (z <= limit) return i * LAYERS + k;
    }
    return -1;
  }

  // Every move from floor slot s: out(slot, kind) for each floor a player gets to from
  // there (MOVE_WALK / MOVE_JUMP onto a neighbor, MOVE_LADDER up this cell's ladder). A
  // fall needs room at our height over the neighbor (not through a railing or a wall)
  // and, with strictFalls, the hull must really drop there (`drops`).
  moves(s, out) {
    const L = this.layers, w = this.w, i = Math.floor(s / LAYERS), z = L[s];
    const lad = this.ladder[i];
    const limit = (lad > z - CLIMB ? Math.max(z, lad) : z) + CLIMB;
    const px = i % w, py = (i - px) / w;
    for (let d = 0; d < 4; d++) {
      if ((d === 0 && px === 0) || (d === 1 && px === w - 1) || (d === 2 && py === 0) || (d === 3 && py === this.h - 1)) {
        continue;
      }
      const j = i + (d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -w : w);
      const c = this.landing(j, z + STAIR);
      if (c >= 0) {
        if (L[c] >= z - STAIR) out(c, MOVE_WALK);
        else {
          const nx = this.centerX(j), ny = this.centerY(j);
          if (fitsCrouched(this.world, nx, ny, z) &&
            (!this.strictFalls || this.drops(nx, ny, z, nx - this.centerX(i), ny - this.centerY(i), L[c]))) {
            out(c, MOVE_WALK);
          }
        }
      }
      for (let k = 0; k < LAYERS; k++) {
        const z2 = L[j * LAYERS + k];
        if (z2 > z + STAIR && z2 <= limit) out(j * LAYERS + k, z2 <= z + CLIMB ? MOVE_JUMP : MOVE_LADDER);
      }
    }
    if (lad > -Infinity) { // on a ladder: every floor of this cell up to its top
      for (let k = 0; k < LAYERS; k++) if (L[i * LAYERS + k] > z && L[i * LAYERS + k] <= limit) out(i * LAYERS + k, MOVE_LADDER);
    }
  }

  // Does a crouching player walking from the cell center (x - dx, y - dy) on floor level
  // z to (x, y) fall onto the floor `floor` below (more than a stair down)? His hull must
  // get there level, then down to within a stair of that floor, unobstructed; there or a
  // little further along the move: past the rim of a ledge, where the hull at the cell
  // center still overlaps the floor he is leaving. A cell whose own floor the grid could
  // not keep (a step or a crate's side within the hull of its center, a railing at the
  // floor's edge) was otherwise a "fall" onto the floor far below it (de_nuke's upper
  // floors over the lower level), and the bot walked there and stood.
  drops(x, y, z, dx, dy, floor) {
    const tr = dropTrace, fx = x - dx, fy = y - dy;
    let up = 0;
    while (up <= STAIR && !hullFits(this.world, HULL_DUCK, fx, fy, z + 19 + up)) up += STAIR / 2;
    if (up > STAIR) return false;
    const top = z + 19 + up, bottom = floor + 19;
    for (let along = 0; along <= 1; along++) {
      const px = x + dx * along * 0.85, py = y + dy * along * 0.85;
      traceHull(this.world, HULL_DUCK, fx, fy, top, px, py, top, tr);
      if (tr.fraction < 1) return false; // something in the way (the railing, the step)
      traceHull(this.world, HULL_DUCK, px, py, top, px, py, bottom, tr);
      if (top - (top - bottom) * tr.fraction <= bottom + STAIR + 2) return true;
    }
    return false;
  }

  // Flood fill from the spawn points and hostages: 1 per reachable floor slot. Maps
  // without any: every floor.
  flood(bsp) {
    const n = this.w * this.h * LAYERS, reached = new Uint8Array(n), queue = new Int32Array(n);
    let head = 0, tail = 0;
    const visit = (s) => {
      if (reached[s]) return;
      reached[s] = 1;
      queue[tail++] = s;
    };
    const o = new Float32Array(3);
    for (const e of bsp.entities) {
      if (!SEEDS.has(e.classname)) continue;
      parseVec3(e.origin, o);
      const i = this.index(o[0], o[1]);
      const s = i < 0 ? -1 : this.landing(i, o[2] + 8);
      if (s >= 0) visit(s);
    }
    if (!tail) {
      for (let s = 0; s < n; s++) reached[s] = this.layers[s] > -Infinity ? 1 : 0;
      return reached;
    }
    while (head < tail) this.moves(queue[head++], visit);
    return reached;
  }

  // Per cell: the highest reachable floor, or -Infinity.
  topReached() {
    const n = this.w * this.h, top = new Float32Array(n).fill(-Infinity);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < LAYERS; k++) {
        if (this.reached[i * LAYERS + k]) {
          top[i] = this.layers[i * LAYERS + k];
          break;
        }
      }
    }
    return top;
  }

  // World bounds [x0, y0, x1, y1] of every standable floor (a cell of slack around).
  layerBounds() {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let py = 0; py < this.h; py++) {
      for (let px = 0; px < this.w; px++) {
        if (this.layers[(py * this.w + px) * LAYERS] === -Infinity) continue;
        a = Math.min(a, px);
        c = Math.max(c, px + 1);
        b = Math.min(b, py);
        d = Math.max(d, py + 1);
      }
    }
    if (a === Infinity) return [0, 0, 1, 1];
    const s = this.cell;
    return [this.minX + (a - 1) * s, this.maxY - (d + 1) * s, this.minX + (c + 1) * s, this.maxY - (b - 1) * s];
  }

  // Per cell: the highest ladder top over it (a cell of slack around each ladder).
  ladders(world) {
    const w = this.w, h = this.h, out = new Float32Array(w * h).fill(-Infinity);
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

  // Scanline fill of a convex polygon: each cell center inside gets the face's height
  // there as a floor layer if a crouching player fits on it.
  raster(f, world) {
    const { xs, ys, nx, ny, nz, d } = f, n = xs.length, w = this.w, s = this.cell;
    let pyMin = Infinity, pyMax = -Infinity;
    for (let i = 0; i < n; i++) {
      pyMin = Math.min(pyMin, this.py(ys[i]));
      pyMax = Math.max(pyMax, this.py(ys[i]));
    }
    for (let py = Math.max(0, Math.ceil(pyMin - 0.5)); py <= Math.min(this.h - 1, Math.floor(pyMax - 0.5)); py++) {
      const wy = this.maxY - (py + 0.5) * s;
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
        const wx = this.minX + (px + 0.5) * s;
        const z = (d - nx * wx - ny * wy) / nz;
        if (this.hasLayer(py * w + px, z)) continue;
        if (fitsCrouched(world, wx, wy, z)) this.addLayer(py * w + px, z);
      }
    }
  }

  hasLayer(i, z) {
    for (let k = 0; k < LAYERS; k++) if (Math.abs(this.layers[i * LAYERS + k] - z) < MERGE) return true;
    return false;
  }

  // Inserts floor z into cell i's layers (highest first); when full the highest goes.
  addLayer(i, z) {
    const L = this.layers, o = i * LAYERS;
    let k = LAYERS - 1;
    if (L[o + k] !== -Infinity) {
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

const dropTrace = new Trace();

// Does a crouching player fit on floor z at (x, y)? Uneven ground (terrain, curbs)
// lifts him by up to a stair step, so the hull is tried a little higher too.
export function fitsCrouched(world, x, y, z) {
  for (let up = 0; up <= STAIR; up += STAIR / 2) {
    if (hullFits(world, HULL_DUCK, x, y, z + 19 + up)) return true; // duck hull center 18 above the feet
  }
  return false;
}

export function faceBounds(faces) {
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
export function floorFaces(bsp) {
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
