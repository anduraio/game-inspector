#!/usr/bin/env node
// The inspector inspecting a game.
//
//   npm test
//
// Starts a real browser, loads a fixture that is shaped like a Three.js game,
// attaches over this project's own CDP client and checks what actually
// happened: that the game's loop stopped, that the camera moved, that the
// overlays are in the document, that picking found the mesh in the middle of
// the screen, and that stopping gives the game its loop back.
//
// The assertions are deliberately plain -- a counter and an expect. A tool
// graded by itself passes no matter what is broken.

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { Session, chooseTarget, listTargets } from '../src/cdp.js';
import { findChrome, launchChrome } from '../src/chrome.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8');
const FIXTURE = pathToFileURL(join(here, 'fixture.html')).href;

const failures = [];
let passed = 0;

function expect(label, condition, detail = '') {
  if (condition) passed++;
  else failures.push({ label, detail: String(detail) });
  return !!condition;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until an expression reaches a value. Waiting on the loop, not the clock. */
async function waitFor(session, expression, predicate, { timeout = 8000, every = 60 } = {}) {
  const deadline = Date.now() + timeout;
  let value = await session.evaluate(expression);
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(every);
    value = await session.evaluate(expression);
  }
  return value;
}

/** Wait for the inspector to draw a frame, so state changes are visible. */
async function nextFrame(session) {
  const before = await session.evaluate('window.__GAME_INSPECTOR__.state.frames');
  await waitFor(session, 'window.__GAME_INSPECTOR__.state.frames', (v) => v > before);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('skipped: no Chrome found on this machine');
    return 0;
  }

  // A port of our own, so a browser the developer already has open on 9222 is
  // never touched by a test run.
  const port = 9300 + Math.floor(Math.random() * 400);
  let launched = null;
  let session = null;

  try {
    launched = await launchChrome({ url: FIXTURE, port, chrome, headless: true });
    expect('a browser starts with a debugging port', !!launched.child.pid, `${chrome} on ${port}`);

    const targets = await listTargets({ port });
    const page = chooseTarget(targets, 'fixture.html');
    expect('the fixture page is a target', /fixture\.html/.test(page.url), JSON.stringify(targets.map((t) => t.url)));

    session = await Session.open(page.webSocketDebuggerUrl);

    // Headless Chrome only produces frames when something asks it to, and a
    // requestAnimationFrame loop is fed by frame production: without this the
    // fixture's loop ticks a handful of times a second and every timing
    // assertion here is a race. A 32px screencast is enough to keep frames
    // coming, which is what a real window does for free.
    await session.send('Page.enable');
    await session.send('Page.startScreencast', {
      format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1,
    });

    // --- it plays rather than freezing --------------------------------
    // Taking the draw call is what makes the camera safe, so the game is left
    // running: the world keeps moving while you fly around it.
    const runningA = await session.evaluate('window.__fixtureFrames');
    await sleep(200);
    const runningB = await session.evaluate('window.__fixtureFrames');
    expect('the game loop is running before injection', runningB > runningA, `${runningA} -> ${runningB}`);

    const raw = await session.evaluate(CLIENT);
    const status = JSON.parse(raw);
    expect('injecting finds the scene', status.found?.scene === true, raw);
    expect('injecting finds the camera', status.found?.camera === true, raw);
    expect('injecting finds the renderer', status.found?.renderer === true, raw);
    expect('and draws with the game\'s own one', status.renderMode === 'game', status.renderMode);
    expect('it did not mistake anything else for a scene', status.found?.children === 2, `${status.found?.children}`);
    expect('it counts what is in the scene',
      status.stats?.meshes === 2 && status.stats.triangles === 24, JSON.stringify(status.stats));

    const playingA = await session.evaluate('window.__fixtureFrames');
    const playingB = await waitFor(session, 'window.__fixtureFrames', (v) => v > playingA, { timeout: 6000 });
    expect('the game keeps playing while the inspector is up', playingB > playingA, `${playingA} -> ${playingB}`);
    expect('and the inspector did not freeze it', status.frozen === false, `${status.frozen}`);

    // The game is still asking to draw every frame; the inspector is the one
    // answering. That is the difference between a game that is playing but
    // hidden and a game that has stopped.
    const swallowed = await session.evaluate('window.__GAME_INSPECTOR__.status().swallowed');
    await sleep(300);
    const swallowedLater = await session.evaluate('window.__GAME_INSPECTOR__.status().swallowed');
    expect('the game\'s draw calls are being taken over', swallowedLater > swallowed, `${swallowed} -> ${swallowedLater}`);
    expect('and it is the inspector painting instead',
      await session.evaluate('window.__GAME_INSPECTOR__.status().renderMode') === 'game');

    // --- the camera is ours --------------------------------------------
    // The inspector starts from the pose the game was already in: the eye
    // where the game left it, and the target one distance along the direction
    // the game camera was looking. The fixture looks down (0,-1,-2)/sqrt(5)
    // from (0,5,10), so everything below is checkable by hand.
    // Checked before anything moves the camera, which is the whole point of it.
    const pose = await session.evaluate(
      '(() => { const c = window.__fixture.camera; const i = window.__GAME_INSPECTOR__;'
      + 'return { eye: { x: c.position.x, y: c.position.y, z: c.position.z },'
      + ' target: i.state.target, distance: i.state.distance, lookAtCalls: c.lookAtCalls }; })()',
    );
    const unit = 1 / Math.sqrt(5);
    const forward = { x: 0, y: -unit, z: -2 * unit };
    const expected = {
      x: 0 + forward.x * 12,
      // The pivot is never left under the floor: a camera pitched down puts a
      // fixed-distance target below y = 0, and orbiting that swings you under it.
      y: Math.max(5 + forward.y * 12, 0),
      z: 10 + forward.z * 12,
    };
    const near = (a, b, tol = 0.001) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < tol;
    expect('the target is one distance along the direction the game was looking',
      near(pose.target, expected), `${JSON.stringify(pose.target)} vs ${JSON.stringify(expected)}`);
    expect('and the pivot is not left under the floor', pose.target.y >= 0, `${pose.target.y}`);
    expect('the camera is aimed at the target every frame', pose.lookAtCalls > 3, `${pose.lookAtCalls} calls`);
    // The view direction is the thing that has to survive the round trip: the
    // eye is rebuilt from the target along these angles, so it lands where the
    // game camera was looking rather than exactly where it was standing.
    const lookedAt = {
      x: (pose.target.x - pose.eye.x) / pose.distance,
      y: (pose.target.y - pose.eye.y) / pose.distance,
      z: (pose.target.z - pose.eye.z) / pose.distance,
    };
    expect('and it is looking the way the game camera was looking',
      near(lookedAt, forward, 0.01), `${JSON.stringify(lookedAt)} vs ${JSON.stringify(forward)}`);

    // --- pause and play -----------------------------------------------
    await session.evaluate('window.__GAME_INSPECTOR__.pause(true)');
    await sleep(200); // let the frame already in flight land
    const pausedA = await session.evaluate('window.__fixtureFrames');
    await sleep(300);
    const pausedB = await session.evaluate('window.__fixtureFrames');
    expect('pausing stops the game', pausedB === pausedA, `${pausedA} -> ${pausedB}`);
    expect('and the panel says so',
      await session.evaluate('window.__GAME_INSPECTOR__.status().frozen === true'));

    const camWhilePaused = await session.evaluate('JSON.stringify(window.__fixture.camera.position)');
    await session.evaluate('window.__GAME_INSPECTOR__.orbit(30, 0)');
    await nextFrame(session);
    expect('the camera still works while paused',
      await session.evaluate('JSON.stringify(window.__fixture.camera.position)') !== camWhilePaused);

    await session.evaluate('window.__GAME_INSPECTOR__.pause(false)');
    const resumed = await waitFor(session, 'window.__fixtureFrames', (v) => v > pausedB, { timeout: 5000 });
    expect('playing lets it go again', resumed > pausedB, `${pausedB} -> ${resumed}`);

    // --- rendering ------------------------------------------------------
    const rendered = await session.evaluate(
      '(() => { const r = window.__fixture.renderer; return { calls: r.calls, scene: r.lastScene === window.__fixture.scene, camera: r.lastCamera === window.__fixture.camera }; })()',
    );
    expect('the inspector renders through the game\'s own renderer', rendered.calls > 3, `${rendered.calls} calls`);
    expect('with the game\'s own scene and camera', rendered.scene && rendered.camera, JSON.stringify(rendered));

    // --- the overlay ----------------------------------------------------
    const dom = await session.evaluate(
      '(() => ({ overlay: !!document.querySelector("canvas[style*=\'2147483000\']"), panels: document.querySelectorAll("div").length }))()',
    );
    expect('an overlay canvas is in the page', dom.overlay === true, JSON.stringify(dom));
    const shadow = await session.evaluate(
      '(() => Array.from(document.querySelectorAll("div")).some((d) => d.shadowRoot && d.shadowRoot.querySelector(".panel")))()',
    );
    expect('a panel is in a shadow root, out of reach of the page\'s CSS', shadow === true);

    // --- driving it -----------------------------------------------------
    const start = await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())').then(JSON.parse);
    await session.evaluate('window.__GAME_INSPECTOR__.dolly(0.5)');
    await nextFrame(session);
    const closer = JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'));
    expect('dolly moves the camera in', closer.distance < start.distance, `${start.distance} -> ${closer.distance}`);
    const eyeDistance = Math.hypot(closer.camera.x - closer.target.x, closer.camera.y - closer.target.y, closer.camera.z - closer.target.z);
    expect('and the eye really is that far from the target',
      Math.abs(eyeDistance - closer.distance) < 0.001, `${eyeDistance} vs ${closer.distance}`);

    await session.evaluate('window.__GAME_INSPECTOR__.orbit(40, 0)');
    await nextFrame(session);
    const orbited = JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'));
    expect('orbit swings the camera around the target',
      Math.abs(orbited.camera.x - closer.camera.x) > 0.5, `${closer.camera.x} -> ${orbited.camera.x}`);
    expect('and the eye stays the same distance away while it swings',
      Math.abs(Math.hypot(orbited.camera.x - orbited.target.x, orbited.camera.y - orbited.target.y, orbited.camera.z - orbited.target.z) - orbited.distance) < 0.001);

    // --- picking --------------------------------------------------------
    const pick = await session.evaluate(
      '(() => { const p = window.__GAME_INSPECTOR__.pick(innerWidth / 2, innerHeight / 2); return p ? { name: p.name, meshes: p.meshes, size: p.size } : null; })()',
    );
    expect('picking the centre of the screen finds the mesh that is there',
      pick && pick.size.x === 2, JSON.stringify(pick));

    const miss = await session.evaluate(
      'window.__GAME_INSPECTOR__.pick(2, innerHeight - 2) === null',
    );
    expect('and picking empty space finds nothing', miss === true);

    // --- the loop keeps running -----------------------------------------
    const framesA = (JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'))).frames;
    await sleep(300);
    const framesB = (JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'))).frames;
    expect('the inspector\'s own loop is running', framesB > framesA, `${framesA} -> ${framesB}`);

    // --- playing the game rather than looking at it ---------------------
    // The whole point of the mode: while inspecting, the inspector eats the
    // input; while playing, the game gets every event and the inspector paints
    // nothing.
    await session.evaluate('window.__received.keys = 0; window.__received.pointers = 0; window.__GAME_INSPECTOR__.setMode("inspect"); 1');
    await session.evaluate(`(() => {
      const canvas = document.getElementById('game');
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true }));
      return 1;
    })()`);
    expect('while inspecting, the inspector keeps the input to itself',
      await session.evaluate('window.__received.pointers === 0 && window.__received.keys === 0'),
      await session.evaluate('JSON.stringify(window.__received)'));

    await session.evaluate('window.__received.keys = 0; window.__received.pointers = 0; window.__GAME_INSPECTOR__.setMode("play"); 1');
    const played = JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'));
    expect('playing hands the draw call back', played.suppressed === false && played.mode === 'play', JSON.stringify({ mode: played.mode, suppressed: played.suppressed }));
    expect('and hides the inspector\'s own canvas',
      await session.evaluate(`!document.querySelector("canvas[style*='2147482000']") || document.querySelector("canvas[style*='2147482000']").style.display === 'none'`));

    await session.evaluate(`(() => {
      const canvas = document.getElementById('game');
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true }));
      return 1;
    })()`);
    expect('while playing, the game receives the input',
      await session.evaluate('window.__received.pointers === 1 && window.__received.keys === 1'),
      await session.evaluate('JSON.stringify(window.__received)'));

    const gameDraws = await session.evaluate('window.__fixture.renderer.calls');
    await sleep(300);
    expect('and the game paints for itself',
      await session.evaluate('window.__fixture.renderer.calls') > gameDraws,
      `${gameDraws} -> ${await session.evaluate('window.__fixture.renderer.calls')}`);

    await session.evaluate('window.__GAME_INSPECTOR__.setMode("inspect")');
    await nextFrame(session);
    const backToInspect = JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'));
    expect('switching back takes the draw call again', backToInspect.suppressed === true && backToInspect.mode === 'inspect', JSON.stringify({ mode: backToInspect.mode, suppressed: backToInspect.suppressed }));

    // --- teardown -------------------------------------------------------
    await session.evaluate('window.__GAME_INSPECTOR__.stop()');
    const stopped = JSON.parse(await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())'));
    expect('stop() takes the inspector off the page', stopped.active === false && stopped.overlay === false && stopped.panel === false, JSON.stringify(stopped));
    expect('and stops taking the draw calls over', stopped.suppressed === false, JSON.stringify(stopped));

    const draws = await session.evaluate('window.__fixture.renderer.calls');
    await sleep(300);
    expect('the game is painting for itself again',
      await session.evaluate('window.__fixture.renderer.calls') > draws,
      `${draws} -> ${await session.evaluate('window.__fixture.renderer.calls')}`);
    expect('the render method it was given back is its own',
      !(await session.evaluate('String(window.__fixture.renderer.render)')).includes('inspectorDrawsThisNow'));

    const restarted = await session.evaluate('window.__fixtureFrames');
    const later = await waitFor(session, 'window.__fixtureFrames', (v) => v > restarted, { timeout: 5000 });
    expect('and its loop is still the one it started with', later > restarted, `${restarted} -> ${later}`);
    expect('the patched requestAnimationFrame is restored',
      await session.evaluate('window.requestAnimationFrame.toString().includes("native code")'),
      await session.evaluate('String(window.requestAnimationFrame).slice(0, 60)'));

    // --- a game that keeps its renderer to itself ------------------------
    // The common case in the wild: the scene is reachable, the renderer is not,
    // because nothing ever needed it on a global. If the page has a Three.js
    // namespace the inspector builds its own renderer rather than giving up.
    await session.send('Page.stopScreencast').catch(() => {});
    await session.send('Page.navigate', { url: `${FIXTURE}?no-renderer` });
    await waitFor(session, 'typeof window.game', (v) => v === 'object');
    await session.send('Page.startScreencast', {
      format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1,
    }).catch(() => {});

    const borrowed = JSON.parse(await session.evaluate(CLIENT));
    expect('a game with no reachable renderer still starts', borrowed.active === true, borrowed.error ?? '');
    expect('by building a renderer of its own', borrowed.renderMode === 'own', borrowed.renderMode);
    expect('and it found the namespace it needed', borrowed.found.three === true && borrowed.found.renderer === false, JSON.stringify(borrowed.found));

    await waitFor(session, 'window.__ownRenderer ? window.__ownRenderer.calls : 0', (v) => v > 3);
    expect('the built renderer is the one drawing',
      await session.evaluate('(window.__ownRenderer?.calls ?? 0) > 3'),
      await session.evaluate('String(window.__ownRenderer?.calls)'));
    expect('it was told the viewport size',
      await session.evaluate('window.__ownRenderer?.width === innerWidth && window.__ownRenderer?.height === innerHeight'),
      await session.evaluate('JSON.stringify({ w: window.__ownRenderer?.width, h: window.__ownRenderer?.height, iw: innerWidth, ih: innerHeight })'));
    expect('and it renders the game\'s scene',
      await session.evaluate('!!document.querySelector("canvas[style*=\'2147482000\']")'), 'no overlay canvas found');

    await session.evaluate('window.__GAME_INSPECTOR__.stop()');
    expect('stopping disposes the renderer it built',
      await session.evaluate('window.__ownRendererDisposed === true'), 'dispose() was never called');
    expect('and takes its canvas away',
      await session.evaluate('!document.querySelector("canvas[style*=\'2147482000\']")'), 'the canvas is still there');

    // --- and a page with nothing to inspect ------------------------------
    await session.send('Page.navigate', { url: 'about:blank' });
    await waitFor(session, 'document.readyState', (v) => v === 'complete');
    const empty = JSON.parse(await session.evaluate(CLIENT));
    expect('a page with no scene refuses to start', empty.active === false, JSON.stringify(empty));
    expect('and says which piece was missing', /no scene/.test(empty.error ?? ''), empty.error);
  } finally {
    try { await session?.send('Page.stopScreencast'); } catch { /* already gone */ }
    try { session?.close(); } catch { /* already gone */ }
    await launched?.cleanup();
  }

  return 0;
}

main()
  .then((code) => finish(code))
  .catch((err) => {
    // A thrown error must not hide the checks that already failed: when
    // everything collapses the interesting part is usually the first thing
    // that went wrong, not the last.
    console.error(`game-inspector selftest: ${err?.stack ?? err}`);
    finish(1);
  });

function finish(code) {
  for (const failure of failures) {
    console.log(`FAIL  ${failure.label}${failure.detail ? `\n        ${failure.detail}` : ''}`);
  }
  console.log(`\n${passed}/${passed + failures.length} inspector checks passed`);
  process.exit(failures.length ? 1 : (code ?? 0));
}
