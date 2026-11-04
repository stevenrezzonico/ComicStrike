# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end
panel and damage report (14m), sun shadows for players (14n), gun looks, comic jingles,
the demo's practice tools, demo recording.

## Server QoL (first list, item 9; on hold)

- `callvote kick|changelevel|restartgame` with CS:GO's vote cvars (`sv_vote_timer_duration`
  15, quorum 0.6, `sv_vote_creation_timer` 150, `sv_vote_failure_timer` 300,
  `sv_vote_issue_*_allowed`, `sv_vote_kick_ban_duration` 15 min); `S2C_VOTE` (a protocol
  bump); a client `#vote` panel with F1 / F2 binds.
- `sv_password`: sent in HELLO, a field in the Play panel, a client cvar `password`.
- `GET /rooms.json` listing public rooms, with a public checkbox on the upload.

## Second list (proposed 2026-11-04, in the order to build)

1. **Damage direction and the killer's health.** CS:GO's red arcs round the crosshair
   pointing at where damage came from (a shooter's eye, an HE or fire, a map explosion, the
   bomb; no arc for a crush or a fall), at full strength 0.4 s and gone by 1.5 s, turning
   with the view; a spray from one place renews its arc. The server notes the place where
   damage is applied (`server/game.js`: the bullet loop, `grenadeHurt` with the grenade's
   place from `shared/grenades.js` `targets.hurt`, `hurtBy` for `blast`, `explodeBomb`); the
   own block carries it while recent (an `OWN_HURT` flag, then a serial and i16 x, y, z,
   repeated for 16 ticks: a protocol bump); the client draws pooled SVG arcs
   (`client/hurtdir.js`, `#hurtdir`), the sandbox's grenades too. The death panel adds the
   killer's health left (CS:GO's freeze cam) from the killer's row in the newest snapshot
   (`E_HEALTH` is already exact): no wire change.
2. **Skip players and effects behind walls.** Players, hostages, ground weapons, grenades,
   effects and their contact and sun shadows are culled by the view frustum only
   (`sphereInView` in `client/gl/playermodels.js`). Skip pose and draw for those whose leaf
   is not marked by the camera's PVS row (`client/gl/worldvis.js` already marks the leaves
   each frame), and the sun-shadow sky test with them. Saves 0.15-0.5 ms of animation CPU
   and part of the models pass on crowded maps; Valve's maps at once, ours after item 5.
3. **Bots throw smokes and molotovs.** Bots throw only HE and flashbangs (14j) and buy no
   others. Smokes: the Ts going for a site smoke the CT spot that watches their path; CTs
   smoke a T entrance when they hear Ts pushing. Molotovs: a T throws one on the bomb when
   he hears a defuse; a CT at a T choke at round start. Reuse `throwAngles` and the throw
   sequence (`this.nade`) in `server/bots.js`; buy them from normal difficulty up. Tests: a
   smoke lands near its spot, a molotov reaches a defusing CT.
4. **Tracers and brass casings.** Every few shots (CS:GO's tracer frequency per gun) a
   yellow inked streak from the muzzle to the impact for 0.1 s, everyone's shots (ours from
   the predicted shot, others' from the snapshot shot counter and impact events); casings
   out of the ejection port as instanced debris (`client/gl/debris.js`), landing with a soft
   tink (`client/audio.js`). Needs an ejection point on each gun model
   (`client/models/guns.js`) and a new `client/gl/tracers.js`.
5. **Visibility data for our own maps.** `shared/bspwriter.js` writes no visibility lump and
   no marksurfaces (lines ~901 and ~964), so de_playground, de_inkwell, cs_polaris and every
   editor map draw every face every frame, where `WorldVis` skips 93-95 % of Valve's maps.
   Build the portals between the hull 0 tree's empty leaves, flood a conservative PVS
   through them (clipped by separating planes, like vis's fast pass), write marksurfaces and
   compressed rows. Mind the compile time (cs_polaris ~34 s): a time cap, a fast pass in
   draft light. Measure the world pass on cs_polaris before and after (`r_drawrepeat 20`);
   test that every leaf a ray reaches is in the PVS.
6. **Radio commands and pings.** CS:GO's Z / X / C radio menus: the line as a comic speech
   balloon over the speaker for 2 s and in team chat (`client/chat.js`, a new
   `client/radio.js`). Middle mouse pings: a comic "!" at the point looked at, in the world
   and on the radar (`client/radar.js`), teammates only, 3 s, rate-limited. Bots obey
   "Follow me" and "Hold this position" and call "Enemy spotted" and "Bomb planted". New
   server messages (a protocol bump; share it with item 1 if built together).
7. **Retakes mode.** Each round the bomb is already planted on a random site, the Ts start
   round it defending and the CTs at the entrances; no money, fixed loadouts per round type
   (pistol, light, full). Spawns from `Nav.open` nodes in and around the site's zone, so maps
   need no extra data. `cfg/gamemode_retakes.cfg`, a `GAME_MODES` entry, the round start in
   `server/game.js`, the Practice menu; the bots' planted-bomb goals already fit.
8. **Ink hatching in corners.** Screen-space ambient occlusion from the depth target in the
   ink pass (`INK_FS`, G-buffer resolution, ~8 samples), printed as diagonal hatch lines on a
   fixed screen grid (like the dots, so it never crawls) where corners and contacts darken.
   `r_hatching` (Video), dropped first by r_dynres; budget under 0.15 ms at full clock.
9. **Comic skies with a backdrop.** The sun as an inked disc with rays where `sunOf` puts it,
   and a distant silhouette ring by map name (dunes for dust, a skyline for office and
   polaris, mountains for snow), procedural, printed flat in the sky pass (`SKY_FS`), one
   draw.
10. **Map load time.** Measure click to first frame on de_dust2 and cs_polaris, step by step
    (download, parse, mesh, lightmap atlas, overview, floor grid, warm-up draws, the practice
    worker's nav). Then likely: the overview built in a worker, the overview and nav cached
    per map in IndexedDB, a progress bar in the menu. Target: half.
