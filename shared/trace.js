// Hull collision against GoldSrc BSP clip hulls (port of SV_RecursiveHullCheck).
// Hull 0 (point) is built from the BSP nodes at load time and appended after the
// clipnodes, so one recursive routine serves all four hulls. No allocation per trace.

import { CONTENTS_EMPTY, CONTENTS_SOLID, modelHeadnode, entityModelIndex, parseVec3 } from './bsp.js';

export const HULL_POINT = 0;
export const HULL_STAND = 1;
export const HULL_LARGE = 2;
export const HULL_DUCK = 3;

// Per-hull box extents relative to the entity origin (origin = box center).
export const HULL_MINS = new Float32Array([0, 0, 0, -16, -16, -36, -32, -32, -32, -16, -16, -18]);
export const HULL_MAXS = new Float32Array([0, 0, 0, 16, 16, 36, 32, 32, 32, 16, 16, 18]);

export const ENT_SOLID = 0;
export const ENT_LADDER = 1;
export const ENT_WATER = 2;
export const ENT_NONE = 3; // disabled: collides with nothing (broken func_breakable)

const DIST_EPSILON = 0.03125;

// Brush entities that never block movement. Every other func_* brush entity is solid.
const NONSOLID = new Set([
  'func_illusionary', 'func_buyzone', 'func_bomb_target', 'func_hostage_rescue', 'func_escapezone',
  'func_vip_safetyzone', 'func_monsterclip', 'func_mortar_field', 'func_traincontrols', 'func_friction',
]);

export class Trace {
  constructor() {
    this.fraction = 1;
    this.allsolid = false;
    this.startsolid = false;
    this.inopen = false;
    this.inwater = false;
    this.endx = 0;
    this.endy = 0;
    this.endz = 0;
    this.nx = 0;
    this.ny = 0;
    this.nz = 0;
    this.dist = 0;
    this.ent = -1;
    this.head = 0; // hull root of the entity being traced (internal)
  }

  copyFrom(t) {
    this.fraction = t.fraction;
    this.allsolid = t.allsolid;
    this.startsolid = t.startsolid;
    this.inopen = t.inopen;
    this.inwater = t.inwater;
    this.endx = t.endx;
    this.endy = t.endy;
    this.endz = t.endz;
    this.nx = t.nx;
    this.ny = t.ny;
    this.nz = t.nz;
    this.dist = t.dist;
    this.ent = t.ent;
  }
}

export class CollisionWorld {
  // planes: [nx, ny, nz, dist] * P; ptype: plane axis type (0..2 axial, else general)
  // cnPlane / cnChild: clip tree; children >= 0 are node indices, < 0 are contents.
  constructor(planes, ptype, cnPlane, cnChild) {
    this.planes = planes;
    this.ptype = ptype;
    this.cnPlane = cnPlane;
    this.cnChild = cnChild;
    this.ents = [];
  }

  // heads: hull 0..3 root nodes (or contents when negative); bounds in model space.
  // push: base velocity given to players standing on it (func_conveyor).
  addEntity(kind, heads, ox, oy, oz, mins, maxs, push = null) {
    this.ents.push({
      kind,
      heads: Int32Array.from(heads),
      ox, oy, oz,
      mins: Float32Array.from(mins),
      maxs: Float32Array.from(maxs),
      pushX: push ? push[0] : 0,
      pushY: push ? push[1] : 0,
      pushZ: push ? push[2] : 0,
      bspEntity: -1,
    });
    return this.ents.length - 1;
  }

