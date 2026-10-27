import assert from 'node:assert/strict';
import { FL_DUCKING } from '../shared/pmove.js';
import { WEAPONS, WEAPON_ID } from '../shared/weapons.js';
import {
  HitTargets, hitgroupScale, HITGROUP_HEAD, HITGROUP_CHEST, HITGROUP_STOMACH, HITGROUP_LEGS,
} from '../shared/hitgroups.js';

// One target standing at the origin (hull center z = 36, feet at 0), facing +x.
function target(flags = 0, duck = 0, yaw = 0) {
  const t = new HitTargets(4);
  t.set(1, 0, 0, 36, yaw, flags, duck, 2);
  return t;
}

Deno.test('hit groups by height: head, chest, stomach, legs', () => {
  const t = target();
  for (const [z, group] of [[64, HITGROUP_HEAD], [50, HITGROUP_CHEST], [36, HITGROUP_STOMACH], [12, HITGROUP_LEGS]]) {
    assert.equal(t.trace(-200, 0, z, 1, 0, 0, 1000, -1, 0), 1, `z=${z}`);
    assert.equal(t.group, group, `z=${z}`);
  }
  assert.equal(t.trace(-200, 0, 75, 1, 0, 0, 1000, -1, 0), -1, 'over the head');
  assert.equal(t.trace(-200, 20, 50, 1, 0, 0, 1000, -1, 0), -1, 'beside the body');
  assert.ok(Math.abs(t.trace(-200, 0, 50, 1, 0, 0, 1000, -1, 0) === 1 && t.dist - 193) < 1e-6, 'enters the chest box');
});

Deno.test('crouching lowers the head; turning turns the boxes; walls and teammates stop nothing', () => {
  const ducked = new HitTargets(4);
  ducked.set(1, 0, 0, 18, 0, FL_DUCKING, 1, 2); // duck hull center 18 above the feet
  assert.equal(ducked.trace(-200, 0, 64, 1, 0, 0, 1000, -1, 0), -1, 'standing head height is empty');
  assert.equal(ducked.trace(-200, 0, 32, 1, 0, 0, 1000, -1, 0), 1);
  assert.equal(ducked.group, HITGROUP_HEAD);

  // The head sits 1.5 units forward: facing +y it reaches y = 6.5, facing +x only 4.5.
  const turned = target(0, 0, 90);
  assert.equal(turned.trace(-200, 6, 64, 1, 0, 0, 1000, -1, 0), 1);
  assert.equal(turned.group, HITGROUP_HEAD);
  assert.equal(target().trace(-200, 6, 64, 1, 0, 0, 1000, -1, 0), -1, 'facing +x the head is not there');

  const t = target();
  assert.equal(t.trace(-200, 0, 50, 1, 0, 0, 150, -1, 0), -1, 'a wall at 150 units is nearer');
  assert.equal(t.trace(-200, 0, 50, 1, 0, 0, 1000, -1, 2), -1, 'friendly fire off');
  assert.equal(t.trace(-200, 0, 50, 1, 0, 0, 1000, 1, 0), -1, 'never yourself');
});

Deno.test('CS:GO damage scale per hit group', () => {
  const ak = WEAPONS[WEAPON_ID.ak47];
  assert.equal(hitgroupScale(HITGROUP_HEAD, ak), 4);
  assert.equal(hitgroupScale(HITGROUP_STOMACH, ak), 1.25);
  assert.equal(hitgroupScale(HITGROUP_LEGS, ak), 0.75);
  assert.equal(hitgroupScale(HITGROUP_CHEST, ak), 1);
});
