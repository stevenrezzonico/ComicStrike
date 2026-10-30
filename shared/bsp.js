// GoldSrc BSP (version 30) parser.
// Lumps are exposed as typed-array views over the file buffer (copied only when
// misaligned). Fixed-size records are read by index arithmetic, never as objects.

export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_TEXTURES = 2;
export const LUMP_VERTICES = 3;
export const LUMP_VISIBILITY = 4;
export const LUMP_NODES = 5;
export const LUMP_TEXINFO = 6;
export const LUMP_FACES = 7;
export const LUMP_LIGHTING = 8;
export const LUMP_CLIPNODES = 9;
export const LUMP_LEAVES = 10;
export const LUMP_MARKSURFACES = 11;
export const LUMP_EDGES = 12;
export const LUMP_SURFEDGES = 13;
export const LUMP_MODELS = 14;

// Leaf / hull contents.
export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SLIME = -4;
export const CONTENTS_LAVA = -5;
export const CONTENTS_SKY = -6;

// Record sizes in bytes.
const PLANE_SIZE = 20;
const NODE_SIZE = 24;
const TEXINFO_SIZE = 40;
const FACE_SIZE = 20;
const CLIPNODE_SIZE = 8;
const LEAF_SIZE = 28;
const MODEL_SIZE = 64;

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error('bsp: big-endian hosts are not supported');
}

function lumpView(buffer, offset, length, Ctor) {
  const count = Math.floor(length / Ctor.BYTES_PER_ELEMENT);
  if (offset % Ctor.BYTES_PER_ELEMENT === 0) return new Ctor(buffer, offset, count);
  return new Ctor(buffer.slice(offset, offset + count * Ctor.BYTES_PER_ELEMENT));
}

// Aligned copy of a lump so several typed views can alias the same records.
function lumpBuffer(buffer, offset, length) {
  if (offset % 4 === 0) return { buf: buffer, off: offset };
  return { buf: buffer.slice(offset, offset + length), off: 0 };
}

function readCString(bytes, start, max) {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = bytes[start + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function parseEntities(text) {
  const out = [];
  const re = /"([^"]*)"|([{}])/g;
  let ent = null;
  let key = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[2] === '{') {
      ent = {};
      key = null;
    } else if (m[2] === '}') {
      if (ent) out.push(ent);
      ent = null;
    } else if (ent) {
      if (key === null) key = m[1];
      else {
        ent[key] = m[1];
        key = null;
      }
    }
  }
  return out;
}

