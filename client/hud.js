// Round HUD (score, clock, round-end banner), money, the bomb (carrier icon, plant /
// defuse progress), scoreboard and the buy menu. DOM only; every element is rewritten
// only when its text changes.

import { TEAM_T, TEAM_CT, TEAM_SPECTATOR } from '../shared/player.js';
import {
  PHASE_WARMUP, PHASE_FREEZE, PHASE_OVER, END_TIME, END_BOMB, END_DEFUSE, END_RESCUE, END_MATCH, GAME_FFA, GAME_DM,
  GAME_DEMO, GAME_ARMSRACE, GAME_DEMOLITION,
  BUY_MENU, ITEM_KEVLAR, ITEM_ASSAULTSUIT, ITEM_DEFUSER, itemLabel, itemPrice,
} from '../shared/economy.js';
import { WEAPONS } from '../shared/weapons.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { TICK_RATE } from '../shared/constants.js';
import { ARMS_RACE } from '../shared/progression.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(onBuy) {
    this.onBuy = onBuy; // (item) => void
    this.elMoney = $('hud-money');
    this.elRound = $('roundbar');
    this.elBanner = $('banner');
    this.elScore = $('scoreboard');
    this.elMenu = $('buymenu');
    this.elBomb = $('hud-bomb');
    this.elProgress = $('progress');
    this.elProgressBar = this.elProgress.firstElementChild;
    this.elProgressLabel = this.elProgress.lastElementChild;
    this.shown = { money: '', round: '', banner: '', bomb: '', progress: '' };
    // What the round bar and banner were built from: rebuilt only when one changes.
    this.key = { money: -1, secs: -1, phase: -1, planted: false, ct: -1, t: -1, mode: -1, info: -1, notice: '',
      lName: '', lScore: -1, lSelf: false, lTied: false, progress: '' };
    this.bombSite = false;
    this.progressShown = false;
    this.progressPct = -1;
    this.notice = '';
    this.noticeUntil = 0;
    this.menuOpen = false;
    this.category = -1;
    this.buildMenu();
  }

  set(el, key, text) {
    if (this.shown[key] === text) return;
    this.shown[key] = text;
    el.textContent = text;
  }

  // A banner message for `ms` (unless the round's own banner is showing).
  flash(text, ms, now) {
    this.notice = text;
    this.noticeUntil = now + ms;
  }

  // rs: RoundState and bomb: BombState (null offline); now: ms; leader: the top scorer
  // { name, score, self, tied } (deathmatch, arms race) or null; progress: our place in
  // the gun game modes' weapon list ('' in the others).
  update(rs, bomb, money, now, leader = null, progress = '') {
    const K = this.key;
    if (money !== K.money) {
      K.money = money;
      this.set(this.elMoney, 'money', `$${money}`);
    }
    if (!rs) {
      this.set(this.elRound, 'round', 'OFFLINE');
      this.set(this.elBanner, 'banner', '');
      return;
    }
    const secs = rs.ticksLeft > 0 ? Math.ceil(rs.ticksLeft / TICK_RATE) : 0;
    // CS:GO hides the clock once the bomb is down: the beeps tell the time.
    const planted = bomb.state === BOMB_PLANTED;
    const notice = now < this.noticeUntil ? this.notice : '';
    const lName = leader ? leader.name : '', lScore = leader ? leader.score : -1, lSelf = !!leader && leader.self;
    const lTied = !!leader && leader.tied;
    if (secs === K.secs && rs.phase === K.phase && planted === K.planted && rs.scoreCT === K.ct && rs.scoreT === K.t &&
      rs.mode === K.mode && rs.info === K.info && notice === K.notice && lName === K.lName && lScore === K.lScore &&
      lSelf === K.lSelf && lTied === K.lTied && progress === K.progress) return; // nothing to rebuild (the usual frame)
    K.progress = progress;
    K.secs = secs;
    K.phase = rs.phase;
    K.planted = planted;
    K.ct = rs.scoreCT;
    K.t = rs.scoreT;
    K.mode = rs.mode;
    K.info = rs.info;
    K.notice = notice;
    K.lName = lName;
    K.lScore = lScore;
    K.lSelf = lSelf;
    K.lTied = lTied;
    this.elRound.classList.toggle('planted', planted && rs.phase !== PHASE_OVER);
    const clock = rs.ticksLeft > 0 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '';
    const mid = rs.phase === PHASE_WARMUP ? 'WARMUP' : rs.phase === PHASE_FREEZE ? `buy ${clock}` : planted ? ' C4 ' : clock;
    const dm = (rs.mode & GAME_DM) !== 0, armsRace = (rs.mode & GAME_ARMSRACE) !== 0;
    const lead = leader && leader.score > 0 && !leader.tied ? `   lead: ${leader.self ? 'you' : leader.name} ` +
      (armsRace ? `level ${Math.min(leader.score + 1, ARMS_RACE.length)}` : leader.score) : '';
    this.set(this.elRound, 'round', rs.mode & GAME_DEMO ? `DEMO   ${mid}`
      : dm ? `DEATHMATCH   ${mid}${lead}` : armsRace ? `ARMS RACE   ${mid}   ${progress}${lead}`
      : `CT ${rs.scoreCT}   ${mid}   ${rs.scoreT} T${rs.mode & GAME_DEMOLITION ? `   ${progress}` : ''}`);
    let banner = '';
    if (rs.phase === PHASE_OVER && rs.info >> 2 === END_MATCH) {
      banner = !leader || leader.tied ? 'Match over: a draw'
        : `${leader.self ? 'You win' : `${leader.name} wins`} the match` + (armsRace ? '' : ` (${leader.score} points)`);
    } else if (rs.phase === PHASE_OVER) {
      const winner = rs.info & 3, reason = rs.info >> 2;
      banner = winner === TEAM_CT ? 'Counter-Terrorists Win' : winner === TEAM_T ? 'Terrorists Win' : 'Round Draw';
      if (reason === END_TIME) banner += ' (time)';
      else if (reason === END_BOMB) banner = 'Target Bombed: ' + banner;
      else if (reason === END_DEFUSE) banner = 'Bomb Defused: ' + banner;
      else if (reason === END_RESCUE) banner = 'Hostage Rescued: ' + banner;
    } else if (rs.phase === PHASE_WARMUP) {
      banner = rs.mode & GAME_FFA ? 'Warmup: waiting for players' : 'Warmup: waiting for both teams';
    } else if (notice) {
      banner = notice;
    }
    this.set(this.elBanner, 'banner', banner);
  }

  // The C4 icon while we carry it (bright inside a bomb site), and the plant/defuse
  // progress bar (`label` '' hides it; `frac` 0..1).
  bombStatus(carrying, inSite, label, frac) {
    this.set(this.elBomb, 'bomb', carrying ? 'C4' : '');
    if ((carrying && inSite) !== this.bombSite) {
      this.bombSite = carrying && inSite;
      this.elBomb.classList.toggle('site', this.bombSite);
    }
    if (!!label !== this.progressShown) {
      this.progressShown = !!label;
      this.elProgress.style.display = label ? 'block' : 'none';
    }
    if (!label) return;
    this.set(this.elProgressLabel, 'progress', label);
    const pct = Math.round(Math.min(Math.max(frac, 0), 1) * 100);
    if (pct !== this.progressPct) {
      this.progressPct = pct;
      this.elProgressBar.style.width = `${pct}%`;
    }
  }

  // --- Scoreboard (hold Tab) -----------------------------------------------------

  // net: NetClient (names/teams/kills/deaths/scores), alive(id) -> bool. Deathmatch
  // adds the points (and sorts by them); free for all is one list.
  scoreboard(show, net, selfId, alive) {
    this.elScore.style.display = show ? 'block' : 'none';
    if (!show || !net) return;
    const mode = net.own.round.mode, armsRace = (mode & GAME_ARMSRACE) !== 0;
    const dm = (mode & GAME_DM) !== 0 || armsRace; // ranked by score (arms race: the level)
    const ranked = (id) => armsRace ? Math.min(net.scores[id] + 1, ARMS_RACE.length) : net.scores[id];
    const groups = mode & GAME_FFA ? [[[TEAM_CT, TEAM_T], 'Players', 'ffa']]
      : [[[TEAM_CT], 'Counter-Terrorists', 'ct'], [[TEAM_T], 'Terrorists', 't']];
    const lines = [];
    for (const [teams, title, cls] of groups) {
      lines.push(dm ? [cls, title, armsRace ? 'Level' : 'Score', 'K', 'D'] : [cls, title, 'K', 'D']);
      const ids = [];
      for (let id = 0; id < net.names.length; id++) if (net.names[id] && teams.includes(net.teams[id])) ids.push(id);
      ids.sort((a, b) => (dm ? net.scores[b] - net.scores[a] : 0) || net.kills[b] - net.kills[a] ||
        net.deaths[a] - net.deaths[b]);
      for (const id of ids) {
        const cls = `${id === selfId ? 'me' : ''}${alive(id) ? '' : ' dead'}`;
        lines.push(dm ? [cls, net.names[id], ranked(id), net.kills[id], net.deaths[id]]
          : [cls, net.names[id], net.kills[id], net.deaths[id]]);
      }
    }
    const watching = [];
    for (let id = 0; id < net.names.length; id++) {
      if (net.names[id] && net.teams[id] === TEAM_SPECTATOR) watching.push(net.names[id]);
    }
    if (watching.length) lines.push(['spec', `Spectators: ${watching.join(', ')}`]);
    const key = JSON.stringify(lines);
    if (this.shown.score === key) return;
    this.shown.score = key;
    const table = document.createElement('table');
    for (const [cls, ...cells] of lines) {
      const tr = table.insertRow();
      tr.className = cls;
      for (const c of cells) tr.insertCell().textContent = c; // names as text, never HTML
    }
    this.elScore.replaceChildren(table);
  }

  // --- Buy menu (B): CS:GO's radial wheel ------------------------------------------
  // A ring of categories; picking one turns it into a ring of that category's items (the
  // ones our team can buy) around a center that shows the money, or the item under the
  // mouse with its price and stats. The mouse's direction from the center picks a
  // sector (anywhere on the screen, as in CS:GO), a click opens or buys it, a right click
  // or a click in the center goes back; number keys pick too (0 = the tenth). SVG in a
  // full-screen layer; only what changes is rewritten.

  buildMenu() {
    const svg = svgEl('svg', { viewBox: `${-WHEEL} ${-WHEEL} ${WHEEL * 2} ${WHEEL * 2}`, class: 'wheel' });
    const defs = svgEl('defs');
    const hatch = svgEl('pattern', { id: 'buy-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)' });
    hatch.append(svgEl('rect', { width: 8, height: 8, class: 'hatch-bg' }), svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8,
      class: 'hatch-line' }));
    defs.appendChild(hatch);
    this.ring = svgEl('g', { class: 'ring' });
    this.center = svgEl('g', { class: 'center' });
    this.center.appendChild(svgEl('circle', { r: R_IN - 8 }));
    this.centerLines = [];
    for (let i = 0; i < 6; i++) {
      const t = svgEl('text', { y: -46 + i * 22, class: i === 0 ? 'big' : i === 1 ? 'price' : 'small' });
      this.centerLines.push(t);
      this.center.appendChild(t);
    }
    svg.append(defs, this.ring, this.center);
    const hint = document.createElement('div');
    hint.className = 'hint';
    this.elHint = hint;
    this.elMenu.replaceChildren(svg, hint);
    this.wheel = svg;
    this.sectors = []; // per sector: { g, path, item, label, price, key, shownPrice, shownState }
    this.hover = -1;
    this.view = 'cats';
    this.elMenu.addEventListener('pointermove', (e) => this.pointAt(e.clientX, e.clientY));
    this.elMenu.addEventListener('pointerdown', (e) => {
      this.pointAt(e.clientX, e.clientY);
      if (e.button === 2 || (e.button === 0 && this.hover < 0)) this.back();
      else if (e.button === 0) this.pick(this.hover);
    });
    this.elMenu.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // The sectors of the current view: the categories, or category `cat`'s items.
  showRing(cat) {
    this.view = cat < 0 ? 'cats' : 'items';
    this.category = cat < 0 ? this.category : cat;
    const team = this.lastPlayer ? this.lastPlayer.team : TEAM_T;
    const entries = cat < 0 ? BUY_MENU.map(([name]) => ({ label: name, item: -1 }))
      : BUY_MENU[cat][1].filter((item) => forTeam(item, team)).map((item) => ({ label: itemLabel(item), item }));
    const n = entries.length, step = 360 / n;
    this.ring.replaceChildren();
    this.sectors = entries.map((en, i) => {
      const mid = -90 + i * step, g = svgEl('g', { class: 'sector' });
      const path = svgEl('path', { d: sectorPath(mid - step / 2 + GAP, mid + step / 2 - GAP, R_IN, R_OUT) });
      const rad = mid * Math.PI / 180, tr = (R_IN + R_OUT) / 2 + (n > 8 ? 6 : 0);
      const tx = Math.cos(rad) * tr, ty = Math.sin(rad) * tr;
      const lines = wrapLabel(en.label, n > 8 ? 9 : 12);
      const label = svgEl('text', { x: tx, y: ty - (lines.length - 1) * 9 - (cat < 0 ? 0 : 6), class: cat < 0 ? 'cat' : 'name' });
      lines.forEach((line, k) => {
        const span = svgEl('tspan', { x: tx, dy: k ? 18 : 0 });
        span.textContent = line;
        label.appendChild(span);
      });
      const price = svgEl('text', { x: tx, y: ty + lines.length * 9 + 8, class: 'price' });
      const kr = R_OUT - 14, key = svgEl('text', { x: Math.cos(rad) * kr, y: Math.sin(rad) * kr + 4, class: 'key' });
      key.textContent = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
      g.append(path, label, price, key);
      g.dataset.dx = (Math.cos(rad) * 8).toFixed(1);
      g.dataset.dy = (Math.sin(rad) * 8).toFixed(1);
      this.ring.appendChild(g);
      return { g, item: en.item, price, shownPrice: null, shownState: -1, enabled: cat < 0 };
    });
    this.hover = -1;
    this.ring.classList.remove('pop');
    requestAnimationFrame(() => this.ring.classList.add('pop'));
    this.elHint.textContent = cat < 0 ? 'B / Esc: close  ·  pick a category'
      : 'B / Esc: close  ·  right click or the center: back';
    this.centerKey = '';
    this.refreshMenu(this.lastPlayer, this.lastCanBuy, this.lastFree);
  }

  // The sector in the mouse's direction from the wheel's center (-1: the center).
  pointAt(x, y) {
    const r = this.wheel.getBoundingClientRect();
    if (!r.width) return;
    const scale = r.width / (WHEEL * 2), dx = (x - r.left - r.width / 2) / scale, dy = (y - r.top - r.height / 2) / scale;
    let k = -1;
    if (dx * dx + dy * dy > (R_IN - 8) * (R_IN - 8) && this.sectors.length) {
      const step = 360 / this.sectors.length, a = Math.atan2(dy, dx) * 180 / Math.PI + 90 + step / 2;
      k = Math.floor((((a % 360) + 360) % 360) / step);
    }
    this.setHover(k);
  }

  setHover(k) {
    if (k === this.hover) return;
    if (this.hover >= 0 && this.sectors[this.hover]) {
      this.sectors[this.hover].g.classList.remove('hot');
      this.sectors[this.hover].g.style.transform = '';
    }
    this.hover = k;
    if (k >= 0) {
      const g = this.sectors[k].g;
      g.classList.add('hot');
      g.style.transform = `translate(${g.dataset.dx}px, ${g.dataset.dy}px)`;
    }
    this.centerKey = '';
    this.refreshMenu(this.lastPlayer, this.lastCanBuy, this.lastFree);
  }

  pick(k) {
    const s = this.sectors[k];
    if (!s) return;
    if (this.view === 'cats') this.showRing(k);
    else if (s.enabled) this.onBuy(s.item);
  }

  back() {
    if (this.view === 'items') this.showRing(-1);
  }

  // Prices, what this player cannot buy now and the center text (`free`: deathmatch).
  // Called every frame: touches the DOM only when something changed.
  refreshMenu(player, canBuy, free = false) {
    this.lastPlayer = player;
    this.lastCanBuy = canBuy;
    this.lastFree = free;
    if (!this.menuOpen || !player) return;
    if (this.shownTeam !== player.team) { // the items differ per team
      this.shownTeam = player.team;
      return this.showRing(this.view === 'items' ? this.category : -1);
    }
    this.elMenu.classList.toggle('closed', !canBuy);
    if (this.view === 'items') {
      for (const s of this.sectors) {
        const price = itemPrice(player, s.item);
        const state = price < 0 ? 1 : !canBuy || player.health <= 0 || (!free && price > player.money) ? 2 : 0;
        s.enabled = state === 0;
        if (state !== s.shownState) {
          s.shownState = state;
          s.g.classList.toggle('off', state !== 0);
        }
        const text = price < 0 ? 'OWNED' : free ? 'FREE' : `$${price}`;
        if (text !== s.shownPrice) s.price.textContent = s.shownPrice = text;
      }
    }
    // The center: the money and why we cannot buy, or the item under the mouse.
    const s = this.sectors[this.hover];
    const key = `${this.view}${this.hover}|${player.money}|${canBuy}|${free}|${s ? s.shownPrice : ''}`;
    if (key === this.centerKey) return;
    this.centerKey = key;
    let lines;
    if (this.view === 'items' && s) lines = [itemLabel(s.item), s.shownPrice, ...itemStats(s.item)];
    else if (this.view === 'items') lines = [BUY_MENU[this.category][0], free ? 'FREE' : `$${player.money}`, 'right click: back'];
    else lines = [free ? 'FREE' : `$${player.money}`, '', s ? BUY_MENU[this.hover][0] : 'BUY MENU'];
    if (!canBuy) lines = [lines[0], lines[1], 'Buying is not', 'possible here', 'or now'];
    this.centerLines.forEach((t, i) => {
      t.textContent = lines[i] || '';
      t.classList.toggle('warn', !canBuy && i >= 2);
    });
  }

  toggleMenu(open = !this.menuOpen) {
    this.menuOpen = open;
    this.elMenu.style.display = open ? 'block' : 'none';
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.showRing(-1);
    }
  }

  // Number keys inside the menu: first a category, then an item (0 = the tenth).
  menuKey(n) {
    if (!this.menuOpen) return;
    this.pick(n - 1);
  }
}

