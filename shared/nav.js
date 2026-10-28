// Bot navigation, generated from the BSP (GoldSrc maps ship no navigation mesh): the
// reachable floors of a FloorGrid (shared/floorgrid.js) at NAV_CELL resolution, with the
// doors as they are in this game (closed), become graph nodes; edges are the moves a
// player makes (walk or fall, jump, ladder) to the 8 neighbors (diagonals only where
// both sides are open). A* finds paths; `direct` tells whether a straight walk between
// two points stays on the floors (bots cut corners with it). Everything is preallocated
// for the path searches.

import { FloorGrid, floorFaces, LAYERS, STAIR, MOVE_WALK, MOVE_JUMP, MOVE_LADDER } from './floorgrid.js';
import { hullFits, HULL_STAND } from './trace.js';

export const NAV_CELL = 24; // world units per cell (approx.: the hull is 32 wide)
export const NODE_CROUCH = 1; // only a crouching player fits here
export const EDGE_WALK = MOVE_WALK;
export const EDGE_JUMP = MOVE_JUMP;
export const EDGE_LADDER = MOVE_LADDER;
const JUMP_COST = 48; // extra cost of a move (in units of distance), to prefer walking
const LADDER_COST = 64;
const CROUCH_COST = 24;
const SAFE_FALL = 160; // drops beyond this hurt (CS falls hurt from about 210 units): they cost more

export class Nav {
  constructor(bsp, world, cell = NAV_CELL) {
    const faces = floorFaces(bsp);
    const bounds = new FloorGrid(bsp, world, 96, { faces }).layerBounds(); // where floors are at all
    const g = this.grid = new FloorGrid(bsp, world, cell, { bounds, margin: 1, faces });
    const slots = g.w * g.h * LAYERS;
    const nodeOf = this.nodeOf = new Int32Array(slots).fill(-1); // grid slot -> node
    let n = 0;
    for (let s = 0; s < slots; s++) if (g.reached[s]) nodeOf[s] = n++;
    this.count = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n); // the floor (feet height)
    this.flags = new Uint8Array(n);
    this.slot = new Int32Array(n);
    for (let s = 0; s < slots; s++) {
      const k = nodeOf[s];
      if (k < 0) continue;
      const i = Math.floor(s / LAYERS);
      this.slot[k] = s;
      this.x[k] = g.centerX(i);
      this.y[k] = g.centerY(i);
      this.z[k] = g.layers[s];
      let stands = false;
      for (let up = 0; up <= STAIR && !stands; up += STAIR / 2) {
        stands = hullFits(world, HULL_STAND, this.x[k], this.y[k], this.z[k] + 37 + up);
      }
      if (!stands) this.flags[k] = NODE_CROUCH;
    }

