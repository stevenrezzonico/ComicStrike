// Visibility for the maps our compiler writes (shared/bspwriter.js): GoldSrc's PVS, which
// leaves may be seen from which, as Quake's vis works it out. To keep it small the portals
// and their flow are worked on a coarse tree of the world's large opaque brushes only
// (walls, slabs, the sky shell: `structural`), like Quake 2's detail brushes: furniture
// splits the real tree into thousands of leaves, but taking occluders away only ever lets
// more be seen, so the result stays conservative. Each real leaf then sees the real leaves
// overlapping any coarse leaf the coarse leaves it overlaps can see.
//  * portals: the cell polygons of two empty coarse leaves on the same node's plane,
//    intersected (each cell polygon remembers the node whose cut made it);
//  * mightsee (qvis BasePortalVis): what a flood through the portals in front of a portal
//    (and with it behind them) reaches;
//  * the flow (qvis RecursiveLeafFlow): through chains of portals, each next one cut down to
//    what can be seen through the ones before (ClipToSeperators: the planes through an edge
//    of one and a corner of the other that keep the two apart); portals with the fewest
//    leaves in reach first, given up for their mightsee once the flow has taken `budget`
//    steps (a count, not a time: the same map gives the same bytes on any machine).
// Returns the visibility lump and each real leaf's offset into it (-1: none).

const EPS = 0.01;
const MAX_DEPTH = 16; // portals in a chain before the rest in reach counts as seen

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The part of a convex polygon in front of plane (n, d) (n·p >= d), or null.
function chop(w, n, d) {
  let front = false, back = false;
  const ds = w.map((p) => {
    const x = dot(n, p) - d;
    if (x > EPS) front = true;
    else if (x < -EPS) back = true;
    return x;
  });
  if (!front) return null;
  if (!back) return w;
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = w[(i + 1) % w.length], da = ds[i], db = ds[(i + 1) % w.length];
    if (da >= -EPS) out.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out.length >= 3 ? out : null;
}

function areaOf(w) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i + 1 < w.length; i++) {
    const c = cross(sub(w[i], w[0]), sub(w[i + 1], w[0]));
    x += c[0];
    y += c[1];
    z += c[2];
  }
  return Math.hypot(x, y, z) / 2;
}

// The overlap of convex polygons a and b lying on one plane (normal n), or null.
function overlap(a, b, n) {
  let w = a;
  const c = b.reduce((s, p) => [s[0] + p[0] / b.length, s[1] + p[1] / b.length, s[2] + p[2] / b.length], [0, 0, 0]);
  for (let i = 0; i < b.length && w; i++) {
    let en = cross(n, sub(b[(i + 1) % b.length], b[i]));
    const len = Math.hypot(en[0], en[1], en[2]);
    if (len < 1e-6) continue;
    en = [en[0] / len, en[1] / len, en[2] / len];
    let ed = dot(en, b[i]);
    if (dot(en, c) < ed) { // the edge plane faces into b
      en = [-en[0], -en[1], -en[2]];
      ed = -ed;
    }
    w = chop(w, en, ed);
  }
  return w && areaOf(w) > 1 ? w : null;
}

export const boxOf = (points) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) (b[k] = Math.min(b[k], p[k])), (b[k + 3] = Math.max(b[k + 3], p[k]));
  return b;
};
const boxesMeet = (a, b) => a[0] <= b[3] + EPS && b[0] <= a[3] + EPS && a[1] <= b[4] + EPS && b[1] <= a[4] + EPS &&
  a[2] <= b[5] + EPS && b[2] <= a[5] + EPS;

// The flow works on flat windings (x, y, z per corner) in buffers made once per chain
// depth: allocating on every step made it several times slower.
const MAXP = 128;
const dists = new Float64Array(MAXP);

