// Gun models for every weapon (zero assets): a parts library on client/gl/meshkit.js and
// one compact specification per gun, in CS:GO-like proportions and colors: few colors,
// bevelled edges and round parts, details (ribs, slots, serrations) in their own shade so
// the ink outlines them. Units are inches (= game units).
//
// Gun frame: x along the barrel, y left, z up; the origin is where the shooting hand
// holds the grip (the top of the pistol grip). Three bones: GUN_ROOT, GUN_MAG (the
// magazine, so reloads can drop it) and GUN_BOLT (slide, bolt, pump). Each model also
// reports the points hands and effects need (see buildGun).

import { MeshBuilder, FINISH, finish } from '../gl/meshkit.js';
import { WEAPONS } from '../../shared/weapons.js';

export const GUN_ROOT = 0;
export const GUN_MAG = 1;
export const GUN_BOLT = 2;
export const GUN_BONES = 3;

// Finishes (other colors print as polymer).
const BLACK = finish([0.1, 0.1, 0.11], FINISH.METAL);
const DARK = finish([0.18, 0.18, 0.19], FINISH.METAL); // gunmetal
const STEEL = finish([0.55, 0.57, 0.6], FINISH.METAL);
const SILVER = finish([0.72, 0.73, 0.75], FINISH.METAL);
const WOOD = finish([0.5, 0.28, 0.13], FINISH.WOOD);
const WOOD_DARK = finish([0.34, 0.19, 0.1], FINISH.WOOD);
const POLY = [0.15, 0.15, 0.15]; // black polymer
const OLIVE = [0.33, 0.37, 0.25]; // AWP / AUG green
const SAND = [0.55, 0.49, 0.36];
const BEVEL = 0.12; // edge rounding of boxes and outlines (in)
const SEG = 12; // sides of round parts
const C4_TAN = [0.52, 0.47, 0.3];
const LED = [0.95, 0.12, 0.08];
// Pistols: the off hand's point on the grip's left, beside the shooting hand's fingers,
// and its grasp (the grip's axis that far in, wrapped with the shooting hand: that half-size).
const PISTOL_SUPPORT = [-0.65, 1.35, -1.95];
const PISTOL_GRASP = [1.35, 1.5];
const LENS = finish([0.42, 0.6, 0.74], FINISH.METAL); // scope glass
const CAN = finish([0.3, 0.31, 0.33], FINISH.METAL); // silencers: lighter than the black slides and receivers
const STANAG = finish([0.36, 0.36, 0.37], FINISH.METAL); // aluminium AR magazines
const STANAG_LIGHT = finish([0.55, 0.55, 0.54], FINISH.METAL);

// --- parts ----------------------------------------------------------------------------
// All take the builder and work in the gun frame.

// Runs fn with the builder's edge rounding set to r (0: sharp, for small cheap details).
function withBevel(b, r, fn) {
  const bev = b.bev;
  b.bevel(r);
  fn();
  b.bevel(bev);
}

// A lighter or darker print of a color, keeping its finish: details in another color get
// their own ink outline (ribs, serrations).
function shade(c, k) {
  const s = c.map((v) => Math.min(1, v * k));
  if (c.finish !== undefined) s.finish = c.finish;
  return s;
}

// Long-gun receiver from x0 to x1, bottom at z0, height h, width w, its rear corners cut;
// `cover`: a rounded dust cover on top (AK, Galil), half a cover height above it.
function receiver(b, x0, x1, z0, h, w, color, cover = false) {
  const c = Math.min(0.5, h * 0.2);
  b.color(color).extrude([[x0, z0 + c], [x0 + c, z0], [x1, z0], [x1, z0 + h], [x0 + c, z0 + h], [x0, z0 + h - c]], w);
  if (cover) b.color(shade(color, 1.2)).rbox(x1 - x0 - 1.4, w * 0.84, 1, 0.42, (x0 + x1) / 2 + 0.4, 0, z0 + h);
}

// AR-15 receivers (M4A4, M4A1-S): a flat upper, its rear corner cut, on a darker lower
// whose magwell flares down round the magazine `m`; the ejection port cover and the
// forward assist on the right.
function arReceiver(b, rx0, rx1, z0, rh, rw, color, m) {
  const zu = z0 + rh * 0.45, top = z0 + rh;
  b.color(color).extrude([[rx0, zu], [rx1, zu], [rx1, top], [rx0 + 0.5, top], [rx0, top - 0.5]], rw * 0.9);
  const mf = m.x + 0.3, mb = m.x - (m.depth || 1.4) - 0.3;
  b.color(shade(color, 0.8)).extrude([[rx0 + 0.6, z0 + 0.3], [mb, z0], [mb - 0.15, z0 - 0.9], [mf + 0.1, z0 - 0.9],
    [mf + 0.2, z0 + 0.2], [mf + 0.9, zu], [rx0 + 0.6, zu]], rw);
  withBevel(b, 0, () => b.color(shade(color, 1.4)).box(2.4, 0.1, (top - zu) * 0.5, (rx0 + rx1) / 2 + 0.4,
    -rw * 0.45 - 0.05, (zu + top) / 2 + 0.05));
  tube(b, rx0 + 0.5, rx0 + 1.7, 0.26, top - 0.55, shade(color, 1.2), 10, -rw * 0.45 - 0.1);
}

// Round part along x (barrel, tube, silencer): radius r from x0 to x1 at height z (and
// side y).
function tube(b, x0, x1, r, z, color, seg = SEG, y = 0) {
  b.color(color).push().translate(x0, y, z).rotate(90).lathe([[r, 0], [r, x1 - x0]], seg).pop();
}

// Surface of revolution along x from x0 at height z: profile [[radius, distance], ...].
function turned(b, x0, z, profile, color, seg = SEG) {
  b.color(color).push().translate(x0, 0, z).rotate(90).lathe(profile, seg).pop();
}

// Pistol grip at the origin, raked back `rake` degrees (the bottom behind the top), `len`
// long, with a palm swell; the trigger guard and trigger ahead of it.
function grip(b, len, w, color, rake = 15, depth = 1.6) {
  const d = depth;
  withBevel(b, 0.25, () => b.color(color).push().rotate(rake).extrude([[-d * 0.55, 0.2], [d * 0.45, 0.2],
    [d * 0.42, -len * 0.25], [d * 0.5, -len * 0.5], [d * 0.42, -len * 0.75], [d * 0.4, -len], [-d * 0.62, -len],
    [-d * 0.68, -len * 0.55], [-d * 0.6, -len * 0.2]], w).pop());
  withBevel(b, 0, () => {
    b.color(color).box(1.9, w * 0.35, 0.22, 1.55, 0, -1.25).box(0.22, w * 0.35, 1.25, 2.45, 0, -0.68);
    b.color(BLACK).push().translate(1.25, 0, -0.25).rotate(-15).box(0.22, 0.25, 0.75, 0, 0, -0.3).pop();
  });
}

