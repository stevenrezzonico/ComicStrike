// Builds maps/de_playground.bsp, ComicStrike's own test map (the demo mode's playground):
// a walled courtyard under the sky with every kind of map element to try out: stairs
// and a lift, a ladder tower, breakable crates and glass and an exploding barrel, a
// conveyor belt, a metal yard with a cart on rails and a shutter a valve works, a
// shallow pool with a deeper end and a diving well, sliding / swinging / button doors, two bomb sites
// (B's crates blow up with the bomb) and both spawns with buy zones.
//
// deno run --allow-write=maps tools/gen_demomap.js
//
// The map is written in the GoldSrc BSP 30 format by our own box compiler
// (shared/bspwriter.js, also the map editor's). Deterministic: the same file every run.
// Not used by the game at runtime.

import { MapBuilder, box, wedge, NONE } from '../shared/bspwriter.js';

const OUT = new URL('../maps/de_playground.bsp', import.meta.url);

// --- The map ---------------------------------------------------------------------------

// Textures: name -> [width, height] (the shaders scale their patterns by it).
const TEX = {
  sky: [256, 256],
  aaatrigger: [64, 64],
  '-0sand': [128, 128],
  sandroad: [128, 128],
  cssandwallbta: [128, 128],
  sandtrim: [128, 32],
  azwall_a: [128, 128],
  '!watergreen': [64, 64],
  mltrycrtesd: [64, 64],
  mltrycrtetp: [64, 64],
  bcrate02: [64, 64],
  crate08: [64, 64],
  glass_med: [64, 64],
  crete4_stp01: [64, 64],
  crete3_wall02: [128, 128],
  '{ladder1': [64, 64],
  duct_flr01: [64, 64],
  scroll_conv: [64, 64],
  metal_wall05b: [128, 128],
  steel: [64, 64],
  stripes2: [64, 64],
  sandwlldoor: [64, 128],
  fifties_dr2: [64, 128],
  out_w8dr1: [128, 128],
  lab1_comp3d: [32, 32],
};

const map = new MapBuilder(TEX, { wad: '', mapversion: '220', skyname: 'desert', message: 'de_playground' });
const world = map.world;
const brushEntity = (keys, brushes, opts) => map.brushEntity(keys, brushes, opts);
const point = (keys) => map.point(keys);

const X = 1600, Y = 1024, TOP = 640; // the courtyard's inside; walls 32 thick
const floorTex = { top: '-0sand', bottom: 'azwall_a', side: 'azwall_a' };
const wallTex = 'cssandwallbta';

// Floor (64 deep), cut open for the pool: shallow (14 deep) west, deeper (30) east, and in
// its north-east corner a diving well 190 deep (WELL: x0, x1, y0, y1; its bottom at -192),
// walled under the floor slab, a ramp down its south side from the knee-deep floor, a
// ladder up its north wall.
const POOL = [-300, 300, 300, 700];
const WELL = [60, 300, 520, 700];
world.push(
  box(-X - 32, -Y - 32, -64, X + 32, POOL[2], 0, floorTex),
  box(-X - 32, POOL[3], -64, X + 32, Y + 32, 0, floorTex),
  box(-X - 32, POOL[2], -64, POOL[0], POOL[3], 0, floorTex),
  box(POOL[1], POOL[2], -64, X + 32, POOL[3], 0, floorTex),
  box(POOL[0], POOL[2], -64, 0, POOL[3], -16, floorTex),
  box(0, POOL[2], -64, POOL[1], WELL[2], -32, floorTex),
  box(0, WELL[2], -64, WELL[0], POOL[3], -32, floorTex),
  box(WELL[0] - 32, WELL[2] - 32, -224, WELL[1] + 32, WELL[3] + 32, -192, floorTex), // the well's bottom
  box(WELL[0] - 32, WELL[2] - 32, -192, WELL[1] + 32, WELL[2], -64, floorTex), // its walls
  box(WELL[0] - 32, WELL[3], -192, WELL[1] + 32, WELL[3] + 32, -64, floorTex),
  box(WELL[0] - 32, WELL[2], -192, WELL[0], WELL[3], -64, floorTex),
  box(WELL[1], WELL[2], -192, WELL[1] + 32, WELL[3], -64, floorTex),
  wedge([WELL[0], WELL[2], -192, WELL[1], WELL[2] + 64, -32], 'nx', floorTex), // 34 degrees down
  box(200, WELL[3] - 4, -192, 264, WELL[3], 0, { top: '{ladder1', bottom: null, side: '{ladder1', py: null }),
);
brushEntity({ classname: 'func_ladder' }, [box(200, WELL[3] - 20, -192, 264, WELL[3] - 4, 16, NONE)]);
brushEntity({ classname: 'func_water', skin: '-3', WaveHeight: '0' }, [
  box(POOL[0], POOL[2], -32, POOL[1], POOL[3], -2, { top: '!watergreen', bottom: null, side: null }),
  box(WELL[0], WELL[2], -192, WELL[1], WELL[3], -32, NONE),
], { contents: -3 });
// A paved road from spawn to spawn.
world.push(box(-X, -140, 0, X, 140, 1, { top: 'sandroad', bottom: null, side: 'sandtrim' }));

