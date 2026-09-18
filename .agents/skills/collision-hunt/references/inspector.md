# Driving game-inspector

The tool is a separate repo, usually `~/Code/game-inspector`, and its CLI is
symlinked into `~/.local/bin` as `game-inspector`. It attaches to a running
Three.js game over CDP, takes the camera, and gives you an orbit view of the
scene the game was drawing. No adapter, no install into the game.

## Launching it

```bash
game-inspector --launch --headed --url http://localhost:5173/   # its own browser, a window
game-inspector --url localhost:5173                             # attach to a Chrome already on 9222
game-inspector --status                                         # what it found, without starting
game-inspector --list                                           # pages it can attach to
game-inspector --stop                                           # take it off the page
```

`--launch` starts Chrome with a throwaway profile and kills it when you close the
window: the CLI notices the socket closing and exits with it. Give it the scheme
(`http://localhost:5173/`) — a bare `localhost:5173` can race the browser's first
navigation and attach fails with `no page matching`.

## Controls

| | |
|---|---|
| drag | orbit |
| wheel | zoom |
| right-drag / shift-drag | pan |
| `WASD` `QE` | fly the target (hold to fly; `QE` is height) |
| arrows | orbit in steps |
| click | pick an object and box it |
| `B` | toggle the picked object's bounds |
| `C` | composer vs raw renderer |
| `R` | re-aim at wherever the game's camera is looking now |
| `P` / `F` | hold the world still |
| `` ` `` | hand it back to the game (play mode) |
| `Esc` | stop |

Two modes: **inspecting** takes the camera, the draw call and the input, and the
game keeps simulating underneath; **playing** hands all three back and the
inspector collapses to a badge. Coming *back* from playing holds the world still,
because reaching for the badge is the moment you stopped playing and started
looking.

## Framing a reported overlap

The inspector drives the game's own camera every frame from its orbit state, so
aim it with numbers rather than by wrestling the orbit. In the page console:

```js
const I = window.__GAME_INSPECTOR__;
I.freeze();                                     // hold the world: the body stops walking
I.state.target = { x: X, y: Y, z: Z };          // the `at` the scan reported
I.state.yaw = 0;                                // look along the crossing
I.state.pitch = 0.06;                           // level with the rails
I.state.distance = 3.6;                         // whole body and the ground in one frame
```

`P` (or `I.thaw()`) releases it again. The eye is always
`target + distance * (cos pitch sin yaw, sin pitch, cos pitch cos yaw)`, so those
four numbers are the whole pose.

## Stills

The inspector has no screenshot of its own — it is a viewer, not a pixel differ
("No pixels" in its README). Take stills through CDP (`Page.captureScreenshot`),
which is what `.agents/skills/collision-hunt/scripts/hunt.mjs frame` does, or
screenshot the window with macOS.

While inspecting, the picture is the inspector's: pixel ratio 1 through a plain
renderer, no bloom, and its canvas covers the game's own HUD. For the game's real
frame, press the badge (`` ` ``) and play.

## Leaving nothing running

Headless browsers have no window to close and no CLI watching them. After any
headless run:

```bash
node .agents/skills/collision-hunt/scripts/hunt.mjs strays --kill
```

Profile directories (`/var/folders/.../T/game-inspector-XXXX`, ~60–175 MB each)
are wiped by the CLI on a normal exit, and left behind by a killed browser or a
failed `--launch`; delete them by hand if you care.