// Magazine hanging from the receiver bottom at z0: front edge at x, `len` long, `depth`
// deep (along x), curving forward by `curve` (fraction of len) — on the GUN_MAG bone. A
// floor plate at the bottom and `ribs` ribs across its sides.
function magazine(b, x, z0, len, depth, w, color, curve = 0, rake = 0, ribs = 0) {
  const lean = Math.tan(rake * Math.PI / 180);
  const dx = (t) => curve * len * t * t + lean * len * t;
  const steps = curve ? 6 : 1;
  const front = [], back = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    front.push([x + dx(t), z0 - len * t]);
    back.push([x - depth + dx(t), z0 - len * t]);
  }
  const pts = [...back.slice().reverse(), ...front];
  b.bone(GUN_MAG).color(color).extrude(pts.reverse(), w);
  // Across the magazine at t: turned with the curve.
  const across = (t, sx, sy, sz, c, dz = 0) => {
    const deg = Math.atan(2 * curve * t + lean) * 180 / Math.PI;
    b.color(c).push().translate(x - depth / 2 + dx(t), 0, z0 - len * t + dz).rotate(-deg).box(sx, sy, sz).pop();
  };
  withBevel(b, 0, () => {
    for (let i = 1; i <= ribs; i++) across(0.1 + 0.8 * i / (ribs + 1), depth * 0.72, w + 0.14, 0.2, shade(color, 1.35));
  });
  withBevel(b, 0.1, () => across(1, depth + 0.25, w + 0.2, 0.4, shade(color, 0.7), -0.05));
  b.bone(GUN_ROOT);
}

// Drum or pan magazine: a disc of radius r and thickness t, centered at (x, z), axis
// along y, its face stepped in.
function drum(b, x, z, r, t, color) {
  b.bone(GUN_MAG).color(color).push().translate(x, -t / 2, z).rotate(0, 0, -90)
    .lathe([[r * 0.85, 0], [r, t * 0.15], [r, t * 0.85], [r * 0.85, t]], 16).pop().bone(GUN_ROOT);
}

// Handguard from x0, `hl` long, `hh` high, `hw` wide around the barrel at `bore`:
// 'round' a ribbed tube with end caps (M4), 'quad' a rail on every side (KAC RAS), 'forend'
// under the barrel only (AWP), 'wood' a tapered lower half (AK, Galil), else a rounded block.
function handguard(b, style, x0, hl, hh, hw, bore, color) {
  if (style === 'round') {
    const r = hh / 2, n = Math.max(3, Math.round((hl - 0.8) / 0.9)), s = (hl - 0.8) / n;
    const prof = [[r * 1.1, 0], [r * 1.1, 0.4]];
    for (let i = 0; i < n; i++) {
      const a = 0.4 + s * i;
      prof.push([r, a], [r, a + s * 0.55], [r * 0.9, a + s * 0.55], [r * 0.9, a + s]);
    }
    prof.push([r * 1.1, hl - 0.4], [r * 1.1, hl]);
    turned(b, x0, bore, prof, color, 10);
  } else if (style === 'quad') {
    quadRail(b, x0, hl, hh, bore, color);
  } else if (style === 'forend') { // under the barrel only, tapering to the front
    withBevel(b, 0.3, () => b.color(color).extrude([[x0, bore + 0.15], [x0, bore - hh], [x0 + hl * 0.7, bore - hh * 0.8],
      [x0 + hl, bore - hh * 0.45], [x0 + hl, bore + 0.15]], hw));
  } else if (style === 'wood') {
    const top = bore + 0.2, bot = bore - hh * 0.8;
    withBevel(b, 0.3, () => b.color(color).extrude([[x0, top], [x0 + hl, top], [x0 + hl, bot + 0.6],
      [x0 + hl - 0.7, bot], [x0 + 0.6, bot + 0.05], [x0, bot + 0.5]], hw));
  } else {
    b.color(color).rbox(hl, hw, hh, 0.35, x0 + hl / 2, 0, bore - hh * 0.3);
  }
}

// Silencer from x, `len` long, radius r at height z: a thin coupling, a fat can in its own
// grey with a lighter band at each end (so the ink outlines it apart from the gun), a
// rounded front cap and the bore.
function silencer(b, x, len, r, z) {
  turned(b, x, z, [[r * 0.55, 0], [r * 0.55, 0.3], [r * 0.92, 0.36], [r, 0.5], [r, len - 0.35], [r * 0.82, len - 0.05],
    [r * 0.45, len]], CAN, 14);
  withBevel(b, 0, () => {
    turned(b, x + 0.75, z, [[r * 1.03, 0], [r * 1.03, 0.22]], shade(CAN, 1.45), 14);
    turned(b, x + len - 0.95, z, [[r * 1.03, 0], [r * 1.03, 0.22]], shade(CAN, 1.45), 14);
  });
  turned(b, x + len - 0.02, z, [[r * 0.32, 0], [r * 0.32, 0.04]], BLACK, 10);
}

// Quad rail handguard (KAC RAS) from x0, `hl` long, `hh` across, round the bore: a square
// tube with a slotted rail on top and ribbed rail covers over the sides and the bottom.
function quadRail(b, x0, hl, hh, bore, color) {
  const xm = x0 + hl / 2, c = hh * 0.86, cover = shade(color, 1.3), rib = shade(color, 0.75);
  b.color(color).rbox(hl, c, c, 0.25, xm, 0, bore);
  rail(b, x0 + 0.1, x0 + hl - 0.1, bore + c / 2 - 0.05, 0.8);
  const cl = hl - 1.2, n = Math.round(cl / 0.9);
  withBevel(b, 0, () => {
    for (const y of [-1, 1]) b.color(cover).box(cl, 0.16, c * 0.62, xm, y * (c / 2 + 0.06), bore);
    b.color(cover).box(cl, c * 0.62, 0.16, xm, 0, bore - c / 2 - 0.06);
    for (let i = 0; i < n; i++) {
      const x = xm - cl / 2 + (i + 0.5) * cl / n;
      for (const y of [-1, 1]) b.color(rib).box(0.16, 0.06, c * 0.56, x, y * (c / 2 + 0.16), bore);
    }
  });
}

