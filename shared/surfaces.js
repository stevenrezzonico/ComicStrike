// What surface a bullet hit: finds the BSP face under a point (GoldSrc's
// RecursiveLightPoint walk) and maps its texture to a CS:GO surface type, whose
// penetration modifier drives wall penetration. Values are CS:GO's
// surfaceproperties_cs.txt (penetrationmodifier, gamematerial).

import {
  faceTexinfo, faceNumEdges, facePlane, faceVertex, faceLightOfs, faceStyle, modelHeadnode, entityModelIndex,
} from './bsp.js';
import { classify, MAT } from './materials.js';
import {
  MAT_GLASS, MAT_WOOD, MAT_METAL, MAT_FLESH, MAT_CINDER, MAT_CEILING_TILE, MAT_COMPUTER, MAT_UNBREAKABLE_GLASS,
  MAT_ROCKS,
} from './breakables.js';
import { toLocal } from './trace.js';

const la = new Float64Array(3), lb = new Float64Array(3);

// CS:GO game materials (CHAR_TEX_*) that HandleBulletPenetration special-cases.
export const GM_GLASS = 89; // 'Y'
export const GM_GRATE = 71; // 'G'
export const GM_WOOD = 87; // 'W'
export const GM_CARDBOARD = 85; // 'U'
export const GM_PLASTIC = 76; // 'L'
const GM_CONCRETE = 67; // 'C'
const GM_METAL = 77; // 'M'
const GM_DIRT = 68; // 'D'
const GM_TILE = 84; // 'T'
const GM_COMPUTER = 80; // 'P'
const GM_FLESH = 70; // 'F'
const GM_SLOSH = 83; // 'S'
const GM_SNOW = 75; // 'K'
const GM_FOLIAGE = 79; // 'O'
const GM_BRICK = 82; // 'R'
const GM_ROCK = 3;
const GM_PLASTER = 2;
const GM_CARPET = 7;

// [penetration modifier, game material]
export const SURF_DEFAULT = [1.0, GM_CONCRETE];
export const SURF_FLESH = [0.9, GM_FLESH];
const SURF_BY_MAT = {
  [MAT.PLASTER]: [0.7, GM_PLASTER],
  [MAT.CONCRETE]: [0.5, GM_CONCRETE],
  [MAT.BRICK]: [0.47, GM_BRICK],
  [MAT.STONE]: [0.5, GM_ROCK],
  [MAT.GROUND]: [0.6, GM_DIRT],
  [MAT.FOLIAGE]: [0.95, GM_FOLIAGE],
  [MAT.WOOD]: [0.9, GM_WOOD],
  [MAT.CRATE]: [0.9, GM_WOOD], // wood_crate
  [MAT.METAL]: [0.4, GM_METAL],
  [MAT.GRATE]: [0.95, GM_GRATE], // metalgrate
  [MAT.WINDOW]: [0.99, GM_GLASS],
  [MAT.WATER]: [0.3, GM_SLOSH],
  [MAT.TILE]: [0.7, GM_TILE],
  [MAT.FABRIC]: [0.75, GM_CARPET],
  [MAT.LIGHT]: SURF_DEFAULT,
  [MAT.DOOR]: [0.9, GM_WOOD],
  [MAT.DECAL]: [0.7, GM_PLASTER], // posters and signs sit on walls
  [MAT.TECH]: [0.4, GM_COMPUTER],
  [MAT.ROOF]: [0.7, GM_TILE],
  [MAT.SNOW]: [0.85, GM_SNOW],
};
// func_breakable "material" -> surface.
const SURF_BY_BREAKABLE = {
  [MAT_GLASS]: [0.99, GM_GLASS],
  [MAT_WOOD]: [0.9, GM_WOOD],
  [MAT_METAL]: [0.4, GM_METAL],
  [MAT_FLESH]: SURF_FLESH,
  [MAT_CINDER]: [0.5, GM_CONCRETE],
  [MAT_CEILING_TILE]: [0.95, GM_CARDBOARD],
  [MAT_COMPUTER]: [0.4, GM_COMPUTER],
  [MAT_UNBREAKABLE_GLASS]: [0.99, GM_GLASS],
  [MAT_ROCKS]: [0.5, GM_ROCK],
};

export function breakableSurface(material) {
  return SURF_BY_BREAKABLE[material] || SURF_DEFAULT;
}

export class SurfaceMap {
  constructor(bsp) {
    this.bsp = bsp;
    // Per texture: its surface. Per face: texinfo s/t extents for the hit test.
    this.texSurface = bsp.textureNames.map((n) => SURF_BY_MAT[classify(n).mat] || SURF_DEFAULT);
    const n = bsp.numFaces;
    this.extents = new Float32Array(n * 4); // smin, smax, tmin, tmax
    const tf = bsp.texinfoF;
    for (let f = 0; f < n; f++) {
      const ti = faceTexinfo(bsp, f) * 10;
      let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
      for (let i = 0, ne = faceNumEdges(bsp, f); i < ne; i++) {
        const v = faceVertex(bsp, f, i) * 3;
        const x = bsp.vertices[v], y = bsp.vertices[v + 1], z = bsp.vertices[v + 2];
        const s = x * tf[ti] + y * tf[ti + 1] + z * tf[ti + 2] + tf[ti + 3];
        const t = x * tf[ti + 4] + y * tf[ti + 5] + z * tf[ti + 6] + tf[ti + 7];
        if (s < smin) smin = s;
        if (s > smax) smax = s;
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
      }
      this.extents.set([smin - 0.5, smax + 0.5, tmin - 0.5, tmax + 0.5], f * 4);
    }
    // Render-tree head node per bsp entity with a brush model (others use model 0).
    this.entityHead = new Map();
    this.hitS = 0;
    this.hitT = 0;
    bsp.entities.forEach((e, i) => {
      const m = entityModelIndex(e);
      if (m > 0) this.entityHead.set(i, modelHeadnode(bsp, m, 0));
    });
  }

