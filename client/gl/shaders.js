// GLSL sources. Material ids must match shared/materials.js (MAT).
//
// Comic rendering: every scene shader writes the G-buffer (client/gl/gbuffer.js) through
// GBUFFER's gbuffer(): flat albedo and how lit it is, the normal and an object id, linear
// depth and flags. INK_FS then draws the ink (lines on silhouettes, creases and object
// boundaries) at the G-buffer's resolution, and COMPOSITE_FS prints the frame to the
// canvas from both: the lines, a halftone dot screen for shade, the sky's dots, paper grain.

// Value noise, shared by the surfaces, the sky and the composite.
const NOISE = `
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + 1.0), f.x), f.y);
}`;

// G-buffer flags (alpha of target 2), as GBUFFER_CONSTS declares them.
export const G_FLAGS = { FLAT: 1, SKY: 2, SCREEN: 4, VIEW: 8, CHAR: 16 };

const GBUFFER_CONSTS = `
const float DEPTH_FAR = 16384.0; // linear depth range (units)
const float DEPTH_NEAR = 4.0;    // the near plane: the depth target holds DEPTH_NEAR / depth, 0..1
const uint G_FLAT = 1u;   // unshaded (lights, flames, flashes): no dots, a bolder line
const uint G_SKY = 2u;
const uint G_SCREEN = 4u; // see-through, printed as a dot screen: no ink against what lies behind
const uint G_VIEW = 8u;   // the first-person view: a bolder line, like a foreground figure
const uint G_CHAR = 16u;  // a character (player, hostage, their guns): far away, color over ink
const vec3 INK = vec3(0.09, 0.075, 0.06);`;

// Fragment outputs of every scene shader. The depth target is a half-float RG (1 / depth,
// read as it is by the print's dozen neighbor fetches); without half-float targets
// (DEPTH_PACKED, client/gl/gbuffer.js) 24 bits of an RGBA8, decoded at every fetch.
// (Tried and dropped: one RGBA16F target with depth, flags, id and an octahedral normal,
// a single fetch per neighbor: the 8-byte texels and the normal decode made the ink a
// third slower than the two 4-byte fetches on an Intel Iris Xe.)
const GBUFFER = `
layout(location = 0) out vec4 o_albedo; // rgb albedo, a: light 0..1
layout(location = 1) out vec4 o_normal; // normal * 0.5 + 0.5, a: object id / 255
#ifdef DEPTH_PACKED
layout(location = 2) out vec4 o_depth;  // rgb: linear depth / DEPTH_FAR in 24 bits, a: G_ flags / 255
#else
layout(location = 2) out vec2 o_depth;  // r: DEPTH_NEAR / linear depth, g: G_ flags
#endif
${GBUFFER_CONSTS}
void gbuffer(vec3 albedo, float light, vec3 n, uint id, float depth, uint flags) {
  o_albedo = vec4(albedo, light);
  o_normal = vec4(normalize(n) * 0.5 + 0.5, float(id) / 255.0);
#ifdef DEPTH_PACKED
  float x = floor(clamp(depth / DEPTH_FAR, 0.0, 1.0) * 16777215.0);
  float hi = floor(x / 65536.0);
  x -= hi * 65536.0;
  float mid = floor(x / 256.0);
  o_depth = vec4(hi, mid, x - mid * 256.0, float(flags)) / 255.0;
#else
  o_depth = vec2(DEPTH_NEAR / max(depth, 1.0), float(flags)); // (the first-person view comes nearer than the near plane)
#endif
}`;

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
uniform float u_time;

