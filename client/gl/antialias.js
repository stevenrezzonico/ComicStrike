// Anti-aliasing of the print besides supersampling (r_inkaa, Video: Anti-aliasing). The ink
// is what aliases here: the surface marks, patterns and the model shading smooth their own
// edges with fwidth, and the dots, the grain and the crosshair are printed per canvas pixel.
// The ink sits alone in its own target, so a filter can work on it without touching them.
// Every mode runs at the G-buffer's resolution, between the ink pass and the composite,
// and hands the composite the textures it reads in place of the G-buffer's own:
//   1 corners: no pass; the composite's smoothInk greys the inside corners of the steps (at
//     the canvas's own render scale only).
//   2 FXAA on the ink: finds which way a line runs, follows it to its ends and samples the
//     ink across the edge by where it falls inside the texel (Lottes' FXAA 3.11, quality
//     search, written for one channel).
//   3 SMAA 1x on the ink: edges by local contrast, a search along each edge for its ends and
//     the crossing edges there, the area the line between them leaves on either side, then
//     each texel blended with its neighbors by those areas (Jimenez et al.'s structure; the
//     areas are worked out in the shader instead of read from SMAA's precomputed area
//     texture, as the game loads no image files; orthogonal patterns only, no diagonals).
//   4 TAA: the world (and the decals on it) is drawn with a sub-texel Halton jitter every
//     frame, and its color plate and ink are blended into a history reprojected through the
//     depth, clamped to the current neighborhood. What moves by itself (models, debris,
//     lines, doors: G_MOVING, and the lines drawn from them, the ink pass's mark) has no
//     motion vectors to follow: it is drawn without the jitter, keeps no history (its
//     outline faded to a tenth while it moved) and gets SMAA instead.
// MSAA cannot work with the deferred ink (WebGL2 shaders cannot read multisampled textures,
// and a resolve averages the normals and ids); CMAA2 needs compute shaders; FXAA or SMAA over
// the finished print smear the dots and the grain.

import { COMPOSITE_VS, GBUFFER_CONSTS, DEPTH_READ } from './shaders.js';
import { program } from './program.js';
import { multiply } from './mat4.js';

export const AA = { OFF: 0, CORNERS: 1, FXAA: 2, SMAA: 3, TAA: 4 };

const TAA_BLEND = 0.1; // the share of the new frame in the history
const JITTERS = 8; // Halton (2, 3) points, then again
const JITTER = new Float32Array(JITTERS * 2);
for (let k = 0; k < JITTERS; k++) {
  JITTER[k * 2] = halton(k + 1, 2) - 0.5;
  JITTER[k * 2 + 1] = halton(k + 1, 3) - 0.5;
}

// The i-th point of the Halton sequence in base b (0..1).
export function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

const ONE_CHANNEL = `#version 300 es
precision highp float;
precision highp int;
`;

