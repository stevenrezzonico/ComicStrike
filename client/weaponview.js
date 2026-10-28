// Weapon presentation: the first-person view (arms and gun animated by
// client/anim/viewanim.js), dynamic crosshair and the HUD readouts. Simulation lives in
// shared/weapons.js; this only reads its state and events.

import { PS_VEL, PS_FLAGS, FL_ONGROUND } from '../shared/pmove.js';
import {
  activeWeapon, getInaccuracy, weaponStats, modeOf, silenced, grenadeCount, WS_ACTIVE, WS_SLOTS, WS_MODE_END, WEV_FIRE,
} from '../shared/weapons.js';
import { Viewmodel } from './gl/viewmodel.js';
import { Crosshair } from './gl/crosshair.js';
import { ViewAnimator } from './anim/viewanim.js';

const FLASH_TIME = 0.035;
const VM_TAN = Math.tan(27 * Math.PI / 180) / Math.tan(30 * Math.PI / 180);

export class WeaponView {
  // cv: the client cvars (crosshair, viewmodel_fov / viewmodel_offset_*); guns: GunMeshes.
  constructor(gl, fovY, cv, guns) {
    this.viewmodel = new Viewmodel(gl, guns);
    this.guns = guns;
    this.animator = new ViewAnimator();
    this.team = 0; // the player's team (arms)
    this.light = new Float32Array([1, 1, 1]); // map light at the player (main keeps it current)
    this.crosshair = new Crosshair(gl, cv);
    this.cv = cv;
    this.fovY = fovY;
    this.flashUntil = 0;
    this.blind = 0; // 0..1 flashbang white-out (main): the off hand shields the eyes
    this.bobPhase = 0;
    this.anim = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, flash: false };
    this.hidden = false; // dead: no viewmodel or crosshair, HUD only
    this.spread = -1; // crosshair spread gap (px) for drawCrosshair, -1: none
    this.scoped = false; // looking through a scope: its overlay replaces both

    this.elHealth = document.getElementById('hud-health');
    this.elArmor = document.getElementById('hud-armor');
    this.elAmmo = document.getElementById('hud-ammo');
    this.elWeapon = document.getElementById('hud-weapon');
    this.shown = { health: -1, armor: -1, clip: -1, reserve: -1, weapon: -1, label: null };
  }

  // Called once per simulation tick with that tick's weapon events.
  onTick(events, time) {
    if (events & WEV_FIRE) this.flashUntil = time + FLASH_TIME;
    this.animator.onEvents(events, time);
  }

  // +lookatweapon.
  inspect(time) {
    this.animator.inspect(time);
  }

  // The first-person view into the G-buffer, and the HUD numbers. time: interpolated
  // simulation time; dt: frame time.
  draw(height, aspect, ws, ps, buttons, time, dt, health, armor) {
    const w = activeWeapon(ws);
    const id = ws.f[WS_SLOTS + ws.f[WS_ACTIVE] * 3];
    const a = this.anim;
    a.x = a.y = a.z = a.pitch = a.yaw = a.roll = 0;

    if (w && !this.hidden && !this.scoped) {
      // Walk bob.
      const speed = Math.hypot(ps.f[PS_VEL], ps.f[PS_VEL + 1]) / 250;
      if (ps.i[PS_FLAGS] & FL_ONGROUND) this.bobPhase += dt * speed * Math.PI * 3;
      a.x += Math.sin(this.bobPhase) * 0.5 * speed;
      a.y -= Math.abs(Math.sin(this.bobPhase)) * 0.4 * speed;

      // viewmodel_offset_x/y/z (right, forward, up), relative to CS:GO's defaults 1, 1, -1.
      const cv = this.cv;
      a.x += cv.viewmodel_offset_x.number - 1;
      a.z -= cv.viewmodel_offset_y.number - 1;
      a.y += cv.viewmodel_offset_z.number + 1;
      // viewmodel_fov is horizontal at 4:3; 60 (the default) keeps the models' tuned 54 deg vertical.
      this.viewmodel.fovY = 2 * Math.atan(VM_TAN * Math.tan(cv.viewmodel_fov.number * Math.PI / 360));

      a.flash = time < this.flashUntil && !silenced(ws, ws.f[WS_ACTIVE]);
      this.animator.blind = this.blind;
      const va = this.animator.update(id, ws, time, this.guns.points[id]);
      this.viewmodel.draw(id, aspect, va, a, this.light, this.team, silenced(ws, ws.f[WS_ACTIVE]));
    }

    // Dynamic crosshairs open up with the real bullet cone (inaccuracy + spread).
    let spread = 0;
    if (w && w.gun) {
      const cone = getInaccuracy(ws, ps, buttons) + weaponStats(ws).spread;
      spread = Math.tan(cone) / Math.tan(this.fovY / 2) * height * 0.5;
    }
    // Sniper rifles show no crosshair unscoped, like CS:GO.
    const sniper = w && w.altKind === 'scope' && w.name !== 'aug' && w.name !== 'sg556';
    this.spread = !this.hidden && !this.scoped && !sniper ? spread : -1;

    this.updateHud(w, ws, id, health, armor);
  }

  // The crosshair, on the printed frame (after Renderer.composite), as draw() left it.
  drawCrosshair(width, height) {
    if (this.spread >= 0) this.crosshair.draw(width, height, this.spread);
  }

  updateHud(w, ws, id, health, armor) {
    const s = this.shown;
    if (health !== s.health) this.elHealth.textContent = s.health = health;
    if (armor !== s.armor) this.elArmor.textContent = s.armor = armor;
    // The label says the mode: burst fire, a silencer coming on / off, grenades held.
    let label = w ? w.label : '';
    if (w && w.altKind === 'burst' && modeOf(ws, w)) label += ' · Burst';
    if (w && w.altKind === 'silencer' && ws.f[WS_MODE_END] > 0) {
      label += silenced(ws, w.slot) ? ' · removing silencer' : ' · attaching silencer';
    }
    if (w && w.grenade && grenadeCount(ws, id) > 1) label += ` ×${grenadeCount(ws, id)}`;
    if (label !== s.label) this.elWeapon.textContent = s.label = label;
    if (id !== s.weapon) {
      s.weapon = id;
      s.clip = s.reserve = -1;
    }
    const o = WS_SLOTS + ws.f[WS_ACTIVE] * 3;
    const clip = w && w.gun ? ws.f[o + 1] : -2;
    const reserve = w && w.gun ? ws.f[o + 2] : -2;
    if (clip !== s.clip || reserve !== s.reserve) {
      s.clip = clip;
      s.reserve = reserve;
      this.elAmmo.textContent = clip < 0 ? '' : `${clip} / ${reserve}`;
    }
  }
}
