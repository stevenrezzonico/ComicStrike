# Project Overview: Procedural Web FPS

**Concept:** A lightweight, high-performance web-based multiplayer FPS. It combines the advanced mechanical logic and physics of CS:GO with the simplified geometry of classic CS 1.6 maps, rendered with a highly stylized, procedural "potato-spec" (LodAdj=5) aesthetic.

**Design Philosophy:** Built through first-principles engineering, the project utilizes a zero-dependency, self-contained architecture. The client executes directly in the browser via standard ES Modules—requiring no npm packages, bundlers, WebAssembly, or third-party graphics libraries. Every system is micro-optimized to eliminate garbage collection spikes, minimize input lag, and maximize frame rates.

## 1. Technical Stack

* **Language:** Vanilla JavaScript (ES6 Modules) and standard Web APIs.
* **Graphics:** Pure WebGL2 (Bare-metal rendering).
* **Networking:** WebTransport (HTTP/3 QUIC) for native UDP-like datagram transmission.
* **Map Format:** Direct GoldSrc BSP (Version 30) binary parsing.

## 2. Core Systems & Architecture

### Graphics & Rendering (The "Potato" Aesthetic)

* **Zero-Asset Pipeline:** The game loads exactly zero image or texture files.
* **Procedural Fragment Shaders:** The visual identity emulates the extreme texture-degraded, flat-shaded look of older Radeon GPUs running LodAdj=5. Textures are procedurally generated in the fragment shader using basic math, noise functions, and flat color assignments based on string names (e.g., `metal`, `crate`) extracted from the map file.
* **Single-Draw-Call Geometry:** Map geometry is packed into a single Vertex Buffer Object (VBO) to keep GPU draw calls as close to zero as possible.

### Map Parsing (GoldSrc BSP)

* **Native Binary Reading:** Native `fetch()` and `DataView` APIs are used to read CS 1.6 `.bsp` files directly into JavaScript `Float32Array` and `Int32Array` buffers.
* **Zero-Overhead Memory:** Because the parsed BSP lumps are already loaded into typed arrays, they are passed directly into WebGL2 buffers, bypassing the need for intermediate data structures or mesh conversions.

### Physics & Gameplay Logic (CS:GO Mechanics)

* **Modern Movement on Retro Geometry:** The engine implements CS:GO’s precise movement physics (acceleration, friction, air-strafing) mapped against the simplified collision hulls of CS 1.6 BSP architecture.
* **Strict Memory Management:** All game states, physics calculations, raycasting, and AABB collision sweeps are handled via pre-allocated `Float32Array` object pools to prevent JavaScript garbage collection from interrupting the main loop.

### Networking & Server Sync

* **WebTransport Datagrams:** Replaces WebSockets and WebRTC to provide a direct, low-latency connection without the overhead of STUN/TURN signaling servers.
* **Source-Style Netcode:** Utilizes fixed-tick server logic (e.g., 64-tick), client-side prediction, and server reconciliation, ensuring crisp hit registration that doesn't suffer from TCP head-of-line blocking.
* **Pragmatic Backend:** The server architecture remains lightweight enough to be deployed directly onto custom self-hosted Linux environments (such as DietPi setups or Pterodactyl panels) with minimal overhead.
## Development

