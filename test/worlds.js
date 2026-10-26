// Synthetic collision worlds for movement tests: unions of axis-aligned boxes compiled
// into per-hull clip trees (each box expanded by the hull extents, like a BSP compiler).

import { CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER } from '../shared/bsp.js';
import { CollisionWorld, HULL_MINS, HULL_MAXS, ENT_SOLID } from '../shared/trace.js';

export const BIG = 8192;

class TreeBuilder {
  constructor() {
    this.planes = [];
    this.ptype = [];
    this.cnPlane = [];
    this.cnChild = [];
  }

  plane(axis, dist) {
    const n = [0, 0, 0];
    n[axis] = 1;
    this.planes.push(n[0], n[1], n[2], dist);
    this.ptype.push(axis);
    return this.ptype.length - 1;
  }

  node(plane, front, back) {
    this.cnPlane.push(plane);
    this.cnChild.push(front, back);
    return this.cnPlane.length - 1;
  }

  // Chain of boxes: inside box k -> its contents, else fall through to box k+1.
  chain(boxes, hull) {
    let next = CONTENTS_EMPTY;
    for (let k = boxes.length - 1; k >= 0; k--) {
      const b = boxes[k];
      const contents = b.contents ?? CONTENTS_SOLID;
      if (hull !== 0 && contents !== CONTENTS_SOLID) continue; // liquids only exist in hull 0
      const mn = [0, 1, 2].map((a) => b.min[a] - HULL_MAXS[hull * 3 + a]);
      const mx = [0, 1, 2].map((a) => b.max[a] - HULL_MINS[hull * 3 + a]);
      // Innermost test first; each node: front = continue testing, back = outside.
      let inner = contents;
      for (let a = 2; a >= 0; a--) {
        inner = this.node(this.plane(a, mx[a]), next, inner); // x >= max -> outside
        inner = this.node(this.plane(a, mn[a]), inner, next); // x <  min -> outside
      }
      next = inner;
    }
    return next;
  }

  heads(boxes) {
    return [0, 1, 2, 3].map((h) => this.chain(boxes, h));
  }

  world() {
    return new CollisionWorld(
      Float32Array.from(this.planes),
      Int32Array.from(this.ptype),
      Int32Array.from(this.cnPlane),
      Int32Array.from(this.cnChild),
    );
  }
}

// boxes: [{ min, max, contents? }], extra: [{ kind, boxes }]
export function boxWorld(boxes, extra = []) {
  const tb = new TreeBuilder();
  const worldHeads = tb.heads(boxes);
  const extraHeads = extra.map((e) => tb.heads(e.boxes));
  const w = tb.world();
  w.addEntity(ENT_SOLID, worldHeads, 0, 0, 0, [-BIG, -BIG, -BIG], [BIG, BIG, BIG]);
  extra.forEach((e, k) => {
    const mins = [0, 1, 2].map((a) => Math.min(...e.boxes.map((b) => b.min[a])));
    const maxs = [0, 1, 2].map((a) => Math.max(...e.boxes.map((b) => b.max[a])));
    w.addEntity(e.kind, extraHeads[k], 0, 0, 0, mins, maxs);
  });
  return w;
}

export const FLOOR = { min: [-BIG, -BIG, -BIG], max: [BIG, BIG, 0] };
export const floorWorld = (...more) => boxWorld([FLOOR, ...more]);
export const emptyWorld = () => boxWorld([]);
export const WATER = CONTENTS_WATER;
