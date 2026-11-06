// Hull collision against GoldSrc BSP clip hulls (port of SV_RecursiveHullCheck).
// Hull 0 (point) is built from the BSP nodes at load time and appended after the
// clipnodes, so one recursive routine serves all four hulls. No allocation per trace.

import {
  CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER, CONTENTS_SLIME, CONTENTS_LAVA, isLiquid, modelHeadnode, entityModelIndex,
  parseVec3,
} from './bsp.js';

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

export const DIST_EPSILON = 0.03125;

// Player bodies: the living players as solid boxes to each other's movement (CS:GO:
// players collide, stand on each other and ride a moving teammate, the run boost). They
// are packed every tick by player id (`setBody`), so a client's prediction and the server
// agree on the ground entity's index; only the player hull traces see them
// (`tracePlayerA`), bullets never (the hit groups do players). A body the trace starts
// inside is passed through: two players left overlapping walk out of each other.
export const MAX_BODIES = 64; // slots (player ids)
export const BODY_FIELDS = 8; // x, y, z (hull center), half height (0: no body), vx, vy, vz, team
export const ENT_BODY_BASE = 1 << 16; // trace.ent of body k is ENT_BODY_BASE + k

// Brush entities that never block movement. Every other func_* brush entity is solid (the
// floor grid takes the same list: shared/floorgrid.js).
export const NONSOLID = new Set([
  'func_illusionary', 'func_buyzone', 'func_bomb_target', 'func_hostage_rescue', 'func_escapezone',
  'func_vip_safetyzone', 'func_monsterclip', 'func_mortar_field', 'func_traincontrols', 'func_friction',
]);

export class Trace {
  constructor() {
    // (-0 first: the fields that hold fractions are doubles from the start; a field first
    // given a whole number changes the object's map when a fraction comes)
    this.fraction = this.endx = this.endy = this.endz = this.nx = this.ny = this.nz = this.dist = -0;
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
    // World bounds of every entity, 6 a row (min x y z, max x y z): each entity's `amin` /
    // `amax` are views into it, so the broadphase reads one flat array instead of every
    // entity object. Grown (and the views moved over) by addEntity.
    this.bounds = new Float64Array(6 * 16);
    // Indices of the entities created as water and ladders: pointContents and findLadder walk
    // only these (still checking `kind`, which breakables and doors change at run time).
    this.water = [];
    this.ladders = [];
    // False once fromBSP found no liquid leaf and no func_water: the water probes (pmove,
    // grenades, the client's swimming and splashes) are skipped on a dry map.
    this.liquids = true;
    this.surfaces = null; // SurfaceMap, attached by whoever loads the map (bullet penetration)
    this.bodies = new Float32Array(MAX_BODIES * BODY_FIELDS); // see BODY_FIELDS
    this.bodyCount = 0; // slots in use (by player id, so holes are bodies of half height 0)
    this.bodySelf = -1; // the moving player's own slot: never collides with itself
    this.bodyTeam = 0; // the moving player's team
    this.solidTeam = true; // mp_solid_teammates: false lets teammates pass through each other
  }

