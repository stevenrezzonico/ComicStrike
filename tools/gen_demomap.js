// Builds maps/de_playground.bsp, ComicStrike's own test map (the demo mode's playground):
// a walled courtyard under the sky with every kind of map element to try out: stairs,
// a ladder tower, breakable crates and glass, a conveyor belt, a metal yard, a shallow
// pool with a deeper end, sliding / swinging / button doors, two bomb sites and both
// spawns with buy zones.
//
// deno run --allow-write=maps tools/gen_demomap.js
//
// The map is written in the GoldSrc BSP 30 format the engine reads (shared/bsp.js), from
// axis-aligned boxes only, by a small compiler of our own:
//  * per model and hull, a k-d tree splits space on the boxes' faces until every cell is
//    inside a box (solid) or outside all of them (empty); hulls 1-3 use the boxes grown
//    by the player hulls (exact for boxes), so collision is GoldSrc's own;
//  * faces are the sides of empty cells that touch solid ones (each piece hung on the
//    node whose plane it lies on, as GoldSrc's light point lookup expects), merged back
//    into rectangles where they line up, wound clockwise seen from the front;
//  * lightmaps (16 units a texel) are baked here: a warm sun with shadows and a cool sky
//    seen from each texel (a dozen rays), traced against the boxes.
// Deterministic: the same file every run. Not used by the game at runtime.

const OUT = new URL('../maps/de_playground.bsp', import.meta.url);

// --- The map ---------------------------------------------------------------------------

// Textures: name -> [width, height] (the shaders scale their patterns by it).
const TEX = {
  sky: [256, 256],
  aaatrigger: [64, 64],
  '-0sand': [128, 128],
  sandroad: [128, 128],
  cssandwallbta: [128, 128],
  sandtrim: [128, 32],
  azwall_a: [128, 128],
  '!watergreen': [64, 64],
  mltrycrtesd: [64, 64],
  mltrycrtetp: [64, 64],
  bcrate02: [64, 64],
  crate08: [64, 64],
  glass_med: [64, 64],
  crete4_stp01: [64, 64],
  crete3_wall02: [128, 128],
  '{ladder1': [64, 64],
  duct_flr01: [64, 64],
  scroll_conv: [64, 64],
  metal_wall05b: [128, 128],
  steel: [64, 64],
  stripes2: [64, 64],
  sandwlldoor: [64, 128],
  fifties_dr2: [64, 128],
  out_w8dr1: [128, 128],
  lab1_comp3d: [32, 32],
};

// A box brush: [x0, y0, z0, x1, y1, z1] and its textures: one name, or per side
// { top, bottom, side } / { px, nx, py, ny, pz, nz } (null: no face there).
const SIDES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const NONE = { top: null, bottom: null, side: null }; // triggers and volumes: no faces
function box(x0, y0, z0, x1, y1, z1, tex, opts = {}) {
  const t = typeof tex === 'string' ? { top: tex, bottom: tex, side: tex } : tex;
  const per = SIDES.map((s, i) => (s in t ? t[s] : i === 4 ? t.top : i === 5 ? t.bottom : t.side) ?? null);
  return { b: [x0, y0, z0, x1, y1, z1], tex: per, sky: per.includes('sky'), ...opts };
}

const world = [];
const ents = [{ classname: 'worldspawn', wad: '', mapversion: '220', skyname: 'desert', message: 'de_playground' }];
const models = [{ brushes: world, origin: [0, 0, 0] }];

// A brush entity: its keys and boxes (in world coordinates; a hinge `origin` key makes the
// model relative to it, as GoldSrc's origin brushes do).
function brushEntity(keys, brushes, opts = {}) {
  const origin = keys.origin ? keys.origin.split(' ').map(Number) : [0, 0, 0];
  models.push({ brushes, origin, ...opts });
  ents.push({ ...keys, model: `*${models.length - 1}` });
}
const point = (keys) => ents.push(keys);

const X = 1600, Y = 1024, TOP = 640; // the courtyard's inside; walls 32 thick
const floorTex = { top: '-0sand', bottom: 'azwall_a', side: 'azwall_a' };
const wallTex = 'cssandwallbta';

// Floor (64 deep), cut open for the pool: shallow (14 deep) west, deeper (30) east.
const POOL = [-300, 300, 300, 700];
world.push(
  box(-X - 32, -Y - 32, -64, X + 32, POOL[2], 0, floorTex),
  box(-X - 32, POOL[3], -64, X + 32, Y + 32, 0, floorTex),
  box(-X - 32, POOL[2], -64, POOL[0], POOL[3], 0, floorTex),
  box(POOL[1], POOL[2], -64, X + 32, POOL[3], 0, floorTex),
  box(POOL[0], POOL[2], -64, 0, POOL[3], -16, floorTex),
  box(0, POOL[2], -64, POOL[1], POOL[3], -32, floorTex),
);
brushEntity({ classname: 'func_water', skin: '-3', WaveHeight: '0' }, [
  box(POOL[0], POOL[2], -32, POOL[1], POOL[3], -2, { top: '!watergreen', bottom: null, side: null }),
], { contents: -3 });
// A paved road from spawn to spawn.
world.push(box(-X, -140, 0, X, 140, 1, { top: 'sandroad', bottom: null, side: 'sandtrim' }));

