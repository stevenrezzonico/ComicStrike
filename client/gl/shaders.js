// GLSL sources. Material ids must match shared/materials.js (MAT).

export const WORLD_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec2 a_lm;
layout(location=3) in vec4 a_nrm;
layout(location=4) in vec4 a_col;
layout(location=5) in uvec4 a_mat;

uniform mat4 u_viewProj;
uniform uvec4 u_broken[2]; // 256-bit mask of broken breakable slots (a_mat.w)
uniform uint u_moverBase; // slots above it are doors and buttons (shared/doors.js)
uniform vec4 u_movers[192]; // their 3x4 model -> world matrices, MAX_MOVERS x 3 rows

out vec3 v_pos;
out vec2 v_uv;
out vec2 v_lm;
out vec3 v_nrm;
out vec4 v_col;
flat out uvec3 v_mat;

void main() {
  uint slot = a_mat.w;
  uint word = u_broken[slot >> 7u][(slot >> 5u) & 3u];
  if (slot != 0u && (word & (1u << (slot & 31u))) != 0u) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // outside the clip volume: triangle dropped
    return;
  }
  vec3 pos = a_pos, nrm = a_nrm.xyz;
  if (slot > u_moverBase) {
    int m = int(slot - u_moverBase - 1u) * 3;
    vec4 p = vec4(a_pos, 1.0), r0 = u_movers[m], r1 = u_movers[m + 1], r2 = u_movers[m + 2];
    pos = vec3(dot(r0, p), dot(r1, p), dot(r2, p));
    nrm = vec3(dot(r0.xyz, nrm), dot(r1.xyz, nrm), dot(r2.xyz, nrm));
  }
  v_pos = pos;
  v_uv = a_uv;
  v_lm = a_lm;
  v_nrm = nrm;
  v_col = a_col;
  v_mat = a_mat.xyz;
  gl_Position = u_viewProj * vec4(pos, 1.0);
}`;

export const WORLD_FS = `#version 300 es
precision highp float;

in vec3 v_pos;
in vec2 v_uv;
in vec2 v_lm;
in vec3 v_nrm;
in vec4 v_col;
flat in uvec3 v_mat;

uniform sampler2D u_lightmap;
uniform vec3 u_eye;
uniform float u_time;
uniform vec3 u_fogColor;

out vec4 o_color;

const uint FLAG_ALPHATEST = 1u;
const uint FLAG_FULLBRIGHT = 2u;

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Smooth value noise: reads like a heavily mip-biased texture (LodAdj=5).
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1, 0)), c = h21(i + vec2(0, 1)), d = h21(i + 1.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Distance to the nearest edge of the unit cell.
float edge(vec2 f) { return min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)); }