// AR-15 front sight base at x: a block clamped round the barrel, the A-frame up to
// `top` with the post on it, the bayonet lug under it.
function frontSightBase(b, x, bore, top, color) {
  b.color(color).rbox(1.3, 0.9, 1.0, 0.15, x, 0, bore - 0.05);
  b.push().translate(x, 0, 0).extrude([[-0.7, bore + 0.35], [0.7, bore + 0.35], [0.22, top], [-0.22, top]], 0.55).pop();
  withBevel(b, 0, () => b.color(BLACK).box(0.22, 0.2, 0.45, x, 0, top + 0.2).color(color).box(0.8, 0.45, 0.55, x + 0.15, 0, bore - 0.8));
}

// Flip-up rear sight (ARMS #40) on a top rail at x, z the rail's top.
function flipSight(b, x, z) {
  withBevel(b, 0, () => {
    b.color(BLACK).box(1.2, 0.8, 0.35, x, 0, z + 0.17);
    b.box(0.3, 0.62, 0.75, x + 0.25, 0, z + 0.7);
  });
}

// Muzzle device from x, `len` long, radius r at height z: 'bird' a flared birdcage with
// slots (M4), 'slant' a brake cut at the front (AK), else a brake with lipped ends.
function muzzleDevice(b, x, len, r, z, color, style) {
  if (style === 'bird') {
    turned(b, x, z, [[r * 0.75, 0], [r * 0.75, len * 0.15], [r, len * 0.3], [r, len], [r * 0.7, len]], color);
    withBevel(b, 0, () => {
      for (let i = 0; i < 2; i++) b.color(BLACK).box(len * 0.45, 0.08, r * 0.5, x + len * 0.65, (i ? 1 : -1) * r, z);
      b.color(BLACK).box(len * 0.45, r * 0.5, 0.08, x + len * 0.65, 0, z + r);
    });
  } else if (style === 'slant') {
    turned(b, x, z, [[r, 0], [r, len * 0.7], [r * 0.82, len]], color);
    withBevel(b, 0, () => b.color(BLACK).box(len * 0.3, r * 0.6, 0.1, x + len * 0.5, 0, z + r * 0.97));
  } else {
    turned(b, x, z, [[r * 0.9, 0], [r, len * 0.12], [r, len * 0.88], [r * 0.9, len]], color);
  }
}

// Stock behind x0: 'solid' (a wedge down to a butt `drop` below the bore line, with a
// pad), 'skeleton' (two rails and a butt plate), 'tube' (buffer tube and a small butt),
// 'collapsible' (M4: the buffer tube straight back from the receiver, the stock body an
// angular wedge on it, a rubber butt), 'thumbhole' (AWP: a comb with a cheek rest back to a
// tall butt, a bar under it from the butt to the bottom of the pistol grip, `low` its z,
// and the hole between).
function stock(b, type, x0, top, len, h, drop, color, low = -3.6) {
  const pad = color.finish === FINISH.WOOD ? BLACK : shade(color, 0.6);
  if (type === 'solid') {
    withBevel(b, 0.32, () => b.color(color).extrude([[x0, top], [x0, top - h * 0.5],
      [x0 - len * 0.35, top - drop * 0.35 - h * 0.6], [x0 - len, top - drop - h], [x0 - len, top - drop],
      [x0 - len * 0.5, top - drop * 0.5 + 0.05]], 1.5));
    b.color(pad).rbox(0.45, 1.6, h + 0.1, 0.18, x0 - len - 0.2, 0, top - drop - h / 2);
  } else if (type === 'skeleton') {
    b.color(color).box(len, 0.6, 0.5, x0 - len / 2, 0, top - 0.3);
    b.box(len, 0.6, 0.5, x0 - len / 2, 0, top - h + 0.3 - drop * 0.5);
    b.rbox(0.8, 1.4, h + drop * 0.5, 0.3, x0 - len, 0, top - (h + drop * 0.5) / 2);
  } else if (type === 'thumbhole') {
    const xb = x0 - len, zt = top - drop, zb = low - 0.4;
    withBevel(b, 0.3, () => {
      b.color(color).extrude([[xb + 1.2, zt - 1.7], [x0 + 0.3, top - 1.9], [x0 + 0.3, top - 0.1], [xb + 1.2, zt]], 1.5);
      b.extrude([[xb + 1, zb], [-1.0, low - 0.25], [-0.55, low + 1], [xb + 1, zb + 1.4]], 1.5);
      b.extrude([[xb + 0.5, zb], [xb + len * 0.62, low - 0.2], [xb + len * 0.5, zt - 1.2], [xb + 0.5, zt]], 1.5); // solid behind the hole
      b.rbox(1.8, 1.6, zt - zb, 0.4, xb + 0.9, 0, (zt + zb) / 2);
    });
    b.color(shade(color, 1.2)).rbox(len * 0.45, 1.3, 0.7, 0.3, x0 - len * 0.45, 0, zt + (top - zt) * 0.45 + 0.15); // cheek rest
    b.color(pad).rbox(0.5, 1.7, zt - zb + 0.2, 0.2, xb - 0.2, 0, (zt + zb) / 2);
  } else if (type === 'collapsible') {
    tube(b, x0 - len * 0.8, x0, 0.58, top - 0.75, color);
    b.color(color).extrude([[x0 - len, top - 0.25 - h], [x0 - len + 1.3, top - 0.25 - h], [x0 - len * 0.42, top - 1.45],
      [x0 - len * 0.42, top - 0.15], [x0 - len, top - 0.05]], 1.45);
    b.color(pad).rbox(0.45, 1.55, h + 0.25, 0.18, x0 - len - 0.18, 0, top - 0.15 - h / 2);
  } else if (type === 'tube') {
    tube(b, x0 - len * 0.6, x0, 0.6, top - 0.8, color);
    b.color(color).rbox(len * 0.45, 1.5, h, 0.4, x0 - len + len * 0.22, 0, top - 0.8 - h * 0.35);
  }
}

// Telescopic sight along x centered on (x, z): objective and eyepiece bells, turrets, blue
// lenses at both ends, two mounts down to z0.
function scope(b, x, z, len, r, z0, color) {
  const x0 = x - len / 2;
  turned(b, x0, z, [[r * 1.3, 0], [r * 1.45, len * 0.05], [r * 1.45, len * 0.2], [r, len * 0.3], [r, len * 0.68],
    [r * 1.6, len * 0.82], [r * 1.6, len]], color);
  turned(b, x0 - 0.04, z, [[r * 1.1, 0], [r * 1.1, 0.08]], LENS);
  turned(b, x0 + len - 0.04, z, [[r * 1.35, 0], [r * 1.35, 0.08]], LENS);
  b.color(color).push().translate(x0 + len * 0.49, 0, z + r * 0.8).lathe([[r * 0.5, 0], [r * 0.5, r * 0.8]], 10).pop();
  b.push().translate(x0 + len * 0.49, -r * 0.8, z).rotate(0, 0, 90).lathe([[r * 0.45, 0], [r * 0.45, r * 0.7]], 10).pop();
  b.color(BLACK).box(0.8, 0.9, z - z0, x - len * 0.18, 0, (z + z0) / 2).box(0.8, 0.9, z - z0, x + len * 0.15, 0, (z + z0) / 2);
}

