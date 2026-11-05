# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end
panel and damage report (14m), sun shadows for players (14n), gun looks, comic jingles,
the demo's practice tools, demo recording, the hurt indicator and the killer's health, characters culled by the PVS, bots' smokes and molotovs, tracers and casings, visibility for our own maps (opt-in: cs_polaris and editor exports), radio and pings, Retakes, comic skies, map load time (the radar's overview off the page's thread), the 2026-11-04 audit's findings (left as they are: duplicated one-line vector helpers and `el` across modules, the two IndexedDB openers, and test-only `buildDefuser`, `buildAllGuns` and the mannequin), the 2026-11-05 audit's 20 findings (its smaller ones below).

## Consistent frame times (Phase 15; the measuring is done)

The goal: the 1 % low near the average on every machine, no caps, the quality the GPU can give. See CLAUDE.md, Performance, Consistent frame times, for the numbers and the method.

1. **Garbage, what is left** (CLAUDE.md, Performance, Consistent frame times, The garbage, Phase 15b and 15c). ~1.4 KB a frame on the laptop at 57 fps in a quiet scene. Per tick (~35 KB/s, whatever the frame rate): the practice worker's message (~6 objects: the event, the buffer, its view; a SharedArrayBuffer ring would need cross-origin isolation, COOP and COEP headers), `trace()` in pmove is not inlined and boxes its six doubles at each of its ~8 call sites (callers writing the array themselves), `tryPlayerMove`'s loop-carried velocity and `clipVelocity`'s seven arguments. Per frame: `frame` (~5 objects: `dynres.frame`'s gap, `pollPads`' elapsed, maybe more), `draw` (~6: `fx.update`'s time, `perspective`'s fov, `weaponView.draw`'s sim time), the radar's redraw (~6 at 30 a second: `setTransform` and the arcs of the frame), `renderer.render` / `setWorldUniforms` (5: `uniform1f` with a double: `uniform1fv` from a Float32Array), `viewanim` / `viewmodel` (5). Rarely-run paths in baseline code while they run (the balloons' `toScreen`, ~20 a frame while one shows). First-session deoptimizations: `step` once at the first freeze end (the flight phase's `this.phase`, though `primeAnimator` reaches it), `reloadPose` at the first reload of a kind priming missed, `draw` at the first plant: ~0.5-5 s of baseline code each, once a page.
2. **DOM writes, the rest** (done: `--roundbar-w` off `body`, the hurt arcs and the comic words as Web Animations, `#fx` contained). The kill feed builds a row with `innerHTML` per kill (rare); the gunfire line (`.pop.ticker`) writes its text each shot and four properties each new line; `cl_showfps` / `net_graph` 4/s each when on; the scoreboard's `JSON.stringify` while Tab is held. Check on a GPU-composited PC (this laptop's Edge composites no animation, see CLAUDE.md, Phase 15d) before going further.
3. **The radar.** A redraw is 0.11-0.26 ms, 30 a second (3 % of the frames at 1000 fps): `drawImage` of the level a quarter, the clip a tenth. Two layers (the level on a canvas the compositor turns by a CSS transform, the dots on an overlay) trade the `drawImage` for a style write per redraw (~0.05 ms here): not clearly better. Cheaper: the dark disc, the clip and the rims as CSS on the canvas element (`border-radius`, background, `outline` over the content), the markers alone drawn; or the radar drawn in WebGL with the frame.
4. **The tick** (measured, see CLAUDE.md, Phase 15d; done: practice over shared memory, 0.31 → 0.19 ms a tick). Left: online play's `writer.write` per tick (unmeasured), the prediction's `runCommand` (~0.05 ms) and the snapshot decode in `poll`.

## Water: a softer splash and Half-Life / CS 1.6 underwater (planned 2026-11-05)

Swimming exists (`shared/pmove.js` `checkWater`, `waterMove`), with splash and wade
footsteps and a landing splash; nothing else of being in water. The HL behavior below is from
memory of the HL SDK (`pm_shared.c`, `player.cpp`), not from a copy: check before relying on
exact numbers. One commit a phase, each with `deno task test`, `deno lint` and a browser check.

1. **The splash** (`client/audio.js` `splash`, `land`): landing in shallow water is too sharp
   (noise through a 1500 Hz band-pass with a 20 ms attack). A low-pass sweeping ~900 → 200 Hz
   swelling in over ~35 ms, a "whoomp" falling 160 → 60 Hz on a landing, a tail of 4-6 low
   bubbles (rising chirps 250-450 Hz) over ~0.4 s; the footstep splashes share it and stay
   quiet. Measured by rendering it offline in the browser (centroid and rise time before and
   after; Deno has no WebAudio).
