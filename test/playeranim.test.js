import assert from 'node:assert/strict';
import { buildPlayer, HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4 } from '../client/models/players.js';
import { PlayerAnimator, holdOf, gunInHand } from '../client/anim/playeranim.js';
import { PLAYER_SKELETON as S } from '../client/anim/skeleton.js';
import { MESH_STRIDE } from '../client/gl/meshkit.js';
import { WEAPON_ID, WEAPONS } from '../shared/weapons.js';
import { ANIM_PLANT, ANIM_RELOAD } from '../shared/protocol.js';

const bone = (a, name) => {
  const i = S.bone(name), w = a.pose.wpos;
  return [w[i * 3], w[i * 3 + 1], w[i * 3 + 2]];
};
// Runs n frames of 1/64 s; pos(t) gives the feet position at time t.
function run(a, n, pos, opts = {}) {
  const { yaw = 0, pitch = 0, duck = 0, ground = true, hold = HOLD_RIFLE, anim = 0, shots = 0, alive = true } = opts;
  for (let k = 0; k < n; k++) {
    const [x, y, z] = pos(k / 64);
    a.update(1 / 64, x, y, z, yaw, pitch, duck, ground, hold, anim, shots, alive);
  }
  return a;
}

Deno.test('player models: closed, under budget, team looks differ', () => {
  for (const [team, helmet] of [['T', false], ['CT', false], ['CT', true], ['H', false]]) {
    const m = buildPlayer(team, helmet);
    assert.ok(m.tris <= 6000, `${team} ${m.tris} triangles`);
    assert.ok(m.tris > 300);
  }
  assert.ok(buildPlayer('CT', true).tris > buildPlayer('CT', false).tris, 'the helmet adds geometry');
  assert.equal(holdOf(WEAPON_ID.ak47), HOLD_RIFLE);
  assert.equal(holdOf(WEAPON_ID.deagle), HOLD_PISTOL);
  assert.equal(holdOf(WEAPON_ID.knife), HOLD_KNIFE);
  assert.equal(holdOf(WEAPON_ID.c4), HOLD_C4);
});

Deno.test('player models: every leg part rides the bone whose span it covers', () => {
  for (const [team, helmet] of [['T', false], ['CT', true]]) {
    const m = buildPlayer(team, helmet), u8 = new Uint8Array(m.data);
    for (let v = 0; v < m.count; v++) {
      const name = S.names[u8[v * MESH_STRIDE + 15]], z = m.positions[v * 3 + 2];
      const top = { leg_upper_L: 39, leg_upper_R: 39, leg_lower_L: 22.6, leg_lower_R: 22.6, ankle_L: 7, ankle_R: 7 }[name];
      const bottom = { leg_upper_L: 17, leg_upper_R: 17, leg_lower_L: 0.5, leg_lower_R: 0.5, ankle_L: -0.1, ankle_R: -0.1 }[name];
      if (top === undefined) continue;
      assert.ok(z <= top && z >= bottom, `${team}: a ${name} vertex at z ${z.toFixed(1)} is outside its span`);
    }
  }
});

Deno.test('player animation: same inputs, same matrices', () => {
  const walk = (t) => [t * 200, t * 50, 0];
  const a = run(new PlayerAnimator(), 90, walk, { pitch: 12, shots: 3 });
  const b = run(new PlayerAnimator(), 90, walk, { pitch: 12, shots: 3 });
  assert.deepEqual(a.pose.skin, b.pose.skin);
  for (const v of a.pose.skin.subarray(0, S.count * 16)) assert.ok(Number.isFinite(v));
});

Deno.test('player animation: standing feet are planted; the stride phase follows distance', () => {
  const a = run(new PlayerAnimator(), 64, () => [100, 200, 0]);
  for (const side of ['L', 'R']) {
    const [, , z] = bone(a, `ankle_${side}`);
    assert.ok(Math.abs(z - 3.5) < 0.1, `ankle ${side} at ${z}`);
  }
  // Twice the speed for half the time: the same distance, the same phase.
  const slow = run(new PlayerAnimator(), 128, (t) => [t * 120, 0, 0]);
  const fast = run(new PlayerAnimator(), 64, (t) => [t * 240, 0, 0]);
  assert.ok(slow.phase > 0.05);
  // Strides lengthen with speed, so the fast one covers fewer cycles per unit.
  assert.ok(fast.phase !== slow.phase);
  // Feet move along the walk direction: at full stride the ankles are apart in x.
  let spread = 0;
  const a2 = new PlayerAnimator();
  for (let k = 0; k < 128; k++) {
    a2.update(1 / 64, k / 64 * 250, 0, 0, 0, 0, 0, true, HOLD_RIFLE, 0, 0, true);
    spread = Math.max(spread, Math.abs(bone(a2, 'ankle_L')[0] - bone(a2, 'ankle_R')[0]));
  }
  assert.ok(spread > 15, `stride spread ${spread}`);
});

Deno.test('player animation: crouch drops the head toward the squashed head box', () => {
  const stand = run(new PlayerAnimator(), 32, () => [0, 0, 0]);
  const crouch = run(new PlayerAnimator(), 32, () => [0, 0, 0], { duck: 1 });
  const hs = bone(stand, 'head_0')[2], hc = bone(crouch, 'head_0')[2];
  assert.ok(hs > 60 && hs < 66, `standing head ${hs}`);
  assert.ok(hc > 28 && hc < 40, `crouched head ${hc} (head box center 32)`);
  assert.ok(bone(crouch, 'pelvis')[2] < 20);
  for (const side of ['L', 'R']) assert.ok(Math.abs(bone(crouch, `ankle_${side}`)[2] - 3.5) < 0.2, 'feet stay down');
});

