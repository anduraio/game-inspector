#!/usr/bin/env node
// game-inspector — attach to a running game and fly around its scene.
//
//   game-inspector --launch --url http://localhost:5174
//   game-inspector                     # attach to a Chrome already on 9222
//   game-inspector --list
//   game-inspector --stop
//
// No adapter, no install into the game, no dependencies. It finds the scene by
// asking the page what it has.

import { readFileSync } from 'node:fs';
import { CdpError, Session, browserVersion, chooseTarget, listTargets } from './cdp.js';
import { launchChrome } from './chrome.js';

const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

const HELP = `
game-inspector — fly around a running Three.js game

Usage
  game-inspector [options]

Options
  --url <text>        pick the tab whose url contains this (default: first page)
  --port <n>          debugging port to attach to (default: 9222)
  --host <name>       debugging host (default: 127.0.0.1)
  --launch            start a browser with --remote-debugging-port and attach
  --headed            with --launch, show the window instead of headless
  --chrome <path>     browser binary to launch
  --distance <n>      how far to start from the subject, in world units (default 12)
  --wait <seconds>    how long to wait for the page to build a scene (default 15)
  --no-borrow         do not try to import Three.js from the page's dev server
  --once              inject and exit instead of staying to re-inject on reload
  --list              list inspectable pages and exit
  --status            report what the inspector found, without starting one
  --stop              remove the inspector from the page
  --json              machine-readable output
  -h, --help          this

Controls, once attached
  drag                orbit
  wheel               zoom
  right-drag/shift    pan
  WASD / QE           fly the target
  arrows              orbit
  click               pick an object and box it
  B                   toggle the picked object's bounds
  C                   composer vs raw renderer
  R                   reframe on the whole scene
  Esc                 stop

The game keeps playing while you fly around it. Pause it from the panel, or
with F, when you want it to hold still. Where you were looking is remembered
per tab, so a refresh puts you back where you were rather than at the camera's
pose again.

Chrome has to be started with a debugging port open. Either pass --launch, or
start it yourself:

  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
    --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-inspect
`;

function parseArgs(argv) {
  const options = {
    url: null, port: 9222, host: '127.0.0.1', launch: false, headed: null,
    chrome: null, distance: null, wait: 15, borrow: true, watch: true, list: false,
    status: false, stop: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new CdpError(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--url': case '-u': options.url = next(); break;
      case '--port': case '-p': options.port = Number(next()); break;
      case '--host': options.host = next(); break;
      case '--launch': case '-l': options.launch = true; break;
      case '--headed': options.headed = true; break;
      case '--headless': options.headed = false; break;
      case '--chrome': options.chrome = next(); break;
      case '--distance': case '-d': options.distance = Number(next()); break;
      case '--wait': case '-w': options.wait = Number(next()); break;
      case '--no-borrow': options.borrow = false; break;
      case '--once': case '--no-watch': options.watch = false; break;
      case '--list': options.list = true; break;
      case '--status': options.status = true; break;
      case '--stop': options.stop = true; break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('-')) throw new CdpError(`unknown option ${arg}`);
        else options.url = arg; // a bare argument is the url to match
    }
  }
  return options;
}

