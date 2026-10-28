// The radar, CS:GO style (top left): the map overview generated from the BSP
// (shared/overview.js) under the view, turning with it (cl_radar_rotate), zoomed by
// cl_radar_scale and sized by cl_hud_radar_scale. Teammates always show (at the edge
// when farther), and so do their bodies (an X); enemies only while the server marks them
// spotted for our team (ANIM_SPOTTED_*: seen by one of us, or firing). Spectators see
// everyone. Also the bomb sites' letters, hostages, and the dropped or planted bomb for
// the Terrorists. Drawn with Canvas2D each frame.

import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import {
  MAX_PLAYERS, E_ACTIVE, E_X, E_Y, E_Z, E_YAW, E_HEALTH, E_TEAM, E_ANIM, E_FIELDS, ANIM_SPOTTED_T, ANIM_SPOTTED_CT,
  dequantizeYaw,
} from '../shared/protocol.js';
import { BOMB_DROPPED, BOMB_PLANTED } from '../shared/bomb.js';
import { HS_IDLE } from '../shared/hostages.js';

const RANGE = 4096; // world units across the radar at cl_radar_scale 1 (approx.)
const SIZE = 0.27; // of the screen height at cl_hud_radar_scale 1 (approx.)
const LEVEL = 128; // higher or lower than this: an up / down mark
const DEG = Math.PI / 180;
const COLOR = { [TEAM_T]: '#e8c46a', [TEAM_CT]: '#8cb4f0', enemy: '#e8443a', bomb: '#ff9a3c', site: 'rgba(232,196,106,0.85)' };