* **Runtime:** Deno (≥ 2.9) for the server, static file serving and tests. The WebTransport server uses Deno's unstable QUIC API (`Deno.QuicEndpoint` + `Deno.upgradeWebTransport`), isolated in `server/transport.js`. No npm/jsr packages anywhere.
* **Run:** `deno task start`, then open `http://127.0.0.1:27015/?map=de_dust2`. TCP 27015 serves HTTP; UDP 27015 carries WebTransport. Clients connect via `127.0.0.1` (not `localhost`) because Chrome tries `::1` first.
* **Test:** `deno task test` (`Deno.test` + `node:assert`; map-dependent tests skip if `maps/*.bsp` is missing). `deno lint` must stay clean.
* **Certificates:** `server/cert.js` auto-generates a 13-day ECDSA P-256 self-signed cert in `certs/` with `openssl`; clients pin it via `serverCertificateHashes` fetched from `/connect.json`.
* **Maps:** `maps/` holds Valve CS 1.6 BSPs — copyrighted, git-ignored, never commit them.
* **Layout:** `shared/` = code run identically by client and server (BSP parsing, physics, protocol); `client/` = browser only; `server/` = Deno only.
* **Lighting:** the BSP's own lighting lump is packed into one lightmap atlas texture at load time (map data, not an image file); albedo is fully procedural from texture names (`client/materials.js`).
* **Chrome datagram limit:** `maxDatagramSize` is 1024 bytes — every packet must fit.
* **Movement (`shared/pmove.js`):** Source `FullWalkMove` ordering with CS:GO convars (`MOVE` table). Player origin is the GoldSrc hull *center* (standing hull 32×32×72, duck hull 32×32×36 — fixed by the BSP clipnodes), so eye heights are 64 standing / 30 crouched above the feet. Crouch-jump raises feet 9 units like CS:GO. Stamina constants are approximations, tuned by feel.
* **Collision (`shared/trace.js`):** hull 0 is rebuilt from BSP nodes and appended after the clipnodes; one recursive trace serves all hulls. Solid brush entities are `func_*` minus a non-solid list; `func_ladder`/`func_water` are volumes.
* **Weapons (`shared/weapons.js`):** CS:GO accuracy model (penalty + recovery with the start/end-bullet transition, movement/air inaccuracy, jump/land penalties), spread seeded by the tick/command number, aim punch with CS:GO recoil convars. Fire rates are tick-quantized (AK: 7 ticks/shot at 64 tick), as in CS:GO.
  * **Real game data:** `shared/weapondata.js` is generated by `tools/gen_weapondata.js` from CS:GO's final `items_game.txt` (all 34 guns, primary + alt modes). Never hand-edit it; reload times and HUD labels (not in that file) live in `EXTRA` in weapons.js and are approximate.
  * **Spray patterns:** generated exactly like CS:GO: Valve's `CUniformRandomStream` (bit-exact port) seeded with each gun's `recoil seed`, angle drawn before magnitude, full-auto tables lerp by `weapon_recoil_variance` 0.55, first 4 shots suppressed from 0.75. The formula was confirmed by matching documented spray shapes (AK, Galil, FAMAS, SG 553, MAC-10); tests pin them.
  * **Not yet modeled:** scope/burst/silencer toggles (weapons spawn in their default mode: USP-S and M4A1-S silenced), revolver cocking, Negev's spread tightening, fixed shotgun spread patterns, the camera-only view punch (`weapon_recoil_view_punch_extra`).
* **Breakables (`shared/breakables.js`):** `func_breakable` with GoldSrc semantics: `health`, `material` (missing = glass), spawnflag 1 trigger-only (CS bomb-site crates: bullets do nothing), 256 one-hit melee, material 7 unbreakable. Bullets deal CS:GO damage with range falloff (`damageAtRange`). Each breakable has a slot (1..255, BSP entity order) stored in vertex byte 39; the world vertex shader drops triangles of broken slots via the `u_broken` bitmask, so the world stays one draw call. Broken ones become `ENT_NONE` (no collision), lose their decals and burst into instanced procedural debris (`client/gl/debris.js`). They reset on respawn (round restart). Mapper-built crates are often several overlapping breakables (fy_buzzkill: lid/shell, hollow walls, floor slab) that break separately, as in GoldSrc. Not yet: explosions (`explodemagnitude`), firing `target`, touch/pressure flags, spawned items, bullet penetration.
* **Client presentation:** bullet decals (`client/gl/decals.js`, ring buffer), box-built viewmodels (`client/gl/viewmodel.js`), GPU crosshair (`client/gl/crosshair.js`), DOM HUD updated only on change (`client/weaponview.js`). Keys: 1/2/3 slots, Q last weapon, R reload, mouse wheel jump.
