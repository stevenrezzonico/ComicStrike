// Other players as animated models (client/models/players.js, client/anim/playeranim.js),
// drawn from the interpolated snapshot rows: body plus the gun in the right hand (two
// draw calls per player), lit by the map's light under them. The dead stay where they
// fell until they respawn or leave. Also draws the dropped bomb.

import { SkinnedRenderer, SkinnedMesh, IDENTITY_SKIN, modelLight } from './skinned.js';
import { buildPlayer, HOLD_TIED } from '../models/players.js';
import { MAX_HOSTAGES, HS_IDLE, HS_CARRIED, HS_DEAD } from '../../shared/hostages.js';
import { PlayerAnimator, holdOf, gunInHand } from '../anim/playeranim.js';
import { PLAYER_SKELETON as S, MAX_BONES } from '../anim/skeleton.js';
import { GUN_MAG, GUN_BOLT } from '../models/guns.js';
import { multiply } from './mat4.js';
import { TEAM_CT } from '../../shared/player.js';
import { WEAPON_ID } from '../../shared/weapons.js';
import { MAX_ITEMS } from '../../shared/items.js';
import { FL_ONGROUND } from '../../shared/pmove.js';
import { feetOffset } from '../../shared/hitgroups.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS,
  E_FIELDS, ANIM_HELMET, ANIM_SILENCED, ANIM_IMMUNE, dequantizeYaw, dequantizePitch,
} from '../../shared/protocol.js';