    // Edges (compressed rows): the grid's moves, plus diagonals walkable both ways round.
    const from = [], to = [], kind = [];
    const moves = [];
    const collect = (s2, m) => moves.push(s2, m);
    const walkTo = (s, di) => { // the walk move from slot s to neighbor index offset di, or -1
      moves.length = 0;
      g.moves(s, collect);
      const j = Math.floor(s / LAYERS) + di;
      for (let q = 0; q < moves.length; q += 2) {
        if (moves[q + 1] === MOVE_WALK && Math.floor(moves[q] / LAYERS) === j) return moves[q];
      }
      return -1;
    };
    for (let k = 0; k < n; k++) {
      const s = this.slot[k];
      moves.length = 0;
      g.moves(s, collect);
      const list = moves.slice();
      for (let q = 0; q < list.length; q += 2) {
        const k2 = nodeOf[list[q]];
        if (k2 < 0 || k2 === k) continue;
        from.push(k);
        to.push(k2);
        kind.push(list[q + 1]);
      }
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const a = walkTo(s, dx), b = walkTo(s, -dy * g.w);
        if (a < 0 || b < 0) continue;
        const c1 = walkTo(a, -dy * g.w), c2 = walkTo(b, dx);
        if (c1 < 0 || c1 !== c2 || nodeOf[c1] < 0) continue;
        from.push(k);
        to.push(nodeOf[c1]);
        kind.push(MOVE_WALK);
      }
    }
    const m = from.length;
    this.first = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) this.first[from[e] + 1]++;
    for (let k = 0; k < n; k++) this.first[k + 1] += this.first[k];
    this.to = new Int32Array(m);
    this.kind = new Uint8Array(m);
    this.cost = new Float32Array(m);
    const fill = this.first.slice(0, n);
    for (let e = 0; e < m; e++) {
      const a = from[e], b = to[e], o = fill[a]++;
      this.to[o] = b;
      this.kind[o] = kind[e];
      this.cost[o] = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a], this.z[b] - this.z[a]) +
        (kind[e] === MOVE_JUMP ? JUMP_COST : kind[e] === MOVE_LADDER ? LADDER_COST : 0) +
        (this.flags[b] & NODE_CROUCH ? CROUCH_COST : 0) + Math.max(0, this.z[a] - this.z[b] - SAFE_FALL) * 6;
    }

    // A* scratch.
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Int32Array(n); // search number that touched the node
    this.closed = new Int32Array(n);
    this.search = 0;
    this.heap = new Int32Array(m + n);
    this.prio = new Float32Array(m + n);
  }

  // The node under a player's feet at (x, y, feetZ): the highest floor of that cell at
  // most a stair above, else the nearest within two cells. -1 if none.
  nodeAt(x, y, z) {
    const g = this.grid;
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const i = g.index(x + dx * g.cell, y + dy * g.cell);
          if (i < 0) continue;
          for (let k = 0; k < LAYERS; k++) {
            const node = this.nodeOf[i * LAYERS + k];
            if (node < 0) continue;
            const dz = z - this.z[node];
            if (dz < -STAIR - 8) continue; // above us
            const d = Math.hypot(this.x[node] - x, this.y[node] - y) + Math.max(dz, 0) * 2;
            if (d < bestD) {
              bestD = d;
              best = node;
            }
          }
        }
      }
    }
    return best;
  }

  // A* from node a to node b; writes the nodes (a .. b) into `out` and returns how many,
  // or 0 if there is no way (or it does not fit).
  path(a, b, out) {
    if (a < 0 || b < 0) return 0;
    const st = ++this.search, G = this.g, P = this.parent, S = this.stamp, C = this.closed;
    const heap = this.heap, prio = this.prio, X = this.x, Y = this.y, Z = this.z;
    const h = (k) => Math.hypot(X[k] - X[b], Y[k] - Y[b], Z[k] - Z[b]);
    let size = 0;
    const push = (k, p) => { // binary heap of (node, priority), lowest first
      let i = size++;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (prio[up] <= p) break;
        heap[i] = heap[up];
        prio[i] = prio[up];
        i = up;
      }
      heap[i] = k;
      prio[i] = p;
    };
    const pop = () => {
      const top = heap[0], k = heap[--size], p = prio[size];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= size) break;
        if (c + 1 < size && prio[c + 1] < prio[c]) c++;
        if (prio[c] >= p) break;
        heap[i] = heap[c];
        prio[i] = prio[c];
        i = c;
      }
      heap[i] = k;
      prio[i] = p;
      return top;
    };
    S[a] = st;
    G[a] = 0;
    P[a] = -1;
    push(a, h(a));
    while (size > 0) {
      const k = pop();
      if (C[k] === st) continue;
      C[k] = st;
      if (k === b) break;
      for (let e = this.first[k]; e < this.first[k + 1]; e++) {
        const k2 = this.to[e], g2 = G[k] + this.cost[e];
        if (S[k2] === st && g2 >= G[k2]) continue;
        if (size >= heap.length) return 0;
        S[k2] = st;
        G[k2] = g2;
        P[k2] = k;
        push(k2, g2 + h(k2));
      }
    }
    if (C[b] !== st) return 0;
    let len = 0;
    for (let k = b; k >= 0; k = P[k]) len++;
    if (len > out.length) return 0;
    for (let k = b, i = len - 1; k >= 0; k = P[k], i--) out[i] = k;
    return len;
  }

  // Open floor: a standing player fits and every neighbor is walkable (no ledge, crate
  // top or narrow gap: somewhere to put a player down).
  open(k) {
    return !(this.flags[k] & NODE_CROUCH) && this.first[k + 1] - this.first[k] >= 8;
  }

  // The edge kind from node a to node b (EDGE_*), or -1 if they are not neighbors.
  edge(a, b) {
    for (let e = this.first[a]; e < this.first[a + 1]; e++) if (this.to[e] === b) return this.kind[e];
    return -1;
  }

  // Can a player walk straight from (x0, y0, feet z0) to (x1, y1, z1), staying on floors
  // without climbing more than a stair at a time? Sampled every third of a cell.
  direct(x0, y0, z0, x1, y1, z1) {
    const g = this.grid, d = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(d / (g.cell / 3)));
    let z = z0;
    for (let t = 1; t <= steps; t++) {
      const x = x0 + (x1 - x0) * t / steps, y = y0 + (y1 - y0) * t / steps, i = g.index(x, y);
      if (i < 0) return false;
      const s = g.landing(i, z + STAIR);
      if (s < 0 || this.nodeOf[s] < 0 || z - g.layers[s] > 64) return false; // a wall, or a drop
      z = g.layers[s];
    }
    return Math.abs(z - z1) <= STAIR;
  }

  // A random node (rand: () => 0..1), or one inside a box [x0, y0, z0, x1, y1, z1].
  random(rand, box = null) {
    for (let tries = 0; tries < 64; tries++) {
      const k = Math.floor(rand() * this.count);
      if (!box || (this.x[k] >= box[0] && this.x[k] <= box[3] && this.y[k] >= box[1] && this.y[k] <= box[4] &&
        this.z[k] >= box[2] - 40 && this.z[k] <= box[5])) return k;
    }
    if (!box) return -1;
    const inside = [];
    for (let k = 0; k < this.count; k++) {
      if (this.x[k] >= box[0] && this.x[k] <= box[3] && this.y[k] >= box[1] && this.y[k] <= box[4] &&
        this.z[k] >= box[2] - 40 && this.z[k] <= box[5]) inside.push(k);
    }
    return inside.length ? inside[Math.floor(rand() * inside.length)] : -1;
  }
}