// FXAA on the ink. SUBPIX is lower than FXAA's 0.75: the ink lines are 1-3 texels wide, and
// the sub-texel pass would spread a 1 px line over 2 at half its ink.
export const FXAA_FS = `${ONE_CHANNEL}
uniform sampler2D u_ink;
out vec4 o_ink;
const float EDGE_MIN = 0.0312;  // contrast under max(EDGE_MIN, EDGE_MAX * the darkest ink) is no edge
const float EDGE_MAX = 0.125;
const float SUBPIX = 0.5;
const int STEPS = 12;
float stepOf(int i) { return i < 5 ? 1.0 : i < 6 ? 1.5 : i < 10 ? 2.0 : i < 11 ? 4.0 : 8.0; }
ivec2 gsize;
float at(ivec2 p) { return texelFetch(u_ink, clamp(p, ivec2(0), gsize - 1), 0).r; }
float lin(vec2 uv) { return textureLod(u_ink, uv, 0.0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gsize = textureSize(u_ink, 0);
  vec2 texel = 1.0 / vec2(gsize), uv = (vec2(p) + 0.5) * texel;
  float m = at(p), n = at(p + ivec2(0, 1)), s = at(p - ivec2(0, 1)), e = at(p + ivec2(1, 0)), w = at(p - ivec2(1, 0));
  float lo = min(m, min(min(n, s), min(e, w))), hi = max(m, max(max(n, s), max(e, w)));
  float range = hi - lo;
  if (range < max(EDGE_MIN, hi * EDGE_MAX)) {
    o_ink = vec4(m, 0.0, 0.0, 1.0);
    return;
  }
  float ne = at(p + ivec2(1, 1)), nw = at(p + ivec2(-1, 1)), se = at(p + ivec2(1, -1)), sw = at(p + ivec2(-1, -1));
  float ns = n + s, ew = e + w, west = nw + sw, east = ne + se, north = ne + nw, south = se + sw;
  // Which way the edge runs: along x when the ink changes most across y.
  bool horiz = abs(-2.0 * w + west) + 2.0 * abs(-2.0 * m + ns) + abs(-2.0 * e + east) >=
    abs(-2.0 * n + north) + 2.0 * abs(-2.0 * m + ew) + abs(-2.0 * s + south);
  float l1 = horiz ? s : w, l2 = horiz ? n : e;
  float g1 = l1 - m, g2 = l2 - m;
  bool first = abs(g1) >= abs(g2);
  float scaled = 0.25 * max(abs(g1), abs(g2));
  float len = horiz ? texel.y : texel.x;
  float avg = 0.5 * ((first ? l1 : l2) + m);
  if (first) len = -len;
  // Along the edge, half a texel over onto its steeper side, both ways to its ends.
  vec2 at0 = uv + (horiz ? vec2(0.0, 0.5 * len) : vec2(0.5 * len, 0.0));
  vec2 dir = horiz ? vec2(texel.x, 0.0) : vec2(0.0, texel.y);
  vec2 uv1 = at0 - dir, uv2 = at0 + dir;
  float end1 = lin(uv1) - avg, end2 = lin(uv2) - avg;
  bool done1 = abs(end1) >= scaled, done2 = abs(end2) >= scaled;
  if (!done1) uv1 -= dir;
  if (!done2) uv2 += dir;
  for (int i = 2; i < STEPS && !(done1 && done2); i++) {
    if (!done1) end1 = lin(uv1) - avg;
    if (!done2) end2 = lin(uv2) - avg;
    done1 = abs(end1) >= scaled;
    done2 = abs(end2) >= scaled;
    if (!done1) uv1 -= dir * stepOf(i);
    if (!done2) uv2 += dir * stepOf(i);
  }
  float d1 = horiz ? uv.x - uv1.x : uv.y - uv1.y, d2 = horiz ? uv2.x - uv.x : uv2.y - uv.y;
  bool near1 = d1 < d2;
  float off = 0.5 - min(d1, d2) / (d1 + d2);
  // Only where the end found goes the other way from this texel (else it is not this edge's end).
  if (((near1 ? end1 : end2) < 0.0) == (m < avg)) off = 0.0;
  // The sub-texel term: a texel unlike its whole neighborhood (a 1-texel feature).
  float sub = clamp(abs((2.0 * (ns + ew) + west + east) / 12.0 - m) / range, 0.0, 1.0);
  sub = (-2.0 * sub + 3.0) * sub * sub;
  off = max(off, sub * sub * SUBPIX);
  o_ink = vec4(lin(uv + (horiz ? vec2(0.0, off * len) : vec2(off * len, 0.0))), 0.0, 0.0, 1.0);
}`;

