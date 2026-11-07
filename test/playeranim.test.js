import assert from 'node:assert/strict';
import { buildPlayer, HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4, HOLD_TIED } from '../client/models/players.js';
import { PlayerAnimator, holdOf, gunInHand, primeAnimator } from '../client/anim/playeranim.js';
import { PLAYER_SKELETON as S } from '../client/anim/skeleton.js';

const PLAYER_BIND_X = (name) => S.bind[S.bone(name) * 3]; // a bone's x at the bind pose
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
    // The coarse (far) version: a third of the triangles, the same bones, the same height.
    const c = buildPlayer(team, helmet, true);
    assert.ok(c.tris <= 1700 && c.tris < m.tris / 2.5, `${team} coarse ${c.tris} triangles`);
    assert.equal(c.bones, m.bones);
    const top = (mesh) => Math.max(...Array.from({ length: mesh.count }, (_, v) => mesh.positions[v * 3 + 2]));
    assert.ok(Math.abs(top(c) - top(m)) < 0.5, 'as tall');
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

// The priming run at load (the optimizer's type feedback) goes through every state without
// a gun's points and with them; it must leave the shared animator code with sane poses.
Deno.test('player animation: the priming run goes through every state', () => {
  primeAnimator(null);
  const points = [];
  for (const name of ['ak47', 'nova', 'revolver']) points[WEAPON_ID[name]] = { support: [10, 0, 0], mag: [2, 0, -3], magDir: [0, 0, -1], bolt: [-3, 0, 2], port: [0, 0, -1], cylinder: [1, 0, 1] };
  primeAnimator(points);
  const a = new PlayerAnimator();
  a.update(1 / 60, 0, 0, 0, 0, 0, 0, true, HOLD_RIFLE, 0, 0, true);
  assert.ok(a.pose.skin.every((v) => Number.isFinite(v)), 'a fresh animator poses after the priming');
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

Deno.test('player animation: lifted feet swing the way we walk, planted feet push back (no moonwalk)', () => {
  for (const [dir, what] of [[1, 'forward'], [-1, 'backward']]) {
    const a = new PlayerAnimator();
    let lifted = 0, planted = 0, prev = null;
    for (let k = 0; k < 192; k++) {
      a.update(1 / 64, dir * k / 64 * 250, 0, 0, 0, 0, 0, true, HOLD_RIFLE, 0, 0, true);
      const [x, , z] = bone(a, 'ankle_L');
      if (prev && k > 32) {
        if (z > 5) lifted += x - prev;
        else if (z < 3.7) planted += x - prev;
      }
      prev = x;
    }
    assert.ok(lifted * dir > 5, `${what}: the lifted foot swings ${what} (${lifted.toFixed(1)})`);
    assert.ok(planted * dir < -5, `${what}: the planted foot pushes back (${planted.toFixed(1)})`);
  }
});

Deno.test('player animation: in water it treads upright, kicking; swimming, it leans forward with the legs behind', () => {
  const tread = new PlayerAnimator();
  tread.swim = true;
  let lo = Infinity, hi = -Infinity;
  run(tread, 64, () => [0, 0, 0], { ground: false });
  for (let k = 0; k < 128; k++) {
    run(tread, 1, () => [0, 0, 0], { ground: false });
    const x = bone(tread, 'ankle_L')[0];
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  assert.ok(bone(tread, 'head_0')[2] > 55, `upright (head at ${bone(tread, 'head_0')[2].toFixed(1)})`);
  assert.ok(hi - lo > 6, `a scissor kick (the ankle ${lo.toFixed(1)} .. ${hi.toFixed(1)})`);
  const swim = new PlayerAnimator();
  swim.swim = true;
  run(swim, 128, (t) => [t * 200, 0, 0], { ground: false });
  const pelvis = bone(swim, 'pelvis'), head = bone(swim, 'head_0'), ankle = bone(swim, 'ankle_L');
  assert.ok(head[0] - pelvis[0] > 15, `leaning forward (head ${(head[0] - pelvis[0]).toFixed(1)} ahead of the hips)`);
  assert.ok(pelvis[0] - ankle[0] > 15, `the legs behind (${(pelvis[0] - ankle[0]).toFixed(1)})`);
  assert.ok(swim.pose.skin.every((v) => Number.isFinite(v)));
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

  const dead = run(new PlayerAnimator(), 80, () => [0, 0, 0], { alive: false });
  assert.ok(bone(dead, 'head_0')[2] < 14, `the dead lie down (head at ${bone(dead, 'head_0')[2]})`);
});

// Every joint at or above the ground (z >= -1), checked each frame.
function aboveGround(a, n, opts) {
  for (let k = 0; k < n; k++) {
    run(a, 1, () => [0, 0, 0], opts);
    for (let i = 0; i < S.count; i++) assert.ok(a.pose.wpos[i * 3 + 2] > -1, `${S.names[i]} under the ground at frame ${k}`);
  }
  return a;
}

Deno.test('player animation: a death collapses in place, knees first, then over to a side', () => {
  const a = new PlayerAnimator();
  run(a, 8, () => [0, 0, 0]);
  const standing = bone(a, 'pelvis')[2];
  aboveGround(a, 20, { alive: false }); // 0.31 s: the knees have given, the feet still planted
  assert.ok(bone(a, 'pelvis')[2] < standing - 15, `hips dropped (${bone(a, 'pelvis')[2]})`);
  assert.ok(bone(a, 'head_0')[2] > 30, 'still up, folding');
  for (const side of ['L', 'R']) assert.ok(Math.abs(bone(a, `ankle_${side}`)[2] - 3.5) < 0.5, 'feet planted');
  aboveGround(a, 60, { alive: false }); // 1.25 s: on the ground
  assert.ok(bone(a, 'head_0')[2] < 14, `lying (head at ${bone(a, 'head_0')[2]})`);
  assert.ok(bone(a, 'pelvis')[2] < 12);
  // The seed picks the side: odd falls to the left (+y), even to the right.
  const left = new PlayerAnimator(), right = new PlayerAnimator();
  left.die(0, 0, false, 0, 0, 1);
  right.die(0, 0, false, 0, 0, 2);
  aboveGround(left, 80, { alive: false });
  aboveGround(right, 80, { alive: false });
  assert.ok(bone(left, 'head_0')[1] > 8, `left: head at y ${bone(left, 'head_0')[1]}`);
  assert.ok(bone(right, 'head_0')[1] < -8, `right: head at y ${bone(right, 'head_0')[1]}`);
  const again = new PlayerAnimator();
  again.die(0, 0, false, 0, 0, 1);
  aboveGround(again, 80, { alive: false });
  assert.deepEqual(again.pose.skin, left.pose.skin, 'deterministic by seed');
});

Deno.test('player animation: a headshot throws the body back along the shot, onto its back', () => {
  const a = new PlayerAnimator();
  run(a, 8, () => [0, 0, 0]);
  a.die(-1, 0, true, 40, 0, 7); // shot from the front (the shot travels -x), 40 units of room
  aboveGround(a, 10, { alive: false }); // 0.16 s: head snapped back, body lifting and moving
  assert.ok(bone(a, 'pelvis')[0] < -8, `moving back (${bone(a, 'pelvis')[0]})`);
  assert.ok(bone(a, 'pelvis')[2] > 30, 'still up');
  aboveGround(a, 70, { alive: false }); // 1.25 s: lying on the back beyond the throw
  const pelvis = bone(a, 'pelvis'), head = bone(a, 'head_0');
  assert.ok(pelvis[0] < -36 && pelvis[0] > -50, `thrown back ${pelvis[0]}`);
  assert.ok(pelvis[2] < 10 && head[2] < 14, `on the ground (${pelvis[2]}, ${head[2]})`);
  assert.ok(head[0] < pelvis[0] - 15, 'head further along the shot than the hips');
  for (const side of ['L', 'R']) assert.ok(bone(a, `ankle_${side}`)[0] > pelvis[0] + 10, 'feet back where he stood');
  // The shot in the world turns into the player's frame: facing +y (yaw 90), a shot
  // travelling +x throws him to his right (-y in his frame... which is +x in the world).
  const b = new PlayerAnimator();
  run(b, 8, () => [0, 0, 0], { yaw: 90 });
  b.die(1, 0, true, 40, 0, 7);
  run(b, 80, () => [0, 0, 0], { yaw: 90, alive: false });
  assert.ok(bone(b, 'pelvis')[1] < -30, `in his frame the shot goes -y (${bone(b, 'pelvis')[1]})`);
  // No room (a wall at the back): tips over where he stands.
  const c = new PlayerAnimator();
  c.die(-1, 0, true, 0, 0, 7);
  aboveGround(c, 80, { alive: false });
  assert.ok(bone(c, 'pelvis')[0] > -12 && bone(c, 'head_0')[2] < 14);
});

Deno.test('player animation: a shot kicks, then settles', () => {
  const a = run(new PlayerAnimator(), 32, () => [0, 0, 0], { shots: 5 });
  assert.equal(a.kick, 0);
  run(a, 1, () => [0, 0, 0], { shots: 6 });
  assert.ok(a.kick > 0.8);
  run(a, 32, () => [0, 0, 0], { shots: 6 });
  assert.equal(a.kick, 0);
});

Deno.test('player animation: a weapon throw swings the gun hand forward and back', () => {
  const a = run(new PlayerAnimator(), 32, () => [0, 0, 0], { hold: HOLD_PISTOL });
  const rest = bone(a, 'hand_R')[0];
  a.throwArm();
  let reach = rest;
  for (let i = 0; i < 32; i++) {
    run(a, 1, () => [0, 0, 0], { hold: HOLD_PISTOL });
    reach = Math.max(reach, bone(a, 'hand_R')[0]);
  }
  assert.ok(reach > rest + 5, `the hand swings forward (${(reach - rest).toFixed(1)} units)`);
  assert.equal(a.toss, 0);
  assert.ok(Math.abs(bone(a, 'hand_R')[0] - rest) < 1, 'and comes back (within a breath)');
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

Deno.test('player models: a deltoid covers each shoulder joint; broad shoulders', () => {
  const m = buildPlayer('T'), u8 = new Uint8Array(m.data);
  for (const side of ['L', 'R']) {
    const j = S.bone(`arm_upper_${side}`), [jx, jy, jz] = [S.bind[j * 3], S.bind[j * 3 + 1], S.bind[j * 3 + 2]];
    assert.ok(Math.abs(jy) > 9, `the ${side} shoulder joint is out at the chest's edge (${jy})`);
    // Vertices of the clavicle (the deltoid's main bone) all round the joint, within 5 units.
    let n = 0;
    for (let v = 0; v < m.count; v++) {
      if (S.names[u8[v * MESH_STRIDE + 15]] !== `clavicle_${side}`) continue;
      const dx = m.positions[v * 3] - jx, dy = m.positions[v * 3 + 1] - jy, dz = m.positions[v * 3 + 2] - jz;
      assert.ok(dx * dx + dy * dy + dz * dz < 25, `a ${side} deltoid vertex ${Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1)} from the joint`);
      n++;
    }
    assert.ok(n > 30, `${side} deltoid vertices: ${n}`);
  }
});

Deno.test('player animation: the ready stance stands apart, bladed and leaning; breathing stays small', () => {
  const a = run(new PlayerAnimator(), 64, () => [0, 0, 0], { hold: HOLD_RIFLE });
  const l = bone(a, 'ankle_L'), r = bone(a, 'ankle_R');
  assert.ok(l[1] - r[1] > 11, `feet apart at rest (${(l[1] - r[1]).toFixed(1)})`);
  assert.ok(l[0] - r[0] > 2, 'the right foot back for a rifle');
  assert.ok(bone(a, 'pelvis')[2] < 37.5, 'knees soft');
  const sh = bone(a, 'arm_upper_L'), sr = bone(a, 'arm_upper_R');
  assert.ok(sh[0] > sr[0] + 6, 'bladed: the left shoulder ahead of the right');
  assert.ok(bone(a, 'head_0')[0] > bone(a, 'pelvis')[0] + 1, 'leaning forward');
  const pistol = run(new PlayerAnimator(), 64, () => [0, 0, 0], { hold: HOLD_PISTOL });
  assert.ok(Math.abs(bone(pistol, 'ankle_L')[0] - bone(pistol, 'ankle_R')[0]) < 0.5, 'a pistol stance is square');
  // Breathing and sway over 4 s move the hands and hips by less than a unit and a half.
  let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
  for (let k = 0; k < 256; k++) {
    run(a, 1, () => [0, 0, 0], { hold: HOLD_RIFLE });
    const h = bone(a, 'hand_R'), p = bone(a, 'pelvis');
    lo = Math.min(lo, h[2]);
    hi = Math.max(hi, h[2]);
    ylo = Math.min(ylo, p[1]);
    yhi = Math.max(yhi, p[1]);
  }
  assert.ok(hi - lo > 0.05 && hi - lo < 1.5, `the gun hand breathes (${(hi - lo).toFixed(2)})`);
  assert.ok(yhi - ylo > 0.2 && yhi - ylo < 1.5, `the weight sways (${(yhi - ylo).toFixed(2)})`);
});

Deno.test('player animation: moving leans into the direction and the hips swing with the stride', () => {
  const fwd = run(new PlayerAnimator(), 64, (t) => [t * 250, 0, 0], { hold: HOLD_RIFLE });
  const still = run(new PlayerAnimator(), 64, () => [0, 0, 0], { hold: HOLD_RIFLE });
  const leanOf = (a) => bone(a, 'head_0')[0] - bone(a, 'pelvis')[0];
  assert.ok(leanOf(fwd) > leanOf(still) + 1, 'leans forward running');
  const back = run(new PlayerAnimator(), 64, (t) => [-t * 250, 0, 0], { hold: HOLD_RIFLE });
  assert.ok(leanOf(back) < leanOf(still) - 1, 'leans back backpedalling');
  // The hips turn one way then the other over a stride.
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 64; k++) {
    run(fwd, 1, () => [(64 + k) / 64 * 250, 0, 0], { hold: HOLD_RIFLE });
    const d = bone(fwd, 'leg_upper_L')[0] - bone(fwd, 'leg_upper_R')[0];
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  assert.ok(hi - lo > 1, `the hips swing (${(hi - lo).toFixed(2)})`);
});

Deno.test('player animation: a planted foot does not slide; the swing lifts high at a run, low at a walk', () => {
  // Running along x at 250 u/s: the world x of an ankle on the ground stays put from frame to frame.
  const a = run(new PlayerAnimator(), 64, (t) => [t * 250, 0, 0], { hold: HOLD_RIFLE });
  let maxSlide = 0, hi = 0, planted = 0;
  const last = [NaN, NaN];
  for (let k = 0; k < 64; k++) {
    const x = (64 + k) / 64 * 250;
    run(a, 1, () => [x, 0, 0], { hold: HOLD_RIFLE });
    for (const [s, side] of [[0, 'L'], [1, 'R']]) {
      const [ax, , az] = bone(a, `ankle_${side}`);
      hi = Math.max(hi, az);
      if (a.footLift[s] === 0) { // planted (its ankle may rise on the heel or the ball)
        if (!Number.isNaN(last[s])) maxSlide = Math.max(maxSlide, Math.abs(ax + x - last[s]));
        last[s] = ax + x;
        planted++;
      } else last[s] = NaN;
    }
  }
  assert.ok(planted > 20, `feet on the ground part of the time (${planted} frames)`);
  assert.ok(maxSlide < 0.6, `a planted foot slides ${maxSlide.toFixed(2)} units a frame`);
  assert.ok(hi > 14, `the swing lifts the foot (${hi.toFixed(1)})`);
  const w = run(new PlayerAnimator(), 64, (t) => [t * 60, 0, 0], { hold: HOLD_RIFLE });
  let wh = 0;
  for (let k = 0; k < 96; k++) {
    run(w, 1, () => [(64 + k) / 64 * 60, 0, 0], { hold: HOLD_RIFLE });
    wh = Math.max(wh, bone(w, 'ankle_L')[2]);
  }
  assert.ok(wh > 5 && wh < 11, `walking lifts less (${wh.toFixed(1)})`);
});

Deno.test('player animation: a run lands heel first and pushes off from the ball, hips high, feet near the line', () => {
  const pitchOf = (a, side) => { // degrees, toes down positive
    const q = a.pose.wrot, i = S.bone(`ankle_${side}`) * 4;
    return Math.asin(Math.max(-1, Math.min(1, 2 * (q[i + 3] * q[i + 1] - q[i + 2] * q[i])))) * 180 / Math.PI;
  };
  const a = run(new PlayerAnimator(), 64, (t) => [t * 250, 0, 0], { hold: HOLD_RIFLE });
  const stand = bone(run(new PlayerAnimator(), 64, () => [0, 0, 0], { hold: HOLD_RIFLE }), 'pelvis')[2];
  let up = 0, down = 0, low = Infinity, wide = 0;
  for (let k = 0; k < 64; k++) {
    run(a, 1, () => [(64 + k) / 64 * 250, 0, 0], { hold: HOLD_RIFLE });
    for (const [s, side] of [[0, 'L'], [1, 'R']]) {
      if (a.footLift[s] !== 0) continue;
      up = Math.min(up, pitchOf(a, side));
      down = Math.max(down, pitchOf(a, side));
      wide = Math.max(wide, Math.abs(bone(a, `ankle_${side}`)[1]));
    }
    low = Math.min(low, bone(a, 'pelvis')[2]);
  }
  assert.ok(Math.abs(up) > 3 && down > 25, `toes up landing (${up.toFixed(0)}), heel up pushing off (${down.toFixed(0)})`);
  assert.ok(stand - low < 5, `the hips drop ${(stand - low).toFixed(1)} running (a lunge was ~9)`);
  assert.ok(wide < 4, `planted feet ${wide.toFixed(1)} from the line`);
});

Deno.test('player animation: the clavicles carry the shoulders toward a gun held out, back for tied hands', () => {
  const rest = PLAYER_BIND_X('arm_upper_L');
  const rifle = run(new PlayerAnimator(), 32, () => [0, 0, 0], { hold: HOLD_RIFLE });
  const knife = run(new PlayerAnimator(), 32, () => [0, 0, 0], { hold: HOLD_KNIFE });
  const fwdOf = (a, side) => { // the shoulder joint ahead of its clavicle's root, in the chest's frame
    const c = bone(a, `clavicle_${side}`), j = bone(a, `arm_upper_${side}`), q = a.pose.wrot, i = S.bone('spine_3') * 4;
    const dx = j[0] - c[0], dy = j[1] - c[1], dz = j[2] - c[2];
    // chest forward axis (x of spine_3's world rotation)
    const fx = 1 - 2 * (q[i + 1] * q[i + 1] + q[i + 2] * q[i + 2]), fy = 2 * (q[i] * q[i + 1] + q[i + 3] * q[i + 2]), fz = 2 * (q[i] * q[i + 2] - q[i + 3] * q[i + 1]);
    return dx * fx + dy * fy + dz * fz;
  };
  assert.ok(Math.abs(rest) < 1e-6);
  assert.ok(fwdOf(rifle, 'L') > 1.5, `the rifle's support shoulder forward (${fwdOf(rifle, 'L').toFixed(2)})`);
  assert.ok(fwdOf(rifle, 'L') > fwdOf(knife, 'L') + 1, 'more than with the knife');
});

// A world point in spine_3's frame (the chest: its origin at the bone, x forward, y left).
function inChest(a, p) {
  const i = S.bone('spine_3'), q = a.pose.wrot, w = a.pose.wpos;
  const vx = p[0] - w[i * 3], vy = p[1] - w[i * 3 + 1], vz = p[2] - w[i * 3 + 2];
  const qx = -q[i * 4], qy = -q[i * 4 + 1], qz = -q[i * 4 + 2], qw = q[i * 4 + 3]; // the inverse turn
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

Deno.test('player animation: elbows and upper arms stay outside the chest, every hold, moving or not, aiming up or down', () => {
  // The chest's core in spine_3's frame: an arm's center line in here has gone through the
  // chest (hanging against its broad sides is not: the torso is 17-20 wide, the joints at 9.75).
  const inside = ([x, y, z]) => z > -5 && z < 3 && Math.abs(y) < 6.2 && Math.abs(x) < 4.5;
  for (const hold of [HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4, HOLD_TIED]) {
    for (const [move, pos, duck] of [['still', () => [0, 0, 0], 0], ['run', (t) => [t * 250, 0, 0], 0], ['crouch', () => [0, 0, 0], 1]]) {
      for (const pitch of [-60, 0, 60]) {
        const a = run(new PlayerAnimator(), 48, pos, { hold, pitch, duck });
        for (const side of ['L', 'R']) {
          const sh = bone(a, `arm_upper_${side}`), el = bone(a, `arm_lower_${side}`);
          const mid = [(sh[0] + el[0]) / 2, (sh[1] + el[1]) / 2, (sh[2] + el[2]) / 2];
          for (const [what, p] of [['elbow', el], ['upper arm', mid]]) {
            const c = inChest(a, p);
            assert.ok(!inside(c), `hold ${hold} ${move} pitch ${pitch}: the ${side} ${what} inside the chest at ${c.map((v) => v.toFixed(1))}`);
          }
        }
      }
    }
  }
});

Deno.test('player animation: feet and hips turn part way toward a strafe; backpedalling keeps them forward', () => {
  const footYaw = (a, side) => {
    const q = a.pose.wrot, i = S.bone(`ankle_${side}`) * 4;
    return Math.atan2(2 * (q[i + 3] * q[i + 2] + q[i] * q[i + 1]), 1 - 2 * (q[i + 1] * q[i + 1] + q[i + 2] * q[i + 2])) * 180 / Math.PI;
  };
  const left = run(new PlayerAnimator(), 64, (t) => [0, t * 250, 0], { hold: HOLD_PISTOL });
  const fwd = run(new PlayerAnimator(), 64, (t) => [t * 250, 0, 0], { hold: HOLD_PISTOL });
  assert.ok(footYaw(left, 'L') - footYaw(fwd, 'L') > 30, `the left foot turns into a left strafe (${(footYaw(left, 'L') - footYaw(fwd, 'L')).toFixed(0)} degrees)`);
  assert.ok(bone(left, 'leg_upper_L')[0] < bone(left, 'leg_upper_R')[0] - 1, 'the hips turn toward the strafe');
  const back = run(new PlayerAnimator(), 64, (t) => [-t * 250, 0, 0], { hold: HOLD_PISTOL });
  assert.ok(Math.abs(footYaw(back, 'L') - footYaw(fwd, 'L')) < 5, 'backpedalling feet point forward');
});
