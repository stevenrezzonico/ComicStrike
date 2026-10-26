import assert from 'node:assert/strict';
import { parseBSP, parseVec3 } from '../shared/bsp.js';
import { TICK_DT, IN_FORWARD, IN_JUMP, IN_DUCK, IN_SPEED, IN_MOVERIGHT } from '../shared/constants.js';
import { CollisionWorld, Trace, traceHull, hullFits, HULL_POINT, HULL_STAND, ENT_LADDER, ENT_SOLID } from '../shared/trace.js';
import {
  createPlayerState, playerMove, PS_ORIGIN, PS_VEL, PS_FLAGS, PS_EVENTS, PS_WATERLEVEL,
  FL_ONGROUND, FL_DUCKING, EV_JUMP, EV_LAND, MOVE,
} from '../shared/pmove.js';
import { boxWorld, floorWorld, emptyWorld, FLOOR, WATER } from './worlds.js';

const KNIFE = 250;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}±${eps}, got ${a}`);
const hspeed = (ps) => Math.hypot(ps.f[PS_VEL], ps.f[PS_VEL + 1]);

function spawn(x, y, z, vx = 0, vy = 0, vz = 0) {
  const ps = createPlayerState();
  ps.f.set([x, y, z], PS_ORIGIN);
  ps.f.set([vx, vy, vz], PS_VEL);
  return ps;
}

// Runs n ticks with fixed input; onTick(ps, tick) may return new buttons.
function run(world, ps, n, buttons = 0, yaw = 0, pitch = 0, onTick = null) {
  for (let t = 0; t < n; t++) {
    playerMove(world, ps, buttons, pitch, yaw, TICK_DT, KNIFE);
    if (onTick) {
      const r = onTick(ps, t);
      if (r !== undefined) buttons = r;
    }
  }
  return ps;
}

function settle(world, ps) {
  return run(world, ps, 64);
}

Deno.test('trace: point and player hulls hit the floor at the right height', () => {
  const w = floorWorld();
  const tr = new Trace();
  traceHull(w, HULL_POINT, 0, 0, 100, 0, 0, -100, tr);
  near(tr.endz, 0, 0.05, 'point hull impact z');
  assert.equal(tr.nz, 1);
  traceHull(w, HULL_STAND, 0, 0, 100, 0, 0, -100, tr);
  near(tr.endz, 36, 0.05, 'standing hull impact z');
  near(tr.fraction, (100 - 36) / 200, 1e-3);
});

Deno.test('trace: starting inside solid reports startsolid with fraction 0', () => {
  const w = floorWorld();
  const tr = new Trace();
  traceHull(w, HULL_STAND, 0, 0, 10, 0, 0, 50, tr);
  assert.ok(tr.startsolid);
  assert.equal(tr.fraction, 0);
  assert.equal(hullFits(w, HULL_STAND, 0, 0, 10), false);
  assert.equal(hullFits(w, HULL_STAND, 0, 0, 37), true);
});

Deno.test('falling player lands on the floor and reports the landing', () => {
  const w = floorWorld();
  const ps = spawn(0, 0, 200);
  let landed = 0;
  run(w, ps, 128, 0, 0, 0, (p) => {
    if (p.i[PS_EVENTS] & EV_LAND) landed++;
  });
  assert.equal(landed, 1);
  assert.ok(ps.i[PS_FLAGS] & FL_ONGROUND);
  near(ps.f[PS_ORIGIN + 2], 36, 0.05);
  assert.equal(ps.f[PS_VEL + 2], 0);
});

Deno.test('ground acceleration reaches knife speed quickly and caps at it', () => {
  const w = floorWorld();
  const ps = settle(w, spawn(0, 0, 36));
  let t90 = -1;
  run(w, ps, 64, IN_FORWARD, 0, 0, (p, t) => {
    if (t90 < 0 && hspeed(p) >= 225) t90 = t;
  });
  near(hspeed(ps), KNIFE, 0.5, 'top speed');
  // Source ordering (friction, then accelerate) with CS:GO convars: ~0.36 s to 90%.
  assert.ok(t90 >= 0 && t90 * TICK_DT < 0.4, `90% speed after ${t90 * TICK_DT}s`);
  assert.ok(ps.f[PS_ORIGIN] > 200, 'moved forward along +x');
});

Deno.test('friction stops a running player within ~0.5 s', () => {
  const w = floorWorld();
  const ps = run(w, settle(w, spawn(0, 0, 36)), 64, IN_FORWARD);
  run(w, ps, 32);
  assert.ok(hspeed(ps) < 1, `still moving at ${hspeed(ps)}`);
});

Deno.test('walk and crouch speed modifiers', () => {
  const w = floorWorld();
  const walk = run(w, settle(w, spawn(0, 0, 36)), 64, IN_FORWARD | IN_SPEED);
  near(hspeed(walk), KNIFE * MOVE.walkModifier, 0.5, 'walk speed');
  const duck = run(w, settle(w, spawn(0, 0, 36)), 64, IN_FORWARD | IN_DUCK);
  near(hspeed(duck), KNIFE * MOVE.duckModifier, 0.5, 'duck speed');
  assert.ok(duck.i[PS_FLAGS] & FL_DUCKING);
  near(duck.f[PS_ORIGIN + 2], 18, 0.05, 'duck hull center sits 18 above the floor');
});

Deno.test('standing up is blocked under a low ceiling', () => {
  const ceiling = { min: [-100, -100, 40], max: [100, 100, 60] };
  const w = floorWorld(ceiling);
  const ps = run(w, settle(w, spawn(0, 0, 36)), 32, IN_DUCK);
  assert.ok(ps.i[PS_FLAGS] & FL_DUCKING);
  run(w, ps, 32); // release duck
  assert.ok(ps.i[PS_FLAGS] & FL_DUCKING, 'stood up into the ceiling');
  run(w, ps, 128, IN_FORWARD); // crouch-walk (85 u/s) out from under it
  run(w, ps, 64);
  assert.ok(!(ps.i[PS_FLAGS] & FL_DUCKING), 'did not stand once clear');
});

function jumpPeak(buttonsInAir) {
  const w = floorWorld();
  const ps = settle(w, spawn(0, 0, 36));
  let peakFeet = 0;
  run(w, ps, 1, IN_JUMP);
  run(w, ps, 96, buttonsInAir, 0, 0, (p) => {
    const feet = p.f[PS_ORIGIN + 2] - ((p.i[PS_FLAGS] & FL_DUCKING) ? 18 : 36);
    peakFeet = Math.max(peakFeet, feet);
  });
  return { peakFeet, ps };
}

Deno.test('jump height matches CS:GO (~57 units)', () => {
  const { peakFeet, ps } = jumpPeak(0);
  assert.ok(peakFeet > 54 && peakFeet < 58, `peak ${peakFeet}`);
  assert.ok(ps.i[PS_FLAGS] & FL_ONGROUND, 'landed again');
});

Deno.test('crouch-jump raises the feet ~9 more units', () => {
  const { peakFeet } = jumpPeak(IN_DUCK);
  assert.ok(peakFeet > 62 && peakFeet < 68, `peak ${peakFeet}`);
});

Deno.test('holding jump does not auto-bunnyhop', () => {
  const w = floorWorld();
  const ps = settle(w, spawn(0, 0, 36));
  let jumps = 0;
  run(w, ps, 192, IN_JUMP, 0, 0, (p) => {
    if (p.i[PS_EVENTS] & EV_JUMP) jumps++;
  });
  assert.equal(jumps, 1);
});

Deno.test('steps up to stepsize (18) but not higher', () => {
  for (const [h, expectUp] of [[16, true], [18, true], [24, false]]) {
    const step = { min: [100, -1000, -10], max: [1000, 1000, h] };
    const w = floorWorld(step);
    const ps = run(w, settle(w, spawn(0, 0, 36)), 96, IN_FORWARD);
    if (expectUp) {
      near(ps.f[PS_ORIGIN + 2], 36 + h, 0.1, `step ${h}`);
      assert.ok(ps.f[PS_ORIGIN] > 200, `step ${h}: did not continue forward`);
    } else {
      near(ps.f[PS_ORIGIN], 100 - 16, 0.1, `step ${h}: should be blocked at the riser`);
    }
  }
});

Deno.test('air strafing gains speed; strafing without turning does not', () => {
  const w = emptyWorld();
  const turning = spawn(0, 0, 0, KNIFE, 0, 0);
  let yaw = 0;
  for (let t = 0; t < 64; t++) {
    // Keep the strafe direction perpendicular to velocity (optimal strafe).
    yaw = Math.atan2(turning.f[PS_VEL + 1], turning.f[PS_VEL]) * 180 / Math.PI;
    playerMove(w, turning, IN_MOVERIGHT, 0, yaw, TICK_DT, KNIFE);
  }
  assert.ok(hspeed(turning) > 330, `strafe gain only reached ${hspeed(turning)}`);

  const straight = run(w, spawn(0, 0, 0, KNIFE, 0, 0), 64, IN_MOVERIGHT);
  assert.ok(hspeed(straight) < 255, `no-turn strafe reached ${hspeed(straight)}`);
});

Deno.test('ladders: pressing forward climbs at ~200 u/s', () => {
  const ladder = { kind: ENT_LADDER, boxes: [{ min: [200, -32, 0], max: [208, 32, 500] }] };
  const w = boxWorld([FLOOR], [ladder]);
  const ps = settle(w, spawn(186, 0, 36));
  const z0 = ps.f[PS_ORIGIN + 2];
  run(w, ps, 32, IN_FORWARD);
  near(ps.f[PS_ORIGIN + 2] - z0, MOVE.ladderSpeed * 0.5, 8, 'climbed in 0.5 s');
  const z1 = ps.f[PS_ORIGIN + 2];
  run(w, ps, 16);
  near(ps.f[PS_ORIGIN + 2], z1, 0.01, 'holds position on the ladder without input');
});

Deno.test('water: submerged player sinks idle and swims up with jump', () => {
  const pool = { min: [-500, -500, 0], max: [500, 500, 200], contents: WATER };
  const w = boxWorld([{ min: [-8192, -8192, -8192], max: [8192, 8192, -1] }, pool]);
  const ps = run(w, spawn(0, 0, 120), 32);
  assert.equal(ps.i[PS_WATERLEVEL], 3);
  assert.ok(ps.f[PS_VEL + 2] < 0, 'should sink');
  const z = ps.f[PS_ORIGIN + 2];
  run(w, ps, 32, IN_JUMP);
  assert.ok(ps.f[PS_ORIGIN + 2] > z + 20, 'should swim up');
});

Deno.test('conveyor carries a standing player and its momentum survives leaving it', () => {
  // 16-unit platform pushing +x at 400 u/s on top of the floor.
  const belt = { kind: ENT_SOLID, boxes: [{ min: [-200, -200, 0], max: [200, 200, 16] }], push: [400, 0, 0] };
  const w = boxWorld([FLOOR], [belt]);
  const ps = run(w, spawn(-150, 0, 16 + 36), 16);
  const x0 = ps.f[PS_ORIGIN];
  run(w, ps, 16);
  near(ps.f[PS_ORIGIN] - x0, 400 * 0.25, 2, 'distance carried in 0.25 s');
  near(ps.f[PS_VEL], 0, 0.01, 'own velocity stays zero while riding');

  let maxOwn = 0;
  run(w, ps, 64, 0, 0, 0, (p) => {
    if (p.f[PS_ORIGIN] > 200 + 16) maxOwn = Math.max(maxOwn, p.f[PS_VEL]);
  });
  // The belt is lower than stepsize, so we step down onto the floor: momentum
  // (speed * (1 + dt/2)) transfers, then one tick of floor friction applies.
  near(maxOwn, 400 * (1 + TICK_DT / 2) * (1 - MOVE.friction * TICK_DT), 0.5, 'momentum after leaving the belt');
  assert.ok(ps.f[PS_ORIGIN] > 216 + 50, `slid on past the belt end (x=${ps.f[PS_ORIGIN]})`); // ~v/friction = 71 units
});

Deno.test('fy_buzzkill: conveyor ramp launches the player onto the central tower', async (t) => {
  let buf;
  try {
    buf = await Deno.readFile(new URL('../maps/fy_buzzkill.bsp', import.meta.url));
  } catch {
    return t.step({ name: 'skipped: maps/fy_buzzkill.bsp missing', fn: () => {}, ignore: true });
  }
  const w = CollisionWorld.fromBSP(parseBSP(buf.buffer));
  const ps = run(w, spawn(-512, -1000, -200), 64); // in front of the +y ramp
  near(ps.f[PS_ORIGIN + 2], -284, 1, 'standing on the arena floor');
  run(w, ps, 40, IN_FORWARD, 90); // walk onto the ramp
  run(w, ps, 160, 0, 90); // fly
  assert.ok(ps.i[PS_FLAGS] & FL_ONGROUND, 'landed');
  near(ps.f[PS_ORIGIN + 2], 36, 1, 'standing on the tower top (z=0)');
});

Deno.test('movement is bit-for-bit deterministic', () => {
  const w = floorWorld({ min: [300, -50, 0], max: [400, 50, 16] });
  const script = (_p, t) => [IN_FORWARD, IN_FORWARD | IN_JUMP, IN_DUCK | IN_MOVERIGHT, 0][(t >> 4) & 3];
  const a = run(w, spawn(0, 0, 40), 400, 0, 20, 5, script);
  const b = run(w, spawn(0, 0, 40), 400, 0, 20, 5, script);
  assert.deepEqual(new Uint8Array(a.buf), new Uint8Array(b.buf));
});

Deno.test('de_dust2: every spawn settles on the ground and can walk', async (t) => {
  let buf;
  try {
    buf = await Deno.readFile(new URL('../maps/de_dust2.bsp', import.meta.url));
  } catch {
    return t.step({ name: 'skipped: maps/de_dust2.bsp missing', fn: () => {}, ignore: true });
  }
  const bsp = parseBSP(buf.buffer);
  const w = CollisionWorld.fromBSP(bsp);
  const spawns = bsp.entities.filter((e) => /^info_player_(start|deathmatch)$/.test(e.classname));
  assert.ok(spawns.length >= 20);
  const o = new Float32Array(3);
  for (const s of spawns) {
    parseVec3(s.origin, o);
    const ps = settle(w, spawn(o[0], o[1], o[2]));
    assert.ok(ps.i[PS_FLAGS] & FL_ONGROUND, `spawn ${s.origin} not grounded`);
    assert.ok(hullFits(w, HULL_STAND, ps.f[0], ps.f[1], ps.f[2]), `spawn ${s.origin} stuck`);
    assert.ok(Math.abs(ps.f[2] - o[2]) < 40, `spawn ${s.origin} fell to ${ps.f[2]}`);
    run(w, ps, 128, IN_FORWARD, +(s.angle || 0));
    assert.ok(hullFits(w, HULL_STAND, ps.f[0], ps.f[1], ps.f[2]), `walked into solid from ${s.origin}`);
    assert.ok(ps.f[2] > -4096 && ps.f[2] < 4096, `left the map from ${s.origin}`);
  }
});
