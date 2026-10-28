// Player skeleton (CS:GO bone names), poses and the matrices that skin a mesh built in
// the bind pose (client/gl/meshkit.js). Model space is GoldSrc's: X forward, Y left,
// Z up, feet at the origin; the bind pose is a T-pose with identity rotations, so a
// bone's skin matrix is its world transform applied to (vertex - bind position).
// Everything works in preallocated Float32Arrays.

import * as Q from './quat.js';

// [name, parent, bind position (model space, units)] for a 72-unit player (CS:GO's
// standing eye height is 64).
const BONES = [
  ['pelvis', null, [0, 0, 38]],
  ['spine_0', 'pelvis', [0, 0, 42]],
  ['spine_1', 'spine_0', [0, 0, 46.5]],
  ['spine_2', 'spine_1', [0, 0, 51]],
  ['spine_3', 'spine_2', [0, 0, 55.5]],
  ['neck_0', 'spine_3', [0, 0, 60]],
  ['head_0', 'neck_0', [0, 0, 63.5]],
  ['clavicle_L', 'spine_3', [0, 2, 57.5]],
  ['arm_upper_L', 'clavicle_L', [0, 7.5, 57.5]],
  ['arm_lower_L', 'arm_upper_L', [0, 19.5, 57.5]],
  ['hand_L', 'arm_lower_L', [0, 31, 57.5]],
  ['clavicle_R', 'spine_3', [0, -2, 57.5]],
  ['arm_upper_R', 'clavicle_R', [0, -7.5, 57.5]],
  ['arm_lower_R', 'arm_upper_R', [0, -19.5, 57.5]],
  ['hand_R', 'arm_lower_R', [0, -31, 57.5]],
  ['leg_upper_L', 'pelvis', [0, 4, 36.5]],
  ['leg_lower_L', 'leg_upper_L', [0, 4, 20]],
  ['ankle_L', 'leg_lower_L', [0, 4, 3.5]],
  ['leg_upper_R', 'pelvis', [0, -4, 36.5]],
  ['leg_lower_R', 'leg_upper_R', [0, -4, 20]],
  ['ankle_R', 'leg_lower_R', [0, -4, 3.5]],
];

export const MAX_BONES = 24; // the skinned shader's bone array size

export class Skeleton {
  constructor(bones = BONES) {
    this.count = bones.length;
    this.names = bones.map((b) => b[0]);
    this.index = Object.fromEntries(this.names.map((n, i) => [n, i]));
    this.parent = new Int8Array(bones.map((b) => (b[1] === null ? -1 : this.index[b[1]])));
    this.bind = new Float32Array(bones.flatMap((b) => b[2])); // model-space bind positions
    this.offset = new Float32Array(this.count * 3); // bind position relative to the parent
    for (let i = 0; i < this.count; i++) {
      const p = this.parent[i];
      if (p >= i) throw new Error('bones must follow their parent');
      for (let c = 0; c < 3; c++) this.offset[i * 3 + c] = this.bind[i * 3 + c] - (p >= 0 ? this.bind[p * 3 + c] : 0);
    }
  }

  // Bone index -> its left/right twin (itself on the center line), for mirrored meshes.
  get mirror() {
    this._mirror ??= Uint8Array.from(this.names, (n, i) => {
      const twin = n.endsWith('_L') ? n.slice(0, -2) + '_R' : n.endsWith('_R') ? n.slice(0, -2) + '_L' : n;
      return this.index[twin] ?? i;
    });
    return this._mirror;
  }

  bone(name) {
    const i = this.index[name];
    if (i === undefined) throw new Error(`no bone ${name}`);
    return i;
  }
}

export const PLAYER_SKELETON = new Skeleton();

// First-person arms (client/anim/viewanim.js): bound pointing forward (+x) from shoulders
// beside the eye, palms facing in; the animator moves the shoulders per hold. Longer
// than the player's arms, like CS:GO's viewmodel arms, to reach a rifle's handguard.
export const VIEW_ARM_UPPER = 13.5;
export const VIEW_ARM_LOWER = 13.5;
export const ARMS_SKELETON = new Skeleton([
  ['view', null, [0, 0, 0]],
  ['arm_upper_L', 'view', [0, 6, 0]],
  ['arm_lower_L', 'arm_upper_L', [VIEW_ARM_UPPER, 6, 0]],
  ['hand_L', 'arm_lower_L', [VIEW_ARM_UPPER + VIEW_ARM_LOWER, 6, 0]],
  ['arm_upper_R', 'view', [0, -6, 0]],
  ['arm_lower_R', 'arm_upper_R', [VIEW_ARM_UPPER, -6, 0]],
  ['hand_R', 'arm_lower_R', [VIEW_ARM_UPPER + VIEW_ARM_LOWER, -6, 0]],
]);