  // heads: hull 0..3 root nodes (or contents when negative); bounds in model space.
  // push: base velocity given to players standing on it (func_conveyor).
  addEntity(kind, heads, ox, oy, oz, mins, maxs, push = null) {
    const i = this.ents.length, j = i * 6;
    if (j + 6 > this.bounds.length) {
      const b = new Float64Array(this.bounds.length * 2);
      b.set(this.bounds);
      this.bounds = b;
      for (let k = 0; k < i; k++) {
        this.ents[k].amin = b.subarray(k * 6, k * 6 + 3);
        this.ents[k].amax = b.subarray(k * 6 + 3, k * 6 + 6);
      }
    }
    const B = this.bounds;
    B[j] = mins[0] + ox; B[j + 1] = mins[1] + oy; B[j + 2] = mins[2] + oz;
    B[j + 3] = maxs[0] + ox; B[j + 4] = maxs[1] + oy; B[j + 5] = maxs[2] + oz;
    if (i > 0 && kind === ENT_WATER) this.water.push(i); // from 1, as the loops these replace (0 is the world)
    if (i > 0 && kind === ENT_LADDER) this.ladders.push(i);
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
      liquid: CONTENTS_WATER, // a func_water's CONTENTS_*: water, or slime / lava by its skin key (GoldSrc's)
      slot: 0, // world vertex slot (shared/breakables.js, shared/doors.js): decals sit on it
      rot: null, // model -> world rotation (columns forward, left, up), null = none
      amin: B.subarray(j, j + 3), // world bounds (views into this.bounds)
      amax: B.subarray(j + 3, j + 6),
    });
    return i;
  }

  // Moves entity `i` (doors): origin and rotation (a Float64Array(9) from
  // rotationFromAngles, or null). Rotated bounds are a sphere around the origin, as in
  // GoldSrc.
  setTransform(i, ox, oy, oz, rot) {
    const e = this.ents[i];
    e.ox = ox;
    e.oy = oy;
    e.oz = oz;
    e.rot = rot;
    if (rot) {
      let r = 0;
      for (let k = 0; k < 3; k++) r += Math.max(e.mins[k] * e.mins[k], e.maxs[k] * e.maxs[k]);
      r = Math.sqrt(r);
      e.amin[0] = ox - r; e.amin[1] = oy - r; e.amin[2] = oz - r;
      e.amax[0] = ox + r; e.amax[1] = oy + r; e.amax[2] = oz + r;
    } else {
      e.amin[0] = e.mins[0] + ox; e.amin[1] = e.mins[1] + oy; e.amin[2] = e.mins[2] + oz;
      e.amax[0] = e.maxs[0] + ox; e.amax[1] = e.maxs[1] + oy; e.amax[2] = e.maxs[2] + oz;
    }
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
    let wet = false;
    for (let j = 0; j < nn; j++) {
      cnPlane[nc + j] = bsp.nodesI32[j * 6];
      for (let k = 0; k < 2; k++) {
        const c = bsp.nodesI16[j * 12 + 2 + k];
        cnChild[(nc + j) * 2 + k] = c >= 0 ? nc + c : bsp.leavesI32[(-1 - c) * 7];
        if (c < 0 && isLiquid(cnChild[(nc + j) * 2 + k])) wet = true;
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
      return i;
    };

    add(ENT_SOLID, 0, [0, 0, 0]);
    bsp.entities.forEach((e, bspEntity) => {
      const m = entityModelIndex(e);
      if (m <= 0) return;
      const cls = e.classname || '';
      let kind;
      if (cls === 'func_ladder') kind = ENT_LADDER;
      else if (cls === 'func_water') kind = ENT_WATER;
      else if (solidBrushEntity(e)) kind = ENT_SOLID;
      else return;
      parseVec3(e.origin, origin);
      const i = add(kind, m, origin, cls === 'func_conveyor' ? conveyorPush(e) : null, bspEntity);
      const skin = +e.skin;
      if (kind === ENT_WATER && (skin === CONTENTS_SLIME || skin === CONTENTS_LAVA)) world.ents[i].liquid = skin;
    });
    world.liquids = wet || world.water.length > 0;
    return world;
  }
}

// Solid brush entities not named func_* (shared/doors.js moves them).
const MOVERS = new Set(['momentary_door', 'momentary_rot_button']);

const SF_CONVEYOR_VISUAL = 1; // scrolls but does not push
const SF_CONVEYOR_NOTSOLID = 2;

// A brush entity that stops players and holds them up (a collision ENT_SOLID): func_* but the
// passable ones (NONSOLID), the volumes and a not-solid conveyor, plus the momentary movers.
// The floor grid (bots, the radar) asks the same: it had its own test, where a not-solid
// conveyor was a floor and a momentary_door none.
export function solidBrushEntity(e) {
  const cls = e.classname || '';
  if (cls === 'func_ladder' || cls === 'func_water') return false;
  if (cls === 'func_conveyor' && (+(e.spawnflags || 0) & SF_CONVEYOR_NOTSOLID)) return false;
  return (cls.startsWith('func_') && !NONSOLID.has(cls)) || MOVERS.has(cls);
}

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

// The values a branch picks go through these, not through a ?: or a reassigned variable:
// in Maglev (where the traces run for minutes) every phi is tagged, and each double that
// flowed through one was a new heap number, per node visited (see CLAUDE.md, Performance,
// The garbage). The same arithmetic: bit-exact.
const HP = new Float64Array(1); // hullPointContents' plane side
const S = new Float64Array(7); // recursiveHullCheck's: t1, t2, then frac, midf, mx, my, mz

