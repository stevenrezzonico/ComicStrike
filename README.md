# ComicStrike

A multiplayer first-person shooter that runs in the browser and looks like a printed comic: flat colors, ink outlines, halftone dots and sound words (BLAM!, KAPOW!). The mechanics follow CS:GO (movement, recoil and spray patterns, armor, economy, the bomb, hostages); the maps are classic Counter-Strike 1.6 maps read straight from their `.bsp` files.

Everything is written from scratch in plain JavaScript: WebGL2 for the graphics, WebTransport (UDP over QUIC) for the netcode, Web Audio for the sounds. There are no dependencies, no build step and no image or sound files: every texture, model and sound is generated in code.

## Features

- **The comic print:** one full-screen pass draws ink lines on every silhouette, crease and part, shade as halftone dots, and a slightly misregistered color plate. Surfaces get flat colors and a few ink marks by material (bricks, planks, tiles), colored like the original textures.
- **CS:GO gameplay:** the movement (acceleration, friction, air strafing, crouch jumps), the weapons with their real stats and spray patterns, bullet penetration, armor, competitive rounds and economy, the buy menu, planting and defusing the bomb, carrying hostages, all five grenades.
- **Netcode:** a 64-tick server, client-side prediction that matches the server bit for bit, interpolation and lag compensation.
- **Game modes:** competitive, casual, wingman (2 against 2), deathmatch (free for all or teams), arms race and demolition (weapons earned by kills, the knife last), and a demo playground with free buys and infinite ammo.
- **Bots** that navigate the maps, fight, plant, defuse and rescue, at four difficulties.
- **Practice:** the real server runs inside the browser (a Web Worker), so you can play against bots with no server at all.
- **A CS:GO-style console** (`` ` ``) with the familiar commands, cvars and binds, spectating, a radar built from the map, doors and breakables.

## Running it

You need [Deno](https://deno.com/) 2.9 or newer, and Chrome or Edge (the game uses WebTransport).

```bash
git clone https://github.com/stevenrezzonico/ComicStrike.git
cd ComicStrike
deno task start
```

Then open <http://127.0.0.1:27015/>. Use `127.0.0.1` rather than `localhost`: Chrome tries IPv6 first and the game server listens on IPv4.

The start menu offers Play (join this server), Practice (bots in your browser), Demo and Settings.

### Maps

The repository includes one map of its own, `de_playground`: a small yard with something of everything (stairs, a ladder tower, crates and glass to break, a conveyor belt, a pool, doors, both bomb sites).

The server starts on `de_dust2` by default. Counter-Strike 1.6 maps are copyrighted by Valve and are not included; if you own the game, copy the `.bsp` files from its `cstrike/maps` folder into `maps/`. Without them, start on the included map:

```bash
MAP=de_playground deno task start
```

In PowerShell: `$env:MAP = "de_playground"; deno task start`.

### Useful links while developing

| URL | What it does |
|---|---|
| `/?practice&map=de_playground&mode=competitive&players=10&difficulty=2` | Practice game, 5 against 5 bots |
| `/?practice&map=de_playground&mode=armsrace&players=4` | Arms Race against bots (`mode`: casual, competitive, wingman, deathmatch, armsrace, demolition) |
| `/?practice&mode=demo&map=de_playground` | The demo playground |
| `/?team=ct&primary=ak47&secondary=deagle` | Join the server straight away |
| `/?offline&map=de_playground` | Alone in the map, no rules (noclip in the console) |

## Controls

CS:GO's defaults; change them in Settings, Controls, or with `bind` in the console.

| Key | Action | Key | Action |
|---|---|---|---|
| W A S D | Move | Mouse 1 / 2 | Fire / scope, burst, silencer |
| Space, mouse wheel | Jump | R | Reload |
| Ctrl | Crouch | E | Use (doors, defuse, hostages) |
| Shift | Walk | F | Inspect the weapon |
| 1 – 5 | Weapon slots | G | Drop the weapon |
| Q | Last weapon | B | Buy menu |
| Tab | Scoreboard | M | Choose team |
| `` ` `` | Console | Esc | Pause menu |

## Development

```bash
deno task test   # the test suite (map tests are skipped when the map is missing)
deno lint
```

- `client/`: the browser game (renderer, models, animation, HUD, sound).
- `shared/`: code the client and server both run (map loading, movement, weapons, rules, protocol).
- `server/`: the Deno server (WebTransport, game rules, bots, console).
- `tools/`: generators: weapon data from CS:GO's game files, the playground map, texture colors.

[CLAUDE.md](CLAUDE.md) is the detailed design document: every system, its rules and its approximations.

## Hosting a server

[deploy/README.md](deploy/README.md) explains how to run it on a Linux server with your own domain and a Let's Encrypt certificate on port 443, as a systemd service.

## License

The code is under the [MIT license](LICENSE). Counter-Strike maps and textures belong to Valve and are not part of this project.