out vec3 v_pos;
out vec2 v_uv;
out vec2 v_lm;
out vec3 v_nrm;
out vec4 v_col;
out float v_w;
flat out uvec4 v_mat; // material, flags, seed, object id

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
  // Conveyor belts: the texture slides along s (a_nrm.w: SCROLL_UNIT 8ths of a tile a second).
  v_uv = vec2(a_uv.x - u_time * a_nrm.w * (127.0 / 8.0), a_uv.y);
  v_lm = a_lm;
  v_nrm = nrm;
  v_col = a_col;
  // Ids 1..127 by texture and entity: ink where the texture changes, not along the
  // BSP's splits of one surface.
  v_mat = uvec4(a_mat.xyz, (a_mat.z * 7u + slot * 13u) % 127u + 1u);
  gl_Position = u_viewProj * vec4(pos, 1.0);
  // Brush entity faces (FLAG_ENTITY) win over world faces in their plane, and nets,
  // fences (alpha-tested) and breakables / doors over other entities': mappers lay
  // func_walls, func_illusionaries and water flush on the world or each other, which
  // z-fought. ~25 steps of the 24-bit depth buffer a level, a constant in clip space (a
  // polygon offset within the one draw).
  if ((a_mat.y & 8u) != 0u) {
    float level = 1.0 + float(slot != 0u || (a_mat.y & 1u) != 0u);
    gl_Position.z -= 3e-6 * level * gl_Position.w;
  }
  v_w = gl_Position.w;
}`;

export const WORLD_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 v_pos;
in vec2 v_uv;
in vec2 v_lm;
in vec3 v_nrm;
in vec4 v_col;
in float v_w;
flat in uvec4 v_mat;

uniform sampler2D u_lightmap;
uniform float u_time;
uniform float u_zoom; // 90 / fov: the ink fade follows the scope
uniform float u_dot;  // halftone cell (px): see-through surfaces use a finer screen
uniform float u_lightFull; // lifted map light that prints fully lit (no dots), per map
// Flash lights (client/gl/flashes.js): xyz, radius; strength; how many are on.
uniform vec4 u_flash[4];
uniform float u_flashK[4];
uniform int u_flashN;

${GBUFFER}

// CUT drops the fragment. WORLD_SOLID_FS (the opaque bulk) defines SOLID: a shader that can
// discard keeps many GPUs from skipping hidden pixels before shading them, so that one has
// none (its faces never take the branches: alpha-tested and see-through faces draw apart).
#ifdef SOLID
#define CUT
#else
#define CUT discard
#endif

const uint FLAG_ALPHATEST = 1u;
const uint FLAG_FULLBRIGHT = 2u;

${NOISE}

// Distance to the nearest edge of the unit cell.
float edge(vec2 f) { return min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)); }

// Ink on the cell borders of b: half width w in cells per axis (0: none on that axis),
// fw = fwidth(b). Lines thin out where cells get small on screen, so far walls stay calm.
float grid(vec2 b, vec2 w, vec2 fw) {
  vec2 d = abs(fract(b) - 0.5);
  vec2 l = smoothstep(0.5 - w - fw, 0.5 - w, d) * step(0.0001, w);
  return max(l.x, l.y) * (1.0 - smoothstep(0.1, 0.25, max(fw.x, fw.y)));
}

// Ink where v is within w of c (fw = fwidth(v)).
float line(float v, float c, float w, float fw) {
  return 1.0 - smoothstep(w, w + fw, abs(v - c));
}

// A see-through surface as a 15 degree dot screen covering 'cover' of the area.
float screenAt(vec2 frag, float cover, float size) {
  vec2 q = mat2(0.966, -0.259, 0.259, 0.966) * frag / size;
  if (cover > 0.5) return step(sqrt((1.0 - cover) / 3.14159), length(fract(q + 0.5) - 0.5));
  return step(length(fract(q) - 0.5), sqrt(cover / 3.14159));
}

// Comic background art: a flat color with a few ink marks per class (some bricks outlined,
// plank seams, tile grout) and, on floors (up = 1), weathering blotches printed as dots
// ('dark' takes light away).
vec3 surface(uint mat, vec2 uv, vec2 fw, vec3 base, float seed, uint flags, float up, inout float ink,
  inout float dark) {
  vec2 s = uv + seed * 7.13;
  float fwm = max(fw.x, fw.y);
  if (mat == 0u) { // PLASTER
    if (vnoise(s * 3.0) > 0.74) dark = 0.22 * up;
    return base;
  } else if (mat == 1u) { // CONCRETE
    if (vnoise(s * 3.0) > 0.72) dark = 0.22 * up;
    ink = grid(uv, vec2(0.008), fw) * step(0.55, h21(floor(uv) + seed));
    return base;
  } else if (mat == 2u) { // BRICK: only some bricks drawn
    vec2 b = uv * vec2(2.0, 4.0);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    float show = step(0.62, vnoise(floor(b) * 0.45 + seed * 5.0));
    ink = show * grid(b, vec2(0.035, 0.07), fw * vec2(2.0, 4.0));
    if (show > 0.5 && h21(floor(b) + seed) > 0.72) dark = 0.3;
    else if (vnoise(s * 3.0 + 11.0) > 0.74) dark = 0.22 * up;
    return base;
  } else if (mat == 3u) { // STONE
    vec2 b = uv * vec2(2.0, 3.0);
    b.x += h21(vec2(floor(b.y), seed));
    float show = step(0.5, vnoise(floor(b) * 0.5 + seed * 3.0));
    ink = show * grid(b, vec2(0.04), fw * vec2(2.0, 3.0));
    if (h21(floor(b) + seed + 0.5) > 0.75) dark = 0.3;
    return base * (0.94 + 0.12 * h21(floor(b) + seed));
  } else if (mat == 4u) { // GROUND
    if (vnoise(s * 2.5) > 0.7) dark = 0.22 * up;
    return base;
  } else if (mat == 5u) { // FOLIAGE
    float n = vnoise(s * 6.0);
    if ((flags & FLAG_ALPHATEST) != 0u && n < 0.42) CUT;
    if (vnoise(s * 14.0) < 0.3) dark = 0.3;
    return base * (0.9 + 0.3 * step(0.7, n));
  } else if (mat == 6u) { // WOOD: plank seams
    float p = uv.y * 4.0;
    ink = grid(vec2(0.5, p), vec2(0.0, 0.04), vec2(0.0, fw.y * 4.0));
    return base * (0.92 + 0.14 * h21(vec2(floor(p), seed)));
  } else if (mat == 7u) { // CRATE: frame, brace, planks
    vec2 f = fract(uv);
    float e = edge(f);
    float frame = step(e, 0.1);
    ink = max(line(e, 0.1, 0.008, fwm), grid(uv, vec2(0.012), fw));
    if (frame < 0.5) {
      ink = max(ink, line(abs(f.x - f.y), 0.035, 0.006, fwm)); // the diagonal brace's two edges
      ink = max(ink, 0.6 * grid(vec2(0.5, f.y * 4.0), vec2(0.0, 0.02), vec2(0.0, fw.y * 4.0)));
    }
    return base * (frame > 0.5 ? 0.82 : 1.0);
  } else if (mat == 8u) { // METAL: panel seams, streaks
    ink = grid(uv * vec2(1.0, 2.0), vec2(0.012), fw * vec2(1.0, 2.0));
    if (vnoise(vec2(uv.x * 6.0, uv.y * 1.2) + seed) > 0.72) dark = 0.22 * up;
    return base;
  } else if (mat == 9u) { // GRATE
    vec2 g = fract(uv * 8.0);
    bool bar = min(g.x, g.y) < 0.28;
    if (!bar && (flags & FLAG_ALPHATEST) != 0u) CUT;
    if (!bar) dark = 0.6;
    return base * (bar ? 1.0 : 0.4);
  } else if (mat == 10u) { // WINDOW: dark pane, frame, two glints
    vec2 g = fract(uv * 2.0);
    float e = edge(g);
    if (e < 0.07) return base * 1.1;
    ink = line(e, 0.07, 0.01, fwm * 2.0);
    float d = g.x + g.y;
    if (abs(d - 0.9) < 0.07 || abs(d - 1.12) < 0.03) return vec3(0.86, 0.9, 0.94);
    return vec3(0.2, 0.22, 0.28);
  } else if (mat == 11u) { // WATER: drifting contour lines
    float n = vnoise(v_pos.xy * 0.012 + u_time * vec2(0.15, 0.1)) + 0.5 * vnoise(v_pos.yx * 0.03 - u_time * 0.2);
    float c = fract(n * 4.0);
    ink = 0.8 * line(c, 0.5, 0.04, fwidth(n * 4.0));
    dark = -1.0; // printed light: lightmaps under water are dark
    return mix(base, vec3(0.55, 0.78, 0.84), 0.45);
  } else if (mat == 12u) { // TILE: grout
    vec2 b = uv * 4.0;
    ink = grid(b, vec2(0.03), fw * 4.0);
    return base * (0.94 + 0.08 * mod(floor(b.x) + floor(b.y), 2.0));
  } else if (mat == 13u) { // FABRIC: hem
    ink = line(edge(fract(uv)), 0.08, 0.008, fwm);
    if (vnoise(s * 4.0) > 0.7) dark = 0.3 * up;
    return base;
  } else if (mat == 14u) { // LIGHT
    return min(base * 1.15, vec3(1.0));
  } else if (mat == 15u) { // DOOR: two inset panels
    vec2 f = fract(uv);
    vec2 p = vec2(f.x, fract(f.y * 2.0));
    ink = max(line(edge(p), 0.14, 0.01, fwm * 2.0), grid(uv, vec2(0.01), fw));
    if (edge(p) > 0.14 && p.y < 0.3) dark = 0.3;
    return base;
  } else if (mat == 16u) { // DECAL (signs, posters, books): color blocks in a frame
    vec2 c = floor(uv * 4.0);
    vec3 tint = vec3(h21(c + seed), h21(c + seed + 3.1), h21(c + seed + 7.7));
    ink = line(edge(fract(uv)), 0.06, 0.01, fwm);
    return edge(fract(uv)) < 0.06 ? base * 0.6 : mix(base, tint, 0.45);
  } else if (mat == 17u) { // TECH: panel lines and lit cells
    vec2 c = floor(uv * 6.0);
    ink = grid(uv * 2.0, vec2(0.015), fw * 2.0);
    float on = step(0.72, h21(c + seed + floor(u_time * 1.5 * h21(c)))) * step(0.15, edge(fract(uv * 6.0)));
    vec3 led = mix(vec3(0.25, 0.86, 0.35), vec3(0.95, 0.63, 0.16), h21(c + 9.0));
    return mix(base, led, on);
  } else if (mat == 18u) { // ROOF: shingle rows, shadowed under each row
    float p = uv.y * 6.0;
    ink = grid(vec2(0.5, p), vec2(0.0, 0.05), vec2(0.0, fw.y * 6.0));
    if (fract(p) < 0.3) dark = 0.3;
    return base;
  }
  // SNOW
  if (vnoise(s * 1.5) > 0.7) dark = 0.2 * up;
  return base;
}

void main() {
  uint mat = v_mat.x, flags = v_mat.y;
  float seed = float(v_mat.z) / 255.0;
  float ink = 0.0, dark = 0.0;
  float up = step(0.7, normalize(v_nrm).z);
  vec3 albedo = surface(mat, v_uv, fwidth(v_uv), v_col.rgb, seed, flags, up, ink, dark);
  // Printed colors: lighter and a little more saturated than the originals' averages.
  albedo = pow(albedo, vec3(0.8));
  albedo = clamp(mix(vec3(dot(albedo, vec3(0.3, 0.59, 0.11))), albedo, 1.25), 0.0, 1.0);

  uint g = 0u;
  float light = 1.0;
  if ((flags & FLAG_FULLBRIGHT) != 0u) {
    g = G_FLAT;
  } else {
    // GoldSrc lightmaps are stored dark; lift them roughly like lightgamma/brightness.
    // Colored light tints the albedo; how bright it is becomes the dot screen.
    vec3 lm = pow(texture(u_lightmap, v_lm).rgb, vec3(0.6)) * 1.45;
    float lum = dot(lm, vec3(0.3, 0.59, 0.11));
    albedo = clamp(albedo * mix(vec3(1.0), clamp(lm / max(lum, 0.05), 0.0, 2.0), 0.5), 0.0, 1.0);
    light = dark < 0.0 ? 0.8 : pow(clamp(lum / u_lightFull, 0.0, 1.0), 0.8) * (1.0 - dark);
    // Muzzle flashes and explosions: the light rises toward full (the dots there thin out
    // and go), most on faces turned to the flash, with a warm cast.
    float glow = 0.0;
    for (int i = 0; i < u_flashN; i++) {
      vec3 d = u_flash[i].xyz - v_pos;
      float f = smoothstep(0.0, 1.0, 1.0 - length(d) / u_flash[i].w);
      glow += u_flashK[i] * f * (0.6 + 0.4 * max(0.0, dot(normalize(v_nrm), normalize(d))));
    }
    glow = min(glow, 1.0);
    light = mix(light, 1.0, glow);
    albedo = mix(albedo, min(albedo * vec3(1.18, 1.06, 0.82), vec3(1.0)), 0.6 * glow);
  }
  ink *= 1.0 - smoothstep(720.0 * u_zoom, 1600.0 * u_zoom, v_w);
  albedo = mix(albedo, INK, ink);
  light = mix(light, 1.0, ink);

  if (v_col.a < 0.999) { // glass, water: a dot screen over what lies behind
    if (screenAt(gl_FragCoord.xy, v_col.a, max(u_dot * 0.6, 2.0)) < 0.5) CUT;
    g |= G_SCREEN;
  }
  gbuffer(albedo, light, v_nrm, v_mat.w, v_w, g);
}`;

