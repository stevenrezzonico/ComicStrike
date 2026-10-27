// Gun models for every weapon (zero assets): a parts library on client/gl/meshkit.js and
// one compact specification per gun, in CS:GO-like proportions and colors, flat and
// low-poly (art style: few colors, crisp shapes). Units are inches (= game units).
//
// Gun frame: x along the barrel, y left, z up; the origin is where the shooting hand
// holds the grip (the top of the pistol grip). Three bones: GUN_ROOT, GUN_MAG (the
// magazine, so reloads can drop it) and GUN_BOLT (slide, bolt, pump). Each model also
// reports the points hands and effects need (see buildGun).

import { MeshBuilder } from '../gl/meshkit.js';
import { WEAPONS } from '../../shared/weapons.js';

export const GUN_ROOT = 0;
export const GUN_MAG = 1;
export const GUN_BOLT = 2;
export const GUN_BONES = 3;

// Finishes.
const BLACK = [0.1, 0.1, 0.11];
const DARK = [0.18, 0.18, 0.19]; // gunmetal
const STEEL = [0.55, 0.57, 0.6];
const SILVER = [0.72, 0.73, 0.75];
const WOOD = [0.5, 0.28, 0.13];
const WOOD_DARK = [0.34, 0.19, 0.1];
const POLY = [0.15, 0.15, 0.15]; // black polymer
const OLIVE = [0.33, 0.37, 0.25]; // AWP / AUG green
const SAND = [0.55, 0.49, 0.36];
const C4_TAN = [0.52, 0.47, 0.3];
const LED = [0.95, 0.12, 0.08];

// --- parts ----------------------------------------------------------------------------
// All take the builder and work in the gun frame.

// Long-gun receiver: a box from x0 to x1, bottom at z0, height h, width w.
function receiver(b, x0, x1, z0, h, w, color) {
  b.color(color).box(x1 - x0, w, h, (x0 + x1) / 2, 0, z0 + h / 2);
}

// Round part along x (barrel, tube, silencer, scope body): radius r from x0 to x1 at
// height z (and side y).
function tube(b, x0, x1, r, z, color, seg = 6, y = 0) {
  b.color(color).push().translate(x0, y, z).rotate(90).lathe([[r, 0], [r, x1 - x0]], seg).pop();
}

// Pistol grip at the origin, raked back `rake` degrees (the bottom behind the top), `len`
// long.
function grip(b, len, w, color, rake = 15, depth = 1.6) {
  b.color(color).push().rotate(rake).extrude([[-depth * 0.55, 0.2], [depth * 0.45, 0.2], [depth * 0.4, -len],
    [-depth * 0.6, -len]], w).pop();
  b.color(color).box(1.6, w * 0.4, 0.25, 1.5, 0, -0.9); // trigger guard bar
}

// Magazine hanging from the receiver bottom at z0: front edge at x, `len` long, `depth`
// deep (along x), curving forward by `curve` (fraction of len) — on the GUN_MAG bone.
function magazine(b, x, z0, len, depth, w, color, curve = 0, rake = 0) {
  const pts = [];
  const steps = curve ? 3 : 1;
  const front = [], back = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const dx = curve * len * t * t + Math.tan(rake * Math.PI / 180) * len * t;
    front.push([x + dx, z0 - len * t]);
    back.push([x - depth + dx, z0 - len * t]);
  }
  pts.push(...back.slice().reverse(), ...front);
  b.bone(GUN_MAG).color(color).extrude(pts.reverse(), w).bone(GUN_ROOT);
}

// Drum or pan magazine: a disc of radius r and thickness t, centered at (x, z), axis
// along y.
function drum(b, x, z, r, t, color) {
  b.bone(GUN_MAG).color(color).push().translate(x, -t / 2, z).rotate(0, 0, -90).lathe([[r, 0], [r, t]], 10).pop()
    .bone(GUN_ROOT);
}