export function parseBSP(buffer) {
  const dv = new DataView(buffer);
  const version = dv.getInt32(0, true);
  if (version !== 30) throw new Error(`bsp: unsupported version ${version} (expected 30)`);

  const lumpOfs = new Int32Array(15);
  const lumpLen = new Int32Array(15);
  for (let i = 0; i < 15; i++) {
    lumpOfs[i] = dv.getInt32(4 + i * 8, true);
    lumpLen[i] = dv.getInt32(8 + i * 8, true);
    if (lumpOfs[i] < 0 || lumpLen[i] < 0 || lumpOfs[i] + lumpLen[i] > buffer.byteLength) {
      throw new Error(`bsp: lump ${i} out of bounds`);
    }
  }
  const raw = (lump, Ctor) => lumpView(buffer, lumpOfs[lump], lumpLen[lump], Ctor);
  const records = (lump, size) => {
    if (lumpLen[lump] % size !== 0) throw new Error(`bsp: lump ${lump} size not a multiple of ${size}`);
    return lumpBuffer(buffer, lumpOfs[lump], lumpLen[lump]);
  };

  // Planes: float normal[3], float dist, int32 type
  const pl = records(LUMP_PLANES, PLANE_SIZE);
  const numPlanes = lumpLen[LUMP_PLANES] / PLANE_SIZE;
  const planesF = new Float32Array(pl.buf, pl.off, numPlanes * 5);
  const planesI = new Int32Array(pl.buf, pl.off, numPlanes * 5);

  // Vertices: float[3]
  const vertices = raw(LUMP_VERTICES, Float32Array);

  // Nodes: int32 plane, int16 children[2], int16 mins[3], maxs[3], uint16 firstface, numfaces
  const nd = records(LUMP_NODES, NODE_SIZE);
  const numNodes = lumpLen[LUMP_NODES] / NODE_SIZE;
  const nodesI32 = new Int32Array(nd.buf, nd.off, numNodes * 6);
  const nodesI16 = new Int16Array(nd.buf, nd.off, numNodes * 12);

  // Texinfo: float vecs[2][4], int32 miptex, int32 flags
  const ti = records(LUMP_TEXINFO, TEXINFO_SIZE);
  const numTexinfo = lumpLen[LUMP_TEXINFO] / TEXINFO_SIZE;
  const texinfoF = new Float32Array(ti.buf, ti.off, numTexinfo * 10);
  const texinfoI = new Int32Array(ti.buf, ti.off, numTexinfo * 10);

  // Faces: uint16 plane, int16 side, int32 firstedge, int16 numedges, int16 texinfo,
  //        uint8 styles[4], int32 lightofs
  const fc = records(LUMP_FACES, FACE_SIZE);
  const numFaces = lumpLen[LUMP_FACES] / FACE_SIZE;
  const facesU16 = new Uint16Array(fc.buf, fc.off, numFaces * 10);
  const facesI16 = new Int16Array(fc.buf, fc.off, numFaces * 10);
  const facesI32 = new Int32Array(fc.buf, fc.off, numFaces * 5);
  const facesU8 = new Uint8Array(fc.buf, fc.off, numFaces * 20);

  // Clipnodes: int32 plane, int16 children[2]
  const cn = records(LUMP_CLIPNODES, CLIPNODE_SIZE);
  const numClipnodes = lumpLen[LUMP_CLIPNODES] / CLIPNODE_SIZE;
  const clipnodesI32 = new Int32Array(cn.buf, cn.off, numClipnodes * 2);
  const clipnodesI16 = new Int16Array(cn.buf, cn.off, numClipnodes * 4);

  // Leaves: int32 contents, int32 visofs, int16 mins[3], maxs[3], uint16 firstmark, nummark, uint8 ambient[4]
  const lf = records(LUMP_LEAVES, LEAF_SIZE);
  const numLeaves = lumpLen[LUMP_LEAVES] / LEAF_SIZE;
  const leavesI32 = new Int32Array(lf.buf, lf.off, numLeaves * 7);
  const leavesI16 = new Int16Array(lf.buf, lf.off, numLeaves * 14);

  // Models: float mins[3], maxs[3], origin[3], int32 headnode[4], visleafs, firstface, numfaces
  const md = records(LUMP_MODELS, MODEL_SIZE);
  const numModels = lumpLen[LUMP_MODELS] / MODEL_SIZE;
  const modelsF = new Float32Array(md.buf, md.off, numModels * 16);
  const modelsI = new Int32Array(md.buf, md.off, numModels * 16);

  const edges = raw(LUMP_EDGES, Uint16Array);
  const surfedges = raw(LUMP_SURFEDGES, Int32Array);
  const marksurfaces = raw(LUMP_MARKSURFACES, Uint16Array);
  const lighting = new Uint8Array(buffer, lumpOfs[LUMP_LIGHTING], lumpLen[LUMP_LIGHTING]);
  const visibility = new Uint8Array(buffer, lumpOfs[LUMP_VISIBILITY], lumpLen[LUMP_VISIBILITY]);

  // Textures: int32 count, int32 offsets[count]; miptex = char name[16], uint32 w, h, offsets[4]
  const texBase = lumpOfs[LUMP_TEXTURES];
  const numTextures = lumpLen[LUMP_TEXTURES] > 0 ? dv.getInt32(texBase, true) : 0;
  if (numTextures < 0 || 4 + numTextures * 4 > lumpLen[LUMP_TEXTURES]) throw new Error('bsp: bad texture count');
  const textureNames = new Array(numTextures);
  const textureSize = new Uint16Array(numTextures * 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < numTextures; i++) {
    const ofs = dv.getInt32(texBase + 4 + i * 4, true);
    if (ofs < 0) {
      textureNames[i] = '';
      textureSize[i * 2] = textureSize[i * 2 + 1] = 64;
      continue;
    }
    const p = texBase + ofs;
    textureNames[i] = readCString(bytes, p, 16).toLowerCase();
    textureSize[i * 2] = dv.getUint32(p + 16, true) || 64;
    textureSize[i * 2 + 1] = dv.getUint32(p + 20, true) || 64;
  }

  const entText = new TextDecoder('latin1').decode(
    new Uint8Array(buffer, lumpOfs[LUMP_ENTITIES], lumpLen[LUMP_ENTITIES]),
  );

  return {
    version,
    numPlanes, planesF, planesI,
    vertices,
    numNodes, nodesI32, nodesI16,
    numTexinfo, texinfoF, texinfoI,
    numFaces, facesU16, facesI16, facesI32, facesU8,
    numClipnodes, clipnodesI32, clipnodesI16,
    numLeaves, leavesI32, leavesI16,
    numModels, modelsF, modelsI,
    edges, surfedges, marksurfaces, lighting, visibility,
    numTextures, textureNames, textureSize,
    entities: parseEntities(entText),
  };
}

