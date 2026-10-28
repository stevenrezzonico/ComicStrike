// Procedural mesh builder for player and weapon models (zero assets): boxes, rounded
// boxes, rounded slabs, spheres, lathes, extrusions (optionally bevelled), lofts and
// capsules, and swept tubes under a transform stack, one color and finish per vertex,
// skinned to one bone or blended between two (skin(): limbs that bend smoothly).
// Normals are smooth within each primitive across edges flatter than its crease angle
// (smooth(): round shapes shade round and get no crease ink, box corners stay sharp).
// Every primitive is closed, wound counter-clockwise seen from outside. Runs once at
// load; the result is one interleaved buffer for client/gl/skinned.js.
//
// Vertex (24 bytes): pos f32x3 | normal i8x3 norm, bone u8 | color u8x4 norm (rgb, finish) |
// second bone u8, its weight u8 (0..255; the first bone is the heavier), 2 spare bytes.

export const MESH_STRIDE = 24;

// Surface finishes (the vertex color's alpha byte): how SKINNED_FS prints a part.
export const FINISH = { CLOTH: 0, SKIN: 1, METAL: 2, POLYMER: 3, WOOD: 4, PATTERN: 5 };

// A color that carries its finish: color(finish([r, g, b], FINISH.METAL)).
export function finish(rgb, fin) {
  const c = rgb.slice();
  c.finish = fin;
  return c;
}

const DEFAULT_CREASE = 50; // degrees: flatter edges are smoothed