// The opaque bulk of the world: WORLD_FS without a discard (see CUT).
export const WORLD_SOLID_FS = WORLD_FS.replace('#version 300 es\n', '#version 300 es\n#define SOLID\n');

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

// A pale sky the composite screens with blue dots, thicker toward the zenith, and flat
// white clouds (their own id, so they get an ink outline). The cloud noise is a tiling
// texture made at load (cloudNoise in client/gl/renderer.js, CLOUD_PERIOD cells across):
// one fetch, where two octaves of value noise (eight hashes a pixel) were a quarter of the
// GPU frame on a map with a wide sky.
export const CLOUD_PERIOD = 16;
export const SKY_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 v_dir;
uniform vec3 u_horizon;
uniform float u_time;
uniform sampler2D u_clouds;
${GBUFFER}

void main() {
  vec3 dir = normalize(v_dir);
  // Clouds on a dome rather than a plane: the lookup stays bounded at the horizon.
  vec2 p = dir.xy / max(dir.z + 0.3, 0.05) * 1.6 + u_time * 0.01;
  float n = texture(u_clouds, p / ${CLOUD_PERIOD}.0).r;
  // Where one pixel spans a whole noise cell the shapes would alias and shimmer.
  float footprint = length(fwidth(p)) * 2.7;
  bool cloud = n > 0.66 && footprint < 0.5 && dir.z > 0.02;
  float dark = cloud ? 0.0 : clamp(0.06 + dir.z * 0.55, 0.03, 0.42);
  gbuffer(cloud ? vec3(0.98, 0.97, 0.93) : u_horizon, 1.0 - dark, vec3(0.0, 0.0, 1.0), cloud ? 1u : 0u,
    DEPTH_FAR, G_SKY);
}`;

// Contact shadows (client/gl/shadows.js): a disc lying on the floor under each character
// takes light away (the albedo target's alpha only, multiplied down), so the print shows it
// as shade dots like any shadow; no ink, no other target touched.
export const SHADOW_VS = `#version 300 es
layout(location=0) in vec4 a_disc; // x, y, floor height, radius (per instance)
layout(location=1) in float a_dark; // share of the light taken at its middle
uniform mat4 u_viewProj;
out vec2 v_q;
out float v_dark;
void main() {
  vec2 q = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0;
  v_q = q;
  v_dark = a_dark;
  gl_Position = u_viewProj * vec4(a_disc.xy + q * a_disc.w, a_disc.z + 1.0, 1.0);
}`;

export const SHADOW_FS = `#version 300 es
precision mediump float;
in vec2 v_q;
in float v_dark;
layout(location = 0) out vec4 o_albedo;
void main() {
  // A firm edge, slightly soft: it reads as a shape, printed in dots.
  o_albedo = vec4(0.0, 0.0, 0.0, v_dark * (1.0 - smoothstep(0.75, 1.0, length(v_q))));
}`;

// Bullet holes: world-space quads, an ink star written into the albedo only (decals.js).
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
layout(location = 0) out vec4 o_color;
void main() {
  float r = length(v_uvs.xy);
  float a = atan(v_uvs.y, v_uvs.x);
  float spike = pow(abs(sin(a * 3.0 + v_uvs.z * 40.0)), 6.0);
  if (r > 0.38 + 0.55 * spike) discard;
  o_color = vec4(0.09, 0.075, 0.06, 1.0);
}`;

