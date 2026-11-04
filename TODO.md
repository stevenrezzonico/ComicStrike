# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end panel
and damage report (14m), sun shadows for players (14n), gun looks, comic jingles.

## Practice tools in Demo mode

CS:GO players' practice configs, in the demo mode only (`rules.demo`, `GAME_DEMO`):

- `sv_grenade_trajectory 1`: the client draws the arc of every grenade in flight as an ink
  line (the positions kept per grenade id for 3 s after it lands), and the landing spot as a
  ring.
- `sv_showimpacts 1`: our bullets' impact points drawn as small boxes for 2 s (from the
  predicted shot's impacts, client side).
- `bot_place`: moves every bot to where we look (the server's `bot_place` command; the
  practice console sends it with no rcon).
- A noclip key (`noclip` works in the demo on the server: `sv_cheats` is on in
  `gamemode_demo.cfg`; bind it in Controls).
- Position save / load: `save_pos` / `load_pos` client commands keep our origin and angles
  (localStorage per map) and `setpos` / `setang` restore them (the demo allows setpos).
- Tests: the arc positions and the impacts list; `bot_place` through the Host.

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
