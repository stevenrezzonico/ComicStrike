// The HUD's weapon column (CS:GO's inventory over the ammo): a row for each weapon carried in
// the slot keys' order, each kind of grenade on a row of its own with its count, the one in
// hand yellow, its key beside it. The silhouettes are the kill feed's icons (client/
// killicons.js) used as masks, so CSS colors them. Rebuilt only when what is carried or held
// changes (a DOM write restyles the page); the check runs every frame and allocates nothing.
// cl_showloadout 0 (CS:GO's) shows it for FADE_MS after a change only.

import {
  WEAPONS, WS_SLOTS, WS_ACTIVE, WS_GRENADES, GRENADE_IDS, NUM_SLOTS,
  SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, SLOT_TASER, SLOT_GRENADE, SLOT_C4,
} from '../shared/weapons.js';

const ORDER = [SLOT_PRIMARY, SLOT_SECONDARY, SLOT_KNIFE, SLOT_TASER, SLOT_GRENADE, SLOT_C4]; // top to bottom
const KEYS = ['1', '2', '3', '4', '5', '3']; // by slot: slot1-5 (the Zeus comes out with 3, as the knife)
const ROWS_MAX = NUM_SLOTS - 1 + GRENADE_IDS.length;
export const FADE_MS = 3000;
const EM = 20; // icon sizes in ems of 20 px (the kill feed's size), so the column's font size scales them
const SLACK_X = 5, SLACK_Y = 16; // a tap this far off a row's icon still takes it (half the touch row's gap across)

// The console command that draws weapon `id` (slot1-6; the Zeus by slot6, as slot3 with
// the knife out would).
export const slotCommand = (id) => `slot${WEAPONS[id].slot + 1}`;

// The rows of weapon state `ws` into `out`, 3 numbers a row: the weapon id, the count (a
// grenade kind's; 1 for the rest) and 1 for the one in hand. Returns the row count.
export function loadoutRows(ws, out) {
  const f = ws.f, active = f[WS_ACTIVE];
  let n = 0;
  for (let i = 0; i < ORDER.length; i++) {
    const slot = ORDER[i], id = f[WS_SLOTS + slot * 3];
    if (slot === SLOT_GRENADE) {
      const n0 = n;
      for (let k = 0; k < GRENADE_IDS.length; k++) {
        if (!(f[WS_GRENADES + k] > 0)) continue;
        out[n * 3] = GRENADE_IDS[k];
        out[n * 3 + 1] = f[WS_GRENADES + k];
        out[n * 3 + 2] = active === slot && id === GRENADE_IDS[k] ? 1 : 0;
        n++;
      }
      if (n === n0 && id > 0 && WEAPONS[id]) { // a grenade with no counts: a spectated player's (client/spectate.js)
        out[n * 3] = id;
        out[n * 3 + 1] = 1;
        out[n * 3 + 2] = active === slot ? 1 : 0;
        n++;
      }
    } else if (id > 0 && WEAPONS[id]) {
      out[n * 3] = id;
      out[n * 3 + 1] = 1;
      out[n * 3 + 2] = active === slot ? 1 : 0;
      n++;
    }
  }
  return n;
}

export class LoadoutPanel {
  // el: the column; icons: the kill feed's KillIcons.
  constructor(el, icons) {
    this.el = el;
    this.icons = icons;
    this.rows = new Float64Array(ROWS_MAX * 3);
    this.shown = new Float64Array(ROWS_MAX * 3);
    this.shownN = -1;
    this.changedAt = -1e9;
    this.faded = false;
  }

  // Every drawn frame: ws the weapons seen (ours, or the spectated player's), now in ms,
  // always: cl_showloadout.
  update(ws, now, always) {
    const n = loadoutRows(ws, this.rows), rows = this.rows, shown = this.shown;
    let same = n === this.shownN;
    for (let i = 0; same && i < n * 3; i++) same = rows[i] === shown[i];
    if (!same) {
      this.build(n);
      shown.set(rows);
      this.shownN = n;
      this.changedAt = now;
    }
    const fade = !always && now - this.changedAt > FADE_MS;
    if (fade !== this.faded) {
      this.faded = fade;
      this.el.classList.toggle('faded', fade);
    }
  }

  // A touch screen's tap at page point (x, y) on a row draws that weapon: its command, or
  // null (nothing there, the column faded out, or the weapon already in hand: slot4 again is the
  // next grenade, slot3 again the Zeus). The rows' places are read on the tap only.
  commandAt(x, y) {
    if (this.faded) return null;
    const rows = this.el.children;
    for (let r = 0; r < rows.length; r++) {
      const b = rows[r].getBoundingClientRect();
      if (x >= b.left - SLACK_X && x <= b.right + SLACK_X && y >= b.top - SLACK_Y && y <= b.bottom + SLACK_Y) {
        return rows[r].className === 'lo on' ? null : rows[r].dataset.cmd;
      }
    }
    return null;
  }

  build(n) {
    const el = this.el, rows = this.rows, icons = this.icons;
    el.textContent = '';
    for (let r = 0; r < n; r++) {
      const id = rows[r * 3], count = rows[r * 3 + 1];
      const row = el.appendChild(document.createElement('div'));
      row.className = rows[r * 3 + 2] ? 'lo on' : 'lo';
      row.dataset.cmd = slotCommand(id);
      const ic = row.appendChild(document.createElement('i'));
      const mask = `url(${icons.url(id)})`; // (draws the icon first if it was not yet: sizes too)
      ic.style.width = `${icons.widths[id] / EM}em`;
      ic.style.height = `${icons.heights[id] / EM}em`;
      ic.style.maskImage = ic.style.webkitMaskImage = mask;
      if (count > 1) row.appendChild(document.createElement('b')).textContent = `×${count}`;
      row.appendChild(document.createElement('kbd')).textContent = KEYS[WEAPONS[id].slot];
    }
  }
}
