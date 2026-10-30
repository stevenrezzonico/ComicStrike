// A small map compiler of our own: GoldSrc BSP 30 files (the format shared/bsp.js reads)
// from axis-aligned boxes only. Used by tools/gen_demomap.js (de_playground) and by the
// map editor in the browser (client/editor/), so it runs in Deno and in a Web Worker.
//  * per model and hull, a k-d tree splits space on the boxes' faces until every cell is
//    inside a box (solid) or outside all of them (empty); hulls 1-3 use the boxes grown
//    by the player hulls (exact for boxes), so collision is GoldSrc's own;
//  * faces are the sides of empty cells that touch solid ones (each piece hung on the
//    node whose plane it lies on, as GoldSrc's light point lookup expects), merged back
//    into rectangles where they line up, wound clockwise seen from the front;
//  * lightmaps (16 units a texel) are baked here: a warm sun with shadows and a cool sky
//    seen from each texel (18 rays), traced against the boxes; `light: 'draft'` skips the
//    rays (no shadows: the sun by the face's slope, the sky by how much it faces up), for
//    a quick look while editing.
// Only the lumps the engine reads are filled (no visibility, no marksurfaces).
// Deterministic: the same input gives the same bytes.

export const CONTENTS_EMPTY = -1, CONTENTS_SOLID = -2, CONTENTS_WATER = -3;

// A box brush: [x0, y0, z0, x1, y1, z1] and its textures: one name, or per side
// { top, bottom, side } / { px, nx, py, ny, pz, nz } (null: no face there).
export const SIDES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
export const NONE = { top: null, bottom: null, side: null }; // triggers and volumes: no faces
export function box(x0, y0, z0, x1, y1, z1, tex, opts = {}) {
  const t = typeof tex === 'string' ? { top: tex, bottom: tex, side: tex } : tex;
  const per = SIDES.map((s, i) => (s in t ? t[s] : i === 4 ? t.top : i === 5 ? t.bottom : t.side) ?? null);
  return { b: [x0, y0, z0, x1, y1, z1], tex: per, sky: per.includes('sky'), ...opts };
}

// A map being put together: the world's boxes, brush entities (each its own model) and
// point entities. textures: name -> [width, height] (the shaders scale patterns by it).
export class MapBuilder {
  constructor(textures, worldKeys = {}) {
    this.textures = textures;
    this.world = [];
    this.ents = [{ classname: 'worldspawn', ...worldKeys }];
    this.models = [{ brushes: this.world, origin: [0, 0, 0] }];
  }