// --- Untrusted maps --------------------------------------------------------

// Limits for a map from outside (a player's own file, a room on the server): every engine
// part trusts indices, recursion depth and sizes, so a file is checked before any of them
// sees it. Real maps stay far inside these (GoldSrc's own limits are lower).
export const BSP_LIMITS = {
  coord: 16384, // |x|, |y|, |z| of every vertex and model bound (the floor grids cover the map)
  depth: 512, // BSP tree depth (the traces recurse)
  faceEdges: 256, // corners of one face
  lightmap: 256, // lightmap texels along a face's side
  entities: 8192,
  textures: 8192,
};

// Throws unless every index in the parsed map points inside its lump, the trees are trees
// (children after their parent, as the BSP compilers write them: no cycles) of bounded
// depth, coordinates are finite and bounded, and entity models exist.
export function validateBSP(b, L = BSP_LIMITS) {
  const fail = (what) => {
    throw new Error(`bsp: ${what}`);
  };
  const finite = (x, lim = Infinity) => Number.isFinite(x) && Math.abs(x) <= lim;
  const nv = Math.floor(b.vertices.length / 3), ne = b.edges.length >> 1, nse = b.surfedges.length;
  if (b.numModels < 1 || b.numNodes < 1 || b.numLeaves < 1 || b.numPlanes < 1) fail('missing lumps');
  for (let i = 0; i < nv * 3; i++) if (!finite(b.vertices[i], L.coord)) fail(`vertex ${Math.floor(i / 3)} out of range`);
  for (let i = 0; i < b.numPlanes; i++) {
    for (let k = 0; k < 4; k++) if (!finite(b.planesF[i * 5 + k], 1e6)) fail(`plane ${i}`);
  }
  for (let i = 0; i < ne * 2; i++) if (b.edges[i] >= nv) fail(`edge ${i >> 1}`);
  for (let i = 0; i < nse; i++) if (Math.abs(b.surfedges[i]) >= ne) fail(`surfedge ${i}`);
  if (b.numTextures > L.textures) fail('too many textures');
  for (let i = 0; i < b.numTexinfo; i++) {
    for (let k = 0; k < 8; k++) if (!finite(b.texinfoF[i * 10 + k], 1e6)) fail(`texinfo ${i}`);
    const mt = b.texinfoI[i * 10 + 8];
    if (mt < 0 || mt >= b.numTextures) fail(`texinfo ${i} texture`);
  }
  for (let f = 0; f < b.numFaces; f++) {
    const first = faceFirstEdge(b, f), n = faceNumEdges(b, f), ti = faceTexinfo(b, f);
    if (facePlane(b, f) >= b.numPlanes) fail(`face ${f} plane`);
    if (n < 3 || n > L.faceEdges || first < 0 || first + n > nse) fail(`face ${f} edges`);
    if (ti < 0 || ti >= b.numTexinfo) fail(`face ${f} texinfo`);
    let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = faceVertex(b, f, i) * 3;
      const x = b.vertices[v], y = b.vertices[v + 1], z = b.vertices[v + 2];
      const t = b.texinfoF;
      const S = x * t[ti * 10] + y * t[ti * 10 + 1] + z * t[ti * 10 + 2] + t[ti * 10 + 3];
      const T = x * t[ti * 10 + 4] + y * t[ti * 10 + 5] + z * t[ti * 10 + 6] + t[ti * 10 + 7];
      smin = Math.min(smin, S);
      smax = Math.max(smax, S);
      tmin = Math.min(tmin, T);
      tmax = Math.max(tmax, T);
    }
    if (faceLightOfs(b, f) >= 0 && ((smax - smin) / 16 > L.lightmap || (tmax - tmin) / 16 > L.lightmap)) {
      fail(`face ${f} lightmap extents`);
    }
  }
  for (let i = 0; i < b.marksurfaces.length; i++) if (b.marksurfaces[i] >= b.numFaces) fail(`marksurface ${i}`);
  for (let i = 0; i < b.numLeaves; i++) {
    const contents = b.leavesI32[i * 7], vis = b.leavesI32[i * 7 + 1];
    const first = b.leavesI16[i * 14 + 10] & 0xffff, n = b.leavesI16[i * 14 + 11] & 0xffff;
    if (contents > -1 || contents < -15) fail(`leaf ${i} contents`);
    if (vis >= b.visibility.length) fail(`leaf ${i} visibility`);
    if (first + n > b.marksurfaces.length) fail(`leaf ${i} faces`);
  }
  // Trees: nodes (hull 0) end in leaves, clipnodes (hulls 1-3) in contents.
  for (let i = 0; i < b.numNodes; i++) {
    if (b.nodesI32[i * 6] < 0 || b.nodesI32[i * 6] >= b.numPlanes) fail(`node ${i} plane`);
    const ff = b.nodesI16[i * 12 + 10] & 0xffff, nf = b.nodesI16[i * 12 + 11] & 0xffff;
    if (ff + nf > b.numFaces) fail(`node ${i} faces`);
    for (let k = 0; k < 2; k++) {
      const c = b.nodesI16[i * 12 + 2 + k];
      if (c >= b.numNodes || (c < 0 && -c - 1 >= b.numLeaves)) fail(`node ${i} child`);
    }
  }
  checkTree(b.numNodes, (i, k) => b.nodesI16[i * 12 + 2 + k], L.depth, fail, 'node');
  for (let i = 0; i < b.numClipnodes; i++) {
    if (b.clipnodesI32[i * 2] < 0 || b.clipnodesI32[i * 2] >= b.numPlanes) fail(`clipnode ${i} plane`);
    for (let k = 0; k < 2; k++) {
      const c = b.clipnodesI16[i * 4 + 2 + k];
      if (c >= b.numClipnodes || c < -15) fail(`clipnode ${i} child`);
    }
  }
  checkTree(b.numClipnodes, (i, k) => b.clipnodesI16[i * 4 + 2 + k], L.depth, fail, 'clipnode');
  for (let m = 0; m < b.numModels; m++) {
    for (let k = 0; k < 9; k++) if (!finite(b.modelsF[m * 16 + k], L.coord * 2)) fail(`model ${m} bounds`);
    const h0 = modelHeadnode(b, m, 0);
    if (h0 >= b.numNodes || (h0 < 0 && -h0 - 1 >= b.numLeaves)) fail(`model ${m} head node`);
    for (let h = 1; h < 4; h++) {
      const head = modelHeadnode(b, m, h);
      if (head >= b.numClipnodes || head < -15) fail(`model ${m} hull ${h}`);
    }
    if (modelFirstFace(b, m) < 0 || modelNumFaces(b, m) < 0 || modelFirstFace(b, m) + modelNumFaces(b, m) > b.numFaces) {
      fail(`model ${m} faces`);
    }
  }
  if (b.entities.length > L.entities) fail('too many entities');
  for (const e of b.entities) {
    const m = entityModelIndex(e);
    if (m !== -1 && !(m >= 0 && m < b.numModels)) fail(`entity model ${e.model}`);
  }
  return b;
}