// Breakable debris and hit boxes: one unit cube, instanced (position, scale, euler
// rotation, color).
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
out float v_w;
flat out uint v_id;
void main() {
  vec3 c = cos(i_rot), s = sin(i_rot);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, c.x, s.x, 0.0, -s.x, c.x);
  mat3 ry = mat3(c.y, 0.0, -s.y, 0.0, 1.0, 0.0, s.y, 0.0, c.y);
  mat3 rz = mat3(c.z, s.z, 0.0, -s.z, c.z, 0.0, 0.0, 0.0, 1.0);
  mat3 r = rz * ry * rx;
  v_col = i_col;
  v_nrm = r * a_nrm;
  v_id = 128u + uint(gl_InstanceID % 127);
  gl_Position = u_viewProj * vec4(i_pos + r * (a_pos * i_scale), 1.0);
  v_w = gl_Position.w;
}`;

export const DEBRIS_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 v_col;
in vec3 v_nrm;
in float v_w;
flat in uint v_id;
${GBUFFER}
void main() {
  vec3 n = normalize(v_nrm);
  float d = dot(n, normalize(vec3(0.35, 0.25, 0.9)));
  gbuffer(v_col, d > 0.2 ? 1.0 : d > -0.3 ? 0.6 : 0.35, n, v_id, v_w, 0u);
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

// Skinned models (client/gl/skinned.js): every vertex follows one bone or a blend of two
// (elbows, knees, the spine bend smoothly). Two flat tones
// split by a crisp terminator, times the map's light at the model (never below
// MODEL_FLOOR: characters stay readable in dark corners), a pale rim along the shadow
// side's outline, and per finish (vertex alpha, FINISH in client/gl/meshkit.js) a shine
// streak on metal and polymer, grain strokes on wood, a woven check on patterned cloth. Ids differ per draw and per
// color, so the ink outlines every part of a model (jacket, trousers, gloves).
export const SKINNED_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in uint a_bone;
layout(location=3) in vec4 a_col; // rgb, finish / 255
layout(location=4) in uvec2 a_blend; // second bone, its weight (0..255)
uniform mat4 u_viewProj;
uniform mat4 u_bones[24]; // bone -> world (the model matrix folded in, client/gl/skinned.js)
uniform uint u_id;
out vec3 v_nrm;
out vec3 v_col;
out vec3 v_pos; // world
out vec3 v_obj; // model space (grain)
out float v_w;
flat out uint v_id;
flat out uint v_fin;
void main() {
  // Linear blend skinning between two bones (one when the weight is 0).
  float bw = float(a_blend.y) / 255.0;
  mat4 m = u_bones[a_bone] * (1.0 - bw) + u_bones[a_blend.x] * bw;
  v_nrm = mat3(m) * a_nrm;
  v_col = a_col.rgb;
  v_fin = uint(a_col.a * 255.0 + 0.5);
  v_obj = a_pos;
  uvec3 c = uvec3(a_col.rgb * 255.0 + 0.5);
  v_id = (u_id * 37u + c.r * 7u + c.g * 13u + c.b * 29u) % 127u + 128u;
  vec4 w = m * vec4(a_pos, 1.0);
  v_pos = w.xyz;
  gl_Position = u_viewProj * w;
  v_w = gl_Position.w;
}`;

