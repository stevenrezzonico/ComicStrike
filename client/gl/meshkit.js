// Procedural low-poly mesh builder for player and weapon models (zero assets): boxes,
// rounded slabs, lathes, extrusions, lofts and capsules under a transform stack, with
// flat normals (one per triangle: the flat cartoon look), one color and one skeleton
// bone per vertex. Every primitive is closed, wound counter-clockwise seen from outside.
// Runs once at load; the result is one interleaved buffer for client/gl/skinned.js.
//
// Vertex (20 bytes): pos f32x3 | normal i8x3 norm, bone u8 | color u8x4 norm (rgb, 255).

export const MESH_STRIDE = 20;

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
    this.nrm = [];
    this.col = [];
    this.bones = [];
    this.m = IDENTITY.slice();
    this.stack = [];
    this.rgb = [0.5, 0.5, 0.5];
    this.boneIndex = 0;
    this.boneMap = null;
  }

  get tris() {
    return this.pos.length / 9;
  }

  // --- state -------------------------------------------------------------------------

  color(r, g, b) {
    this.rgb = Array.isArray(r) ? r : [r, g, b];
    return this;
  }

  // Bone for the next vertices (remapped while building a mirrored half).
  bone(i) {
    this.boneIndex = this.boneMap ? this.boneMap[i] : i;
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

  // --- triangles -----------------------------------------------------------------------

  // Triangle a, b, c (local points [x, y, z]), counter-clockwise from the front. Mirroring
  // transforms keep the winding outward.
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
      this.bones.push(this.boneIndex);
    }
    return this;
  }

  quad(a, b, c, d) {
    return this.tri(a, b, c).tri(a, c, d);
  }

  // Simple polygon (points in order, either winding) as a fan of ears, facing `normal`
  // ([x, y, z]); pts are 3D and coplanar.
  polygon(pts, normal) {
    const idx = triangulate(pts, normal);
    for (let i = 0; i < idx.length; i += 3) this.tri(pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]);
    return this;
  }

  // --- primitives ----------------------------------------------------------------------

  // Box of size (sx, sy, sz) centered on (cx, cy, cz).
  box(sx, sy, sz, cx = 0, cy = 0, cz = 0) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
    this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]); // -x
    this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]); // +y
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -y
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]); // -z
    return this;
  }

  // Outline [[x, z], ...] (a side view: x forward, z up) extruded `depth` along y,
  // centered on y = 0: receivers, magazines, blades, stocks.
  extrude(outline, depth) {
    const h = depth / 2;
    const n = outline.length;
    const ccw = area2(outline) > 0; // counter-clockwise in (x, z) = facing -y
    const ring = (y) => outline.map(([x, z]) => [x, y, z]);
    const front = ring(-h), back = ring(h);
    this.polygon(front, [0, -1, 0]);
    this.polygon(back, [0, 1, 0]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (ccw) this.quad(front[i], back[i], back[j], front[j]);
      else this.quad(front[j], back[j], back[i], front[i]);
    }
    return this;
  }

  // Box with its four vertical edges rounded (radius r, seg steps per corner), centered:
  // padded torsos, pouches, grips.
  slab(sx, sy, sz, r, seg = 2) {
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
  lathe(profile, seg = 8) {
    const ring = (r, z) => {
      const out = [];
      for (let k = 0; k < seg; k++) {
        const a = 2 * Math.PI * k / seg;
        out.push([r * Math.cos(a), r * Math.sin(a), z]);
      }
      return out;
    };
    const rings = profile.map(([r, z]) => (r > 0 ? ring(r, z) : null));
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
    return this;
  }

  // Capsule along z from z = 0 to z = len (the caps included), radius r: limbs.
  capsule(r, len, seg = 8, capSteps = 2) {
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

  // Skin between sections across z: rings [{ z, pts: [[x, y], ...] }], all with the same
  // number of points in the same (counter-clockwise from +z) order. Ends are capped.
  loft(rings) {
    const n = rings[0].pts.length;
    const P = rings.map(({ z, pts }) => {
      if (pts.length !== n) throw new Error('loft rings need equal point counts');
      const r = pts.map(([x, y]) => [x, y, z]);
      return area2(pts) > 0 ? r : r.reverse();
    });
    for (let i = 0; i + 1 < P.length; i++) {
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        this.quad(P[i][k], P[i][j], P[i + 1][j], P[i + 1][k]);
      }
    }
    this.polygon(P[0].slice().reverse(), [0, 0, -1]);
    this.polygon(P.at(-1), [0, 0, 1]);
    return this;
  }

  // --- output --------------------------------------------------------------------------

  build() {
    const count = this.pos.length / 3;
    const data = new ArrayBuffer(count * MESH_STRIDE);
    const f = new Float32Array(data), i8 = new Int8Array(data), u8 = new Uint8Array(data);
    for (let v = 0; v < count; v++) {
      const o = v * MESH_STRIDE;
      f[o / 4] = this.pos[v * 3];
      f[o / 4 + 1] = this.pos[v * 3 + 1];
      f[o / 4 + 2] = this.pos[v * 3 + 2];
      for (let c = 0; c < 3; c++) i8[o + 12 + c] = Math.round(this.nrm[v * 3 + c] * 127);
      u8[o + 15] = this.bones[v];
      for (let c = 0; c < 3; c++) u8[o + 16 + c] = Math.max(0, Math.min(255, Math.round(this.col[v * 3 + c] * 255)));
      u8[o + 19] = 255;
    }
    return { data, count, tris: count / 3, positions: new Float32Array(this.pos) };
  }
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
