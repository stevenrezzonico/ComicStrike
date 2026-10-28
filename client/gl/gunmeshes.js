// GPU meshes of every gun model (client/models/guns.js), built once and shared by the
// first-person view and the third-person players: index = weapon id.

import { SkinnedMesh } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import { buildGun } from '../models/guns.js';
import { WEAPONS } from '../../shared/weapons.js';

const FLASH = [1.0, 0.82, 0.23];
const FLASH_CORE = [1.0, 0.97, 0.82];

// Comic muzzle flash at the muzzle (mx, my, mz): a flat starburst facing down the barrel,
// a smaller pale core in front of it, and two crossed side bursts stretched forward.
export function buildFlash(mx, my, mz) {
  const star = (n, r1, r2, sx = 1) => {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? r2 : r1;
      pts.push([Math.cos(a) * r * sx, Math.sin(a) * r]);
    }
    return pts;
  };
  const b = new MeshBuilder().color(FLASH);
  b.push().translate(mx + 0.4, my, mz).rotate(0, 90).extrude(star(9, 3.2, 1.3), 0.15).pop();
  b.color(FLASH_CORE).push().translate(mx + 0.6, my, mz).rotate(0, 90).extrude(star(7, 1.6, 0.7), 0.15).pop();
  b.color(FLASH);
  b.push().translate(mx + 2.4, my, mz).extrude(star(6, 2.6, 0.9, 1.4), 0.12).pop();
  b.push().translate(mx + 2.4, my, mz).rotate(0, 0, 90).extrude(star(6, 2.6, 0.9, 1.4), 0.12).pop();
  return b.build();
}

export class GunMeshes {
  constructor(gl) {
    this.mesh = []; // gun model
    this.flash = []; // muzzle flash at the muzzle (guns only)
    this.muzzle = [];
    this.support = []; // off-hand point in the gun frame, or null
    this.points = []; // buildGun's points (muzzle, support, mag, bolt, ...) for the hands
    this.bare = []; // the M4A1-S and USP-S with their silencer off
    this.bareFlash = [];
    WEAPONS.forEach((w, id) => {
      if (!w) return;
      const g = buildGun(w.name);
      this.mesh[id] = new SkinnedMesh(gl, g.mesh);
      this.muzzle[id] = g.muzzle;
      this.support[id] = g.support;
      this.points[id] = { ...g, mesh: null };
      if (w.gun) {
        const [mx, my, mz] = g.muzzle;
        this.flash[id] = new SkinnedMesh(gl, buildFlash(mx, my, mz));
      }
    });
    this.c4Off = new SkinnedMesh(gl, buildGun('c4', { ledOff: true }).mesh); // dropped bomb between beeps
    for (const name of ['m4a1_silencer', 'usp_silencer']) {
      const id = WEAPONS.findIndex((w) => w && w.name === name), g = buildGun(name, { noSilencer: true });
      this.bare[id] = new SkinnedMesh(gl, g.mesh);
      const [mx, my, mz] = g.muzzle;
      this.bareFlash[id] = new SkinnedMesh(gl, buildFlash(mx, my, mz));
    }
  }

  // The mesh for weapon `id` as it is now (silencer on or off), and its flash.
  meshOf(id, silencedOn = true) {
    return !silencedOn && this.bare[id] ? this.bare[id] : this.mesh[id];
  }

  flashOf(id, silencedOn = true) {
    return !silencedOn && this.bareFlash[id] ? this.bareFlash[id] : this.flash[id];
  }
}