// No cycles and at most `maxDepth` levels below any node (children: child(i, 0 | 1), < 0 a
// leaf). Some compilers share subtrees and write children before parents, so it is a
// depth-first walk with colors (grey: on the path, a cycle if met again), each node once.
function checkTree(n, child, maxDepth, fail, what) {
  const height = new Int32Array(n).fill(-1); // -1 unseen, -2 on the current path, else levels below
  const stack = new Int32Array(maxDepth + 2), side = new Uint8Array(maxDepth + 2);
  for (let root = 0; root < n; root++) {
    if (height[root] !== -1) continue;
    let sp = 0;
    stack[0] = root;
    side[0] = 0;
    height[root] = -2;
    while (sp >= 0) {
      const i = stack[sp];
      if (side[sp] < 2) {
        const c = child(i, side[sp]++);
        if (c < 0 || height[c] >= 0) continue;
        if (height[c] === -2) fail(`${what} ${i}: cycle`);
        if (sp + 1 > maxDepth) fail(`${what} tree too deep`);
        stack[++sp] = c;
        side[sp] = 0;
        height[c] = -2;
      } else {
        const a = child(i, 0), z = child(i, 1);
        height[i] = 1 + Math.max(a < 0 ? 0 : height[a], z < 0 ? 0 : height[z]);
        sp--;
      }
    }
  }
}