// Outer walls up to the sky, the sky over everything.
world.push(
  box(-X - 32, -Y - 32, 0, -X, Y + 32, TOP, wallTex),
  box(X, -Y - 32, 0, X + 32, Y + 32, TOP, wallTex),
  box(-X, -Y - 32, 0, X, -Y, TOP, wallTex),
  box(-X, Y, 0, X, Y + 32, TOP, wallTex),
  box(-X - 32, -Y - 32, TOP, X + 32, Y + 32, TOP + 32, 'sky'),
);

// Spawn walls (x = -1100 and 1100, 32 thick) with a doorway on the road and a passage.
const DOOR_Y = [-140, 140], PASS_Y = [-720, -560];
for (const sx of [-1, 1]) {
  const x0 = sx < 0 ? -1100 : 1068, x1 = x0 + 32;
  world.push(
    box(x0, -Y, 0, x1, PASS_Y[0], 192, wallTex),
    box(x0, PASS_Y[1], 0, x1, DOOR_Y[0], 192, wallTex),
    box(x0, DOOR_Y[1], 0, x1, Y, 192, wallTex),
    box(x0, PASS_Y[0], 128, x1, PASS_Y[1], 192, wallTex),
    box(x0, DOOR_Y[0], 128, x1, DOOR_Y[1], 192, wallTex),
  );
}
// T side: a sliding door on the road (it rises when touched).
brushEntity({ classname: 'func_door', angle: '-1', speed: '160', wait: '3', lip: '8' },
  [box(-1092, DOOR_Y[0], 1, -1076, DOOR_Y[1], 128, 'sandwlldoor')]);
// CT side: a swinging door on the road, hinged on its south edge.
brushEntity({ classname: 'func_door_rotating', origin: `1084 ${DOOR_Y[0] + 4} 64`, distance: '90', speed: '120',
  wait: '3' }, [box(1078, DOOR_Y[0] + 4, 1, 1090, DOOR_Y[1] - 4, 127, 'fifties_dr2')]);
// CT side's passage: a garage door a button opens.
brushEntity({ classname: 'func_door', targetname: 'garage', angle: '-1', speed: '90', wait: '5', lip: '8' },
  [box(1072, PASS_Y[0], 1, 1096, PASS_Y[1], 128, 'out_w8dr1')]);
brushEntity({ classname: 'func_button', target: 'garage', angle: '180', speed: '40', wait: '1', lip: '2' },
  [box(1064, PASS_Y[1] + 24, 52, 1068, PASS_Y[1] + 40, 68, 'lab1_comp3d')]);