// Affine transform as a 3x4 row-major array [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz].
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function compose(a, b) { // a * b
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
    }
  }
  return o;
}

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = []; // face normals, per vertex (smoothed in build)
    this.col = [];
    this.fins = [];
    this.bones = [];
    this.bones2 = []; // per vertex: the second bone and its weight (0..0.5)
    this.weights = [];
    this.skinFn = null;
    this.groups = []; // per triangle: the primitive it belongs to
    this.creases = []; // per triangle: cos of its crease angle
    this.hards = []; // per triangle: 1 = a flat face that keeps its normal (bevels bend to it)
    this.hard = false;
    this.m = IDENTITY.slice();
    this.stack = [];
    this.rgb = [0.5, 0.5, 0.5];
    this.fin = FINISH.CLOTH;
    this.baseFin = FINISH.CLOTH; // for colors without their own finish
    this.boneIndex = 0;
    this.boneMap = null;
    this.crease = Math.cos(DEFAULT_CREASE * Math.PI / 180);
    this.bev = 0;
    this.group = 0;
    this.depth = 0; // primitive nesting: one group per outermost primitive
  }

  get tris() {
    return this.pos.length / 9;
  }

  // --- state -------------------------------------------------------------------------

  // Color for the next vertices; a color made by finish() also sets the finish (else the
  // default finish).
  color(r, g, b) {
    this.rgb = Array.isArray(r) ? r : [r, g, b];
    this.fin = Array.isArray(r) && r.finish !== undefined ? r.finish : this.baseFin;
    return this;
  }

  // Finish of the colors that carry none (cloth unless set).
  defaultFinish(fin) {
    this.baseFin = fin;
    return this;
  }

  // Crease angle (degrees) of the next primitives: edges flatter than it are smoothed
  // (0: flat facets).
  smooth(deg = DEFAULT_CREASE) {
    this.crease = deg > 0 ? Math.cos(deg * Math.PI / 180) : 2;
    return this;
  }

  // Edge rounding radius of the next boxes and extrusions (0: sharp).
  bevel(r = 0) {
    this.bev = r;
    return this;
  }

  // Bone for the next vertices (remapped while building a mirrored half).
  bone(i) {
    this.boneIndex = this.boneMap ? this.boneMap[i] : i;
    return this;
  }

  // Skinning by position for the next vertices: fn([x, y, z]) (builder space, after the
  // transform) -> [bone a, bone b, weight of b] (bone indices remapped while mirroring);
  // null: the bone() bone alone.
  skin(fn = null) {
    this.skinFn = fn;
    return this;
  }

  push() {
    this.stack.push(this.m);
    return this;
  }

  pop() {
    this.m = this.stack.pop();
    return this;
  }

  transform(t) {
    this.m = compose(this.m, t);
    return this;
  }

  translate(x, y, z) {
    return this.transform([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
  }

  scale(x, y = x, z = x) {
    return this.transform([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]);
  }

  // GoldSrc angles in degrees: yaw about Z, then pitch about Y (down-positive), then roll
  // about X.
  rotate(pitch, yaw = 0, roll = 0) {
    const d = Math.PI / 180;
    const cp = Math.cos(pitch * d), sp = Math.sin(pitch * d), cy = Math.cos(yaw * d), sy = Math.sin(yaw * d);
    const cr = Math.cos(roll * d), sr = Math.sin(roll * d);
    const z = [cy, -sy, 0, 0, sy, cy, 0, 0, 0, 0, 1, 0];
    const y = [cp, 0, sp, 0, 0, 1, 0, 0, -sp, 0, cp, 0];
    const x = [1, 0, 0, 0, 0, cr, -sr, 0, 0, sr, cr, 0];
    return this.transform(compose(compose(z, y), x));
  }

  // Runs build() twice: as is, then mirrored across the plane through the origin
  // normal to `axis` (0 x, 1 y, 2 z) — left and right limbs, gun halves. boneMap
  // (bone -> its mirror twin, Skeleton.mirror) swaps the bones of the second half.
  mirror(build, axis = 1, boneMap = null) {
    build(this);
    this.push();
    this.scale(axis === 0 ? -1 : 1, axis === 1 ? -1 : 1, axis === 2 ? -1 : 1);
    this.boneMap = boneMap;
    build(this);
    this.boneMap = null;
    this.pop();
    return this;
  }

  // Brackets a primitive: its triangles smooth together, not with other primitives'.
  open() {
    if (this.depth++ === 0) this.group++;
    return this;
  }

  close() {
    this.depth--;
    return this;
  }

  // --- triangles -----------------------------------------------------------------------

  // Triangle a, b, c (local points [x, y, z]), counter-clockwise from the front. Mirroring
  // transforms keep the winding outward. A loose triangle (outside a primitive) stands
  // alone: flat.
  tri(a, b, c) {
    const m = this.m;
    const p = [a, b, c].map(([x, y, z]) => [
      m[0] * x + m[1] * y + m[2] * z + m[3],
      m[4] * x + m[5] * y + m[6] * z + m[7],
      m[8] * x + m[9] * y + m[10] * z + m[11],
    ]);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) +
      m[2] * (m[4] * m[9] - m[5] * m[8]);
    if (det < 0) [p[1], p[2]] = [p[2], p[1]];
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return this; // degenerate: nothing to see
    for (const q of p) {
      this.pos.push(q[0], q[1], q[2]);
      this.nrm.push(nx / l, ny / l, nz / l);
      this.col.push(...this.rgb);
      this.fins.push(this.fin);
      if (this.skinFn) {
        let [a, b, w] = this.skinFn(q);
        if (this.boneMap) [a, b] = [this.boneMap[a], this.boneMap[b]];
        if (w > 0.5) [a, b, w] = [b, a, 1 - w];
        this.bones.push(a);
        this.bones2.push(b);
        this.weights.push(Math.max(0, w));
      } else {
        this.bones.push(this.boneIndex);
        this.bones2.push(this.boneIndex);
        this.weights.push(0);
      }
    }
    this.groups.push(this.depth ? this.group : ++this.group);
    this.creases.push(this.crease);
    this.hards.push(this.hard ? 1 : 0);
    return this;
  }

  quad(a, b, c, d) {
    return this.tri(a, b, c).tri(a, c, d);
  }

  // Simple polygon (points in order, either winding) as a fan of ears, facing `normal`
  // ([x, y, z]); pts are 3D and coplanar.
  polygon(pts, normal) {
    const idx = triangulate(pts, normal);
    this.open();
    for (let i = 0; i < idx.length; i += 3) this.tri(pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]);
    return this.close();
  }

  // --- primitives ----------------------------------------------------------------------

  // Box of size (sx, sy, sz) centered on (cx, cy, cz); rounded by bevel().
  box(sx, sy, sz, cx = 0, cy = 0, cz = 0) {
    if (this.bev > 0) return this.rbox(sx, sy, sz, this.bev, cx, cy, cz, 1);
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.open();
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
    this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]); // -x
    this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]); // +y
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -y
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]); // -z
    return this.close();
  }

  // Box with every edge and corner rounded by radius r, centered on (cx, cy, cz): a grid
  // on the box's faces (seg steps across each half of a rounded edge; 1 is a chamfer that
  // smooth normals print round) pushed onto the rounded surface.
  rbox(sx, sy, sz, r, cx = 0, cy = 0, cz = 0, seg = 2) {
    const h = [sx / 2, sy / 2, sz / 2], c = [cx, cy, cz];
    r = Math.min(r, h[0] * 0.95, h[1] * 0.95, h[2] * 0.95);
    if (!(r > 0)) {
      const bev = this.bev;
      return this.bevel(0).box(sx, sy, sz, cx, cy, cz).bevel(bev);
    }
    const core = h.map((v) => v - r);
    const grid = h.map((v) => {
      const out = [];
      for (let k = 0; k <= seg; k++) out.push(-v + r * k / seg);
      for (let k = seg; k >= 0; k--) out.push(v - r * k / seg);
      return out;
    });
    const place = (p) => {
      const q = [0, 0, 0], d = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        q[a] = Math.max(-core[a], Math.min(core[a], p[a]));
        d[a] = p[a] - q[a];
      }
      const l = Math.hypot(d[0], d[1], d[2]);
      return [0, 1, 2].map((a) => (l > 1e-9 ? q[a] + d[a] / l * r : p[a]) + c[a]);
    };
    this.open();
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3;
      for (const s of [-1, 1]) {
        const at = (gi, gj) => {
          const p = [0, 0, 0];
          p[a] = s * h[a];
          p[u] = grid[u][gi];
          p[v] = grid[v][gj];
          return place(p);
        };
        for (let i = 0; i + 1 < grid[u].length; i++) {
          for (let j = 0; j + 1 < grid[v].length; j++) {
            // (u, v, a) is right-handed: counter-clockwise from +a; flipped on the -a side.
            // The flat middle of each face is hard: the rounding bends between them.
            this.hard = i === seg && j === seg;
            if (s > 0) this.quad(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
            else this.quad(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
          }
        }
      }
    }
    this.hard = false;
    return this.close();
  }

  // Sphere of radius r about the origin, `seg` sides and `rings` bands (scale it for an
  // ellipsoid).
  sphere(r, seg = 12, rings = 6) {
    const profile = [];
    for (let k = 0; k <= rings; k++) {
      const a = Math.PI * k / rings;
      profile.push([k === 0 || k === rings ? 0 : r * Math.sin(a), -r * Math.cos(a)]);
    }
    return this.lathe(profile, seg);
  }

  // Outline [[x, z], ...] (a side view: x forward, z up) extruded `depth` along y,
  // centered on y = 0: receivers, magazines, blades, stocks. With bevel() the edges
  // around both side faces are cut at 45 degrees (the outline inset on the faces).
  extrude(outline, depth) {
    const h = depth / 2;
    const n = outline.length;
    const ccw = area2(outline) > 0; // counter-clockwise in (x, z) = facing -y
    const bv = Math.min(this.bev, h * 0.45);
    const ring = (pts, y) => pts.map(([x, z]) => [x, y, z]);
    const rings = bv > 0 ?
      [ring(inset(outline, bv, ccw), -h), ring(outline, -h + bv), ring(outline, h - bv), ring(inset(outline, bv, ccw), h)] :
      [ring(outline, -h), ring(outline, h)];
    this.open();
    // Bevelled: the side faces and the outline's sides are hard, the bevels bend between.
    this.hard = bv > 0;
    this.polygon(rings[0], [0, -1, 0]);
    this.polygon(rings.at(-1), [0, 1, 0]);
    for (let r = 0; r + 1 < rings.length; r++) {
      const front = rings[r], back = rings[r + 1];
      this.hard = bv > 0 && r === 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (ccw) this.quad(front[i], back[i], back[j], front[j]);
        else this.quad(front[j], back[j], back[i], front[i]);
      }
    }
    this.hard = false;
    return this.close();
  }

  // Box with its four vertical edges rounded (radius r, seg steps per corner), centered:
  // padded torsos, pouches, grips.
  slab(sx, sy, sz, r, seg = 3) {
    r = Math.min(r, sx / 2, sy / 2);
    const pts = [];
    const corners = [[sx / 2 - r, sy / 2 - r, 0], [-sx / 2 + r, sy / 2 - r, 90], [-sx / 2 + r, -sy / 2 + r, 180],
      [sx / 2 - r, -sy / 2 + r, 270]];
    for (const [cx, cy, a0] of corners) {
      for (let k = 0; k <= seg; k++) {
        const a = (a0 + 90 * k / seg) * Math.PI / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    return this.loft([{ z: -sz / 2, pts }, { z: sz / 2, pts }]);
  }

  // Surface of revolution about z: profile [[radius, z], ...] from bottom to top, `seg`
  // sides. Ends with radius 0 close to a point, others get a flat cap. (Rotate the
  // builder for other axes: barrels along x are rotate(90).)
  lathe(profile, seg = 12) {
    const ring = (r, z) => {
      const out = [];
      for (let k = 0; k < seg; k++) {
        const a = 2 * Math.PI * k / seg;
        out.push([r * Math.cos(a), r * Math.sin(a), z]);
      }
      return out;
    };
    const rings = profile.map(([r, z]) => (r > 0 ? ring(r, z) : null));
    this.open();
    for (let i = 0; i + 1 < profile.length; i++) {
      const a = rings[i], b = rings[i + 1];
      for (let k = 0; k < seg; k++) {
        const j = (k + 1) % seg;
        if (a && b) this.quad(a[k], a[j], b[j], b[k]);
        else if (a) this.tri(a[k], a[j], [0, 0, profile[i + 1][1]]);
        else if (b) this.tri([0, 0, profile[i][1]], b[j], b[k]);
      }
    }
    if (rings[0]) this.polygon(rings[0].slice().reverse(), [0, 0, -1]);
    const last = rings.at(-1);
    if (last) this.polygon(last, [0, 0, 1]);
    return this.close();
  }

  // Capsule along z from z = 0 to z = len (the caps included), radius r: limbs.
  capsule(r, len, seg = 12, capSteps = 3) {
    const profile = [[0, 0]];
    for (let k = 1; k <= capSteps; k++) {
      const a = (Math.PI / 2) * (1 - k / capSteps);
      profile.push([r * Math.cos(a), r - r * Math.sin(a)]);
    }
    for (let k = capSteps; k >= 1; k--) {
      const a = (Math.PI / 2) * (1 - k / capSteps);
      profile.push([r * Math.cos(a), len - r + r * Math.sin(a)]);
    }
    profile.push([0, len]);
    return this.lathe(profile, seg);
  }

  // Tube along a path of sections [{ at: [x, y, z], a, b, n }]: each an oval (a
  // superellipse of exponent n, 2 by default; 4 is a rounded box) square to the path, half-
  // size b toward `up` and a across, `seg` sides; `ends` 'round' closes both ends with a
  // dome, else flat caps. Torsos, limbs.
  sweep(sections, seg = 12, up = [0, 0, 1], ends = 'round') {
    const last = sections.length - 1;
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const unit = (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const ringAt = (s, i, shift = 0, shrink = 1) => {
      const t = unit(sub(sections[Math.min(last, i + 1)].at, sections[Math.max(0, i - 1)].at));
      const d = up[0] * t[0] + up[1] * t[1] + up[2] * t[2];
      const e2 = unit([up[0] - t[0] * d, up[1] - t[1] * d, up[2] - t[2] * d]);
      const e1 = [e2[1] * t[2] - e2[2] * t[1], e2[2] * t[0] - e2[0] * t[2], e2[0] * t[1] - e2[1] * t[0]]; // e1 x e2 = t
      const e = 2 / (s.n || 2), out = [];
      for (let k = 0; k < seg; k++) {
        const th = 2 * Math.PI * k / seg, c = Math.cos(th), sn = Math.sin(th);
        const x = Math.sign(c) * Math.abs(c) ** e * s.a * shrink, y = Math.sign(sn) * Math.abs(sn) ** e * s.b * shrink;
        out.push([0, 1, 2].map((j) => s.at[j] + t[j] * shift + e1[j] * x + e2[j] * y));
      }
      return { pts: out, t };
    };
    const rings = sections.map((s, i) => ringAt(s, i));
    if (ends === 'round') { // two shrinking rings past each end
      const dome = (i, sign) => [1, 2].map((k) => {
        const s = sections[i], ph = k / 3 * Math.PI / 2, depth = Math.min(s.a, s.b) * 0.9;
        return ringAt(s, i, sign * depth * Math.sin(ph), Math.cos(ph));
      });
      rings.unshift(...dome(0, -1).reverse());
      rings.push(...dome(last, 1));
    }
    this.open();
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i].pts, b = rings[i + 1].pts;
      for (let k = 0; k < seg; k++) {
        const j = (k + 1) % seg;
        this.quad(a[k], a[j], b[j], b[k]);
      }
    }
    const t0 = rings[0].t, t1 = rings.at(-1).t;
    this.polygon(rings[0].pts.slice().reverse(), [-t0[0], -t0[1], -t0[2]]);
    this.polygon(rings.at(-1).pts, t1);
    return this.close();
  }

  // Skin between sections across z: rings [{ z, pts: [[x, y], ...] }], all with the same
  // number of points in the same (counter-clockwise from +z) order. Ends are capped.
  loft(rings) {
    const n = rings[0].pts.length;
    const P = rings.map(({ z, pts }) => {
      if (pts.length !== n) throw new Error('loft rings need equal point counts');
      const r = pts.map(([x, y]) => [x, y, z]);
      return area2(pts) > 0 ? r : r.reverse();
    });
    this.open();
    for (let i = 0; i + 1 < P.length; i++) {
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        this.quad(P[i][k], P[i][j], P[i + 1][j], P[i + 1][k]);
      }
    }
    this.polygon(P[0].slice().reverse(), [0, 0, -1]);
    this.polygon(P.at(-1), [0, 0, 1]);
    return this.close();
  }

  // --- output --------------------------------------------------------------------------

  build() {
    const count = this.pos.length / 3;
    const nrm = smoothNormals(this.pos, this.nrm, this.groups, this.creases, this.hards);
    const data = new ArrayBuffer(count * MESH_STRIDE);
    const f = new Float32Array(data), i8 = new Int8Array(data), u8 = new Uint8Array(data);
    for (let v = 0; v < count; v++) {
      const o = v * MESH_STRIDE;
      f[o / 4] = this.pos[v * 3];
      f[o / 4 + 1] = this.pos[v * 3 + 1];
      f[o / 4 + 2] = this.pos[v * 3 + 2];
      for (let c = 0; c < 3; c++) i8[o + 12 + c] = Math.round(nrm[v * 3 + c] * 127);
      u8[o + 15] = this.bones[v];
      for (let c = 0; c < 3; c++) u8[o + 16 + c] = Math.max(0, Math.min(255, Math.round(this.col[v * 3 + c] * 255)));
      u8[o + 19] = this.fins[v];
      u8[o + 20] = this.bones2[v];
      u8[o + 21] = Math.round(this.weights[v] * 255);
    }
    return { data, count, tris: count / 3, positions: new Float32Array(this.pos), normals: nrm };
  }
}

