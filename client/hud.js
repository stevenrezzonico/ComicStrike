// Round HUD (score, clock, round-end banner), money, the bomb (carrier icon, plant /
// defuse progress), scoreboard and the buy menu. DOM only; every element is rewritten
// only when its text changes.

import { TEAM_T, TEAM_CT } from '../shared/player.js';
import {
  PHASE_WARMUP, PHASE_FREEZE, PHASE_OVER, END_TIME, END_BOMB, END_DEFUSE, BUY_MENU, itemLabel, itemPrice,
} from '../shared/economy.js';
import { BOMB_PLANTED } from '../shared/bomb.js';
import { TICK_RATE } from '../shared/constants.js';

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

  // rs: RoundState and bomb: BombState (null offline); now: ms.
  update(rs, bomb, money, now) {
    this.set(this.elMoney, 'money', `$${money}`);
    if (!rs) {
      this.set(this.elRound, 'round', 'OFFLINE');
      this.set(this.elBanner, 'banner', '');
      return;
    }
    const secs = Math.max(0, Math.ceil(rs.ticksLeft / TICK_RATE));
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    // CS:GO hides the clock once the bomb is down: the beeps tell the time.
    const planted = bomb.state === BOMB_PLANTED;
    const mid = rs.phase === PHASE_WARMUP ? 'WARMUP' : rs.phase === PHASE_FREEZE ? `buy ${clock}` : planted ? ' C4 ' : clock;
    this.set(this.elRound, 'round', `CT ${rs.scoreCT}   ${mid}   ${rs.scoreT} T`);
    this.elRound.classList.toggle('planted', planted && rs.phase !== PHASE_OVER);
    let banner = '';
    if (rs.phase === PHASE_OVER) {
      const winner = rs.info & 3, reason = rs.info >> 2;
      banner = winner === TEAM_CT ? 'Counter-Terrorists Win' : winner === TEAM_T ? 'Terrorists Win' : 'Round Draw';
      if (reason === END_TIME) banner += ' (time)';
      else if (reason === END_BOMB) banner = 'Target Bombed: ' + banner;
      else if (reason === END_DEFUSE) banner = 'Bomb Defused: ' + banner;
    } else if (rs.phase === PHASE_WARMUP) {
      banner = 'Warmup: waiting for both teams';
    } else if (now < this.noticeUntil) {
      banner = this.notice;
    }
    this.set(this.elBanner, 'banner', banner);
  }

  // The C4 icon while we carry it (bright inside a bomb site), and the plant/defuse
  // progress bar (`label` '' hides it; `frac` 0..1).
  bombStatus(carrying, inSite, label, frac) {
    this.set(this.elBomb, 'bomb', carrying ? 'C4' : '');
    this.elBomb.classList.toggle('site', carrying && inSite);
    this.elProgress.style.display = label ? 'block' : 'none';
    if (!label) return;
    this.set(this.elProgressLabel, 'progress', label);
    this.elProgressBar.style.width = `${Math.round(Math.min(Math.max(frac, 0), 1) * 100)}%`;
  }

  // --- Scoreboard (hold Tab) -----------------------------------------------------

  // net: NetClient (names/teams/kills/deaths), alive(id) -> bool
  scoreboard(show, net, selfId, alive) {
    this.elScore.style.display = show ? 'block' : 'none';
    if (!show || !net) return;
    const lines = [];
    for (const [team, title, cls] of [[TEAM_CT, 'Counter-Terrorists', 'ct'], [TEAM_T, 'Terrorists', 't']]) {
      lines.push([cls, title, 'K', 'D']);
      const ids = [];
      for (let id = 0; id < net.names.length; id++) if (net.names[id] && net.teams[id] === team) ids.push(id);
      ids.sort((a, b) => net.kills[b] - net.kills[a] || net.deaths[a] - net.deaths[b]);
      for (const id of ids) {
        lines.push([`${id === selfId ? 'me' : ''}${alive(id) ? '' : ' dead'}`, net.names[id], net.kills[id], net.deaths[id]]);
      }
    }
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

  // --- Buy menu (B) ---------------------------------------------------------------

  buildMenu() {
    this.elMenu.innerHTML = '';
    const cats = document.createElement('div');
    cats.className = 'cats';
    this.items = document.createElement('div');
    this.items.className = 'items';
    BUY_MENU.forEach(([name], i) => {
      const b = document.createElement('button');
      b.textContent = `${i + 1}  ${name}`;
      b.addEventListener('click', () => this.openCategory(i));
      cats.appendChild(b);
    });
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'B / Esc: close  ·  click the game to resume';
    this.elMenu.append(cats, this.items, hint);
  }

  openCategory(i) {
    this.category = i;
    this.items.innerHTML = '';
    BUY_MENU[i][1].forEach((item, k) => {
      const b = document.createElement('button');
      b.dataset.item = item;
      b.innerHTML = '<span></span><span class="price"></span>';
      b.firstChild.textContent = `${k + 1}  ${itemLabel(item)}`;
      b.addEventListener('click', () => this.onBuy(item));
      this.items.appendChild(b);
    });
    this.refreshMenu(this.lastPlayer, this.lastCanBuy);
  }

  // Grey out what this player cannot buy now; show prices.
  refreshMenu(player, canBuy) {
    this.lastPlayer = player;
    this.lastCanBuy = canBuy;
    if (!this.menuOpen || !player) return;
    for (const b of this.items.children) {
      const price = itemPrice(player, +b.dataset.item);
      b.lastChild.textContent = price < 0 ? '—' : `$${price}`;
      b.disabled = !canBuy || price < 0 || price > player.money || player.health <= 0;
    }
    this.elMenu.classList.toggle('closed', !canBuy);
  }

  toggleMenu(open = !this.menuOpen) {
    this.menuOpen = open;
    this.elMenu.style.display = open ? 'block' : 'none';
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.openCategory(this.category < 0 ? 0 : this.category);
    }
  }

  // Number keys inside the menu: first a category, then an item.
  menuKey(n) {
    if (!this.menuOpen) return;
    const items = this.items.children;
    if (this.items.dataset.picking === '1' && n <= items.length) {
      if (!items[n - 1].disabled) items[n - 1].click();
      this.items.dataset.picking = '0';
    } else if (n <= BUY_MENU.length) {
      this.openCategory(n - 1);
      this.items.dataset.picking = '1';
    }
  }
}
