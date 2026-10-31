// A .bsp (version 30) opened in the map editor: the map turned back into a project.
// GoldSrc keeps no brushes in a compiled map, only its BSP trees, but every path down a
// model's hull 0 tree that ends in a solid leaf is a convex cell bounded by the node planes
// along it. So each model's tree is walked with a convex cell, split at every node, and the
// solid (and sky and water) cells become shapes: a box where the cell is an axis-aligned
// box with the same texture round its sides, else a convex piece (project.js 'convex').
// A cell's side lying on a node takes the texture of that node's face under the side's
// middle; sides with no face (inside solid, toward the void) get none. Brush entities the
// editor knows keep their kind and keys (zones become one box each), func_wall becomes
// solid; spawns and hostages become points, point bomb targets and rescue spots zones.
// Everything else is left out and counted. Pure (no DOM): the compile worker runs it.

import { mapNameOf, faceFirstEdge, faceNumEdges, faceTexinfo, faceSide } from '../../shared/bsp.js';
import { planeSquare, clip } from '../../shared/bspwriter.js';
import { FORMAT, VERSION, TEXTURES, KINDS, makeBrush } from './project.js';

const EPS = 0.01;
const CONTENTS_EMPTY = -1, CONTENTS_SOLID = -2, CONTENTS_WATER = -3, CONTENTS_LAVA = -5, CONTENTS_SKY = -6;
const PALETTE = new Set(TEXTURES.map(([n]) => n));
const AS_WORLD = new Set(['func_wall', 'func_wall_toggle']);
const SPAWNS = new Set(['info_player_deathmatch', 'info_player_start']);
const DROP_KEYS = new Set(['classname', 'model', 'origin']);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The project made from parsed (and checked: parseUntrustedBSP) map `bsp` from file `fileName`:
// { project, report: { shapes, boxes, points, dropped: { classname: count } } }.
export function decompileBSP(bsp, fileName) {
  const p = { format: FORMAT, version: VERSION, name: mapNameOf(fileName), brushes: [], points: [], textures: {}, nextId: 1 };
  const report = { shapes: 0, boxes: 0, points: 0, dropped: {} };
  const drop = (cls) => (report.dropped[cls] = (report.dropped[cls] || 0) + 1);
  const faceLoops = new Map(); // face -> its corners

  // --- Cells ---------------------------------------------------------------------------

  // The solid cells of model m's tree: [{ faces: [{ n, d, poly, tex }], contents }], in
  // world coordinates (moved by `origin`, a rotating door's).
  function cells(m, root, origin, keep) {
    const out = [];
    const start = [];
    for (let k = 0; k < 3; k++) {
      for (const s of [1, -1]) {
        const n = [0, 0, 0];
        n[k] = s;
        start.push({ n, d: s > 0 ? root[k + 3] : -root[k], node: -1, side: 0 });
      }
    }
    for (const f of start) f.poly = loop(f, start);
    walk(bsp.modelsI[m * 16 + 9], start.filter((f) => f.poly.length));

    function walk(node, faces) {
      if (node < 0) {
        const contents = bsp.leavesI32[(-node - 1) * 7];
        if (keep(contents)) out.push(cellOf(faces, contents));
        return;
      }
      const pl = bsp.nodesI32[node * 6];
      const N = [bsp.planesF[pl * 5], bsp.planesF[pl * 5 + 1], bsp.planesF[pl * 5 + 2]], D = bsp.planesF[pl * 5 + 3];
      let front = false, back = false;
      for (const f of faces) {
        for (const v of f.poly) {
          const x = dot(N, v) - D;
          if (x > EPS) front = true;
          else if (x < -EPS) back = true;
        }
      }
      const kids = [bsp.nodesI16[node * 12 + 2], bsp.nodesI16[node * 12 + 3]];
      if (!back) return walk(kids[0], faces);
      if (!front) return walk(kids[1], faces);
      // Front child: N·p >= D (its new side faces -N, a back face of the node); back child:
      // N·p <= D (its new side faces N, a front face).
      for (const [kid, s] of [[kids[0], -1], [kids[1], 1]]) {
        const cap = { n: [N[0] * s, N[1] * s, N[2] * s], d: D * s, node, side: s > 0 ? 0 : 1 };
        const next = [];
        for (const f of faces) {
          const poly = clip(f.poly, cap.n, cap.d);
          if (poly.length) next.push({ ...f, poly });
        }
        cap.poly = loop(cap, next);
        if (cap.poly.length) next.push(cap);
        if (next.length >= 4) walk(kid, next);
      }
    }

    function cellOf(faces, contents) {
      const sky = contents === CONTENTS_SKY;
      return {
        contents,
        faces: faces.map((f) => ({
          n: f.n, d: f.d + dot(f.n, origin), poly: f.poly.map((v) => [v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]]),
          tex: sky ? 'sky' : textureOf(f),
        })),
      };
    }
    return out;
  }

  // Neighboring cells joined wherever the two make one convex shape (the tree cuts a wall
  // into slices along planes from all over the map; joined, it is a shape or two again, and
  // the map compiles back far smaller). A and B, on either side of a plane they both have,
  // make a convex union exactly when every vertex of each lies behind every other plane of
  // the other (that intersection is then A on one side and B on the other). Faces on one
  // plane must not disagree on their texture.
  function join(list) {
    const key = (n, d) => `${n.map((x) => Math.round(x * 1e4)).join()}:${Math.round(d * 100)}`;
    const keyed = (c) => { // each face's plane key (k) and its opposite's (o), the corners
      for (const f of c.faces) {
        f.k = key(f.n, f.d);
        f.o = key(f.n.map((x) => -x), -f.d);
      }
      c.verts = c.faces.flatMap((f) => f.poly);
      return c;
    };
    const behind = (vs, f) => vs.every((v) => dot(f.n, v) <= f.d + 0.05);
    function union(a, b, k) {
      const pa = a.faces.filter((f) => f.k !== k), pb = b.faces.filter((f) => f.o !== k);
      if (!pa.every((f) => behind(b.verts, f)) || !pb.every((f) => behind(a.verts, f))) return null;
      const faces = [], at = new Map();
      for (const f of [...pa, ...pb]) {
        const g = at.get(f.k);
        if (g === undefined) {
          at.set(f.k, faces.length);
          faces.push({ n: f.n, d: f.d, tex: f.tex });
        } else if (f.tex && faces[g].tex && f.tex !== faces[g].tex) return null;
        else faces[g].tex = faces[g].tex || f.tex;
      }
      for (const f of faces) f.poly = loop(f, faces);
      return keyed({ contents: a.contents, faces: faces.filter((f) => f.poly.length) });
    }
    list.forEach(keyed);
    let changed = true;
    while (changed) {
      changed = false;
      const byPlane = new Map();
      list.forEach((c, i) => {
        for (const f of c.faces) {
          if (!byPlane.has(f.k)) byPlane.set(f.k, []);
          byPlane.get(f.k).push(i);
        }
      });
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a) continue;
        search: for (const f of a.faces) {
          for (const j of byPlane.get(f.o) || []) {
            const b = list[j];
            if (j === i || !b || b.contents !== a.contents) continue;
            const u = union(a, b, f.k);
            if (!u) continue;
            list[i] = u;
            list[j] = null;
            changed = true;
            break search;
          }
        }
      }
      list = list.filter(Boolean);
    }
    return list;
  }

  // Face f's polygon: its plane's square clipped by the other faces.
  function loop(f, faces) {
    let poly = planeSquare(f.n, f.d);
    for (const g of faces) if (g !== f && poly.length) poly = clip(poly, g.n, g.d);
    return poly;
  }

  // The texture of the node face under a cell side's middle (else near one of its corners).
  function textureOf(f) {
    if (f.node < 0) return null;
    const first = bsp.nodesI16[f.node * 12 + 10] & 0xffff, count = bsp.nodesI16[f.node * 12 + 11] & 0xffff;
    if (!count) return null;
    const c = [0, 1, 2].map((k) => f.poly.reduce((s, v) => s + v[k], 0) / f.poly.length);
    const probes = [c, ...f.poly.map((v) => [0, 1, 2].map((k) => v[k] + (c[k] - v[k]) * 0.1))];
    for (const q of probes) {
      for (let i = first; i < first + count; i++) {
        if (faceSide(bsp, i) !== f.side || !inside(i, q, f.n)) continue;
        const name = bsp.textureNames[bsp.texinfoI[faceTexinfo(bsp, i) * 10 + 8]];
        return useTexture(name);
      }
    }
    return null;
  }

  // Is point q (on the face's plane) within face i's outline?
  function inside(i, q, n) {
    let pts = faceLoops.get(i);
    if (!pts) {
      pts = [];
      const first = faceFirstEdge(bsp, i);
      for (let k = 0; k < faceNumEdges(bsp, i); k++) {
        const se = bsp.surfedges[first + k];
        const v = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
        pts.push([bsp.vertices[v * 3], bsp.vertices[v * 3 + 1], bsp.vertices[v * 3 + 2]]);
      }
      faceLoops.set(i, pts);
    }
    let pos = false, neg = false;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length], e = sub(b, a);
      const s = dot(cross(e, sub(q, a)), n) / (Math.hypot(e[0], e[1], e[2]) || 1);
      if (s > 0.05) pos = true;
      else if (s < -0.05) neg = true;
      if (pos && neg) return false;
    }
    return true;
  }

  // A texture name the project can carry (null: none).
  function useTexture(name) {
    if (!name || !/^[\w!{}+~-]{1,15}$/.test(name)) return null;
    if (!PALETTE.has(name) && !p.textures[name]) {
      const t = bsp.textureNames.indexOf(name);
      p.textures[name] = [bsp.textureSize[t * 2] || 64, bsp.textureSize[t * 2 + 1] || 64];
    }
    return name;
  }

  // --- Shapes --------------------------------------------------------------------------

  // A cell as a project brush (null: too thin to keep).
  function shapeOf(cell, kind, keys) {
    const verts = cell.faces.flatMap((f) => f.poly);
    const lo = [0, 1, 2].map((k) => Math.min(...verts.map((v) => v[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...verts.map((v) => v[k])));
    if ([0, 1, 2].some((k) => hi[k] - lo[k] < 0.5)) return null;
    const axial = cell.faces.length === 6 && cell.faces.every((f) => Math.abs(f.n[0]) + Math.abs(f.n[1]) + Math.abs(f.n[2]) > 0.9999 &&
      Math.max(Math.abs(f.n[0]), Math.abs(f.n[1]), Math.abs(f.n[2])) > 0.9999);
    const round = axial && [...lo, ...hi].every((x) => Math.abs(x - Math.round(x)) < 0.01);
    const texAt = (test) => cell.faces.find((f) => test(f.n))?.tex ?? null;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => texAt((n) => n[0] * x + n[1] * y > 0.99));
    if (round && sides.every((t) => t === sides[0])) {
      report.boxes++;
      const tex = { top: texAt((n) => n[2] > 0.99), bottom: texAt((n) => n[2] < -0.99), side: sides[0] };
      return makeBrush(p.nextId++, [...lo, ...hi].map(Math.round), tex, kind, keys);
    }
    const b = [...lo.map(Math.floor), ...hi.map(Math.ceil)];
    const s = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
    const faces = cell.faces.map((f) => {
      // n·p <= d in the box's own coordinates (p = b0 + u s): (n s)·u <= d - n·b0
      const n = [f.n[0] * s[0], f.n[1] * s[1], f.n[2] * s[2]], l = Math.hypot(n[0], n[1], n[2]);
      const r = (x) => Math.round(x / l * 1e6) / 1e6;
      return [r(n[0]), r(n[1]), r(n[2]), r(f.d - dot(f.n, b)), f.tex];
    });
    // The palette slots show what most of each kind of face wears.
    const tex = { top: texAt((n) => n[2] > 0.7), bottom: texAt((n) => n[2] < -0.7), side: texAt((n) => Math.abs(n[2]) <= 0.7) };
    const br = makeBrush(p.nextId++, b, tex, kind, keys, { shape: 'convex' });
    br.faces = faces;
    return br;
  }

  const add = (br) => {
    if (!br) return;
    p.brushes.push(br);
    report.shapes++;
  };

  // --- The world ---------------------------------------------------------------------

  // Its starting cell: round the empty leaves (the void outside is solid in GoldSrc: start
  // from all of it and the map would be buried in blocks), 32 units out.
  const room = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  (function leaves(node) {
    if (node < 0) {
      const l = -node - 1, c = bsp.leavesI32[l * 7];
      if (c === CONTENTS_SOLID || c === CONTENTS_SKY) return;
      for (let k = 0; k < 3; k++) {
        room[k] = Math.min(room[k], bsp.leavesI16[l * 14 + 4 + k]);
        room[k + 3] = Math.max(room[k + 3], bsp.leavesI16[l * 14 + 7 + k]);
      }
      return;
    }
    leaves(bsp.nodesI16[node * 12 + 2]);
    leaves(bsp.nodesI16[node * 12 + 3]);
  })(bsp.modelsI[9]);
  const world = [0, 1, 2, 3, 4, 5].map((k) => bsp.modelsF[k]);
  const root = room[0] === Infinity ? world
    : room.map((v, k) => (k < 3 ? Math.max(world[k], v - 32) : Math.min(world[k], v + 32)));
  for (const cell of join(cells(0, root, [0, 0, 0], (c) => c === CONTENTS_SOLID || c === CONTENTS_SKY ||
    (c <= CONTENTS_WATER && c >= CONTENTS_LAVA)))) {
    if (cell.contents === CONTENTS_SOLID || cell.contents === CONTENTS_SKY) add(shapeOf(cell, 'world', {}));
    else add(shapeOf(cell, 'func_water', {}));
  }

  // --- Entities ----------------------------------------------------------------------

  const yawOf = (e) => {
    const a = e.angles ? +e.angles.split(' ')[1] : +e.angle;
    return Number.isFinite(a) && a >= 0 ? Math.round(a) % 360 : 0;
  };
  const vec = (s) => {
    const v = String(s || '').split(' ').map(Number);
    return v.length === 3 && v.every(Number.isFinite) ? v : null;
  };
  const zone = (kind, o, h, keys = {}) => add(makeBrush(p.nextId++,
    [o[0] - h, o[1] - h, o[2] - 128, o[0] + h, o[1] + h, o[2] + 128].map(Math.round), { top: null, bottom: null, side: null }, kind, keys));

  for (const e of bsp.entities) {
    const cls = e.classname;
    if (cls === 'worldspawn') continue;
    const o = vec(e.origin);
    if (SPAWNS.has(cls) || cls === 'hostage_entity') {
      if (!o) continue;
      // Spawn origins are hull centers (the feet 36 under them); hostages stand on theirs.
      p.points.push({ id: p.nextId++, kind: cls, o: [o[0], o[1], o[2] - (cls === 'hostage_entity' ? 0 : 36)].map(Math.round), yaw: yawOf(e) });
      report.points++;
      continue;
    }
    if (cls === 'info_bomb_target' && o) {
      zone('func_bomb_target', o, 128);
      continue;
    }
    if (cls === 'info_hostage_rescue' && o) {
      zone('func_hostage_rescue', o, 256);
      continue;
    }
    const m = /^\*(\d+)$/.exec(e.model || '') ? +e.model.slice(1) : -1;
    const kind = AS_WORLD.has(cls) ? 'world' : KINDS[cls] ? cls : null;
    if (m <= 0 || m >= bsp.numModels || !kind) {
      drop(cls || '(none)');
      continue;
    }
    const origin = o || [0, 0, 0];
    const mb = [0, 1, 2, 3, 4, 5].map((k) => bsp.modelsF[m * 16 + k]);
    const keys = {};
    if (kind !== 'world') {
      for (const [k, v] of Object.entries(e)) if (!DROP_KEYS.has(k) && /^\w{1,32}$/.test(k)) keys[k] = String(v).replace(/"/g, "'").slice(0, 128);
    }
    if (KINDS[kind].trigger) { // zones and volumes: one box round the model
      add(makeBrush(p.nextId++, [...mb.slice(0, 3).map((v, k) => Math.floor(v + origin[k])), ...mb.slice(3).map((v, k) => Math.ceil(v + origin[k]))],
        { top: null, bottom: null, side: null }, kind, keys));
      continue;
    }
    const root = [mb[0] - 1, mb[1] - 1, mb[2] - 1, mb[3] + 1, mb[4] + 1, mb[5] + 1];
    const list = join(cells(m, root, origin, (c) => c !== CONTENTS_EMPTY));
    if (kind === 'func_door_rotating') {
      // The hinge: the end of the door's long side nearer its origin.
      const w = [mb[3] - mb[0], mb[4] - mb[1]], ax = w[0] >= w[1] ? 0 : 1;
      keys.hinge = mb[ax] + mb[ax + 3] > 0 ? 'start' : 'end'; // model space: the origin is 0
    }
    for (const cell of list) add(shapeOf(cell, kind, { ...keys }));
  }
  return { project: p, report };
}
