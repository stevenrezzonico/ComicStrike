// Weapon presentation: viewmodel animation, dynamic crosshair and the HUD readouts.
// Simulation lives in shared/weapons.js; this only reads its state and events.

import { PS_VEL, PS_FLAGS, FL_ONGROUND } from '../shared/pmove.js';
import {
  activeWeapon, getInaccuracy, WS_ACTIVE, WS_SLOTS, WS_RELOAD_END, WS_DEPLOY_END,
  WEV_FIRE, WEV_MELEE, WEV_MELEE2, WEV_DEPLOY,
} from '../shared/weapons.js';
import { Viewmodel } from './gl/viewmodel.js';
import { Crosshair } from './gl/crosshair.js';

const FLASH_TIME = 0.035;
const SWING_TIME = 0.3;

export class WeaponView {
  constructor(gl, fovY) {
    this.viewmodel = new Viewmodel(gl);
    this.crosshair = new Crosshair(gl);
    this.fovY = fovY;
    this.kick = 0;
    this.flashUntil = 0;
    this.swingStart = -1;
    this.bobPhase = 0;
    this.anim = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, flash: false };

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

    if (w) {
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
      a.flash = time < this.flashUntil;
      this.viewmodel.draw(id, aspect, a, 1.0);
    }

    // Crosshair gap follows the real bullet cone (inaccuracy + spread).
    let gap = 3;
    if (w && !w.melee) {
      const cone = getInaccuracy(ws, ps, buttons) + w.spread;
      gap = Math.max(3, Math.tan(cone) / Math.tan(this.fovY / 2) * height * 0.5);
    }
    this.crosshair.draw(width, height, gap);

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
    const clip = w && !w.melee ? ws.f[o + 1] : -2;
    const reserve = w && !w.melee ? ws.f[o + 2] : -2;
    if (clip !== s.clip || reserve !== s.reserve) {
      s.clip = clip;
      s.reserve = reserve;
      this.elAmmo.textContent = clip < 0 ? '' : `${clip} / ${reserve}`;
    }
  }
}