// Contents at the point A[o], A[o + 1], A[o + 2] (an array: three doubles passed as
// arguments were boxed at every call).
function hullPointContents(num, A, o) {
  const x = A[o], y = A[o + 1], z = A[o + 2];
  while (num >= 0) {
    const p = CP[num];
    const t = PT[p], q = p * 4;
    if (t === 0) HP[0] = x;
    else if (t === 1) HP[0] = y;
    else if (t === 2) HP[0] = z;
    else HP[0] = P[q] * x + P[q + 1] * y + P[q + 2] * z;
    const d = HP[0] - P[q + 3];
    num = CC[num * 2 + (d < 0 ? 1 : 0)];
  }
  return num;
}

// The recursion's arguments per depth (p1f, p2f, x1, y1, z1, x2, y2, z2): doubles passed
// as call arguments would be boxed (a heap allocation) on every call. Depth only grows
// where a trace crosses a plane, so the tree depth bounds it.
const MAX_DEPTH = 512;
// validateBSP's checkTree lets a path hold MAX_DEPTH + 1 nodes, and the deepest writes its
// child's arguments one level further: a trace that deep read NaN past the end.
const ARGS = new Float64Array((MAX_DEPTH + 2) * 8);

function hullCheck(head, x1, y1, z1, x2, y2, z2) {
  ARGS[0] = 0;
  ARGS[1] = 1;
  ARGS[2] = x1; ARGS[3] = y1; ARGS[4] = z1;
  ARGS[5] = x2; ARGS[6] = y2; ARGS[7] = z2;
  recursiveHullCheck(head, 0);
}

function recursiveHullCheck(num, depth) {
  const o = depth * 8;
  const p1f = ARGS[o], p2f = ARGS[o + 1];
  const x1 = ARGS[o + 2], y1 = ARGS[o + 3], z1 = ARGS[o + 4], x2 = ARGS[o + 5], y2 = ARGS[o + 6], z2 = ARGS[o + 7];
  // Down the tree while both ends are on the same side of the node's plane (t1, t2: the
  // ends' distances, in S).
  let p = 0;
  for (;;) {
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
    p = CP[num];
    const type = PT[p], q = p * 4, d = P[q + 3];
    if (type === 0) {
      S[0] = x1 - d;
      S[1] = x2 - d;
    } else if (type === 1) {
      S[0] = y1 - d;
      S[1] = y2 - d;
    } else if (type === 2) {
      S[0] = z1 - d;
      S[1] = z2 - d;
    } else {
      S[0] = P[q] * x1 + P[q + 1] * y1 + P[q + 2] * z1 - d;
      S[1] = P[q] * x2 + P[q + 1] * y2 + P[q + 2] * z2 - d;
    }
    const a = S[0], b = S[1];
    if (a >= 0 && b >= 0) num = CC[num * 2];
    else if (a < 0 && b < 0) num = CC[num * 2 + 1];
    else break;
  }
  const t1 = S[0], t2 = S[1], nx = P[p * 4], ny = P[p * 4 + 1], nz = P[p * 4 + 2], dist = P[p * 4 + 3];

  // Put the crosspoint DIST_EPSILON units on the near side.
  if (t1 < 0) S[2] = (t1 + DIST_EPSILON) / (t1 - t2);
  else S[2] = (t1 - DIST_EPSILON) / (t1 - t2);
  if (S[2] < 0) S[2] = 0;
  if (S[2] > 1) S[2] = 1;
  const frac = S[2];

  const midf = p1f + (p2f - p1f) * frac;
  const mx = x1 + frac * (x2 - x1), my = y1 + frac * (y2 - y1), mz = z1 + frac * (z2 - z1);
  const side = t1 < 0 ? 1 : 0;

  const c = o + 8; // the child's arguments
  ARGS[c] = p1f; ARGS[c + 1] = midf;
  ARGS[c + 2] = x1; ARGS[c + 3] = y1; ARGS[c + 4] = z1;
  ARGS[c + 5] = mx; ARGS[c + 6] = my; ARGS[c + 7] = mz;
  if (!recursiveHullCheck(CC[num * 2 + side], depth + 1)) return false;

  // (ARGS[c + 5..7] still hold mx, my, mz: a child writes only its own children's slots)
  if (hullPointContents(CC[num * 2 + (side ^ 1)], ARGS, c + 5) !== CONTENTS_SOLID) {
    ARGS[c] = midf; ARGS[c + 1] = p2f;
    ARGS[c + 2] = mx; ARGS[c + 3] = my; ARGS[c + 4] = mz;
    ARGS[c + 5] = x2; ARGS[c + 6] = y2; ARGS[c + 7] = z2;
    return recursiveHullCheck(CC[num * 2 + (side ^ 1)], depth + 1);
  }

  if (T.allsolid) return false; // never got out of the solid area

  // The other side of the node is solid: this is the impact point.
  if (side === 0) {
    T.nx = nx; T.ny = ny; T.nz = nz; T.dist = dist;
  } else {
    T.nx = -nx; T.ny = -ny; T.nz = -nz; T.dist = -dist;
  }

  // Back off until the midpoint is outside the solid (rare float edge cases). NaN ends it too:
  // a trace toward an infinite point never left the loop, which froze every game.
  // (frac, midf, mx, my, mz in S[2..6]: the loop's changing values, not reassigned variables)
  S[2] = frac; S[3] = midf; S[4] = mx; S[5] = my; S[6] = mz;
  while (hullPointContents(T.head, S, 4) === CONTENTS_SOLID) {
    S[2] -= 0.1;
    if (!(S[2] >= 0)) break;
    S[3] = p1f + (p2f - p1f) * S[2];
    S[4] = x1 + S[2] * (x2 - x1);
    S[5] = y1 + S[2] * (y2 - y1);
    S[6] = z1 + S[2] * (z2 - z1);
  }
  T.fraction = S[3];
  T.endx = S[4]; T.endy = S[5]; T.endz = S[6];
  return false;
}

