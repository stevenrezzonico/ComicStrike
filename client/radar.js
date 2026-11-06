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
const REDRAW_MS = 33; // the radar is redrawn at most this often...
const REDRAW_TURN = 1.5; // ... unless the view turned this many degrees since
const COLOR = {
  [TEAM_T]: '#ffb84a', [TEAM_CT]: '#7db8ff', enemy: '#e2402a', bomb: '#ff9a3c', site: 'rgba(226,64,42,0.9)',
};
// The markers go to Canvas2D in 16ths of a pixel, as whole numbers, under a 1/16 scale: a
// fraction handed to a canvas call is a new heap number each time (~1 KB a redraw, 30
// redraws a second), a whole number is not. The helpers read their numbers from fields
// and PT for the same reason (as arguments they were boxed too).
const SUB = 16;
const UNSUB = 1 / SUB;
const TAU = 2 * Math.PI;
const PT = new Float64Array(2); // place()'s world point
const q = (v) => (v * SUB) | 0; // pixels to 16ths

export class Radar {
  // el: the radar's element (#radar: its CSS draws the disc, the clip and the rims), holding
  // the canvas the map and the markers are drawn on.
  constructor(el, cv) {
    this.pings = [];
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cv = cv;
    this.fontPx = 0; // bomb site letters' font, rebuilt when the size changes
    this.font = '';
    this.overview = null;
    this.images = []; // a canvas of the overview's pixels per level
    this.level = 0; // the level drawn (the one under the feet of whoever we see through)
    this.sites = []; // [x, y, letter]
    this.hidden = false; // hideradar / drawradar
    this.cssSize = 0;
    this.shown = null;
    this.drawnAt = -Infinity; // when, and at which view yaw, it was last drawn
    this.drawnYaw = -0;
    // This redraw's frame, and where place() put a point (pixels). -0: doubles from the
    // start (a field first given a whole number changes its object's map later).
    this.cx = this.cy = this.k = this.a = this.ca = this.sa = this.R = this.r = this.sx = this.sy = -0;
  }

  // A new map: its overview (an image per level) and bomb sites (A, B in entity order,
  // approx.).
  // pings: [x, y, ...] of teammates' pings (client/callouts.js), set before draw.
  setMap(overview, bombSites) {
    this.overview = overview;
    if (!overview) return; // none yet (it is being built: client/overviewworker.js)
    this.images = overview.levels.map((l) => {
      const img = document.createElement('canvas');
      img.width = overview.width;
      img.height = overview.height;
      img.getContext('2d').putImageData(new ImageData(l.rgba, overview.width, overview.height), 0, 0);
      return img;
    });
    this.level = 0;
    this.setSites(bombSites);
  }