// Local rotation (quaternion) and translation of every bone, plus the derived world
// transforms (model space) and skin matrices.
export class Pose {
  constructor(skel) {
    this.skel = skel;
    this.rot = new Float32Array(skel.count * 4);
    this.pos = new Float32Array(skel.count * 3);
    this.wrot = new Float32Array(skel.count * 4); // world rotation
    this.wpos = new Float32Array(skel.count * 3); // world position
    this.skin = new Float32Array(MAX_BONES * 16);
    this.reset();
  }

  // The bind pose.
  reset() {
    for (let i = 0; i < this.skel.count; i++) Q.identity(this.rot, i * 4);
    this.pos.set(this.skel.offset);
    return this;
  }

  copy(src) {
    this.rot.set(src.rot);
    this.pos.set(src.pos);
    return this;
  }

  // Rotates bone i by Euler degrees in its parent frame, on top of its current rotation.
  turn(i, pitch, yaw, roll) {
    Q.fromEuler(tmpQ, 0, pitch, yaw, roll);
    Q.mul(this.rot, i * 4, tmpQ, 0, this.rot, i * 4);
    return this;
  }

  // this = a..b at t (rotations nlerped, translations lerped); a or b may be this.
  blend(a, b, t) {
    for (let i = 0; i < this.skel.count; i++) Q.nlerp(this.rot, i * 4, a.rot, i * 4, b.rot, i * 4, t);
    for (let i = 0; i < this.pos.length; i++) this.pos[i] = a.pos[i] + (b.pos[i] - a.pos[i]) * t;
    return this;
  }

  // World transforms from the local ones (parents come first).
  solve() {
    const { parent, count } = this.skel;
    for (let i = 0; i < count; i++) {
      const p = parent[i];
      if (p < 0) {
        for (let c = 0; c < 4; c++) this.wrot[i * 4 + c] = this.rot[i * 4 + c]; // (subarray would allocate)
        for (let c = 0; c < 3; c++) this.wpos[i * 3 + c] = this.pos[i * 3 + c];
        continue;
      }
      Q.mul(this.wrot, i * 4, this.wrot, p * 4, this.rot, i * 4);
      Q.rotate(this.wpos, i * 3, this.wrot, p * 4, this.pos, i * 3);
      for (let c = 0; c < 3; c++) this.wpos[i * 3 + c] += this.wpos[p * 3 + c];
    }
    return this;
  }

  // Skin matrices (column-major mat4 per bone) from the world transforms: a bind-pose
  // vertex v of bone i goes to wrot_i * (v - bind_i) + wpos_i. Call solve() first.
  skinMatrices() {
    const { bind, count } = this.skel;
    const m = this.skin;
    for (let i = 0; i < count; i++) {
      const x = this.wrot[i * 4], y = this.wrot[i * 4 + 1], z = this.wrot[i * 4 + 2], w = this.wrot[i * 4 + 3];
      const o = i * 16;
      m[o] = 1 - 2 * (y * y + z * z);
      m[o + 1] = 2 * (x * y + z * w);
      m[o + 2] = 2 * (x * z - y * w);
      m[o + 3] = 0;
      m[o + 4] = 2 * (x * y - z * w);
      m[o + 5] = 1 - 2 * (x * x + z * z);
      m[o + 6] = 2 * (y * z + x * w);
      m[o + 7] = 0;
      m[o + 8] = 2 * (x * z + y * w);
      m[o + 9] = 2 * (y * z - x * w);
      m[o + 10] = 1 - 2 * (x * x + y * y);
      m[o + 11] = 0;
      const bx = bind[i * 3], by = bind[i * 3 + 1], bz = bind[i * 3 + 2];
      m[o + 12] = this.wpos[i * 3] - (m[o] * bx + m[o + 4] * by + m[o + 8] * bz);
      m[o + 13] = this.wpos[i * 3 + 1] - (m[o + 1] * bx + m[o + 5] * by + m[o + 9] * bz);
      m[o + 14] = this.wpos[i * 3 + 2] - (m[o + 2] * bx + m[o + 6] * by + m[o + 10] * bz);
      m[o + 15] = 1;
    }
    return m;
  }

