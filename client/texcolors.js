// The original CS 1.6 / Half-Life texture colors, measured offline (tools/gen_texturedata.js,
// no pixels kept): a texture name's main color, and whether the original repeats in lines.
// The flat procedural materials keep their name class patterns and use these colors.

import { TEXTURE_NAMES, TEXTURE_COLORS } from './texturedata.js';
import { MAT } from '../shared/materials.js';

export const RECORD_BYTES = 4; // r, g, b, flags
export const TF_LINES = 1; // the original shows repeating lines (bricks, tiles, planks)

// Packs an analysis (tools/texanalysis.js) into a record.
export function encodeRecord(a) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return new Uint8Array([c(a.mean[0]), c(a.mean[1]), c(a.mean[2]), a.ny || a.nx ? TF_LINES : 0]);
}

let table = null; // name -> record

// The record of a texture name (lowercase), or null.
export function textureRecord(name) {
  if (!table) {
    table = new Map();
    const bin = atob(TEXTURE_COLORS);
    const names = TEXTURE_NAMES ? TEXTURE_NAMES.split(' ') : [];
    names.forEach((n, i) => {
      const r = new Uint8Array(RECORD_BYTES);
      for (let k = 0; k < RECORD_BYTES; k++) r[k] = bin.charCodeAt(i * RECORD_BYTES + k);
      table.set(n, r);
    });
  }
  return table.get(name) || null;
}

// A classification (shared/materials.js classify) with the original's color. Brick and
// tile patterns are dropped where the original shows no such lines.
export function withOriginalColor(m, name) {
  const r = textureRecord(name);
  if (!r) return m;
  const mat = (m.mat === MAT.BRICK || m.mat === MAT.TILE) && !(r[3] & TF_LINES) ? MAT.PLASTER : m.mat;
  return { ...m, mat, r: r[0], g: r[1], b: r[2] };
}
