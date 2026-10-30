// A small map compiler of our own: GoldSrc BSP 30 files (the format shared/bsp.js reads)
// from convex brushes: boxes, wedges (ramps), turned boxes (angled walls), prisms
// (pillars), any convex set of planes. Used by tools/gen_demomap.js (de_playground) and
// by the map editor in the browser (client/editor/), so it runs in Deno and in a Worker.
//  * per model and hull, a BSP tree splits space on the brushes' own planes until every
//    cell (a convex polyhedron) is inside a brush (solid) or outside all of them (empty);
//    hulls 1-3 use the brushes grown by the player hulls (every plane moved out by the
//    hull's reach along its normal, plus axial bevel planes, as GoldSrc's compilers do),
//    so collision is GoldSrc's own;
//  * faces are the brushes' sides pushed down the hull 0 tree: the parts that end in open
//    space are kept, hung on the node whose plane they lie on (GoldSrc's light point
//    lookup expects that), merged back where neighbors make a convex polygon, wound
//    clockwise seen from the front;
//  * texture axes follow the face's nearest axis (GoldSrc's world alignment), and
//    lightmaps (16 units a texel) are baked here: a warm sun with shadows and a cool sky
//    seen from each texel (18 rays), traced against the brushes; `light: 'draft'` skips
//    the rays (no shadows), for a quick look while editing.
// Only the lumps the engine reads are filled (no visibility, no marksurfaces).
// Deterministic: the same input gives the same bytes.

export const CONTENTS_EMPTY = -1, CONTENTS_SOLID = -2, CONTENTS_WATER = -3;

const EPS = 0.01; // plane side tolerance (units)
const HUGE = 65536;

// --- Brushes ---------------------------------------------------------------------------

// A box brush: [x0, y0, z0, x1, y1, z1] and its textures: one name, or per side
// { top, bottom, side } / { px, nx, py, ny, pz, nz } (null: no face there).
export const SIDES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
export const NONE = { top: null, bottom: null, side: null }; // triggers and volumes: no faces
const sideTextures = (tex) => {
  const t = typeof tex === 'string' ? { top: tex, bottom: tex, side: tex } : tex;
  return SIDES.map((s, i) => (s in t ? t[s] : i === 4 ? t.top : i === 5 ? t.bottom : t.side) ?? null);
};
export function box(x0, y0, z0, x1, y1, z1, tex, opts = {}) {
  const per = sideTextures(tex);
  return { b: [x0, y0, z0, x1, y1, z1], tex: per, sky: per.includes('sky'), ...opts };
}

// A convex brush from its planes: [{ n: [x, y, z] (outward, any length), d, tex }]
// (inside: n·p <= d).
export function convex(planes, opts = {}) {
  const ps = planes.map((p) => {
    const l = Math.hypot(p.n[0], p.n[1], p.n[2]);
    return { n: p.n.map((x) => x / l), d: p.d / l, tex: p.tex ?? null };
  });
  return { planes: ps, sky: ps.some((p) => p.tex === 'sky'), ...opts };
}

const boxPlanes = (b, tex) => [
  { n: [1, 0, 0], d: b[3], tex: tex[0] }, { n: [-1, 0, 0], d: -b[0], tex: tex[1] },
  { n: [0, 1, 0], d: b[4], tex: tex[2] }, { n: [0, -1, 0], d: -b[1], tex: tex[3] },
  { n: [0, 0, 1], d: b[5], tex: tex[4] }, { n: [0, 0, -1], d: -b[2], tex: tex[5] },
];

// A ramp: box b rising toward `up` ('px', 'nx', 'py', 'ny': the high side), its slope
// textured like the top.
export function wedge(b, up, tex, opts = {}) {
  const t = sideTextures(tex);
  const [x0, y0, z0, x1, y1, z1] = b, h = z1 - z0;
  const planes = boxPlanes(b, t).filter((p) => !(p.n[2] === 1)); // no flat top
  // The low side's wall goes too: the slope meets the bottom there.
  const low = { px: 1, nx: 0, py: 3, ny: 2 }[up]; // index in boxPlanes of the low side
  const lowN = boxPlanes(b, t)[low].n;
  const kept = planes.filter((p) => !(p.n[0] === lowN[0] && p.n[1] === lowN[1] && p.n[2] === 0));
  const run = up === 'px' || up === 'nx' ? x1 - x0 : y1 - y0;
  // Slope plane through the low bottom edge and the high top edge: n = (-dir * h, run) style.
  const dir = { px: [1, 0], nx: [-1, 0], py: [0, 1], ny: [0, -1] }[up];
  const n = [-dir[0] * h, -dir[1] * h, run];
  const lowEdge = up === 'px' ? x0 : up === 'nx' ? x1 : up === 'py' ? y0 : y1;
  const p0 = [up === 'px' || up === 'nx' ? lowEdge : x0, up === 'py' || up === 'ny' ? lowEdge : y0, z0];
  const d = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2];
  kept.push({ n, d, tex: t[4] });
  return convex(kept, opts);
}