// SMAA 1, edges: r the edge between a texel and its left neighbor, g the one below it, where
// the ink differs by THRESHOLD, and by at least half the largest difference round it (SMAA's
// local contrast adaptation: the inner edges of a thick line or a double edge are dropped).
export const SMAA_EDGE_FS = `${ONE_CHANNEL}
uniform sampler2D u_ink;
uniform float u_only; // 1 (TAA): only edges touching a texel marked moving (the ink's g)
out vec4 o_edges;
const float THRESHOLD = 0.1;
const float CONTRAST = 2.0;
ivec2 gsize;
ivec2 cl(ivec2 p) { return clamp(p, ivec2(0), gsize - 1); }
float at(ivec2 p) { return texelFetch(u_ink, cl(p), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gsize = textureSize(u_ink, 0);
  vec2 tc = texelFetch(u_ink, p, 0).rg, tl = texelFetch(u_ink, cl(p - ivec2(1, 0)), 0).rg;
  vec2 tb = texelFetch(u_ink, cl(p - ivec2(0, 1)), 0).rg;
  float c = tc.r;
  vec2 lb = vec2(tl.r, tb.r);
  vec2 delta = abs(c - lb);
  vec2 edges = step(THRESHOLD, delta);
  if (u_only > 0.0) edges *= step(0.5, max(vec2(tc.g), vec2(tl.g, tb.g)));
  if (edges.x + edges.y == 0.0) {
    o_edges = vec4(0.0);
    return;
  }
  vec2 rt = abs(c - vec2(at(p + ivec2(1, 0)), at(p + ivec2(0, 1))));
  vec2 far = abs(lb - vec2(at(p - ivec2(2, 0)), at(p - ivec2(0, 2))));
  float most = max(max(max(delta.x, delta.y), max(rt.x, rt.y)), max(far.x, far.y));
  edges *= step(most, CONTRAST * delta);
  o_edges = vec4(edges, 0.0, 1.0);
}`;

