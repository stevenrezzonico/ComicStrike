// Skinned model drawing: one VAO per built mesh (client/gl/meshkit.js), indexed (shared
// vertices: indexMesh), one draw call per model instance with its bone matrices
// (client/anim/skeleton.js Pose.skin; only as many as the mesh uses are sent).
// Models wind counter-clockwise (the world is clockwise, GoldSrc), so the front face
// flips around the draws.

import { program } from './program.js';
import { SKINNED_VS, SKINNED_FS } from './shaders.js';
import { MESH_STRIDE, indexMesh } from './meshkit.js';
import { MAX_BONES } from '../anim/skeleton.js';

// Sun-ish direction for the two tones: from above, slightly in front.
const LIGHT_DIR = (() => {
  const v = [0.35, 0.25, 0.9];
  const l = Math.hypot(...v);
  return new Float32Array(v.map((x) => x / l));
})();

// Lifted map light that prints fully lit (no halftone dots): set per map from its
// lightmap (Renderer.loadMap), shared by every model.
export const mapLight = { full: 1.25 };

// Camera position of a view-projection matrix (column-major): the point every row but
// depth maps to zero (clip x = y = w = 0). Rim and shine need it; no allocation.
export function eyeOf(out, m) {
  // Rows x, y, w: a . (p, 1) = 0, three equations in p, by Cramer's rule.
  const a0 = m[0], a1 = m[4], a2 = m[8], a3 = m[12];
  const b0 = m[1], b1 = m[5], b2 = m[9], b3 = m[13];
  const c0 = m[3], c1 = m[7], c2 = m[11], c3 = m[15];
  const det = a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
  if (Math.abs(det) < 1e-12) return out.fill(0);
  out[0] = -(a3 * (b1 * c2 - b2 * c1) - a1 * (b3 * c2 - b2 * c3) + a2 * (b3 * c1 - b1 * c3)) / det;
  out[1] = -(a0 * (b3 * c2 - b2 * c3) - a3 * (b0 * c2 - b2 * c0) + a2 * (b0 * c3 - b3 * c0)) / det;
  out[2] = -(a0 * (b1 * c3 - b3 * c1) - a1 * (b0 * c3 - b3 * c0) + a3 * (b0 * c1 - b1 * c0)) / det;
  return out;
}

// Skin for meshes drawn rigidly (guns, props): every bone at its bind pose.
export const IDENTITY_SKIN = new Float32Array(MAX_BONES * 16);
for (let i = 0; i < MAX_BONES; i++) for (let k = 0; k < 4; k++) IDENTITY_SKIN[i * 16 + k * 5] = 1;

export class SkinnedMesh {
  constructor(gl, built) {
    const ix = indexMesh(built.data, built.count);
    this.count = built.count; // indices
    this.indexType = ix.indices.BYTES_PER_ELEMENT === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    this.bones = ix.bones; // bone matrices its vertices use
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, ix.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, MESH_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.BYTE, true, MESH_STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, MESH_STRIDE, 15);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, MESH_STRIDE, 16); // rgb, finish
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 2, gl.UNSIGNED_BYTE, MESH_STRIDE, 20); // second bone, its weight
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); // kept by the VAO
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }
}

// Every draw gets the next object id (the shader mixes in each vertex color), so the ink
// outlines each model and each part. Shared by all renderers: ids differ across them too.
let nextId = 0;

export class SkinnedRenderer {
  constructor(gl) {
    this.gl = gl;
    this.emissive = 0;
    this.white = 0;
    this.eye = new Float32Array(3);
    this.flags = 0; // G_FLAGS on every pixel drawn (G_FLAGS.VIEW: the first-person view)
    this.prog = program(gl, SKINNED_VS, SKINNED_FS, ['u_viewProj', 'u_bones', 'u_light', 'u_lightDir',
      'u_emissive', 'u_white', 'u_id', 'u_lightFull', 'u_eye', 'u_flags']);
    this.bones = new Float32Array(MAX_BONES * 16); // model x skin, per draw
  }

  // Changes the G_FLAGS of the next draws (between begin and end).
  setFlags(flags) {
    if (flags !== this.flags) this.gl.uniform1ui(this.prog.loc.u_flags, (this.flags = flags));
  }

  begin(viewProj) {
    const gl = this.gl;
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gl.uniform3fv(this.prog.loc.u_eye, eyeOf(this.eye, viewProj));
    gl.uniform1ui(this.prog.loc.u_flags, this.flags);
    gl.uniform3fv(this.prog.loc.u_lightDir, LIGHT_DIR);
    gl.uniform1f(this.prog.loc.u_emissive, (this.emissive = 0));
    gl.uniform1f(this.prog.loc.u_white, (this.white = 0));
    gl.uniform1f(this.prog.loc.u_lightFull, mapLight.full);
    gl.frontFace(gl.CCW);
  }

  // model: mat4 (model space -> world); skin: Pose.skin (or IDENTITY_SKIN); light: rgb
  // multiplier; emissive: 1 glows unlit; white: 0..1 toward white (spawn protection).
  draw(mesh, model, skin, light, emissive = 0, white = 0) {
    const gl = this.gl;
    if (emissive !== this.emissive) gl.uniform1f(this.prog.loc.u_emissive, (this.emissive = emissive));
    if (white !== this.white) gl.uniform1f(this.prog.loc.u_white, (this.white = white));
    gl.uniform1ui(this.prog.loc.u_id, (nextId = (nextId + 1) & 1023));
    // The bones go up already in world space (model x skin): a mat4 product per bone here
    // instead of one per vertex (the models pass is vertex-bound: 9 players are ~40,000
    // vertices a frame).
    const b = this.bones;
    for (let i = 0; i < mesh.bones; i++) {
      const o = i * 16;
      for (let c = 0; c < 4; c++) {
        const s0 = skin[o + c * 4], s1 = skin[o + c * 4 + 1], s2 = skin[o + c * 4 + 2], s3 = skin[o + c * 4 + 3];
        for (let r = 0; r < 4; r++) {
          b[o + c * 4 + r] = model[r] * s0 + model[4 + r] * s1 + model[8 + r] * s2 + model[12 + r] * s3;
        }
      }
    }
    gl.uniformMatrix4fv(this.prog.loc.u_bones, false, b, 0, mesh.bones * 16);
    gl.uniform3fv(this.prog.loc.u_light, light);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
  }

  end() {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.frontFace(gl.CW);
  }
}

// Model brightness from a lightmap sample (0..255 rgb), lifted like the world shader's
// pow(lm, 0.6) * 1.45, with a floor so models never vanish in black corners.
export function modelLight(out, rgb) {
  for (let c = 0; c < 3; c++) out[c] = Math.max(0.25, Math.min(1.6, Math.pow(rgb[c] / 255, 0.6) * 1.45));
  return out;
}