// Stock behind x0: 'solid' (wedge down to a butt `drop` below the bore line),
// 'skeleton' (two rails and a butt plate), 'tube' (buffer tube and a small butt).
function stock(b, type, x0, top, len, h, drop, color) {
  if (type === 'solid') {
    b.color(color).extrude([[x0, top], [x0, top - h * 0.5], [x0 - len, top - drop - h], [x0 - len, top - drop]], 1.5);
  } else if (type === 'skeleton') {
    b.color(color).box(len, 0.6, 0.5, x0 - len / 2, 0, top - 0.3);
    b.box(len, 0.6, 0.5, x0 - len / 2, 0, top - h + 0.3 - drop * 0.5);
    b.box(0.8, 1.4, h + drop * 0.5, x0 - len, 0, top - (h + drop * 0.5) / 2);
  } else if (type === 'tube') {
    tube(b, x0 - len * 0.6, x0, 0.6, top - 0.8, color);
    b.color(color).box(len * 0.45, 1.5, h, x0 - len + len * 0.22, 0, top - 0.8 - h * 0.35);
  }
}

// Telescopic sight along x centered on (x, z): a tube with wider bells and two mounts
// down to z0.
function scope(b, x, z, len, r, z0, color) {
  tube(b, x - len / 2, x - len / 2 + len * 0.22, r * 1.45, z, color, 8);
  tube(b, x - len / 2 + len * 0.22, x + len / 2 - len * 0.25, r, z, color, 8);
  tube(b, x + len / 2 - len * 0.25, x + len / 2, r * 1.6, z, color, 8);
  b.color(BLACK).box(0.8, 0.9, z - z0, x - len * 0.18, 0, (z + z0) / 2).box(0.8, 0.9, z - z0, x + len * 0.15, 0, (z + z0) / 2);
}

function sights(b, rear, front, z, color = BLACK) {
  b.color(color).box(0.5, 0.8, 0.6, rear, 0, z + 0.3).box(0.3, 0.25, 0.8, front, 0, z + 0.4);
}

// Pistol: slide (GUN_BOLT) from x = -1.4 forward, frame and grip; mag base in the grip.
function pistol(b, s) {
  const { len, h = 1.25, w = 1.0, slide = DARK, frame = POLY, gripLen = 4.2, rake = 18, barrel = 0 } = s;
  b.bone(GUN_BOLT).color(slide).box(len, w, h, -1.4 + len / 2, 0, 0.35 + h / 2);
  sights(b, -1.1, len - 1.7, 0.35 + h);
  b.bone(GUN_ROOT).color(frame).box(len * 0.72, w * 0.9, 0.55, -1.4 + len * 0.36 + 0.4, 0, 0.1);
  grip(b, gripLen, w * 1.05, frame, rake, 1.5);
  // Magazine base plate at the bottom of the grip.
  const bx = -Math.tan(rake * Math.PI / 180) * gripLen;
  b.bone(GUN_MAG).color(BLACK).box(1.6, w * 1.1, 0.4, bx, 0, -gripLen - 0.1).bone(GUN_ROOT);
  if (barrel) tube(b, -1.4 + len, -1.4 + len + barrel, 0.3, 0.9, DARK);
  const r = rake * Math.PI / 180;
  return {
    muzzle: [-1.4 + len + barrel, 0, 0.95], support: [-0.4, -0.6, -2.4],
    mag: [bx, 0, -gripLen - 0.3], magDir: [-Math.sin(r), 0, -Math.cos(r)], bolt: [-0.9, 0, 0.35 + h / 2],
  };
}