// SMAA 2, blending weights. For each edge a texel holds, the search runs along it both ways
// (SEARCH texels at most) to its ends, where a crossing edge on one side or the other bends
// the line: the shape is rebuilt as MLAA does (an L from the crossing to the edge's middle,
// a Z corner to corner, a U as two L's) and the area it cuts from each side of this texel's
// stretch of the edge is that side's weight. Out: r this texel takes from the one below, g
// that one takes from this; b this texel takes from the left one, a that one from this.
export const SMAA_WEIGHT_FS = `${ONE_CHANNEL}
uniform sampler2D u_edges;
out vec4 o_weights;
const int SEARCH = 16; // texels each way
ivec2 gsize;
vec2 E(ivec2 p) {
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, gsize))) return vec2(0.0);
  return texelFetch(u_edges, p, 0).rg;
}
// The line from a to b over the texel at [x, x + 1] along the edge: the area on this
// texel's side (the line above the edge, y > 0) and on the other side.
vec2 seg(vec2 a, vec2 b, float x) {
  float x1 = max(x, a.x), x2 = min(x + 1.0, b.x);
  if (x2 <= x1) return vec2(0.0);
  float k = (b.y - a.y) / (b.x - a.x);
  float y1 = a.y + (x1 - a.x) * k, y2 = a.y + (x2 - a.x) * k;
  if (y1 * y2 >= 0.0) {
    float s = 0.5 * (y1 + y2) * (x2 - x1);
    return s > 0.0 ? vec2(s, 0.0) : vec2(0.0, -s);
  }
  float xz = x1 + (x2 - x1) * y1 / (y1 - y2);
  float s1 = 0.5 * y1 * (xz - x1), s2 = 0.5 * y2 * (x2 - xz);
  return vec2(max(s1, 0.0) + max(s2, 0.0), max(-s1, 0.0) + max(-s2, 0.0));
}
// An edge d texels long whose ends bend by h1 and h2 (+-0.5 toward a side, 0 straight).
vec2 area(float h1, float h2, float d, float x) {
  if (h1 * h2 < 0.0) return seg(vec2(0.0, h1), vec2(d, h2), x);
  return seg(vec2(0.0, h1), vec2(0.5 * d, 0.0), x) + seg(vec2(0.5 * d, 0.0), vec2(d, h2), x);
}
// The bend at an end from its crossing edges on this side and the other. Crossings on both
// sides at once are a thin line's step (the line ends in one row and goes on in the next at
// the same column): the edge bends toward the side where it goes on (mine: this side's).
float bend(float up, float dn, float mine, float other) {
  if (up > dn) return 0.5;
  if (up < dn) return -0.5;
  return mine > other ? 0.5 : mine < other ? -0.5 : 0.0;
}
// The edge below p (between p and p - y), along x.
vec2 alongX(ivec2 p) {
  int d1 = 0, d2 = 0;
  float h1 = 0.0, h2 = 0.0;
  ivec2 q = p;
  vec2 eq = E(q); // (carried from step to step: two fetches a step)
  for (int i = 0; i < SEARCH; i++) { // to the left end
    float up = eq.r, dn = E(q - ivec2(0, 1)).r; // crossing edges on q's left, in p's row and the one below
    if (up + dn > 0.0) { h1 = bend(up, dn, E(q + ivec2(-1, 1)).g, E(q - ivec2(1, 1)).g); break; }
    vec2 el = E(q - ivec2(1, 0));
    if (el.g == 0.0) break;
    q.x--;
    d1++;
    eq = el;
  }
  q = p;
  for (int i = 0; i < SEARCH; i++) { // to the right end
    vec2 er = E(q + ivec2(1, 0));
    float up = er.r, dn = E(q + ivec2(1, -1)).r;
    if (up + dn > 0.0) { h2 = bend(up, dn, E(q + ivec2(1, 1)).g, E(q + ivec2(1, -1)).g); break; }
    if (er.g == 0.0) break;
    q.x++;
    d2++;
  }
  return area(h1, h2, float(d1 + d2 + 1), float(d1));
}
// The edge left of p (between p and p - x), along y.
vec2 alongY(ivec2 p) {
  int d1 = 0, d2 = 0;
  float h1 = 0.0, h2 = 0.0;
  ivec2 q = p;
  vec2 eq = E(q);
  for (int i = 0; i < SEARCH; i++) { // to the bottom end
    float rt = eq.g, lf = E(q - ivec2(1, 0)).g; // crossing edges under q, in p's column and the left one
    if (rt + lf > 0.0) { h1 = bend(rt, lf, E(q + ivec2(1, -1)).r, E(q - ivec2(1, 1)).r); break; }
    vec2 ed = E(q - ivec2(0, 1));
    if (ed.r == 0.0) break;
    q.y--;
    d1++;
    eq = ed;
  }
  q = p;
  for (int i = 0; i < SEARCH; i++) { // to the top end
    vec2 eu = E(q + ivec2(0, 1));
    float rt = eu.g, lf = E(q + ivec2(-1, 1)).g;
    if (rt + lf > 0.0) { h2 = bend(rt, lf, E(q + ivec2(1, 1)).r, E(q + ivec2(-1, 1)).r); break; }
    if (eu.r == 0.0) break;
    q.y++;
    d2++;
  }
  return area(h1, h2, float(d1 + d2 + 1), float(d1));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gsize = textureSize(u_edges, 0);
  vec2 e = E(p);
  vec4 w = vec4(0.0);
  if (e.g > 0.0) w.rg = alongX(p);
  if (e.r > 0.0) w.ba = alongY(p);
  o_weights = w;
}`;

// SMAA 3, blending: each texel takes from its neighbors by the weights of its four edges,
// across the way with the larger ones (a texel on a step's corner would otherwise blend twice).
export const SMAA_BLEND_FS = `${ONE_CHANNEL}
uniform sampler2D u_ink;
uniform sampler2D u_weights;
out vec4 o_ink;
ivec2 gsize;
float I(ivec2 p) { return texelFetch(u_ink, clamp(p, ivec2(0), gsize - 1), 0).r; }
vec4 W(ivec2 p) {
  if (any(greaterThanEqual(p, gsize))) return vec4(0.0);
  return texelFetch(u_weights, p, 0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gsize = textureSize(u_ink, 0);
  float c = I(p);
  vec4 w = W(p);
  float below = w.r, left = w.b, above = W(p + ivec2(0, 1)).g, right = W(p + ivec2(1, 0)).a;
  float across = max(below, above), along = max(left, right);
  float ink = c;
  if (across + along > 0.0) {
    if (across >= along) {
      ink = (below * mix(c, I(p - ivec2(0, 1)), below) + above * mix(c, I(p + ivec2(0, 1)), above)) / (below + above);
    } else {
      ink = (left * mix(c, I(p - ivec2(1, 0)), left) + right * mix(c, I(p + ivec2(1, 0)), right)) / (left + right);
    }
  }
  o_ink = vec4(ink, 0.0, 0.0, 1.0);
}`;

