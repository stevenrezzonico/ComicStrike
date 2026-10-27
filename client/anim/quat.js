// Quaternion helpers [x, y, z, w] for the skeleton, writing into caller-owned arrays at
// an offset (o) so poses live in flat Float32Arrays: no allocation per frame.

export function identity(q, o = 0) {
  q[o] = 0;
  q[o + 1] = 0;
  q[o + 2] = 0;
  q[o + 3] = 1;
  return q;
}

// out = a * b (apply b, then a).
export function mul(out, oo, a, ao, b, bo) {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

// out = conjugate (the inverse of a unit quaternion).
export function conj(out, oo, a, ao) {
  out[oo] = -a[ao];
  out[oo + 1] = -a[ao + 1];
  out[oo + 2] = -a[ao + 2];
  out[oo + 3] = a[ao + 3];
  return out;
}

// Rotation of `angle` radians about the unit axis (x, y, z).
export function fromAxisAngle(out, oo, x, y, z, angle) {
  const s = Math.sin(angle / 2);
  out[oo] = x * s;
  out[oo + 1] = y * s;
  out[oo + 2] = z * s;
  out[oo + 3] = Math.cos(angle / 2);
  return out;
}

// Rotation from Euler angles in degrees, applied yaw (Z), then pitch (Y), then roll (X)
// in the parent frame: q = qz * qy * qx (GoldSrc angle order).
export function fromEuler(out, oo, pitch, yaw, roll) {
  const d = Math.PI / 360;
  const cp = Math.cos(pitch * d), sp = Math.sin(pitch * d);
  const cy = Math.cos(yaw * d), sy = Math.sin(yaw * d);
  const cr = Math.cos(roll * d), sr = Math.sin(roll * d);
  out[oo] = cy * cp * sr - sy * sp * cr;
  out[oo + 1] = cy * sp * cr + sy * cp * sr;
  out[oo + 2] = sy * cp * cr - cy * sp * sr;
  out[oo + 3] = cy * cp * cr + sy * sp * sr;
  return out;
}

export function normalize(q, o) {
  const l = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]) || 1;
  q[o] /= l;
  q[o + 1] /= l;
  q[o + 2] /= l;
  q[o + 3] /= l;
  return q;
}

// Normalized lerp along the shorter arc: out = a..b at t.
export function nlerp(out, oo, a, ao, b, bo, t) {
  const dot = a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3];
  const s = dot < 0 ? -t : t, u = 1 - t;
  for (let i = 0; i < 4; i++) out[oo + i] = a[ao + i] * u + b[bo + i] * s;
  return normalize(out, oo);
}

// Rotates vector v (at vo) by q (at qo) into out (at oo).
export function rotate(out, oo, q, qo, v, vo) {
  const qx = q[qo], qy = q[qo + 1], qz = q[qo + 2], qw = q[qo + 3];
  const vx = v[vo], vy = v[vo + 1], vz = v[vo + 2];
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[oo] = vx + qw * tx + (qy * tz - qz * ty);
  out[oo + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[oo + 2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}
