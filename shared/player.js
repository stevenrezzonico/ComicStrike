// One player's simulation, run identically by the client (prediction) and the server
// (authority): a user command moves the player, applies fall damage and runs the
// weapon; shots are then traced against the world and its breakables.

import { TICK_DT } from './constants.js';
import {
  createPlayerState, copyPlayerState, playerMove, fallDamage, PS_ORIGIN, PS_EVENTS, PS_LAND_SPEED, PS_VELMOD, EV_LAND,
} from './pmove.js';
import {
  createWeaponState, copyWeaponState, giveWeapon, weaponTick, activeWeapon, WEAPON_ID, SLOT_PRIMARY, WS_ACTIVE,
} from './weapons.js';
import { Trace, traceHull, hullFits, HULL_POINT } from './trace.js';
import { hitgroupScale, HITGROUP_HEAD, HITGROUP_LEGS } from './hitgroups.js';
import {
  SURF_DEFAULT, SURF_FLESH, GM_GLASS, GM_GRATE, GM_WOOD, GM_CARDBOARD, GM_PLASTIC, breakableSurface,
} from './surfaces.js';

export const TEAM_T = 1;
export const TEAM_CT = 2;

export class Player {
  constructor() {
    this.ps = createPlayerState();
    this.ws = createWeaponState();
    this.psBytes = new Uint8Array(this.ps.buf); // raw views for the wire
    this.wsBytes = new Uint8Array(this.ws.f.buffer);
    this.health = 100;
    this.armor = 0;
    this.helmet = false;
    this.team = TEAM_T;
    this.spawnCount = 0; // bumps on every respawn, so clients notice a teleport
    this.primary = 0; // loadout weapon ids (0 = team default)
    this.secondary = 0;
  }
}

// Resets a player to a fresh life at a spawn point with the round loadout.
export function spawnPlayer(p, x, y, z) {
  copyPlayerState(p.ps, createPlayerState());
  p.ps.f[PS_ORIGIN] = x;
  p.ps.f[PS_ORIGIN + 1] = y;
  p.ps.f[PS_ORIGIN + 2] = z;
  copyWeaponState(p.ws, createWeaponState());
  const ct = p.team === TEAM_CT;
  giveWeapon(p.ws, WEAPON_ID.knife);
  giveWeapon(p.ws, p.secondary || (ct ? WEAPON_ID.usp_silencer : WEAPON_ID.glock));
  giveWeapon(p.ws, p.primary || (ct ? WEAPON_ID.m4a1 : WEAPON_ID.ak47));
  p.ws.f[WS_ACTIVE] = SLOT_PRIMARY;
  p.health = 100;
  p.armor = 0; // a new life starts without armor (round restarts keep it: see the round code)
  p.helmet = false;
  p.spawnCount = (p.spawnCount + 1) & 255;
}

// Runs one user command. Returns true if the player died (fall damage).
export function runCommand(world, p, buttons, select, pitch, yaw, tick, shots) {
  const w = activeWeapon(p.ws);
  playerMove(world, p.ps, buttons, pitch, yaw, TICK_DT, w ? w.maxSpeed : 250);
  if (p.ps.i[PS_EVENTS] & EV_LAND) p.health -= Math.round(fallDamage(p.ps.f[PS_LAND_SPEED]));
  weaponTick(p.ws, p.ps, buttons, select, pitch, yaw, tick, shots);
  return p.health <= 0;
}

// CS:GO OnTakeDamage for a bullet hit: armor (kevlar; the head only with a helmet,
// never the legs) takes part of the damage according to the weapon's armor ratio,
// then the hit tags the victim: their speed is capped by the weapon's flinch
// modifier (smaller slowdown when armor took the hit). Returns the health lost.
const ARMOR_BONUS = 0.5;
export function applyDamage(p, damage, weapon, group) {
  const armored = p.armor > 0 && group !== HITGROUP_LEGS && (group !== HITGROUP_HEAD || p.helmet);
  if (armored) {
    let toHealth = damage * weapon.armorRatio * 0.5;
    let toArmor = (damage - toHealth) * ARMOR_BONUS;
    if (toArmor > p.armor) { // not enough armor left to absorb all of it
      toHealth = damage - p.armor / ARMOR_BONUS;
      p.armor = 0;
    } else {
      if (toArmor < 0) toArmor = 1;
      p.armor = Math.trunc(p.armor - toArmor);
    }
    if (p.armor <= 0) p.helmet = false;
    damage = toHealth;
  }
  const lost = Math.trunc(damage); // CS:GO truncates
  p.health -= lost;
  const flinch = armored ? weapon.flinchSmall : weapon.flinchLarge;
  if (flinch > 0 && flinch < p.ps.f[PS_VELMOD]) p.ps.f[PS_VELMOD] = flinch;
  return lost;
}