  static fromBSP(bsp) {
    const P = bsp.numPlanes;
    const planes = new Float32Array(P * 4);
    const ptype = new Int32Array(P);
    for (let i = 0; i < P; i++) {
      planes[i * 4] = bsp.planesF[i * 5];
      planes[i * 4 + 1] = bsp.planesF[i * 5 + 1];
      planes[i * 4 + 2] = bsp.planesF[i * 5 + 2];
      planes[i * 4 + 3] = bsp.planesF[i * 5 + 3];
      ptype[i] = bsp.planesI[i * 5 + 4];
    }

    const nc = bsp.numClipnodes;
    const nn = bsp.numNodes;
    const cnPlane = new Int32Array(nc + nn);
    const cnChild = new Int32Array((nc + nn) * 2);
    for (let i = 0; i < nc; i++) {
      cnPlane[i] = bsp.clipnodesI32[i * 2];
      cnChild[i * 2] = bsp.clipnodesI16[i * 4 + 2];
      cnChild[i * 2 + 1] = bsp.clipnodesI16[i * 4 + 3];
    }
    // Hull 0 from render nodes: leaf children become their leaf contents.
    for (let j = 0; j < nn; j++) {
      cnPlane[nc + j] = bsp.nodesI32[j * 6];
      for (let k = 0; k < 2; k++) {
        const c = bsp.nodesI16[j * 12 + 2 + k];
        cnChild[(nc + j) * 2 + k] = c >= 0 ? nc + c : bsp.leavesI32[(-1 - c) * 7];
      }
    }

    const world = new CollisionWorld(planes, ptype, cnPlane, cnChild);
    const heads = new Int32Array(4);
    const mins = new Float32Array(3);
    const maxs = new Float32Array(3);
    const origin = new Float32Array(3);
    const add = (kind, m, o, push = null, bspEntity = -1) => {
      for (let h = 0; h < 4; h++) {
        const head = modelHeadnode(bsp, m, h);
        heads[h] = h === 0 && head >= 0 ? nc + head : head;
      }
      for (let k = 0; k < 3; k++) {
        mins[k] = bsp.modelsF[m * 16 + k];
        maxs[k] = bsp.modelsF[m * 16 + 3 + k];
      }
      const i = world.addEntity(kind, heads, o[0], o[1], o[2], mins, maxs, push);
      world.ents[i].bspEntity = bspEntity; // index into bsp.entities, -1 for the world
    };

    add(ENT_SOLID, 0, [0, 0, 0]);
    bsp.entities.forEach((e, bspEntity) => {
      const m = entityModelIndex(e);
      if (m <= 0) return;
      const cls = e.classname || '';
      let kind;
      if (cls === 'func_ladder') kind = ENT_LADDER;
      else if (cls === 'func_water') kind = ENT_WATER;
      else if (cls === 'func_conveyor' && (+(e.spawnflags || 0) & SF_CONVEYOR_NOTSOLID)) return;
      else if (cls.startsWith('func_') && !NONSOLID.has(cls)) kind = ENT_SOLID;
      else return;
      parseVec3(e.origin, origin);
      add(kind, m, origin, cls === 'func_conveyor' ? conveyorPush(e) : null, bspEntity);
    });
    return world;
  }
}

const SF_CONVEYOR_VISUAL = 1; // scrolls but does not push
const SF_CONVEYOR_NOTSOLID = 2;

// Base velocity of a func_conveyor: SetMovedir(angles) * speed (HL SDK CFuncConveyor).
function conveyorPush(e) {
  const flags = +(e.spawnflags || 0);
  if (flags & SF_CONVEYOR_VISUAL) return null;
  const speed = +(e.speed || 0) || 100;
  const a = new Float32Array(3);
  if (e.angles) parseVec3(e.angles, a);
  else if (e.angle) a[1] = +e.angle;
  let dir;
  if (a[0] === 0 && a[1] === -1 && a[2] === 0) dir = [0, 0, 1];
  else if (a[0] === 0 && a[1] === -2 && a[2] === 0) dir = [0, 0, -1];
  else {
    const p = a[0] * Math.PI / 180, y = a[1] * Math.PI / 180;
    dir = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
  }
  return [dir[0] * speed, dir[1] * speed, dir[2] * speed];
}

// --- Recursive hull check -------------------------------------------------
// Module-level state for the active trace keeps the recursion argument list scalar.

let P, PT, CP, CC, T;

