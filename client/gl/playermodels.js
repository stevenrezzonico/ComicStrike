// Other players as animated models (client/models/players.js, client/anim/playeranim.js),
// drawn from the interpolated snapshot rows: body plus the gun in the right hand (two
// draw calls per player), lit by the map's light under them. The dead stay where they
// fell until they respawn or leave. Also draws the dropped bomb.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight } from './skinned.js';
import { buildPlayer } from '../models/players.js';
import { PlayerAnimator, holdOf, handTurn, PALM } from '../anim/playeranim.js';
import { PLAYER_SKELETON as S } from '../anim/skeleton.js';
import * as Q from '../anim/quat.js';
import { multiply } from './mat4.js';
import { TEAM_CT } from '../../shared/player.js';
import { WEAPON_ID } from '../../shared/weapons.js';
import { FL_ONGROUND } from '../../shared/pmove.js';
import { feetOffset } from '../../shared/hitgroups.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS,
  E_FIELDS, ANIM_HELMET, dequantizeYaw, dequantizePitch,
} from '../../shared/protocol.js';

const HAND_R = S.bone('hand_R');
const C4_ID = WEAPON_ID.c4;

export class PlayerModels {
  // guns: GunMeshes (client/gl/gunmeshes.js).
  constructor(gl, guns) {
    this.gl = gl;
    this.guns = guns;
    this.renderer = new SkinnedRenderer(gl);
    this.bodyT = new SkinnedMesh(gl, buildPlayer('T'));
    this.bodyCT = new SkinnedMesh(gl, buildPlayer('CT'));
    this.bodyCTHelmet = new SkinnedMesh(gl, buildPlayer('CT', true));
    this.weapon = new Int16Array(MAX_PLAYERS); // weapon id in hand (0: none drawn)
    this.gunModel = new Float32Array(MAX_PLAYERS * 16);
    this.handM = new Float32Array(16);
    this.qGun = new Float32Array(8);
    this.bomb = { show: false, led: false, model: new Float32Array(16), light: new Float32Array([1, 1, 1]) };
    this.anim = Array.from({ length: MAX_PLAYERS }, () => new PlayerAnimator());
    this.visible = new Uint8Array(MAX_PLAYERS);
    this.body = new Array(MAX_PLAYERS).fill(null);
    this.model = new Float32Array(MAX_PLAYERS * 16);
    this.light = new Float32Array(MAX_PLAYERS * 3).fill(1);
    // Per-player views, made once (no allocation per frame).
    this.modelOf = Array.from({ length: MAX_PLAYERS }, (_, i) => this.model.subarray(i * 16, i * 16 + 16));
    this.gunOf = Array.from({ length: MAX_PLAYERS }, (_, i) => this.gunModel.subarray(i * 16, i * 16 + 16));
    this.lightOf = Array.from({ length: MAX_PLAYERS }, (_, i) => this.light.subarray(i * 3, i * 3 + 3));
    this.lm = new Float32Array(3);
    this.tmpLight = new Float32Array(3);
  }

  // Animates every player in rows `ents` (base `row0`) except `self`, by dt seconds.
  // surfaces: the map's SurfaceMap (light under the players), or null. show = false
  // hides them all (cl_showhitboxes draws boxes instead).
  update(ents, row0, self, dt, surfaces, show = true) {
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const r = row0 + id * E_FIELDS;
      const a = this.anim[id];
      if (!show || id === self || !ents[r + E_ACTIVE]) {
        this.visible[id] = 0;
        a.reset();
        continue;
      }
      this.visible[id] = 1;
      const flags = ents[r + E_FLAGS], alive = ents[r + E_HEALTH] > 0;
      const x = ents[r + E_X], y = ents[r + E_Y], z = ents[r + E_Z] - feetOffset(flags);
      const yaw = dequantizeYaw(ents[r + E_YAW]);
      const weapon = ents[r + E_WEAPON];
      a.update(dt, x, y, z, yaw, dequantizePitch(ents[r + E_PITCH]), ents[r + E_DUCK] / 255, (flags & FL_ONGROUND) !== 0,
        holdOf(weapon), ents[r + E_ANIM], ents[r + E_SHOTS], alive, this.guns.support[weapon] || null);
      this.weapon[id] = alive && this.guns.mesh[weapon] ? weapon : 0;
      this.body[id] = ents[r + E_TEAM] === TEAM_CT
        ? (ents[r + E_ANIM] & ANIM_HELMET ? this.bodyCTHelmet : this.bodyCT)
        : this.bodyT;

      // Model matrix: yaw about z at the feet.
      const yr = yaw * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr), m = this.model, o = id * 16;
      m[o] = c; m[o + 1] = s; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = -s; m[o + 5] = c; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;

      if (this.weapon[id]) this.placeGun(id);

      // Light: the lightmap under the chest, eased so crossing faces does not pop.
      if (surfaces && surfaces.lightAt(this.lm, x, y, z + 36)) {
        modelLight(this.tmpLight, this.lm);
        const k = 1 - Math.exp(-dt * 8);
        for (let ch = 0; ch < 3; ch++) this.light[id * 3 + ch] += (this.tmpLight[ch] - this.light[id * 3 + ch]) * k;
      }
    }
  }

  // Gun in the right palm: the hand's rotation without its quarter turn (= the aim), at
  // the palm, in world space.
  placeGun(id) {
    const pose = this.anim[id].pose, h = HAND_R;
    Q.conj(this.qGun, 4, handTurn[1], 0);
    Q.mul(this.qGun, 0, pose.wrot, h * 4, this.qGun, 4);
    const x = this.qGun[0], y = this.qGun[1], z = this.qGun[2], w = this.qGun[3], m = this.handM;
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w); m[3] = 0;
    m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w); m[7] = 0;
    m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
    m[12] = pose.wpos[h * 3] + m[0] * PALM;
    m[13] = pose.wpos[h * 3 + 1] + m[1] * PALM;
    m[14] = pose.wpos[h * 3 + 2] + m[2] * PALM;
    m[15] = 1;
    multiply(this.gunOf[id], this.modelOf[id], m);
  }

  // The bomb lying at (x, y, z = floor), turned by yaw (radians); show = false hides it.
  setBomb(show, x = 0, y = 0, z = 0, yaw = 0, led = false, surfaces = null) {
    const b = this.bomb;
    b.show = show;
    if (!show) return;
    b.led = led;
    const c = Math.cos(yaw), s = Math.sin(yaw), m = b.model;
    m.fill(0);
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c; m[10] = 1; m[15] = 1;
    m[12] = x - 3 * c; m[13] = y - 3 * s; m[14] = z + 1.5; // the brick's center over the spot
    if (surfaces && surfaces.lightAt(this.lm, x, y, z + 8)) modelLight(b.light, this.lm);
  }

  draw(viewProj) {
    const r = this.renderer;
    let begun = false;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      if (!this.visible[id]) continue;
      if (!begun) {
        r.begin(viewProj);
        begun = true;
      }
      const model = this.modelOf[id], light = this.lightOf[id];
      const skin = this.anim[id].pose.skin;
      r.draw(this.body[id], model, skin, light);
      if (this.weapon[id]) r.draw(this.guns.mesh[this.weapon[id]], this.gunOf[id], IDENTITY_SKIN, light);
    }
    const b = this.bomb;
    if (b.show) {
      if (!begun) r.begin(viewProj);
      begun = true;
      r.draw(b.led ? this.guns.mesh[C4_ID] : this.guns.c4Off, b.model, IDENTITY_SKIN, b.light, 0);
    }
    if (begun) r.end();
  }
}