2. **Movement** (`shared/pmove.js`, predicted, bit-exact): jump speed by liquid (water 100,
   slime 80, lava 50; `checkWater` keeps the contents); `PM_CheckWaterJump` / `PM_WaterJump`:
   at waterlevel 2, moving toward (or still against) a near-vertical wall within 24 units at
   the origin + 8, clear at the hull's top: vz 225 and 50 u/s into the wall (`-50 × normal`)
   until out of the water, on a new `FL_WATERJUMP` flag bit (no new state field, no wire
   change; HL's 2 s timer never matters at 225 u/s; it ends on leaving the water or vz ≤ 0).
   Tests in `test/pmove.test.js`.
3. **Drowning, slime and lava** (`server/game.js`, each tick for living players from
   `PS_WATERLEVEL`): 12 s of air (`AIRTIME`) with the eye under, then damage once a second
   3, 4, 5, 5, ... through armor (DMG_DROWN), tallied; on surfacing up to 10 back every 2 s
   until all is restored; slime 4 × and lava 10 × the water level a second (approx. of HL's
   timing); a death is the player's own (weapon 0, like a fall); reset at spawn; the demo
   mode's humans still cannot die; none in noclip. New `test/water.test.js` on the
   playground's deep end.
4. **The view and hearing under water** (`client/main.js`, `client/gl/renderer.js`,
   `COMPOSITE_FS`, `client/audio.js`), from `pointContents` at the eye once a frame: the
   smoke's fog (`u_smoke`, `SMOKE_TONE`, `SMOKE_SIGHT`) becomes a medium's fog with a tone
   and a sight: grey / 28 for smoke; water in the map's water color (its first `!` texture as
   the world prints it, else a murky teal) with an e-fold of ~160 units, slime green, lava
   orange; the first-person view tinted ~25 %. GoldSrc's underwater field-of-view wobble (as
   Xash3D reproduces it: x × (0.97 + 0.03 sin 1.5t), y × (1.03 − 0.03 sin 1.5t), on
   `proj[0]` / `proj[5]`). Muffled hearing (HL's `waterroom_type`): the bus low-pass at
   ~600 Hz while under, the flashbang's muffle ramping back to it, not to 20 kHz.
5. **Water sounds** (`client/soundscape.js`): a splash on entering or leaving water (HL's
   `PM_PlayWaterSounds`; ours from `PS_WATERLEVEL` 0 ↔ ≥ 1, others' from the contents at
   their feet: falling into deep water is silent now), a stroke every second while jump is
   held in water (own), bubbles at random more often as the 12 s run out (own, the client's
   own timer), a gasp on surfacing after over 3 s under (own).
6. **Swim poses** (`client/anim/playeranim.js`): a player chest deep (the client's contents
   at the chest) treads water (upright, slow scissor kicks, a little bob) and leans forward up
   to ~60° when moving (CS's `treadwater` / `swim`); run through by `primeAnimator`; tests in
   `test/playeranim.test.js`.
7. **Grenades** (`shared/grenades.js`): in water the velocity halves every 0.1 s
   (`CGrenade::TumbleThink`), so they sink; a molotov landing in water fizzles (CS:GO's).
   Tests in `test/grenades.test.js`.
8. **The playground's deep end** (`tools/gen_demomap.js`, `maps/de_playground.bsp`
   regenerated): a diving well at the pool's east end (~x 120..300, y 520..700, bottom
   at -192, 190 deep), walls and a bottom of its own under the 64-unit floor slab, a ramp
   down from the knee-deep part and a ladder up its north wall. `test/playground.test.js`:
   the depth checks moved off the well; the eye under water there, swimming up, the water
   jump out at the edge, the ladder out, a bot path in and out.
9. **Docs**: CLAUDE.md (Movement, Sounds, Test map, the fog), this list.

Risks: the water jump must stay bit-exact (`test/server.test.js`); bots know nothing of
swimming and one stuck on the well's bottom over 12 s drowns (the ramp and ladder make it
unlikely; else deep water as a costly nav edge); the wobble may be queasy (subtle, a cvar if
asked); the water's fog color is approximate (GoldSrc takes it from the `!` texture's
palette). Left out: HL's drowning HUD icon, the view nudge at the surface (`waterOffset`),
others' bubbles, strokes and gasps, bullets splashing on water (none in CS 1.6), waves
(`WaveHeight`). Shooting under water stays allowed (CS 1.6).

## Audit leftovers (2026-11-05)

The smaller findings of the second audit, each checked in code:

- A decoy at rest sends the CT bot that hears it nowhere: `hearDecoy` passes the effect's
  floor height where `heard` wants a hull center (`gr.fxPos[o + 2] + 36`), and the test puts
  the decoy at hull height.
- Phantom gunshots, muzzle lights, casings and tracers on the first frame of a new map:
  `resetSession` keeps `scape.shots` (and `hurtSerial`, `spectator.synced`).
- A lost WebGL context leaves a frozen screen with no word (`webglcontextlost`).
- A map's explosion set off by a player hurts his teammates and counts a teamkill (`hurtBy`).
- `Renderer.loadMap` deletes the old VAO only, not its buffers and lightmap texture (the
  editor's 3D view rebuilds the map on every edit).
- Chat lines go after 12 s by a timer even while typing a reply holds their fade.
- Radio orders outlive the player who gave them (`Bot.order` after a disconnect or a team
  switch, and across a respawn).
- A bot leaves its first hold spot the tick after arriving (`holdTicks` starts at 0).
- `readProject` keeps points with two coordinates: a lamp so placed opens the map to the void.

## Server QoL (first list, item 9; on hold)

- `callvote kick|changelevel|restartgame` with CS:GO's vote cvars (`sv_vote_timer_duration`
  15, quorum 0.6, `sv_vote_creation_timer` 150, `sv_vote_failure_timer` 300,
  `sv_vote_issue_*_allowed`, `sv_vote_kick_ban_duration` 15 min); `S2C_VOTE` (a protocol
  bump); a client `#vote` panel with F1 / F2 binds.
- `sv_password`: sent in HELLO, a field in the Play panel, a client cvar `password`.
- `GET /rooms.json` listing public rooms, with a public checkbox on the upload.