export const SKINNED_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 v_nrm;
in vec3 v_col;
in vec3 v_pos;
in vec3 v_obj;
in float v_w;
flat in uint v_id;
flat in uint v_fin;
uniform vec3 u_light; // map light at the model, lifted like the world's
uniform vec3 u_lightDir;
uniform vec3 u_eye;   // camera position in the draw's space
uniform float u_emissive; // 1: unlit glow (muzzle flash, LEDs, flames)
uniform float u_white;    // 0..1 toward white (spawn protection's pulse)
uniform float u_lightFull; // lifted light that prints fully lit (per map, Renderer.loadMap)
uniform uint u_flags;      // G_ flags for every pixel of the draw (G_VIEW: first person)
const float MODEL_FLOOR = 0.55; // models print at least this lit
const uint FIN_METAL = 2u, FIN_POLYMER = 3u, FIN_WOOD = 4u, FIN_PATTERN = 5u;
${NOISE}
${GBUFFER}
void main() {
  vec3 n = normalize(v_nrm);
  if (u_emissive > 0.5) {
    gbuffer(min(v_col * 1.25, vec3(1.0)), 1.0, n, v_id, v_w, G_FLAT | u_flags);
    return;
  }
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(u_eye - v_pos);
  float lum = dot(u_light, vec3(0.3, 0.59, 0.11));
  vec3 albedo = clamp(v_col * mix(vec3(1.0), clamp(u_light / max(lum, 0.05), 0.0, 2.0), 0.5), 0.0, 1.0);
  float lit = clamp(max(lum / u_lightFull, MODEL_FLOOR), 0.0, 1.0);
  float ndl = dot(n, u_lightDir);
  // Small on screen (a far figure, a few units a pixel): the detail (two tones, rim, shine)
  // is only speckle there, so it fades to one flat tone and the silhouette carries it.
  float small = smoothstep(1.2, 3.0, length(fwidth(v_pos)));
  float light = mix(ndl > 0.0 ? lit : 0.6 * lit, 0.85 * lit, small);
  // Rim: a pale band along the outline on the shadow side.
  float rim = smoothstep(0.68, 0.76, 1.0 - max(dot(n, V), 0.0)) * step(ndl, 0.0) * (1.0 - small);
  light = mix(light, lit, rim);
  albedo = mix(albedo, min(albedo * 1.35 + 0.08, vec3(1.0)), rim);
  if (v_fin == FIN_METAL || v_fin == FIN_POLYMER) {
    // Shine: a blue-grey sheen toward the light, a hard white streak at its peak. A flat
    // face (its normal does not bend) would turn white all over: it gets two diagonal
    // bars instead.
    float h = dot(n, normalize(u_lightDir + V));
    float curved = smoothstep(0.004, 0.03, length(fwidth(n)));
    float sheen = smoothstep(0.8, 0.84, h) * (v_fin == FIN_METAL ? 0.45 : 0.3) * mix(0.3, 1.0, curved) * (1.0 - small);
    albedo = mix(albedo, vec3(0.45, 0.5, 0.58), sheen);
    float b = fract((v_obj.x + v_obj.z + v_obj.y * 0.5) / 7.0);
    float bars = step(0.12, b) * step(b, 0.18) + step(0.24, b) * step(b, 0.27);
    float streak = smoothstep(0.955, 0.965, h) * (v_fin == FIN_METAL ? 0.9 : 0.6) * mix(bars, 1.0, curved)
      * (1.0 - small);
    albedo = mix(albedo, vec3(0.95, 0.96, 0.98), streak);
    light = mix(light, 1.0, max(streak, sheen));
  } else if (v_fin == FIN_WOOD) {
    // Grain: broken wavy strokes along the part.
    float g = v_obj.z * 2.2 + v_obj.y * 1.3 + sin(v_obj.x * 0.9 + v_obj.z) * 0.35;
    float fw = max(fwidth(g), 1e-4);
    float d = abs(fract(g) - 0.5) / fw;
    // Broken strokes, gone where they would crowd closer than a few pixels.
    float stroke = (1.0 - smoothstep(0.8, 1.6, d)) * step(0.45, vnoise(vec2(v_obj.x * 0.8, floor(g) * 3.7)))
      * (1.0 - smoothstep(0.12, 0.3, fw));
    albedo = mix(albedo, albedo * 0.3, stroke * 0.9);
  } else if (v_fin == FIN_PATTERN) {
    // Woven check (a shemagh): two families of diagonal lines, gone where they crowd.
    float g1 = dot(v_obj, vec3(1.1, 1.1, 1.1)), g2 = dot(v_obj, vec3(1.1, -1.1, 1.1));
    float f1 = max(fwidth(g1), 1e-4), f2 = max(fwidth(g2), 1e-4);
    float l1 = 1.0 - smoothstep(0.8, 1.8, abs(fract(g1) - 0.5) / f1);
    float l2 = 1.0 - smoothstep(0.8, 1.8, abs(fract(g2) - 0.5) / f2);
    albedo = mix(albedo, albedo * 0.45, max(l1, l2) * 0.85 * (1.0 - smoothstep(0.15, 0.35, max(f1, f2))));
  }
  gbuffer(mix(albedo, vec3(1.0), u_white), clamp(mix(light, 1.0, u_white), 0.0, 1.0), n, v_id, v_w, u_flags);
}`;

// The comic print, one fullscreen pass over the G-buffer.
export const COMPOSITE_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// The flashbang's afterimage (client/gl/afterimage.js): the kept frame, pixel for pixel.
export const AFTERIMAGE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_img;
uniform float u_alpha;
out vec4 o_color;
void main() {
  o_color = vec4(texelFetch(u_img, ivec2(gl_FragCoord.xy), 0).rgb, u_alpha);
}`;