// The part of flat winding w (n corners) in front of plane (nx, ny, nz, d) into `out`;
// returns its corners (0: none).
function chopInto(w, n, nx, ny, nz, d, out) {
  let front = false, back = false;
  for (let i = 0; i < n; i++) {
    const x = nx * w[i * 3] + ny * w[i * 3 + 1] + nz * w[i * 3 + 2] - d;
    dists[i] = x;
    if (x > EPS) front = true;
    else if (x < -EPS) back = true;
  }
  if (!front) return 0;
  if (!back) {
    for (let i = 0; i < n * 3; i++) out[i] = w[i];
    return n;
  }
  let k = 0;
  for (let i = 0; i < n && k < MAXP - 1; i++) {
    const j = i + 1 === n ? 0 : i + 1, da = dists[i], db = dists[j];
    if (da >= -EPS) {
      out[k * 3] = w[i * 3];
      out[k * 3 + 1] = w[i * 3 + 1];
      out[k * 3 + 2] = w[i * 3 + 2];
      k++;
    }
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out[k * 3] = w[i * 3] + (w[j * 3] - w[i * 3]) * t;
      out[k * 3 + 1] = w[i * 3 + 1] + (w[j * 3 + 1] - w[i * 3 + 1]) * t;
      out[k * 3 + 2] = w[i * 3 + 2] + (w[j * 3 + 2] - w[i * 3 + 2]) * t;
      k++;
    }
  }
  return k >= 3 ? k : 0;
}

// Qvis's ClipToSeperators: target T (nt corners) cut by every plane through an edge of
// source S and a corner of pass P that has the two on opposite sides, kept on P's side
// (flip: the other side), ping-ponging between buffers A and B (never written: T). The
// result in sepW / sepN (0: nothing left).
let sepW = null, sepN = 0;
function clipSeparators(S, ns, P, np, T, nt, flip, A, B) {
  let cur = T, cn = nt, dst = cur === A ? B : A;
  for (let i = 0; i < ns; i++) {
    const l = i + 1 === ns ? 0 : i + 1;
    const x1 = S[i * 3], y1 = S[i * 3 + 1], z1 = S[i * 3 + 2];
    const ex = S[l * 3] - x1, ey = S[l * 3 + 1] - y1, ez = S[l * 3 + 2] - z1;
    for (let j = 0; j < np; j++) {
      const px = P[j * 3] - x1, py = P[j * 3 + 1] - y1, pz = P[j * 3 + 2] - z1;
      let nx = ey * pz - ez * py, ny = ez * px - ex * pz, nz = ex * py - ey * px;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 0.01) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      let d = nx * P[j * 3] + ny * P[j * 3 + 1] + nz * P[j * 3 + 2];
      // Which side has the source portal?
      let side = 0;
      for (let k = 0; k < ns; k++) {
        if (k === i || k === l) continue;
        const x = nx * S[k * 3] + ny * S[k * 3 + 1] + nz * S[k * 3 + 2] - d;
        if (x < -EPS) {
          side = -1;
          break;
        }
        if (x > EPS) {
          side = 1;
          break;
        }
      }
      if (!side) continue; // in the plane of the source portal
      if (side > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
        d = -d;
      }
      // A separator has every corner of the pass portal on its front.
      let front = 0, ok = true;
      for (let k = 0; k < np; k++) {
        if (k === j) continue;
        const x = nx * P[k * 3] + ny * P[k * 3 + 1] + nz * P[k * 3 + 2] - d;
        if (x < -EPS) {
          ok = false;
          break;
        }
        if (x > EPS) front++;
      }
      if (!ok || !front) continue;
      if (flip) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
        d = -d;
      }
      cn = chopInto(cur, cn, nx, ny, nz, d, dst);
      if (!cn) {
        sepN = 0;
        return;
      }
      cur = dst;
      dst = cur === A ? B : A;
    }
  }
  sepW = cur;
  sepN = cn;
}

