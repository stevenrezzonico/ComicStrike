// One player's simulation, run identically by the client (prediction) and the server
// (authority): a user command moves the player, applies fall damage and runs the
// weapon; shots are then traced against the world and its breakables.

import { TICK_DT } from './constants.js';
import {
  createPlayerState, copyPlayerState, playerMove, fallDamage, PS_ORIGIN, PS_EVENTS, PS_LAND_SPEED, EV_LAND,
} from './pmove.js';
import {
  createWeaponState, copyWeaponState, giveWeapon, weaponTick, activeWeapon, damageAtRange, WEAPON_ID, SLOT_PRIMARY,
  WS_ACTIVE,
} from './weapons.js';
import { Trace, traceHull, HULL_POINT } from './trace.js';
import { hitgroupScale } from './hitgroups.js';

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

// Where shots landed this tick (preallocated, reused).
export class ImpactList {
  constructor(capacity = 16) {
    this.count = 0;
    this.pos = new Float64Array(capacity * 3);
    this.normal = new Float64Array(capacity * 3);
    this.owner = new Uint8Array(capacity); // breakable slot hit (0 = static world)
    this.broke = new Uint8Array(capacity); // breakable slot this hit broke, else 0
    this.player = new Int8Array(capacity); // player hit (-1 = none: world impact)
    this.group = new Uint8Array(capacity); // hit group when a player was hit
    this.damage = new Float32Array(capacity); // damage to that player (before armor)
  }
}

const shotTrace = new Trace();

// Traces a tick's shots against the world and, if given, the players in `targets`
// (a HitTargets; the shooter `selfId` and teammates of `selfTeam` are skipped).
// World hits damage breakables; player hits only record the damage, which the caller
// applies (the server) or ignores (client prediction). Fills `impacts`.
export function resolveShots(world, breakables, ws, shots, impacts, targets = null, selfId = -1, selfTeam = 0) {
  impacts.count = 0;
  const w = activeWeapon(ws);
  for (let i = 0; i < shots.count; i++) {
    const ox = shots.origin[i * 3], oy = shots.origin[i * 3 + 1], oz = shots.origin[i * 3 + 2];
    const dx = shots.dir[i * 3], dy = shots.dir[i * 3 + 1], dz = shots.dir[i * 3 + 2];
    const r = shots.range[i];
    const t = traceHull(world, HULL_POINT, ox, oy, oz, ox + dx * r, oy + dy * r, oz + dz * r, shotTrace);
    if (t.startsolid) continue;
    const worldDist = r * t.fraction;
    const hit = targets ? targets.trace(ox, oy, oz, dx, dy, dz, worldDist, selfId, selfTeam) : -1;
    if (hit >= 0) {
      const k = impacts.count++;
      const d = targets.dist;
      impacts.pos[k * 3] = ox + dx * d;
      impacts.pos[k * 3 + 1] = oy + dy * d;
      impacts.pos[k * 3 + 2] = oz + dz * d;
      impacts.normal[k * 3] = -dx;
      impacts.normal[k * 3 + 1] = -dy;
      impacts.normal[k * 3 + 2] = -dz;
      impacts.owner[k] = 0;
      impacts.broke[k] = 0;
      impacts.player[k] = hit;
      impacts.group[k] = targets.group;
      impacts.damage[k] = damageAtRange(w, shots.damage[i], d) * (w.melee ? 1 : hitgroupScale(targets.group, w));
      continue;
    }
    if (t.fraction >= 1) continue;
    const k = impacts.count++;
    impacts.player[k] = -1;
    impacts.pos[k * 3] = t.endx;
    impacts.pos[k * 3 + 1] = t.endy;
    impacts.pos[k * 3 + 2] = t.endz;
    impacts.normal[k * 3] = t.nx;
    impacts.normal[k * 3 + 1] = t.ny;
    impacts.normal[k * 3 + 2] = t.nz;
    impacts.owner[k] = t.ent > 0 ? breakables.slotOfEnt[t.ent] : 0;
    impacts.broke[k] = breakables.damage(world, t.ent, damageAtRange(w, shots.damage[i], r * t.fraction), w.melee);
  }
}