function bind(world) {
  P = world.planes;
  PT = world.ptype;
  CP = world.cnPlane;
  CC = world.cnChild;
}

const entTrace = new Trace();

// GoldSrc AngleVectors as a model -> world rotation: columns forward, left (-right), up,
// so world = origin + R * local and local = R^T * (world - origin) (SV_ClipMoveToEntity).
export function rotationFromAngles(pitch, yaw, roll, out = new Float64Array(9)) {
  const D = Math.PI / 180;
  const sp = Math.sin(pitch * D), cp = Math.cos(pitch * D), sy = Math.sin(yaw * D), cy = Math.cos(yaw * D);
  const sr = Math.sin(roll * D), cr = Math.cos(roll * D);
  out[0] = cp * cy; out[1] = cp * sy; out[2] = -sp; // forward
  out[3] = -(-sr * sp * cy + cr * sy); out[4] = -(-sr * sp * sy - cr * cy); out[5] = -(-sr * cp); // left = -right
  out[6] = cr * sp * cy + sr * sy; out[7] = cr * sp * sy - sr * cy; out[8] = cr * cp; // up
  return out;
}

// World point -> entity model space (origin and rotation), into `out` [x, y, z].
export function toLocal(e, x, y, z, out) {
  x -= e.ox; y -= e.oy; z -= e.oz;
  const R = e.rot;
  if (!R) {
    out[0] = x; out[1] = y; out[2] = z;
  } else {
    out[0] = x * R[0] + y * R[1] + z * R[2];
    out[1] = x * R[3] + y * R[4] + z * R[5];
    out[2] = x * R[6] + y * R[7] + z * R[8];
  }
  return out;
}

const ls = new Float64Array(3), le = new Float64Array(3);

// A trace's start and end in one array (sx, sy, sz, ex, ey, ez): the *A functions take it,
// so no doubles cross their calls (as arguments each was boxed: 6 a call, 4 calls deep for a
// player's move). The plain ones are the same with the numbers as arguments.
const TA = new Float64Array(6);
const setTA = (sx, sy, sz, ex, ey, ez) => {
  TA[0] = sx; TA[1] = sy; TA[2] = sz; TA[3] = ex; TA[4] = ey; TA[5] = ez;
  return TA;
};

// Traces one entity's hull in world space. Result goes into `out`.
export function traceEntity(world, entIndex, hull, sx, sy, sz, ex, ey, ez, out) {
  return traceEntityA(world, entIndex, hull, setTA(sx, sy, sz, ex, ey, ez), out);
}

export function traceEntityA(world, entIndex, hull, A, out) {
  const e = world.ents[entIndex];
  if (e.rot) return traceRotated(world, e, entIndex, hull, A, out);
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
  // (hullCheck written out: the six doubles go straight into the recursion's arguments)
  ARGS[0] = 0;
  ARGS[1] = 1;
  ARGS[2] = A[0] - e.ox; ARGS[3] = A[1] - e.oy; ARGS[4] = A[2] - e.oz;
  ARGS[5] = A[3] - e.ox; ARGS[6] = A[4] - e.oy; ARGS[7] = A[5] - e.oz;
  recursiveHullCheck(out.head, 0);
  if (out.fraction === 1) {
    out.endx = A[3]; out.endy = A[4]; out.endz = A[5];
  } else {
    out.endx += e.ox; out.endy += e.oy; out.endz += e.oz;
    out.dist += out.nx * e.ox + out.ny * e.oy + out.nz * e.oz;
    out.ent = entIndex;
  }
  return out;
}

