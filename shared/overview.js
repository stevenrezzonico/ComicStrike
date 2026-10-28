// The radar's map overview, made from the BSP at load time (CS:GO ships a drawn image
// per map; this game loads no images): the floors players can reach (shared/floorgrid.js,
// doors drawn open), each pixel showing its highest one, so roofs and the outside drop
// out and the ground under an overhang shows. Flat tones by height, lighter higher, with
// a dark line where the floor ends or steps more than a stair, like CS:GO's radars.
// Pure JS (no canvas): the client puts the pixels into an image, tests read them.

import { FloorGrid, floorFaces, faceBounds } from './floorgrid.js';

const STEP = 40; // a height change bigger than a stair step draws a line (approx.)
const MARGIN = 8; // pixels of empty border

// Floor tones (low -> high) and the outline: printed paper tones and ink, like the game.
const LOW = [138, 124, 100];
const HIGH = [246, 238, 219];
const LINE = [23, 19, 15];

export class Overview {
  // size: pixels along the longer side.
  constructor(bsp, world, size = 512) {
    const faces = floorFaces(bsp);
    // A coarse pass finds the floors' extent (the faces' includes outside geometry).
    const [x0, y0, x1, y1] = new FloorGrid(bsp, world, Math.max(...extent(faceBounds(faces))) / 96,
      { faces, doorsOpen: true }).layerBounds();
    const scale = Math.max(x1 - x0, y1 - y0, 1) / (size - 2 * MARGIN);
    const grid = this.grid = new FloorGrid(bsp, world, scale, { bounds: [x0, y0, x1, y1], margin: MARGIN, faces,
      doorsOpen: true });
    this.scale = scale; // world units per pixel
    this.width = grid.w;
    this.height = grid.h;
    this.minX = grid.minX; // world x of pixel column 0's left edge
    this.maxY = grid.maxY; // world y of pixel row 0's top edge (north up)
    this.layers = grid.layers; // per pixel, LAYERS (6) floor heights (highest first)
    const w = this.width, h = this.height;
    const top = this.floor = grid.topReached(); // the floor shown per pixel, or -Infinity

    let zLo = Infinity, zHi = -Infinity;
    for (const z of top) {
      if (z === -Infinity) continue;
      zLo = Math.min(zLo, z);
      zHi = Math.max(zHi, z);
    }
    this.minZ = zLo;
    this.maxZ = zHi;
    const rgba = this.rgba = new Uint8ClampedArray(w * h * 4);
    const span = Math.max(zHi - zLo, 1);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = py * w + px, z = top[i];
        if (z === -Infinity) continue;
        const edge = px === 0 || py === 0 || px === w - 1 || py === h - 1 ||
          !(Math.abs(top[i - 1] - z) <= STEP) || !(Math.abs(top[i + 1] - z) <= STEP) ||
          !(Math.abs(top[i - w] - z) <= STEP) || !(Math.abs(top[i + w] - z) <= STEP);
        const t = (z - zLo) / span, o = i * 4;
        for (let k = 0; k < 3; k++) rgba[o + k] = edge ? LINE[k] : LOW[k] + (HIGH[k] - LOW[k]) * t;
        rgba[o + 3] = 255;
      }
    }
  }

  // World (x, y) to pixel coordinates (fractional).
  px(x) {
    return (x - this.minX) / this.scale;
  }

  py(y) {
    return (this.maxY - y) / this.scale;
  }

  // The floor shown under world (x, y), or -Infinity.
  floorAt(x, y) {
    const i = this.grid.index(x, y);
    return i < 0 ? -Infinity : this.floor[i];
  }
}

const extent = ([x0, y0, x1, y1]) => [x1 - x0, y1 - y0];