// TAA: the world's color plate and ink blended into their history. The depth is linear (the
// clip w), so a texel's clip position is rebuilt from it and the near and far planes of the
// scene's projection (DEPTH_NEAR, DEPTH_FAR: client/main.js's perspective), and u_reproj
// (last frame's view-projection times this frame's inverse, both unjittered) takes it to
// where it was: right for the world, which stands still. A texel marked moving (G_MOVING, or
// the ink pass's mark for a line drawn from something moving) this frame or last takes this
// frame alone, its ink SMAA'd (u_cur). The history is clamped to the current neighborhood (a
// plus: half the fetches of a 3x3) so the rest leaves no trails.
export const TAA_FS = `${ONE_CHANNEL}precision highp sampler2D;
uniform sampler2D u_albedo;
uniform sampler2D u_depth;
uniform sampler2D u_ink;   // the ink pass's target: g, its moving mark
uniform sampler2D u_cur;   // this frame's ink, SMAA'd where marked
uniform sampler2D u_histC;
uniform sampler2D u_histI; // r ink, g moving mark
uniform mat4 u_reproj;
uniform float u_blend; // the share of this frame (1: no history yet)
uniform float u_lines; // 1: the ink pass ran this frame (its mark is this frame's)
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_ink;
${GBUFFER_CONSTS}
${DEPTH_READ}
const float ZA = (DEPTH_FAR + DEPTH_NEAR) / (DEPTH_FAR - DEPTH_NEAR);
const float ZB = -2.0 * DEPTH_FAR * DEPTH_NEAR / (DEPTH_FAR - DEPTH_NEAR);
vec4 lo, top;
float ilo, ihi;
void widen(ivec2 q) {
  q = cl(q);
  vec4 n = texelFetch(u_albedo, q, 0);
  float m = texelFetch(u_cur, q, 0).r;
  lo = min(lo, n);
  top = max(top, n);
  ilo = min(ilo, m);
  ihi = max(ihi, m);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gsize = textureSize(u_depth, 0);
  vec4 c = texelFetch(u_albedo, p, 0);
  float i = texelFetch(u_cur, p, 0).r;
  DTEX D = dtex(p);
  bool moving = (flagsOf(D) & G_MOVING) != 0u || (u_lines > 0.0 && texelFetch(u_ink, p, 0).g > 0.0);
  o_color = c;
  o_ink = vec4(i, moving ? 1.0 : 0.0, 0.0, 1.0);
  if (moving || u_blend >= 1.0) return;
  float d = depthOf(D);
  vec2 uv = (vec2(p) + 0.5) / vec2(gsize);
  vec4 q = u_reproj * vec4((uv * 2.0 - 1.0) * d, ZA * d + ZB, d);
  vec2 prev = q.xy / q.w * 0.5 + 0.5;
  if (q.w <= 0.0 || any(lessThan(prev, vec2(0.0))) || any(greaterThan(prev, vec2(1.0)))) return;
  vec2 h = textureLod(u_histI, prev, 0.0).rg;
  if (h.g > 0.0) return; // something moved through here last frame
  lo = c;
  top = c;
  ilo = i;
  ihi = i;
  widen(p + ivec2(1, 0));
  widen(p - ivec2(1, 0));
  widen(p + ivec2(0, 1));
  widen(p - ivec2(0, 1));
  o_color = mix(clamp(textureLod(u_histC, prev, 0.0), lo, top), c, u_blend);
  o_ink.r = mix(clamp(h.r, ilo, ihi), i, u_blend);
}`;

// A texture of `levels` mip levels (filtered with `linear`) and the framebuffer drawing
// into the given textures.
function texture(gl, format, w, h, levels, linear) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
    levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function framebuffer(gl, textures) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const bufs = [];
  for (let i = 0; i < textures.length; i++) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, textures[i], 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  }
  gl.drawBuffers(bufs);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`anti-aliasing target incomplete (0x${status.toString(16)})`);
  return fb;
}