// Iron sights of a long gun: a notch at x `rear` whose base is at `top` (on a block of its
// own unless `block` is false: a carry handle's housing), and an A-frame front post at
// `front` rising from the barrel (`base`) to the same height.
function ironSights(b, rear, front, base, top, block = true, color = BLACK) {
  rearNotch(b, rear, top, block, color);
  withBevel(b, 0, () => {
    b.color(color).push().translate(front, 0, 0).extrude([[-0.5, base], [0.5, base], [0.12, top + 0.25], [-0.12, top + 0.25]], 0.3).pop();
  });
}

// A notch rear sight at x `rear`, its base at `top` (on a block of its own, or not).
function rearNotch(b, rear, top, block = true, color = BLACK) {
  withBevel(b, 0, () => {
    if (block) b.color(color).box(0.6, 0.9, 0.35, rear, 0, top - 0.17);
    b.color(color).box(0.6, 0.22, 0.3, rear, 0.34, top + 0.12).box(0.6, 0.22, 0.3, rear, -0.34, top + 0.12);
  });
}

// Small sights on a slide or frame (pistols, the revolver).
function pistolSights(b, rear, front, z, color = BLACK) {
  withBevel(b, 0, () => b.color(color).box(0.5, 0.8, 0.3, rear, 0, z + 0.15).box(0.25, 0.22, 0.35, front, 0, z + 0.17));
}

// Rail on top from x0 to x1 at height z, its cross slots (every `step`) each outlined.
function rail(b, x0, x1, z, step = 0.6) {
  withBevel(b, 0, () => {
    b.color(BLACK).box(x1 - x0, 0.75, 0.3, (x0 + x1) / 2, 0, z + 0.15);
    for (let x = x0 + 0.35; x < x1 - 0.2; x += step) b.color(DARK).box(0.24, 0.8, 0.14, x, 0, z + 0.34);
  });
}

// Carry handle from x0 to x1 on the receiver top z: one arch (two posts and a bridge, the
// gap showing) rising at its back end into the rear sight housing, its heights times k.
// Returns the sight's base height.
function carryHandle(b, x0, x1, z, color, k = 1) {
  b.color(color).extrude([[x0, z], [x0 + 0.8, z], [x0 + 0.8, z + 0.85 * k], [x1 - 0.8, z + 0.85 * k], [x1 - 0.8, z], [x1, z],
    [x1, z + 1.35 * k], [x0 + 1.1, z + 1.35 * k], [x0 + 0.9, z + 1.75 * k], [x0, z + 1.75 * k]], 0.8);
  return z + 1.75 * k;
}

// Pistol: slide (GUN_BOLT) from x = -1.4 forward with its front top cut, grip serrations,
// the ejection port and the bore; frame and grip; mag base in the grip.
function pistol(b, s) {
  const { len, h = 1.25, w = 1.0, slide = DARK, frame = POLY, gripLen = 4.2, rake = 18, barrel = 0 } = s;
  const x0 = -1.4, x1 = x0 + len, sz = 0.35;
  // The slide; the Desert Eagle's covers only the back, its fixed barrel running the whole
  // length on top: a long block, flat on top, its sides narrowing to the bottom.
  const sx1 = s.deagle ? x0 + len * 0.5 : x1;
  b.bone(GUN_BOLT).color(slide).extrude([[x0, sz], [sx1, sz], [sx1, sz + h * 0.7], [sx1 - 0.45, sz + h], [x0, sz + h]], w);
  withBevel(b, 0, () => {
    for (let i = 0; i < 5; i++) b.color(shade(slide, 1.6)).box(0.08, w + 0.04, h * 0.62, x0 + 0.35 + i * 0.22, 0, sz + h * 0.5);
    b.color(BLACK).box(Math.min(1.6, len * 0.22), 0.06, h * 0.45, x0 + len * 0.45, -w / 2, sz + h * 0.62); // ejection port
  });
  b.bone(GUN_ROOT);
  if (s.deagle) {
    const zt = sz + h, zb = sz + 0.05, hw = w / 2;
    b.color(shade(slide, 0.9)).push().translate(x0 + len * 0.71, 0, 0).rotate(0, 90)
      .extrude([[-hw * 0.45, zb], [hw * 0.45, zb], [hw * 1.02, zt - 0.3], [hw * 0.9, zt], [-hw * 0.9, zt], [-hw * 1.02, zt - 0.3]], len * 0.58)
      .pop();
    withBevel(b, 0, () => b.color(shade(slide, 1.3)).box(len * 0.5, w * 0.5, 0.1, x0 + len * 0.7, 0, zt + 0.04)); // the rib on top
  }
  turned(b, x1 - 0.02, 0.95, [[0.22, 0], [0.22, 0.05]], BLACK, 10); // the bore
  pistolSights(b, x0 + 0.3, x1 - 0.4, sz + h);
  // The frame: the dust cover under the slide's front (an accessory rail's notch on it).
  b.color(frame).extrude([[x0 + 0.4, -0.25], [x1 - 0.9, -0.25], [x1 - 0.5, 0.05], [x1 - 0.5, sz + 0.05], [x0 + 0.4, sz + 0.05]], w * 0.9);
  withBevel(b, 0, () => b.color(shade(frame, 1.7)).box(Math.min(2, len * 0.22), w * 0.92, 0.08, x1 - 1.9, 0, -0.12));
  grip(b, gripLen, w * 1.05, frame, rake, 1.8);
  // Magazine base plate at the bottom of the grip (extended on the Glock).
  const bx = -Math.tan(rake * Math.PI / 180) * gripLen;
  b.bone(GUN_MAG).color(BLACK).box(s.baseplate ? 1.95 : 1.75, w * 1.1, s.baseplate ? 0.6 : 0.4, bx, 0, -gripLen - (s.baseplate ? 0.2 : 0.1))
    .bone(GUN_ROOT);
  if (barrel) tube(b, x1, x1 + barrel, 0.3, 0.9, DARK);
  const r = rake * Math.PI / 180;
  return {
    // The off hand wraps the shooting hand on the grip's left (a two-handed hold): its
    // fingers curl around the grip and the shooting hand's fingers.
    muzzle: [x1 + barrel, 0, 0.95], support: [...PISTOL_SUPPORT], grasp: [...PISTOL_GRASP], gripR: w * 1.05 / 2,
    mag: [bx, 0, -gripLen - 0.3], magDir: [-Math.sin(r), 0, -Math.cos(r)], bolt: [-0.9, 0, sz + h / 2],
  };
}