export class Radar {
  constructor(canvas, cv) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cv = cv;
    this.fontPx = 0; // bomb site letters' font, rebuilt when the size changes
    this.font = '';
    this.overview = null;
    this.image = null; // canvas holding the overview pixels
    this.sites = []; // [x, y, letter]
    this.hidden = false; // hideradar / drawradar
    this.cssSize = 0;
  }

  // A new map: its overview and bomb sites (A, B in entity order, approx.).
  setMap(overview, bombSites) {
    this.overview = overview;
    const img = this.image = document.createElement('canvas');
    img.width = overview.width;
    img.height = overview.height;
    img.getContext('2d').putImageData(new ImageData(overview.rgba, overview.width, overview.height), 0, 0);
    this.sites = bombSites.boxes.map((b, i) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, String.fromCharCode(65 + i)]);
  }

  // view: { x, y, z (camera), yaw (degrees) }; rows: interpolated snapshot rows (or
  // null offline); selfId / watched: our id and the one we see through (-1); team: ours
  // (TEAM_SPECTATOR sees all); ffa: free for all; bomb: BombState or null; hostages or null.
  draw(show, cx, cy, cz, yaw, rows, selfId, watched, team, ffa, bomb, hostages, now) {
    const c = this.canvas;
    show = show && !this.hidden && this.overview !== null;
    c.style.display = show ? 'block' : 'none';
    const css = show ? Math.max(120, Math.round(innerHeight * SIZE * this.cv.cl_hud_radar_scale.number)) : 0;
    if (css !== this.cssSize) {
      this.cssSize = css;
      document.documentElement.style.setProperty('--radar', `${css ? css + 10 : 0}px`); // #debug goes below it
    }
    if (!show) return;
    const dpr = devicePixelRatio || 1, D = Math.round(css * dpr);
    if (c.width !== D) {
      c.width = c.height = D;
      c.style.width = c.style.height = `${css}px`;
    }
    const ctx = this.ctx, o = this.overview, R = D / 2, selfX = cx, selfY = cy;
    const k = D / (RANGE * this.cv.cl_radar_scale.number); // screen pixels per world unit
    const rotate = this.cv.cl_radar_rotate.bool;
    if (!this.cv.cl_radar_always_centered.bool && !rotate) { // stop at the map's edges
      const half = R / k, x0 = o.minX, x1 = o.minX + o.width * o.scale, y1 = o.maxY, y0 = o.maxY - o.height * o.scale;
      cx = x1 - x0 > 2 * half ? Math.min(Math.max(cx, x0 + half), x1 - half) : (x0 + x1) / 2;
      cy = y1 - y0 > 2 * half ? Math.min(Math.max(cy, y0 + half), y1 - half) : (y0 + y1) / 2;
    }
    const a = (rotate ? 90 - yaw : 0) * DEG, ca = Math.cos(a), sa = Math.sin(a);
    this.cx = cx;
    this.cy = cy;
    this.k = k;
    this.a = a;
    this.ca = ca;
    this.sa = sa;
    this.R = R;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, D, D);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12, 14, 17, 0.7)';
    ctx.fill();
    ctx.clip();
    // The overview: pixel (u, v) -> world (minX + s u, maxY - s v) -> radar.
    const s = o.scale, ox = o.minX - cx, oy = o.maxY - cy;
    ctx.setTransform(k * s * ca, -k * s * sa, k * s * sa, k * s * ca, R + k * (ox * ca - oy * sa), R - k * (ox * sa + oy * ca));
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.image, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const r = 3.4 * dpr * Math.max(1, css / 200);
    const px = Math.round(r * 3.2);
    if (px !== this.fontPx) { // (a new string and a font parse only when the size changes)
      this.fontPx = px;
      this.font = `700 ${px}px Verdana, Tahoma, sans-serif`;
    }
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i], x = site[0], y = site[1], letter = site[2];
      if (!this.place(x, y, false)) continue;
      ctx.lineWidth = dpr * 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(letter, this.sx, this.sy);
      ctx.fillStyle = COLOR.site;
      ctx.fillText(letter, this.sx, this.sy);
    }
    if (hostages) {
      for (let h = 0; h < hostages.count; h++) {
        if (hostages.state[h] !== HS_IDLE || !this.place(hostages.x[h], hostages.y[h], false)) continue;
        ctx.fillStyle = '#e6e6e0';
        ctx.fillRect(this.sx - r * 0.8, this.sy - r * 0.8, r * 1.6, r * 1.6);
      }
    }
    const all = team === TEAM_SPECTATOR;
    if (bomb && (all || team === TEAM_T) && (bomb.state === BOMB_DROPPED || bomb.state === BOMB_PLANTED) &&
      this.place(bomb.x, bomb.y, true)) {
      const blink = bomb.state === BOMB_PLANTED && Math.floor(now / 400) % 2;
      ctx.fillStyle = blink ? '#ff3b2f' : COLOR.bomb;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = dpr;
      ctx.fillRect(this.sx - r * 1.1, this.sy - r * 0.8, r * 2.2, r * 1.6);
      ctx.strokeRect(this.sx - r * 1.1, this.sy - r * 0.8, r * 2.2, r * 1.6);
    }

    if (rows) {
      const spotBit = team === TEAM_T ? ANIM_SPOTTED_T : ANIM_SPOTTED_CT;
      for (let pass = 0; pass < 2; pass++) { // bodies first, then the living on top
        for (let id = 0; id < MAX_PLAYERS; id++) {
          const q = id * E_FIELDS;
          if (!rows[q + E_ACTIVE] || id === selfId || id === watched) continue;
          const t = rows[q + E_TEAM], alive = rows[q + E_HEALTH] > 0;
          if (alive !== (pass === 1)) continue;
          const mate = !ffa && t === team;
          const visible = all || mate || (alive && (rows[q + E_ANIM] & (ffa ? ANIM_SPOTTED_T | ANIM_SPOTTED_CT : spotBit)));
          if (!visible) continue;
          const color = mate || all ? COLOR[t] || '#ccc' : COLOR.enemy;
          if (!this.place(rows[q + E_X], rows[q + E_Y], mate && alive)) continue;
          if (!alive) this.cross(color, r);
          else this.dot(color, r, dequantizeYaw(rows[q + E_YAW]), rows[q + E_Z] - cz);
        }
      }
    }
    // Us (or whoever we watch): an arrow along the view (straight up when the radar turns).
    if (this.place(selfX, selfY, true)) {
      this.arrow(r * 1.5, yaw, team === TEAM_CT ? COLOR[TEAM_CT] : team === TEAM_T ? COLOR[TEAM_T] : '#f2ecd8');
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(R, R, R - dpr, 0, Math.PI * 2);
    ctx.lineWidth = dpr * 1.5;
    ctx.strokeStyle = 'rgba(200, 196, 180, 0.55)';
    ctx.stroke();
  }

  // Radar position of world (x, y) into this.sx / this.sy; false if off the radar (or,
  // `clamp`: pulled in to the edge).
  place(x, y, clamp) {
    const dx = x - this.cx, dy = y - this.cy, k = this.k;
    let px = k * (dx * this.ca - dy * this.sa), py = -k * (dx * this.sa + dy * this.ca);
    const d = Math.hypot(px, py), max = this.R * 0.9;
    if (d > max) {
      if (!clamp) return false;
      px *= max / d;
      py *= max / d;
    }
    this.sx = this.R + px;
    this.sy = this.R + py;
    return true;
  }

  // A player: a dot with a tick along his view (world yaw `pyaw`), a mark when far above
  // or below us. A world direction at yaw p is at angle p + the radar's turn on screen.
  dot(color, r, pyaw, dz) {
    const ctx = this.ctx, x = this.sx, y = this.sy, a = pyaw * DEG + this.a;
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * r * 2, y - Math.sin(a) * r * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = r * 0.35;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    if (Math.abs(dz) > LEVEL) { // above: a cap over the dot; below: under it
      const s = dz > 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(x - r, y + s * r * 1.5);
      ctx.lineTo(x, y + s * r * 2.6);
      ctx.lineTo(x + r, y + s * r * 1.5);
      ctx.lineWidth = r * 0.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  cross(color, r) {
    const ctx = this.ctx, x = this.sx, y = this.sy;
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.6;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.stroke();
  }

  // An arrow along world yaw `yaw` (degrees).
  arrow(r, yaw, color) {
    const ctx = this.ctx, a = yaw * DEG + this.a, x = this.sx, y = this.sy;
    const ux = Math.cos(a), uy = -Math.sin(a); // forward on screen; (-uy, ux) is to its side
    ctx.beginPath();
    ctx.moveTo(x + ux * r * 1.4, y + uy * r * 1.4);
    ctx.lineTo(x - ux * r - uy * r, y - uy * r + ux * r);
    ctx.lineTo(x - ux * r * 0.45, y - uy * r * 0.45);
    ctx.lineTo(x - ux * r + uy * r, y - uy * r - ux * r);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = r * 0.25;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}