  // A brush entity: its keys and boxes (in world coordinates; a hinge `origin` key makes
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

// GoldSrc hulls 1-3 (point, standing, large, crouched): mins / maxs.
const HULLS = [[0, 0, 0, 0, 0, 0], [-16, -16, -36, 16, 16, 36], [-32, -32, -32, 32, 32, 32], [-16, -16, -18, 16, 16, 18]];

// k-d tree over boxes (each { b, contents, brush }) inside `cell`: a node { axis, dist,
// front (> dist), back, cell } or a leaf { contents, brush, cell }.
function buildTree(boxes, cell) {
  const overlaps = (b, c) => b[0] < c[3] && b[3] > c[0] && b[1] < c[4] && b[4] > c[1] && b[2] < c[5] && b[5] > c[2];
  const contains = (b, c) => b[0] <= c[0] && b[3] >= c[3] && b[1] <= c[1] && b[4] >= c[4] && b[2] <= c[2] && b[5] >= c[5];
  const split = (c, list) => {
    const inside = list.filter((i) => overlaps(boxes[i].b, c));
    if (!inside.length) return { contents: CONTENTS_EMPTY, brush: -1, cell: c };
    const full = inside.find((i) => contains(boxes[i].b, c));
    if (full !== undefined) return { contents: boxes[full].contents, brush: boxes[full].brush, cell: c };
    let best = null, bestScore = Infinity;
    for (const i of inside) {
      for (let a = 0; a < 3; a++) {
        for (const v of [boxes[i].b[a], boxes[i].b[a + 3]]) {
          if (v <= c[a] || v >= c[a + 3]) continue;
          let front = 0, back = 0, cross = 0;
          for (const j of inside) {
            const b = boxes[j].b;
            if (b[a + 3] <= v) back++;
            else if (b[a] >= v) front++;
            else cross++;
          }
          const score = Math.abs(front - back) + cross * 3;
          if (score < bestScore) {
            bestScore = score;
            best = [a, v];
          }
        }
      }
    }
    const [a, v] = best, lo = c.slice(), hi = c.slice();
    lo[a + 3] = v;
    hi[a] = v;
    return { axis: a, dist: v, cell: c, front: split(hi, inside), back: split(lo, inside) };
  };
  return split(cell, boxes.map((_, i) => i));
}

const leavesOf = (n, out = []) => {
  if (n.axis === undefined) out.push(n);
  else {
    leavesOf(n.front, out);
    leavesOf(n.back, out);
  }
  return out;
};

// The model's boxes in model space for hull h, grown by the hull, and the root cell (the
// world's bounds exactly, so beyond them is solid; other models a margin wider, so empty).
function hullBoxes(model, h) {
  const [m0, m1, m2, M0, M1, M2] = HULLS[h], o = model.origin;
  return model.brushes.map((br, brush) => ({
    b: [br.b[0] - o[0] - M0, br.b[1] - o[1] - M1, br.b[2] - o[2] - M2, br.b[3] - o[0] - m0, br.b[4] - o[1] - m1,
      br.b[5] - o[2] - m2],
    contents: model.contents ?? CONTENTS_SOLID,
    brush,
  }));
}
function rootCell(boxes, isWorld) {
  const c = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { b } of boxes) {
    for (let k = 0; k < 3; k++) {
      c[k] = Math.min(c[k], b[k]);
      c[k + 3] = Math.max(c[k + 3], b[k + 3]);
    }
  }
  if (!isWorld) for (let k = 0; k < 3; k++) (c[k] -= 16), (c[k + 3] += 16);
  return c;
}

// The leaves of `node` the slab `q` (a box, zero thick on one axis allowed) touches.
function query(node, q, out) {
  if (node.axis === undefined) return out.push(node);
  const a = node.axis;
  if (q[a + 3] > node.dist) query(node.front, q, out);
  if (q[a] < node.dist) query(node.back, q, out);
}

// Faces of a model: where an empty cell meets a solid one, from the solid brush's side.
// Each piece: { axis, dist, side (0: faces +axis), u0, v0, u1, v1 (the two other axes in
// order), tex, node }.
const UV = [[1, 2], [2, 0], [0, 1]]; // in-plane axes with u x v = +axis
function modelFaces(model, tree) {
  const pieces = [];
  const root = tree.cell;
  for (const L of leavesOf(tree)) {
    if (L.contents !== CONTENTS_EMPTY) continue;
    const c = L.cell;
    for (let a = 0; a < 3; a++) {
      for (const up of [true, false]) {
        const d = up ? c[a + 3] : c[a];
        if (d === (up ? root[a + 3] : root[a])) continue; // the root's edge: nothing beyond
        const q = c.slice();
        q[a] = up ? d : d - 0.5;
        q[a + 3] = up ? d + 0.5 : d;
        const across = [];
        query(tree, q, across);
        const [u, v] = UV[a];
        for (const S of across) {
          if (S.contents === CONTENTS_EMPTY) continue;
          const u0 = Math.max(c[u], S.cell[u]), u1 = Math.min(c[u + 3], S.cell[u + 3]);
          const v0 = Math.max(c[v], S.cell[v]), v1 = Math.min(c[v + 3], S.cell[v + 3]);
          if (u1 <= u0 || v1 <= v0) continue;
          // The solid side faces back toward L: up (L below it) means the brush's -axis side.
          const tex = model.brushes[S.brush].tex[a * 2 + (up ? 1 : 0)];
          if (!tex) continue;
          pieces.push({ axis: a, dist: d, side: up ? 1 : 0, u0, v0, u1, v1, tex });
        }
      }
    }
  }
  // Hang each piece on the first node on its plane (where a trace crossing it is checked).
  for (const p of pieces) {
    let n = tree;
    while (!(n.axis === p.axis && n.dist === p.dist)) {
      const a = n.axis, u = UV[p.axis][0];
      const lo = a === p.axis ? p.dist : a === u ? p.u0 : p.v0;
      n = lo >= n.dist ? n.front : n.back;
    }
    p.node = n;
  }
  return mergePieces(pieces);
}

