// Gun finishes ("looks"): a gun's dark metal and polymer parts painted one color with a
// pattern finish that SKINNED_FS prints in model space (client/gl/shaders.js): camo
// blotches, tiger stripes, a hex grid, a fade. Wood, steel, lenses and light parts keep
// their colors, so every gun stays recognisable. A look is applied to a built mesh's vertex
// colors (paintMesh), never to its shape: the triangles, bones and hand fits stay the
// gun's own. Each gun offers four (looksOf: the factory finish first), chosen in Settings,
// Weapons (cvars cl_finish_<gun>), seen in our own first-person view and in the gallery
// (client/guns.html ?look=); others' choices are not sent, so other players' guns are
// always factory.

import { FINISH, MESH_STRIDE } from '../gl/meshkit.js';

export const LOOKS = {
  plain: { label: 'Factory' },
  desert: { label: 'Desert Camo', paint: [0.66, 0.56, 0.38], pattern: FINISH.CAMO },
  forest: { label: 'Forest Camo', paint: [0.36, 0.43, 0.25], pattern: FINISH.CAMO },
  arctic: { label: 'Arctic Camo', paint: [0.8, 0.83, 0.86], pattern: FINISH.CAMO },
  tiger: { label: 'Tiger Stripe', paint: [0.9, 0.55, 0.14], pattern: FINISH.STRIPES },
  hex: { label: 'Hex Grid', paint: [0.24, 0.36, 0.46], pattern: FINISH.HEX },
  fade: { label: 'Fade', paint: [0.92, 0.48, 0.74], pattern: FINISH.FADE },
};

const PISTOL = ['plain', 'fade', 'hex', 'tiger'];
const SMG = ['plain', 'forest', 'tiger', 'hex'];
const RIFLE = ['plain', 'desert', 'tiger', 'fade'];
const SNIPER = ['plain', 'arctic', 'forest', 'hex'];
const HEAVY = ['plain', 'desert', 'forest', 'hex'];
const KNIFE = ['plain', 'fade', 'tiger', 'hex'];
const GROUPS = [
  [PISTOL, 'glock hkp2000 usp_silencer p250 elite fiveseven tec9 cz75a deagle revolver'],
  [SMG, 'mac10 mp9 mp7 mp5sd ump45 p90 bizon'],
  [RIFLE, 'galilar famas ak47 m4a1 m4a1_silencer sg556 aug'],
  [SNIPER, 'ssg08 awp g3sg1 scar20'],
  [HEAVY, 'nova xm1014 sawedoff mag7 m249 negev'],
  [KNIFE, 'knife'],
];
const OF = new Map();
for (const [list, names] of GROUPS) for (const n of names.split(' ')) OF.set(n, list);

// The guns that have looks (the knife too; not grenades or the C4).
export const LOOK_GUNS = [...OF.keys()];

// Guns whose metal is light (the knife's blade, the R8's and the Dual Berettas' silver):
// a look paints all their metal, else it would hardly show.
const PAINT_ALL = new Set(['knife', 'revolver', 'elite']);
export const paintsAll = (name) => PAINT_ALL.has(name);

// The looks gun `name` offers (keys of LOOKS, the factory finish first); ['plain'] for the rest.
export function looksOf(name) {
  return OF.get(name) || ['plain'];
}

// The look key for choice `index` of gun `name` (out of range: the factory finish).
export function lookOf(name, index) {
  return looksOf(name)[index | 0] || 'plain';
}

// A copy of a built mesh (MeshBuilder.build: data, count, ...) in look `key`: every metal
// or polymer vertex darker than PAINT_BELOW (all of them with `all`: paintsAll), and
// not glass (bluish), takes the look's paint, a little lighter for parts that were lighter,
// so neighboring parts keep apart (their ink ids come from their colors), and the look's
// pattern finish; the fade's place along the gun (0 at the back, 1 at the muzzle) goes in
// the pattern byte (its colors cannot be the vertex colors: the ink ids would change from
// triangle to triangle). The factory look returns the mesh itself.
const PAINT_BELOW = 0.5;
export function paintMesh(built, key, all = false) {
  const look = LOOKS[key];
  if (!look || !look.paint) return built;
  const data = built.data.slice(0), u8 = new Uint8Array(data), pos = built.positions;
  let x0 = Infinity, x1 = -Infinity;
  for (let v = 0; v < built.count; v++) {
    x0 = Math.min(x0, pos[v * 3]);
    x1 = Math.max(x1, pos[v * 3]);
  }
  for (let v = 0; v < built.count; v++) {
    const o = v * MESH_STRIDE + 16;
    const fin = u8[o + 3];
    if (fin !== FINISH.METAL && fin !== FINISH.POLYMER) continue;
    const r = u8[o] / 255, g = u8[o + 1] / 255, b = u8[o + 2] / 255;
    if (b > r + 0.12) continue; // lenses
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    if (!all && lum >= PAINT_BELOW) continue;
    const k = 0.8 + 0.6 * lum;
    for (let c = 0; c < 3; c++) u8[o + c] = Math.max(0, Math.min(255, Math.round(look.paint[c] * k * 255)));
    u8[o + 3] = look.pattern;
    u8[o + 6] = Math.round((pos[v * 3] - x0) / Math.max(x1 - x0, 1e-6) * 255); // byte 22
  }
  return { ...built, data };
}