// A built triangle list (data, count) as shared vertices and indices: corners that are the
// same bytes (position, normal, bones, color: a smooth surface's) become one vertex, so the
// vertex shader runs once for them (a player: ~14,400 corners, ~4,000 vertices). Hard
// edges keep their separate vertices. Also the number of bones the vertices use.
export function indexMesh(data, count) {
  const words = MESH_STRIDE / 4;
  const src = new Uint32Array(data, 0, count * words), u8 = new Uint8Array(data);
  const out = new Uint32Array(count * words);
  const indices = count <= 65536 ? new Uint16Array(count) : new Uint32Array(count);
  const mask = (1 << Math.ceil(Math.log2(count * 2 + 2))) - 1;
  const table = new Int32Array(mask + 1).fill(-1); // open addressing: slot -> vertex
  let n = 0, bones = 1;
  for (let v = 0; v < count; v++) {
    const o = v * words;
    let h = 0x811c9dc5;
    for (let k = 0; k < words; k++) h = Math.imul(h ^ src[o + k], 0x01000193);
    for (let s = (h >>> 0) & mask; ; s = (s + 1) & mask) {
      const u = table[s];
      if (u < 0) {
        table[s] = n;
        for (let k = 0; k < words; k++) out[n * words + k] = src[o + k];
        bones = Math.max(bones, u8[v * MESH_STRIDE + 15] + 1, u8[v * MESH_STRIDE + 20] + 1);
        indices[v] = n++;
        break;
      }
      let k = 0;
      while (k < words && out[u * words + k] === src[o + k]) k++;
      if (k === words) {
        indices[v] = u;
        break;
      }
    }
  }
  return { vertices: new Uint8Array(out.buffer, 0, n * MESH_STRIDE), indices, vertexCount: n, bones };
}

