---
name: collision-hunt
description: Find places where a character's body is drawn inside the world — the track bed, the sleepers, the rails, the kerbs, the props and the trains — by walking every step of a move with the game's own scan engine, framing each hit with game-inspector, shooting before/after into a gitignored folder, then fixing the cause and re-scanning. Use when a body looks buried in or cut through by geometry, or when asked to find collisions like the one where the rails crossed the baby.
---

# Collision hunt

> A copy of a skill that belongs with the game it was written for: that repo
> holds the scan engine (`scripts/collide.js`) this drives, and the gitignored
> shots it writes. It is copied here so anyone pointing this inspector at that
> game has the workflow to hand. Everything is parameterised — `GAME_URL` for the
> page, `GAME_INSPECTOR` for this repo.

The body moves in two dimensions — x and z, with y decided by the surface it is
standing on — and until recently nothing tested its box against the geometry it
is drawn among. The bug this workflow came from: every body walked on `y = 0`
while the art draws its surfaces at 0.10 (lawn) up to 0.57 (rail heads), so on a
lane the shins were inside the ballast and the rails crossed the body at a third
of an adult's height and more than half of the baby's. It was found by flying a
camera at it, not by anything that ran. This makes it run.

## The loop

1. **Scan.** `node .agents/skills/collision-hunt/scripts/hunt.mjs scan`
   Starts its own headless browser, loads the game from the dev server
   (`npm run dev` first), walks every age down every column and out every row,
   steps the real sim at 120 Hz and tests the body's box against the world at
   every step of every move. Prints findings deepest first: `depth`, `dy`, the
   mesh, its `top`, and the `at` world position of the overlap.

2. **Look at it.** The scan says *where*; the inspector says *what*. Launch it
   headed and fly to the reported `at` (see `references/inspector.md` for the
   controls, the framing snippet, and the two ways to get a still):

   ```
   game-inspector --launch --headed --url http://localhost:5173/
   ```

3. **Shoot it before you touch it.** The driver parks the body, aims at the
   deepest overlap at that spot, hides the HUD and writes a PNG into the
   gitignored `collision-shots/`. Without `--row` it stands the body on a lane,
   which is where a body meets the track:

   ```
   node .agents/skills/collision-hunt/scripts/hunt.mjs frame --label rails --phase before --age 1
   ```

   `--row N --col N` park it exactly; `--at x,y,z` overrides the aim.

4. **Fix the cause, not the picture.** In this game the ground is one number:
   `GROUND` in `src/config.js` (`lawn`, and `lane` = `TRACK.sleeperTop`), read
   per row through `Track.surfaceAt(row)` and used by `Player.groundY`. Anything
   that stands on the world — body, corpse, props, pickups, effect positions —
   must take its height from that, never from a constant. If a *prop* is at
   fault instead, it is usually `slot.position.set(x, 0, z)` in `src/world.js`.

5. **Shoot it after, and re-scan** the same command with `--phase after`. Then
   run the rest of the net: `npm run check` (offline invariants) and the browser
   audit (`import('/scripts/audit.js').then((m) => m.run())`) — the `ground` and
   `corpse` sections fail if the plane slips again. If the fix is a rule the game
   states, add it to `scripts/audit.js`; that is where a claim belongs.

6. **Clean up the browsers.** Every scan and frame starts a headless Chrome on
   port 9350 with a throwaway profile; a killed script leaves it running and
   nothing on screen to explain why the fans came on:

   ```
   node .agents/skills/collision-hunt/scripts/hunt.mjs strays
   node .agents/skills/collision-hunt/scripts/hunt.mjs strays --kill
   ```

## Reading a finding

The report is grouped: one line per class of geometry per body, with `count` for
how many steps it was met on, and the worst case's position in that line. Twelve
rows of baby under the same rail is one thing to look at.

- `depth` is the smallest axis of the overlap: how far something has to move to
  be out. `dy` is the vertical overlap, which is what the eye sees — a 150-unit
  long rail gives a small `depth` in z and a large `dy`.
- Findings below 0.03 are contact, not collision. Nothing is reported for it.
- The **surface the body stands on is not a collision**: an offender whose `top`
  is at or below the body's ground is the ground, allowed up to a shoe (0.12),
  which is how far these models' feet sink into their own surface by authorship.
  Everything else — a sleeper beside a crawling baby, a rail at its waist, a
  kerb, a tree, a train — is a finding.
- **The rails are the one class that is known and accepted.** Every body drags
  through a rail by up to 0.16 — the height a rail head stands above the ties —
  as it steps over it, because the models cross flat. Fixing it means either
  lowering the rails flush with the ties or lifting the body as it crosses; the
  scan will keep reporting `BoxGeometry` with `top` 0.41–0.58 and `depth` ≤ 0.16
  on lane rows until one of those is chosen. Everything else it reports is new.
- `mesh` is `type/geometryType` (`Mesh/BoxGeometry`, `InstancedMesh/BoxGeometry`
  for the sleepers). It is deliberately not a name: the game names nothing, and
  guessing "sleeper" from a size would be the tool inventing facts. Fly to `at`.

## Options

- `scan --ages 1,75 --rows 20` — narrower or longer walk.
- `frame --headed` — watch the shot being taken; `--distance 6` for a wider frame.
- `HUNT_SEED` — the crossing to walk (default 7). Two runs with one seed see the
  same lanes, which is what makes a before and an after comparable.
- `GAME_URL`, `GAME_INSPECTOR`, `HUNT_PORT`, `HUNT_SHOTS` — page, tool path,
  debugging port, and output directory (default `./collision-shots`, gitignored).
