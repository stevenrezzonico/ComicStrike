// The visible part of the world, nearest first (GoldSrc's R_MarkLeaves + R_RecursiveWorldNode).
// Each BSP leaf has a row of the visibility lump (PVS): the leaves anything could be seen in
// from it. When the camera enters a new leaf, its visible leaves and their parent nodes get
// the new mark; every frame the tree is walked from the root, near child first, skipping
// unmarked nodes and those outside the view, and the opaque triangles of the faces in the
// leaves reached are copied out in that order. Typically 5-7 % of a map's triangles, and
// drawn front to back the GPU skips the hidden pixels of the far ones before shading them.
// Brush entities, sky, alpha-tested and see-through faces are drawn as before. A map with no
// visibility lump (de_playground), or a camera in solid (noclip), gets -1: draw everything.

const MARGIN = 32; // frustum slack (units): a face's leaf box may sit just outside the view

export class WorldVis {
  // mesh: buildMapMesh's result (indices, worldOpaqueCount, faceFirst, faceCount).
  constructor(bsp, mesh) {
    this.b = bsp;
    this.src = mesh.indices;
    this.faceFirst = mesh.faceFirst;
    this.faceCount = mesh.faceCount;
    this.out = new Uint32Array(mesh.worldOpaqueCount);
    this.visleafs = bsp.modelsI[13]; // model 0's leaf count (leaf 0, the shared solid one, aside)
    this.rowBytes = (this.visleafs + 7) >> 3;
    this.row = new Uint8Array(this.rowBytes);
    this.usable = bsp.visibility.length > 0;
    const nn = bsp.numNodes, nl = bsp.numLeaves;
    this.nodeParent = new Int32Array(nn).fill(-1);
    this.leafParent = new Int32Array(nl).fill(-1);
    for (let n = 0; n < nn; n++) {
      for (let k = 0; k < 2; k++) {
        const c = bsp.nodesI16[n * 12 + 2 + k];
        if (c >= 0) this.nodeParent[c] = n;
        else this.leafParent[-1 - c] = n;
      }
    }
    this.nodeMark = new Int32Array(nn);
    this.leafMark = new Int32Array(nl);
    this.faceStamp = new Int32Array(bsp.numFaces);
    this.visframe = 0;
    this.frame = 0;
    this.leaf = -1;
    this.stack = new Int32Array(nn + 1);
    this.planes = new Float32Array(16); // left, right, bottom, top: a b c d
  }

  // The leaf of model 0 holding point p.
  leafAt(x, y, z) {
    const b = this.b, pf = b.planesF;
    let n = b.modelsI[9];
    while (n >= 0) {
      const p = b.nodesI32[n * 6] * 5;
      n = b.nodesI16[n * 12 + 2 + (pf[p] * x + pf[p + 1] * y + pf[p + 2] * z - pf[p + 3] >= 0 ? 0 : 1)];
    }
    return -1 - n;
  }

  // Marks the leaves leaf `l` can see, and their parents (R_MarkLeaves).
  mark(l) {
    const b = this.b, vis = b.visibility, row = this.row;
    let ofs = b.leavesI32[l * 7 + 1];
    const v = ++this.visframe;
    let i = 0;
    while (i < this.rowBytes) { // run-length: a zero byte is followed by a count of zero bytes
      const c = vis[ofs++];
      if (c) row[i++] = c;
      else for (let z = vis[ofs++]; z > 0 && i < this.rowBytes; z--) row[i++] = 0;
    }
    for (let k = 1; k <= this.visleafs; k++) {
      if (!(row[(k - 1) >> 3] & (1 << ((k - 1) & 7)))) continue;
      this.leafMark[k] = v;
      for (let n = this.leafParent[k]; n >= 0 && this.nodeMark[n] !== v; n = this.nodeParent[n]) this.nodeMark[n] = v;
    }
  }

  // Is the box (int16 mins / maxs at `o` in arr) outside one of the frustum's side planes?
  culled(arr, o) {
    const pl = this.planes;
    for (let k = 0; k < 16; k += 4) {
      const a = pl[k], b = pl[k + 1], c = pl[k + 2];
      // The box corner furthest along the plane's normal.
      const x = a >= 0 ? arr[o + 3] : arr[o], y = b >= 0 ? arr[o + 4] : arr[o + 1], z = c >= 0 ? arr[o + 5] : arr[o + 2];
      if (a * x + b * y + c * z + pl[k + 3] < -MARGIN) return true;
    }
    return false;
  }

  // Fills `out` with the visible world's opaque triangles, nearest first, for a camera at
  // `eye` with view-projection `m` (column-major). Returns the index count, or -1: draw all.
  update(eye, m) {
    if (!this.usable) return -1;
    const b = this.b;
    const l = this.leafAt(eye[0], eye[1], eye[2]);
    if (l === 0 || b.leavesI32[l * 7 + 1] < 0) return -1; // in solid, or a leaf with no row
    if (l !== this.leaf) {
      this.leaf = l;
      this.mark(l);
    }
    // Side planes from the matrix rows (Gribb-Hartmann), scaled to unit normals so the
    // margin is in world units: left w+x, right w-x, bottom w+y, top w-y.
    const pl = this.planes;
    for (let k = 0; k < 4; k++) {
      const r = k >> 1, s = k & 1 ? -1 : 1;
      const a = m[3] + s * m[r], bb = m[7] + s * m[4 + r], c = m[11] + s * m[8 + r], d = m[15] + s * m[12 + r];
      const len = Math.sqrt(a * a + bb * bb + c * c) || 1;
      pl[k * 4] = a / len;
      pl[k * 4 + 1] = bb / len;
      pl[k * 4 + 2] = c / len;
      pl[k * 4 + 3] = d / len;
    }
    const v = this.visframe, f = ++this.frame;
    const pf = b.planesF, n16 = b.nodesI16, l16 = b.leavesI16, ms = b.marksurfaces;
    const src = this.src, out = this.out, first = this.faceFirst, count = this.faceCount;
    const stack = this.stack;
    let sp = 0, n = 0;
    stack[sp++] = b.modelsI[9];
    while (sp > 0) {
      const node = stack[--sp];
      if (node < 0) { // a leaf: its faces
        const leaf = -1 - node;
        if (this.leafMark[leaf] !== v || this.culled(l16, leaf * 14 + 4)) continue;
        const m0 = l16[leaf * 14 + 10] & 0xffff, m1 = m0 + (l16[leaf * 14 + 11] & 0xffff);
        for (let k = m0; k < m1; k++) {
          const face = ms[k];
          if (this.faceStamp[face] === f) continue;
          this.faceStamp[face] = f;
          const s = first[face];
          if (s < 0) continue;
          for (let i = s, e = s + count[face]; i < e; i++) out[n++] = src[i];
        }
        continue;
      }
      if (this.nodeMark[node] !== v || this.culled(n16, node * 12 + 4)) continue;
      const p = b.nodesI32[node * 6] * 5;
      const front = pf[p] * eye[0] + pf[p + 1] * eye[1] + pf[p + 2] * eye[2] - pf[p + 3] >= 0;
      // The far child first onto the stack, so the near one comes off first.
      stack[sp++] = n16[node * 12 + 2 + (front ? 1 : 0)];
      stack[sp++] = n16[node * 12 + 2 + (front ? 0 : 1)];
    }
    return n;
  }
}
