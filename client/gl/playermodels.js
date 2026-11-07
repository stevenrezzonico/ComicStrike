// Other players as animated models (client/models/players.js, client/anim/playeranim.js),
// drawn from the interpolated snapshot rows: body plus the gun in the right hand (two
// draw calls per player), lit by the map's light under them. The dead stay where they
// fell until they respawn or leave. Also draws the dropped bomb.

import { SkinnedRenderer, SkinnedMesh, SkinnedShadows, IDENTITY_SKIN, modelLight, printedLight, eyeOf } from './skinned.js';
import { LED_AT } from '../models/guns.js';
import { WEAPON_ID } from '../../shared/weapons.js';
import { G_FLAGS } from './shaders.js';
import { buildPlayer, HOLD_TIED } from '../models/players.js';
import { MAX_HOSTAGES, HS_IDLE, HS_CARRIED, HS_DEAD } from '../../shared/hostages.js';
import { PlayerAnimator, holdOf, gunInHand, primeAnimator } from '../anim/playeranim.js';
import { PLAYER_SKELETON as S, MAX_BONES } from '../anim/skeleton.js';
import { GUN_MAG, GUN_BOLT } from '../models/guns.js';
import { multiply, sphereInViewAt, CLIP_ALL } from './mat4.js';
import { FloorShadows, SHADOW_FLOATS } from './shadows.js';
import { TEAM_CT } from '../../shared/player.js';
import { MAX_ITEMS } from '../../shared/items.js';
import { TICK_RATE } from '../../shared/constants.js';
import { FL_ONGROUND } from '../../shared/pmove.js';
import { feetOffset } from '../../shared/hitgroups.js';
import { shadowMatrix } from '../../shared/sun.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_PITCH, E_YAW, E_FLAGS, E_DUCK, E_WEAPON, E_HEALTH, E_TEAM, E_ANIM, E_SHOTS,
  E_FIELDS, ANIM_HELMET, ANIM_SILENCED, ANIM_IMMUNE, dequantizeYaw, dequantizePitch,
} from '../../shared/protocol.js';

const SPINE3 = S.bone('spine_3');
const ITEM_SPIN = 720; // degrees/s a flying weapon turns end over end
const OWN_TOSS_TICKS = 16; // our own thrown weapon stays hidden this long (first person shows it)
// Bounding spheres for skipping what lies outside the view: a character from the middle of
// its standing height (lying dead or carried on a shoulder, with the gun held out, it
// stays within), a weapon on the ground from its grip, the bomb.
const BODY_MID = 36, BODY_R = 84, ITEM_R = 48, BOMB_R = 16;
const C4_ID = WEAPON_ID.c4;
// The bomb's glint at a beep (buildC4Glow): this far over its LED and toward the eye, and
// grown with the distance past GLINT_NEAR units, up to GLINT_MAX times its size (~10 px tall
// at any distance on a 720p screen, where the LED was a pixel at 300 units).
const GLINT_UP = 1.5, GLINT_OUT = 2, GLINT_NEAR = 200, GLINT_MAX = 4;
// Contact shadow under a living character: radius and the light it takes at its middle,
// growing fainter and wider with the height above the floor (a jump), gone at SHADOW_FADE.
const SHADOW_R = 20, SHADOW_DARK = 0.75, SHADOW_FADE = 180;
// Past FAR_LOD units from the eye (r_lod_dist) a character draws as its coarse mesh (a
// third of the triangles), back to the full one nearer than FAR_LOD - LOD_BAND (so it
// never flickers).
const FAR_LOD = 520, LOD_BAND = 100;
// Sun shadows (r_playershadows): a character in the sun (the first face from its chest toward
// the sun is sky, looked up every SUN_EVERY frames) takes its floor's printed light down to
// SUN_SHARE of it under its shadow, about what the baked shade of a wall prints (de_dust2:
// sunlit ground ~0.6, shade ~0.4; our compiler's maps alike).
const SUN_SHARE = 0.65, SUN_EVERY = 8, SUN_CHEST = 48;
// A character's limbs are posed at most this often (seconds): up to ~300 fps every frame,
// at 1000 fps every third or fourth (still 250 times a second), the players staggered so
// the frames share the work; the body's place and turn follow every frame. Posing 9
// players was 0.15-0.4 ms a frame on a laptop, a third of a 1000 fps frame.
const POSE_DT = 1 / 300;

