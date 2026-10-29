// Texture-name -> procedural material classification.
// GoldSrc maps only reference textures by name; we never load the pixels.
// Each name maps to a material id (selects the shader pattern) and a base color.

export const MAT = {
  PLASTER: 0,
  CONCRETE: 1,
  BRICK: 2,
  STONE: 3,
  GROUND: 4,
  FOLIAGE: 5,
  WOOD: 6,
  CRATE: 7,
  METAL: 8,
  GRATE: 9,
  WINDOW: 10,
  WATER: 11,
  TILE: 12,
  FABRIC: 13,
  LIGHT: 14,
  DOOR: 15,
  DECAL: 16,
  TECH: 17,
  ROOF: 18,
  SNOW: 19,
};

// Surface flags (packed into the vertex alongside the material id).
export const FLAG_ALPHATEST = 1; // '{' textures: holes via discard
export const FLAG_FULLBRIGHT = 2; // ignore lightmap
export const FLAG_SCROLL = 4; // animated / flowing
export const FLAG_ENTITY = 8; // a brush entity's face: drawn a hair nearer than the world (WORLD_VS)

// Names that are never drawn. Alpha-tested textures with no opaque pixel ({blue is all
// blue, the transparent color) are invisible in GoldSrc: mappers put them on func_walls
// as invisible blockers, often flush on a world face.
const SKIP = new Set(['sky', 'aaatrigger', 'clip', 'null', 'origin', 'hint', 'skip', 'bevel', '{invisible', 'noclip',
  '{blue', '{wallinv', '{wallinv2', '{wallinv3']);

// First match wins. [substrings, material, base rgb]
const RULES = [
  [['water'], MAT.WATER, [40, 70, 80]],
  [['snow', 'ice0'], MAT.SNOW, [215, 220, 228]],
  [['light', 'lght', 'lgt', 'lamp', 'lite', 'lantern'], MAT.LIGHT, [250, 240, 205]],
  [['glass', 'window', 'wndw', 'wndwn', 'cuwnd', 'wdw', 'winl', 'stuccowin', 'concyelwin'], MAT.WINDOW, [70, 85, 100]],
  [['grate', 'grat', 'fence', 'rail', 'ladder', 'rung', 'trellis', 'mesh', 'net', 'bars', 'razor', 'tension', 'scaffold', 'winerack'], MAT.GRATE, [70, 70, 68]],
  [['grass', 'grss', 'moss', 'ivy', 'vine', 'leaf', 'tree', 'plant', 'bush', 'hedge', 'jung', 'flower'], MAT.FOLIAGE, [70, 95, 45]],
  [['crate', 'crte', 'crt', 'cardb', 'cardbox', 'box', '_bx', 'bcrate'], MAT.CRATE, [140, 105, 60]],
  [['door', 'dr1', 'dr2', 'dr3', 'dr4', 'dr5', 'dr8', 'dr9', 'cstldr', 'drd'], MAT.DOOR, [110, 80, 50]],
  [['comp', 'cmp', 'mon', 'screen', 'scrn', 'keyboard', 'gad', 'pnl', 'panel', 'swch', 'button', 'reac', 'fusebox', 'radio', 'tv'], MAT.TECH, [55, 60, 62]],
  [['sign', 'poster', 'painting', 'picture', 'paint', 'pict', 'pntg', 'map', 'mural', 'logo', 'cred', 'mag', 'book', 'paper', 'pi_art', 'clock', 'tapestry', 'banner', 'popdog'], MAT.DECAL, [150, 130, 105]],
  [['carpet', 'crpt', 'rug', 'fabric', 'cloth', 'tarp', 'curtain', 'crtn', 'couch', 'bed', 'canvas', 'blinds', 'seat', 'cushion', 'cch'], MAT.FABRIC, [120, 50, 45]],
  [['roof', 'shingle', 'claytile', 'rf'], MAT.ROOF, [120, 70, 50]],
  [['tile', 'grout', 'lino', 'museumflr', 'marble', 'japflr', 'mktfloor'], MAT.TILE, [175, 170, 160]],
  [['wood', 'wd', 'plank', 'plywood', 'oak', 'board', 'brd', 'beam', 'log', 'bookcase', 'table', 'chair', 'drawer', 'wicker', 'barrel'], MAT.WOOD, [125, 90, 55]],
  [['brick', 'brck', 'brk', 'bricks'], MAT.BRICK, [140, 85, 65]],
  [['stone', 'stn', 'rock', 'out_rk', 'rck', 'cobble', 'cbbl', 'slate', 'cstl', 'castle', 'castwll', 'azwll', 'azwall', 'azt', 'temple', 'pillar', 'column', 'arch', 'statue', 'sphinx', 'pebble', 'paving', 'cobbles', 'stat'], MAT.STONE, [150, 135, 110]],
  [['sand', 'dirt', 'drt', 'mud', 'ground', 'grnd', 'gravel', 'hay', 'snd', 'rckpile'], MAT.GROUND, [165, 140, 100]],
  [['asphalt', 'apht', 'road', 'pave', 'pav', 'sidewlk', 'curb', 'track', 'tread'], MAT.CONCRETE, [80, 80, 80]],
  [['crete', 'conc', 'cncr', 'cement', 'cinder', 'concrete', 'ccrete', 'conrete', 'silo', 'tnnl', 'babtech', 'bunker'], MAT.CONCRETE, [135, 132, 125]],
  [['metal', 'mtl', 'metl', 'steel', 'iron', 'rust', 'pipe', 'vent', 'vnt', 'duct', 'tank', 'tnk', 'chrome', 'galv', 'hull', 'elev', 'lift', 'train', 'trk', 'van', 'apc', 'plane', '747', 'f15', 'barl', 'dumpster', 'dmp', 'cont', 'locker', 'freezer', 'rocket', 'turbine', 'conv', 'engine', 'wheel', 'bumper', 'cockpit', 'axle'], MAT.METAL, [105, 108, 110]],
  [['white'], MAT.PLASTER, [220, 220, 215]],
  [['black', 'drk'], MAT.PLASTER, [45, 45, 48]],
  [['red'], MAT.PLASTER, [150, 40, 35]],
  [['yellow', 'yel', 'gold'], MAT.PLASTER, [190, 160, 60]],
  [['blue', 'blu'], MAT.PLASTER, [55, 75, 130]],
  [['green', 'grn'], MAT.PLASTER, [70, 110, 70]],
  [['stucco', 'plaster', 'wall', 'wll', 'wl', 'ceil', 'ciel', 'clng', 'flr', 'floor', 'trim', 'bord', 'step', 'stair'], MAT.PLASTER, [170, 155, 130]],
];

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function isSkipped(name) {
  return SKIP.has(name);
}