// Spawns (hull centers) and buy zones.
for (let k = 0; k < 5; k++) {
  const y = -256 + k * 128;
  point({ classname: 'info_player_deathmatch', origin: `-1400 ${y} 37`, angles: '0 0 0' });
  point({ classname: 'info_player_start', origin: `1400 ${y} 37`, angles: '0 180 0' });
}
brushEntity({ classname: 'func_buyzone', team: '1' }, [box(-X, -Y, 0, -1100, Y, 128, NONE)]);
brushEntity({ classname: 'func_buyzone', team: '2' }, [box(1100, -Y, 0, X, Y, 128, NONE)]);

// Bomb sites A (north-west) and B (north-east), with crates to plant behind.
// B's stacked crates are breakables only the bomb sets off (spawnflags 1: bullets do
// nothing; the site's target names them), each exploding, as de_dust2's do.
brushEntity({ classname: 'func_bomb_target' }, [box(-1000, 480, 0, -560, 960, 128, NONE)]);
brushEntity({ classname: 'func_bomb_target', target: 'siteb' }, [box(560, 480, 0, 1000, 960, 128, NONE)]);
const crate = (x, y, z, s, tex = 'crate08') => box(x, y, z, x + s, y + s, z + s, tex);
world.push(
  crate(-900, 820, 0, 64), crate(-836, 820, 0, 64), crate(-900, 820, 64, 64), crate(-700, 560, 0, 96),
  crate(620, 560, 0, 96),
);
const breakable = (keys, b) => brushEntity({ classname: 'func_breakable', ...keys }, [b]);
const bombCrate = { targetname: 'siteb', spawnflags: '1', material: '1', health: '1', explodemagnitude: '100' };
breakable(bombCrate, crate(700, 820, 0, 64));
breakable(bombCrate, crate(764, 820, 0, 64));
breakable(bombCrate, crate(764, 820, 64, 64));

// Stairs: eight 16-unit steps up to a platform 128 high.
for (let k = 0; k < 8; k++) {
  world.push(box(-1000 + 32 * k, -960, 0, -720, -760, 16 * (k + 1),
    { top: 'crete4_stp01', bottom: null, side: k === 7 ? 'crete3_wall02' : 'crete4_stp01' }));
}
world.push(box(-720, -960, 0, -600, -760, 128, { top: 'crete4_stp01', bottom: null, side: 'crete3_wall02' }));
// A lift beside the platform: it rests 2 units proud of the floor and rises 128 when
// stood on (func_plat: drawn at its top, GoldSrc starts it at the bottom).
brushEntity({ classname: 'func_plat', height: '128', speed: '100' },
  [box(-600, -960, 114, -520, -880, 130, { top: 'duct_flr01', bottom: 'steel', side: 'steel' })]);

// Ladder tower: 320 high, the ladder up its north face.
world.push(box(-440, -960, 0, -312, -832, 320, 'crete3_wall02'));
world.push(box(-408, -832, 0, -344, -828, 320, { top: '{ladder1', bottom: null, side: '{ladder1', ny: null }));
brushEntity({ classname: 'func_ladder' }, [box(-408, -828, 0, -344, -812, 336, NONE)]);

// Breakables: wooden crates, a metal crate, a glass pane, one that never breaks, and a
// barrel that explodes (explodemagnitude: 120 damage at its middle falling off to
// nothing 300 units out; the wooden crates beside it go with it).
const woodCrate = { top: 'mltrycrtetp', bottom: 'mltrycrtetp', side: 'mltrycrtesd' };
breakable({ material: '2', health: '60', explodemagnitude: '120' }, box(-300, -560, 0, -252, -512, 56, 'bcrate02'));
breakable({ material: '1', health: '40' }, box(-240, -560, 0, -176, -496, 64, woodCrate));
breakable({ material: '1', health: '40' }, box(-240, -560, 64, -176, -496, 128, woodCrate));
breakable({ material: '1', health: '40' }, box(-160, -560, 0, -112, -512, 48, woodCrate));
breakable({ material: '2', health: '250' }, box(-60, -560, 0, 4, -496, 64, 'bcrate02'));
breakable({ material: '0', health: '20', rendermode: '2', renderamt: '110' },
  box(60, -620, 0, 64, -460, 112, 'glass_med'));
