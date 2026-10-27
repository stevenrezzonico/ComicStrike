// Skinned model drawing: one VAO per built mesh (client/gl/meshkit.js), one draw call
// per model instance with its bone matrices (client/anim/skeleton.js Pose.skin).
// Models wind counter-clockwise (the world is clockwise, GoldSrc), so the front face
// flips around the draws.

import { program } from './program.js';
import { SKINNED_VS, SKINNED_FS } from './shaders.js';
import { MESH_STRIDE } from './meshkit.js';
import { MAX_BONES } from '../anim/skeleton.js';

// Sun-ish direction for the two tones: from above, slightly in front.
const LIGHT_DIR = (() => {
  const v = [0.35, 0.25, 0.9];
  const l = Math.hypot(...v);
  return new Float32Array(v.map((x) => x / l));
})();

// Skin for meshes drawn rigidly (guns, props): every bone at its bind pose.
export const IDENTITY_SKIN = new Float32Array(MAX_BONES * 16);
for (let i = 0; i < MAX_BONES; i++) for (let k = 0; k < 4; k++) IDENTITY_SKIN[i * 16 + k * 5] = 1;

export class SkinnedMesh {
  constructor(gl, built) {
    this.count = built.count;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, MESH_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.BYTE, true, MESH_STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, MESH_STRIDE, 15);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.UNSIGNED_BYTE, true, MESH_STRIDE, 16);
    gl.bindVertexArray(null);
  }
}

export class SkinnedRenderer {
  constructor(gl) {
    this.gl = gl;
    this.emissive = 0;
    this.prog = program(gl, SKINNED_VS, SKINNED_FS, ['u_viewProj', 'u_model', 'u_bones', 'u_light', 'u_lightDir', 'u_emissive']);
  }

  begin(viewProj) {
    const gl = this.gl;
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gl.uniform3fv(this.prog.loc.u_lightDir, LIGHT_DIR);
    gl.uniform1f(this.prog.loc.u_emissive, (this.emissive = 0));
    gl.frontFace(gl.CCW);
  }

  // model: mat4 (model space -> world); skin: Pose.skin (or IDENTITY_SKIN); light: rgb
  // multiplier; emissive: 1 glows unlit.
  draw(mesh, model, skin, light, emissive = 0) {
    const gl = this.gl;
    if (emissive !== this.emissive) gl.uniform1f(this.prog.loc.u_emissive, (this.emissive = emissive));
    gl.uniformMatrix4fv(this.prog.loc.u_model, false, model);
    gl.uniformMatrix4fv(this.prog.loc.u_bones, false, skin, 0, MAX_BONES * 16);
    gl.uniform3fv(this.prog.loc.u_light, light);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
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