// A box turned by `yaw` degrees about its vertical center line (an angled wall).
export function turnedBox(b, yaw, tex, opts = {}) {
  const t = sideTextures(tex);
  const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, hx = (b[3] - b[0]) / 2, hy = (b[4] - b[1]) / 2;
  const a = yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const ex = [c, s, 0], ey = [-s, c, 0];
  const dot = (n) => n[0] * cx + n[1] * cy;
  return convex([
    { n: ex, d: dot(ex) + hx, tex: t[0] }, { n: ex.map((v) => -v), d: -dot(ex) + hx, tex: t[1] },
    { n: ey, d: dot(ey) + hy, tex: t[2] }, { n: ey.map((v) => -v), d: -dot(ey) + hy, tex: t[3] },
    { n: [0, 0, 1], d: b[5], tex: t[4] }, { n: [0, 0, -1], d: -b[2], tex: t[5] },
  ], opts);
}

// A prism with `sides` faces round the vertical center line of box b (a pillar), touching
// the box's sides, turned by `yaw` degrees.
export function prism(b, sides, yaw, tex, opts = {}) {
  const t = sideTextures(tex);
  const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, rx = (b[3] - b[0]) / 2, ry = (b[4] - b[1]) / 2;
  const planes = [{ n: [0, 0, 1], d: b[5], tex: t[4] }, { n: [0, 0, -1], d: -b[2], tex: t[5] }];
  for (let k = 0; k < sides; k++) {
    const a = (yaw + (k + 0.5) * 360 / sides) * Math.PI / 180;
    // The side's normal on the ellipse through the box's sides (a circle in a square box).
    const nx = Math.cos(a) / rx, ny = Math.sin(a) / ry;
    planes.push({ n: [nx, ny, 0], d: nx * cx + ny * cy + Math.cos(Math.PI / sides), tex: t[0] });
  }
  return convex(planes, opts);
}

// The planes of a brush (a box's six, or its own).
export const brushPlanes = (br) => br.planes || boxPlanes(br.b, br.tex);

// --- Geometry --------------------------------------------------------------------------

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

// A big square on plane (n, d), counter-clockwise round n.
function planeSquare(n, d) {
  const up = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(cross(up, n)), v = cross(n, u);
  const c = [n[0] * d, n[1] * d, n[2] * d];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
    [c[0] + (u[0] * a + v[0] * b) * HUGE, c[1] + (u[1] * a + v[1] * b) * HUGE, c[2] + (u[2] * a + v[2] * b) * HUGE]);
}

// The part of convex polygon `poly` behind plane (n, d) (n·p <= d), or in front (front).
function clip(poly, n, d, front = false) {
  const out = [];
  const s = front ? -1 : 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = s * (dot3(n, a) - d), db = s * (dot3(n, b) - d);
    if (da <= EPS) out.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out.length >= 3 ? out : [];
}

// The brush's face polygons (one per plane, [] where a plane bounds nothing), each
// counter-clockwise round its outward normal.
export function brushPolygons(planes) {
  return planes.map((p, i) => {
    let poly = planeSquare(p.n, p.d);
    for (let j = 0; j < planes.length && poly.length; j++) if (j !== i) poly = clip(poly, planes[j].n, planes[j].d);
    return poly;
  });
}

const boundsOf = (points) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], p[k]);
      b[k + 3] = Math.max(b[k + 3], p[k]);
    }
  }
  return b;
};

// A convex cell: its face polygons (vertex loops, any winding) and its vertices.
function boxCell(b) {
  const polys = brushPolygons(boxPlanes(b, [null, null, null, null, null, null]));
  return { polys, verts: polys.flat() };
}

// Splits a cell by plane (n, d): [back (n·p <= d), front].
function splitCell(cell, n, d) {
  const back = [], front = [], cap = [];
  for (const poly of cell.polys) {
    const ds = poly.map((p) => dot3(n, p) - d);
    if (ds.every((x) => x <= EPS)) back.push(poly);
    else if (ds.every((x) => x >= -EPS)) front.push(poly);
    else {
      const b = clip(poly, n, d), f = clip(poly, n, d, true);
      if (b.length) back.push(b);
      if (f.length) front.push(f);
      for (let i = 0; i < poly.length; i++) { // where the edges cross the plane
        const a = ds[i], c = ds[(i + 1) % poly.length];
        if (Math.abs(a) <= EPS) cap.push(poly[i]);
        else if ((a < -EPS && c > EPS) || (a > EPS && c < -EPS)) {
          const q = poly[(i + 1) % poly.length], t = a / (a - c);
          cap.push([poly[i][0] + (q[0] - poly[i][0]) * t, poly[i][1] + (q[1] - poly[i][1]) * t,
            poly[i][2] + (q[2] - poly[i][2]) * t]);
        }
      }
    }
  }
  const capPoly = orderLoop(cap, n);
  if (capPoly.length >= 3) {
    back.push(capPoly);
    front.push(capPoly);
  }
  return [{ polys: back, verts: back.flat() }, { polys: front, verts: front.flat() }];
}