// Joins pieces on the same node, side and texture that share a whole edge.
function mergePieces(pieces) {
  const groups = new Map();
  for (const p of pieces) {
    const key = p.node;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const list of groups.values()) {
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < list.length && !merged; i++) {
        for (let j = i + 1; j < list.length && !merged; j++) {
          const p = list[i], q = list[j];
          if (p.side !== q.side || p.tex !== q.tex || p.axis !== q.axis) continue;
          if (p.v0 === q.v0 && p.v1 === q.v1 && (p.u1 === q.u0 || q.u1 === p.u0)) {
            p.u0 = Math.min(p.u0, q.u0);
            p.u1 = Math.max(p.u1, q.u1);
          } else if (p.u0 === q.u0 && p.u1 === q.u1 && (p.v1 === q.v0 || q.v1 === p.v0)) {
            p.v0 = Math.min(p.v0, q.v0);
            p.v1 = Math.max(p.v1, q.v1);
          } else continue;
          list.splice(j, 1);
          merged = true;
        }
      }
    }
    out.push(...list);
  }
  return out;
}

// --- Lighting ------------------------------------------------------------------------------

const SUN = normalize([-0.42, 0.3, 0.86]); // toward the sun
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

function normalize(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}

// Boxes that cast no shadows: triggers, volumes, ladders (and glass, the sky: see below).
const SHADOWLESS = new Set(['func_buyzone', 'func_bomb_target', 'func_ladder', 'func_water', 'func_hostage_rescue',
  'func_illusionary']);

// --- Writing the BSP ----------------------------------------------------------------------

// Texture axes by face orientation (GoldSrc's): floors s = x, t = -y; walls s along, t = -z.
const TEX_AXES = [[[0, 1, 0], [0, 0, -1]], [[1, 0, 0], [0, 0, -1]], [[1, 0, 0], [0, -1, 0]]];