// Outer walls up to the sky, the sky over everything.
world.push(
  box(-X - 32, -Y - 32, 0, -X, Y + 32, TOP, wallTex),
  box(X, -Y - 32, 0, X + 32, Y + 32, TOP, wallTex),
  box(-X, -Y - 32, 0, X, -Y, TOP, wallTex),
  box(-X, Y, 0, X, Y + 32, TOP, wallTex),
  box(-X - 32, -Y - 32, TOP, X + 32, Y + 32, TOP + 32, 'sky'),
);

// Spawn walls (x = -1100 and 1100, 32 thick) with a doorway on the road and a passage.
const DOOR_Y = [-140, 140], PASS_Y = [-720, -560];
for (const sx of [-1, 1]) {
  const x0 = sx < 0 ? -1100 : 1068, x1 = x0 + 32;
  world.push(
    box(x0, -Y, 0, x1, PASS_Y[0], 192, wallTex),
    box(x0, PASS_Y[1], 0, x1, DOOR_Y[0], 192, wallTex),
    box(x0, DOOR_Y[1], 0, x1, Y, 192, wallTex),
    box(x0, PASS_Y[0], 128, x1, PASS_Y[1], 192, wallTex),
    box(x0, DOOR_Y[0], 128, x1, DOOR_Y[1], 192, wallTex),
  );
}
// T side: a sliding door on the road (it rises when touched).
brushEntity({ classname: 'func_door', angle: '-1', speed: '160', wait: '3', lip: '8' },
  [box(-1092, DOOR_Y[0], 1, -1076, DOOR_Y[1], 128, 'sandwlldoor')]);
// CT side: a swinging door on the road, hinged on its south edge.
brushEntity({ classname: 'func_door_rotating', origin: `1084 ${DOOR_Y[0] + 4} 64`, distance: '90', speed: '120',
  wait: '3' }, [box(1078, DOOR_Y[0] + 4, 1, 1090, DOOR_Y[1] - 4, 127, 'fifties_dr2')]);
// CT side's passage: a garage door a button opens.
brushEntity({ classname: 'func_door', targetname: 'garage', angle: '-1', speed: '90', wait: '5', lip: '8' },
  [box(1072, PASS_Y[0], 1, 1096, PASS_Y[1], 128, 'out_w8dr1')]);
brushEntity({ classname: 'func_button', target: 'garage', angle: '180', speed: '40', wait: '1', lip: '2' },
  [box(1064, PASS_Y[1] + 24, 52, 1068, PASS_Y[1] + 40, 68, 'lab1_comp3d')]);

// Spawns (hull centers) and buy zones.
for (let k = 0; k < 5; k++) {
  const y = -256 + k * 128;
  point({ classname: 'info_player_deathmatch', origin: `-1400 ${y} 37`, angles: '0 0 0' });
  point({ classname: 'info_player_start', origin: `1400 ${y} 37`, angles: '0 180 0' });
}
brushEntity({ classname: 'func_buyzone', team: '1' }, [box(-X, -Y, 0, -1100, Y, 128, NONE)]);
brushEntity({ classname: 'func_buyzone', team: '2' }, [box(1100, -Y, 0, X, Y, 128, NONE)]);

// Bomb sites A (north-west) and B (north-east), with crates to plant behind.
brushEntity({ classname: 'func_bomb_target' }, [box(-1000, 480, 0, -560, 960, 128, NONE)]);
brushEntity({ classname: 'func_bomb_target' }, [box(560, 480, 0, 1000, 960, 128, NONE)]);
const crate = (x, y, z, s, tex = 'crate08') => box(x, y, z, x + s, y + s, z + s, tex);
world.push(
  crate(-900, 820, 0, 64), crate(-836, 820, 0, 64), crate(-900, 820, 64, 64), crate(-700, 560, 0, 96),
  crate(700, 820, 0, 64), crate(764, 820, 0, 64), crate(764, 820, 64, 64), crate(620, 560, 0, 96),
);

// Stairs: eight 16-unit steps up to a platform 128 high.
for (let k = 0; k < 8; k++) {
  world.push(box(-1000 + 32 * k, -960, 0, -720, -760, 16 * (k + 1),
    { top: 'crete4_stp01', bottom: null, side: k === 7 ? 'crete3_wall02' : 'crete4_stp01' }));
}
world.push(box(-720, -960, 0, -600, -760, 128, { top: 'crete4_stp01', bottom: null, side: 'crete3_wall02' }));

// Ladder tower: 320 high, the ladder up its north face.
world.push(box(-440, -960, 0, -312, -832, 320, 'crete3_wall02'));
world.push(box(-408, -832, 0, -344, -828, 320, { top: '{ladder1', bottom: null, side: '{ladder1', ny: null }));
brushEntity({ classname: 'func_ladder' }, [box(-408, -828, 0, -344, -812, 336, NONE)]);

