// CS:GO bomb rules shared by client and server: bomb sites from the map, the bomb's
// state as the snapshot carries it, and the explosion's damage.

import { parseVec3, modelBox } from './bsp.js';

export const PLANT_TIME = 3; // C4 arming time (s)
export const DEFUSE_TIME = 10;
export const DEFUSE_TIME_KIT = 5;
export const C4_TIMER = 40; // mp_c4timer (s)
export const USE_RANGE = 90; // eye to bomb, to start a defuse (approximation of CS:GO's +use reach)
export const USE_CONE = 0.8; // cosine: the bomb must be roughly in front of the view
export const PICKUP_RANGE = 40; // horizontal distance from a dropped bomb's center to pick it up
export const DEFAULT_BOMB_RADIUS = 500; // info_map_parameters "bombradius"
const POINT_TARGET_RADIUS = 256; // info_bomb_target (a point): plantable this close (approximation)

export const BOMB_NONE = 0; // warmup, or maps without bomb sites
export const BOMB_CARRIED = 1;
export const BOMB_DROPPED = 2;
export const BOMB_PLANTED = 3;
export const BOMB_DEFUSED = 4;
export const BOMB_EXPLODED = 5;

// The bomb as the snapshot carries it (the server adds its own bookkeeping).
export class BombState {
  constructor() {
    this.state = BOMB_NONE;
    // Where it lies (dropped / planted): its bottom center. -0: a double from the start, so
    // the first drop, minutes into a match, does not change the fields' representation from
    // integer, which deoptimized every function that had read the bomb (the client's tick,
    // draw, snapshot apply, HUD and radar at once: seconds of slower, garbage-heavy frames).
    this.x = -0;
    this.y = -0;
    this.z = -0;
    this.ticksLeft = 0; // planted: server ticks until it explodes
  }

  copy(o) {
    this.state = o.state;
    this.x = o.x;
    this.y = o.y;
    this.z = o.z;
    this.ticksLeft = o.ticksLeft;
  }
}

// Plantable areas: func_bomb_target brushes (every CS 1.6 de_ map) or boxes around
// info_bomb_target points.
export class BombSites {
  constructor(bsp) {
    this.boxes = []; // [minx, miny, minz, maxx, maxy, maxz]
    this.targets = []; // per box: the name it fires when the bomb blows up there ('' = none)
    this.names = []; // per box: its letter (A, B, ... in entity order, approx.)
    this.radius = DEFAULT_BOMB_RADIUS;
    const o = new Float32Array(3);
    for (const e of bsp.entities) {
      if (e.classname === 'info_map_parameters' && +e.bombradius > 0) this.radius = +e.bombradius;
      if (e.classname === 'func_bomb_target') {
        const box = modelBox(bsp, e, o);
        if (!box) continue;
        this.boxes.push(box);
        this.targets.push(e.target || '');
        this.names.push(String.fromCharCode(65 + this.names.length));
      } else if (e.classname === 'info_bomb_target') {
        parseVec3(e.origin, o);
        const r = POINT_TARGET_RADIUS;
        this.boxes.push([o[0] - r, o[1] - r, o[2] - r, o[0] + r, o[1] + r, o[2] + r]);
        this.targets.push(e.target || '');
        this.names.push(String.fromCharCode(65 + this.names.length));
      }
    }
  }

  get count() {
    return this.boxes.length;
  }

  // Keeps only site i (Wingman: one site; CS:GO's Wingman maps are single sites).
  keepOnly(i) {
    if (i < 0 || i >= this.boxes.length) return;
    this.boxes = [this.boxes[i]];
    this.targets = [this.targets[i]];
    this.names = [this.names[i]];
  }

  // Does a box (center, half extents) touch a bomb site?
  touches(x, y, z, hx, hy, hz) {
    return this.siteAt(x, y, z, hx, hy, hz) >= 0;
  }

  // The bomb site a box touches, or -1.
  siteAt(x, y, z, hx, hy, hz) {
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (x + hx >= b[0] && x - hx <= b[3] && y + hy >= b[1] && y - hy <= b[4] && z + hz >= b[2] && z - hz <= b[5]) {
        return i;
      }
    }
    return -1;
  }
}

// CS:GO C4 explosion (CPlantedC4::Explode -> RadiusDamage, ignoring walls): damage
// `radius` at the bomb, falling off as a gaussian with sigma = radius * 3.5 / 3, and
// nothing beyond radius * 3.5.
export function bombDamage(radius, dist) {
  const range = radius * 3.5;
  if (dist > range) return 0;
  const sigma = range / 3;
  return radius * Math.exp(-(dist * dist) / (2 * sigma * sigma));
}