// A rotated entity (GoldSrc SV_ClipMoveToEntity): the trace runs in model space (the hull
// box itself is not rotated, as in GoldSrc), then the plane turns back and the end point
// is lerped in world space.
function traceRotated(world, e, entIndex, hull, A, out) {
  const sx = A[0], sy = A[1], sz = A[2], ex = A[3], ey = A[4], ez = A[5];
  toLocal(e, sx, sy, sz, ls);
  toLocal(e, ex, ey, ez, le);
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
  hullCheck(out.head, ls[0], ls[1], ls[2], le[0], le[1], le[2]);
  if (out.fraction === 1) {
    out.endx = ex; out.endy = ey; out.endz = ez;
    return out;
  }
  const R = e.rot, nx = out.nx, ny = out.ny, nz = out.nz;
  out.nx = R[0] * nx + R[3] * ny + R[6] * nz;
  out.ny = R[1] * nx + R[4] * ny + R[7] * nz;
  out.nz = R[2] * nx + R[5] * ny + R[8] * nz;
  out.endx = sx + (ex - sx) * out.fraction;
  out.endy = sy + (ey - sy) * out.fraction;
  out.endz = sz + (ez - sz) * out.fraction;
  out.dist = out.nx * out.endx + out.ny * out.endy + out.nz * out.endz;
  out.ent = entIndex;
  return out;
}

// Traces a hull against the world and all solid brush entities (GoldSrc PM_PlayerTrace
// semantics: startsolid forces fraction 0).
export function traceHull(world, hull, sx, sy, sz, ex, ey, ez, out) {
  return traceHullA(world, hull, setTA(sx, sy, sz, ex, ey, ez), out);
}

