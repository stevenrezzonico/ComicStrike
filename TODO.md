# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end panel
and damage report (14m), sun shadows for players (14n), gun looks, comic jingles, the demo's practice tools.

## Demo recording (first list, item 5)

Record a game as the stream of datagrams received (plus our commands), play it back through
the same `NetClient` path (`connectLocal` with a replayer instead of the worker), with the
spectator camera free. `record <name>` / `stop` / `playback <name>` in the console, files in
IndexedDB (the editor's handoff shows how) with a download. No protocol change; a header
with the protocol version and the map.

## Server QoL (first list, item 9; on hold)

- `callvote kick|changelevel|restartgame` with CS:GO's vote cvars (`sv_vote_timer_duration`
  15, quorum 0.6, `sv_vote_creation_timer` 150, `sv_vote_failure_timer` 300,
  `sv_vote_issue_*_allowed`, `sv_vote_kick_ban_duration` 15 min); `S2C_VOTE` (a protocol
  bump); a client `#vote` panel with F1 / F2 binds.
- `sv_password`: sent in HELLO, a field in the Play panel, a client cvar `password`.
- `GET /rooms.json` listing public rooms, with a public checkbox on the upload.
