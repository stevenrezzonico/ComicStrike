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

## Audit leftovers (2026-11-04)

Each was reproduced or read in the code; the smallest fix is named.
- `writeSnapshot` has no size check: ~20-25 movers away from rest with 20 players overflow the
  1024-byte writer (de_storm has 10 that can stay open); refuse uploaded maps with more than
  16 such movers, and a test that writes a full 20-player snapshot.
- deploy/update.sh restarts the game on every push, docs too: skip the restart when nothing
  under server/, shared/ or cfg/ changed.
- rcon guesses: 5 a minute per IPv6 /64 is ~327k a minute from a /48, and `rconGuard.clear()`
  at 4096 keys lifts every block: a server-wide cap per minute, evict the oldest.
- `Rooms.lastUpload` only grows: prune entries older than the cooldown in `sweep`.
- Lean (~160 lines): the instanced cube built three times (gl/debris.js, gl/players.js,
  gl/practice.js), `r_inkfast` (buys nothing now), duplicated vector helpers, `el`, `rng`,
  `shade`, the IndexedDB opener; `damageAtRange` unused outside a test while player.js writes
  the formula inline; unreferenced `GUN_BONES`, `SPEC_CHASE`, `CONTENTS_SLIME`, `HULL_LARGE`.