export function traceHullA(world, hull, A, out) {
  const sx = A[0], sy = A[1], sz = A[2], ex = A[3], ey = A[4], ez = A[5];
  const hminx = HULL_MINS[hull * 3], hminy = HULL_MINS[hull * 3 + 1], hminz = HULL_MINS[hull * 3 + 2];
  const hmaxx = HULL_MAXS[hull * 3], hmaxy = HULL_MAXS[hull * 3 + 1], hmaxz = HULL_MAXS[hull * 3 + 2];
  const bminx = Math.min(sx, ex) + hminx, bmaxx = Math.max(sx, ex) + hmaxx;
  const bminy = Math.min(sy, ey) + hminy, bmaxy = Math.max(sy, ey) + hmaxy;
  const bminz = Math.min(sz, ez) + hminz, bmaxz = Math.max(sz, ez) + hmaxz;

  traceEntityA(world, 0, hull, A, out);
  if (out.fraction !== 1 || out.startsolid) out.ent = 0;

  const ents = world.ents, B = world.bounds;
  for (let i = 1, j = 6; i < ents.length; i++, j += 6) {
    // Broadphase: swept box vs model bounds, from the flat array before touching the entity.
    if (bminx > B[j + 3] || bmaxx < B[j] || bminy > B[j + 4] || bmaxy < B[j + 1] ||
      bminz > B[j + 5] || bmaxz < B[j + 2]) continue;
    if (ents[i].kind !== ENT_SOLID) continue;

    traceEntityA(world, i, hull, A, entTrace);
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

// Body slot k (a player id): his hull center, half height (36 standing, 18 ducked), velocity
// (what a player standing on him rides along with) and team. Packed again every tick.
export function setBody(world, k, x, y, z, halfHeight, vx, vy, vz, team) {
  const B = world.bodies, b = k * BODY_FIELDS;
  B[b] = x; B[b + 1] = y; B[b + 2] = z;
  B[b + 3] = halfHeight;
  B[b + 4] = vx; B[b + 5] = vy; B[b + 6] = vz;
  B[b + 7] = team;
  if (k >= world.bodyCount) world.bodyCount = k + 1;
}

export function clearBodies(world) {
  world.bodies.fill(0, 0, world.bodyCount * BODY_FIELDS);
  world.bodyCount = 0;
}

// Clips a hull trace (already run against the world and brush entities into `out`)
// against the player bodies: each body's box grown by the hull's extents, the ray
// through the slabs, the end backed off DIST_EPSILON like the BSP trace. A box the
// start lies inside is skipped, a box touched exactly is not entered by a move along it.
export function traceBodiesA(world, hull, A, out) {
  const sx = A[0], sy = A[1], sz = A[2], ex = A[3], ey = A[4], ez = A[5];
  const n = world.bodyCount;
  if (n === 0 || out.startsolid) return out;
  const B = world.bodies, self = world.bodySelf, pass = world.solidTeam ? -1 : world.bodyTeam;
  const hx = HULL_MAXS[hull * 3], hz = HULL_MAXS[hull * 3 + 2]; // the hulls are symmetric
  const dx = ex - sx, dy = ey - sy, dz = ez - sz;
  for (let k = 0; k < n; k++) {
    const b = k * BODY_FIELDS, bh = B[b + 3];
    if (bh === 0 || k === self || B[b + 7] === pass) continue;
    const minx = B[b] - 16 - hx, maxx = B[b] + 16 + hx;
    const miny = B[b + 1] - 16 - hx, maxy = B[b + 1] + 16 + hx;
    const minz = B[b + 2] - bh - hz, maxz = B[b + 2] + bh + hz;
    if (sx > minx && sx < maxx && sy > miny && sy < maxy && sz > minz && sz < maxz) continue;
    let tin = -Infinity, tout = Infinity, axis = -1, sign = 0;
    // x
    if (dx === 0) {
      if (sx <= minx || sx >= maxx) continue;
    } else {
      let t1 = (minx - sx) / dx, t2 = (maxx - sx) / dx, sg = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
      if (t1 > tin) { tin = t1; axis = 0; sign = sg; }
      if (t2 < tout) tout = t2;
    }
    // y
    if (dy === 0) {
      if (sy <= miny || sy >= maxy) continue;
    } else {
      let t1 = (miny - sy) / dy, t2 = (maxy - sy) / dy, sg = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
      if (t1 > tin) { tin = t1; axis = 1; sign = sg; }
      if (t2 < tout) tout = t2;
    }
    // z
    if (dz === 0) {
      if (sz <= minz || sz >= maxz) continue;
    } else {
      let t1 = (minz - sz) / dz, t2 = (maxz - sz) / dz, sg = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
      if (t1 > tin) { tin = t1; axis = 2; sign = sg; }
      if (t2 < tout) tout = t2;
    }
    if (axis < 0 || tin >= tout || tout <= 0 || tin >= out.fraction) continue;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    let frac = tin - DIST_EPSILON / Math.abs(d);
    if (frac < 0) frac = 0;
    if (frac >= out.fraction) continue;
    out.fraction = frac;
    out.allsolid = false;
    out.startsolid = false;
    out.endx = sx + dx * frac;
    out.endy = sy + dy * frac;
    out.endz = sz + dz * frac;
    out.nx = axis === 0 ? sign : 0;
    out.ny = axis === 1 ? sign : 0;
    out.nz = axis === 2 ? sign : 0;
    out.dist = out.nx * out.endx + out.ny * out.endy + out.nz * out.endz;
    out.ent = ENT_BODY_BASE + k;
  }
  return out;
}

// A player's movement trace: the world, the brush entities, then the other players.
export function tracePlayerA(world, hull, A, out) {
  traceHullA(world, hull, A, out);
  return traceBodiesA(world, hull, A, out);
}

// Contents of a point in one entity's hull (CONTENTS_*).
export function entityContents(world, entIndex, hull, x, y, z) {
  const e = world.ents[entIndex];
  toLocal(e, x, y, z, ls);
  bind(world);
  return hullPointContents(e.heads[hull], ls, 0);
}

// Point contents for water checks: world hull 0 plus func_water volumes (their liquid).
export function pointContents(world, x, y, z) {
  const c = entityContents(world, 0, HULL_POINT, x, y, z);
  if (c !== CONTENTS_EMPTY) return c;
  const ents = world.ents, water = world.water, B = world.bounds;
  for (let k = 0; k < water.length; k++) {
    const i = water[k], j = i * 6;
    // Bounds first: a crafted map's volumes can each hold a deep tree.
    if (x < B[j] || x > B[j + 3] || y < B[j + 1] || y > B[j + 4] || z < B[j + 2] || z > B[j + 5]) continue;
    if (ents[i].kind === ENT_WATER && entityContents(world, i, HULL_POINT, x, y, z) !== CONTENTS_EMPTY) {
      return ents[i].liquid;
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
