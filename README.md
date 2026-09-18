# game-inspector

Attach to a running Three.js game and fly around its scene.

No adapter. No install into the game. No dependencies. It finds the scene by
asking the page what it has, freezes the game's loop, takes the camera, and
gives you an orbit view of the world it was drawing — zoom in on a character,
pull back over a level, box an object to see where it actually is.

```bash
game-inspector --launch --url http://localhost:5174
```

There are two modes. It starts inspecting: the camera is yours, the game is
running, and the panel watches. Hit **Play game** (or `` ` ``) and the game takes
everything back — camera, input, its own draw call — leaving a small badge in the
corner to get back. The inspector stays attached across reloads either way.

```
launched /Applications/Google Chrome.app/... on port 9222
game-inspector
  scene      ok (24 children)
  camera     ok
  render     its own (built from THREE)
  three      ok
  contents   1038 objects, 874 meshes, 151,366 triangles
  frozen     true
  distance   12
  eye        0.00, 10.30, 3.30

the panel is in the top-left of the page. drag to orbit, wheel to zoom, Esc to stop.
```

| | |
|---|---|
| drag | orbit |
| wheel | zoom |
| right-drag / shift-drag | pan |
| `WASD` `QE` | fly the target |
| arrows | orbit |
| click | pick an object and box it |
| `P` / Hold | hold the world still while you look at it |
| `` ` `` / Play game | hand the game back: camera, input and all |
| `B` | toggle the picked object's bounds |
| `C` | composer vs raw renderer |
| `R` / Reset view | back to where the game was looking |
| `Esc` | stop |

## Why this is not the harness

A test harness drives a game through a handle and returns a pass or a fail. It
runs unattended, and it is the thing that decides whether a build is good.

This is the opposite, on purpose. It needs a person, it produces no verdict, and
"it looked fine" is not a test result. Keeping them in separate repositories is
the same boundary drawn a second time, in the place where it cannot be crossed by
accident: an inspector that quietly became part of the test suite would be worse
than no inspector at all.

They share no code. The scene maths (`worldBounds`, `sceneStats`, projection) is
written twice, and that is the deliberate cost of the two repos not depending on
each other. If a third thing ever needs it, that is the moment to extract it.

## How it finds anything

It duck-types, which is why it works on a game whose source you do not have and
whose copy of Three.js is bundled, minified and unreachable.

- **scene** — anything with `isScene` and `children`
- **camera** — `isPerspectiveCamera` first, then `isCamera`. Perspective first
  because the cameras a game does *not* look through are shadow cameras and
  fitting rigs, and orbiting a light's shadow camera looks exactly like a broken
  inspector. `shadow` is skipped outright while searching.
- **renderer** — anything with `.render` and a canvas `.domElement`
- **composer** — anything with `.render`, `.passes` and `.renderer`, preferred
  when present so bloom and the game's other passes stay in the picture
- **THREE** — a namespace with `WebGLRenderer` and `Scene` in it

The search walks the page's globals breadth-first, three levels deep. A game
puts its scene on a global or one object inside one; going deeper means walking
the DOM, every extension's globals and every library the page ever loaded, for
nothing.

## Inspecting and playing

Two activities that cannot share one set of controls: the same drag cannot be both
an orbit and a gesture at the game, and one camera cannot be both the inspector's
and the game's. So it is a mode, not a setting.

**Inspecting** takes the camera, the draw call and the input. The game keeps
running — the world is not a frozen diorama — but it never sees a keystroke. This
is the mode for looking at things.

**Playing** hands all three back. The game paints its own frame with its own
post-processing, reads the keyboard and the pointer exactly as it always does, and
the inspector collapses to a small badge in the corner. This is the mode for
checking the thing actually works, and it is the honest way to test a game you are
building: the version you play is the version you shipped, not a version being
rendered by a tool.

The badge, `` ` `` or the API switch between them, and the mode is in every status
report.

## It stays

Two things used to make this a tool for one look at a time.

**A reload used to take the inspector with it.** An injected script does not
survive a navigation, and a hot reload is a navigation. The CLI stays attached
and puts it back when the page moves on, so a refresh, an HMR reload or a route
change leaves you with an inspector still running.

**A refresh used to put you back at the game's camera pose**, which is the same
place every time: fly somewhere worth looking at, lose it, start again. Where you
were looking is kept per tab — target, angle, distance, and whether you had it
paused — so coming back from a reload means coming back to the same view. A
fresh launch still starts fresh, since a new tab has nothing remembered.

## What it does to the page

Worth knowing before you point it at something.

**It takes the game's draw call.** Not to stop the game, but so that only one
thing paints. Two renderers on one scene fight over a light's shadow map, and
whichever paints last is the one you see, so leaving both in would make the
picture depend on the order the browser runs its callbacks in. The game keeps
simulating, animating and reading input — it just stops painting, and the
inspector paints instead. Stopping hands the call back.

**It pauses only when you ask.** `requestAnimationFrame` is replaced, and
callbacks asked for while paused are held rather than dropped — a game schedules
its next frame from inside the current one, so dropping that request would kill
the loop for good and resuming would hand back a loop nobody was going to call.
They are replayed on resume. The Pause button, `P`, and `stop` all restore it.

**It drives the game's own camera.** Position and aim are set every frame from
the orbit state, starting from the pose the game was already in, so the view
begins where you were looking. Nothing is constructed from THREE to do this: the
camera is moved with numbers.

**It will build a renderer if it has to.** If the game's renderer is reachable it
uses that one, so the picture is the game's picture. If it is not — common, since
nothing ever needed it on a global — and the page has a Three.js namespace, it
builds its own renderer on a canvas laid over the game's, and disposes it on the
way out.

**It puts a panel in a shadow root**, so the page's CSS cannot reach it, and an
overlay canvas above everything for drawing bounds. Both are removed on stop.

**It swallows the gestures it uses**, captured on the way down, so the game
underneath never sees a drag meant for the camera.

## Making your game inspectable

It will tell you exactly what is missing:

```
found the scene and the camera, but nothing to draw with: no renderer is
reachable and the page has no Three.js namespace. Expose one of them in dev
(window.THREE = THREE, or the renderer itself) to make this game inspectable.
```

Either is one line in a dev build and neither is needed in production:

```js
window.THREE = THREE;          // lets the inspector build its own renderer
window.GAME = { scene, camera, renderer };   // or just hand over what it needs
```

## Other ways in

```bash
game-inspector                          # attach to a Chrome already on 9222
game-inspector --url localhost:5174     # pick the tab by url substring
game-inspector --list                   # what is open in there
game-inspector --status                 # what the inspector found, without starting
game-inspector --stop                   # take it off the page
game-inspector --launch --headed        # watch it happen in a real window
```

Chrome has to be started with a debugging port open. `--launch` does that for
you with a throwaway profile, so your own browser and its logins are never
touched. To do it yourself:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-inspect
```

## Limitations, stated honestly

- **It needs a browser it can attach to.** Chrome or Chromium with a debugging
  port. A page inside a cross-origin iframe is a separate target and has to be
  attached to directly.
- **Pausing needs the game to go through `window.requestAnimationFrame`.** A game
  that captured a private reference to it before this ran keeps ticking. The
  camera is still safe — the draw call is what the inspector holds — but the
  world will not hold still.
- **Input shielding happens at the window's capture phase.** That beats a game
  that listens on `window` or on an element, which is nearly all of them. A game
  that registers its own `window` listener *with capture* before the inspector
  loads gets the event first and cannot be shielded; hold the world still if that
  matters.
- **A game that hides its renderer keeps painting underneath.** The inspector
  cannot take a draw call it cannot find, so with its own renderer built from
  THREE the game renders as well, invisibly, and the work is wasted. Nothing
  looks wrong; it is a GPU cost.
- **Reset view needs a pose to return to.** It goes back to where the game's
  camera was when the inspector arrived, which is right unless the game was
  mid-boot at the time.
- **Post-processing is only kept if a composer is found.** Rendering straight
  through the renderer skips it, which is usually what you want when judging
  geometry and is a visible difference if you were looking at the final look.
  `C` toggles between them.
- **Picking is nearest projected centre**, not a real ray cast. It is good enough
  for "what am I looking at", and it will pick the wrong thing when two objects
  overlap.
- **Bounds read `geometry.boundingBox`**, so an `InstancedMesh` reports its base
  geometry rather than its instances.
- **Headless Chrome throttles `requestAnimationFrame`** unless something is
  asking for frames. Launching uses the flags that stop it, but for real
  inspection use `--headed` and look at it.
- **No pixels.** This is a viewer, not a screenshot differ. If you want visual
  regression tests, drive it to a fixed pose and capture from there.

## Testing it

```bash
npm test        # 54 checks, in a real browser
```

The selftest starts a browser, loads a fixture shaped like a Three.js game, and
attaches over this project's own CDP client. It checks what actually happened
rather than what was called: that the game keeps playing while the inspector is
up and that its draw calls are being taken over, that inspecting keeps the input
away from the game and playing hands it over, that holding stops the world and
resuming lets it go, that the camera is aimed at the orbit target every frame,
that the eye sits exactly `distance` from the target after a swing, that picking
the middle of the screen finds the mesh that is there, that the panel is in a
shadow root, that a game with no reachable renderer gets one built for it, and
that a page with no scene refuses to start with a reason.

The assertions are deliberately plain — a counter and an `expect`. A tool graded
by itself passes no matter what is broken.

Several of its checks exist because an earlier version of this failed them: the
camera it found was a light's shadow camera, freezing the loop killed it
permanently instead of pausing it, the whole search never looked past the first
object because a local variable shadowed the depth it was given, and Reset view
used to frame the entire scene — which on a scene with a large ground and a sky
dome means pointing the camera at the sky.