vec3 surface(uint mat, vec2 uv, vec3 base, float seed, uint flags) {
  vec2 s = uv + seed * 7.13;
  if (mat == 0u) { // PLASTER
    return base * (0.92 + 0.14 * vnoise(s * 3.0));
  } else if (mat == 1u) { // CONCRETE
    return base * (0.82 + 0.16 * vnoise(s * 4.0) + 0.06 * vnoise(s * 15.0));
  } else if (mat == 2u) { // BRICK
    vec2 b = uv * vec2(2.0, 4.0);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    vec2 f = fract(b);
    float m = smoothstep(0.03, 0.11, min(min(f.x, 1.0 - f.x) * 0.5, min(f.y, 1.0 - f.y)));
    vec3 brick = base * (0.8 + 0.3 * h21(floor(b) + seed));
    return mix(vec3(0.62, 0.6, 0.56) * 255.0 * 0.75, brick, m);
  } else if (mat == 3u) { // STONE
    vec2 b = uv * vec2(2.0, 3.0);
    b.x += h21(vec2(floor(b.y), seed)) ;
    vec2 f = fract(b);
    float m = smoothstep(0.02, 0.09, edge(f));
    float v = 0.75 + 0.35 * h21(floor(b) + seed) + 0.1 * vnoise(s * 9.0);
    return base * v * mix(0.55, 1.0, m);
  } else if (mat == 4u) { // GROUND
    return base * (0.78 + 0.3 * vnoise(s * 3.0) + 0.12 * vnoise(s * 11.0));
  } else if (mat == 5u) { // FOLIAGE
    float n = vnoise(s * 6.0);
    if ((flags & FLAG_ALPHATEST) != 0u && n < 0.42) discard;
    return base * (0.65 + 0.6 * n);
  } else if (mat == 6u) { // WOOD
    float p = uv.y * 4.0;
    float f = fract(p);
    float seam = smoothstep(0.0, 0.07, f) * smoothstep(1.0, 0.93, f);
    float grain = vnoise(vec2(uv.x * 3.0, uv.y * 36.0) + seed);
    return base * (0.8 + 0.25 * h21(vec2(floor(p), seed))) * (0.85 + 0.2 * grain) * mix(0.6, 1.0, seam);
  } else if (mat == 7u) { // CRATE
    vec2 f = fract(uv);
    float frame = smoothstep(0.07, 0.11, edge(f));
    float brace = smoothstep(0.035, 0.07, abs(f.x - f.y));
    float plank = mix(0.75, 1.0, smoothstep(0.0, 0.06, fract(f.y * 4.0)));
    vec3 inner = base * plank * (0.9 + 0.15 * vnoise(s * 8.0));
    return mix(base * 0.62, inner, frame * brace);
  } else if (mat == 8u) { // METAL
    vec2 f = fract(uv * vec2(1.0, 2.0));
    float seam = smoothstep(0.0, 0.04, edge(f));
    float streak = vnoise(vec2(uv.x * 10.0, uv.y * 1.5) + seed);
    return base * (0.8 + 0.25 * streak) * mix(0.6, 1.0, seam);
  } else if (mat == 9u) { // GRATE
    vec2 g = fract(uv * 8.0);
    bool bar = min(g.x, g.y) < 0.28;
    if (!bar && (flags & FLAG_ALPHATEST) != 0u) discard;
    return base * (bar ? 1.0 : 0.45);
  } else if (mat == 10u) { // WINDOW
    vec2 g = fract(uv * 2.0);
    if (edge(g) < 0.07) return base * 1.1;
    float sheen = 0.6 + 0.4 * smoothstep(0.2, 0.9, g.y + 0.3 * g.x);
    return vec3(38.0, 50.0, 66.0) * sheen;
  } else if (mat == 11u) { // WATER
    float n = vnoise(v_pos.xy * 0.02 + u_time * vec2(0.3, 0.2)) + vnoise(v_pos.yx * 0.035 - u_time * 0.25);
    return base * (0.75 + 0.35 * n);
  } else if (mat == 12u) { // TILE
    vec2 b = uv * 4.0;
    vec2 f = fract(b);
    float m = smoothstep(0.02, 0.06, edge(f));
    float c = mod(floor(b.x) + floor(b.y), 2.0);
    return base * mix(0.6, 0.9 + 0.12 * c, m);
  } else if (mat == 13u) { // FABRIC
    vec2 f = fract(uv);
    float border = step(0.08, edge(f));
    return base * (0.85 + 0.2 * vnoise(s * 12.0)) * mix(1.35, 1.0, border);
  } else if (mat == 14u) { // LIGHT
    vec2 f = fract(uv);
    return base * (0.85 + 0.25 * smoothstep(0.0, 0.4, edge(f)));
  } else if (mat == 15u) { // DOOR
    vec2 f = fract(uv);
    vec2 p = vec2(f.x, fract(f.y * 2.0));
    float inset = smoothstep(0.12, 0.16, edge(p)) - smoothstep(0.16, 0.2, edge(p)) * 0.5;
    return base * (0.85 + 0.15 * vnoise(s * 6.0)) * (1.0 - 0.3 * inset);
  } else if (mat == 16u) { // DECAL (signs, posters, books)
    vec2 c = floor(uv * 4.0);
    vec3 tint = vec3(h21(c + seed), h21(c + seed + 3.1), h21(c + seed + 7.7));
    vec3 col = mix(base, tint * 220.0, 0.45);
    return edge(fract(uv)) < 0.06 ? base * 0.5 : col;
  } else if (mat == 17u) { // TECH
    vec2 c = floor(uv * 6.0);
    float on = step(0.72, h21(c + seed + floor(u_time * 1.5 * h21(c))));
    vec3 led = mix(vec3(60, 220, 90), vec3(240, 160, 40), h21(c + 9.0));
    return mix(base * (0.85 + 0.15 * vnoise(s * 5.0)), led, on * step(0.15, edge(fract(uv * 6.0))));
  } else if (mat == 18u) { // ROOF
    float p = uv.y * 6.0;
    float off = floor(uv.x * 4.0 + 0.5 * mod(floor(p), 2.0));
    return base * (0.65 + 0.4 * fract(p)) * (0.9 + 0.2 * h21(vec2(off, floor(p))));
  }
  // SNOW
  return base * (0.94 + 0.06 * vnoise(s * 4.0));
}