// tree: the coarse hull 0 tree (nodes { n, d, front, back }, empty leaves with their cell:
// polygons tagged with the node that cut them); leaves: the real world leaves, index 1..
// (0 unused), each { bounds, see } (see: may be seen into: empty or seen-through); budget:
// flow steps (portals stepped through) before the rest keep their mightsee.
export function computeVis(tree, leaves, budget) {
  const t0 = performance.now();
  // Empty coarse leaves.
  const cells = [];
  (function walk(n) {
    if (n.n === undefined) {
      if (n.cell) {
        n.id = cells.length;
        cells.push(n);
      }
      return;
    }
    walk(n.front);
    walk(n.back);
  })(tree);
  const L = cells.length, words = (L + 31) >> 5;

  // Portals: per node, the cell polygons on its plane from either side, intersected.
  const byTag = new Map();
  for (const c of cells) {
    const verts = c.cell.verts;
    const center = [0, 1, 2].map((k) => verts.reduce((s, p) => s + p[k], 0) / verts.length);
    for (const poly of c.cell.polys) {
      if (!poly.tag) continue; // the root box
      if (!byTag.has(poly.tag)) byTag.set(poly.tag, []);
      byTag.get(poly.tag).push({ c, poly, front: dot(poly.tag.n, center) > poly.tag.d, box: boxOf(poly) });
    }
  }
  const portals = []; // oriented: from leaf `from` into leaf `to`, plane normal into `to`
  const out = cells.map(() => []);
  for (const [tag, list] of byTag) {
    for (const b of list) {
      if (b.front) continue;
      for (const f of list) {
        if (!f.front || !boxesMeet(b.box, f.box)) continue;
        const w = overlap(b.poly, f.poly, tag.n);
        if (!w) continue;
        const ab = { from: b.c.id, to: f.c.id, w, n: tag.n, d: tag.d };
        const ba = { from: f.c.id, to: b.c.id, w, n: [-tag.n[0], -tag.n[1], -tag.n[2]], d: -tag.d };
        out[ab.from].push(portals.length);
        portals.push(ab);
        out[ba.from].push(portals.length);
        portals.push(ba);
      }
    }
  }

  // Mightsee: a flood from where each portal leads through the portals in front of it
  // (their corners' boxes first: most pairs are settled by them).
  const P = portals.length;
  for (const p of portals) {
    p.box = boxOf(p.w);
    p.wf = Float64Array.from(p.w.flat());
    p.wn = p.w.length;
  }
  // The box's corners furthest along and against plane (n, d): [most, least].
  const reach = (b, n, d) => {
    const hi = n[0] * (n[0] >= 0 ? b[3] : b[0]) + n[1] * (n[1] >= 0 ? b[4] : b[1]) + n[2] * (n[2] >= 0 ? b[5] : b[2]) - d;
    const lo = n[0] * (n[0] >= 0 ? b[0] : b[3]) + n[1] * (n[1] >= 0 ? b[1] : b[4]) + n[2] * (n[2] >= 0 ? b[2] : b[5]) - d;
    return [hi, lo];
  };
  // Whether tp might be seen through p: some corner of tp in front of p, some corner of p
  // behind tp. Asked only of the portals the flood reaches.
  const ahead = (p, tp) => {
    if (tp === p || tp.to === p.from) return false;
    const [hi, lo] = reach(tp.box, p.n, p.d);
    if (hi <= EPS || (lo <= EPS && !tp.w.some((v) => dot(p.n, v) - p.d > EPS))) return false;
    const [hi2, lo2] = reach(p.box, tp.n, tp.d);
    return !(lo2 >= -EPS || (hi2 >= -EPS && !p.w.some((v) => dot(tp.n, v) - tp.d < -EPS)));
  };
  for (const p of portals) {
    const m = new Uint32Array(words), stack = [p.to];
    m[p.to >> 5] |= 1 << (p.to & 31);
    while (stack.length) {
      const leaf = stack.pop();
      for (const q of out[leaf]) {
        const to = portals[q].to;
        if (m[to >> 5] & (1 << (to & 31)) || !ahead(p, portals[q])) continue;
        m[to >> 5] |= 1 << (to & 31);
        stack.push(to);
      }
    }
    p.mightsee = m;
    let count = 0;
    for (let k = 0; k < words; k++) for (let x = m[k]; x; x &= x - 1) count++;
    p.count = count;
  }

  const mightMs = Math.round(performance.now() - t0);
  // The flow, cheapest first; past the budget a portal keeps its mightsee. A chain deeper
  // than MAX_DEPTH portals counts everything still in reach as seen (the far end of long
  // chains through open space is where the time went; most is hidden within a few).
  const order = portals.map((_, i) => i).sort((a, b) => portals[a].count - portals[b].count);
  const levels = [];
  const level = (k) => levels[k] ||= {
    src: new Float64Array(MAXP * 3), pass: new Float64Array(MAXP * 3), a: new Float64Array(MAXP * 3),
    b: new Float64Array(MAXP * 3), might: new Uint32Array(words),
  };
  let flowed = 0, steps = 0, base = null, vis = null;
  const flow = (leaf, depth, srcW, srcN, passW, passN, might) => {
    steps++;
    vis[leaf >> 5] |= 1 << (leaf & 31);
    if (depth >= MAX_DEPTH) {
      for (let k = 0; k < words; k++) vis[k] |= might[k];
      return;
    }
    const lv = level(depth), next = lv.might;
    for (const qi of out[leaf]) {
      const q = portals[qi];
      if (!(might[q.to >> 5] & (1 << (q.to & 31)))) continue;
      const test = q.vis || q.mightsee;
      let more = false;
      for (let k = 0; k < words; k++) {
        next[k] = might[k] & test[k];
        if (next[k] & ~vis[k]) more = true;
      }
      if (!more && vis[q.to >> 5] & (1 << (q.to & 31))) continue;
      let pn = chopInto(q.wf, q.wn, base.n[0], base.n[1], base.n[2], base.d, lv.pass); // beyond the base portal
      if (!pn) continue;
      const sn = chopInto(srcW, srcN, -q.n[0], -q.n[1], -q.n[2], -q.d, lv.src); // the source behind this one
      if (!sn) continue;
      let pw = lv.pass;
      if (passW) {
        clipSeparators(lv.src, sn, passW, passN, pw, pn, false, lv.a, lv.b);
        if (!sepN) continue;
        clipSeparators(passW, passN, lv.src, sn, sepW, sepN, true, lv.a, lv.b);
        if (!sepN) continue;
        pw = sepW;
        pn = sepN;
      }
      flow(q.to, depth + 1, lv.src, sn, pw, pn, next);
    }
  };
  for (const i of order) {
    const p = portals[i];
    if (steps > budget) {
      p.vis = p.mightsee;
      continue;
    }
    base = p;
    vis = new Uint32Array(words);
    flow(p.to, 0, p.wf, p.wn, null, 0, p.mightsee);
    p.vis = vis;
    flowed++;
  }

  // Coarse PVS rows: the leaf, and what its portals see.
  const pvs = cells.map((c) => {
    const r = new Uint32Array(words);
    r[c.id >> 5] |= 1 << (c.id & 31);
    for (const qi of out[c.id]) {
      const v = portals[qi].vis;
      for (let k = 0; k < words; k++) r[k] |= v[k];
    }
    return r;
  });

  // Real leaves onto coarse ones: the empty coarse leaves their bounds reach into.
  const n = leaves.length - 1, rowBytes = (n + 7) >> 3;
  const coarseOf = new Array(leaves.length), realIn = cells.map(() => []);
  for (let r = 1; r <= n; r++) {
    if (!leaves[r].see) continue;
    const b = leaves[r].bounds, set = [];
    (function walk(node) {
      if (node.n === undefined) {
        if (node.cell) set.push(node.id);
        return;
      }
      const nn = node.n;
      const hi = nn[0] * (nn[0] >= 0 ? b[3] : b[0]) + nn[1] * (nn[1] >= 0 ? b[4] : b[1]) + nn[2] * (nn[2] >= 0 ? b[5] : b[2]);
      const lo = nn[0] * (nn[0] >= 0 ? b[0] : b[3]) + nn[1] * (nn[1] >= 0 ? b[1] : b[4]) + nn[2] * (nn[2] >= 0 ? b[2] : b[5]);
      if (hi > node.d + EPS) walk(node.front);
      if (lo < node.d - EPS) walk(node.back);
    })(tree);
    if (!set.length) for (let k = 0; k < L; k++) set.push(k); // lost between the trees: sees all
    coarseOf[r] = set;
    for (const k of set) realIn[k].push(r);
  }

  // Rows, one per distinct set of coarse leaves, compressed (a zero byte, then how many).
  const chunks = [], offsets = new Int32Array(leaves.length).fill(-1), cache = new Map();
  let size = 0;
  for (let r = 1; r <= n; r++) {
    const set = coarseOf[r];
    if (!set) continue;
    const key = set.join(',');
    if (cache.has(key)) {
      offsets[r] = cache.get(key);
      continue;
    }
    const seen = new Uint32Array(words);
    for (const k of set) for (let w = 0; w < words; w++) seen[w] |= pvs[k][w];
    const row = new Uint8Array(rowBytes);
    for (let k = 0; k < L; k++) {
      if (!(seen[k >> 5] & (1 << (k & 31)))) continue;
      for (const q of realIn[k]) row[(q - 1) >> 3] |= 1 << ((q - 1) & 7);
    }
    const bytes = [];
    for (let i = 0; i < rowBytes;) {
      if (row[i]) {
        bytes.push(row[i++]);
        continue;
      }
      let z = 0;
      while (i < rowBytes && !row[i] && z < 255) (i++), z++;
      bytes.push(0, z);
    }
    cache.set(key, size);
    offsets[r] = size;
    chunks.push(bytes);
    size += bytes.length;
  }
  const lump = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    lump.set(c, at);
    at += c.length;
  }
  return { lump, offsets, stats: { coarse: L, portals: P / 2, flowed, steps, mightMs, ms: Math.round(performance.now() - t0) } };
}