// GPU memory a G-buffer texel's worth of `mode`'s targets takes (r_supersample_max counts it
// with the G-buffer's ~15 bytes; mip chains left out of both): FXAA's out; SMAA's out, edges
// and weights; TAA's ink mark and two histories besides SMAA's.
export function aaBytes(mode, half) {
  const smaa = 1 + 2 + 4;
  return mode === AA.FXAA ? 1 : mode === AA.SMAA ? smaa : mode === AA.TAA ? smaa + 1 + 2 * (half ? 8 + 4 : 4 + 2) : 0;
}

export class Antialias {
  // half: half-float targets are renderable (the TAA history keeps more than 8 bits, or
  // a blend of a tenth would stall on small differences).
  constructor(gl, half) {
    this.gl = gl;
    this.half = half;
    this.mode = AA.OFF; // the mode the targets are made for
    this.width = 0;
    this.height = 0;
    this.mips = false;
    this.textures = [];
    this.fbs = [];
    this.programs = []; // by mode, compiled at first use
    this.plates = { albedo: null, ink: null }; // what the composite reads (the G-buffer's when no pass ran)
    this.turn = 0; // TAA: the history written this frame
    this.fresh = true; // TAA: no history to blend yet
    this.frame = 0; // TAA: the jitter's place in its sequence
    this.prev = new Float32Array(16); // TAA: last frame's view-projection (unjittered)
    this.reproj = new Float32Array(16);
  }