breakable({ material: '7', health: '1' }, box(120, -560, 0, 184, -496, 64, 'crate08'));

// A free-standing wall between the lanes and the pool (cover, and shade).
world.push(box(-160, 180, 0, 160, 196, 192, { top: 'crete3_wall02', bottom: null, side: 'crete3_wall02' }));

// Conveyor belt: carries whoever stands on it east; its top is a scroll* texture, so it
// slides that way (GoldSrc scrolls those along s at the conveyor's speed).
world.push(box(280, -968, 0, 920, -960, 12, 'stripes2'), box(280, -856, 0, 920, -848, 12, 'stripes2'));
brushEntity({ classname: 'func_conveyor', speed: '160', angles: '0 0 0' },
  [box(280, -960, 0, 920, -856, 8, { top: 'scroll_conv', bottom: null, side: 'steel' })]);

// Metal yard: steel plates and a metal shed with an open side.
world.push(box(280, -760, 0, 920, -400, 2, { top: 'duct_flr01', bottom: null, side: 'steel' }));
// A cart riding round four path_corners (func_train: its center goes corner to corner at
// its speed, pausing 2 s at the first; it carries whoever stands on it and shoves
// whoever is in its way).
brushEntity({ classname: 'func_train', target: 'cart1', speed: '100', dmg: '2' },
  [box(308, -732, 2, 372, -668, 18, { top: 'stripes2', bottom: 'steel', side: 'steel' })]);
point({ classname: 'path_corner', targetname: 'cart1', target: 'cart2', origin: '340 -700 10', wait: '2' });
point({ classname: 'path_corner', targetname: 'cart2', target: 'cart3', origin: '660 -700 10' });
point({ classname: 'path_corner', targetname: 'cart3', target: 'cart4', origin: '660 -440 10' });
point({ classname: 'path_corner', targetname: 'cart4', target: 'cart1', origin: '340 -440 10' });
// The shed's shutter sinks into the ground (angle -2) and stays where it is sent
// (spawnflags 32); a valve wheel on a post works it (func_rot_button turning a quarter
// about its own axis x (GoldSrc's "rotate z" flag 64 adds to the roll), back after a
// second, firing the shutter each time).
brushEntity({ classname: 'func_door', targetname: 'shutter', angle: '-2', speed: '120', wait: '-1', lip: '8', spawnflags: '32' },
  [box(720, -744, 2, 728, -576, 192, 'out_w8dr1')]);
world.push(box(736, -804, 0, 756, -780, 80, 'steel'));
brushEntity({ classname: 'func_rot_button', target: 'shutter', origin: '734 -792 48', spawnflags: '64', distance: '90',
  speed: '90', wait: '1' }, [box(732, -804, 36, 736, -780, 60, 'lab1_comp3d')]);
world.push(
  box(720, -760, 2, 920, -744, 192, 'metal_wall05b'),
  box(904, -744, 2, 920, -560, 192, 'metal_wall05b'),
  box(720, -576, 2, 904, -560, 192, 'metal_wall05b'),
  box(720, -760, 192, 920, -560, 200, 'metal_wall05b'),
);
// A lamp under the shed's roof (a `light` point, baked into the lightmaps).
point({ classname: 'light', origin: '820 -660 170', _light: '255 235 190 200' });

const { bytes, stats } = map.compile();
Deno.writeFileSync(OUT, bytes);
console.log(`de_playground.bsp: ${(bytes.length / 1024).toFixed(0)} KB, ${stats.models} models, ${stats.faces} faces, ` +
  `${stats.nodes} nodes, ${stats.clipnodes} clipnodes, ${stats.leaves} leaves, ${stats.texels} light texels`);
