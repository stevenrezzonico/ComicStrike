import assert from 'node:assert/strict';
import {
  parseBSP, parseEntities, faceNumEdges, faceVertex, faceTexinfo,
  modelFirstFace, modelNumFaces, entityModelIndex,
} from '../shared/bsp.js';

const MAPS = new URL('../maps/', import.meta.url);

async function load(name) {
  try {
    return parseBSP((await Deno.readFile(new URL(name, MAPS))).buffer);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

Deno.test('parseEntities handles keys, values and multiple blocks', () => {
  const ents = parseEntities('{\n"classname" "worldspawn"\n"wad" "a.wad"\n}\n{ "classname" "info_player_start" "origin" "1 2 3" }');
  assert.equal(ents.length, 2);
  assert.equal(ents[0].wad, 'a.wad');
  assert.equal(ents[1].origin, '1 2 3');
});

Deno.test('rejects non-v30 files', () => {
  const buf = new ArrayBuffer(4 + 15 * 8);
  new DataView(buf).setInt32(0, 29, true);
  assert.throws(() => parseBSP(buf), /version 29/);
});

Deno.test('de_dust2 parses into consistent lumps', async (t) => {
  const b = await load('de_dust2.bsp');
  if (!b) return t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });

  assert.equal(b.version, 30);
  assert.ok(b.numFaces > 1000);
  assert.equal(b.entities[0].classname, 'worldspawn');

  // Plane normals are unit length.
  for (let i = 0; i < b.numPlanes; i++) {
    const x = b.planesF[i * 5], y = b.planesF[i * 5 + 1], z = b.planesF[i * 5 + 2];
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-3, `plane ${i} not normalized`);
  }

  // Every face references valid vertices and texinfo.
  const numVerts = b.vertices.length / 3;
  for (let f = 0; f < b.numFaces; f++) {
    const n = faceNumEdges(b, f);
    assert.ok(n >= 3, `face ${f} has ${n} edges`);
    for (let i = 0; i < n; i++) assert.ok(faceVertex(b, f, i) < numVerts);
    assert.ok(faceTexinfo(b, f) < b.numTexinfo);
  }

  // World model covers a prefix of the faces; brush entities reference valid models.
  assert.equal(modelFirstFace(b, 0), 0);
  assert.ok(modelNumFaces(b, 0) > 0);
  for (const e of b.entities) {
    const m = entityModelIndex(e);
    if (m >= 0) assert.ok(m < b.numModels, `${e.classname} -> *${m}`);
  }

  const spawnsT = b.entities.filter((e) => e.classname === 'info_player_deathmatch');
  const spawnsCT = b.entities.filter((e) => e.classname === 'info_player_start');
  assert.ok(spawnsT.length > 0 && spawnsCT.length > 0);
});

Deno.test('every map in maps/ parses', async () => {
  let n = 0;
  try {
    for await (const ent of Deno.readDir(MAPS)) {
      if (!ent.name.endsWith('.bsp')) continue;
      const b = await load(ent.name);
      assert.ok(b.numFaces > 0, ent.name);
      n++;
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  console.log(`parsed ${n} maps`);
});