// Smooth vertex normals: each corner of a triangle averages the face normals of the
// triangles of its primitive meeting at that point whose normal is within the triangle's
// crease angle of its own, weighted by their corner angle there times their area (so how
// a quad is split into triangles does not tilt the result). Hard triangles (the flat
// faces of bevelled boxes and outlines) average only hard ones; a soft corner touching a
// hard face takes the hard faces' normal, so a bevel bends from one flat face's normal to
// the next and the faces themselves stay flat.
function smoothNormals(pos, faceNrm, groups, creases, hards) {
  const tris = groups.length;
  const weight = new Float64Array(tris * 3);
  for (let v = 0; v < tris * 3; v++) {
    const t = (v / 3) | 0, a = v * 3, b = (t * 3 + (v + 1) % 3) * 3, c = (t * 3 + (v + 2) % 3) * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const cross = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    const cos = (ux * wx + uy * wy + uz * wz) / ((Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz)) || 1);
    weight[v] = Math.acos(Math.max(-1, Math.min(1, cos))) * cross;
  }
  const key = (v) => `${groups[(v / 3) | 0]}:${Math.round(pos[v * 3] * 1e3)},${Math.round(pos[v * 3 + 1] * 1e3)},` +
    `${Math.round(pos[v * 3 + 2] * 1e3)}`;
  const at = new Map(); // key -> the triangle corners there
  for (let v = 0; v < tris * 3; v++) {
    const k = key(v);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(v);
  }
  const out = new Float32Array(faceNrm.length);
  for (let v = 0; v < tris * 3; v++) {
    const t = (v / 3) | 0, f = t * 9;
    const near = at.get(key(v)).filter((w) => {
      const u = (w / 3) | 0, g = u * 9;
      return u === t || faceNrm[f] * faceNrm[g] + faceNrm[f + 1] * faceNrm[g + 1] + faceNrm[f + 2] * faceNrm[g + 2] >= creases[t];
    });
    const hardOnly = hards[t] === 1 || near.some((w) => hards[(w / 3) | 0] === 1);
    let x = 0, y = 0, z = 0;
    for (const w of near) {
      const g = ((w / 3) | 0) * 9;
      if (hardOnly && hards[(w / 3) | 0] !== 1) continue;
      x += faceNrm[g] * weight[w];
      y += faceNrm[g + 1] * weight[w];
      z += faceNrm[g + 2] * weight[w];
    }
    const l = Math.hypot(x, y, z) || 1;
    out[v * 3] = x / l;
    out[v * 3 + 1] = y / l;
    out[v * 3 + 2] = z / l;
  }
  return out;
}