// Returns { mat, flags, r, g, b, seed } for a lowercased texture name.
export function classify(name) {
  let flags = 0;
  let base = name;
  let forced = -1;

  // Strip GoldSrc prefixes: +N/+a animated, -N random tiling, { alpha, ! water, ~ luminous.
  while (base.length > 1) {
    const c = base[0];
    if ((c === '+' || c === '-') && base.length > 2) {
      if (c === '+') flags |= FLAG_SCROLL;
      base = base.slice(2);
    } else if (c === '{') {
      flags |= FLAG_ALPHATEST;
      base = base.slice(1);
    } else if (c === '!') {
      forced = MAT.WATER;
      base = base.slice(1);
    } else if (c === '~') {
      flags |= FLAG_FULLBRIGHT;
      base = base.slice(1);
    } else break;
  }

  const seed = hash32(name);
  let mat = MAT.PLASTER;
  let rgb = null;
  if (forced >= 0) {
    mat = forced;
    rgb = RULES[0][2];
  } else {
    for (const [keys, m, color] of RULES) {
      if (keys.some((k) => base.includes(k))) {
        mat = m;
        rgb = color;
        break;
      }
    }
  }

  if (!rgb) {
    // Unknown name: muted earthy color derived from the hash.
    const hue = (seed & 0xff) / 255;
    rgb = [
      120 + 50 * Math.cos(6.2832 * hue),
      115 + 35 * Math.cos(6.2832 * (hue + 0.33)),
      100 + 30 * Math.cos(6.2832 * (hue + 0.66)),
    ];
  }
  if (mat === MAT.LIGHT) flags |= FLAG_FULLBRIGHT;
  if (mat === MAT.WATER) flags |= FLAG_SCROLL;
  if (flags & FLAG_ALPHATEST && mat !== MAT.FOLIAGE) mat = MAT.GRATE;

  // Per-texture variation so neighbouring textures of one class differ slightly.
  const v = 0.85 + ((seed >>> 8) & 0xff) / 255 * 0.3;
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return {
    mat,
    flags,
    r: clamp(rgb[0] * v),
    g: clamp(rgb[1] * v),
    b: clamp(rgb[2] * v),
    seed: (seed >>> 16) & 0xff,
  };
}