// models: [{ brushes, origin, contents? }] (model 0 the world), ents: entity key objects
// (brush entities name their model as "*n"). Returns { bytes: Uint8Array, stats }.
export function compileBSP(TEX, models, ents, { light = 'full' } = {}) {
  const planes = [], planeOf = new Map();
  function plane(axis, dist) {
    const key = `${axis}:${dist}`;
    if (!planeOf.has(key)) {
      planeOf.set(key, planes.length);
      planes.push([axis, dist]);
    }
    return planeOf.get(key);
  }

  // Boxes that cast shadows (world coordinates): solid brushes but the sky, glass, water,
  // triggers and ladders.
  const occluders = [];
  models.forEach((m, i) => {
    const e = i === 0 ? ents[0] : ents.find((x) => x.model === `*${i}`);
    if (SHADOWLESS.has(e.classname) || (e.classname === 'func_breakable' && e.material === '0')) return;
    for (const br of m.brushes) if (!br.sky) occluders.push(br.b);
  });

  // Does the ray from p along d (unit) hit a box within `far`?
  function blocked(p, d, far = 8192) {
    for (const b of occluders) {
      let t0 = 0, t1 = far;
      for (let k = 0; k < 3 && t0 <= t1; k++) {
        if (Math.abs(d[k]) < 1e-9) {
          if (p[k] < b[k] || p[k] > b[k + 3]) t0 = Infinity;
          continue;
        }
        let ta = (b[k] - p[k]) / d[k], tb = (b[k + 3] - p[k]) / d[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 <= t1) return true;
    }
    return false;
  }

  // Light (0..255 rgb) at point p on a face with normal n.
  function lightAt(p, n) {
    const q = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
    const ndl = n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2];
    let sun, sky = 0;
    if (light === 'draft') {
      sun = Math.max(0, ndl);
      sky = (1 + n[2]) / 2;
    } else {
      sun = ndl > 0 && !blocked(q, SUN) ? ndl : 0;
      for (const d of SKY_DIRS) {
        const k = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
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
  function vertex(x, y, z) {
    const key = `${x},${y},${z}`;
    if (!vertexOf.has(key)) {
      vertexOf.set(key, vertices.length);
      vertices.push([x, y, z]);
    }
    return vertexOf.get(key);
  }
  const edges = [[0, 0]]; // edge 0 is never used (its sign could not be told)
  const surfedges = [], faces = [], nodes = [], leaves = [], clipnodes = [], modelRecs = [];
  const lighting = [];
  leaves.push({ contents: CONTENTS_SOLID, cell: [0, 0, 0, 0, 0, 0] }); // leaf 0: every solid point

  // A face record from a piece (model-space rectangle; `o` is the model's origin, for light).
  function addFace(p, o) {
    const [u, v] = UV[p.axis];
    const corner = (cu, cv) => {
      const c = [0, 0, 0];
      c[p.axis] = p.dist;
      c[u] = cu;
      c[v] = cv;
      return vertex(...c);
    };
    // Clockwise seen from the front: from +axis that is u0v0, u0v1, u1v1, u1v0.
    const ring = p.side === 0
      ? [corner(p.u0, p.v0), corner(p.u0, p.v1), corner(p.u1, p.v1), corner(p.u1, p.v0)]
      : [corner(p.u0, p.v0), corner(p.u1, p.v0), corner(p.u1, p.v1), corner(p.u0, p.v1)];
    const firstedge = surfedges.length;
    for (let i = 0; i < 4; i++) {
      surfedges.push(edges.length);
      edges.push([ring[i], ring[(i + 1) % 4]]);
    }
    const ti = texinfo(p.tex, p.axis), info = texinfos[ti];
    let lightofs = -1;
    if (!info.flags) lightofs = bakeLightmap(p, info, o);
    faces.push({ plane: plane(p.axis, p.dist), side: p.side, firstedge, numedges: 4, texinfo: ti, lightofs });
  }

  // The face's lightmap: one texel per 16 texture units over its extents (as the engine
  // reads them), each lit at the nearest point of the face.
  function bakeLightmap(p, info, o) {
    const [u, v] = UV[p.axis];
    let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
    for (const [cu, cv] of [[p.u0, p.v0], [p.u1, p.v0], [p.u0, p.v1], [p.u1, p.v1]]) {
      const c = [0, 0, 0];
      c[p.axis] = p.dist;
      c[u] = cu;
      c[v] = cv;
      const s = c[0] * info.s[0] + c[1] * info.s[1] + c[2] * info.s[2];
      const t = c[0] * info.t[0] + c[1] * info.t[1] + c[2] * info.t[2];
      smin = Math.min(smin, s);
      smax = Math.max(smax, s);
      tmin = Math.min(tmin, t);
      tmax = Math.max(tmax, t);
    }
    const minS = Math.floor(smin / 16), minT = Math.floor(tmin / 16);
    const w = Math.ceil(smax / 16) - minS + 1, h = Math.ceil(tmax / 16) - minT + 1;
    const ofs = lighting.length;
    const n = [0, 0, 0];
    n[p.axis] = p.side ? -1 : 1;
    const sAxis = info.s.findIndex((x) => x !== 0), tAxis = info.t.findIndex((x) => x !== 0);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const pt = [0, 0, 0];
        pt[p.axis] = p.dist;
        pt[sAxis] = (minS + i) * 16 * info.s[sAxis];
        pt[tAxis] = (minT + j) * 16 * info.t[tAxis];
        // Into the face (never sample inside the wall beside it).
        pt[u] = Math.min(p.u1 - 0.5, Math.max(p.u0 + 0.5, pt[u]));
        pt[v] = Math.min(p.v1 - 0.5, Math.max(p.v0 + 0.5, pt[v]));
        lighting.push(...lightAt([pt[0] + o[0], pt[1] + o[1], pt[2] + o[2]], n));
      }
    }
    return ofs;
  }

  // Hull 0 tree -> nodes (with their faces) and leaves; returns the head node index.
  function emitNodes(tree, facesByNode) {
    const emit = (n) => {
      if (n.axis === undefined) {
        if (n.contents === CONTENTS_SOLID) return -1; // leaf 0
        leaves.push({ contents: n.contents, cell: n.cell });
        return -leaves.length;
      }
      const i = nodes.length;
      const rec = { plane: plane(n.axis, n.dist), cell: n.cell, firstface: faces.length, numfaces: 0 };
      nodes.push(rec);
      for (const p of facesByNode.get(n) || []) addFace(p, facesByNode.origin);
      rec.numfaces = faces.length - rec.firstface;
      rec.front = emit(n.front);
      rec.back = emit(n.back);
      return i;
    };
    return emit(tree);
  }

  function emitClipnodes(tree) {
    const emit = (n) => {
      if (n.axis === undefined) return n.contents;
      const i = clipnodes.length, rec = { plane: plane(n.axis, n.dist) };
      clipnodes.push(rec);
      rec.front = emit(n.front);
      rec.back = emit(n.back);
      return i;
    };
    return emit(tree);
  }

  models.forEach((model, mi) => {
    if (!model.brushes.length) throw new Error(mi ? `entity model *${mi} has no boxes` : 'the map has no boxes');
    const isWorld = mi === 0;
    const heads = [];
    const firstface = faces.length;
    for (let h = 0; h < 4; h++) {
      const boxes = hullBoxes(model, h);
      const tree = buildTree(boxes, rootCell(boxes, isWorld));
      if (h === 0) {
        const byNode = new Map();
        for (const p of modelFaces(model, tree)) {
          if (!byNode.has(p.node)) byNode.set(p.node, []);
          byNode.get(p.node).push(p);
        }
        byNode.origin = model.origin;
        heads.push(emitNodes(tree, byNode));
      } else heads.push(emitClipnodes(tree));
    }
    const b = rootCell(hullBoxes(model, 0), true);
    modelRecs.push({ mins: b.slice(0, 3), maxs: b.slice(3), heads, firstface, numfaces: faces.length - firstface });
  });

  if (vertices.length > 65535 || nodes.length > 32767 || clipnodes.length > 32767 || leaves.length > 32767 ||
    faces.length > 65535) {
    throw new Error('the map is too big for BSP 30');
  }

  const entText = ents.map((e) => `{\n${Object.entries(e).map(([k, v]) => `"${k}" "${v}"`).join('\n')}\n}\n`).join('') +
    '\0';
  const lumps = [];
  const buf = (n) => new DataView(new ArrayBuffer(n));
  // 0 entities
  lumps[0] = new TextEncoder().encode(entText);
  // 1 planes: normal, dist, type (axial)
  let d = buf(planes.length * 20);
  planes.forEach(([a, dist], i) => {
    d.setFloat32(i * 20 + a * 4, 1, true);
    d.setFloat32(i * 20 + 12, dist, true);
    d.setInt32(i * 20 + 16, a, true);
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
  const i16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x)));
  d = buf(nodes.length * 24);
  nodes.forEach((n, i) => {
    const o = i * 24;
    d.setInt32(o, n.plane, true);
    d.setInt16(o + 4, n.front, true);
    d.setInt16(o + 6, n.back, true);
    for (let k = 0; k < 6; k++) d.setInt16(o + 8 + k * 2, i16(n.cell[k]), true);
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
    for (let k = 0; k < 6; k++) d.setInt16(i * 28 + 8 + k * 2, i16(l.cell[k]), true);
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
