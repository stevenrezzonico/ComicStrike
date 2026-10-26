// GLSL sources. Material ids must match client/materials.js (MAT).

export const WORLD_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec2 a_lm;
layout(location=3) in vec4 a_nrm;
layout(location=4) in vec4 a_col;
layout(location=5) in uvec4 a_mat;

uniform mat4 u_viewProj;

out vec3 v_pos;
out vec2 v_uv;
out vec2 v_lm;
out vec3 v_nrm;
out vec4 v_col;
flat out uvec3 v_mat;

void main() {
  v_pos = a_pos;
  v_uv = a_uv;
  v_lm = a_lm;
  v_nrm = a_nrm.xyz;
  v_col = a_col;
  v_mat = a_mat.xyz;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
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
