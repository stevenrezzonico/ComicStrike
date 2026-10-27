// Load-time conversion of BSP faces into one interleaved vertex buffer, one index
// buffer (opaque, sky and translucent ranges, in that order) and a lightmap atlas built
// from the BSP lighting lump. Runs once per map; nothing here touches the frame loop.

import {
  faceTexinfo, faceNumEdges, facePlane, faceSide, faceLightOfs, faceStyle,
  faceVertex, modelFirstFace, modelNumFaces, entityModelIndex, parseVec3,
} from '../shared/bsp.js';
import { breakableEntities, MAX_BREAKABLES } from '../shared/breakables.js';
import { classify, isSkipped, MAT } from './materials.js';

// Vertex layout (40 bytes):
//  0 pos   f32x3     12 uv f32x2 (texture tiles)   20 lm f32x2 (atlas 0..1)
// 28 nrm   i8x4 norm 32 col u8x4 norm (rgb, alpha)
// 36 mat   u8x4 int (material, flags, seed, breakable slot or 0)
export const VERTEX_STRIDE = 40;

const TEX_SPECIAL = 1; // texinfo flag: sky / water / no lightmap
const ATLAS_W = 1024;

// Brush entities that are never visible.
const HIDDEN_CLASSES = new Set([
  'func_buyzone', 'func_bomb_target', 'func_hostage_rescue', 'func_escapezone',
  'func_vip_safetyzone', 'func_ladder', 'func_mortar_field', 'func_friction', 'env_bubbles',
]);

// Shelf packer for lightmap rectangles.
class Atlas {
  constructor(width) {
    this.width = width;
    this.height = 64;
    this.data = new Uint8Array(width * this.height * 4);
    this.x = 0;
    this.y = 0;
    this.shelf = 0;
  }

  alloc(w, h) {
    if (this.x + w + 1 > this.width) {
      this.y += this.shelf + 1;
      this.x = 0;
      this.shelf = 0;
    }
    while (this.y + h + 1 > this.height) this.grow();
    const rx = this.x;
    const ry = this.y;
    this.x += w + 1;
    if (h > this.shelf) this.shelf = h;
    return [rx, ry];
  }

  grow() {
    const next = new Uint8Array(this.width * this.height * 2 * 4);
    next.set(this.data);
    this.data = next;
    this.height *= 2;
  }
}

function collectModels(bsp) {
  const out = [{ model: 0, ox: 0, oy: 0, oz: 0, alpha: 255, slot: 0 }];
  const origin = new Float32Array(3);
  const slotOf = new Map(breakableEntities(bsp).map((bi, k) => [bi, k + 1]));
  for (let ei = 0; ei < bsp.entities.length; ei++) {
    const e = bsp.entities[ei];
    const m = entityModelIndex(e);
    if (m <= 0) continue;
    const cls = e.classname || '';
    if (cls.startsWith('trigger_') || HIDDEN_CLASSES.has(cls)) continue;

    const mode = +(e.rendermode || 0);
    let alpha = 255;
    if (mode === 1 || mode === 2 || mode === 3 || mode === 5) {
      alpha = e.renderamt === undefined ? 255 : +e.renderamt;
      if (alpha <= 0) continue;
    }
    parseVec3(e.origin, origin);
    out.push({ model: m, ox: origin[0], oy: origin[1], oz: origin[2], alpha, slot: slotOf.get(ei) || 0 });
  }
  return out;
}