  // Face index under the segment a -> b (model-space), or -1.
  findFace(node, ax, ay, az, bx, by, bz) {
    const b = this.bsp;
    while (node >= 0) {
      const p = b.nodesI32[node * 6] * 5;
      const nx = b.planesF[p], ny = b.planesF[p + 1], nz = b.planesF[p + 2], d = b.planesF[p + 3];
      const front = nx * ax + ny * ay + nz * az - d;
      const back = nx * bx + ny * by + nz * bz - d;
      const side = front < 0 ? 1 : 0;
      const c0 = b.nodesI16[node * 12 + 2 + side];
      if ((back < 0 ? 1 : 0) === side) { // both on one side
        node = c0;
        continue;
      }
      const frac = front / (front - back);
      const mx = ax + (bx - ax) * frac, my = ay + (by - ay) * frac, mz = az + (bz - az) * frac;
      const r = this.findFace(c0, ax, ay, az, mx, my, mz);
      if (r >= 0) return r;
      // Crossing this node's plane: is the crossing point on one of its faces?
      const first = b.nodesI16[node * 12 + 10] & 0xffff, count = b.nodesI16[node * 12 + 11] & 0xffff;
      const tf = b.texinfoF;
      for (let f = first; f < first + count; f++) {
        if (facePlane(b, f) !== b.nodesI32[node * 6]) continue;
        const ti = faceTexinfo(b, f) * 10;
        const s = mx * tf[ti] + my * tf[ti + 1] + mz * tf[ti + 2] + tf[ti + 3];
        const t = mx * tf[ti + 4] + my * tf[ti + 5] + mz * tf[ti + 6] + tf[ti + 7];
        const e = f * 4;
        if (s >= this.extents[e] && s <= this.extents[e + 1] && t >= this.extents[e + 2] && t <= this.extents[e + 3]) {
          this.hitS = s; // texture coordinates of the hit, for lightAt
          this.hitT = t;
          return f;
        }
      }
      node = b.nodesI16[node * 12 + 2 + (side ^ 1)];
      ax = mx;
      ay = my;
      az = mz;
    }
    return -1;
  }

  // Lightmap color (0..255, style 0) of the world under (x, y, z), as GoldSrc's
  // R_LightPoint: the first face straight below within 2048 units. Writes rgb into out
  // and returns false (out = 0) where nothing lit is found. Client only (models).
  lightAt(out, x, y, z) {
    out[0] = out[1] = out[2] = 0;
    const b = this.bsp;
    const f = this.findFace(0, x, y, z, x, y, z - 2048);
    if (f < 0) return false;
    const ofs = faceLightOfs(b, f);
    if (ofs < 0 || faceStyle(b, f, 0) === 255) return false;
    const e = f * 4;
    const minS = Math.floor((this.extents[e] + 0.5) / 16), minT = Math.floor((this.extents[e + 2] + 0.5) / 16);
    const w = Math.ceil((this.extents[e + 1] - 0.5) / 16) - minS + 1, h = Math.ceil((this.extents[e + 3] - 0.5) / 16) - minT + 1;
    const ds = Math.min(w - 1, Math.max(0, Math.floor(this.hitS / 16 - minS + 0.5)));
    const dt = Math.min(h - 1, Math.max(0, Math.floor(this.hitT / 16 - minT + 0.5)));
    const p = ofs + (dt * w + ds) * 3;
    if (p + 2 >= b.lighting.length) return false;
    out[0] = b.lighting[p];
    out[1] = b.lighting[p + 1];
    out[2] = b.lighting[p + 2];
    return true;
  }

  // Surface at world point (x, y, z) approached along unit (dx, dy, dz), on collision
  // entity `ent` of `world` (0 = the world itself).
  surfaceAt(world, ent, x, y, z, dx, dy, dz) {
    const e = world.ents[ent];
    let head = 0;
    if (ent > 0 && e) {
      const h = this.entityHead.get(e.bspEntity);
      if (h === undefined) return SURF_DEFAULT;
      head = h;
      toLocal(e, x - dx * 4, y - dy * 4, z - dz * 4, la); // model space (moved / turned doors)
      toLocal(e, x + dx * 4, y + dy * 4, z + dz * 4, lb);
    } else {
      la[0] = x - dx * 4; la[1] = y - dy * 4; la[2] = z - dz * 4;
      lb[0] = x + dx * 4; lb[1] = y + dy * 4; lb[2] = z + dz * 4;
    }
    const f = this.findFace(head, la[0], la[1], la[2], lb[0], lb[1], lb[2]);
    if (f < 0) return SURF_DEFAULT;
    return this.texSurface[this.bsp.texinfoI[faceTexinfo(this.bsp, f) * 10 + 8]];
  }
}
