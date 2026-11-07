// The kill feed's icons, CS:GO's way but with no image files: each weapon's silhouette drawn
// from its own model (client/models/guns.js) seen side-on, the muzzle toward the victim, and
// the marks (headshot, wallbang, flash assist, in the air, no scope, a death of one's own) as
// small SVGs written here. A weapon's icon is drawn once, in idle time after the page loads
// (or at its first kill if that comes sooner), and kept as a data URL.

// Icon size rules (CSS pixels): a gun's inches times SCALE, small ones grown to MIN_H tall but
// no wider than SMALL_W (the knife stays a thin blade), none over MAX_H tall or MAX_W wide (the AWP).
const SCALE = 2.6, MIN_H = 20, SMALL_W = 48, MAX_H = 28, MAX_W = 110;
const RES = 2; // canvas pixels a CSS pixel (crisp on high-DPI screens)

// A model's triangle corners (MeshBuilder.build positions: x along the barrel, z up) seen
// from the side, in icon pixels from the top left: every triangle wound one way (so a
// nonzero fill is their union, none cancelling another), degenerate ones left out.
// Returns { tris: Float32Array of x, y corners, w, h }.
export function iconTriangles(positions, scale = 1) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], z = positions[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const lw = x1 - x0, lh = z1 - z0;
  const s = scale * Math.min(MAX_H / lh, MAX_W / lw, Math.max(SCALE, Math.min(MIN_H / lh, SMALL_W / lw)));
  const out = new Float32Array(positions.length / 9 * 6);
  let n = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = (positions[i] - x0) * s, ay = (z1 - positions[i + 2]) * s;
    const bx = (positions[i + 3] - x0) * s, by = (z1 - positions[i + 5]) * s;
    const cx = (positions[i + 6] - x0) * s, cy = (z1 - positions[i + 8]) * s;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-4) continue;
    const flip = area < 0;
    out[n++] = ax;
    out[n++] = ay;
    out[n++] = flip ? cx : bx;
    out[n++] = flip ? cy : by;
    out[n++] = flip ? bx : cx;
    out[n++] = flip ? by : cy;
  }
  return { tris: out.subarray(0, n), w: Math.ceil(lw * s), h: Math.ceil(lh * s) };
}

// The marks, 24 x 24, in the text's color (headshot's burst in yellow).
const MARKS = {
  headshot: '<circle cx="11" cy="11" r="7"/><rect x="8" y="16" width="6" height="5" rx="1"/>' +
    '<polygon fill="#ffd23a" points="18,2 19.5,6 23,5 20.5,8.5 23,12 19,11 17,14 16.5,10 13,8 17,6.5"/>',
  wallbang: '<rect x="9" y="3" width="6" height="18" rx="1" fill-opacity="0.55"/>' +
    '<rect x="1" y="11" width="21" height="2.4" rx="1"/><polygon points="19,7.5 24,12.2 19,16.9"/>',
  flash: '<polygon points="12,1 14,8.5 21,5 16.5,11 23,13 16,15 19,22 12,17 6,23 8,15.5 1,13 7.5,10.5 3,4 10,8"/>',
  air: '<rect x="2" y="20" width="20" height="2.2" rx="1"/><rect x="10.8" y="7" width="2.4" height="9" rx="1"/>' +
    '<polygon points="6,9 12,2 18,9"/>',
  noscope: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
    '<rect x="11" y="6" width="2" height="12"/><rect x="6" y="11" width="12" height="2"/>' +
    '<rect x="-1.5" y="10.8" width="27" height="2.4" rx="1" fill="#e2402a" transform="rotate(-45 12 12)"/>',
  skull: '<path fill-rule="evenodd" d="M12 2a8 8 0 0 0-8 8c0 2.6 1.2 4.3 3 5.4V19h10v-3.6c1.8-1.1 3-2.8 3-5.4a8 8 0 0 0-8-8z' +
    'M8.5 8.5a2 2 0 1 0 0.01 0zM15.5 8.5a2 2 0 1 0 0.01 0z"/><rect x="8" y="19.5" width="8" height="2.5" rx="1"/>',
};
export const MARK_NAMES = Object.keys(MARKS);

export class KillIcons {
  // build(name): the triangle corners of weapon `name`'s model (buildGun(name).mesh.positions);
  // weapons: shared/weapons.js WEAPONS.
  constructor(build, weapons) {
    this.build = build;
    this.weapons = weapons;
    this.urls = new Array(weapons.length).fill(null);
    this.heights = new Float32Array(weapons.length); // CSS pixels
    this.widths = new Float32Array(weapons.length);
    this.marks = new Map(); // name -> a parsed SVG, cloned for each use
    this.next = 1; // idle drawing walks the weapons from here
  }

  // Draws the icons not drawn yet, one per idle slice with room for it (a model and its
  // icon take ~5-15 ms), so the first kills cost nothing.
  prepare() {
    const step = (deadline) => {
      if (deadline && deadline.timeRemaining() < 15) return (globalThis.requestIdleCallback || setTimeout)(step);
      while (this.next < this.weapons.length && (!this.weapons[this.next] || this.urls[this.next])) this.next++;
      if (this.next >= this.weapons.length) return;
      this.url(this.next);
      (globalThis.requestIdleCallback || setTimeout)(step);
    };
    (globalThis.requestIdleCallback || setTimeout)(step);
  }

  url(id) {
    if (this.urls[id]) return this.urls[id];
    const { tris, w, h } = iconTriangles(this.build(this.weapons[id].name), RES);
    const cv = document.createElement('canvas');
    cv.width = w + 2 * RES;
    cv.height = h + 2 * RES;
    const c = cv.getContext('2d');
    c.translate(RES, RES);
    c.beginPath();
    for (let i = 0; i < tris.length; i += 6) {
      c.moveTo(tris[i], tris[i + 1]);
      c.lineTo(tris[i + 2], tris[i + 3]);
      c.lineTo(tris[i + 4], tris[i + 5]);
      c.closePath();
    }
    c.fillStyle = '#f6eedb';
    c.lineJoin = 'round';
    c.strokeStyle = '#f6eedb';
    c.lineWidth = 0.6 * RES; // (closes the hairline gaps between triangles)
    c.stroke();
    c.fill();
    this.heights[id] = cv.height / RES;
    this.widths[id] = cv.width / RES;
    return (this.urls[id] = cv.toDataURL());
  }

  // An <img> of weapon id's silhouette (a skull for no weapon: the world).
  weapon(id) {
    const w = this.weapons[id];
    if (!w) return this.mark('skull');
    const img = document.createElement('img');
    img.className = 'wi';
    img.src = this.url(id);
    img.height = this.heights[id];
    img.alt = img.title = w.label;
    return img;
  }

  // A mark's <svg> (MARK_NAMES).
  mark(name) {
    let svg = this.marks.get(name);
    if (!svg) {
      const tpl = document.createElement('template');
      tpl.innerHTML = `<svg class="km ${name}" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="${name}">${MARKS[name]}</svg>`;
      svg = tpl.content.firstChild;
      this.marks.set(name, svg);
    }
    return svg.cloneNode(true);
  }
}