// The ink and the composite share the G-buffer readers: a depth texel (DTEX) with its
// flags, depth and 1 / depth, the normal texel, and the terms of the line tests.
const INK_COMMON = `
ivec2 gsize;
ivec2 cl(ivec2 p) { return clamp(p, ivec2(0), gsize - 1); }
// A depth texel (DTEX): its flags, its depth, and 1 / depth up to a constant (the
// silhouette test only compares them).
#ifdef DEPTH_PACKED
#define DTEX uvec4
DTEX dtex(ivec2 p) { return uvec4(texelFetch(u_depth, cl(p), 0) * 255.0 + 0.5); }
uint flagsOf(DTEX t) { return t.a; }
float depthOf(DTEX t) { return float((t.r << 16u) | (t.g << 8u) | t.b) * (DEPTH_FAR / 16777215.0); }
float invOf(DTEX t) { return 1.0 / max(depthOf(t), 1.0); }
#else
#define DTEX vec2
DTEX dtex(ivec2 p) { return texelFetch(u_depth, cl(p), 0).rg; }
uint flagsOf(DTEX t) { return uint(t.g); }
float depthOf(DTEX t) { return DEPTH_NEAR / t.r; }
float invOf(DTEX t) { return t.r; }
#endif
vec4 ntex(ivec2 p) { return texelFetch(u_normal, cl(p), 0); }

uint fc;  // flags at the line sample
float wc; // 1 / depth there
// A see-through screen and what lies behind it count as one surface: no ink between them.
bool across(DTEX t) { return ((flagsOf(t) ^ fc) & G_SCREEN) != 0u; }
float invd(DTEX t) { return across(t) ? wc : invOf(t); }
bool isChar(DTEX t) { return (flagsOf(t) & G_CHAR) != 0u; }
// Crease between the line sample's normal c and a neighbor's normal texel n.
float crease(vec3 c, vec4 n) { return 1.0 - dot(c, n.xyz * 2.0 - 1.0); }

`;