// Points on a plane as a loop round their center (duplicates dropped).
function orderLoop(points, n) {
  const pts = [];
  for (const p of points) if (!pts.some((q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < EPS)) pts.push(p);
  if (pts.length < 3) return [];
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const up = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(cross(up, n)), v = cross(n, u);
  return pts.map((p) => [p, Math.atan2(dot3(v, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]),
    dot3(u, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]))]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

// Which side of plane (n, d) points lie: -1 all behind, 1 all in front, 0 both.
function sideOf(points, n, d) {
  let back = false, front = false;
  for (const p of points) {
    const x = dot3(n, p) - d;
    if (x > EPS) front = true;
    else if (x < -EPS) back = true;
    if (front && back) return 0;
  }
  return front ? 1 : -1;
}

// GoldSrc's plane storage: axial planes face +axis (type 0-2); others have their largest
// component positive (type 3-5). Returns { n, d, type, flip } (flip: the canonical plane
// faces the other way).
function canonical(n, d) {
  const a = n.map(Math.abs);
  const axis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  const flip = n[axis] < 0;
  const cn = flip ? n.map((x) => -x || 0) : n.slice(), cd = flip ? -d : d;
  const axial = a[(axis + 1) % 3] < 1e-6 && a[(axis + 2) % 3] < 1e-6;
  if (axial) {
    cn[0] = cn[1] = cn[2] = 0;
    cn[axis] = 1;
  }
  return { n: cn, d: cd, type: axial ? axis : 3 + axis, flip };
}

// --- Tree ------------------------------------------------------------------------------

// GoldSrc hulls 1-3 (point, standing, large, crouched): mins / maxs.
const HULLS = [[0, 0, 0, 0, 0, 0], [-16, -16, -36, 16, 16, 36], [-32, -32, -32, 32, 32, 32], [-16, -16, -18, 16, 16, 18]];

// A brush for a hull, in model space: planes moved out by the hull's reach along their
// normal, plus the axial bevels of the grown bounds; with its vertices.
function hullBrush(planes, h, origin, contents, index) {
  const [m0, m1, m2, M0, M1, M2] = HULLS[h], m = [m0, m1, m2], M = [M0, M1, M2];
  const local = planes.map((p) => ({ n: p.n, d: p.d - dot3(p.n, origin), tex: p.tex }));
  const verts = brushPolygons(local).flat();
  if (!verts.length) return null;
  const reach = (n) => n.reduce((s, x, k) => s + (x > 0 ? -m[k] : -M[k]) * x, 0);
  const grown = local.map((p) => ({ n: p.n, d: p.d + reach(p.n), tex: p.tex }));
  const b = boundsOf(verts);
  const g = [b[0] - M0, b[1] - M1, b[2] - M2, b[3] - m0, b[4] - m1, b[5] - m2];
  for (const p of boxPlanes(g, [null, null, null, null, null, null])) {
    if (!grown.some((q) => Math.abs(dot3(q.n, p.n) - 1) < 1e-9 && Math.abs(q.d - p.d) < EPS)) grown.push(p);
  }
  const all = h === 0 ? local : grown;
  return { planes: all, verts: h === 0 ? verts : brushPolygons(all).flat(), contents, index };
}

// BSP tree over brushes inside `cell`: a node { n, d (canonical), type, front, back, cell
// bounds } or a leaf { contents, bounds }.
function buildTree(brushes, rootBounds) {
  const split = (cell, list) => {
    const verts = cell.verts, bounds = boundsOf(verts);
    const inside = list.filter((i) => !brushes[i].planes.some((p) => sideOf(verts, p.n, p.d) === 1));
    if (!inside.length) return { contents: CONTENTS_EMPTY, bounds };
    const full = inside.find((i) => brushes[i].planes.every((p) => sideOf(verts, p.n, p.d) === -1));
    if (full !== undefined) return { contents: brushes[full].contents, bounds };
    let best = null, bestScore = Infinity;
    const tried = new Set();
    for (const i of inside) {
      for (const p of brushes[i].planes) {
        const c = canonical(p.n, p.d);
        const key = `${c.n.map((x) => x.toFixed(6))}:${c.d.toFixed(4)}`;
        if (tried.has(key)) continue;
        tried.add(key);
        if (sideOf(verts, c.n, c.d) !== 0) continue; // does not cut this cell
        let front = 0, back = 0, cross = 0;
        for (const j of inside) {
          const s = sideOf(brushes[j].verts, c.n, c.d);
          if (s < 0) back++;
          else if (s > 0) front++;
          else cross++;
        }
        const score = Math.abs(front - back) + cross * 3 + (c.type < 3 ? 0 : 0.5);
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    if (!best) return { contents: brushes[inside[0]].contents, bounds }; // (within the tolerance: call it inside)
    const [b, f] = splitCell(cell, best.n, best.d);
    return { n: best.n, d: best.d, type: best.type, bounds, front: split(f, inside), back: split(b, inside) };
  };
  return split(boxCell(rootBounds), brushes.map((_, i) => i));
}

// --- Faces -----------------------------------------------------------------------------

// A brush side pushed down the hull 0 tree: its parts in open space, with the node whose
// plane each lies on and whether it faces that plane's back (side 1).
function faceFragments(tree, poly, normal, out) {
  const push = (node, p, on) => {
    if (node.n === undefined) {
      if (node.contents !== CONTENTS_SOLID && on) out.push({ poly: p, node: on.node, side: on.side });
      return;
    }
    const ds = p.map((v) => dot3(node.n, v) - node.d);
    if (ds.every((x) => Math.abs(x) <= EPS)) {
      const facing = dot3(normal, node.n) > 0;
      push(facing ? node.front : node.back, p, on || { node, side: facing ? 0 : 1 });
    } else if (ds.every((x) => x <= EPS)) push(node.back, p, on);
    else if (ds.every((x) => x >= -EPS)) push(node.front, p, on);
    else {
      const b = clip(p, node.n, node.d), f = clip(p, node.n, node.d, true);
      if (b.length) push(node.back, b, on);
      if (f.length) push(node.front, f, on);
    }
  };
  push(tree, poly, null);
}

const samePoint = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < EPS;

// Drops corners on a straight line between their neighbors.
function simplify(poly, n) {
  let p = poly;
  for (let changed = true; changed && p.length > 3;) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const x = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - b[0], c[1] - b[1], c[2] - b[2]]);
      if (Math.abs(dot3(x, n)) < 1e-3 || samePoint(a, b)) {
        p = p.slice(0, i).concat(p.slice(i + 1));
        changed = true;
        break;
      }
    }
  }
  return p;
}