// Breakables: wooden crates, a metal crate, a glass pane, one that never breaks.
const breakable = (keys, b) => brushEntity({ classname: 'func_breakable', ...keys }, [b]);
const woodCrate = { top: 'mltrycrtetp', bottom: 'mltrycrtetp', side: 'mltrycrtesd' };
breakable({ material: '1', health: '40' }, box(-240, -560, 0, -176, -496, 64, woodCrate));
breakable({ material: '1', health: '40' }, box(-240, -560, 64, -176, -496, 128, woodCrate));
breakable({ material: '1', health: '40' }, box(-160, -560, 0, -112, -512, 48, woodCrate));
breakable({ material: '2', health: '250' }, box(-60, -560, 0, 4, -496, 64, 'bcrate02'));
breakable({ material: '0', health: '20', rendermode: '2', renderamt: '110' },
  box(60, -620, 0, 64, -460, 112, 'glass_med'));
breakable({ material: '7', health: '1' }, box(120, -560, 0, 184, -496, 64, 'crate08'));

// A free-standing wall between the lanes and the pool (cover, and shade).
world.push(box(-160, 180, 0, 160, 196, 192, { top: 'crete3_wall02', bottom: null, side: 'crete3_wall02' }));

// Conveyor belt: carries whoever stands on it east; its top is a scroll* texture, so it
// slides that way (GoldSrc scrolls those along s at the conveyor's speed).
world.push(box(280, -968, 0, 920, -960, 12, 'stripes2'), box(280, -856, 0, 920, -848, 12, 'stripes2'));
brushEntity({ classname: 'func_conveyor', speed: '160', angles: '0 0 0' },
  [box(280, -960, 0, 920, -856, 8, { top: 'scroll_conv', bottom: null, side: 'steel' })]);

// Metal yard: steel plates and a metal shed with an open side.
world.push(box(280, -760, 0, 920, -400, 2, { top: 'duct_flr01', bottom: null, side: 'steel' }));
world.push(
  box(720, -760, 2, 920, -744, 192, 'metal_wall05b'),
  box(904, -744, 2, 920, -560, 192, 'metal_wall05b'),
  box(720, -576, 2, 904, -560, 192, 'metal_wall05b'),
  box(720, -760, 192, 920, -560, 200, 'metal_wall05b'),
);

// --- Compiler ----------------------------------------------------------------------------

const CONTENTS_EMPTY = -1, CONTENTS_SOLID = -2;
// GoldSrc hulls 1-3 (point, standing, large, crouched): mins / maxs.
const HULLS = [[0, 0, 0, 0, 0, 0], [-16, -16, -36, 16, 16, 36], [-32, -32, -32, 32, 32, 32], [-16, -16, -18, 16, 16, 18]];

const planes = [], planeOf = new Map();
function plane(axis, dist) {
  const key = `${axis}:${dist}`;
  if (!planeOf.has(key)) {
    planeOf.set(key, planes.length);
    planes.push([axis, dist]);
  }
  return planeOf.get(key);
}

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

// Boxes that cast shadows (world coordinates): solid brushes but the sky, glass, water,
// triggers and ladders.
const SHADOWLESS = new Set(['func_buyzone', 'func_bomb_target', 'func_ladder', 'func_water']);
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
  const sun = ndl > 0 && !blocked(q, SUN) ? ndl : 0;
  let sky = 0;
  for (const d of SKY_DIRS) {
    const k = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (k > 0 && !blocked(q, d)) sky += k;
  }
  sky /= SKY_NORM;
  return [0, 1, 2].map((c) => Math.min(255, Math.round(BASE_RGB[c] + SUN_RGB[c] * sun + SKY_RGB[c] * sky)));
}

// --- Writing the BSP ----------------------------------------------------------------------

const texNames = Object.keys(TEX), texIndex = new Map(texNames.map((n, i) => [n, i]));
const texinfos = [], texinfoOf = new Map();
// Texture axes by face orientation (GoldSrc's): floors s = x, t = -y; walls s along, t = -z.
const TEX_AXES = [[[0, 1, 0], [0, 0, -1]], [[1, 0, 0], [0, 0, -1]], [[1, 0, 0], [0, -1, 0]]];
function texinfo(tex, axis) {
  const key = `${tex}:${axis}`;
  if (!texinfoOf.has(key)) {
    if (!texIndex.has(tex)) throw new Error(`texture ${tex} is not in TEX`); // (it would print as sky)
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

function writeBSP() {
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
  return out;
}

if (vertices.length > 65535 || nodes.length > 32767 || clipnodes.length > 32767 || leaves.length > 32767) {
  throw new Error('the map is too big for BSP 30');
}
const file = writeBSP();
Deno.writeFileSync(OUT, file);
console.log(`de_playground.bsp: ${(file.length / 1024).toFixed(0)} KB, ${models.length} models, ${faces.length} faces, ` +
  `${nodes.length} nodes, ${clipnodes.length} clipnodes, ${leaves.length} leaves, ${lighting.length / 3} light texels`);
