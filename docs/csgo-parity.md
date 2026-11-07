# CS:GO parity audit

A read of `shared/` against CS:GO's rules (convars, `items_game.txt`, the SDK's game movement and weapon code, community measurements). Rows marked *unsure* give a reference value from memory, not from a source at hand. Fixed rows name the commit that closed them.

## Fixed in this audit

| Rule | Was | CS:GO | Now |
|---|---|---|---|
| Jump speed clamp (`sv_enablebunnyhopping 0`, PreventBunnyJumping) | none: a strafe-jumper kept building speed | horizontal speed scaled down to 1.1 × max speed as the jump starts | `checkJump` in `shared/pmove.js` |
| Landing stamina cost | 0.02 per unit of landing speed | `sv_staminalandcost` 0.05 | 0.05 |
| Knife backstab | none | swing 40 → 90, stab 65 → 180 when the victim faces away (dot of his view and the line of sight over 0.475) | `resolveShots` in `shared/player.js`, `backstab` / `backstab2` on the knife |
| Hostage first touch | $300 | `cash_player_interact_with_hostage` 150 | $150 |
| Overtime | none: a 15-15 match restarted | MR3 periods, $10000 each half, first to 4 of a period, 3-3 plays another | `startOvertime` in `server/game.js`, `mp_overtime_*` |

## Fixed in the 2026-11-07 pass

| Rule | Was | CS:GO | Now |
|---|---|---|---|
| Friendly fire | always off | competitive and wingman: `mp_friendlyfire 1`, bullets 0.33, grenades 0.85, own grenade 1, other 0.4 | the same cvars and shares (`hurtBy`, `applyImpacts`); bots hold fire past a teammate |
| Death drops | the gun only | also the grenade in hand or the best (`mp_death_drop_grenade 2`) and the kit (`mp_death_drop_defuser 1`) | the same; the best grenade by price is *unsure* |
| Assists | none | over 40 damage to a victim a teammate kills, else a flash assist; K / A / D | the same, per life of the victim |
| Team limits | `mp_teamsize_max` only | `mp_limitteams 2`, `mp_autoteambalance 1` | the same; who is moved (newest bot, else the last to join the team) is approx. |
| Kill feed | headshots | wallbang mark, the assister | WB, `killer + assister` (FLASH for a flash assist) |
| Target id | none | the player under the crosshair named (`hud_showtargetid`) | the same; an enemy only in plain sight |
| Team id over heads | none | marks over teammates, through walls | a triangle in the team's color (`cl_teamid_overhead`) |
| Alive players on the top bar | none | an avatar per player, the dead greyed | pips beside the scores |
| `autobuy`, `rebuy` | none | F3 / F4 | the same keys; `cl_autobuy`'s list (CS 1.6's) |

CS 1.6 map entities the game ignored, from a scan of the 48 maps here: `trigger_hurt`, `env_explosion`, `game_text` (and `game_playerspawn`), `player_weaponstrip`, `game_player_equip`, `info_map_parameters`' `buying`, `trigger_teleport` (predicted). See CLAUDE.md, Doors and Collision.

## Matches (checked)

Movement: gravity 800, friction 5.2, stopspeed 80, accelerate 5.5 (scaled by max(250, wishspeed)), airaccelerate 12, air wishspeed cap 30, jump impulse 301.993 (57 units, crouch-jump 66), stamina max 80 / jump cost 0.08 / recovery 60, must release jump to jump again, walk 0.52, duck 0.34, step 18, ladder 200, max velocity 3500, per-weapon speeds from the game data (knife and C4 250, scoped AWP 100), fall damage `(v − 580) × 100 / (1024 − 580)` ignoring armor.