  // Two-bone limb solve: rotates bones a (shoulder / hip) and b (elbow / knee) so the
  // end bone c (hand / ankle) reaches target (tx, ty, tz) in model space, or points at it
  // when out of reach. The joint bends toward the pole direction (px, py, pz). World
  // transforms must be current (solve()); they are updated again on return.
  reach(a, b, c, tx, ty, tz, px, py, pz) {
    const W = this.wpos;
    const ax = W[a * 3], ay = W[a * 3 + 1], az = W[a * 3 + 2];
    const bx = W[b * 3], by = W[b * 3 + 1], bz = W[b * 3 + 2];
    const cx = W[c * 3], cy = W[c * 3 + 1], cz = W[c * 3 + 2];
    // (Math.sqrt, not Math.hypot: hypot is a builtin call that allocates its result.)
    const abx = bx - ax, aby = by - ay, abz = bz - az, cbx = cx - bx, cby = cy - by, cbz = cz - bz;
    const acx = cx - ax, acy = cy - ay, acz = cz - az, atx = tx - ax, aty = ty - ay, atz = tz - az;
    const lab = Math.sqrt(abx * abx + aby * aby + abz * abz), lcb = Math.sqrt(cbx * cbx + cby * cby + cbz * cbz);
    const eps = 1e-3;
    const lat = Math.min(Math.max(Math.sqrt(atx * atx + aty * aty + atz * atz), eps), lab + lcb - eps);

    // Current and wanted inner angles (law of cosines). Written out: calls taking
    // floating-point arguments box them when not inlined, which this long function
    // often is not.
    const lac = Math.sqrt(acx * acx + acy * acy + acz * acz), lat0 = Math.sqrt(atx * atx + aty * aty + atz * atz);
    const acab0 = clampAcos((acx * abx + acy * aby + acz * abz) / (lac * lab || 1));
    const babc0 = clampAcos(-(abx * cbx + aby * cby + abz * cbz) / (lab * lcb || 1));
    const acat0 = clampAcos((acx * atx + acy * aty + acz * atz) / (lac * lat0 || 1));
    const acab1 = clampAcos((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat));
    const babc1 = clampAcos((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb));

    // Bend axis: perpendicular to the limb and the pole; aim axis: limb to target.
    const V = tmpV;
    cross(V, 0, acx, acy, acz, px, py, pz);
    if (V[0] * V[0] + V[1] * V[1] + V[2] * V[2] < eps * eps) cross(V, 0, acx, acy, acz, abx, aby, abz);
    unit(V, 0);
    cross(V, 3, acx, acy, acz, atx, aty, atz);
    if (V[3] * V[3] + V[4] * V[4] + V[5] * V[5] < eps * eps) V.copyWithin(3, 0, 3);
    unit(V, 3);
    const nx = V[0], ny = V[1], nz = V[2], mx = V[3], my = V[4], mz = V[5];

    // World-space corrections, measured in the current pose: the joint first, then the
    // root (bend, then aim), which carries the joint along.
    Q.fromAxisAngle(tmpR, 0, nx, ny, nz, babc1 - babc0);
    this.applyWorld(b, tmpR, 0);
    Q.fromAxisAngle(tmpR, 0, nx, ny, nz, acab1 - acab0);
    Q.fromAxisAngle(tmpR, 4, mx, my, mz, acat0);
    Q.mul(tmpR, 8, tmpR, 4, tmpR, 0); // aim after bend
    this.applyWorld(a, tmpR, 8);
    return this;
  }

  // Sets bone i's world rotation to q (at qo) by rewriting its local rotation; world
  // transforms must be current and are updated again.
  setWorldRotation(i, q, qo) {
    const p = this.skel.parent[i];
    if (p < 0) for (let c = 0; c < 4; c++) this.rot[i * 4 + c] = q[qo + c];
    else {
      Q.conj(tmpQ, 0, this.wrot, p * 4);
      Q.mul(this.rot, i * 4, tmpQ, 0, q, qo);
    }
    return this.solve();
  }

  // Pre-multiplies bone i's world rotation by r (at ro), rewriting its local rotation.
  applyWorld(i, r, ro) {
    const p = this.skel.parent[i];
    Q.mul(tmpQ, 0, r, ro, this.wrot, i * 4); // new world rotation
    if (p < 0) for (let c = 0; c < 4; c++) this.rot[i * 4 + c] = tmpQ[c];
    else {
      Q.conj(tmpQ, 4, this.wrot, p * 4);
      Q.mul(this.rot, i * 4, tmpQ, 4, tmpQ, 0);
    }
    Q.normalize(this.rot, i * 4);
    this.solve();
  }
}

const tmpQ = new Float32Array(8);
const tmpR = new Float32Array(12);
const tmpV = new Float32Array(6);

function clampAcos(v) {
  return Math.acos(Math.max(-1, Math.min(1, v)));
}

function cross(out, o, ax, ay, az, bx, by, bz) {
  out[o] = ay * bz - az * by;
  out[o + 1] = az * bx - ax * bz;
  out[o + 2] = ax * by - ay * bx;
}

function unit(v, o) {
  const l = Math.sqrt(v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2]) || 1;
  v[o] /= l;
  v[o + 1] /= l;
  v[o + 2] /= l;
}