// The ink pass: the line coverage of every G-buffer texel (silhouettes, creases, object
// boundaries, the far characters' rings) into an R8 texture at the G-buffer's resolution,
// which the composite reads under each canvas pixel. At a lower render scale the lines
// are then filtered up (a smooth ramp instead of a staircase: the ink's anti-aliasing),
// and the dozen fetches a texel happen for the scene's pixels, not the screen's.
export const INK_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_normal;
uniform sampler2D u_depth;
uniform float u_line;   // ink line spacing (canvas px); 0: no lines
uniform float u_gscale; // G-buffer texels per canvas pixel
uniform float u_zoom;   // 90 / fov: distance fades follow the scope
out vec4 o_ink;
${GBUFFER_CONSTS}
${INK_COMMON}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gsize = textureSize(u_depth, 0);
  DTEX Dp = dtex(p);
  uint fl = flagsOf(Dp);
  float dP = depthOf(Dp);
  // Ink, sampled at the pixel itself (pc; the ink plate holds still: a hand-drawn boil
  // shifting it 7 times a second was tiring to play with).
  float edge = 0.0;
  if (u_line > 0.0) {
    ivec2 pc = p;
    DTEX Dc = Dp;
    fc = flagsOf(Dc);
    int s = max(1, int((u_line + ((fc & (G_FLAT | G_VIEW)) != 0u ? 1.0 : 0.0)) * u_gscale + 0.5));
    float dC = dP;
    wc = invOf(Dc);
    // Silhouettes: 2nd derivative of 1 / depth (zero on any plane), on the nearer side only:
    // the object in front carries its outline, as a comic artist draws it (both sides made
    // every line twice as thick). There 1 / depth bulges above its neighbors' mean, behind
    // it dips below. Each neighbor is fetched once (an integrated GPU feels every fetch here).
    DTEX tL = dtex(pc + ivec2(-s, 0)), tR = dtex(pc + ivec2(s, 0)), tD = dtex(pc + ivec2(0, -s));
    DTEX tU = dtex(pc + ivec2(0, s));
    float w2 = 2.0 * wc;
    float lap = max(w2 - invd(tL) - invd(tR), 0.0) + max(w2 - invd(tD) - invd(tU), 0.0);
    // Creases and object boundaries: one side only, a thinner line. Inside a character, only
    // against more character (the seams between its parts): its edge to the world is the
    // silhouette's (this one-sided line made a figure's right and top edges thicker).
    bool cc = (fc & G_CHAR) != 0u;
    bool ax = across(tR) || (cc && !isChar(tR)), ay = across(tU) || (cc && !isChar(tU));
    vec4 nc = ntex(pc), nx = ntex(pc + ivec2(s, 0)), ny = ntex(pc + ivec2(0, s));
    vec3 c = nc.xyz * 2.0 - 1.0;
    float nd = 0.0;
    if (!ax) nd = max(nd, crease(c, nx));
    if (!ay) nd = max(nd, crease(c, ny));
    float eI = (!ax && abs(nx.w - nc.w) > 0.002) || (!ay && abs(ny.w - nc.w) > 0.002) ? 1.0 : 0.0;
    // The diagonals read as the sample itself (no silhouette, crease or character term from
    // them) unless fetched below.
    DTEX tDL = Dc, tUR = Dc, tUL = Dc, tDR = Dc;
#ifndef INK_FAST
    // The diagonals (5 fetches more) only where the four direct neighbors show anything at
    // all: a depth bulge, a crease or another surface well under the line's start, other
    // flags. On a plane, inside one surface (most pixels) they would add nothing; the
    // r_inkfast print leaves them out everywhere.
    if (lap > 0.01 * wc || nd > 0.06 || eI > 0.0 ||
      flagsOf(tL) != fc || flagsOf(tR) != fc || flagsOf(tD) != fc || flagsOf(tU) != fc) {
      tDL = dtex(pc + ivec2(-s, -s));
      tUR = dtex(pc + ivec2(s, s));
      tUL = dtex(pc + ivec2(-s, s));
      tDR = dtex(pc + ivec2(s, -s));
      lap += 0.5 * (max(w2 - invd(tDL) - invd(tUR), 0.0) + max(w2 - invd(tUL) - invd(tDR), 0.0));
      bool ad = across(tUR) || (cc && !isChar(tUR));
      if (!ad) nd = max(nd, crease(c, ntex(pc + ivec2(s, s))));
    }
#endif
    float eD = smoothstep(0.05, 0.16, lap / wc);
    float eN = smoothstep(0.22, 0.45, nd);
    float fade = 1.0 - 0.65 * smoothstep(1000.0 * u_zoom, 3400.0 * u_zoom, dC);
    // Characters past arm's length: a crisp outline and their colors, not their ink (the
    // two-sided silhouette and the part lines are a black blob on a small figure; a thinned
    // one goes ragged, as the samples are s pixels apart). Their silhouette becomes a ring
    // exactly one pixel wide just outside them (a pixel touching a character in front of
    // it: only next to characters are these four extra fetches made), and the lines inside
    // fade out. By the nearest character depth round the sample, so a near one keeps its
    // bold comic outline.
    float dChar = cc ? dC : 1e9;
    if (isChar(tL)) dChar = min(dChar, depthOf(tL));
    if (isChar(tR)) dChar = min(dChar, depthOf(tR));
    if (isChar(tD)) dChar = min(dChar, depthOf(tD));
    if (isChar(tU)) dChar = min(dChar, depthOf(tU));
    // (the diagonal samples too: the silhouette test reads them, so a character there would
    // otherwise still print its old, jittered line round the ring)
    if (isChar(tDL)) dChar = min(dChar, depthOf(tDL));
    if (isChar(tUR)) dChar = min(dChar, depthOf(tUR));
    if (isChar(tUL)) dChar = min(dChar, depthOf(tUL));
    if (isChar(tDR)) dChar = min(dChar, depthOf(tDR));
    float farC = dChar < 1e8 ? smoothstep(80.0 * u_zoom, 250.0 * u_zoom, dChar) : 0.0;
    float sil = eD;
    if (farC > 0.0) {
      float ring = 0.0;
      if ((fl & G_CHAR) == 0u) {
        DTEX r0 = dtex(p + ivec2(1, 0)), r1 = dtex(p + ivec2(-1, 0)), r2 = dtex(p + ivec2(0, 1)), r3 = dtex(p + ivec2(0, -1));
        float lim = dP - 8.0;
        if ((isChar(r0) && depthOf(r0) < lim) || (isChar(r1) && depthOf(r1) < lim) ||
          (isChar(r2) && depthOf(r2) < lim) || (isChar(r3) && depthOf(r3) < lim)) ring = 1.0;
      }
      sil = mix(eD, ring, farC);
    }
    // Crease and object lines: inside a far character they fade out; beside one (the
    // background next to it) they go at once, else their jittered samples speckle the ring.
    float inner = (fc & G_CHAR) != 0u ? 1.0 - smoothstep(200.0 * u_zoom, 600.0 * u_zoom, dC) : 1.0 - farC;
    edge = max(sil, max(eN, eI) * fade * inner);
  }
  o_ink = vec4(edge, 0.0, 0.0, 1.0);
}`;
// r_inkfast: lines from the four direct neighbors only (a slower GPU's print).
export const INK_FAST_FS = INK_FS.replace('#version 300 es\n', '#version 300 es\n#define INK_FAST\n');

export const COMPOSITE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_albedo;
uniform sampler2D u_depth;
uniform sampler2D u_ink;
uniform vec2 u_res;    // the canvas (px)
uniform vec2 u_gscale; // G-buffer texels per canvas pixel (1; less at a lower render scale, more supersampling)
uniform float u_line;  // ink line spacing (px); 0: no lines (the ink pass did not run)
uniform float u_dot;   // halftone cell (px); 0: flat tones
uniform float u_zoom;  // 90 / fov: distance fades follow the scope
uniform float u_bands; // light posterized into this many bands (0: smooth)
uniform float u_lift;  // share of the darkness taken away (r_shadowlift): dark corners stay readable
uniform int u_style;   // 0: plain lit colors (r_comic 0)
uniform vec3 u_calm;   // calm zone round the crosshair: center, radius (px; 0: none): dots there go flat
uniform float u_soft;  // shade dots: 0 bold, 1 soft (a finer screen, a paler print, less ink)
out vec4 o_color;
${GBUFFER_CONSTS}
${NOISE}

ivec2 gsize;
ivec2 cl(ivec2 p) { return clamp(p, ivec2(0), gsize - 1); }
#ifdef DEPTH_PACKED
#define DTEX uvec4
DTEX dtex(ivec2 p) { return uvec4(texelFetch(u_depth, cl(p), 0) * 255.0 + 0.5); }
uint flagsOf(DTEX t) { return t.a; }
float depthOf(DTEX t) { return float((t.r << 16u) | (t.g << 8u) | t.b) * (DEPTH_FAR / 16777215.0); }
#else
#define DTEX vec2
DTEX dtex(ivec2 p) { return texelFetch(u_depth, cl(p), 0).rg; }
uint flagsOf(DTEX t) { return uint(t.g); }
float depthOf(DTEX t) { return DEPTH_NEAR / t.r; }
#endif

// Halftone: round dots on a screen at angle 'ang', area growing with 'dark' (they touch
// at full dark: the paper always shows between them).
// The screen's rotation is a constant (turn: cos, sin of the angle; see the callers).
float dots(vec2 frag, float dark, float size, vec2 turn) {
  if (dark < 0.02) return 0.0;
  vec2 q = mat2(turn.x, -turn.y, turn.y, turn.x) * frag / size;
  float d = length(fract(q) - 0.5);
  float r = sqrt(clamp(dark, 0.0, 1.0)) * 0.6;
  float aa = 0.9 / size;
  return 1.0 - smoothstep(r - aa, r + aa, d);
}
// ... turning into its own average (flat) tone with distance (where it has turned all the
// way, the dots are not computed).
float tone(vec2 frag, float dark, float size, vec2 turn, float far) {
  float cov = 1.13 * clamp(dark, 0.0, 1.0);
  return far >= 1.0 ? cov : mix(dots(frag, dark, size, turn), cov, far);
}
const vec2 TURN_SHADE = vec2(0.70738827, 0.70682518); // 45 degrees (0.785 rad)
const vec2 TURN_SKY = vec2(0.96638998, 0.25708055);   // 0.26 rad

void main() {
  vec2 frag = gl_FragCoord.xy;
  gsize = textureSize(u_depth, 0);
  // The G-buffer may be smaller than the canvas (a lower render scale) or larger
  // (supersampling): the dots are printed per canvas pixel, the depth and flags read from
  // the texel under it, the colors and the ink filtered between texels (which smooths the
  // edges of the flat colors and the lines); at the canvas's own size, texel for texel.
  ivec2 p = ivec2(frag * u_gscale);
  DTEX Dp = dtex(p);
  uint fl = flagsOf(Dp);
  float dP = depthOf(Dp);
  bool exact = u_gscale.x == 1.0;
  // The color plate is printed 1 px off the ink plate; not on characters (on a small figure
  // that left a pale sliver of the background inside its outline).
  ivec2 off = ivec2((fl & G_CHAR) != 0u ? 0 : 1, 0);
  vec4 C = exact ? texelFetch(u_albedo, cl(p + off), 0) : texture(u_albedo, (frag + vec2(off)) / u_res);
  vec3 alb = C.rgb;
  float light = C.a;
  if (u_bands > 0.5) light = floor(light * u_bands + 0.5) / u_bands;
  light = 1.0 - (1.0 - light) * (1.0 - u_lift);
  if (u_style == 0) {
    o_color = vec4(alb * mix(0.3, 1.15, light), 1.0);
    return;
  }
  float edge = u_line > 0.0 ? (exact ? texelFetch(u_ink, p, 0).r : texture(u_ink, frag / u_res).r) : 0.0;
  vec3 col;
  float size = max(u_dot, 1.0) * (1.0 - 0.25 * u_soft);
  // Round the crosshair the dots melt into their own average tone (same brightness, no
  // pattern for it to get lost in).
  float calm = u_calm.z > 0.0 ? 1.0 - smoothstep(u_calm.z * 0.55, u_calm.z, distance(frag, u_calm.xy)) : 0.0;
  float far = u_dot < 1.0 ? 1.0 : max(smoothstep(500.0 * u_zoom, 1300.0 * u_zoom, dP), calm);
  if ((fl & G_CHAR) != 0u) far = max(far, smoothstep(300.0 * u_zoom, 800.0 * u_zoom, dP)); // flat colors sooner
  if ((fl & G_SKY) != 0u) {
    col = mix(alb, alb * vec3(0.43, 0.71, 0.89), tone(frag, 1.0 - light, size * 1.15, TURN_SKY, u_dot < 1.0 ? 1.0 : calm));
  } else if ((fl & G_FLAT) != 0u) {
    col = alb * (0.62 + 0.38 * light);
  } else {
    float dark = 1.0 - light;
    // (A flat tone reads darker than the same tone in dots: the calm zone prints lighter.)
    float m = tone(frag, dark, size, TURN_SHADE, far) * (1.0 - 0.15 * calm);
    vec3 base = alb * (0.84 + 0.16 * light);
    // Shade dots: a cool, darker print of the color, only a little ink even at full dark
    // (soft: paler still, and less ink).
    vec3 shade = mix(alb * vec3(0.52, 0.53, 0.62), base, 0.3 * u_soft);
    col = mix(base, mix(shade, INK, (0.12 + 0.28 * smoothstep(0.5, 0.9, dark)) * (1.0 - 0.6 * u_soft)), m);
  }
  col *= 0.965 + 0.035 * h21(frag); // paper grain
  vec2 uv = frag / u_res - 0.5;
  col *= 1.0 - dot(uv, uv) * 0.3;
  o_color = vec4(mix(col, INK, edge), 1.0);
}`;

// The G-buffer shaders, for test/comic.test.js.
export const GBUFFER_SHADERS = { WORLD_FS, SKY_FS, DEBRIS_FS, SKINNED_FS };
