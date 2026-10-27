// Reads GoldSrc miptex textures (WAD3 files and textures embedded in BSPs) as RGBA,
// for the offline texture analysis in tools/gen_texturedata.js. Never used at runtime.

const latin1 = new TextDecoder('latin1');

function cstr(b, p, n) {
  let e = p;
  while (e < p + n && b[e]) e++;
  return latin1.decode(b.subarray(p, e)).toLowerCase();
}

// Decodes one miptex at byte offset `p` (mip 0 only). Returns null without pixels.
// '{' textures use palette index 255 as transparent (alpha 0).
export function readMiptex(buf, p) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const name = cstr(buf, p, 16);
  const w = dv.getUint32(p + 16, true), h = dv.getUint32(p + 20, true);
  const ofs0 = dv.getUint32(p + 24, true), ofs3 = dv.getUint32(p + 36, true);
  if (!ofs0 || !w || !h || w > 4096 || h > 4096) return null;
  const pal = p + ofs3 + ((w >> 3) * (h >> 3)) + 2; // after mip 3 and the u16 color count
  if (pal + 768 > buf.length) return null;
  const alpha = name[0] === '{';
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = buf[p + ofs0 + i];
    rgba[i * 4] = buf[pal + c * 3];
    rgba[i * 4 + 1] = buf[pal + c * 3 + 1];
    rgba[i * 4 + 2] = buf[pal + c * 3 + 2];
    rgba[i * 4 + 3] = alpha && c === 255 ? 0 : 255;
  }
  return { name, w, h, rgba };
}

// All miptex lumps of a WAD3 file.
export function readWad(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (cstr(buf, 0, 4) !== 'wad3') return [];
  const n = dv.getInt32(4, true), dir = dv.getInt32(8, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = dir + i * 32;
    if (buf[e + 12] !== 0x43 || buf[e + 13] !== 0) continue; // miptex, uncompressed
    const t = readMiptex(buf, dv.getInt32(e, true));
    if (t) out.push(t);
  }
  return out;
}

// Textures embedded in a BSP v30 file (those stored with their pixels).
export function readBspTextures(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const base = dv.getInt32(4 + 2 * 8, true); // lump 2: textures
  const n = dv.getInt32(base, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ofs = dv.getInt32(base + 4 + i * 4, true);
    if (ofs < 0) continue;
    const t = readMiptex(buf, base + ofs);
    if (t) out.push(t);
  }
  return out;
}
