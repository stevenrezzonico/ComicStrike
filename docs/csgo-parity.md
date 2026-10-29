# CS:GO parity audit

A read of `shared/` against CS:GO's rules (convars, `items_game.txt`, the SDK's game movement and weapon code, community measurements). Rows marked *unsure* give a reference value from memory, not from a source at hand. Fixed rows name the commit that closed them.

## Fixed in this audit

| Rule | Was | CS:GO | Now |
|---|---|---|---|
| Jump speed clamp (`sv_enablebunnyhopping 0`, PreventBunnyJumping) | none: a strafe-jumper kept building speed | horizontal speed scaled down to 1.1 × max speed as the jump starts | `checkJump` in `shared/pmove.js` |
| Landing stamina cost | 0.02 per unit of landing speed | `sv_staminalandcost` 0.05 | 0.05 |
| Knife backstab | none | swing 40 → 90, stab 65 → 180 when the victim faces away (dot of his view and the line of sight over 0.475) | `resolveShots` in `shared/player.js`, `backstab` / `backstab2` on the knife |
| Hostage first touch | $300 | `cash_player_interact_with_hostage` 150 | $150 |

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
| Stamina slow-down | velocity × ((100 − s) / 100) ^ (dt × 70) per tick | wish speed × (100 − s) / 100 | close by feel; *unsure* which quantity CS:GO scales |
| Duck spam penalty | −2 per press, min 1.5, +3/s | `sv_timebetweenducks` 0.4 and CS:GO's own penalty | close |
| Tagging recovery | +0.4 of the modifier per second | *unsure* | approximation |
| Flash blind curve | own curve to 4.87 s by facing and distance | CS:GO's by angle | close |
| Plant time | 3.0 s | 3.0 s (some sources 3.2 with the animation) | *unsure* |
| Defuse reach | eye to bomb 90 units, cone 0.8 | +use reach ~62 | approximation |
| Hostage hit / kill money | −30 / −1000 | −30 / −1000 | *unsure* |
| Overtime | none: a 15-15 match restarts | MR3 overtime, $10000 | not built yet |
| Suicide | no kill change | −1 kill | *unsure* |
