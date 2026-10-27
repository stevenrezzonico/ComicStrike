// Weapon presentation: viewmodel animation, dynamic crosshair and the HUD readouts.
// Simulation lives in shared/weapons.js; this only reads its state and events.

import { PS_VEL, PS_FLAGS, FL_ONGROUND } from '../shared/pmove.js';
import {
  activeWeapon, getInaccuracy, WS_ACTIVE, WS_SLOTS, WS_RELOAD_END, WS_DEPLOY_END, WS_ACTION,
  WEV_FIRE, WEV_MELEE, WEV_MELEE2, WEV_DEPLOY, ACTION_PLANT, ACTION_DEFUSE,
} from '../shared/weapons.js';
import { Viewmodel } from './gl/viewmodel.js';
import { Crosshair } from './gl/crosshair.js';

const FLASH_TIME = 0.035;
const VM_TAN = Math.tan(27 * Math.PI / 180) / Math.tan(30 * Math.PI / 180);
const SWING_TIME = 0.3;

export class WeaponView {
  // cv: the client cvars (crosshair, viewmodel_fov / viewmodel_offset_*).
  constructor(gl, fovY, cv) {
    this.viewmodel = new Viewmodel(gl);
    this.crosshair = new Crosshair(gl, cv);
    this.cv = cv;
    this.fovY = fovY;
    this.kick = 0;
    this.flashUntil = 0;
    this.swingStart = -1;
    this.bobPhase = 0;
    this.anim = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, flash: false };
    this.hidden = false; // dead: no viewmodel or crosshair, HUD only

    this.elHealth = document.getElementById('hud-health');
    this.elArmor = document.getElementById('hud-armor');
    this.elAmmo = document.getElementById('hud-ammo');
    this.elWeapon = document.getElementById('hud-weapon');
    this.shown = { health: -1, armor: -1, clip: -1, reserve: -1, weapon: -1 };
  }

  // Called once per simulation tick with that tick's weapon events.
  onTick(events, time) {
    if (events & WEV_FIRE) {
      this.kick = 1;
      this.flashUntil = time + FLASH_TIME;
    }
    if (events & (WEV_MELEE | WEV_MELEE2)) this.swingStart = time;
    if (events & WEV_DEPLOY) this.kick = 0;
  }

  // time: interpolated simulation time; dt: frame time.
  draw(width, height, aspect, ws, ps, buttons, time, dt, health, armor) {
    const w = activeWeapon(ws);
    const id = ws.f[WS_SLOTS + ws.f[WS_ACTIVE] * 3];
    const a = this.anim;
    a.x = a.y = a.z = a.pitch = a.yaw = a.roll = 0;

    if (w && !this.hidden) {
      // Walk bob.
      const speed = Math.hypot(ps.f[PS_VEL], ps.f[PS_VEL + 1]) / 250;
      if (ps.i[PS_FLAGS] & FL_ONGROUND) this.bobPhase += dt * speed * Math.PI * 3;
      a.x += Math.sin(this.bobPhase) * 0.5 * speed;
      a.y -= Math.abs(Math.sin(this.bobPhase)) * 0.4 * speed;

      // Recoil kick: back toward the camera and muzzle up.
      this.kick *= Math.exp(-dt * 14);
      a.z += this.kick * 2.5;
      a.pitch += this.kick * 4;

      const deploy = Math.min(Math.max((ws.f[WS_DEPLOY_END] - time) / w.deployTime, 0), 1);
      a.y -= deploy * 12;
      a.pitch -= deploy * 30;

      if (ws.f[WS_RELOAD_END] > 0) {
        const r = 1 - (ws.f[WS_RELOAD_END] - time) / w.reloadTime;
        const s = Math.sin(Math.min(Math.max(r, 0), 1) * Math.PI);
        a.y -= s * 5;
        a.roll += s * 25;
        a.pitch -= s * 10;
      }

      if (this.swingStart >= 0 && time - this.swingStart < SWING_TIME) {
        const s = Math.sin((time - this.swingStart) / SWING_TIME * Math.PI);
        a.yaw += s * 40;
        a.pitch -= s * 10;
        a.x -= s * 3;
      }
      const action = ws.f[WS_ACTION];
      if (action === ACTION_PLANT) { // C4 tipped toward the camera, thumb on the keypad
        a.y -= 1;
        a.pitch -= 12;
        a.y += Math.abs(Math.sin(time * 16)) * 0.3;
      } else if (action === ACTION_DEFUSE) {
        a.y -= 14; // hands busy: weapon out of sight
      }

      // viewmodel_offset_x/y/z (right, forward, up), relative to CS:GO's defaults 1, 1, -1.
      const cv = this.cv;
      a.x += cv.viewmodel_offset_x.number - 1;
      a.z -= cv.viewmodel_offset_y.number - 1;
      a.y += cv.viewmodel_offset_z.number + 1;
      // viewmodel_fov is horizontal at 4:3; 60 (the default) keeps the models' tuned 54 deg vertical.
      this.viewmodel.fovY = 2 * Math.atan(VM_TAN * Math.tan(cv.viewmodel_fov.number * Math.PI / 360));

      a.flash = time < this.flashUntil;
      this.viewmodel.draw(id, aspect, a, 1.0);
    }

    // Dynamic crosshairs open up with the real bullet cone (inaccuracy + spread).
    let spread = 0;
    if (w && w.gun) {
      const cone = getInaccuracy(ws, ps, buttons) + w.spread;
      spread = Math.tan(cone) / Math.tan(this.fovY / 2) * height * 0.5;
    }
    if (!this.hidden) this.crosshair.draw(width, height, spread);

    this.updateHud(w, ws, id, health, armor);
  }

  updateHud(w, ws, id, health, armor) {
    const s = this.shown;
    if (health !== s.health) this.elHealth.textContent = s.health = health;
    if (armor !== s.armor) this.elArmor.textContent = s.armor = armor;
    if (id !== s.weapon) {
      s.weapon = id;
      this.elWeapon.textContent = w ? w.label : '';
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
