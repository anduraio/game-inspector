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
  found      the game's renderer, through the scene (it was not on any global)
  drawing    the inspector's, with 29 of the game's draw calls taken
  ratio      1
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
| `P` / Hold | hold the world still while you look at it (the button says Resume while held) |
| `` ` `` / Play game | hand the game back: camera, input and all (the badge then shows the game's frame rate) |
| `B` | toggle the picked object's bounds |
| `C` | composer vs raw renderer |
| `R` / Reset view | point the inspector back at wherever the game is looking now |
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

**When the renderer is not on any global**, the scene gives it up. Three.js
announces every renderer to the scene before each frame —
`scene.onBeforeRender(renderer, scene, camera, renderTarget)` — and that
announcement is the only place a game that keeps its renderer to itself ever
mentions it. The inspector wraps that callback for as long as it is attached and
recognises the first renderer to draw the scene that is not its own. That is what
lets it take the draw call of a game it cannot otherwise see into.

The class is deliberately not patched. `render` is assigned onto each
`WebGLRenderer` in its constructor rather than living on the prototype, so
`THREE.WebGLRenderer.prototype.render` does not exist: patching it would do
nothing, silently, forever. Finding the instance is the only thing that works.

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

The badge carries the frame rate, because it is the only thing on screen in this
mode and the number is the one that matters: playing hands the draw call back, so
what you are feeling is the game's own frame. It is usually *slower* than
inspecting, and that is not the inspector still working — inspecting draws at
pixel ratio 1 through a plain renderer, while playing is the game at full
resolution with its shadows and its post-processing.

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

**It asks the game where it is looking, more than once.** A pose captured at
attach is not enough, because the answer moves: `R` — and coming back from
playing, which hands the camera to the game and lets it drive off somewhere else
— re-reads the game's camera instead of restoring the pose it had at the start.
A game that streams its world makes this the difference between an inspector and
a view of bare ground: The game generates track ahead of the player and retires
the lanes behind them, so a fixed pose ends up over ground the game has taken
away, with the game off the top of the frame. The zoom you set is left alone;
only the aim is re-asked.

**It will build a renderer if it has to.** If the game's renderer is reachable it
uses that one, so the picture is the game's picture. If it is not — common, since
nothing ever needed it on a global — and the page has a Three.js namespace, it
builds its own renderer on a canvas laid over the game's, and disposes it on the
way out.

**It draws at pixel ratio 1 by default.** The game's canvas is covered, so this
is a look-at-the-model view rather than the shipping frame, and the full device
ratio is four times the pixels for a picture nobody is judging pixel by pixel.
`--pixel-ratio 2` when you are, and `--blur` for frosted glass behind the panel,
which is off by default because it is decoration and costs a compositor pass
over a canvas that changes every frame.

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

**Killing the browser kills the inspector** — it is a script inside the page, so
it cannot outlive the tab. The CLI notices the socket close and exits by itself,
and collects the throwaway profile on the way out. Stopping the *CLI* is the
different case: the inspector stays in the page and keeps working, you just lose
the reload recovery until you run it again.

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
- **A game that hides its renderer is found through its scene.** The scene's
  announcement is a Three.js convention: a renderer that does not call
  `scene.onBeforeRender`, or a game whose scene the inspector cannot reach, keeps
  painting underneath, invisibly and at full cost. Nothing looks wrong, it is
  just a GPU bill. The panel and `--status` report how many of the game's draw
  calls are being taken, so a growing count means it worked and a count frozen at
  zero means it did not.
- **Reset view re-asks the game, it does not return to a saved pose.** It goes
  wherever the game's camera is looking at that moment. That is the useful
  answer for a world that moves, and it means there is no "the view I had before"
  to go back to — panning is the thing that stays put.
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
npm test        # 74 checks, in a real browser
```

The selftest starts a browser, loads a fixture shaped like a Three.js game, and
attaches over this project's own CDP client. It checks what actually happened
rather than what was called: that the game keeps playing while the inspector is
up and that its draw calls are being taken over, that inspecting keeps the input
away from the game and playing hands it over, that holding stops the world and
resuming lets it go, that the camera is aimed at the orbit target every frame,
that the eye sits exactly `distance` from the target after a swing, that picking
the middle of the screen finds the mesh that is there, that the panel is in a
shadow root, that a game with no reachable renderer gets one built for it and
then has its own draw call taken off it anyway, and that a page with no scene
refuses to start with a reason.

The assertions are deliberately plain — a counter and an `expect`. A tool graded
by itself passes no matter what is broken.

Several of its checks exist because an earlier version of this failed them: the
camera it found was a light's shadow camera, freezing the loop killed it
permanently instead of pausing it, the whole search never looked past the first
object because a local variable shadowed the depth it was given, Reset view used
to frame the entire scene — which on a scene with a large ground and a sky dome
means pointing the camera at the sky — and a game that kept its renderer private
had its scene painted twice a frame, once by the game and once by the inspector,
with no way to say so in a test.

One more came out of using it on a game rather than a fixture: coming back from
playing left the camera where the game's camera had been at attach, which on a
game that streams its world is a view of ground the game has since retired. The
fixture now moves its camera the way a game does, and the check proves the
inspector follows it.
