// Other players as animated models (client/models/players.js, client/anim/playeranim.js),
// drawn from the interpolated snapshot rows: body plus held weapon, two draw calls per
// player, lit by the map's light under them. The dead stay where they fell until they
// respawn or leave.

import { SkinnedRenderer, SkinnedMesh, modelLight } from './skinned.js';
import { buildPlayer, buildHeld, HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4 } from '../models/players.js';
import { PlayerAnimator, holdOf } from '../anim/playeranim.js';
import { TEAM_CT } from '../../shared/player.js';
import { FL_ONGROUND } from '../../shared/pmove.js';
import { feetOffset } from '../../shared/hitgroups.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS,
  E_FIELDS, ANIM_HELMET, dequantizeYaw, dequantizePitch,
} from '../../shared/protocol.js';

export class PlayerModels {
  constructor(gl) {
    this.gl = gl;
    this.renderer = new SkinnedRenderer(gl);
    this.bodyT = new SkinnedMesh(gl, buildPlayer('T'));
    this.bodyCT = new SkinnedMesh(gl, buildPlayer('CT'));
    this.bodyCTHelmet = new SkinnedMesh(gl, buildPlayer('CT', true));
    this.held = [];
    for (const h of [HOLD_RIFLE, HOLD_PISTOL, HOLD_KNIFE, HOLD_C4]) this.held[h] = new SkinnedMesh(gl, buildHeld(h));
    this.anim = Array.from({ length: MAX_PLAYERS }, () => new PlayerAnimator());
    this.visible = new Uint8Array(MAX_PLAYERS);
    this.body = new Array(MAX_PLAYERS).fill(null);
    this.hold = new Int8Array(MAX_PLAYERS);
    this.model = new Float32Array(MAX_PLAYERS * 16);
    this.light = new Float32Array(MAX_PLAYERS * 3).fill(1);
    // Per-player views, made once (no allocation per frame).
    this.modelOf = Array.from({ length: MAX_PLAYERS }, (_, i) => this.model.subarray(i * 16, i * 16 + 16));
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
      const hold = holdOf(ents[r + E_WEAPON]);
      a.update(dt, x, y, z, yaw, dequantizePitch(ents[r + E_PITCH]), ents[r + E_DUCK] / 255, (flags & FL_ONGROUND) !== 0,
        hold, ents[r + E_ANIM], ents[r + E_SHOTS], alive);
      this.hold[id] = alive ? hold : -1;
      this.body[id] = ents[r + E_TEAM] === TEAM_CT
        ? (ents[r + E_ANIM] & ANIM_HELMET ? this.bodyCTHelmet : this.bodyCT)
        : this.bodyT;

      // Model matrix: yaw about z at the feet.
      const yr = yaw * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr), m = this.model, o = id * 16;
      m[o] = c; m[o + 1] = s; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = -s; m[o + 5] = c; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;

      // Light: the lightmap under the chest, eased so crossing faces does not pop.
      if (surfaces && surfaces.lightAt(this.lm, x, y, z + 36)) {
        modelLight(this.tmpLight, this.lm);
        const k = 1 - Math.exp(-dt * 8);
        for (let ch = 0; ch < 3; ch++) this.light[id * 3 + ch] += (this.tmpLight[ch] - this.light[id * 3 + ch]) * k;
      }
    }
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
      if (this.hold[id] >= 0) r.draw(this.held[this.hold[id]], model, skin, light);
    }
    if (begun) r.end();
  }
}