// Long gun from a spec (see GUNS): receiver, grip, barrel and handguard, magazine,
// stock, optics and extras. Returns the muzzle and support-hand points.
function longGun(b, s) {
  const metal = s.metal || DARK, furn = s.furniture || POLY;
  const [rx0, rx1] = s.receiver; // receiver x range
  const rh = s.height || 2.4, rw = s.width || 1.4, z0 = s.z0 ?? -0.3;
  const bore = z0 + rh * 0.62;
  receiver(b, rx0, rx1, z0, rh, rw, metal);
  if (s.carry) b.color(metal).box(s.carry[1] - s.carry[0], 0.8, 0.9, (s.carry[0] + s.carry[1]) / 2, 0, z0 + rh + 0.45);
  if (s.rail) b.color(BLACK).box(rx1 - rx0 - 1, 0.7, 0.35, (rx0 + rx1) / 2, 0, z0 + rh + 0.17);
  grip(b, s.gripLen || 3.6, rw * 0.85, s.gripColor || furn, s.rake ?? 15);
  // Bolt / charging handle on the right side.
  const bh = s.boltHandle ?? (rx0 + rx1) / 2;
  b.bone(GUN_BOLT).color(s.boltColor || metal).box(1.2, 0.9, 0.5, bh, -rw / 2 - 0.4, z0 + rh * 0.7).bone(GUN_ROOT);
  // Barrel and handguard.
  const bl = s.barrel;
  tube(b, rx1, rx1 + bl, s.barrelR || 0.35, bore, metal);
  if (s.handguard) {
    const [hl, hh, hw = rw * 1.05] = s.handguard;
    b.color(s.handguardColor || furn).box(hl, hw, hh, rx1 + hl / 2, 0, bore - hh * 0.3);
  }
  if (s.gasTube) tube(b, rx1, rx1 + s.gasTube, 0.32, bore + 0.75, metal);
  let muzzle = rx1 + bl;
  if (s.silencer) {
    tube(b, muzzle, muzzle + s.silencer, 0.75, bore, BLACK, 8);
    muzzle += s.silencer;
  } else if (s.brake) {
    tube(b, muzzle, muzzle + s.brake, 0.55, bore, metal);
    muzzle += s.brake;
  }
  if (s.tubeMag) { // shotgun magazine tube under the barrel, with the pump on it
    tube(b, rx1, rx1 + s.tubeMag, 0.42, bore - 1.05, metal);
    if (s.pump) b.bone(GUN_BOLT).color(furn).box(s.pump, 1.5, 1.3, rx1 + 2.5 + s.pump / 2, 0, bore - 1.05).bone(GUN_ROOT);
  }
  // Magazine; the hand takes it by its lower part.
  const m = s.mag;
  let mag = null, magDir = null;
  if (m) {
    const curve = m.curve || 0, lean = Math.tan((m.rake || 0) * Math.PI / 180);
    mag = m.drum ? [m.x, 0, z0 - m.drum * 1.6] : [m.x - (m.depth || 1.4) / 2 + (curve * 0.5 + lean) * m.len * 0.6, 0, z0 - m.len * 0.6];
    magDir = norm([m.drum ? 0 : curve + lean, 0, -1]);

    if (m.drum) drum(b, m.x, z0 - m.drum, m.drum, m.t || 2.2, m.color || metal);
    else magazine(b, m.x, z0 + 0.1, m.len, m.depth || 1.4, m.w || rw * 0.75, m.color || metal, m.curve || 0, m.rake || 0);
  }
  // Bolt handle on the right, or the pump under the barrel.
  const bolt = s.pump ? [rx1 + 2.5 + s.pump / 2, 0, bore - 1.75] : [bh, -rw / 2 - 0.8, z0 + rh * 0.7];
  if (s.stock) stock(b, s.stock, rx0, z0 + rh, s.stockLen || 9, s.stockH || 3.2, s.stockDrop ?? 1, s.stockColor || furn);
  if (s.scope) scope(b, s.scope[0], z0 + rh + 1.5, s.scope[1], s.scope[2] || 0.7, z0 + rh, s.scopeColor || BLACK);
  if (s.sights !== false && !s.scope) sights(b, rx0 + 1.5, muzzle - 1, bore + 0.3);
  if (s.foregrip) b.color(furn).box(1.2, 1.1, 3, s.foregrip, 0, z0 - 1.5); // vertical foregrip
  if (s.bipod) b.color(BLACK).box(0.5, 0.5, 4, s.bipod, 0.8, bore - 2.4).box(0.5, 0.5, 4, s.bipod, -0.8, bore - 2.4);
  // The off hand: a vertical foregrip, else the handguard (at most 12.5 in ahead of the
  // grip, where long guns are held), else under the receiver front.
  const support = s.support || (s.foregrip ? [s.foregrip, 0, z0 - 1.6]
    : s.handguard ? [Math.min(rx1 + s.handguard[0] * 0.55, 12.5), 0, bore - 1.2] : [rx1 - 1.5, 0, z0]);
  return { muzzle: [muzzle, 0, bore], support, mag, magDir, bolt, pump: !!s.pump, port: [rx1 - 2, 0, z0 - 0.3] };
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// --- specifications ----------------------------------------------------------------------
// Long guns: receiver [x0, x1], barrel length, handguard [length, height, width?],
// mag { x (front edge), len, depth, curve, drum }, stock type and size, scope [x, len, r].

const GUNS = {
  // Pistols: slide length, colors, extras.
  glock: { pistol: { len: 7.0, slide: DARK, frame: POLY } },
  hkp2000: { pistol: { len: 7.1, slide: BLACK, frame: POLY } },
  usp_silencer: { pistol: { len: 7.6, slide: BLACK, frame: POLY }, silencer: 5.6 },
  p250: { pistol: { len: 7.0, slide: DARK, frame: POLY } },
  elite: { pistol: { len: 8.4, slide: SILVER, frame: SILVER, h: 1.3 } },
  fiveseven: { pistol: { len: 7.8, slide: DARK, frame: [0.25, 0.27, 0.25] } },
  tec9: { long: { receiver: [-3, 6], height: 2.0, width: 1.2, barrel: 3, barrelR: 0.4, handguard: [2.5, 1.6], mag: { x: 1.6, len: 7, depth: 1.1 }, gripLen: 3.4, sights: true, support: [1.2, 0, -2.2] } },
  cz75a: { pistol: { len: 7.6, slide: DARK, frame: WOOD_DARK } },
  deagle: { pistol: { len: 10.6, h: 1.55, w: 1.25, slide: [0.42, 0.42, 0.44], frame: BLACK, gripLen: 4.6 } },
  revolver: { revolver: true },
  // SMGs.
  mac10: { long: { receiver: [-3.5, 5], height: 2.6, width: 1.5, barrel: 1.5, mag: { x: 1.2, len: 6.5, depth: 1.1 }, stock: 'skeleton', stockLen: 6, gripLen: 3.4, rake: 5 } },
  mp9: { long: { receiver: [-3, 6], height: 2.4, width: 1.3, barrel: 2, handguard: [2, 1.8], mag: { x: 1.1, len: 6.5, depth: 1.1 }, stock: 'skeleton', stockLen: 7, rail: true } },
  mp7: { long: { receiver: [-3, 6.5], height: 2.6, width: 1.4, barrel: 3, handguard: [2.5, 1.8], mag: { x: 1.1, len: 5.5, depth: 1.1 }, stock: 'skeleton', stockLen: 7, rail: true } },
  mp5sd: { long: { receiver: [-4, 6], height: 2.4, width: 1.4, barrel: 0.5, silencer: 9, handguard: [5.5, 2.2], mag: { x: 3.6, len: 6, depth: 1.2, curve: 0.25 }, stock: 'tube', stockLen: 8 } },
  ump45: { long: { receiver: [-4, 7], height: 2.8, width: 1.5, barrel: 3.5, handguard: [3.5, 2.2], mag: { x: 3.9, len: 7, depth: 1.5 }, stock: 'skeleton', stockLen: 8, rail: true } },
  p90: { long: { receiver: [-8, 8], height: 3.3, width: 2.2, z0: -1.4, barrel: 2.5, mag: null, stock: null, gripLen: 2.6, rake: 0, support: [6, 0, -1.2], top: true } },
  bizon: { long: { receiver: [-3.5, 6], height: 2.4, width: 1.5, barrel: 9, handguard: [3, 1.8], stock: 'skeleton', stockLen: 9, mag: null, helical: true } },
  // Rifles.
  galilar: { long: { receiver: [-3, 8.5], height: 2.6, barrel: 9, brake: 1.5, handguard: [7, 2.4], handguardColor: WOOD, mag: { x: 6.5, len: 7.5, depth: 1.6, curve: 0.18 }, stock: 'skeleton', stockLen: 9, carry: null } },
  famas: { long: { receiver: [-9, 8], height: 3.0, width: 1.6, barrel: 7, brake: 1, metal: DARK, mag: { x: -2.2, len: 5.5, depth: 1.4 }, carry: [-4, 6], gripLen: 3.6, support: [5, 0, -1.2], bipod: 13 } },
  ak47: { long: { receiver: [-2, 9], height: 2.6, barrel: 11, brake: 1.2, handguard: [7.5, 2.4], handguardColor: WOOD, gasTube: 7.5, mag: { x: 6.2, len: 8, depth: 1.8, curve: 0.3, color: [0.24, 0.2, 0.17] }, stock: 'solid', stockColor: WOOD, stockLen: 10, stockDrop: 2.2, gripColor: WOOD_DARK } },
  m4a1: { long: { receiver: [-2.5, 8], height: 2.6, barrel: 10, brake: 1.2, handguard: [7, 2.6], mag: { x: 6.2, len: 7, depth: 1.6, curve: 0.12 }, stock: 'tube', stockLen: 10, carry: null, rail: true } },
  m4a1_silencer: { long: { receiver: [-2.5, 8], height: 2.6, barrel: 7, silencer: 7, handguard: [6.5, 2.6], mag: { x: 6.2, len: 6, depth: 1.6, curve: 0.08 }, stock: 'tube', stockLen: 10, rail: true } },
  sg556: { long: { receiver: [-2.5, 8], height: 2.8, barrel: 10, brake: 1.4, handguard: [6.5, 2.6], mag: { x: 6, len: 6.5, depth: 1.6, curve: 0.2, color: [0.32, 0.3, 0.2] }, stock: 'skeleton', stockLen: 9.5, scope: [3, 7, 0.65] } },
  aug: { long: { receiver: [-10, 8], height: 2.8, width: 1.8, barrel: 8, brake: 1, metal: OLIVE, furniture: OLIVE, mag: { x: -2.5, len: 6, depth: 1.6, curve: 0.15, color: [0.5, 0.52, 0.5] }, scope: [2, 6, 0.7], scopeColor: OLIVE, foregrip: 4.5 } },
  ssg08: { long: { receiver: [-2, 9], height: 2.2, width: 1.3, barrel: 16, barrelR: 0.32, metal: DARK, furniture: [0.22, 0.24, 0.26], handguard: [8, 2, 1.4], mag: { x: 4, len: 3.5, depth: 2 }, stock: 'solid', stockLen: 12, stockDrop: 1.5, scope: [3, 11, 0.7], boltHandle: 0.5 } },
  awp: { long: { receiver: [-2, 10], height: 2.8, width: 1.6, barrel: 18, barrelR: 0.45, brake: 2, metal: DARK, furniture: OLIVE, handguard: [10, 2.6, 1.8], mag: { x: 5, len: 4, depth: 2.2 }, stock: 'solid', stockLen: 13, stockH: 4, stockDrop: 1, scope: [3.5, 13, 0.85], boltHandle: 0, gripLen: 3.8 } },
  g3sg1: { long: { receiver: [-3, 9], height: 2.8, barrel: 13, brake: 1.5, metal: DARK, furniture: BLACK, handguard: [8, 2.4], mag: { x: 6, len: 6, depth: 1.8, curve: 0.08 }, stock: 'solid', stockLen: 11, stockDrop: 1, scope: [3, 10, 0.75], bipod: 18 } },
  scar20: { long: { receiver: [-3, 9], height: 2.8, barrel: 12, brake: 1.5, metal: [0.24, 0.24, 0.23], furniture: SAND, handguard: [8, 2.6], handguardColor: SAND, mag: { x: 6, len: 5.5, depth: 1.8 }, stock: 'solid', stockColor: SAND, stockLen: 10, stockDrop: 0.8, scope: [3, 10, 0.75], rail: true } },
  // Shotguns.
  nova: { long: { receiver: [-2, 6.5], height: 2.4, barrel: 15, barrelR: 0.45, tubeMag: 12, pump: 6, mag: null, stock: 'solid', stockLen: 11, stockDrop: 2, furniture: POLY, support: [11, 0, -0.4] } },
  xm1014: { long: { receiver: [-2, 7], height: 2.4, barrel: 14, barrelR: 0.45, tubeMag: 13, handguard: [5, 1.6], mag: null, stock: 'tube', stockLen: 10, rail: true } },
  sawedoff: { long: { receiver: [-2, 4.5], height: 2.4, barrel: 8, barrelR: 0.5, tubeMag: 7, pump: 4.5, mag: null, gripColor: WOOD, furniture: WOOD, stock: null, support: [8, 0, -0.4] } },
  mag7: { long: { receiver: [-3, 8], height: 3.0, width: 1.8, barrel: 6, barrelR: 0.55, handguard: [5, 2.4], mag: { x: 1.2, len: 5, depth: 1.2 }, stock: 'skeleton', stockLen: 8, gripLen: 3.4, support: [10, 0, -1.4] } },
  // Machine guns.
  m249: { long: { receiver: [-3, 11], height: 3.4, width: 1.8, barrel: 14, brake: 1, handguard: [7, 2.8], mag: { x: 4.5, len: 5.5, depth: 4, w: 2.2, color: [0.3, 0.32, 0.24] }, stock: 'skeleton', stockLen: 10, carry: [2, 8], bipod: 20 } },
  negev: { long: { receiver: [-3, 11], height: 3.2, width: 1.8, barrel: 14, brake: 1.2, handguard: [8, 2.8], mag: { x: 4, drum: 3.4, t: 2.4, color: [0.3, 0.33, 0.25] }, stock: 'skeleton', stockLen: 10, carry: [1, 6], bipod: 21 } },
};

function buildRevolver(b) {
  b.bone(GUN_ROOT).color(SILVER).box(4.6, 1.1, 1.6, 0.4, 0, 0.8); // frame
  tube(b, -1.2, 1.8, 0.85, 0.85, SILVER, 6); // cylinder (on the slide bone for the reload swing)
  tube(b, 2.7, 9, 0.38, 1.1, SILVER);
  b.color(SILVER).box(6.4, 0.6, 0.45, 5.7, 0, 1.6); // top strap / rib
  sights(b, -1, 8.6, 1.8);
  grip(b, 4.2, 1.15, WOOD, 25, 1.6);
  return { muzzle: [9, 0, 1.1], support: [-0.4, -0.6, -2.4], cylinder: [0.3, 0, 0.85] };
}

function buildKnife(b) {
  b.color(BLACK).box(4.4, 1, 1.2, 0.6, 0, 0); // handle
  b.color(DARK).box(0.5, 1.2, 1.9, 3, 0, 0.1); // guard
  b.color(STEEL).extrude([[3.3, 0.55], [9.5, 0.55], [11.4, 0.1], [10.2, -0.55], [3.3, -0.55]], 0.25); // blade
  return { muzzle: [11.4, 0, 0], support: null }; // one-handed
}

// Grenades, upright in the hand (origin at the palm, body around it): HE (olive egg),
// flashbang and smoke (grey and green cans), molotov (bottle with a rag), incendiary
// (grey can, red band), decoy (small green can). Every one has the spoon and pin ring
// on top. The muzzle point is the top (the throw's release point).
const GRENADES = {
  hegrenade: { body: [[0.9, -1.6], [1.25, -0.9], [1.3, 0.3], [1.0, 1.0], [0.6, 1.3]], color: [0.3, 0.33, 0.2] },
  flashbang: { body: [[0.75, -1.9], [0.75, 1.3]], color: [0.62, 0.64, 0.66], band: [0.15, 0.15, 0.16] },
  smokegrenade: { body: [[0.85, -2.0], [0.85, 1.3]], color: [0.36, 0.42, 0.33], band: [0.75, 0.75, 0.72] },
  incgrenade: { body: [[0.8, -1.9], [0.8, 1.3]], color: [0.5, 0.5, 0.5], band: [0.75, 0.16, 0.1] },
  decoy: { body: [[0.7, -1.5], [0.7, 1.1]], color: [0.38, 0.46, 0.3], band: [0.2, 0.2, 0.2] },
};

function buildGrenade(b, name) {
  if (name === 'molotov') {
    b.color([0.36, 0.42, 0.22]).lathe([[1.05, -2.6], [1.05, 0.6], [0.45, 1.6], [0.4, 2.6]], 8); // bottle
    b.color([0.75, 0.68, 0.55]).box(0.7, 0.9, 1.4, 0, 0, 3.1); // rag in the neck
    b.color([0.75, 0.68, 0.55]).box(1.6, 0.4, 0.4, 0.6, 0, 3.6); // its loose end
    return { muzzle: [0, 0, 3.8], support: null };
  }
  const g = GRENADES[name], top = g.body[g.body.length - 1][1];
  b.color(g.color).lathe(g.body, 8);
  if (g.band) b.color(g.band).lathe([[g.body[0][0] + 0.06, -0.5], [g.body[0][0] + 0.06, 0.1]], 8);
  b.color(STEEL).box(0.9, 0.7, 0.7, 0, 0, top + 0.3); // fuse head
  b.box(0.35, 0.5, 2.4, -0.55, 0, top - 0.6).box(0.7, 0.5, 0.3, -0.25, 0, top + 0.6); // spoon
  b.box(0.15, 0.9, 0.9, 0.55, 0, top + 0.5); // pin ring
  return { muzzle: [0, 0, top + 0.8], support: null };
}

function buildC4(b, ledColor = LED) {
  b.color(C4_TAN).box(7, 4.6, 3, 3, 0, 0);
  b.color(BLACK).box(3.8, 3.2, 0.5, 3.5, 0, 1.75);
  b.color(ledColor).box(0.5, 0.5, 0.5, 1.2, 1.6, 1.75);
  b.color([0.8, 0.15, 0.1]).box(5, 0.3, 0.3, 3, 2.35, 0.5).box(5, 0.3, 0.3, 3, -2.35, 0.5); // wires
  return { muzzle: [6.5, 0, 0], support: [3, 2.6, 0] };
}

// The defuse kit (dropped kits, CT belts): a small yellow tool case.
export function buildDefuser() {
  const b = new MeshBuilder();
  b.color([0.75, 0.62, 0.15]).box(5, 1.6, 3, 0, 0, 1.5);
  b.color(BLACK).box(4, 1.7, 0.6, 0, 0, 3.3).box(1, 0.4, 1.4, -1.2, 0, 3.9).box(1, 0.4, 1.4, 1.2, 0, 3.9);
  return b.build();
}

// Builds the model of weapon `name` (shared/weapons.js names; opts.noSilencer: the
// M4A1-S / USP-S with their silencer off): { mesh, muzzle, support,
// mag, magDir, bolt, pump, port, cylinder }, points in the gun frame: the muzzle; the off
// hand's place (null: one-handed); where a hand takes the magazine and the way it comes
// out (null: no magazine); the bolt handle, slide rear or pump (pump: the bolt bone is a
// pump); a shotgun's loading port; the revolver's cylinder.
export function buildGun(name, opts = {}) {
  const b = new MeshBuilder().bone(GUN_ROOT);
  let pts;
  const g = GUNS[name];
  if (name === 'knife') pts = buildKnife(b);
  else if (name === 'molotov' || GRENADES[name]) pts = buildGrenade(b, name);
  else if (name === 'c4') pts = buildC4(b, opts.ledOff ? [0.3, 0.06, 0.05] : LED);
  else if (!g) throw new Error(`no gun model for ${name}`);
  else if (g.revolver) pts = buildRevolver(b);
  else if (g.pistol) {
    pts = pistol(b, g.pistol);
    if (g.silencer && !opts.noSilencer) {
      tube(b, pts.muzzle[0], pts.muzzle[0] + g.silencer, 0.55, pts.muzzle[2], BLACK, 8);
      pts.muzzle[0] += g.silencer;
    }
  } else {
    pts = longGun(b, opts.noSilencer && g.long.silencer ? { ...g.long, silencer: 0, brake: 1 } : g.long);
    if (g.long.top) { // P90: the magazine lies on top
      b.bone(GUN_MAG).color([0.35, 0.33, 0.28]).box(12, 1.8, 0.9, 0, 0, 2.4).bone(GUN_ROOT);
      b.color(BLACK).box(5, 1, 1, 7, 0, 3.2); // optic
      pts.mag = [-3, 0, 2.9];
      pts.magDir = norm([-0.4, 0, 1]);
    }
    if (g.long.helical) { // PP-Bizon: the helical magazine under the barrel
      b.bone(GUN_MAG).color(DARK).push().translate(5, 0, -1.4).rotate(90).lathe([[1.15, 0], [1.15, 8], [0.9, 8.6]], 8).pop()
        .bone(GUN_ROOT);
      pts.mag = [8, 0, -2.5];
      pts.magDir = norm([0.3, 0, -1]);
    }
  }
  return {
    mesh: b.build(), muzzle: pts.muzzle, support: pts.support, mag: pts.mag || null, magDir: pts.magDir || null,
    bolt: pts.bolt || null, pump: !!pts.pump, port: pts.port || null, cylinder: pts.cylinder || null,
  };
}

// Every weapon id's model (index = weapon id; 0 empty).
export function buildAllGuns() {
  return WEAPONS.map((w) => (w ? buildGun(w.name) : null));
}