function hullPointContents(num, x, y, z) {
  while (num >= 0) {
    const p = CP[num];
    const t = PT[p];
    const d = (t < 3 ? (t === 0 ? x : t === 1 ? y : z) : P[p * 4] * x + P[p * 4 + 1] * y + P[p * 4 + 2] * z) -
      P[p * 4 + 3];
    num = CC[num * 2 + (d < 0 ? 1 : 0)];
  }
  return num;
}

function recursiveHullCheck(num, p1f, p2f, x1, y1, z1, x2, y2, z2) {
  if (num < 0) {
    if (num !== CONTENTS_SOLID) {
      T.allsolid = false;
      if (num === CONTENTS_EMPTY) T.inopen = true;
      else T.inwater = true;
    } else {
      T.startsolid = true;
    }
    return true;
  }

  const p = CP[num];
  const type = PT[p];
  const nx = P[p * 4], ny = P[p * 4 + 1], nz = P[p * 4 + 2], dist = P[p * 4 + 3];
  let t1, t2;
  if (type < 3) {
    t1 = (type === 0 ? x1 : type === 1 ? y1 : z1) - dist;
    t2 = (type === 0 ? x2 : type === 1 ? y2 : z2) - dist;
  } else {
    t1 = nx * x1 + ny * y1 + nz * z1 - dist;
    t2 = nx * x2 + ny * y2 + nz * z2 - dist;
  }

  if (t1 >= 0 && t2 >= 0) return recursiveHullCheck(CC[num * 2], p1f, p2f, x1, y1, z1, x2, y2, z2);
  if (t1 < 0 && t2 < 0) return recursiveHullCheck(CC[num * 2 + 1], p1f, p2f, x1, y1, z1, x2, y2, z2);

  // Put the crosspoint DIST_EPSILON units on the near side.
  let frac = t1 < 0 ? (t1 + DIST_EPSILON) / (t1 - t2) : (t1 - DIST_EPSILON) / (t1 - t2);
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  let midf = p1f + (p2f - p1f) * frac;
  let mx = x1 + frac * (x2 - x1), my = y1 + frac * (y2 - y1), mz = z1 + frac * (z2 - z1);
  const side = t1 < 0 ? 1 : 0;

  if (!recursiveHullCheck(CC[num * 2 + side], p1f, midf, x1, y1, z1, mx, my, mz)) return false;

  if (hullPointContents(CC[num * 2 + (side ^ 1)], mx, my, mz) !== CONTENTS_SOLID) {
    return recursiveHullCheck(CC[num * 2 + (side ^ 1)], midf, p2f, mx, my, mz, x2, y2, z2);
  }

  if (T.allsolid) return false; // never got out of the solid area

  // The other side of the node is solid: this is the impact point.
  if (side === 0) {
    T.nx = nx; T.ny = ny; T.nz = nz; T.dist = dist;
  } else {
    T.nx = -nx; T.ny = -ny; T.nz = -nz; T.dist = -dist;
  }

  // Back off until the midpoint is outside the solid (rare float edge cases).
  while (hullPointContents(T.head, mx, my, mz) === CONTENTS_SOLID) {
    frac -= 0.1;
    if (frac < 0) {
      T.fraction = midf;
      T.endx = mx; T.endy = my; T.endz = mz;
      return false;
    }
    midf = p1f + (p2f - p1f) * frac;
    mx = x1 + frac * (x2 - x1);
    my = y1 + frac * (y2 - y1);
    mz = z1 + frac * (z2 - z1);
  }
  T.fraction = midf;
  T.endx = mx; T.endy = my; T.endz = mz;
  return false;
}

function bind(world) {
  P = world.planes;
  PT = world.ptype;
  CP = world.cnPlane;
  CC = world.cnChild;
}

const entTrace = new Trace();

