# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end
panel and damage report (14m), sun shadows for players (14n), gun looks, comic jingles,
the demo's practice tools, demo recording, the hurt indicator and the killer's health, characters culled by the PVS, bots' smokes and molotovs, tracers and casings, visibility for our own maps (opt-in: cs_polaris and editor exports), radio and pings, Retakes, hatching in corners, comic skies, map load time (the radar's overview off the page's thread).

## Server QoL (first list, item 9; on hold)

- `callvote kick|changelevel|restartgame` with CS:GO's vote cvars (`sv_vote_timer_duration`
  15, quorum 0.6, `sv_vote_creation_timer` 150, `sv_vote_failure_timer` 300,
  `sv_vote_issue_*_allowed`, `sv_vote_kick_ban_duration` 15 min); `S2C_VOTE` (a protocol
  bump); a client `#vote` panel with F1 / F2 binds.
- `sv_password`: sent in HELLO, a field in the Play panel, a client cvar `password`.
- `GET /rooms.json` listing public rooms, with a public checkbox on the upload.

## Audit leftovers (2026-11-04; findings 1-5 fixed)

Each was reproduced or read in the code; the smallest fix is named.
- Room maps can hang players' tabs: `WorldVis.mark` (client/gl/worldvis.js) loops forever on a
  visibility row that runs off the lump (`00 00` at the end); break when `ofs >= vis.length`,
  and check model 0's `visleafs` against the leaves in `validateBSP`.
- One address can take every player slot (server/main.js `onDatagram`): cap live sessions per
  `addressKey` (~3).
- Client COMMANDs have no rate limit (server/game.js `receive`): each `name` / `jointeam`
  resends INFO to everyone and logs a line; ~4 a tick per client, cooldowns on both.
- `viewTick` is sent as ticks x 256 in a u32 (shared/protocol.js `writeCmds`): it wraps after
  2^24 ticks (72.8 h on one map) and every shot then rewinds 62 ticks; rebuild the high bits
  from the server tick.
- Lag compensation takes any `viewTick` up to 62 ticks old (`Game.rewind`): clamp to ~13
  ticks around the client's acked tick less the interpolation.
- Bot takeover after `jointeam` mid-round, and more than once a round (`Game.takeOver`): a
  per-round flag set by both, cleared in `startRound`.
- `writeSnapshot` has no size check: ~20-25 movers away from rest with 20 players overflow the
  1024-byte writer (de_storm has 10 that can stay open); refuse uploaded maps with more than
  16 such movers, and a test that writes a full 20-player snapshot.
- deploy/update.sh restarts the game on every push, docs too: skip the restart when nothing
  under server/, shared/ or cfg/ changed.
- Demo playback freezes for good after one step that delivers 2 s or more (client/demo.js
  `step`, the 256-datagram queue): clamp the step to 250 ms.
- rcon guesses: 5 a minute per IPv6 /64 is ~327k a minute from a /48, and `rconGuard.clear()`
  at 4096 keys lifts every block: a server-wide cap per minute, evict the oldest.
- Files a user opens can hang their own tab: editor stairs of 4e9 units (autosaved, so on every
  visit; clamp coordinates in `readProject`, cap pieces), demos of 1-byte frames (cap frames).
- `Rooms.lastUpload` only grows: prune entries older than the cooldown in `sweep`.
- HELLO's `primary` / `secondary` are not checked against the slot and team.
- Map logic never runs on a map with no doors and no triggers (`Game.updateDoors` returns
  first), so delayed fires from a trigger_auto never happen there.
- Lean (~160 lines): the instanced cube built three times (gl/debris.js, gl/players.js,
  gl/practice.js), `r_inkfast` (buys nothing now), duplicated vector helpers, `el`, `rng`,
  `shade`, the IndexedDB opener; `damageAtRange` unused outside a test while player.js writes
  the formula inline; unreferenced `GUN_BONES`, `SPEC_CHASE`, `CONTENTS_SLIME`, `HULL_LARGE`.
