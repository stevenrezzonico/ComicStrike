# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end
panel and damage report (14m), sun shadows for players (14n), gun looks, comic jingles,
the demo's practice tools, demo recording, the hurt indicator and the killer's health, characters culled by the PVS, bots' smokes and molotovs, tracers and casings, visibility for our own maps (opt-in: cs_polaris and editor exports), radio and pings, Retakes, hatching in corners, comic skies, map load time (the radar's overview off the page's thread), the 2026-11-04 audit's findings (left as they are: duplicated one-line vector helpers and `el` across modules, the two IndexedDB openers, and test-only `buildDefuser`, `buildAllGuns` and the mannequin), the 2026-11-05 audit's 20 findings (its smaller ones below).

## Consistent frame times (Phase 15; the measuring is done)

The goal: the 1 % low near the average on every machine, no caps, the quality the GPU can give. See CLAUDE.md, Performance, Consistent frame times, for the numbers and the method.

1. **Garbage, what is left** (CLAUDE.md, Performance, Consistent frame times, The garbage, Phase 15b and 15c). ~1.4 KB a frame on the laptop at 57 fps in a quiet scene. Per tick (~35 KB/s, whatever the frame rate): the practice worker's message (~6 objects: the event, the buffer, its view; a SharedArrayBuffer ring would need cross-origin isolation, COOP and COEP headers), `trace()` in pmove is not inlined and boxes its six doubles at each of its ~8 call sites (callers writing the array themselves), `tryPlayerMove`'s loop-carried velocity and `clipVelocity`'s seven arguments. Per frame: `frame` (~5 objects: `dynres.frame`'s gap, `pollPads`' elapsed, maybe more), `draw` (~6: `fx.update`'s time, `perspective`'s fov, `weaponView.draw`'s sim time), the radar's redraw (~6 at 30 a second: `setTransform` and the arcs of the frame), `renderer.render` / `setWorldUniforms` (5: `uniform1f` with a double: `uniform1fv` from a Float32Array), `viewanim` / `viewmodel` (5). Rarely-run paths in baseline code while they run (the balloons' `toScreen`, ~20 a frame while one shows). First-session deoptimizations: `step` once at the first freeze end (the flight phase's `this.phase`, though `primeAnimator` reaches it), `reloadPose` at the first reload of a kind priming missed, `draw` at the first plant: ~0.5-5 s of baseline code each, once a page.
2. **DOM writes, the rest.** The comic words (`#fx`, 10 a second in a fight: 4 style writes and a text each; cheap recalculations, elementCount 0, but a frame each), the kill feed's `innerHTML`, `cl_showfps` / `net_graph` 4/s each when on. `contain: layout style paint` on the HUD's boxes if a trace shows a recalculation reaching past them. The scoreboard: a version counter instead of `JSON.stringify` while Tab is held. (Done: `--roundbar-w` off `body`, the hurt arcs' fade as a compositor animation.)
3. **The radar as two layers.** The level image on a canvas the compositor turns and moves by a CSS transform; a small overlay canvas for the dots, redrawn only when one moved a pixel (0.3 ms a redraw, 30 a second, now).
4. **The tick's parts.** Measure poll and decode, interpolate, buildTargets, prediction, sendCmds, the sounds; a tick frame should stay under 1.3× a plain one.

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