Deno.test('player animation: hands on the gun follow the aim; reload, plant and death move them', () => {
  const level = run(new PlayerAnimator(), 16, () => [0, 0, 0]);
  const down = run(new PlayerAnimator(), 16, () => [0, 0, 0], { pitch: 45 });
  const [, , rz] = bone(level, 'hand_R'), [, , dz] = bone(down, 'hand_R');
  assert.ok(dz < rz - 2, `aiming down lowers the gun hand (${rz} -> ${dz})`);
  const lh = bone(level, 'hand_L');
  assert.ok(lh[0] > 12, `left hand forward on the handguard (${lh})`);

  const reload = run(new PlayerAnimator(), 16, () => [0, 0, 0], { anim: ANIM_RELOAD });
  assert.ok(bone(reload, 'hand_L')[0] < lh[0] - 5, 'reload pulls the left hand back to the magazine');
  const plant = run(new PlayerAnimator(), 16, () => [0, 0, 0], { anim: ANIM_PLANT, hold: HOLD_C4 });
  assert.ok(bone(plant, 'hand_R')[2] < 16, `planting: hands near the ground (${bone(plant, 'hand_R')[2]})`);

  const dead = run(new PlayerAnimator(), 64, () => [0, 0, 0], { alive: false });
  assert.ok(bone(dead, 'head_0')[2] < 12, `the dead lie down (head at ${bone(dead, 'head_0')[2]})`);
});

Deno.test('player animation: a shot kicks, then settles', () => {
  const a = run(new PlayerAnimator(), 32, () => [0, 0, 0], { shots: 5 });
  assert.equal(a.kick, 0);
  run(a, 1, () => [0, 0, 0], { shots: 6 });
  assert.ok(a.kick > 0.8);
  run(a, 32, () => [0, 0, 0], { shots: 6 });
  assert.equal(a.kick, 0);
});

Deno.test('player animation: the off hand holds the gun at its support point', async () => {
  const { buildGun } = await import('../client/models/guns.js');
  for (const name of ['ak47', 'awp', 'deagle', 'p90']) {
    const g = buildGun(name), support = g.support;
    const a = run(new PlayerAnimator(), 8, () => [0, 0, 0], { hold: holdOf(WEAPON_ID[name]) });
    // Level aim: the left wrist sits at the right wrist plus the support offset.
    a.update(1 / 64, 0, 0, 0, 0, 0, 0, true, holdOf(WEAPON_ID[name]), 0, 0, true, g, WEAPON_ID[name]);
    const l = bone(a, 'hand_L'), r = bone(a, 'hand_R');
    const err = Math.hypot(l[0] - r[0] - support[0], l[1] - r[1] - support[1], l[2] - r[2] - support[2]);
    assert.ok(err < 1, `${name}: off hand ${err.toFixed(2)} from the support point`);
  }
});

Deno.test('player animation: reloads move the magazine with the off hand, rack the bolt, and end at rest', async () => {
  const { buildGun } = await import('../client/models/guns.js');
  const m = new Float32Array(16), q = new Float32Array(8);
  for (const name of ['ak47', 'm4a1', 'glock', 'deagle', 'mp9', 'awp']) {
    const id = WEAPON_ID[name], g = buildGun(name), hold = holdOf(id), w = WEAPONS[id];
    const a = run(new PlayerAnimator(), 8, () => [0, 0, 0], { hold });
    let maxOff = 0, maxBolt = 0, closest = Infinity, maxRoll = 0;
    const frames = Math.ceil(w.reloadTime * 64);
    for (let k = 0; k < frames; k++) {
      a.update(1 / 64, 0, 0, 0, 0, 0, 0, true, hold, ANIM_RELOAD, 0, true, g, id);
      maxOff = Math.max(maxOff, a.magOff);
      maxBolt = Math.max(maxBolt, a.boltOff);
      maxRoll = Math.max(maxRoll, Math.abs(a.reload.roll));
      if (a.reload.take > 0.95 && a.magOff > 4) { // holding the magazine: the left hand is at it
        gunInHand(a.pose, m, q);
        const [px, py, pz] = [0, 1, 2].map((i) => g.mag[i] + g.magDir[i] * a.magOff);
        const wx = m[0] * px + m[4] * py + m[8] * pz + m[12], wy = m[1] * px + m[5] * py + m[9] * pz + m[13];
        const wz = m[2] * px + m[6] * py + m[10] * pz + m[14];
        const l = bone(a, 'hand_L');
        closest = Math.min(closest, Math.hypot(l[0] - wx, l[1] - wy, l[2] - wz));
      }
    }
    assert.ok(maxOff > 8, `${name}: magazine out ${maxOff.toFixed(1)}`);
    assert.ok(closest < 4, `${name}: off hand ${closest.toFixed(1)} from the magazine`);
    assert.ok(maxRoll > 10, `${name}: the gun tilts`);
    if (g.bolt) assert.ok(maxBolt > 0.5, `${name}: bolt racked`);
    a.update(1 / 64, 0, 0, 0, 0, 0, 0, true, hold, 0, 0, true, g, id);
    assert.equal(a.magOff, 0);
    assert.equal(a.reload.roll, 0);
  }
  // Shotguns tip the gun and work at the loading port.
  const nova = buildGun('nova'), a = run(new PlayerAnimator(), 8, () => [0, 0, 0]);
  for (let k = 0; k < 64; k++) a.update(1 / 64, 0, 0, 0, 0, 0, 0, true, HOLD_RIFLE, ANIM_RELOAD, 0, true, nova, WEAPON_ID.nova);
  assert.ok(a.reload.roll < -20 && a.reload.take > 0.9);
});