Weapons: knife 40 / 65, rates 0.4 / 1.0, armor ratio 1.7 (34 armored), ignores hit groups; head × weapon multiplier, stomach 1.25, legs 0.75 unarmored; the armor split (ratio 0.5, bonus 0.5, integer armor, helmet lost at 0); damage truncated; range falloff `rangeModifier ^ (dist / 500)`; 4 penetrations, 3000 units, 90-unit exit search, CS:GO's loss formula, 12 units of flesh per body; kill awards from the data; switching cancels a reload, firing does not (shotguns stop loading); nothing fires before the deploy ends; AWP scope levels and resume-zoom; tick-quantized fire rates; survivors' ammo refilled at round start (CS:GO refills too).

Rounds and money: freeze 15, round 1:55, buy 20 s after the freeze (CS:GO's round clock starts when the freeze ends; the freeze itself is always buyable), restart 7, 30 rounds, swap after 15, c4 40 s, defuse 10 / 5, kit 400, kevlar 650, helmet 350, start 800, cap 16000, win 3250 / 3500, planter and defuser +300, Ts +800 after a lost plant, loss bonus 1400..3400 with the 2019 decrement, Ts alive at the time-out get nothing, teamkill −300, halftime resets money and streaks, default pistols, survivors keep gear.

Grenades and bomb: prices, limits (1, flashbang 2, 4 in all), throw speed formula, gravity 320 and bounce 0.45, HE 99 / 350 / 1.5 s, smoke 18 s / 144, molotov 7 s at 40/s, bomb damage = radius with the gaussian to 3.5 × radius.

## Known differences left as they are

| Rule | Ours | CS:GO | Why |
|---|---|---|---|
| Crouched hit boxes and hull | 36 units tall (GoldSrc duck hull), head box top 34.5 | 54-unit duck hull, head near 46-54 | the BSP clip hulls fix the ducked hull; a taller one would clip the maps' low passages |
| Crouched eye height | 30 | 46 | same reason |
| Crouch boost (a player on a crouching one) | 36 up, 72 on a standing one | 54 / 72 | same reason; run boosts and standing boosts match |
| Stamina slow-down | velocity × ((100 − s) / 100) ^ (dt × 70) per tick | wish speed × (100 − s) / 100 | close by feel; *unsure* which quantity CS:GO scales |
| Duck spam penalty | −2 per press, min 1.5, +3/s | `sv_timebetweenducks` 0.4 and CS:GO's own penalty | close |
| Tagging recovery | +0.4 of the modifier per second | *unsure* | approximation |
| Flash blind curve | own curve to 4.87 s by facing and distance | CS:GO's by angle | close |
| Plant time | 3.0 s | 3.0 s (some sources 3.2 with the animation) | *unsure* |
| Defuse reach | eye to bomb 90 units, cone 0.8 | +use reach ~62 | approximation |
| Hostage hit / kill money | −30 / −1000 | −30 / −1000 | *unsure* |
| Suicide | no kill change | −1 kill | *unsure* |

## Weapon leftovers (Phase 14i)

| Rule | Was | CS:GO | Now |
|---|---|---|---|
| Negev spray tightening | listed as not modeled | `recovery time stand` 0.3 s falling to `recovery time stand final` 0.1 s over bullets 9-12: a wild start, then a laser | already in the data and the accuracy model: ~51 mrad through shot 10, ~19 from shot 14 on (the AK's steady ~19); recoil angle 0 with no variance, straight up; pinned in `test/weapons.test.js` |
| Shotgun pellet patterns | every pellet's spread offset random per shot | `weapon_accuracy_shotgun_spread_patterns` 1: the spread offsets come from a random stream seeded with the gun's `spread seed` at each shot, so each shotgun fires one fixed pattern; the inaccuracy offsets stay random | the same, from the bit-exact `UniformRandomStream` (angle, then radius per pellet); the order of the draws is *unsure* |
| Camera jolt per shot | none: the camera showed 45 % of the aim punch only | `weapon_recoil_view_punch_extra` 0.055 of the shot's kick as a view punch, decaying at `view_punch_decay` 18 | the same, client side only (`shotKick`, `viewKick` in main); the decay's shape (exponential here) is an approximation |
