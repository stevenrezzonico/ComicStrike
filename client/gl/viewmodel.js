// First-person view: the team's arms (client/models/arms.js) holding the gun model
// (client/gl/gunmeshes.js), posed by client/anim/viewanim.js, drawn in eye space with
// their own projection into the G-buffer after the world (a depth clear first), so they
// get the same ink and dots, lit by the map like everything else, with a bolder line
// (G_FLAGS.VIEW). Five or six draws: sleeves, both hands (meshes fitted to what each
// hand holds, built on first use), gun (a second pistol for the Dual Berettas), muzzle
// flash.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN } from './skinned.js';
import { G_FLAGS } from './shaders.js';
import { perspective, multiply } from './mat4.js';
import { buildArms, buildHand, FLAT_CURL } from '../models/arms.js';
import { TEAM_CT } from '../../shared/player.js';

// Rig frame (x forward, y left, z up) -> eye space (right, up, back).
const RIG_TO_EYE = new Float32Array([0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);

export class Viewmodel {
  // guns: GunMeshes.
  constructor(gl, guns) {
    this.gl = gl;
    this.guns = guns;
    this.renderer = new SkinnedRenderer(gl);
    this.renderer.flags = G_FLAGS.VIEW;
    this.proj = new Float32Array(16);
    this.fovY = 54 * Math.PI / 180;
    this.model = new Float32Array(16); // the whole view (bob, offsets), eye space
    this.rig = new Float32Array(16);
    this.tmp = new Float32Array(16);
    this.tmp2 = new Float32Array(16);
    this.tmp3 = new Float32Array(16);
    this.arms = { T: new SkinnedMesh(gl, buildArms('T')), CT: new SkinnedMesh(gl, buildArms('CT')) };
    this.handMeshes = new Map(); // 'T L 1.9 1.5' -> SkinnedMesh
    this.handsOf = { T: [], CT: [] }; // per weapon id: [left, right] SkinnedMesh
    this.openLeft = {}; // team -> the open left hand (shielding the eyes from a flashbang)
  }

  // The two hand meshes for weapon `id`, fitted to what they hold (built once).
  hands(team, id) {
    let h = this.handsOf[team][id];
    if (h) return h;
    const curls = this.guns.curlsOf(id);
    h = curls.map((c, s) => {
      const key = `${team} ${s} ${c.cy.toFixed(2)} ${c.r.toFixed(2)}`;
      if (!this.handMeshes.has(key)) this.handMeshes.set(key, new SkinnedMesh(this.gl, buildHand(team, c, s === 0)));
      return this.handMeshes.get(key);
    });
    this.handsOf[team][id] = h;
    return h;
  }

  // va: the ViewAnimator, updated for this frame; anim: { x, y, z (eye-space offset),
  // pitch, yaw, roll (degrees, about the hands), flash, tossId / toss: a dropped weapon
  // flying out of the hand and its rig-frame matrix }; light: rgb from the map at the
  // player; team: the player's team; silencerOn: the M4A1-S / USP-S wear theirs.
  draw(weaponId, aspect, va, anim, light, team, silencerOn = true) {
    const gun = this.guns.meshOf(weaponId, silencerOn);
    if (!gun) return;
    const gl = this.gl, r = this.renderer;
    perspective(this.proj, this.fovY, aspect, 1, 128);
    this.buildModel(anim);
    multiply(this.rig, this.model, RIG_TO_EYE);

    gl.clear(gl.DEPTH_BUFFER_BIT); // never clip into walls
    r.begin(this.proj);
    const look = team === TEAM_CT ? 'CT' : 'T', hands = this.hands(look, weaponId);
    r.draw(this.arms[look], this.rig, va.pose.skin, light);
    if (va.blind > 0.45) { // shielding the eyes: an open hand
      this.openLeft[look] ??= new SkinnedMesh(this.gl, buildHand(look, FLAT_CURL, true));
      r.draw(this.openLeft[look], this.rig, va.pose.skin, light);
    } else r.draw(hands[0], this.rig, va.pose.skin, light);
    r.draw(hands[1], this.rig, va.pose.skin, light);
    r.draw(gun, multiply(this.tmp, this.rig, va.gun), va.gunSkin, light);
    if (va.dual) {
      r.draw(gun, multiply(this.tmp2, this.rig, va.gun2), va.gunSkin, light);
      if (va.flash2) this.tmp.set(this.tmp2);
    }
    const tossed = anim.tossId ? this.guns.meshOf(anim.tossId, true) : null;
    if (tossed) r.draw(tossed, multiply(this.tmp3, this.rig, anim.toss), IDENTITY_SKIN, light);
    const flash = this.guns.flashOf(weaponId, silencerOn);
    if (anim.flash && flash) r.draw(flash, this.tmp, IDENTITY_SKIN, light, 1); // a flat comic burst
    r.end();
  }

  // Model matrix: rotate about a pivot near the hands, then translate.
  buildModel(a) {
    const DEG = Math.PI / 180;
    const cp = Math.cos(a.pitch * DEG), sp = Math.sin(a.pitch * DEG);
    const cy = Math.cos(a.yaw * DEG), sy = Math.sin(a.yaw * DEG);
    const cr = Math.cos(a.roll * DEG), sr = Math.sin(a.roll * DEG);
    // R = Ry(yaw) * Rx(pitch) * Rz(roll), column-major.
    const m = this.model;
    m[0] = cy * cr + sy * sp * sr; m[1] = cp * sr; m[2] = -sy * cr + cy * sp * sr; m[3] = 0;
    m[4] = -cy * sr + sy * sp * cr; m[5] = cp * cr; m[6] = sy * sr + cy * sp * cr; m[7] = 0;
    m[8] = sy * cp; m[9] = -sp; m[10] = cy * cp; m[11] = 0;
    const px = 6, py = -6, pz = -12; // pivot (eye space)
    m[12] = px - (m[0] * px + m[4] * py + m[8] * pz) + a.x;
    m[13] = py - (m[1] * px + m[5] * py + m[9] * pz) + a.y;
    m[14] = pz - (m[2] * px + m[6] * py + m[10] * pz) + a.z;
    m[15] = 1;
  }
}