// Traces one entity's hull in world space. Result goes into `out`.
export function traceEntity(world, entIndex, hull, sx, sy, sz, ex, ey, ez, out) {
  const e = world.ents[entIndex];
  bind(world);
  T = out;
  out.fraction = 1;
  out.allsolid = true;
  out.startsolid = false;
  out.inopen = false;
  out.inwater = false;
  out.nx = out.ny = out.nz = out.dist = 0;
  out.ent = -1;
  out.head = e.heads[hull];
  recursiveHullCheck(out.head, 0, 1, sx - e.ox, sy - e.oy, sz - e.oz, ex - e.ox, ey - e.oy, ez - e.oz);
  if (out.fraction === 1) {
    out.endx = ex; out.endy = ey; out.endz = ez;
  } else {
    out.endx += e.ox; out.endy += e.oy; out.endz += e.oz;
    out.dist += out.nx * e.ox + out.ny * e.oy + out.nz * e.oz;
    out.ent = entIndex;
  }
  return out;
}

// Traces a hull against the world and all solid brush entities (GoldSrc PM_PlayerTrace
// semantics: startsolid forces fraction 0).
export function traceHull(world, hull, sx, sy, sz, ex, ey, ez, out) {
  const hminx = HULL_MINS[hull * 3], hminy = HULL_MINS[hull * 3 + 1], hminz = HULL_MINS[hull * 3 + 2];
  const hmaxx = HULL_MAXS[hull * 3], hmaxy = HULL_MAXS[hull * 3 + 1], hmaxz = HULL_MAXS[hull * 3 + 2];
  const bminx = Math.min(sx, ex) + hminx, bmaxx = Math.max(sx, ex) + hmaxx;
  const bminy = Math.min(sy, ey) + hminy, bmaxy = Math.max(sy, ey) + hmaxy;
  const bminz = Math.min(sz, ez) + hminz, bmaxz = Math.max(sz, ez) + hmaxz;

  traceEntity(world, 0, hull, sx, sy, sz, ex, ey, ez, out);
  if (out.fraction !== 1 || out.startsolid) out.ent = 0;

  const ents = world.ents;
  for (let i = 1; i < ents.length; i++) {
    const e = ents[i];
    if (e.kind !== ENT_SOLID) continue;
    // Broadphase: swept box vs model bounds.
    if (bminx > e.maxs[0] + e.ox || bmaxx < e.mins[0] + e.ox ||
      bminy > e.maxs[1] + e.oy || bmaxy < e.mins[1] + e.oy ||
      bminz > e.maxs[2] + e.oz || bmaxz < e.mins[2] + e.oz) continue;

    traceEntity(world, i, hull, sx, sy, sz, ex, ey, ez, entTrace);
    if (entTrace.allsolid || entTrace.startsolid || entTrace.fraction < out.fraction) {
      const wasStartSolid = out.startsolid;
      entTrace.ent = i;
      out.copyFrom(entTrace);
      if (wasStartSolid) out.startsolid = true;
    }
  }

  if (out.allsolid) out.startsolid = true;
  if (out.startsolid) {
    out.fraction = 0;
    out.endx = sx; out.endy = sy; out.endz = sz;
  }
  return out;
}

// Contents of a point in one entity's hull (CONTENTS_*).
export function entityContents(world, entIndex, hull, x, y, z) {
  const e = world.ents[entIndex];
  bind(world);
  return hullPointContents(e.heads[hull], x - e.ox, y - e.oy, z - e.oz);
}

// Point contents for water checks: world hull 0 plus func_water volumes.
export function pointContents(world, x, y, z) {
  const c = entityContents(world, 0, HULL_POINT, x, y, z);
  if (c !== CONTENTS_EMPTY) return c;
  const ents = world.ents;
  for (let i = 1; i < ents.length; i++) {
    if (ents[i].kind === ENT_WATER && entityContents(world, i, HULL_POINT, x, y, z) !== CONTENTS_EMPTY) {
      return -3; // CONTENTS_WATER
    }
  }
  return CONTENTS_EMPTY;
}

// True if a hull placed at (x, y, z) overlaps nothing solid.
const posTrace = new Trace();
export function hullFits(world, hull, x, y, z) {
  traceHull(world, hull, x, y, z, x, y, z, posTrace);
  return !posTrace.startsolid;
}