  // The bomb sites drawn (Wingman keeps one).
  setSites(bombSites) {
    this.sites = bombSites.boxes.map((b, i) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, bombSites.names[i], b[2]]);
  }

  // at: [x, y, z (the feet of whoever we see through), yaw (degrees)]; rows:
  // interpolated snapshot rows (or null offline); selfId / watched: our id and the one we
  // see through (-1); team: ours (TEAM_SPECTATOR sees all); ffa: free for all; bomb:
  // BombState or null; hostages or null. On a map of several levels (shared/overview.js)
  // the level under those feet is drawn; what is on another level (players, the bomb,
  // hostages, the sites) is drawn faint, players with their up / down mark.
  draw(show, at, rows, selfId, watched, team, ffa, bomb, hostages, now) {
    const c = this.canvas, cz = at[2], yaw = at[3];
    show = show && !this.hidden && this.overview !== null;
    if (show !== this.shown) {
      this.shown = show;
      this.el.style.display = show ? 'block' : 'none';
      this.drawnAt = -Infinity;
    }
    const css = show ? Math.max(120, Math.round(innerHeight * SIZE * this.cv.cl_hud_radar_scale.number)) : 0;
    if (css !== this.cssSize) {
      this.cssSize = css;
      document.documentElement.style.setProperty('--radar', `${css ? css + 10 : 0}px`); // #debug goes below it
    }
    if (!show) return;
    const dpr = devicePixelRatio || 1, D = Math.round(css * dpr);
    if (c.width !== D) {
      c.width = c.height = D;
      this.el.style.width = this.el.style.height = `${css}px`;
      this.drawnAt = -Infinity;
    }
    // Drawn about 30 times a second (it cost ~0.3 ms a frame), every frame while the view
    // turns, so the rotating map stays smooth.
    const d = Math.abs(yaw - this.drawnYaw) % 360, turn = Math.min(d, 360 - d);
    const level = this.overview.levelOf(cz);
    if (now - this.drawnAt < REDRAW_MS && turn < REDRAW_TURN && level === this.level) return;
    this.drawnAt = now;
    this.drawnYaw = yaw;
    this.level = level;
    const ctx = this.ctx, o = this.overview, R = D / 2, selfX = at[0], selfY = at[1];
    let cx = selfX, cy = selfY;
    const multi = o.levels.length > 1; // (one level: all at full strength, no levelOf calls)
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
    ctx.clearRect(0, 0, D, D); // (the dark disc under it, its round clip and the rims are CSS)
    // The overview: pixel (u, v) -> world (minX + s u, maxY - s v) -> radar.
    const s = o.scale, ox = o.minX - cx, oy = o.maxY - cy;
    ctx.setTransform(k * s * ca, -k * s * sa, k * s * sa, k * s * ca, R + k * (ox * ca - oy * sa), R - k * (ox * sa + oy * ca));
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.images[level], 0, 0);
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const r = this.r = 3.4 * dpr * Math.max(1, css / 200);
    const px = Math.round(r * 3.2);
    if (px !== this.fontPx) { // (a new string and a font parse only when the size changes)
      this.fontPx = px;
      this.font = `700 ${px}px Verdana, Tahoma, sans-serif`;
    }
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.sites.length; i++) { // (the letters at a pixel's scale: a few doubles a redraw)
      const site = this.sites[i];
      PT[0] = site[0];
      PT[1] = site[1];
      if (!this.place(false)) continue;
      if (multi) this.faint(site[3]);
      ctx.lineWidth = dpr * 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(site[2], this.sx, this.sy);
      ctx.fillStyle = COLOR.site;
      ctx.fillText(site[2], this.sx, this.sy);
    }
    ctx.setTransform(UNSUB, 0, 0, UNSUB, 0, 0); // the rest in 16ths of a pixel
    if (hostages) {
      for (let h = 0; h < hostages.count; h++) {
        PT[0] = hostages.x[h];
        PT[1] = hostages.y[h];
        if (hostages.state[h] !== HS_IDLE || !this.place(false)) continue;
        if (multi) this.faint(hostages.z[h]);
        ctx.fillStyle = '#e6e6e0';
        ctx.fillRect(q(this.sx - r * 0.8), q(this.sy - r * 0.8), q(r * 1.6), q(r * 1.6));
      }
    }
    const all = team === TEAM_SPECTATOR;
    if (bomb && (all || team === TEAM_T) && (bomb.state === BOMB_DROPPED || bomb.state === BOMB_PLANTED)) {
      PT[0] = bomb.x;
      PT[1] = bomb.y;
      if (this.place(true)) {
        const blink = bomb.state === BOMB_PLANTED && Math.floor(now / 400) % 2;
        if (multi) this.faint(bomb.z);
        ctx.fillStyle = blink ? '#ff3b2f' : COLOR.bomb;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = q(dpr);
        const x = q(this.sx - r * 1.1), y = q(this.sy - r * 0.8), w = q(r * 2.2), h = q(r * 1.6);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
    }

    if (rows) {
      const spotBit = team === TEAM_T ? ANIM_SPOTTED_T : ANIM_SPOTTED_CT;
      for (let pass = 0; pass < 2; pass++) { // bodies first, then the living on top
        for (let id = 0; id < MAX_PLAYERS; id++) {
          const row = id * E_FIELDS;
          if (!rows[row + E_ACTIVE] || id === selfId || id === watched) continue;
          const t = rows[row + E_TEAM], alive = rows[row + E_HEALTH] > 0;
          if (alive !== (pass === 1)) continue;
          const mate = !ffa && t === team;
          const visible = all || mate || (alive && (rows[row + E_ANIM] & (ffa ? ANIM_SPOTTED_T | ANIM_SPOTTED_CT : spotBit)));
          if (!visible) continue;
          const color = mate || all ? COLOR[t] || '#ccc' : COLOR.enemy;
          PT[0] = rows[row + E_X];
          PT[1] = rows[row + E_Y];
          if (!this.place(mate && alive)) continue;
          const feet = rows[row + E_Z] - 36; // the origin is the hull's center (approx. when ducked)
          if (multi) this.faint(feet);
          if (!alive) this.cross(color);
          else this.dot(color, rows, row, Math.abs(feet - cz) > LEVEL ? (feet > cz ? -1 : 1) : 0);
        }
      }
    }
    ctx.globalAlpha = 1;
    // Teammates' pings: a yellow "!" in an ink ring.
    for (let i = 0; i < this.pings.length; i += 2) {
      PT[0] = this.pings[i];
      PT[1] = this.pings[i + 1];
      if (!this.place(true)) continue;
      const x = this.sx, y = this.sy;
      ctx.beginPath();
      ctx.arc(q(x), q(y), q(r * 1.6), 0, TAU);
      ctx.fillStyle = '#ffd23a';
      ctx.fill();
      ctx.lineWidth = q(r * 0.45);
      ctx.strokeStyle = '#17130f';
      ctx.stroke();
      ctx.fillStyle = '#17130f';
      ctx.fillRect(q(x - r * 0.22), q(y - r * 1.05), q(r * 0.44), q(r * 1.2));
      ctx.fillRect(q(x - r * 0.22), q(y + r * 0.4), q(r * 0.44), q(r * 0.44));
    }
    // Us (or whoever we watch): an arrow along the view (straight up when the radar turns).
    PT[0] = selfX;
    PT[1] = selfY;
    if (this.place(true)) this.arrow(team === TEAM_CT ? COLOR[TEAM_CT] : team === TEAM_T ? COLOR[TEAM_T] : '#f2ecd8');
  }

  // Faint unless feet at z are on the level drawn.
  faint(z) {
    this.ctx.globalAlpha = this.overview.levelOf(z) === this.level ? 1 : 0.45;
  }

  // Radar position (pixels) of the world point in PT into this.sx / this.sy; false if off
  // the radar (or, `clamp`: pulled in to the edge).
  place(clamp) {
    const dx = PT[0] - this.cx, dy = PT[1] - this.cy, k = this.k;
    const px = k * (dx * this.ca - dy * this.sa), py = -k * (dx * this.sa + dy * this.ca);
    const d = Math.sqrt(px * px + py * py), max = this.R * 0.9; // (hypot allocates its result)
    if (d > max && !clamp) return false;
    const f = Math.min(1, max / d); // pulled in to the edge (no reassigned locals: see SUB)
    this.sx = this.R + px * f;
    this.sy = this.R + py * f;
    return true;
  }

  // A player (row `row` of `rows`) at place()'s point: a dot with a tick along his view, a
  // mark when far above (s -1) or below (1) us. A world direction at yaw p is at angle p +
  // the radar's turn on screen.
  dot(color, rows, row, s) {
    const ctx = this.ctx, x = this.sx, y = this.sy, r = this.r, a = dequantizeYaw(rows[row + E_YAW]) * DEG + this.a;
    ctx.strokeStyle = color;
    ctx.lineWidth = q(r * 0.6);
    ctx.beginPath();
    ctx.moveTo(q(x), q(y));
    ctx.lineTo(q(x + Math.cos(a) * r * 2), q(y - Math.sin(a) * r * 2));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(q(x), q(y), q(r), 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = q(r * 0.35);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    if (s !== 0) { // above: a cap over the dot; below: under it
      ctx.beginPath();
      ctx.moveTo(q(x - r), q(y + s * r * 1.5));
      ctx.lineTo(q(x), q(y + s * r * 2.6));
      ctx.lineTo(q(x + r), q(y + s * r * 1.5));
      ctx.lineWidth = q(r * 0.5);
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  // A body at place()'s point: an X.
  cross(color) {
    const ctx = this.ctx, x = this.sx, y = this.sy, r = this.r;
    ctx.strokeStyle = color;
    ctx.lineWidth = q(r * 0.6);
    ctx.beginPath();
    ctx.moveTo(q(x - r), q(y - r));
    ctx.lineTo(q(x + r), q(y + r));
    ctx.moveTo(q(x + r), q(y - r));
    ctx.lineTo(q(x - r), q(y + r));
    ctx.stroke();
  }

  // Us at place()'s point: an arrow along the view (drawnYaw, degrees).
  arrow(color) {
    const ctx = this.ctx, a = this.drawnYaw * DEG + this.a, x = this.sx, y = this.sy, r = this.r * 1.5;
    const ux = Math.cos(a), uy = -Math.sin(a); // forward on screen; (-uy, ux) is to its side
    ctx.beginPath();
    ctx.moveTo(q(x + ux * r * 1.4), q(y + uy * r * 1.4));
    ctx.lineTo(q(x - ux * r - uy * r), q(y - uy * r + ux * r));
    ctx.lineTo(q(x - ux * r * 0.45), q(y - uy * r * 0.45));
    ctx.lineTo(q(x - ux * r + uy * r), q(y - uy * r - ux * r));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = q(r * 0.25);
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}