// Where shots landed this tick (preallocated, reused).
export class ImpactList {
  constructor(capacity = 96) {
    this.capacity = capacity;
    this.count = 0;
    this.pos = new Float64Array(capacity * 3);
    this.normal = new Float64Array(capacity * 3);
    this.owner = new Uint8Array(capacity); // breakable slot hit (0 = static world)
    this.broke = new Uint8Array(capacity); // breakable slot this hit broke, else 0
    this.player = new Int8Array(capacity); // player hit (-1 = none: world impact)
    this.group = new Uint8Array(capacity); // hit group when a player was hit
    this.damage = new Float32Array(capacity); // damage to that player (before armor)
  }

  push(x, y, z, nx, ny, nz, owner, broke, player, group, damage) {
    if (this.count === this.capacity) return;
    const k = this.count++;
    this.pos[k * 3] = x;
    this.pos[k * 3 + 1] = y;
    this.pos[k * 3 + 2] = z;
    this.normal[k * 3] = nx;
    this.normal[k * 3 + 1] = ny;
    this.normal[k * 3 + 2] = nz;
    this.owner[k] = owner;
    this.broke[k] = broke;
    this.player[k] = player;
    this.group[k] = group;
    this.damage[k] = damage;
  }
}

// CS:GO bullet penetration (HandleBulletPenetration): damage lost going through
// `thickness` units between an entry and an exit surface ([penetration modifier,
// game material] pairs).
const PENETRATION_MAX_DISTANCE = 3000; // no penetration after this far
const PENETRATION_COUNT = 4; // possible hits remaining
const EXIT_SEARCH = 90; // TraceToExit: how far to look for the far side of a wall
const BODY_THICKNESS = 12; // a player's flesh, for collaterals

export function penetrationLoss(damage, power, enter, exit, thickness) {
  let finalMod = 0.16, combined;
  if (enter[1] === GM_GLASS || enter[1] === GM_GRATE) {
    combined = 3;
    finalMod = 0.05;
  } else {
    combined = (enter[0] + exit[0]) * 0.5;
  }
  if (enter[1] === exit[1]) {
    if (exit[1] === GM_WOOD || exit[1] === GM_CARDBOARD) combined = 3;
    else if (exit[1] === GM_PLASTIC) combined = 2;
  }
  const penMod = Math.max(0, 1 / combined);
  const weaponLoss = damage * finalMod + Math.max(0, (3 / power) * 1.25) * (penMod * 3);
  return Math.max(0, weaponLoss + penMod * thickness * thickness / 24);
}

const shotTrace = new Trace();
const exitTrace = new Trace();

// Surface of collision entity `ent` at a point: breakables by their material, the
// rest by texture (when the world has a SurfaceMap).
function surfaceOf(world, breakables, ent, x, y, z, dx, dy, dz) {
  const slot = ent > 0 ? breakables.slotOfEnt[ent] : 0;
  if (slot) return breakableSurface(breakables.material[slot]);
  return world.surfaces ? world.surfaces.surfaceAt(world, ent, x, y, z, dx, dy, dz) : SURF_DEFAULT;
}