export class PlayerModels {
  // guns: GunMeshes (client/gl/gunmeshes.js).
  constructor(gl, guns) {
    this.gl = gl;
    this.guns = guns;
    this.renderer = new SkinnedRenderer(gl);
    // Each body in full detail and coarse (for players farther than FAR_LOD: the models
    // pass is triangle-bound, and at that distance the detail is under a pixel).
    this.bodyT = new SkinnedMesh(gl, buildPlayer('T'));
    this.bodyCT = new SkinnedMesh(gl, buildPlayer('CT'));
    this.bodyCTHelmet = new SkinnedMesh(gl, buildPlayer('CT', true));
    this.farOf = new Map([
      [this.bodyT, new SkinnedMesh(gl, buildPlayer('T', false, true))],
      [this.bodyCT, new SkinnedMesh(gl, buildPlayer('CT', false, true))],
      [this.bodyCTHelmet, new SkinnedMesh(gl, buildPlayer('CT', true, true))],
    ]);
    this.far = new Uint8Array(MAX_PLAYERS + MAX_HOSTAGES); // drawn coarse (with hysteresis)
    this.farLod = FAR_LOD; // r_lod_dist (0: always coarse)
    this.eye = new Float32Array(3);
    this.sph = new Float64Array(4); // inSight(): the sphere asked about (x, y, z, r)
    this.at = new Float64Array(3); // a player's chest, for liquidAt
    this.liquidAt = null; // ([x, y, z]): in water, slime or lava (set by main)
    this.box = new Float64Array(6); // and its box for the PVS
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
    this.glintM = new Float32Array(16);
    this.itemCount = 0; // weapons on the ground (and flying ones)
    this.itemWeapon = new Uint8Array(MAX_ITEMS);
    // Flying weapons: drawn between the previous and the newest list (they come every tick
    // while any flies), tumbling end over end; per item its id, the two positions, yaw,
    // ticks in the air (-1: lying still), thrower. Two sets, swapped per list.
    this.itemSets = [0, 1].map(() => ({ id: new Uint16Array(MAX_ITEMS), x: new Float32Array(MAX_ITEMS),
      y: new Float32Array(MAX_ITEMS), z: new Float32Array(MAX_ITEMS), count: 0 }));
    this.itemFrom = new Float32Array(MAX_ITEMS * 3);
    this.itemYaw = new Float32Array(MAX_ITEMS);
    this.itemAge = new Int16Array(MAX_ITEMS);
    this.itemOwner = new Int8Array(MAX_ITEMS);
    this.itemHidden = new Uint8Array(MAX_ITEMS);
    this.itemsAt = 0; // ms the newest list arrived
    this.itemsFlying = false;
    this.itemOf = Array.from({ length: MAX_ITEMS }, () => new Float32Array(16));
    this.itemLightOf = Array.from({ length: MAX_ITEMS }, () => new Float32Array([1, 1, 1]));
    this.anim = Array.from({ length: MAX_PLAYERS }, () => new PlayerAnimator());
    this.visible = new Uint8Array(MAX_PLAYERS);
    this.floorZ = new Float32Array(MAX_PLAYERS); // under each player (NaN: no shadow)
    this.hostageFloorZ = new Float32Array(MAX_HOSTAGES);
    this.shadows = new FloorShadows(gl);
    this.sunShadows = new SkinnedShadows(gl);
    this.sun = null; // toward the map's sun (shared/sun.js sunOf), null: no sun shadows
    this.sunOn = true; // r_playershadows
    this.floorLight = new Float32Array(MAX_PLAYERS).fill(1); // the print's light on the floor under each
    this.hostageFloorLight = new Float32Array(MAX_HOSTAGES).fill(1);
    this.sunlit = new Uint8Array(MAX_PLAYERS); // in the sun (see SUN_EVERY)
    this.hostageSunlit = new Uint8Array(MAX_HOSTAGES);
    this.flatM = new Float32Array(16);
    this.shadowM = new Float32Array(16);
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
    // Players out of the last frame's view are posed every other frame (the time saved up and
    // handed over): one frame stale at worst when they come into view, where posing all 9
    // every frame was ~0.5 ms of CPU.
    this.lastViewProj = new Float32Array(16);
    this.haveView = false;
    this.vis = null; // the map's WorldVis (main sets it with the map)
    this.frameNo = 0;
    this.owedDt = new Float32Array(MAX_PLAYERS);
    // (staggered: each player crosses POSE_DT on its own frames at high frame rates)
    for (let id = 0; id < MAX_PLAYERS; id++) this.owedDt[id] = (id & 3) * POSE_DT / 4;
    // Hostages.
    this.bodyH = new SkinnedMesh(gl, buildPlayer('H'));
    this.farOf.set(this.bodyH, new SkinnedMesh(gl, buildPlayer('H', false, true)));
    this.hostageAnim = Array.from({ length: MAX_HOSTAGES }, () => new PlayerAnimator());
    this.hostageModel = Array.from({ length: MAX_HOSTAGES }, () => new Float32Array(16));
    this.hostageLight = Array.from({ length: MAX_HOSTAGES }, () => new Float32Array([1, 1, 1]));
    this.hostageShown = new Uint8Array(MAX_HOSTAGES);
    this.carryM = new Float32Array(16);
    primeAnimator(guns.points); // the animator's type feedback, before the optimizer compiles it
  }