// Long gun from a spec (see GUNS): receiver, grip, barrel and handguard, magazine,
// stock, optics and extras. Returns the muzzle and support-hand points.
function longGun(b, s) {
  const metal = s.metal || DARK, furn = s.furniture || POLY;
  const [rx0, rx1] = s.receiver; // receiver x range
  const rh = s.height || 2.4, rw = s.width || 1.4, z0 = s.z0 ?? -0.3;
  const bore = z0 + rh * 0.62, top = z0 + rh;
  if (s.ar) arReceiver(b, rx0, rx1, z0, rh, rw, metal, s.mag);
  else receiver(b, rx0, rx1, z0, rh, rw, metal, s.cover);
  let sightTop = top + (s.cover ? 0.5 : s.ar ? 1.05 : 0) + 0.35;
  if (s.carry) sightTop = carryHandle(b, s.carry[0], s.carry[1], top, metal, s.carryH || (s.ar ? 0.8 : 1));
  if (s.rail) rail(b, rx0 + 0.5, rx1 - 0.5, top);
  const gw = Math.min(rw * 0.85, 1.3); // pistol grip width (a hand's span, even on a wide body)
  grip(b, s.gripLen || 3.6, gw, s.gripColor || furn, s.rake ?? 15);
  // Bolt / charging handle on the right side; an AR's T-handle at the back of the upper.
  const bh = s.boltHandle ?? (rx0 + rx1) / 2;
  if (s.ar) b.bone(GUN_BOLT).color(metal).box(0.9, 1.5, 0.3, rx0 + 0.55, 0, top + 0.15).bone(GUN_ROOT);
  else b.bone(GUN_BOLT).color(s.boltColor || metal).box(1.2, 0.9, 0.5, bh, -rw / 2 - 0.4, z0 + rh * 0.7).bone(GUN_ROOT);
  // Barrel and handguard.
  const bl = s.barrel, br = s.barrelR || 0.35;
  tube(b, rx1, rx1 + bl, br, bore, metal);
  const hgColor = s.handguardColor || furn;
  if (s.handguard) {
    const [hl, hh, hw = rw * 1.05] = s.handguard;
    handguard(b, s.hg || (hgColor.finish === FINISH.WOOD ? 'wood' : 'block'), rx1, hl, hh, hw, bore, hgColor);
  }
  if (s.gasTube) {
    tube(b, rx1, rx1 + s.gasTube, 0.32, bore + 0.75, metal);
    if (s.gasBlock) b.color(metal).rbox(1.1, 0.95, 1.55, 0.2, rx1 + s.gasTube + 0.45, 0, bore + 0.3);
    if (hgColor.finish === FINISH.WOOD) b.color(hgColor).rbox(s.gasTube * 0.6, rw * 0.8, 0.95, 0.4, rx1 + s.gasTube * 0.3 + 0.2, 0, bore + 0.75);
  }
  let muzzle = rx1 + bl;
  if (s.silencer) {
    silencer(b, muzzle, s.silencer, s.silencerR || 0.75, bore);
    muzzle += s.silencer;
  } else if (s.brake) {
    muzzleDevice(b, muzzle, s.brake, 0.55, bore, metal, s.brakeStyle);
    muzzle += s.brake;
  }
  if (s.tubeMag) { // shotgun magazine tube under the barrel, with the pump on it
    tube(b, rx1, rx1 + s.tubeMag, 0.42, bore - 1.05, metal);
    if (s.pump) {
      const px = rx1 + 2.5 + s.pump / 2;
      b.bone(GUN_BOLT).color(furn).rbox(s.pump, 1.5, 1.3, 0.5, px, 0, bore - 1.05);
      withBevel(b, 0, () => {
        for (let i = 1; i < 4; i++) b.color(shade(furn, 1.6)).box(0.14, 1.56, 1.1, px - s.pump / 2 + s.pump * i / 4, 0, bore - 1.05);
      });
      b.bone(GUN_ROOT);
    }
  }
  // Magazine; the hand takes it by its lower part.
  const m = s.mag;
  let mag = null, magDir = null;
  if (m) {
    const curve = m.curve || 0, lean = Math.tan((m.rake || 0) * Math.PI / 180);
    mag = m.drum ? [m.x, 0, z0 - m.drum * 1.75] : [m.x - (m.depth || 1.4) / 2 + (curve * 0.5 + lean) * m.len * 0.6, 0, z0 - m.len * 0.6];
    magDir = norm([m.drum ? 0 : curve + lean, 0, -1]);

    if (m.drum) drum(b, m.x, z0 - m.drum, m.drum, m.t || 2.2, m.color || metal);
    else magazine(b, m.x, z0 + 0.1, m.len, m.depth || 1.4, m.w || rw * 0.75, m.color || metal, curve, m.rake || 0, m.ribs || 0);
  }
  // Bolt handle on the right, or the pump under the barrel.
  const bolt = s.pump ? [rx1 + 2.5 + s.pump / 2, 0, bore - 1.75] : s.ar ? [rx0 + 0.2, 0, top + 0.2]
    : [bh, -rw / 2 - 0.8, z0 + rh * 0.7];
  if (s.stock) stock(b, s.stock, rx0, top - (s.stockTop || 0), s.stockLen || 9, s.stockH || 3.2, s.stockDrop ?? 1, s.stockColor || furn, -(s.gripLen || 3.6));
  if (s.scope) scope(b, s.scope[0], top + 1.5, s.scope[1], s.scope[2] || 0.7, top, s.scopeColor || BLACK);
  if (s.ar) { // the front sight base ahead of the handguard; a flip-up rear sight, or the carry handle's
    frontSightBase(b, rx1 + (s.handguard ? s.handguard[0] : 0) + 0.7, bore, sightTop, metal);
    if (s.carry) rearNotch(b, s.carry[0] + 0.45, sightTop, false, metal);
    else flipSight(b, rx0 + 1.4, top + 0.3);
  } else if (s.sights !== false && !s.scope) {
    const front = s.frontSight ?? Math.min(s.handguard ? rx1 + s.handguard[0] + 0.8 : muzzle - 1, muzzle - 1);
    ironSights(b, s.rearSight ?? (s.carry ? s.carry[0] + 0.45 : rx0 + 1.5), front, bore + br * 0.5, sightTop, !s.carry);
  }
  if (s.foregrip) b.color(furn).rbox(1.2, 1.1, 3, 0.45, s.foregrip, 0, z0 - 1.5); // vertical foregrip
  if (s.handGuard) { // bullpups: a guard round the whole hand, from the grip's foot up to the body at x handGuard
    const L = s.gripLen || 3.6;
    withBevel(b, 0.15, () => b.color(furn).extrude([[0.2, -L - 0.05], [1.0, -L - 0.3], [s.handGuard + 0.6, z0 + 0.1],
      [s.handGuard - 0.1, z0 + 0.1]], 0.7));
  }
  if (s.bipod) b.color(BLACK).box(0.5, 0.5, 4, s.bipod, 0.8, bore - 2.4).box(0.5, 0.5, 4, s.bipod, -0.8, bore - 2.4);
  // The off hand: a vertical foregrip, else the handguard (at most 12.5 in ahead of the
  // grip, where long guns are held), else under the receiver front.
  const support = s.support || (s.foregrip ? [s.foregrip, 0, z0 - 1.6]
    : s.handguard ? [Math.min(rx1 + s.handguard[0] * 0.55, 12.5), 0, bore - 1.2] : [rx1 - 1.5, 0, z0]);
  // What the off hand holds there: how far its axis is above the support point, its
  // half-height (the fingers curl around it), 1 if it stands upright (a foregrip, a
  // magazine) rather than lying along the barrel, and its half-width (default the height).
  let grasp;
  if (s.grasp) grasp = s.grasp;
  else if (s.foregrip) grasp = [0.1, 0.6, 1];
  else if (s.handguard) {
    const [, hh, hw = rw * 1.05] = s.handguard;
    const style = s.hg || (hgColor.finish === FINISH.WOOD ? 'wood' : 'block');
    if (style === 'round' || style === 'quad') grasp = [1.2, hh / 2];
    else if (style === 'wood') { // the lower half, with the barrel or the gas tube's wood above it
      const top = Math.max(0.2, br, s.gasTube ? 0.75 + 0.475 : 0), bot = -hh * 0.8;
      grasp = [(top + bot) / 2 + 1.2, (top - bot) / 2, 0, hw / 2];
    }
    else if (style === 'forend') grasp = [1.2 - hh * 0.4, hh * 0.55, 0, hw / 2];
    else grasp = [1.2 - hh * 0.3, hh / 2, 0, hw / 2];
  } else grasp = [rh / 2, rh / 2, 0, rw / 2];
  return { muzzle: [muzzle, 0, bore], support, grasp, gripR: gw / 2, mag, magDir, bolt, pump: !!s.pump,
    port: [rx1 - 2, 0, z0 - 0.3] };
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// --- specifications ----------------------------------------------------------------------
// Long guns: receiver [x0, x1], barrel length, handguard [length, height, width?],
// mag { x (front edge), len, depth, curve, drum, ribs }, stock type and size, scope [x, len, r];
// hg handguard style ('round', 'wood', 'block'; wood colors default to 'wood'), cover (dust
// cover), carry [x0, x1] (carry handle), brakeStyle ('bird', 'slant'), frontSight /
// rearSight x.

const GUNS = {
  // Pistols: slide length, colors, extras.
  glock: { pistol: { len: 7.2, slide: DARK, frame: POLY, rake: 22, baseplate: true } },
  hkp2000: { pistol: { len: 7.1, slide: BLACK, frame: POLY } },
  usp_silencer: { pistol: { len: 7.6, slide: BLACK, frame: POLY }, silencer: 7.2 },
  p250: { pistol: { len: 7.0, slide: DARK, frame: POLY } },
  elite: { pistol: { len: 8.4, slide: SILVER, frame: SILVER, h: 1.3 } },
  fiveseven: { pistol: { len: 7.8, slide: DARK, frame: [0.25, 0.27, 0.25] } },
  tec9: { long: { receiver: [-3, 6], height: 2.0, width: 1.2, barrel: 3, barrelR: 0.4, handguard: [3.5, 1.6], mag: { x: 3.3, len: 7, depth: 1.1 }, gripLen: 3.4, sights: true, support: [...PISTOL_SUPPORT], grasp: [...PISTOL_GRASP] } },
  cz75a: { pistol: { len: 7.6, slide: DARK, frame: WOOD_DARK } },
  deagle: { pistol: { len: 10.6, h: 1.55, w: 1.25, slide: [0.42, 0.42, 0.44], frame: BLACK, gripLen: 4.6, deagle: true } },
  revolver: { revolver: true },
  // SMGs.
  mac10: { long: { receiver: [-3.5, 5], height: 2.6, width: 1.5, barrel: 1.5, mag: { x: 0.55, len: 6.5, depth: 1.1, rake: -5 }, stock: 'skeleton', stockLen: 1.4, gripLen: 3.4, rake: 5 } },
  mp9: { long: { receiver: [-3, 6], height: 2.4, width: 1.3, barrel: 2, handguard: [2, 1.8], mag: { x: 0.55, len: 6.5, depth: 1.1, rake: -15 }, stock: 'skeleton', stockLen: 7, rail: true } },
  mp7: { long: { receiver: [-3, 6.5], height: 2.6, width: 1.4, barrel: 3, handguard: [2.5, 1.8], mag: { x: 0.55, len: 6.5, depth: 1.1, rake: -15 }, stock: 'skeleton', stockLen: 1.6, rail: true, foregrip: 4.8 } },
  mp5sd: { long: { receiver: [-4, 6], height: 2.4, width: 1.4, barrel: 0.5, silencer: 9, handguard: [5.5, 2.2], mag: { x: 3.6, len: 6, depth: 1.2, curve: 0.25 }, stock: 'tube', stockLen: 8 } },
  ump45: { long: { receiver: [-4, 7], height: 2.8, width: 1.5, barrel: 3.5, handguard: [3.5, 2.2], mag: { x: 3.9, len: 7, depth: 1.5 }, stock: 'skeleton', stockLen: 8, rail: true } },
  p90: { long: { receiver: [-8, 8], height: 2.7, width: 2.2, z0: 0, barrel: 2.5, mag: null, stock: null, gripLen: 3.5, rake: 0, support: [6, 0, -0.5], grasp: [1.85, 1.35, 0, 1.1], top: true } },
  bizon: { long: { receiver: [-3.5, 6], height: 2.4, width: 1.5, barrel: 9, handguard: [3, 1.8], stock: 'skeleton', stockLen: 9, mag: null, helical: true } },
  // Rifles.
  galilar: { long: { receiver: [-3, 8.5], height: 2.6, cover: true, barrel: 9, brake: 1.5, handguard: [7, 2.4], handguardColor: WOOD, mag: { x: 6.5, len: 7.5, depth: 1.6, curve: 0.18 }, stock: 'skeleton', stockLen: 9, carry: null } },
  famas: { long: { receiver: [-9, 8], height: 3.0, width: 1.6, barrel: 7, brake: 1, metal: DARK, mag: { x: -2.2, len: 5.5, depth: 1.8, curve: 0.06, color: STANAG_LIGHT }, carry: [-6.5, 7.2], carryH: 1.3, sights: false, gripLen: 3.6, support: [5, 0, -1.2], grasp: [1.5, 1.5, 0, 0.8], handGuard: 3.6 } },
  ak47: { long: { receiver: [-2, 9], height: 2.3, cover: true, barrel: 11, brake: 1.2, brakeStyle: 'slant', frontSight: 19.4, rearSight: 8.2, handguard: [7.5, 2.0], handguardColor: WOOD, gasTube: 7.5, gasBlock: true, mag: { x: 6.2, len: 8, depth: 1.8, curve: 0.3, ribs: 5, color: [0.24, 0.2, 0.17] }, stock: 'solid', stockColor: WOOD, stockLen: 10, stockH: 3.6, stockDrop: 1.6, stockTop: 0.35, gripColor: WOOD_DARK } },
  // M4A4: a Mk 18 (short barrel, quad rail, flat top with a flip-up sight); M4A1-S: a Colt
  // 723 (carry handle, round handguard, a lighter 20-round magazine).
  m4a1: { long: { ar: true, receiver: [-2.8, 7.5], height: 2.7, width: 1.3, barrel: 10.3, brake: 2, brakeStyle: 'bird', handguard: [9.2, 2.4], hg: 'quad', mag: { x: 5.4, len: 6.6, depth: 2.1, curve: 0.12, color: STANAG }, stock: 'collapsible', stockLen: 9, stockH: 2.8, rail: true } },
  m4a1_silencer: { long: { ar: true, receiver: [-2.8, 7.5], height: 2.7, width: 1.3, barrel: 11.5, silencer: 7.5, silencerR: 0.62, handguard: [7, 2.5], hg: 'round', mag: { x: 5.4, len: 5.6, depth: 2.1, curve: 0.06, color: STANAG_LIGHT }, stock: 'collapsible', stockLen: 9, stockH: 2.8, carry: [-1.6, 5.4] } },
  sg556: { long: { receiver: [-2.5, 8], height: 2.8, barrel: 10, brake: 1.4, handguard: [6.5, 2.6], mag: { x: 6, len: 6.5, depth: 1.6, curve: 0.2, color: [0.32, 0.3, 0.2] }, stock: 'skeleton', stockLen: 9.5, scope: [3, 7, 0.65] } },
  aug: { long: { receiver: [-10, 8], height: 2.8, width: 1.8, barrel: 8, brake: 1, metal: OLIVE, furniture: OLIVE, mag: { x: -2.5, len: 6, depth: 1.8, curve: 0.15, color: [0.72, 0.6, 0.45] }, scope: [2, 5, 0.6], scopeColor: BLACK, rail: true, foregrip: 6.5, handGuard: 4.6 } },
  ssg08: { long: { receiver: [-2, 9], height: 2.2, width: 1.3, barrel: 16, barrelR: 0.32, metal: DARK, furniture: [0.22, 0.24, 0.26], handguard: [8, 2, 1.4], mag: { x: 4, len: 3.5, depth: 2 }, stock: 'solid', stockLen: 12, stockDrop: 1.5, scope: [3, 11, 0.7], boltHandle: 0.5 } },
  awp: { long: { receiver: [-2, 10], height: 2.3, width: 1.5, barrel: 18, barrelR: 0.45, brake: 2.4, metal: DARK, furniture: OLIVE, handguard: [12, 1.9, 1.8], hg: 'forend', mag: { x: 5, len: 3.4, depth: 2.4 }, stock: 'thumbhole', stockLen: 13, stockDrop: 0.4, scope: [3.5, 13, 0.9], boltHandle: 0, gripLen: 3.8, gripColor: OLIVE } },
  g3sg1: { long: { receiver: [-3, 9], height: 2.8, barrel: 13, brake: 1.5, metal: DARK, furniture: BLACK, handguard: [8, 2.4], mag: { x: 6, len: 6, depth: 1.8, curve: 0.08 }, stock: 'solid', stockLen: 11, stockDrop: 1, scope: [3, 10, 0.75], bipod: 18 } },
  scar20: { long: { receiver: [-3, 9], height: 2.8, barrel: 12, brake: 1.5, metal: [0.24, 0.24, 0.23], furniture: SAND, handguard: [8, 2.6], handguardColor: SAND, mag: { x: 6, len: 5.5, depth: 1.8 }, stock: 'solid', stockColor: SAND, stockLen: 10, stockDrop: 0.8, scope: [3, 10, 0.75], rail: true } },
  // Shotguns.
  nova: { long: { receiver: [-2, 6.5], height: 2.4, barrel: 15, barrelR: 0.45, tubeMag: 12, pump: 6, mag: null, stock: 'solid', stockLen: 11, stockDrop: 2, furniture: POLY, support: [11, 0, -0.4], grasp: [0.96, 1.07, 0, 0.75] } },
  xm1014: { long: { receiver: [-2, 7], height: 2.4, barrel: 14, barrelR: 0.45, tubeMag: 13, handguard: [5, 1.6], mag: null, stock: 'tube', stockLen: 10, rail: true } },
  sawedoff: { long: { receiver: [-2, 4.5], height: 2.4, barrel: 8, barrelR: 0.5, tubeMag: 7, pump: 4.5, mag: null, gripColor: WOOD, furniture: WOOD, stock: null, support: [8, 0, -0.4], grasp: [0.99, 1.1, 0, 0.75] } },
  mag7: { long: { receiver: [-3, 8], height: 3.0, width: 1.8, barrel: 6, barrelR: 0.55, handguard: [5, 2.4], mag: { x: 0.6, len: 5, depth: 1.2, rake: -15 }, stock: 'skeleton', stockLen: 8, gripLen: 3.4, support: [10, 0, -1.4], grasp: [1.2, 1.2, 0, 0.9] } },
  // Machine guns.
  m249: { long: { receiver: [-3, 11], height: 3.4, width: 1.8, barrel: 14, brake: 1, handguard: [7, 2.8], mag: { x: 5.8, len: 5.5, depth: 4, w: 2.2, color: [0.3, 0.32, 0.24] }, stock: 'skeleton', stockLen: 10, carry: [2, 8], bipod: 20 } },
  negev: { long: { receiver: [-3, 11], height: 3.2, width: 1.8, barrel: 14, brake: 1.2, handguard: [8, 2.8], mag: { x: 4, drum: 3.4, t: 2.4, color: [0.3, 0.33, 0.25] }, stock: 'skeleton', stockLen: 10, carry: [1, 6], bipod: 21 } },
};

function buildRevolver(b) {
  b.bone(GUN_ROOT).color(SILVER).box(4.6, 1.1, 1.6, 0.4, 0, 0.8); // frame
  tube(b, -1.2, 1.8, 0.85, 0.85, SILVER, 8); // cylinder (on the slide bone for the reload swing)
  tube(b, 2.7, 9, 0.38, 1.1, SILVER);
  b.color(SILVER).box(6.4, 0.6, 0.45, 5.7, 0, 1.6); // top strap / rib
  pistolSights(b, -1, 8.6, 1.8);
  grip(b, 4.2, 1.15, WOOD, 25, 1.6);
  return { muzzle: [9, 0, 1.1], support: [...PISTOL_SUPPORT], grasp: [...PISTOL_GRASP], gripR: 1.15 / 2,
    cylinder: [0.3, 0, 0.85] };
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
    b.color([0.36, 0.42, 0.22]).lathe([[1.0, -2.6], [1.0, 0.6], [0.45, 1.6], [0.4, 2.6]], SEG); // bottle
    b.color([0.75, 0.68, 0.55]).box(0.7, 0.9, 1.4, 0, 0, 3.1); // rag in the neck
    b.color([0.75, 0.68, 0.55]).box(1.6, 0.4, 0.4, 0.6, 0, 3.6); // its loose end
    return { muzzle: [0, 0, 3.8], support: null, bodyR: 1.0 };
  }
  const g = GRENADES[name], top = g.body[g.body.length - 1][1];
  b.color(g.color).lathe(g.body, SEG);
  if (g.band) b.color(g.band).lathe([[g.body[0][0] + 0.06, -0.5], [g.body[0][0] + 0.06, 0.1]], SEG);
  b.color(STEEL).box(0.9, 0.7, 0.7, 0, 0, top + 0.3); // fuse head
  b.box(0.35, 0.5, 2.4, -0.55, 0, top - 0.6).box(0.7, 0.5, 0.3, -0.25, 0, top + 0.6); // spoon
  b.box(0.15, 0.9, 0.9, 0.55, 0, top + 0.5); // pin ring
  return { muzzle: [0, 0, top + 0.8], support: null, bodyR: Math.max(...g.body.map((p) => p[0])) };
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
  const b = new MeshBuilder().defaultFinish(FINISH.POLYMER).bevel(BEVEL);
  b.color([0.75, 0.62, 0.15]).box(5, 1.6, 3, 0, 0, 1.5);
  b.color(BLACK).box(4, 1.7, 0.6, 0, 0, 3.3).box(1, 0.4, 1.4, -1.2, 0, 3.9).box(1, 0.4, 1.4, 1.2, 0, 3.9);
  return b.build();
}