// Traces a tick's shots like CS:GO's FireBullet: through the world, breakables and
// the players in `targets` (a HitTargets; the shooter `selfId` and teammates of
// `selfTeam` are skipped), penetrating up to PENETRATION_COUNT times while damage
// falls off with distance and with each penetration. Breakables take their damage
// here; player hits only record theirs, which the caller applies (the server) or
// ignores (client prediction). Every entry and exit point lands in `impacts`.
export function resolveShots(world, breakables, ws, shots, impacts, targets = null, selfId = -1, selfTeam = 0) {
  impacts.count = 0;
  const w = activeWeapon(ws);
  for (let i = 0; i < shots.count; i++) {
    const dx = shots.dir[i * 3], dy = shots.dir[i * 3 + 1], dz = shots.dir[i * 3 + 2];
    const range = shots.range[i];
    let x = shots.origin[i * 3], y = shots.origin[i * 3 + 1], z = shots.origin[i * 3 + 2];
    let damage = shots.damage[i];
    let traveled = 0;
    let pens = w.melee ? 0 : PENETRATION_COUNT;
    let exclude = 0; // players this bullet already went through

    while (range - traveled > 1) {
      const remaining = range - traveled;
      const t = traceHull(world, HULL_POINT, x, y, z, x + dx * remaining, y + dy * remaining, z + dz * remaining,
        shotTrace);
      if (t.startsolid) break;
      const seg = remaining * t.fraction;
      const hit = targets ? targets.trace(x, y, z, dx, dy, dz, seg, selfId, selfTeam, exclude) : -1;

      if (hit >= 0) {
        const d = targets.dist;
        traveled += d;
        if (!w.melee) damage *= Math.pow(w.rangeModifier, traveled / 500);
        const hx = x + dx * d, hy = y + dy * d, hz = z + dz * d;
        impacts.push(hx, hy, hz, -dx, -dy, -dz, 0, 0, hit, targets.group,
          damage * (w.melee ? 1 : hitgroupScale(targets.group, w)));
        exclude |= 1 << hit;
        if (pens <= 0 || traveled > PENETRATION_MAX_DISTANCE) break;
        damage -= penetrationLoss(damage, w.penetration, SURF_FLESH, SURF_FLESH, BODY_THICKNESS);
        if (damage < 1) break;
        x = hx + dx * BODY_THICKNESS;
        y = hy + dy * BODY_THICKNESS;
        z = hz + dz * BODY_THICKNESS;
        traveled += BODY_THICKNESS;
        pens--;
        continue;
      }
      if (t.fraction >= 1) break;

      traveled += seg;
      if (!w.melee) damage *= Math.pow(w.rangeModifier, traveled / 500);
      const ent = t.ent;
      const hx = t.endx, hy = t.endy, hz = t.endz;
      const slot = ent > 0 ? breakables.slotOfEnt[ent] : 0;
      const enter = surfaceOf(world, breakables, ent, hx, hy, hz, dx, dy, dz);
      const broke = breakables.damage(world, ent, damage, w.melee);
      impacts.push(hx, hy, hz, t.nx, t.ny, t.nz, slot, broke, -1, 0, 0);
      if (broke) { // shattered: the bullet flies on through the hole
        x = hx + dx;
        y = hy + dy;
        z = hz + dz;
        traveled += 1;
        continue;
      }
      if (pens <= 0 || traveled > PENETRATION_MAX_DISTANCE || enter[0] < 0.1) break;

      // TraceToExit: step into the wall until we are out, then trace back to the far face.
      let found = false;
      for (let s = 4; s <= EXIT_SEARCH; s += 4) {
        const px = hx + dx * s, py = hy + dy * s, pz = hz + dz * s;
        if (!hullFits(world, HULL_POINT, px, py, pz)) continue;
        traceHull(world, HULL_POINT, px, py, pz, hx, hy, hz, exitTrace);
        if (exitTrace.fraction < 1 && !exitTrace.startsolid) found = true;
        break;
      }
      if (!found) break;
      const ex = exitTrace.endx, ey = exitTrace.endy, ez = exitTrace.endz;
      const exit = surfaceOf(world, breakables, exitTrace.ent, ex, ey, ez, -dx, -dy, -dz);
      const thickness = Math.hypot(ex - hx, ey - hy, ez - hz);
      damage -= penetrationLoss(damage, w.penetration, enter, exit, thickness);
      if (damage < 1) break;
      const exitSlot = exitTrace.ent > 0 ? breakables.slotOfEnt[exitTrace.ent] : 0;
      impacts.push(ex, ey, ez, exitTrace.nx, exitTrace.ny, exitTrace.nz, exitSlot, 0, -1, 0, 0);
      x = ex;
      y = ey;
      z = ez;
      traveled += thickness;
      pens--;
    }
  }
}