export function buildMapMesh(bsp) {
  const materials = bsp.textureNames.map((n) => (isSkipped(n) ? null : classify(n)));
  const skyTex = bsp.textureNames.map((n) => n === 'sky');
  const models = collectModels(bsp);

  // Pass 1: count vertices / indices so buffers are allocated exactly once.
  let numVerts = 0;
  let numIdx = 0;
  for (const m of models) {
    const first = modelFirstFace(bsp, m.model);
    const n = modelNumFaces(bsp, m.model);
    for (let f = first; f < first + n; f++) {
      const tex = bsp.texinfoI[faceTexinfo(bsp, f) * 10 + 8];
      if (!materials[tex] && !skyTex[tex]) continue;
      const ne = faceNumEdges(bsp, f);
      numVerts += ne;
      numIdx += (ne - 2) * 3;
    }
  }

  const vbuf = new ArrayBuffer(numVerts * VERTEX_STRIDE);
  const vf = new Float32Array(vbuf);
  const vi8 = new Int8Array(vbuf);
  const vu8 = new Uint8Array(vbuf);
  const opaque = new Uint32Array(numIdx);
  const trans = new Uint32Array(numIdx);
  const sky = new Uint32Array(numIdx);
  let nOpaque = 0;
  let nTrans = 0;
  let nSky = 0;

  const atlas = new Atlas(ATLAS_W);
  // Reserve a 2x2 mid-grey block for faces without lightmaps.
  const [gx, gy] = atlas.alloc(2, 2);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const p = ((gy + y) * atlas.width + gx + x) * 4;
      atlas.data.set([160, 160, 160, 255], p);
    }
  }

  // Average albedo per breakable slot (rgb sum, face count), for debris colors.
  const slotColor = new Float32Array((MAX_BREAKABLES + 1) * 4);

  const sArr = new Float32Array(64);
  const tArr = new Float32Array(64);
  let v = 0;

  for (const m of models) {
    const first = modelFirstFace(bsp, m.model);
    const nfaces = modelNumFaces(bsp, m.model);
    for (let f = first; f < first + nfaces; f++) {
      const ti = faceTexinfo(bsp, f);
      const tex = bsp.texinfoI[ti * 10 + 8];
      const ne = faceNumEdges(bsp, f);

      // Sky brushes: position only. Drawn with the sky shader so they hide whatever
      // lies behind them, as GoldSrc does.
      if (skyTex[tex]) {
        const base = v;
        for (let i = 0; i < ne; i++, v++) {
          const vi = faceVertex(bsp, f, i) * 3;
          vf[v * 10] = bsp.vertices[vi] + m.ox;
          vf[v * 10 + 1] = bsp.vertices[vi + 1] + m.oy;
          vf[v * 10 + 2] = bsp.vertices[vi + 2] + m.oz;
          vf[v * 10 + 5] = gx + 1;
          vf[v * 10 + 6] = gy + 1;
        }
        for (let i = 1; i < ne - 1; i++) {
          sky[nSky++] = base;
          sky[nSky++] = base + i;
          sky[nSky++] = base + i + 1;
        }
        continue;
      }

      const mat = materials[tex];
      if (!mat) continue;

      const tf = bsp.texinfoF;
      const tw = bsp.textureSize[tex * 2];
      const th = bsp.textureSize[tex * 2 + 1];

      // Texture-space coordinates and lightmap extents.
      let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
      for (let i = 0; i < ne; i++) {
        const vi = faceVertex(bsp, f, i) * 3;
        const x = bsp.vertices[vi], y = bsp.vertices[vi + 1], z = bsp.vertices[vi + 2];
        const s = x * tf[ti * 10] + y * tf[ti * 10 + 1] + z * tf[ti * 10 + 2] + tf[ti * 10 + 3];
        const t = x * tf[ti * 10 + 4] + y * tf[ti * 10 + 5] + z * tf[ti * 10 + 6] + tf[ti * 10 + 7];
        sArr[i] = s;
        tArr[i] = t;
        if (s < smin) smin = s;
        if (s > smax) smax = s;
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
      }
      const lmMinS = Math.floor(smin / 16);
      const lmMinT = Math.floor(tmin / 16);
      const lmW = Math.ceil(smax / 16) - lmMinS + 1;
      const lmH = Math.ceil(tmax / 16) - lmMinT + 1;

      const lightOfs = faceLightOfs(bsp, f);
      const hasLm = lightOfs >= 0 && faceStyle(bsp, f, 0) !== 255 &&
        !(bsp.texinfoI[ti * 10 + 9] & TEX_SPECIAL) &&
        lightOfs + lmW * lmH * 3 <= bsp.lighting.length && lmW <= 256 && lmH <= 256;

      let rx = gx, ry = gy;
      if (hasLm) {
        [rx, ry] = atlas.alloc(lmW, lmH);
        for (let y = 0; y < lmH; y++) {
          for (let x = 0; x < lmW; x++) {
            const src = lightOfs + (y * lmW + x) * 3;
            const dst = ((ry + y) * atlas.width + rx + x) * 4;
            atlas.data[dst] = bsp.lighting[src];
            atlas.data[dst + 1] = bsp.lighting[src + 1];
            atlas.data[dst + 2] = bsp.lighting[src + 2];
            atlas.data[dst + 3] = 255;
          }
        }
      }

      // Plane normal (flipped for back-side faces).
      const pi = facePlane(bsp, f) * 5;
      const sign = faceSide(bsp, f) ? -1 : 1;
      const nx = Math.round(bsp.planesF[pi] * sign * 127);
      const ny = Math.round(bsp.planesF[pi + 1] * sign * 127);
      const nz = Math.round(bsp.planesF[pi + 2] * sign * 127);

      const alpha = mat.mat === MAT.WATER ? Math.min(m.alpha, 150) : m.alpha;
      const base = v;
      for (let i = 0; i < ne; i++, v++) {
        const vi = faceVertex(bsp, f, i) * 3;
        const o = v * 10; // float index (40 bytes / 4)
        const b = v * VERTEX_STRIDE;
        vf[o] = bsp.vertices[vi] + m.ox;
        vf[o + 1] = bsp.vertices[vi + 1] + m.oy;
        vf[o + 2] = bsp.vertices[vi + 2] + m.oz;
        vf[o + 3] = sArr[i] / tw;
        vf[o + 4] = tArr[i] / th;
        if (hasLm) {
          vf[o + 5] = rx + 0.5 + (sArr[i] / 16 - lmMinS);
          vf[o + 6] = ry + 0.5 + (tArr[i] / 16 - lmMinT);
        } else {
          vf[o + 5] = gx + 1;
          vf[o + 6] = gy + 1;
        }
        vi8[b + 28] = nx;
        vi8[b + 29] = ny;
        vi8[b + 30] = nz;
        vu8[b + 32] = mat.r;
        vu8[b + 33] = mat.g;
        vu8[b + 34] = mat.b;
        vu8[b + 35] = alpha;
        vu8[b + 36] = mat.mat;
        vu8[b + 37] = mat.flags;
        vu8[b + 38] = mat.seed;
        vu8[b + 39] = m.slot;
      }
      if (m.slot) {
        slotColor[m.slot * 4] += mat.r;
        slotColor[m.slot * 4 + 1] += mat.g;
        slotColor[m.slot * 4 + 2] += mat.b;
        slotColor[m.slot * 4 + 3]++;
      }

      const translucent = alpha < 255;
      const dst = translucent ? trans : opaque;
      let n = translucent ? nTrans : nOpaque;
      for (let i = 1; i < ne - 1; i++) {
        dst[n++] = base;
        dst[n++] = base + i;
        dst[n++] = base + i + 1;
      }
      if (translucent) nTrans = n;
      else nOpaque = n;
    }
  }

  // Normalize lightmap coordinates now that the atlas size is final.
  const invW = 1 / atlas.width;
  const invH = 1 / atlas.height;
  for (let i = 0; i < numVerts; i++) {
    vf[i * 10 + 5] *= invW;
    vf[i * 10 + 6] *= invH;
  }

  const indices = new Uint32Array(nOpaque + nSky + nTrans);
  indices.set(opaque.subarray(0, nOpaque), 0);
  indices.set(sky.subarray(0, nSky), nOpaque);
  indices.set(trans.subarray(0, nTrans), nOpaque + nSky);

  const breakableColors = new Uint8Array((MAX_BREAKABLES + 1) * 3);
  for (let k = 0; k <= MAX_BREAKABLES; k++) {
    const n = slotColor[k * 4 + 3];
    for (let c = 0; c < 3; c++) breakableColors[k * 3 + c] = n ? slotColor[k * 4 + c] / n : 128;
  }

  return {
    vertices: vbuf,
    numVerts,
    indices,
    opaqueCount: nOpaque,
    skyCount: nSky,
    transCount: nTrans,
    lightmap: { width: atlas.width, height: atlas.height, data: atlas.data },
    breakableColors, // rgb per breakable slot
  };
}