// Two counter-clockwise polygons sharing an edge, joined if the result is convex.
function joinPolys(p, q, n) {
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) {
      if (!samePoint(q[j], b) || !samePoint(q[(j + 1) % q.length], a)) continue;
      const joined = [];
      for (let k = 0; k <= i; k++) joined.push(p[k]);
      for (let k = 2; k < q.length; k++) joined.push(q[(j + k) % q.length]);
      for (let k = i + 1; k < p.length; k++) joined.push(p[k]);
      const s = simplify(joined, n);
      for (let k = 0; k < s.length; k++) { // convex: every turn the same way round n
        const u = s[k], v = s[(k + 1) % s.length], w = s[(k + 2) % s.length];
        const x = cross([v[0] - u[0], v[1] - u[1], v[2] - u[2]], [w[0] - v[0], w[1] - v[1], w[2] - v[2]]);
        if (dot3(x, n) < -1e-3) return null;
      }
      return s;
    }
  }
  return null;
}

// --- Lighting --------------------------------------------------------------------------

const SUN = norm([-0.42, 0.3, 0.86]); // toward the sun
const SUN_RGB = [190, 172, 148]; // open sunny ground ~235: under the clamp, so the tints stay
const SKY_RGB = [52, 60, 80];
const BASE_RGB = [20, 20, 24];
const SKY_DIRS = [];
for (let ring = 0; ring < 3; ring++) { // three rings of directions over the hemisphere
  const el = (ring + 0.5) / 3 * Math.PI / 2, n = 4 + ring * 2;
  for (let k = 0; k < n; k++) {
    const az = (k + ring * 0.5) / n * Math.PI * 2;
    SKY_DIRS.push([Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)]);
  }
}
const SKY_NORM = SKY_DIRS.reduce((s, d) => s + d[2], 0); // an open floor sees all the sky

// Brushes that cast no shadows: triggers, volumes, ladders (and glass, the sky: see below).
const SHADOWLESS = new Set(['func_buyzone', 'func_bomb_target', 'func_ladder', 'func_water', 'func_hostage_rescue',
  'func_illusionary']);

// Texture axes by the face's nearest axis (GoldSrc's): floors s = x, t = -y; walls s along,
// t = -z. Ties go to the floor, then x.
const TEX_AXES = [[[0, 1, 0], [0, 0, -1]], [[1, 0, 0], [0, 0, -1]], [[1, 0, 0], [0, -1, 0]]];
const texAxis = (n) => {
  const a = n.map(Math.abs);
  return a[2] >= a[0] - 1e-6 && a[2] >= a[1] - 1e-6 ? 2 : a[0] >= a[1] - 1e-6 ? 0 : 1;
};

// --- The map ---------------------------------------------------------------------------

// A map being put together: the world's brushes, brush entities (each its own model) and
// point entities. textures: name -> [width, height] (the shaders scale patterns by it).
export class MapBuilder {
  constructor(textures, worldKeys = {}) {
    this.textures = textures;
    this.world = [];
    this.ents = [{ classname: 'worldspawn', ...worldKeys }];
    this.models = [{ brushes: this.world, origin: [0, 0, 0] }];
  }

