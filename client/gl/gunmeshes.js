// GPU meshes of every gun model (client/models/guns.js), built once and shared by the
// first-person view and the third-person players: index = weapon id.

import { SkinnedMesh } from './skinned.js';
import { MeshBuilder } from './meshkit.js';
import { buildGun } from '../models/guns.js';
import { WEAPONS } from '../../shared/weapons.js';

const FLASH = [1.0, 0.75, 0.3];

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
        const f = new MeshBuilder().color(FLASH).box(3, 0.2, 1.8, mx + 1.5, my, mz).box(3, 1.8, 0.2, mx + 1.5, my, mz);
        this.flash[id] = new SkinnedMesh(gl, f.build());
      }
    });
    this.c4Off = new SkinnedMesh(gl, buildGun('c4', { ledOff: true }).mesh); // dropped bomb between beeps
    for (const name of ['m4a1_silencer', 'usp_silencer']) {
      const id = WEAPONS.findIndex((w) => w && w.name === name), g = buildGun(name, { noSilencer: true });
      this.bare[id] = new SkinnedMesh(gl, g.mesh);
      const [mx, my, mz] = g.muzzle;
      this.bareFlash[id] = new SkinnedMesh(gl, new MeshBuilder().color(FLASH).box(3, 0.2, 1.8, mx + 1.5, my, mz)
        .box(3, 1.8, 0.2, mx + 1.5, my, mz).build());
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
