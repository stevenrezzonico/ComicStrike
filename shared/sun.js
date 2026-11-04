// The map's sun, from its `light_environment` entity as GoldSrc's light compiler (hlrad)
// reads it: the yaw from the `angle` key when it is non-zero, else the `angles` yaw; the
// pitch from the `pitch` key when it is non-zero, else the `angles` pitch; the light shines
// along (cos pitch cos yaw, cos pitch sin yaw, sin pitch), so a negative pitch points down.
// Used for the players' sun shadows (client/gl/playermodels.js); our compiler writes one
// for its own sun (shared/bspwriter.js), which it never reads back.

export const SUN_MIN_ELEVATION = 20; // degrees: a lower sun's shadows would run on for hundreds of units
export const SUN_MAX_ELEVATION = 89;

const num = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};

// The unit vector toward the sun of the first `light_environment` in `entities`, or null
// when there is none. Odd pitches clamp: one pointing up (cs_office's `angles 90 0 0`) is
// taken as pointing down by as much (a sign slip), and the elevation is kept within
// SUN_MIN_ELEVATION..SUN_MAX_ELEVATION.
export function sunOf(entities, out = new Float32Array(3)) {
  const e = entities && entities.find((x) => x.classname === 'light_environment');
  if (!e) return null;
  const angles = (e.angles || '').trim().split(/\s+/).map(num);
  let yaw = num(e.angle);
  if (!yaw) yaw = angles[1] || 0;
  let pitch = num(e.pitch);
  if (!pitch) pitch = angles[0] || 0;
  pitch = ((pitch % 360) + 540) % 360 - 180; // -180..180
  if (Math.abs(pitch) > 90) { // past straight up or down: the same line, facing the other way
    pitch = (pitch > 0 ? 180 : -180) - pitch;
    yaw += 180;
  }
  const elevation = Math.min(SUN_MAX_ELEVATION, Math.max(SUN_MIN_ELEVATION, Math.abs(pitch)));
  const el = elevation * Math.PI / 180, yr = yaw * Math.PI / 180;
  // Toward the sun: against the light's direction, so up.
  out[0] = -Math.cos(el) * Math.cos(yr);
  out[1] = -Math.cos(el) * Math.sin(yr);
  out[2] = Math.sin(el);
  return out;
}

// The `light_environment` keys for a sun toward `dir` (a unit vector, z > 0) with color
// `rgb` (0..255) and brightness: pitch and yaw rounded to 0.01 degrees.
export function sunEntity(dir, rgb, brightness = 200) {
  const pitch = -Math.asin(Math.min(1, dir[2])) * 180 / Math.PI;
  let yaw = Math.atan2(-dir[1], -dir[0]) * 180 / Math.PI;
  if (yaw < 0) yaw += 360;
  const p = pitch.toFixed(2), y = yaw.toFixed(2);
  return {
    classname: 'light_environment',
    pitch: p,
    angles: `${p} ${y} 0`,
    _light: `${rgb.map(Math.round).join(' ')} ${brightness}`,
  };
}

// The matrix (column-major) that flattens a point along `sun` (toward the sun, z > 0)
// onto the plane z = h: its shadow there. Points under the plane come out on it too.
export function shadowMatrix(out, sun, h) {
  const ax = sun[0] / sun[2], ay = sun[1] / sun[2];
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = -ax; out[9] = -ay; out[10] = 0; out[11] = 0;
  out[12] = ax * h; out[13] = ay * h; out[14] = h; out[15] = 1;
  return out;
}