  // A brush entity: its keys and brushes (in world coordinates; a hinge `origin` key makes
  // the model relative to it, as GoldSrc's origin brushes do). opts: { contents } (water).
  brushEntity(keys, brushes, opts = {}) {
    const origin = keys.origin ? keys.origin.split(' ').map(Number) : [0, 0, 0];
    this.models.push({ brushes, origin, ...opts });
    this.ents.push({ ...keys, model: `*${this.models.length - 1}` });
  }

  point(keys) {
    this.ents.push(keys);
  }

  // The BSP file: { bytes, stats }. opts: light 'full' (default) or 'draft'.
  compile(opts = {}) {
    return compileBSP(this.textures, this.models, this.ents, opts);
  }
}

// models: [{ brushes, origin, contents? }] (model 0 the world), ents: entity key objects
// (brush entities name their model as "*n"). Returns { bytes: Uint8Array, stats }.
export function compileBSP(TEX, models, ents, { light = 'full' } = {}) {
  const planes = [], planeOf = new Map();
  // A canonical plane's index.
  function plane(c) {
    const key = `${c.n.map((x) => x.toFixed(6))}:${c.d.toFixed(4)}`;
    if (!planeOf.has(key)) {
      planeOf.set(key, planes.length);
      planes.push(c);
    }
    return planeOf.get(key);
  }

  // Brushes that cast shadows (world coordinates, with bounds): solid ones but the sky,
  // glass, water, triggers and ladders.
  const occluders = [];
  models.forEach((m, i) => {
    const e = i === 0 ? ents[0] : ents.find((x) => x.model === `*${i}`);
    if (SHADOWLESS.has(e.classname) || (e.classname === 'func_breakable' && e.material === '0')) return;
    for (const br of m.brushes) {
      if (br.sky) continue;
      const ps = brushPlanes(br), verts = brushPolygons(ps).flat();
      if (verts.length) occluders.push({ planes: ps, b: boundsOf(verts) });
    }
  });

  // Does the ray from p along d (unit) hit a brush within `far`?
  function blocked(p, d, far = 8192) {
    for (const o of occluders) {
      const b = o.b;
      let t0 = 0, t1 = far;
      for (let k = 0; k < 3 && t0 <= t1; k++) { // the bounds first
        if (Math.abs(d[k]) < 1e-9) {
          if (p[k] < b[k] || p[k] > b[k + 3]) t0 = Infinity;
          continue;
        }
        let ta = (b[k] - p[k]) / d[k], tb = (b[k + 3] - p[k]) / d[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 > t1) continue;
      t0 = 0;
      t1 = far;
      for (const pl of o.planes) {
        const den = dot3(pl.n, d), dist = pl.d - dot3(pl.n, p);
        if (Math.abs(den) < 1e-9) {
          if (dist < 0) {
            t0 = Infinity;
            break;
          }
          continue;
        }
        const t = dist / den;
        if (den > 0) t1 = Math.min(t1, t);
        else t0 = Math.max(t0, t);
        if (t0 > t1) break;
      }
      if (t0 <= t1) return true;
    }
    return false;
  }

  // Light (0..255 rgb) at point p on a face with normal n.
  function lightAt(p, n) {
    const q = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
    const ndl = dot3(n, SUN);
    let sun, sky = 0;
    if (light === 'draft') {
      sun = Math.max(0, ndl);
      sky = (1 + n[2]) / 2;
    } else {
      sun = ndl > 0 && !blocked(q, SUN) ? ndl : 0;
      for (const d of SKY_DIRS) {
        const k = dot3(n, d);
        if (k > 0 && !blocked(q, d)) sky += k;
      }
      sky /= SKY_NORM;
    }
    return [0, 1, 2].map((c) => Math.min(255, Math.round(BASE_RGB[c] + SUN_RGB[c] * sun + SKY_RGB[c] * sky)));
  }

  const texNames = Object.keys(TEX), texIndex = new Map(texNames.map((n, i) => [n, i]));
  const texinfos = [], texinfoOf = new Map();
  function texinfo(tex, axis) {
    const key = `${tex}:${axis}`;
    if (!texinfoOf.has(key)) {
      if (!texIndex.has(tex)) throw new Error(`texture ${tex} is not in the texture list`); // (it would print as sky)
      texinfoOf.set(key, texinfos.length);
      const special = tex === 'sky' || tex[0] === '!' ? 1 : 0;
      texinfos.push({ s: TEX_AXES[axis][0], t: TEX_AXES[axis][1], miptex: texIndex.get(tex), flags: special });
    }
    return texinfoOf.get(key);
  }

  const vertices = [], vertexOf = new Map();
  function vertex(p) {
    const r = p.map((x) => Math.round(x * 64) / 64 || 0); // welded: neighbors share corners exactly
    const key = r.join(',');
    if (!vertexOf.has(key)) {
      vertexOf.set(key, vertices.length);
      vertices.push(r);
    }
    return vertexOf.get(key);
  }
  const edges = [[0, 0]]; // edge 0 is never used (its sign could not be told)
  const surfedges = [], faces = [], nodes = [], leaves = [], clipnodes = [], modelRecs = [];
  const lighting = [];
  leaves.push({ contents: CONTENTS_SOLID, bounds: [0, 0, 0, 0, 0, 0] }); // leaf 0: every solid point

  // A face record from a fragment: { poly (counter-clockwise round `normal`), normal, d,
  // tex, side } in model space; `o` is the model's origin, for light.
  function addFace(f, o) {
    const ring = f.poly.map(vertex).reverse(); // clockwise seen from the front
    const loop = ring.filter((v, i) => v !== ring[(i + 1) % ring.length]);
    if (loop.length < 3) return;
    const firstedge = surfedges.length;
    for (let i = 0; i < loop.length; i++) {
      surfedges.push(edges.length);
      edges.push([loop[i], loop[(i + 1) % loop.length]]);
    }
    const ti = texinfo(f.tex, texAxis(f.normal)), info = texinfos[ti];
    let lightofs = -1;
    if (!info.flags) lightofs = bakeLightmap(f, info, o);
    faces.push({ plane: f.planeIndex, side: f.side, firstedge, numedges: loop.length, texinfo: ti, lightofs });
  }

  // The face's lightmap: one texel per 16 texture units over its extents (as the engine
  // reads them), each lit at the nearest point of the face.
  function bakeLightmap(f, info, o) {
    const st = f.poly.map((p) => [dot3(p, info.s), dot3(p, info.t)]);
    let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
    for (const [s, t] of st) {
      smin = Math.min(smin, s);
      smax = Math.max(smax, s);
      tmin = Math.min(tmin, t);
      tmax = Math.max(tmax, t);
    }
    const minS = Math.floor(smin / 16), minT = Math.floor(tmin / 16);
    const w = Math.ceil(smax / 16) - minS + 1, h = Math.ceil(tmax / 16) - minT + 1;
    const ofs = lighting.length;
    const n = f.normal;
    const sAxis = info.s.findIndex((x) => x !== 0), tAxis = info.t.findIndex((x) => x !== 0);
    const k = 3 - sAxis - tAxis; // the axis the face is solved along
    const cs = st.reduce((a, p) => [a[0] + p[0] / st.length, a[1] + p[1] / st.length], [0, 0]);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        // Into the face: half a unit inside its outline (never sample in the wall beside it).
        const [s, t] = insidePoint(st, cs, (minS + i) * 16, (minT + j) * 16);
        const pt = [0, 0, 0];
        pt[sAxis] = s * info.s[sAxis];
        pt[tAxis] = t * info.t[tAxis];
        pt[k] = (f.d - n[sAxis] * pt[sAxis] - n[tAxis] * pt[tAxis]) / n[k];
        lighting.push(...lightAt([pt[0] + o[0], pt[1] + o[1], pt[2] + o[2]], n));
      }
    }
    return ofs;
  }

  // Hull 0 tree -> nodes (with their faces) and leaves; returns the head node index.
  function emitNodes(tree, facesByNode, origin) {
    const emit = (n) => {
      if (n.n === undefined) {
        if (n.contents === CONTENTS_SOLID) return -1; // leaf 0
        leaves.push({ contents: n.contents, bounds: n.bounds });
        return -leaves.length;
      }
      const i = nodes.length;
      const rec = { plane: plane(n), bounds: n.bounds, firstface: faces.length, numfaces: 0 };
      nodes.push(rec);
      for (const f of facesByNode.get(n) || []) addFace({ ...f, planeIndex: rec.plane }, origin);
      rec.numfaces = faces.length - rec.firstface;
      rec.front = emit(n.front);
      rec.back = emit(n.back);
      return i;
    };
    return emit(tree);
  }

  function emitClipnodes(tree) {
    const emit = (n) => {
      if (n.n === undefined) return n.contents;
      const i = clipnodes.length, rec = { plane: plane(n) };
      clipnodes.push(rec);
      rec.front = emit(n.front);
      rec.back = emit(n.back);
      return i;
    };
    return emit(tree);
  }

  models.forEach((model, mi) => {
    if (!model.brushes.length) throw new Error(mi ? `entity model *${mi} has no brushes` : 'the map has no brushes');
    const isWorld = mi === 0;
    const heads = [];
    const firstface = faces.length;
    const contents = model.contents ?? CONTENTS_SOLID;
    let bounds0 = null;
    for (let h = 0; h < 4; h++) {
      const brushes = model.brushes.map((br, i) => hullBrush(brushPlanes(br), h, model.origin, contents, i)).filter(Boolean);
      if (!brushes.length) throw new Error(`model *${mi} has no volume`);
      const root = boundsOf(brushes.flatMap((b) => b.verts));
      if (h === 0) bounds0 = root.slice();
      if (!isWorld) for (let k = 0; k < 3; k++) (root[k] -= 16), (root[k + 3] += 16); // so beyond it is empty
      const tree = buildTree(brushes, root);
      if (h === 0) {
        // Every textured side of every brush, down the tree: the parts in open space.
        const byNode = new Map();
        for (const br of model.brushes) {
          const ps = brushPlanes(br).map((p) => ({ n: p.n, d: p.d - dot3(p.n, model.origin), tex: p.tex }));
          brushPolygons(ps).forEach((poly, i) => {
            if (!poly.length || !ps[i].tex) return;
            const frags = [];
            faceFragments(tree, poly, ps[i].n, frags);
            for (const fr of frags) {
              if (!byNode.has(fr.node)) byNode.set(fr.node, []);
              byNode.get(fr.node).push({ poly: fr.poly, normal: ps[i].n, d: ps[i].d, tex: ps[i].tex, side: fr.side });
            }
          });
        }
        // Neighbors on one node, side and texture, joined where they make a convex polygon.
        for (const list of byNode.values()) {
          for (let merged = true; merged;) {
            merged = false;
            for (let i = 0; i < list.length && !merged; i++) {
              for (let j = i + 1; j < list.length && !merged; j++) {
                const p = list[i], q = list[j];
                if (p.side !== q.side || p.tex !== q.tex) continue;
                const joined = joinPolys(p.poly, q.poly, p.normal);
                if (!joined) continue;
                p.poly = joined;
                list.splice(j, 1);
                merged = true;
              }
            }
          }
          for (const f of list) f.poly = simplify(f.poly, f.normal);
        }
        heads.push(emitNodes(tree, byNode, model.origin));
      } else heads.push(emitClipnodes(tree));
    }
    modelRecs.push({ mins: bounds0.slice(0, 3), maxs: bounds0.slice(3), heads, firstface, numfaces: faces.length - firstface });
  });

  if (vertices.length > 65535 || nodes.length > 32767 || clipnodes.length > 32767 || leaves.length > 32767 ||
    faces.length > 65535 || planes.length > 32767) {
    throw new Error('the map is too big for BSP 30');
  }

  const entText = ents.map((e) => `{\n${Object.entries(e).map(([k, v]) => `"${k}" "${v}"`).join('\n')}\n}\n`).join('') +
    '\0';
  const lumps = [];
  const buf = (n) => new DataView(new ArrayBuffer(n));
  // 0 entities
  lumps[0] = new TextEncoder().encode(entText);
  // 1 planes: normal, dist, type
  let d = buf(planes.length * 20);
  planes.forEach((p, i) => {
    for (let k = 0; k < 3; k++) d.setFloat32(i * 20 + k * 4, p.n[k], true);
    d.setFloat32(i * 20 + 12, p.d, true);
    d.setInt32(i * 20 + 16, p.type, true);
  });
  lumps[1] = d;
  // 2 textures: count, offsets, miptex headers (no pixels: the game never loads them)
  d = buf(4 + texNames.length * 44);
  d.setInt32(0, texNames.length, true);
  texNames.forEach((name, i) => {
    const o = 4 + texNames.length * 4 + i * 40;
    d.setInt32(4 + i * 4, o, true);
    for (let k = 0; k < name.length && k < 15; k++) d.setUint8(o + k, name.charCodeAt(k));
    d.setUint32(o + 16, TEX[name][0], true);
    d.setUint32(o + 20, TEX[name][1], true);
  });
  lumps[2] = d;
  // 3 vertices
  d = buf(vertices.length * 12);
  vertices.forEach((v, i) => v.forEach((x, k) => d.setFloat32(i * 12 + k * 4, x, true)));
  lumps[3] = d;
  lumps[4] = new Uint8Array(0); // visibility: none (everything is drawn)
  // 5 nodes
  const lo = (x) => Math.max(-32768, Math.min(32767, Math.floor(x)));
  const hi = (x) => Math.max(-32768, Math.min(32767, Math.ceil(x)));
  d = buf(nodes.length * 24);
  nodes.forEach((n, i) => {
    const o = i * 24;
    d.setInt32(o, n.plane, true);
    d.setInt16(o + 4, n.front, true);
    d.setInt16(o + 6, n.back, true);
    for (let k = 0; k < 3; k++) {
      d.setInt16(o + 8 + k * 2, lo(n.bounds[k]), true);
      d.setInt16(o + 14 + k * 2, hi(n.bounds[k + 3]), true);
    }
    d.setUint16(o + 20, n.firstface, true);
    d.setUint16(o + 22, n.numfaces, true);
  });
  lumps[5] = d;
  // 6 texinfo
  d = buf(texinfos.length * 40);
  texinfos.forEach((t, i) => {
    const o = i * 40;
    t.s.forEach((x, k) => d.setFloat32(o + k * 4, x, true));
    t.t.forEach((x, k) => d.setFloat32(o + 16 + k * 4, x, true));
    d.setInt32(o + 32, t.miptex, true);
    d.setInt32(o + 36, t.flags, true);
  });
  lumps[6] = d;
  // 7 faces
  d = buf(faces.length * 20);
  faces.forEach((f, i) => {
    const o = i * 20;
    d.setUint16(o, f.plane, true);
    d.setInt16(o + 2, f.side, true);
    d.setInt32(o + 4, f.firstedge, true);
    d.setInt16(o + 8, f.numedges, true);
    d.setInt16(o + 10, f.texinfo, true);
    d.setUint8(o + 12, f.lightofs < 0 ? 255 : 0);
    for (let k = 1; k < 4; k++) d.setUint8(o + 12 + k, 255);
    d.setInt32(o + 16, f.lightofs, true);
  });
  lumps[7] = d;
  lumps[8] = new Uint8Array(lighting);
  // 9 clipnodes
  d = buf(clipnodes.length * 8);
  clipnodes.forEach((c, i) => {
    d.setInt32(i * 8, c.plane, true);
    d.setInt16(i * 8 + 4, c.front, true);
    d.setInt16(i * 8 + 6, c.back, true);
  });
  lumps[9] = d;
  // 10 leaves
  d = buf(leaves.length * 28);
  leaves.forEach((l, i) => {
    d.setInt32(i * 28, l.contents, true);
    d.setInt32(i * 28 + 4, -1, true);
    for (let k = 0; k < 3; k++) {
      d.setInt16(i * 28 + 8 + k * 2, lo(l.bounds[k]), true);
      d.setInt16(i * 28 + 14 + k * 2, hi(l.bounds[k + 3]), true);
    }
  });
  lumps[10] = d;
  lumps[11] = new Uint8Array(0); // marksurfaces: unused (no visibility)
  // 12 edges, 13 surfedges
  d = buf(edges.length * 4);
  edges.forEach(([a, b], i) => {
    d.setUint16(i * 4, a, true);
    d.setUint16(i * 4 + 2, b, true);
  });
  lumps[12] = d;
  d = buf(surfedges.length * 4);
  surfedges.forEach((s, i) => d.setInt32(i * 4, s, true));
  lumps[13] = d;
  // 14 models
  d = buf(modelRecs.length * 64);
  modelRecs.forEach((m, i) => {
    const o = i * 64;
    for (let k = 0; k < 3; k++) {
      d.setFloat32(o + k * 4, m.mins[k], true);
      d.setFloat32(o + 12 + k * 4, m.maxs[k], true);
    }
    m.heads.forEach((h, k) => d.setInt32(o + 36 + k * 4, h, true));
    d.setInt32(o + 52, 0, true);
    d.setInt32(o + 56, m.firstface, true);
    d.setInt32(o + 60, m.numfaces, true);
  });
  lumps[14] = d;

  const bytes = lumps.map((l) => (l instanceof DataView ? new Uint8Array(l.buffer) : l));
  let size = 4 + 15 * 8;
  const ofs = bytes.map((b) => {
    const o = size;
    size += (b.length + 3) & ~3;
    return o;
  });
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setInt32(0, 30, true);
  bytes.forEach((b, i) => {
    dv.setInt32(4 + i * 8, ofs[i], true);
    dv.setInt32(8 + i * 8, b.length, true);
    out.set(b, ofs[i]);
  });
  return {
    bytes: out,
    stats: { models: models.length, faces: faces.length, nodes: nodes.length, clipnodes: clipnodes.length,
      leaves: leaves.length, texels: lighting.length / 3 },
  };
}

// A lightmap sample at texture point (s, t), moved into the face's outline `st` (convex,
// in texture space) to half a unit inside it, toward its center `c`.
function insidePoint(st, c, s, t) {
  // Shrink the outline half a unit toward the center, then clamp into it.
  const poly = st.map(([a, b]) => {
    const dx = c[0] - a, dy = c[1] - b, l = Math.hypot(dx, dy) || 1;
    return [a + dx / l * 0.5, b + dy / l * 0.5];
  });
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    area += x0 * y1 - x1 * y0;
  }
  const sgn = area >= 0 ? 1 : -1;
  let inside = true;
  for (let i = 0; i < poly.length && inside; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    if (sgn * ((x1 - x0) * (t - y0) - (y1 - y0) * (s - x0)) < 0) inside = false;
  }
  if (inside) return [s, t];
  let best = null, bd = Infinity;
  for (let i = 0; i < poly.length; i++) { // the nearest point of the outline
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((s - x0) * dx + (t - y0) * dy) / l2));
    const px = x0 + dx * u, py = y0 + dy * u, dd = (px - s) ** 2 + (py - t) ** 2;
    if (dd < bd) {
      bd = dd;
      best = [px, py];
    }
  }
  return best;
}