  // Hostages (shared/hostages.js list): standing with their hands tied, falling when
  // killed, over the carrier's shoulder when carried (not drawn when we are the carrier
  // or see through his eyes). Call after update().
  updateHostages(h, dt, surfaces) {
    this.hostageShown.fill(0);
    this.hostageFloorZ.fill(NaN); // carried ones cast none
    for (let k = 0; k < h.count; k++) {
      const a = this.hostageAnim[k], m = this.hostageModel[k], state = h.state[k];
      if (state === HS_IDLE || state === HS_DEAD) {
        const i = a.in; // (as array elements: arguments were boxed every frame)
        i[0] = dt; i[1] = h.x[k]; i[2] = h.y[k]; i[3] = h.z[k]; i[4] = h.yaw[k]; i[5] = 0; i[6] = 0;
        a.step(true, HOLD_TIED, 0, 0, state === HS_IDLE);
        const yr = h.yaw[k] * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr);
        m.fill(0);
        m[0] = c; m[1] = s; m[4] = -s; m[5] = c; m[10] = 1;
        m[12] = h.x[k]; m[13] = h.y[k]; m[14] = h.z[k]; m[15] = 1;
        this.hostageFloorLight[k] = 1;
        const sph = this.sph;
        sph[0] = h.x[k]; sph[1] = h.y[k]; sph[2] = h.z[k] + 36;
        if (surfaces && surfaces.lightAtP(this.lm, sph)) {
          modelLight(this.hostageLight[k], this.lm);
          this.hostageFloorLight[k] = printedLight(this.lm);
        }
        this.hostageFloorZ[k] = state === HS_IDLE ? h.z[k] : NaN;
        if (this.sun && surfaces && (this.frameNo + k) % SUN_EVERY === 0) {
          this.hostageSunlit[k] = surfaces.skyward(h.x[k], h.y[k], h.z[k] + SUN_CHEST, this.sun[0], this.sun[1], this.sun[2]) ? 1 : 0;
        }
        this.hostageShown[k] = 1;
      } else if (state === HS_CARRIED && h.carrier[k] >= 0 && this.visible[h.carrier[k]]) {
        // Lying across his shoulders, face down, head to his left.
        const id = h.carrier[k];
        const i = a.in;
        i[0] = dt; i[1] = i[2] = i[3] = i[4] = i[5] = i[6] = 0;
        a.step(true, HOLD_TIED, 0, 0, true);
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
    this.frameNo++;
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
      const sph = this.sph;
      sph[0] = x; sph[1] = y; sph[2] = z + BODY_MID; sph[3] = BODY_R;
      const seen = !this.haveView || this.inSight(this.lastViewProj);
      const owed = this.owedDt[id] + dt;
      if (owed < POSE_DT || (!seen && ((this.frameNo + id) & 1))) this.owedDt[id] = owed;
      else {
        const i = a.in; // the animator's numbers go as array elements, not boxed arguments
        i[0] = owed; i[1] = x; i[2] = y; i[3] = z; i[4] = yaw;
        i[5] = dequantizePitch(ents[r + E_PITCH]); i[6] = ents[r + E_DUCK] / 255;
        const at = this.at; // in water to the chest: the swim pose
        at[0] = x; at[1] = y; at[2] = z + 40;
        a.swim = alive && this.liquidAt !== null && this.liquidAt(at);
        a.step((flags & FL_ONGROUND) !== 0, holdOf(weapon), ents[r + E_ANIM], ents[r + E_SHOTS], alive,
          this.guns.points[weapon] || null, weapon);
        this.owedDt[id] = 0;
      }
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
        if (md) { // (stores in branches, not ?: : a double through a phi was a new heap number)
          skin[GUN_MAG * 16 + 12] = md[0] * a.magOff;
          skin[GUN_MAG * 16 + 13] = md[1] * a.magOff;
          skin[GUN_MAG * 16 + 14] = md[2] * a.magOff;
        } else skin[GUN_MAG * 16 + 12] = skin[GUN_MAG * 16 + 13] = skin[GUN_MAG * 16 + 14] = 0;
        skin[GUN_BOLT * 16 + 12] = -a.boltOff;
      }

      // Light: the lightmap under the chest, eased so crossing faces does not pop.
      this.floorLight[id] = 1;
      sph[0] = x; sph[1] = y; sph[2] = z + 36; // (the point as an array: three boxed doubles a call else)
      if (surfaces && surfaces.lightAtP(this.lm, sph)) {
        this.floorLight[id] = printedLight(this.lm);
        modelLight(this.tmpLight, this.lm);
        const k = 1 - Math.exp(-dt * 8);
        for (let ch = 0; ch < 3; ch++) this.light[id * 3 + ch] += (this.tmpLight[ch] - this.light[id * 3 + ch]) * k;
      }
      // The floor for its contact shadow: under the feet when standing, else the face below.
      if (alive && flags & FL_ONGROUND) this.floorZ[id] = z;
      else if (alive && surfaces) this.floorZ[id] = surfaces.hitZ;
      else this.floorZ[id] = NaN;
      // In the sun (after the floor: the lookup moves hitZ).
      if (this.sun && surfaces && alive && (this.frameNo + id) % SUN_EVERY === 0) {
        this.sunlit[id] = surfaces.skyward(x, y, z + SUN_CHEST, this.sun[0], this.sun[1], this.sun[2]) ? 1 : 0;
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
  // A new ground list (shared/items.js) arrived at `now` (ms). A weapon that just started
  // flying swings its thrower's arm.
  setItems(items, surfaces = null, now = 0) {
    const n = Math.min(items.count, MAX_ITEMS);
    const prev = this.itemSets[0], next = this.itemSets[1]; // [0] is always the newest
    this.itemSets[0] = next;
    this.itemSets[1] = prev;
    this.itemsFlying = false;
    for (let i = 0; i < n; i++) {
      const id = items.id[i];
      let j = 0;
      while (j < prev.count && prev.id[j] !== id) j++;
      const fresh = j === prev.count, f = this.itemFrom;
      f[i * 3] = fresh ? items.x[i] : prev.x[j];
      f[i * 3 + 1] = fresh ? items.y[i] : prev.y[j];
      f[i * 3 + 2] = fresh ? items.z[i] : prev.z[j];
      next.id[i] = id;
      next.x[i] = items.x[i];
      next.y[i] = items.y[i];
      next.z[i] = items.z[i];
      this.itemWeapon[i] = items.weapon[i];
      this.itemYaw[i] = items.yaw[i];
      this.itemAge[i] = items.flying[i] ? items.age[i] : -1;
      this.itemOwner[i] = items.owner[i];
      this.itemHidden[i] = 0;
      if (items.flying[i]) {
        this.itemsFlying = true;
        if (fresh && items.age[i] < 8 && items.owner[i] >= 0 && items.owner[i] < MAX_PLAYERS) {
          this.anim[items.owner[i]].throwArm();
        }
      } else this.placeItem(i, items.x[i], items.y[i], items.z[i], 0, false);
      const light = this.itemLightOf[i];
      if (surfaces && surfaces.lightAt(this.lm, items.x[i], items.y[i], items.z[i] + 8)) modelLight(light, this.lm);
      else light.fill(1);
    }
    next.count = n;
    this.itemCount = n;
    this.itemsAt = now;
    this.updateItems(now, -1);
  }

  // Flying weapons each frame: between the last two lists, turning end over end; our
  // own (self) stays hidden for its first quarter second (the first-person toss shows it).
  updateItems(now, self) {
    if (!this.itemsFlying) return;
    const a = Math.min(1, Math.max(0, (now - this.itemsAt) * TICK_RATE / 1000)), cur = this.itemSets[0];
    for (let i = 0; i < this.itemCount; i++) {
      const age = this.itemAge[i];
      this.itemHidden[i] = age >= 0 && this.itemOwner[i] === self && age + a < OWN_TOSS_TICKS ? 1 : 0;
      if (age < 0) continue;
      const f = this.itemFrom, o = i * 3;
      this.placeItem(i, f[o] + (cur.x[i] - f[o]) * a, f[o + 1] + (cur.y[i] - f[o + 1]) * a,
        f[o + 2] + (cur.z[i] - f[o + 2]) * a, (age + a) / TICK_RATE * ITEM_SPIN, true);
    }
  }

  // Item i's model matrix at (x, y, z): lying still, yaw about z then a quarter roll
  // about the barrel (the gun's right side down, just above the floor); flying, yaw then
  // `spin` degrees end over end (about the gun's y).
  placeItem(i, x, y, z, spin, flying) {
    const yr = this.itemYaw[i] * Math.PI / 180, c = Math.cos(yr), s = Math.sin(yr), m = this.itemOf[i];
    if (flying) {
      const sr = spin * Math.PI / 180, cp = Math.cos(sr), sp = Math.sin(sr);
      m[0] = c * cp; m[1] = s * cp; m[2] = -sp; m[3] = 0;
      m[4] = -s; m[5] = c; m[6] = 0; m[7] = 0;
      m[8] = c * sp; m[9] = s * sp; m[10] = cp; m[11] = 0;
      m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
      return;
    }
    m[0] = c; m[1] = s; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = 0; m[6] = 1; m[7] = 0;
    m[8] = s; m[9] = -c; m[10] = 0; m[11] = 0;
    m[12] = x; m[13] = y; m[14] = z + 0.8; m[15] = 1;
  }

  // Contact shadows under the living players and standing hostages, before they are drawn
  // (their own pixels then cover the disc).
  drawShadows(viewProj, gbuf) {
    for (let id = 0; id < MAX_PLAYERS; id++) {
      if (this.visible[id]) this.addShadow(viewProj, this.modelOf[id], this.floorZ[id]);
    }
    for (let k = 0; k < MAX_HOSTAGES; k++) {
      if (this.hostageShown[k]) this.addShadow(viewProj, this.hostageModel[k], this.hostageFloorZ[k]);
    }
    this.shadows.draw(viewProj, gbuf);
  }

  // In the view and in the camera's PVS (`vis`, the renderer's WorldVis): a figure, its
  // shadows, an item behind the walls is neither drawn nor posed every frame.
  // The sphere in `sph` (x, y, z, r), written by the caller: as arguments the four doubles
  // were boxed at every call, 30 a frame (see Performance, Consistent frame times).
  inSight(m) {
    const s = this.sph;
    if (!sphereInViewAt(m, s)) return false;
    if (!this.vis) return true;
    const b = this.box, r = s[3];
    b[0] = s[0] - r; b[1] = s[1] - r; b[2] = s[2] - r; b[3] = s[0] + r; b[4] = s[1] + r; b[5] = s[2] + r;
    return this.vis.seesBox(b);
  }

  addShadow(viewProj, m, floor) {
    const h = m[14] - floor; // feet above the floor (NaN: none)
    if (!(h > -2 && h < SHADOW_FADE)) return;
    const rad = SHADOW_R * (1 + Math.max(h, 0) / 150), sph = this.sph;
    sph[0] = m[12]; sph[1] = m[13]; sph[2] = floor; sph[3] = rad;
    if (!this.inSight(viewProj)) return;
    const sh = this.shadows; // the disc written in place (FloorShadows.add boxed its five doubles)
    if (sh.count === sh.capacity) return;
    const d = sh.data, o = sh.count++ * SHADOW_FLOATS;
    d[o] = m[12]; d[o + 1] = m[13]; d[o + 2] = floor; d[o + 3] = rad;
    d[o + 4] = SHADOW_DARK * (1 - Math.max(h, 0) / SHADOW_FADE);
  }

  // The map's sun (shared/sun.js sunOf: toward it), or null: no sun shadows.
  setSun(sun) {
    this.sun = sun;
    this.sunlit.fill(0);
    this.hostageSunlit.fill(0);
  }

  // Sun shadows of the living players and standing hostages on their floors (the coarse
  // body, flattened along the sun), after the contact discs and before the characters.
  drawSunShadows(viewProj, gbuf) {
    if (!this.sun || !this.sunOn) return;
    let begun = false;
    for (let slot = 0; slot < MAX_PLAYERS + MAX_HOSTAGES; slot++) {
      const player = slot < MAX_PLAYERS, k = slot - MAX_PLAYERS;
      if (player ? !this.visible[slot] : !this.hostageShown[k]) continue;
      const m = player ? this.modelOf[slot] : this.hostageModel[k];
      const floor = player ? this.floorZ[slot] : this.hostageFloorZ[k];
      const h = m[14] - floor; // feet above the floor (NaN: dead or carried)
      if (!(h > -2 && h < SHADOW_FADE)) continue;
      if (!(player ? this.sunlit[slot] : this.hostageSunlit[k])) continue;
      // Its bounds: from the feet to the head's shadow, away from the sun.
      const ax = this.sun[0] / this.sun[2], ay = this.sun[1] / this.sun[2];
      const reach = (BODY_MID + Math.max(h, 0)) * Math.sqrt(ax * ax + ay * ay), sph = this.sph;
      sph[0] = m[12] - ax * BODY_MID; sph[1] = m[13] - ay * BODY_MID; sph[2] = floor; sph[3] = 40 + reach;
      if (!this.inSight(viewProj)) continue;
      if (!begun) {
        this.sunShadows.begin(viewProj, gbuf);
        begun = true;
      }
      multiply(this.shadowM, shadowMatrix(this.flatM, this.sun, floor + 1), m);
      const body = player ? this.body[slot] : this.bodyH;
      const skin = player ? this.anim[slot].pose.skin : this.hostageAnim[k].pose.skin;
      const level = SUN_SHARE * (player ? this.floorLight[slot] : this.hostageFloorLight[k]);
      this.sunShadows.draw(this.farOf.get(body), this.shadowM, skin, level);
    }
    if (begun) this.sunShadows.end(gbuf);
  }

  // The bomb lying at at.x, at.y, at.z (its floor; a BombState: the numbers from the object,
  // not boxed as arguments every frame); show = false hides it.
  setBomb(show, at = null, led = false, surfaces = null) {
    const b = this.bomb;
    b.show = show;
    if (!show) return;
    b.led = led;
    const m = b.model, sph = this.sph;
    m.fill(0);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    m[12] = at.x - 3; m[13] = at.y; m[14] = at.z + 1.5; // the brick's center over the spot
    sph[0] = at.x; sph[1] = at.y; sph[2] = at.z + 8;
    if (surfaces && surfaces.lightAtP(this.lm, sph)) modelLight(b.light, this.lm);
  }

  // The glint's model matrix over the LED of the bomb at m (a translation), facing the eye:
  // x across the view, its normal (y) toward the eye, z up.
  glint(m) {
    const g = this.glintM, e = this.eye;
    const px = m[12] + LED_AT[0], py = m[13] + LED_AT[1], pz = m[14] + LED_AT[2] + GLINT_UP;
    const ex = e[0] - px, ey = e[1] - py, ez = e[2] - pz;
    const d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
    const fx = ex / d, fy = ey / d, fz = ez / d, rl = Math.sqrt(fx * fx + fy * fy);
    const rx = rl > 1e-4 ? fy / rl : 1, ry = rl > 1e-4 ? -fx / rl : 0;
    const s = Math.min(GLINT_MAX, Math.max(1, d / GLINT_NEAR));
    g[0] = rx * s; g[1] = ry * s; g[2] = 0; g[3] = 0;
    g[4] = fx * s; g[5] = fy * s; g[6] = fz * s; g[7] = 0;
    g[8] = ry * fz * s; g[9] = -rx * fz * s; g[10] = (rx * fy - ry * fx) * s; g[11] = 0;
    g[12] = px + fx * GLINT_OUT; g[13] = py + fy * GLINT_OUT; g[14] = pz + fz * GLINT_OUT; g[15] = 1;
    return g;
  }

  // The mesh for character `slot` (players, then hostages) with its feet at m: `mesh`, or
  // its coarse version when far from the eye, with a band of hysteresis.
  lod(slot, mesh, m) {
    const dx = m[12] - this.eye[0], dy = m[13] - this.eye[1], dz = m[14] + BODY_MID - this.eye[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const far = this.far[slot], near = Math.max(0, this.farLod - LOD_BAND);
    if (far ? d2 < near * near : d2 > this.farLod * this.farLod) this.far[slot] = far ^ 1;
    return this.far[slot] ? this.farOf.get(mesh) : mesh;
  }

  // The contact shadows' and the skinned program's draws once, clipped away (map load: see
  // CLIP_ALL); the program is shared with the view, the grenade effects and the blasts.
  warm(gbuf) {
    this.shadows.warm(gbuf);
    this.sunShadows.begin(CLIP_ALL, gbuf);
    this.sunShadows.draw(this.farOf.get(this.bodyH), IDENTITY_SKIN, IDENTITY_SKIN, 1);
    this.sunShadows.end(gbuf);
    const r = this.renderer;
    r.begin(CLIP_ALL);
    r.draw(this.guns.c4Off, IDENTITY_SKIN, IDENTITY_SKIN, this.hostageLight[0]);
    r.end();
  }

  draw(viewProj, gbuf) {
    this.lastViewProj.set(viewProj);
    this.haveView = true;
    this.drawShadows(viewProj, gbuf);
    this.drawSunShadows(viewProj, gbuf);
    const r = this.renderer;
    let begun = false;
    eyeOf(this.eye, viewProj);
    r.flags = G_FLAGS.CHAR; // players and hostages (G_CHAR: far away their colors show)
    const sph = this.sph;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      if (!this.visible[id]) continue;
      const model = this.modelOf[id];
      sph[0] = model[12]; sph[1] = model[13]; sph[2] = model[14] + BODY_MID; sph[3] = BODY_R;
      if (!this.inSight(viewProj)) continue;
      if (!begun) {
        r.begin(viewProj);
        begun = true;
      }
      const light = this.lightOf[id];
      // Spawn protection: a fast pulse toward white (approx. of CS:GO's).
      const white = this.immune[id] ? 0.3 + 0.3 * Math.sin(this.time * Math.PI * 6) : 0;
      const skin = this.anim[id].pose.skin;
      r.draw(this.lod(id, this.body[id], model), model, skin, light, 0, white);
      if (this.weapon[id]) {
        r.draw(this.guns.meshOf(this.weapon[id], this.silenced[id]), this.gunOf[id], this.gunSkinOf[id], light, 0,
          white);
      }
    }
    for (let k = 0; k < MAX_HOSTAGES; k++) {
      const hm = this.hostageModel[k];
      sph[0] = hm[12]; sph[1] = hm[13]; sph[2] = hm[14] + BODY_MID; sph[3] = BODY_R;
      if (!this.hostageShown[k] || !this.inSight(viewProj)) continue;
      if (!begun) r.begin(viewProj);
      begun = true;
      r.draw(this.lod(MAX_PLAYERS + k, this.bodyH, hm), hm, this.hostageAnim[k].pose.skin, this.hostageLight[k]);
    }
    if (begun) r.setFlags(0); // weapons on the ground and the bomb are things
    else r.flags = 0;
    for (let i = 0; i < this.itemCount; i++) {
      const mesh = this.guns.mesh[this.itemWeapon[i]];
      const im = this.itemOf[i];
      sph[0] = im[12]; sph[1] = im[13]; sph[2] = im[14]; sph[3] = ITEM_R;
      if (!mesh || this.itemHidden[i] || !this.inSight(viewProj)) continue;
      if (!begun) r.begin(viewProj);
      begun = true;
      r.draw(mesh, im, IDENTITY_SKIN, this.itemLightOf[i]);
    }
    const b = this.bomb;
    sph[0] = b.model[12]; sph[1] = b.model[13]; sph[2] = b.model[14]; sph[3] = BOMB_R;
    if (b.show && this.inSight(viewProj)) {
      if (!begun) r.begin(viewProj);
      begun = true;
      r.draw(b.led ? this.guns.mesh[C4_ID] : this.guns.c4Off, b.model, IDENTITY_SKIN, b.light, 0);
      if (b.led) r.draw(this.guns.c4Glow, this.glint(b.model), IDENTITY_SKIN, b.light, 1);
    }
    if (begun) r.end();
  }
}