void main() {
  uint mat = v_mat.x, flags = v_mat.y;
  float seed = float(v_mat.z) / 255.0;
  vec3 base = v_col.rgb * 255.0;

  vec3 albedo = surface(mat, v_uv, base, seed, flags) / 255.0;

  vec3 light;
  if ((flags & FLAG_FULLBRIGHT) != 0u) {
    light = vec3(1.25);
  } else {
    // GoldSrc lightmaps are stored dark; lift them roughly like lightgamma/brightness.
    vec3 lm = texture(u_lightmap, v_lm).rgb;
    light = pow(lm, vec3(0.6)) * 1.45;
  }

  vec3 col = albedo * light;
  float dist = length(v_pos - u_eye);
  col = mix(col, u_fogColor, smoothstep(1500.0, 9000.0, dist) * 0.45);
  o_color = vec4(col, v_col.a);
}`;

// Sky. Two vertex shaders feed one fragment shader with a world-space view ray:
// SKY_MESH_VS draws the map's sky brushes (writing depth, so they hide what lies
// behind them, as in GoldSrc); SKY_FILL_VS is a fullscreen triangle on the far plane
// that fills any pixel nothing else covered.
export const SKY_MESH_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
uniform mat4 u_viewProj;
uniform vec3 u_eye;
out vec3 v_dir;
void main() {
  v_dir = a_pos - u_eye;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

export const SKY_FILL_VS = `#version 300 es
uniform mat4 u_invViewProj;
uniform vec3 u_eye;
out vec3 v_dir;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  // Far-plane points share one w, so this ray is affine in screen space and
  // interpolates exactly across the triangle.
  vec4 far = u_invViewProj * vec4(p, 1.0, 1.0);
  v_dir = far.xyz / far.w - u_eye;
  gl_Position = vec4(p, 0.99999, 1.0); // just inside the far plane: fills only empty pixels
}`;

export const SKY_FS = `#version 300 es
precision highp float;
in vec3 v_dir;
uniform vec3 u_horizon;
uniform vec3 u_zenith;
uniform float u_time;
out vec4 o_color;

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + 1.0), f.x), f.y);
}

void main() {
  vec3 dir = normalize(v_dir);
  vec3 col = mix(u_horizon, u_zenith, pow(clamp(dir.z, 0.0, 1.0), 0.6));

  // Clouds on a dome rather than a plane: the lookup stays bounded at the horizon.
  vec2 p = dir.xy / max(dir.z + 0.3, 0.05) * 1.6 + u_time * 0.01;
  float c = smoothstep(0.45, 0.8, vnoise(p) * 0.65 + vnoise(p * 2.7) * 0.35);
  // Where one pixel spans a whole noise cell the pattern would alias and shimmer
  // with camera motion; blend toward average coverage instead.
  float footprint = length(fwidth(p)) * 2.7;
  c = mix(c, 0.18, smoothstep(0.3, 0.8, footprint));
  col = mix(col, vec3(0.95), c * 0.7 * smoothstep(-0.02, 0.2, dir.z));
  o_color = vec4(col, 1.0);
}`;

// Bullet holes: world-space quads, procedural scorch disc.
export const DECAL_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_uvs; // uv in [-1, 1], seed
uniform mat4 u_viewProj;
out vec3 v_uvs;
void main() {
  v_uvs = a_uvs;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

export const DECAL_FS = `#version 300 es
precision mediump float;
in vec3 v_uvs;
out vec4 o_color;
void main() {
  float r = length(v_uvs.xy);
  float a = atan(v_uvs.y, v_uvs.x);
  float edge = 0.75 + 0.25 * sin(a * 5.0 + v_uvs.z * 40.0);
  if (r > edge) discard;
  float core = 1.0 - smoothstep(0.25, 0.35, r);
  o_color = vec4(vec3(0.05 + 0.08 * (1.0 - core)), mix(0.55, 0.95, core));
}`;

// Breakable debris: one unit cube, instanced (position, scale, euler rotation, color).
export const DEBRIS_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec3 i_pos;
layout(location=3) in vec3 i_scale;
layout(location=4) in vec3 i_rot;
layout(location=5) in vec3 i_col;
uniform mat4 u_viewProj;
out vec3 v_col;
out vec3 v_nrm;
void main() {
  vec3 c = cos(i_rot), s = sin(i_rot);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, c.x, s.x, 0.0, -s.x, c.x);
  mat3 ry = mat3(c.y, 0.0, -s.y, 0.0, 1.0, 0.0, s.y, 0.0, c.y);
  mat3 rz = mat3(c.z, s.z, 0.0, -s.z, c.z, 0.0, 0.0, 0.0, 1.0);
  mat3 r = rz * ry * rx;
  v_col = i_col;
  v_nrm = r * a_nrm;
  gl_Position = u_viewProj * vec4(i_pos + r * (a_pos * i_scale), 1.0);
}`;

