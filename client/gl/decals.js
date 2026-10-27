// Bullet-hole decals: a fixed ring of world-space quads in one dynamic VBO.
// Adding a decal rewrites only its own slot; drawing is one call.

import { program } from './program.js';
import { DECAL_VS, DECAL_FS } from './shaders.js';

const FLOATS_PER_VERT = 6; // pos xyz, uv, seed
const FLOATS_PER_DECAL = FLOATS_PER_VERT * 4;

export class Decals {
  constructor(gl, capacity = 512) {
    this.gl = gl;
    this.capacity = capacity;
    this.count = 0;
    this.next = 0;
    this.data = new Float32Array(capacity * FLOATS_PER_DECAL);
    this.owner = new Uint8Array(capacity); // breakable slot the decal sits on, 0 = world
    this.prog = program(gl, DECAL_VS, DECAL_FS, ['u_viewProj']);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, FLOATS_PER_VERT * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, FLOATS_PER_VERT * 4, 12);
    const idx = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  clear() {
    this.count = 0;
    this.next = 0;
  }

  // Places a decal of radius `size` at p facing along unit normal n. `owner` is the
  // breakable slot it sits on (0 = static world), so it can vanish with it.
  add(px, py, pz, nx, ny, nz, size, seed, owner = 0) {
    // Tangent basis around the normal, spun by the seed so holes vary.
    let tx, ty, tz;
    if (Math.abs(nz) < 0.9) {
      tx = -ny; ty = nx; tz = 0; // n x up
    } else {
      tx = 0; ty = -nz; tz = ny; // n x right
    }
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const a = seed * 6.2831853;
    const ca = Math.cos(a) * size, sa = Math.sin(a) * size;
    const ux = tx * ca + bx * sa, uy = ty * ca + by * sa, uz = tz * ca + bz * sa;
    const vx = bx * ca - tx * sa, vy = by * ca - ty * sa, vz = bz * ca - tz * sa;
    // Lift off the surface slightly to avoid z-fighting.
    const cx = px + nx * 0.1, cy = py + ny * 0.1, cz = pz + nz * 0.1;

    const d = this.data;
    const slot = this.next;
    this.owner[slot] = owner;
    let o = slot * FLOATS_PER_DECAL;
    for (let k = 0; k < 4; k++) {
      const su = k === 0 || k === 3 ? -1 : 1;
      const sv = k < 2 ? -1 : 1;
      d[o++] = cx + ux * su + vx * sv;
      d[o++] = cy + uy * su + vy * sv;
      d[o++] = cz + uz * su + vz * sv;
      d[o++] = su;
      d[o++] = sv;
      d[o++] = seed;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, slot * FLOATS_PER_DECAL * 4, d, slot * FLOATS_PER_DECAL, FLOATS_PER_DECAL);

    this.next = (slot + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  // Removes every decal on a breakable (collapses its quad to a point).
  removeOwner(owner) {
    if (!owner) return;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      if (this.owner[i] !== owner) continue;
      this.data.fill(0, i * FLOATS_PER_DECAL, (i + 1) * FLOATS_PER_DECAL);
      this.owner[i] = 0;
      changed = true;
    }
    if (!changed) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * FLOATS_PER_DECAL);
  }

  draw(viewProj) {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.loc.u_viewProj, false, viewProj);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_SHORT, 0);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
