# TODO

Improvements proposed and kept, not yet built. Each has a plan grounded in the code as it
was when the plan was written; check the files named before starting one. Done so far from
these lists: text chat (14g), movers and breakables (14h), weapon leftovers (14i), bots'
grenades, AWP and buttons (14j), radar levels (14k), point lights (14l), the round-end panel
and damage report (14m), sun shadows for players (14n).

## Procedural gun finishes

Shader patterns per finish, a few looks per gun chosen in Settings, shown in the gallery,
the first-person view and third person.

- `FINISH` in `client/gl/meshkit.js` carries one finish per vertex color; add pattern
  finishes (a camo of blotches, diagonal stripes, a hex grid, a two-tone fade) that
  `SKINNED_FS` prints in model space (the way the shemagh's check is done), each over the
  part's own color, so the ink and the two-tone shading stay.
- A look is a set of part colors plus a pattern finish per gun (`client/models/guns.js`
  specs: a `looks` list of 3-4 per gun, the first the plain one); `GunMeshes` builds the
  chosen look's mesh on demand and caches it (the vertex colors change, nothing else).
- Settings, a Weapons tab: a gun list with its looks as swatches, saved as cvars
  (`cl_finish_<gun>`); the gallery (`client/guns.html`) takes `?look=`; third person uses
  the owner's choice only for ourselves (others' choices are not sent: no protocol change).
- Tests: every look stays within the triangle budget and closed; the finish byte round
  trips; the gallery renders each look.

## Comic jingles

Synthesized stingers (`client/audio.js`): round start (a two-note brass hit), bomb planted
(a low drone with a ticking pulse), the last 10 seconds (rising), round won / lost (a major
or minor cadence, 1.2 s), match end (a longer fanfare); `snd_musicvolume` (0-1, Audio tab)
scales them, 0 off. Triggered from the round block's phase and info changes and the bomb
state in `client/main.js` (where the plant notice is flashed). Rendered through the same
bus as the sounds (the compressor keeps them from ducking the game). Keep each under 2 s
and never on top of a flashbang's ringing.

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