  // Makes the targets `mode` needs at w x h (mip chains over 2x, as the G-buffer's).
  ensure(mode, w, h, mips) {
    if (mode === this.mode && w === this.width && h === this.height && mips === this.mips) return;
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    for (const f of this.fbs) gl.deleteFramebuffer(f);
    this.textures = [];
    this.fbs = [];
    this.mode = mode;
    this.width = w;
    this.height = h;
    this.mips = mips;
    this.fresh = true;
    const levels = mips ? 1 + Math.floor(Math.log2(Math.max(w, h))) : 1;
    // Made on a unit nothing samples: on unit 3 (the active one after the G-buffer's binds) the
    // first pass read the ink target it wrote, an invalid feedback loop.
    gl.activeTexture(gl.TEXTURE7);
    const tex = (format, linear, lv = 1) => {
      const t = texture(gl, format, w, h, lv, linear);
      this.textures.push(t);
      return t;
    };
    if (mode !== AA.OFF) {
      this.out = tex(gl.R8, true, mode === AA.TAA ? 1 : levels); // (TAA reads it itself, texel for texel)
      this.outFb = framebuffer(gl, [this.out]);
      this.fbs.push(this.outFb);
    }
    if (mode === AA.SMAA || mode === AA.TAA) {
      this.edges = tex(gl.RG8, false);
      this.weights = tex(gl.RGBA8, false);
      this.edgesFb = framebuffer(gl, [this.edges]);
      this.weightsFb = framebuffer(gl, [this.weights]);
      this.fbs.push(this.edgesFb, this.weightsFb);
    }
    if (mode === AA.TAA) {
      this.hist = [];
      this.histFb = [];
      for (let k = 0; k < 2; k++) {
        const c = tex(this.half ? gl.RGBA16F : gl.RGBA8, true, levels);
        const i = tex(this.half ? gl.RG16F : gl.RG8, true, levels);
        this.hist.push([c, i]);
        this.histFb.push(framebuffer(gl, [c, i]));
      }
      this.fbs.push(...this.histFb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  program(mode) {
    const gl = this.gl;
    if (!this.programs[mode]) {
      if (mode === AA.FXAA) this.programs[mode] = [program(gl, COMPOSITE_VS, FXAA_FS, ['u_ink'])];
      else if (mode === AA.SMAA) {
        this.programs[mode] = [program(gl, COMPOSITE_VS, SMAA_EDGE_FS, ['u_ink', 'u_only']),
          program(gl, COMPOSITE_VS, SMAA_WEIGHT_FS, ['u_edges']),
          program(gl, COMPOSITE_VS, SMAA_BLEND_FS, ['u_ink', 'u_weights'])];
      } else {
        this.programs[mode] = [program(gl, COMPOSITE_VS, TAA_FS,
          ['u_albedo', 'u_depth', 'u_ink', 'u_cur', 'u_histC', 'u_histI', 'u_reproj', 'u_blend', 'u_lines'])];
      }
    }
    return this.programs[mode];
  }

  // TAA, before the scene is drawn: this frame's jitter into `out` (normalized device
  // coordinates, a texel of the w x h G-buffer at most half a texel off its center either way),
  // and the reprojection from this frame's (unjittered) inverse view-projection to the last.
  jitterFor(w, h, viewProj, invViewProj, out) {
    const k = this.frame++ % JITTERS;
    out[0] = JITTER[k * 2] * 2 / w;
    out[1] = JITTER[k * 2 + 1] * 2 / h;
    multiply(this.reproj, this.prev, invViewProj);
    this.prev.set(viewProj);
  }

  // A new map: the history shows another place.
  reset() {
    this.fresh = true;
  }

  // SMAA's three passes over the ink (unit 3) into `out`; only: just the edges touching a
  // texel marked moving (TAA).
  smaa(only) {
    const gl = this.gl, [edge, weight, blend] = this.program(AA.SMAA);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edgesFb);
    gl.useProgram(edge.p);
    gl.uniform1i(edge.loc.u_ink, 3);
    gl.uniform1f(edge.loc.u_only, only ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.edges);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.weightsFb);
    gl.useProgram(weight.p);
    gl.uniform1i(weight.loc.u_edges, 4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.weights);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFb);
    gl.useProgram(blend.p);
    gl.uniform1i(blend.loc.u_ink, 3);
    gl.uniform1i(blend.loc.u_weights, 5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Runs `mode`'s passes after the ink pass (the G-buffer's textures bound on units 0..3,
  // the empty vertex array bound, no depth test). `lines`: the ink pass ran. Returns the
  // textures for the composite: { albedo, ink }. A mode with no pass this frame frees the
  // targets (TAA's history at the default 2x of a 1440p window is ~300 MB).
  run(mode, gbuf, lines) {
    const gl = this.gl, pl = this.plates;
    pl.albedo = gbuf.tex[0];
    pl.ink = gbuf.ink;
    const pass = mode === AA.TAA || (lines && (mode === AA.FXAA || mode === AA.SMAA));
    this.ensure(pass ? mode : AA.OFF, gbuf.width, gbuf.height, gbuf.mips);
    if (!pass) return pl;
    gl.viewport(0, 0, this.width, this.height);
    if (mode === AA.FXAA) {
      const f = this.program(AA.FXAA)[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFb);
      gl.useProgram(f.p);
      gl.uniform1i(f.loc.u_ink, 3);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      pl.ink = this.out;
    } else if (mode === AA.SMAA) {
      this.smaa(false);
      pl.ink = this.out;
    } else {
      if (lines) this.smaa(true);
      const t = this.program(AA.TAA)[0], k = t.loc, last = this.hist[this.turn]; // last frame's
      this.turn ^= 1;
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, last[0]);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, last[1]);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, lines ? this.out : gbuf.ink);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFb[this.turn]);
      gl.useProgram(t.p);
      gl.uniform1i(k.u_albedo, 0);
      gl.uniform1i(k.u_depth, 2);
      gl.uniform1i(k.u_ink, 3);
      gl.uniform1i(k.u_cur, 6);
      gl.uniform1i(k.u_histC, 4);
      gl.uniform1i(k.u_histI, 5);
      gl.uniformMatrix4fv(k.u_reproj, false, this.reproj);
      gl.uniform1f(k.u_blend, this.fresh ? 1 : TAA_BLEND);
      gl.uniform1f(k.u_lines, lines ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.fresh = false;
      pl.albedo = this.hist[this.turn][0];
      pl.ink = this.hist[this.turn][1];
    }
    return pl;
  }
}