// Outline [[x, z], ...] moved `d` inward (mitred corners, spikes capped): bevelled faces.
function inset(pts, d, ccw) {
  const n = pts.length, s = ccw ? 1 : -1;
  return pts.map(([x, z], i) => {
    const [px, pz] = pts[(i + n - 1) % n], [qx, qz] = pts[(i + 1) % n];
    let ax = x - px, az = z - pz, bx = qx - x, bz = qz - z;
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la;
    az /= la;
    bx /= lb;
    bz /= lb;
    // Left normals of both edges (inward on a counter-clockwise outline), mitred.
    const nx = -az - bz, nz = ax + bx;
    const k = Math.min(d / Math.max(1 + ax * bx + az * bz, 1e-3), d * 2.5);
    return [x + s * nx * k, z + s * nz * k];
  });
}

// Twice the signed area of a 2D polygon (> 0: counter-clockwise).
function area2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}

// Ear clipping of a simple 3D polygon facing `normal`: triangle indices wound
// counter-clockwise seen from the normal's side.
function triangulate(pts, [nx, ny, nz]) {
  // Project onto the plane's two other axes, oriented so the normal points at the viewer.
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  let u, v, s;
  if (az >= ax && az >= ay) [u, v, s] = [0, 1, Math.sign(nz)];
  else if (ay >= ax) [u, v, s] = [2, 0, Math.sign(ny)];
  else [u, v, s] = [1, 2, Math.sign(nx)];
  const p2 = pts.map((p) => [p[u], p[v] * s]);
  let idx = pts.map((_p, i) => i);
  if (area2(p2) < 0) idx.reverse();
  const out = [];
  const cross = (a, b, c) => (p2[b][0] - p2[a][0]) * (p2[c][1] - p2[a][1]) - (p2[b][1] - p2[a][1]) * (p2[c][0] - p2[a][0]);
  const inside = (a, b, c, p) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = idx.length * idx.length;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or flat
      let ear = true;
      for (const q of idx) {
        if (q === a || q === b || q === c) continue;
        if (inside(a, b, c, q) && !(p2[q][0] === p2[a][0] && p2[q][1] === p2[a][1]) &&
          !(p2[q][0] === p2[c][0] && p2[q][1] === p2[c][1])) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(a, b, c);
      idx = idx.filter((x) => x !== b);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate outline: stop rather than loop
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}