const SPINE3 = S.bone('spine_3');
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
    this.silenced = new Uint8Array(MAX_PLAYERS);
    this.gunModel = new Float32Array(MAX_PLAYERS * 16);
    // Per player: the gun's bones (magazine and bolt moved by reloads), identity otherwise.
    this.gunSkinOf = Array.from({ length: MAX_PLAYERS }, () => {
      const s = new Float32Array(MAX_BONES * 16);
      for (let i = 0; i < MAX_BONES; i++) for (let k = 0; k < 4; k++) s[i * 16 + k * 5] = 1;
      return s;
    });
    this.handM = new Float32Array(16);
    this.qGun = new Float32Array(8);
    this.bomb = { show: false, led: false, model: new Float32Array(16), light: new Float32Array([1, 1, 1]) };
    this.itemCount = 0; // weapons on the ground
    this.itemWeapon = new Uint8Array(MAX_ITEMS);
    this.itemOf = Array.from({ length: MAX_ITEMS }, () => new Float32Array(16));
    this.itemLightOf = Array.from({ length: MAX_ITEMS }, () => new Float32Array([1, 1, 1]));
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
    this.immune = new Uint8Array(MAX_PLAYERS); // spawn protection: drawn pulsing toward white
    this.time = 0;
    this.drawLight = new Float32Array(3);
    // Hostages.
    this.bodyH = new SkinnedMesh(gl, buildPlayer('H'));
    this.hostageAnim = Array.from({ length: MAX_HOSTAGES }, () => new PlayerAnimator());
    this.hostageModel = Array.from({ length: MAX_HOSTAGES }, () => new Float32Array(16));
    this.hostageLight = Array.from({ length: MAX_HOSTAGES }, () => new Float32Array([1, 1, 1]));
    this.hostageShown = new Uint8Array(MAX_HOSTAGES);
    this.carryM = new Float32Array(16);
  }

  // Hostages (shared/hostages.js list): standing with their hands tied, falling when
  // killed, over the carrier's shoulder when carried (not drawn when we are the carrier
  // or see through his eyes). Call after update().
  updateHostages(h, dt, surfaces) {
    this.hostageShown.fill(0);
    for (let k = 0; k < h.count; k++) {
      const a = this.hostageAnim[k], m = this.hostageModel[k], state = h.state[k];
      if (state === HS_IDLE || state === HS_DEAD) {
        a.update(dt, h.x[k], h.y[k], h.z[k], h.yaw[k], 0, 0, true, HOLD_TIED, 0, 0, state === HS_IDLE);
        const yr = h.yaw[k] * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr);
        m.fill(0);
        m[0] = c; m[1] = s; m[4] = -s; m[5] = c; m[10] = 1;
        m[12] = h.x[k]; m[13] = h.y[k]; m[14] = h.z[k]; m[15] = 1;
        if (surfaces && surfaces.lightAt(this.lm, h.x[k], h.y[k], h.z[k] + 36)) modelLight(this.hostageLight[k], this.lm);
        this.hostageShown[k] = 1;
      } else if (state === HS_CARRIED && h.carrier[k] >= 0 && this.visible[h.carrier[k]]) {
        // Lying across his shoulders, face down, head to his left.
        const id = h.carrier[k];
        a.update(dt, 0, 0, 0, 0, 0, 0, true, HOLD_TIED, 0, 0, true);
        const w = this.anim[id].pose.wpos, L = this.carryM;
        L.fill(0);
        L[2] = -1; // hostage x (face) -> down
        L[4] = -1; // hostage y -> back
        L[9] = 1; // hostage z (up) -> his left
        L[12] = w[SPINE3 * 3] - 4;
        L[13] = w[SPINE3 * 3 + 1] - 36;
        L[14] = w[SPINE3 * 3 + 2] + 5;
        L[15] = 1;
        multiply(m, this.modelOf[id], L);
        this.hostageLight[k].set(this.lightOf[id]);
        this.hostageShown[k] = 1;
      }
    }
    for (let k = h.count; k < MAX_HOSTAGES; k++) this.hostageAnim[k].reset();
  }

  // Animates every player in rows `ents` (base `row0`) except `self`, by dt seconds.
  // surfaces: the map's SurfaceMap (light under the players), or null. show = false
  // hides them all (cl_showhitboxes draws boxes instead).
  update(ents, row0, self, dt, surfaces, show = true) {
    this.time += dt;
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
        holdOf(weapon), ents[r + E_ANIM], ents[r + E_SHOTS], alive, this.guns.points[weapon] || null, weapon);
      this.weapon[id] = alive && this.guns.mesh[weapon] ? weapon : 0;
      this.silenced[id] = (ents[r + E_ANIM] & ANIM_SILENCED) !== 0;
      this.immune[id] = alive && (ents[r + E_ANIM] & ANIM_IMMUNE) !== 0;
      this.body[id] = ents[r + E_TEAM] === TEAM_CT
        ? (ents[r + E_ANIM] & ANIM_HELMET ? this.bodyCTHelmet : this.bodyCT)
        : this.bodyT;

      // Model matrix: yaw about z at the feet.
      const yr = yaw * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr), m = this.model, o = id * 16;
      m[o] = c; m[o + 1] = s; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = -s; m[o + 5] = c; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;

      if (this.weapon[id]) {
        this.placeGun(id);
        const pts = this.guns.points[weapon], md = pts && pts.magDir, skin = this.gunSkinOf[id];
        skin[GUN_MAG * 16 + 12] = md ? md[0] * a.magOff : 0;
        skin[GUN_MAG * 16 + 13] = md ? md[1] * a.magOff : 0;
        skin[GUN_MAG * 16 + 14] = md ? md[2] * a.magOff : 0;
        skin[GUN_BOLT * 16 + 12] = -a.boltOff;
      }

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
    multiply(this.gunOf[id], this.modelOf[id], gunInHand(this.anim[id].pose, this.handM, this.qGun));
  }

  // Weapons on the ground (shared/items.js): lying on their side, turned by their yaw,
  // lit by the map under them. Call when the list changes.
  setItems(items, surfaces = null) {
    const n = Math.min(items.count, MAX_ITEMS);
    for (let i = 0; i < n; i++) {
      const yr = items.yaw[i] * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr), m = this.itemOf[i];
      // Yaw about z, then a quarter roll about the barrel: the gun's right side down.
      m[0] = c; m[1] = s; m[2] = 0; m[3] = 0;
      m[4] = 0; m[5] = 0; m[6] = 1; m[7] = 0;
      m[8] = s; m[9] = -c; m[10] = 0; m[11] = 0;
      m[12] = items.x[i]; m[13] = items.y[i]; m[14] = items.z[i] + 0.8; m[15] = 1;
      this.itemWeapon[i] = items.weapon[i];
      const light = this.itemLightOf[i];
      if (surfaces && surfaces.lightAt(this.lm, items.x[i], items.y[i], items.z[i] + 8)) modelLight(light, this.lm);
      else light.fill(1);
    }
    this.itemCount = n;
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
      const model = this.modelOf[id];
      let light = this.lightOf[id];
      if (this.immune[id]) { // spawn protection: a fast pulse toward white (approx. of CS:GO's)
        const a = 0.3 + 0.3 * Math.sin(this.time * Math.PI * 6);
        for (let ch = 0; ch < 3; ch++) this.drawLight[ch] = light[ch] + (1.6 - light[ch]) * a;
        light = this.drawLight;
      }
      const skin = this.anim[id].pose.skin;
      r.draw(this.body[id], model, skin, light);
      if (this.weapon[id]) {
        r.draw(this.guns.meshOf(this.weapon[id], this.silenced[id]), this.gunOf[id], this.gunSkinOf[id], light);
      }
    }
    for (let k = 0; k < MAX_HOSTAGES; k++) {
      if (!this.hostageShown[k]) continue;
      if (!begun) r.begin(viewProj);
      begun = true;
      r.draw(this.bodyH, this.hostageModel[k], this.hostageAnim[k].pose.skin, this.hostageLight[k]);
    }
    for (let i = 0; i < this.itemCount; i++) {
      const mesh = this.guns.mesh[this.itemWeapon[i]];
      if (!mesh) continue;
      if (!begun) r.begin(viewProj);
      begun = true;
      r.draw(mesh, this.itemOf[i], IDENTITY_SKIN, this.itemLightOf[i]);
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