// The map name for a map file from outside: its file name, plain characters only (maps are
// named [\w-]+ everywhere: URLs, the console, the protocol).
export function mapNameOf(fileName) {
  const base = String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.bsp$/i, '').toLowerCase();
  return base.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 31) || 'custom';
}

// parseBSP for a file from outside: parsed, then checked (validateBSP).
export const parseUntrustedBSP = (buffer) => validateBSP(parseBSP(buffer));

// --- Record accessors (no allocation) -------------------------------------

export const faceTexinfo = (b, f) => b.facesI16[f * 10 + 5];
export const faceFirstEdge = (b, f) => b.facesI32[f * 5 + 1];
export const faceNumEdges = (b, f) => b.facesI16[f * 10 + 4];
export const facePlane = (b, f) => b.facesU16[f * 10];
export const faceSide = (b, f) => b.facesI16[f * 10 + 1];
export const faceLightOfs = (b, f) => b.facesI32[f * 5 + 4];
export const faceStyle = (b, f, i) => b.facesU8[f * 20 + 12 + i];

// Vertex index of the i-th corner of a face (respecting surfedge sign).
export function faceVertex(b, f, i) {
  const se = b.surfedges[faceFirstEdge(b, f) + i];
  return se >= 0 ? b.edges[se * 2] : b.edges[-se * 2 + 1];
}

export const modelHeadnode = (b, m, hull) => b.modelsI[m * 16 + 9 + hull];
export const modelFirstFace = (b, m) => b.modelsI[m * 16 + 14];
export const modelNumFaces = (b, m) => b.modelsI[m * 16 + 15];

// Brush-model index referenced by an entity's "model" key ("*3" -> 3), or -1.
export function entityModelIndex(ent) {
  const m = ent.model;
  return m && m[0] === '*' ? parseInt(m.slice(1), 10) : -1;
}

export function parseVec3(str, out, o = 0) {
  const p = (str || '0 0 0').trim().split(/\s+/);
  out[o] = +p[0] || 0;
  out[o + 1] = +p[1] || 0;
  out[o + 2] = +p[2] || 0;
  return out;
}