export const DEBRIS_FS = `#version 300 es
precision mediump float;
in vec3 v_col;
in vec3 v_nrm;
out vec4 o_color;
void main() {
  float diff = max(dot(normalize(v_nrm), normalize(vec3(0.35, 0.25, 0.9))), 0.0);
  o_color = vec4(v_col * (0.45 + 0.6 * diff), 1.0);
}`;

// Crosshair: four arms and a dot generated from gl_VertexID (6 vertices each), in
// pixels. u_parts bits: 0 right, 1 left, 2 bottom, 3 top arm, 4 dot.
export const CROSSHAIR_VS = `#version 300 es
uniform vec2 u_screen;
uniform float u_gap;
uniform float u_len;
uniform float u_thick;
uniform int u_parts;
void main() {
  int part = gl_VertexID / 6;
  int k = gl_VertexID % 6;
  if ((u_parts & (1 << part)) == 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 c = vec2(k == 1 || k == 4 || k == 5 ? 1.0 : 0.0, k == 2 || k == 3 || k == 5 ? 1.0 : 0.0);
  vec2 lo, hi;
  float h0 = -floor(u_thick * 0.5), h1 = h0 + u_thick; // whole pixels around the center
  if (part == 0) { lo = vec2(u_gap, h0); hi = vec2(u_gap + u_len, h1); }
  else if (part == 1) { lo = vec2(-u_gap - u_len, h0); hi = vec2(-u_gap, h1); }
  else if (part == 2) { lo = vec2(h0, -u_gap - u_len); hi = vec2(h1, -u_gap); }
  else if (part == 3) { lo = vec2(h0, u_gap); hi = vec2(h1, u_gap + u_len); }
  else { lo = vec2(h0); hi = vec2(h1); }
  vec2 px = floor(u_screen * 0.5) + mix(lo, hi, c);
  gl_Position = vec4(px / u_screen * 2.0 - 1.0, 0.0, 1.0);
}`;

export const CROSSHAIR_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o_color;
void main() {
  o_color = u_color;
}`;

// Skinned models (client/gl/skinned.js): every vertex follows one bone. Cartoon shading:
// two flat tones split by a crisp terminator, times the map's light at the model.
export const SKINNED_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in uint a_bone;
layout(location=3) in vec3 a_col;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform mat4 u_bones[24];
out vec3 v_nrm;
out vec3 v_col;
void main() {
  mat4 m = u_model * u_bones[a_bone];
  v_nrm = mat3(m) * a_nrm;
  v_col = a_col;
  gl_Position = u_viewProj * m * vec4(a_pos, 1.0);
}`;

export const SKINNED_FS = `#version 300 es
precision mediump float;
in vec3 v_nrm;
in vec3 v_col;
uniform vec3 u_light; // map light at the model, lifted like the world's
uniform vec3 u_lightDir;
uniform float u_emissive; // 1: unlit glow (muzzle flash, LEDs)
out vec4 o_color;
void main() {
  float d = dot(normalize(v_nrm), u_lightDir);
  float tone = mix(0.62, 1.0, smoothstep(-0.05, 0.05, d));
  o_color = vec4(mix(v_col * tone * u_light, v_col * 1.6, u_emissive), 1.0);
}`;