const WHEEL = 300; // view box half size
const R_OUT = 286, R_IN = 118; // ring radii
const GAP = 1.2; // degrees between sectors

function svgEl(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// An annular sector from angle a0 to a1 (degrees, clockwise from +x), radii r0..r1.
function sectorPath(a0, a1, r0, r1) {
  const p = (a, r) => `${(Math.cos(a * Math.PI / 180) * r).toFixed(1)} ${(Math.sin(a * Math.PI / 180) * r).toFixed(1)}`;
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p(a0, r1)} A${r1} ${r1} 0 ${large} 1 ${p(a1, r1)} L${p(a1, r0)} A${r0} ${r0} 0 ${large} 0 ${p(a0, r0)} Z`;
}

// A label in one or two lines (split at the space nearest the middle).
function wrapLabel(label, max) {
  if (label.length <= max || !label.includes(' ')) return [label];
  let best = -1;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === ' ' && (best < 0 || Math.abs(i - label.length / 2) < Math.abs(best - label.length / 2))) best = i;
  }
  return [label.slice(0, best), label.slice(best + 1)];
}

// Items a team can ever buy (CS:GO's wheel shows only those).
function forTeam(item, team) {
  if (item === ITEM_DEFUSER) return team === TEAM_CT;
  const w = WEAPONS[item];
  return !w || (w.teams & (team === TEAM_CT ? 2 : 1)) !== 0;
}

// The center's stat lines for an item.
function itemStats(item) {
  const w = WEAPONS[item];
  if (item === ITEM_KEVLAR) return ['Body armor'];
  if (item === ITEM_ASSAULTSUIT) return ['Body armor', 'and a helmet'];
  if (item === ITEM_DEFUSER) return ['Defuses in 5 s'];
  if (!w || !w.gun || w.grenade) return w && w.killAward ? [`Kill award $${w.killAward}`] : [];
  return [
    `Damage ${w.damage}${w.bullets > 1 ? ` x ${w.bullets}` : ''}`,
    `${Math.round(60 / w.cycle)} rounds/min`,
    `Magazine ${w.clip} / ${w.reserve}`,
    `Kill award $${w.killAward}`,
  ];
}