// Builds the model of weapon `name` (shared/weapons.js names; opts.noSilencer: the
// M4A1-S / USP-S with their silencer off): { mesh, muzzle, support, grasp, bodyR,
// mag, magDir, bolt, pump, port, cylinder }, points in the gun frame: the muzzle; the off
// hand's place (null: one-handed) and what it holds there (grasp: [how far the held part's
// axis is in from the point, its half-height, 1 if upright, its half-width]); the pistol grip's half-width;
// a grenade's body radius; where a hand takes the magazine and the way it comes
// out (null: no magazine); the bolt handle, slide rear or pump (pump: the bolt bone is a
// pump); a shotgun's loading port; the revolver's cylinder.
export function buildGun(name, opts = {}) {
  const b = new MeshBuilder().bone(GUN_ROOT).defaultFinish(FINISH.POLYMER).bevel(BEVEL);
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
      tube(b, pts.muzzle[0] - 0.05, pts.muzzle[0] + 0.35, 0.3, pts.muzzle[2], DARK); // the threaded barrel end
      silencer(b, pts.muzzle[0] + 0.3, g.silencer, 0.68, pts.muzzle[2]);
      pts.muzzle[0] += g.silencer + 0.3;
    }
  } else {
    pts = longGun(b, opts.noSilencer && g.long.silencer ? { ...g.long, silencer: 0, brake: 1 } : g.long);
    if (g.long.top) { // P90: the magazine lies on top
      b.bone(GUN_MAG).color([0.35, 0.33, 0.28]).box(12, 1.8, 0.9, 0, 0, 2.4).bone(GUN_ROOT);
      b.color(BLACK).box(5, 1, 1, 7, 0, 3.2); // optic
      // The lower half round the grip: the butt under the back, a bar along the bottom and a
      // post in front, leaving the thumbhole behind the grip and the trigger loop ahead of it.
      withBevel(b, 0.35, () => {
        b.color(POLY).extrude([[-8.4, -3.3], [-7.6, -4.1], [-3.2, -4.1], [-3.2, 0.3], [-8.4, 0.3]], 2.1);
        b.extrude([[-3.5, -4.1], [4.8, -4.1], [4.8, -3.4], [-3.5, -3.4]], 1.6);
        b.extrude([[3.9, -3.6], [5.1, -3.6], [5.5, 0.2], [3.6, 0.2]], 1.8);
      });
      pts.mag = [-3, 0, 2.9];
      pts.magDir = norm([-0.4, 0, 1]);
    }
    if (g.long.helical) { // PP-Bizon: the helical magazine under the barrel
      b.bone(GUN_MAG).color(DARK).push().translate(5, 0, -1.4).rotate(90).lathe([[1.15, 0], [1.15, 8], [0.9, 8.6]], SEG).pop()
        .bone(GUN_ROOT);
      pts.mag = [8, 0, -2.5];
      pts.magDir = norm([0.3, 0, -1]);
    }
  }
  return {
    mesh: b.build(), muzzle: pts.muzzle, support: pts.support, grasp: pts.grasp || null, gripR: pts.gripR || 0,
    bodyR: pts.bodyR || 0,
    mag: pts.mag || null, magDir: pts.magDir || null,
    bolt: pts.bolt || null, pump: !!pts.pump, port: pts.port || null, cylinder: pts.cylinder || null,
  };
}

// Every weapon id's model (index = weapon id; 0 empty).
export function buildAllGuns() {
  return WEAPONS.map((w) => (w ? buildGun(w.name) : null));
}