const say = (text) => process.stdout.write(`${text}\n`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The two things a page can be missing that it might grow a moment later. */
const notYet = (error) => /no scene|no camera/.test(error ?? '');

/**
 * Last resort before giving up: a dev server usually serves Three.js as a real
 * module, so the page can be handed a namespace it never exposed.
 *
 * This is a guess about how a bundler lays its dependencies out, and it is only
 * right for a dev server (Vite and plain node_modules layouts are the two worth
 * trying). It is worth making because the alternative is editing the game to be
 * inspectable, and the version it borrows is the same copy the game itself is
 * running against. Turn it off with --no-borrow.
 */
const BORROW_THREE = `(async () => {
  if (window.THREE && typeof window.THREE.WebGLRenderer === 'function') return 'page already has it';
  const paths = [
    '/node_modules/.vite/deps/three.js',
    '/node_modules/three/build/three.module.js',
    '/node_modules/three/build/three.module.min.js',
  ];
  for (const path of paths) {
    try {
      const module = await import(path);
      if (module && typeof module.WebGLRenderer === 'function') {
        window.THREE = module;
        return path;
      }
    } catch { /* not there, or not a module this page can import */ }
  }
  return null;
})()`;

async function startInspector(session, options) {
  const deadline = Date.now() + options.wait * 1000;
  let status = JSON.parse(await session.evaluate(CLIENT));
  let waited = false;
  let borrowed = null;

  while (!status.active && notYet(status.error) && Date.now() < deadline) {
    if (!waited && !options.json) {
      say(`waiting for the page to build a scene (up to ${options.wait}s)...`);
      waited = true;
    }
    await sleep(250);
    status = JSON.parse(await session.evaluate(CLIENT));
  }

  // The scene is there but there is nothing to draw with: try to borrow a
  // renderer before admitting defeat.
  if (!status.active && /nothing to draw with/.test(status.error ?? '') && options.borrow) {
    try {
      borrowed = await session.evaluate(BORROW_THREE);
    } catch { /* the page refused the import; the message below still stands */ }
    if (borrowed && borrowed !== 'page already has it') {
      if (!options.json) say(`borrowed Three.js from ${borrowed}`);
      status = JSON.parse(await session.evaluate(CLIENT));
    }
  }

  return status;
}

function reportList(targets, options) {
  const pages = targets.filter((t) => t.type === 'page' && t.url);
  if (options.json) return say(JSON.stringify(pages.map((t) => ({ title: t.title, url: t.url })), null, 2));
  if (!pages.length) return say('no pages open in that browser');
  say(`${pages.length} page${pages.length === 1 ? '' : 's'}:`);
  for (const page of pages) say(`  ${page.title || '(untitled)'}\n    ${page.url}`);
  return undefined;
}

function reportStatus(status, options) {
  if (options.json) return say(JSON.stringify(status, null, 2));
  const tick = (v) => (v ? 'ok' : 'MISSING');
  const mode = {
    composer: "the game's composer",
    game: "the game's renderer",
    own: 'its own (built from THREE)',
    none: 'MISSING',
  }[status.renderMode] ?? status.renderMode;
  say('game-inspector');
  say(`  scene      ${tick(status.found.scene)} (${status.found.children} children)`);
  say(`  camera     ${tick(status.found.camera)}`);
  say(`  render     ${mode}`);
  say(`  three      ${status.found.three ? 'ok' : 'not on any global'}`);
  if (status.stats) {
    say(`  contents   ${status.stats.objects} objects, ${status.stats.meshes} meshes, ${status.stats.triangles.toLocaleString()} triangles`);
  }
  say(`  frozen     ${status.frozen}`);
  say(`  distance   ${status.distance}`);
  if (status.camera) {
    const c = status.camera;
    say(`  eye        ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`);
  }
  if (status.picked) say(`  picked     ${status.picked.name} (${status.picked.meshes} meshes)`);
  if (status.error) say(`  error      ${status.error}`);
  return undefined;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    say(HELP.trim());
    return 0;
  }

  let launched = null;
  if (options.launch) {
    if (!options.url) throw new CdpError('--launch needs --url, or a bare url, to know what to open');

    // A browser cannot bind a port something else is already holding, and the
    // wait for it to come up would then succeed against whatever is already
    // there -- silently attaching to the wrong browser. Say so instead.
    const taken = await listTargets({ port: options.port, host: options.host, timeout: 800 })
      .then(() => true, () => false);
    if (taken) {
      throw new CdpError(
        `something is already answering on ${options.host}:${options.port}. Attach to it by `
        + 'dropping --launch, or start a second browser on another port with --port <n>.',
      );
    }

    // Opening a browser is what you do when you want to look at something, so
    // it is a window unless --headless is asked for.
    const headed = options.headed ?? true;
    launched = await launchChrome({
      url: options.url,
      port: options.port,
      chrome: options.chrome,
      headless: !headed,
    });
    if (!options.json) say(`launched ${launched.binary} on port ${options.port}`);
  }

  const targets = await listTargets({ port: options.port, host: options.host });

  if (options.list) {
    reportList(targets, options);
    return 0;
  }

  const target = chooseTarget(targets, options.url);
  const session = await Session.open(target.webSocketDebuggerUrl);

  try {
    if (options.stop) {
      const result = await session.evaluate(
        `(() => { const i = window.__GAME_INSPECTOR__; if (!i) return 'no inspector in this page'; `
        + 'if (!i.active) return "already stopped"; i.stop(); return "stopped"; })()',
      );
      say(options.json ? JSON.stringify({ result }) : result);
      return 0;
    }

    if (options.status) {
      const raw = await session.evaluate(
        'window.__GAME_INSPECTOR__ ? JSON.stringify(window.__GAME_INSPECTOR__.status()) : null',
      );
      if (!raw) {
        say('no inspector running in that page');
        return 1;
      }
      reportStatus(JSON.parse(raw), options);
      return 0;
    }

    // Start one, retrying while the page has not built a scene yet. A game
    // usually needs a second or two after load -- modules, WebGL, the first
    // level -- and attaching to a page mid-boot is the normal case, not an
    // error. Anything else it reports is final and worth saying once.
    let status = await startInspector(session, options);

    if (status.error && !status.active) {
      say(`could not start: ${status.error}`);
      return 1;
    }
    if (!options.json && options.distance) {
      await session.evaluate(`(() => { const i = window.__GAME_INSPECTOR__; i.state.distance = ${options.distance}; return 1; })()`);
      const refreshed = await session.evaluate('JSON.stringify(window.__GAME_INSPECTOR__.status())');
      reportStatus(JSON.parse(refreshed), options);
    } else {
      reportStatus(status, options);
    }

    if (!options.json) {
      say('');
      say('the panel is in the top-left of the page. drag to orbit, wheel to zoom, Esc to stop.');
      if (launched) {
        say(`the browser is a throwaway profile at ${launched.profile}; close the window when done.`);
      }
    }

    // Stay attached and put the inspector back after a reload.
    //
    // An injected script does not survive a navigation -- a refresh, a hot
    // reload, a route change all wipe it -- which made the tool useless for
    // anything longer than one look. Watching the page costs one line of CDP
    // and means the inspector is simply still there, in the same place, on the
    // other side of a refresh.
    if (options.watch && !options.json) {
      let reinjecting = false;
      session.on('Page.frameNavigated', async ({ frame }) => {
        if (reinjecting || (frame && frame.parentId)) return;
        reinjecting = true;
        if (!options.json) say('\nthe page navigated: putting the inspector back...');
        try {
          const again = await startInspector(session, options);
          if (!options.json) {
            say(again.active
              ? `back${again.restored ? ', where you left it' : ''}. Ctrl-C when you are done.`
              : `could not put it back: ${again.error}`);
          }
        } catch (err) {
          if (!options.json) say(`could not put it back: ${err.message}`);
        } finally {
          reinjecting = false;
        }
      });
      await session.send('Page.enable');

      if (!options.json) say('watching for reloads. Ctrl-C to stop.');
      // Hold the process open: the session has to stay alive for any of this
      // to keep working.
      await new Promise((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
        session.onClosed = resolve;
        session.socket?.addEventListener('close', resolve);
      });
      session.close();
      return 0;
    }

    return 0;
  } finally {
    session.close();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    const message = err instanceof CdpError ? err.message : (err?.stack ?? String(err));
    process.stderr.write(`game-inspector: ${message}\n`);
    process.exit(1);
  });
