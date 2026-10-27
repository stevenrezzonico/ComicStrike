import assert from 'node:assert/strict';
import { ViewAnimator } from '../client/anim/viewanim.js';
import { buildArms, HAND_GRIP } from '../client/models/arms.js';
import { buildGun, GUN_MAG, GUN_BOLT } from '../client/models/guns.js';
import { ARMS_SKELETON as A } from '../client/anim/skeleton.js';
import * as Q from '../client/anim/quat.js';
import {
  WEAPONS, WEAPON_ID, createWeaponState, giveWeapon, WS_ACTIVE, WS_DEPLOY_END, WS_RELOAD_END, WS_LAST_SHOT,
} from '../shared/weapons.js';

const points = (name) => ({ ...buildGun(name), mesh: null });

// A weapon state holding `name`, deployed long ago.
function state(name) {
  const ws = createWeaponState();
  giveWeapon(ws, WEAPON_ID[name]);
  ws.f[WS_ACTIVE] = WEAPONS[WEAPON_ID[name]].slot;
  ws.f[WS_DEPLOY_END] = 1;
  return ws;
}

// Where hand s holds things: the wrist plus the grip offset along the hand.
function held(va, s) {
  const h = A.bone(s ? 'hand_R' : 'hand_L'), p = va.pose, v = new Float32Array(6);
  v[0] = HAND_GRIP;
  Q.rotate(v, 3, p.wrot, h * 4, v, 0);
  return [p.wpos[h * 3] + v[3], p.wpos[h * 3 + 1] + v[4], p.wpos[h * 3 + 2] + v[5]];
}

const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

Deno.test('first-person arms: closed, low-poly, both teams', () => {
  for (const team of ['T', 'CT']) {
    const m = buildArms(team);
    assert.ok(m.tris > 50 && m.tris <= 600, `${team}: ${m.tris} triangles`);
    const bones = new Set();
    const u8 = new Uint8Array(m.data);
    for (let v = 0; v < m.count; v++) bones.add(u8[v * 20 + 15]);
    assert.equal(bones.size, 6, 'both arms skinned to their bones');
  }
});

Deno.test('first-person: at rest both hands are on the gun, for every weapon', () => {
  WEAPONS.forEach((w) => {
    if (!w) return;
    const pts = points(w.name), va = new ViewAnimator();
    va.update(WEAPON_ID[w.name], state(w.name), 10, pts);
    // The right hand holds the grip (inside the hand: about an inch and a half from its
    // palm axis), the left hand the support point.
    const grip = apply(va.gun, w.name === 'knife' ? [0.4, 0, 0] : w.c4 ? [3, -2.3, 0] : [-0.75, 0, -1.6]);
    assert.ok(dist(held(va, 1), grip) < 1.6, `${w.name}: right hand ${dist(held(va, 1), grip).toFixed(2)} from the grip`);
    if (pts.support && w.name !== 'elite') {
      const sp = apply(va.gun, pts.support);
      assert.ok(dist(held(va, 0), sp) < 1.6, `${w.name}: left hand ${dist(held(va, 0), sp).toFixed(2)} from the support`);
    }
  });
});

Deno.test('first-person: a reload takes the magazine out and puts it back; the bolt cycles', () => {
  for (const name of ['ak47', 'glock', 'p90', 'negev']) {
    const w = WEAPONS[WEAPON_ID[name]], pts = points(name), ws = state(name), va = new ViewAnimator();
    ws.f[WS_RELOAD_END] = 10 + w.reloadTime;
    const at = (r) => {
      va.update(WEAPON_ID[name], ws, 10 + r * w.reloadTime, pts);
      const s = va.gunSkin;
      return [Math.hypot(s[GUN_MAG * 16 + 12], s[GUN_MAG * 16 + 13], s[GUN_MAG * 16 + 14]), -s[GUN_BOLT * 16 + 12]];
    };
    assert.ok(at(0.05)[0] < 0.01, `${name}: magazine in at the start`);
    assert.ok(at(0.44)[0] > 6, `${name}: magazine out mid-reload`);
    assert.ok(at(0.99)[0] < 0.01, `${name}: magazine back in`);
    assert.ok(at(0.785)[1] > 0.5, `${name}: bolt / slide pulled`);
    // The hand carries the magazine.
    at(0.35);
    const mag = va.gunSkin.subarray(GUN_MAG * 16, GUN_MAG * 16 + 16);
    const p = apply(mag, pts.mag);
    assert.ok(dist(held(va, 0), apply(va.gun, p)) < 2, `${name}: hand on the magazine`);
  }
});

Deno.test('first-person: shots cycle slides, bolts and pumps; the same state gives the same pose', () => {
  for (const [name, at, min] of [['glock', 0.02, 0.5], ['nova', 0.45, 2], ['awp', 0.5, 2]]) {
    const w = WEAPONS[WEAPON_ID[name]], ws = state(name), va = new ViewAnimator();
    ws.f[WS_LAST_SHOT] = 10;
    va.update(WEAPON_ID[name], ws, 10 + at * (name === 'glock' ? 1 : w.cycle), points(name));
    assert.ok(-va.gunSkin[GUN_BOLT * 16 + 12] > min, `${name}: ${-va.gunSkin[GUN_BOLT * 16 + 12]}`);
  }
  const a = new ViewAnimator(), b = new ViewAnimator(), ws = state('ak47'), pts = points('ak47');
  ws.f[WS_RELOAD_END] = 12;
  a.update(WEAPON_ID.ak47, ws, 11, pts);
  b.update(WEAPON_ID.ak47, ws, 11, pts);
  assert.deepEqual(a.pose.skin, b.pose.skin);
  assert.deepEqual(a.gun, b.gun);
});
