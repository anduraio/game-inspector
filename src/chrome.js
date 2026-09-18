// Finding Chrome and starting one with a debugging port open.
//
// A launch always uses a throwaway profile directory. Attaching to the user's
// real profile is not worth it: Chrome refuses a debugging port on a profile it
// is already running, and getting that wrong means either an error nobody can
// read or, worse, a browser that silently does not expose the port.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpError, listTargets } from './cdp.js';

const MAC_APPS = [
  'Google Chrome.app',
  'Google Chrome Canary.app',
  'Chromium.app',
  'Brave Browser.app',
  'Microsoft Edge.app',
  'Vivaldi.app',
];

const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];

/** Where Chrome probably is, in the order worth trying. */
export function chromeCandidates(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      ...MAC_APPS.map((app) => `/Applications/${app}/Contents/MacOS/${app.replace('.app', '')}`),
      ...MAC_APPS.map((app) => join(process.env.HOME ?? '', 'Applications', app, 'Contents/MacOS', app.replace('.app', ''))),
    ];
  }
  if (platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((root) => [
      join(root, 'Google/Chrome/Application/chrome.exe'),
      join(root, 'Microsoft/Edge/Application/msedge.exe'),
    ]);
  }
  return [...LINUX_NAMES, '/usr/bin/google-chrome', '/snap/bin/chromium'];
}

/** The first candidate that exists, or null. */
export function findChrome({ explicit = null, platform = process.platform } = {}) {
  if (explicit) {
    if (!existsSync(explicit)) throw new CdpError(`no browser at ${explicit}`);
    return explicit;
  }
  for (const candidate of chromeCandidates(platform)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the debugging port answers, or give up. */
export async function waitForPort({ port, host = '127.0.0.1', timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await listTargets({ port, host, timeout: 1000 });
      return true;
    } catch (err) {
      lastError = err;
      await sleep(150);
    }
  }
  throw new CdpError(`a browser never answered on ${host}:${port} within ${timeout}ms`, { cause: lastError });
}

/**
 * Start a browser with a debugging port and a profile of its own.
 *
 * Returns the process and a cleanup function. The caller is responsible for
 * calling cleanup, and the cleanup is idempotent because a test that fails
 * halfway has already proved it will be called twice.
 */
export async function launchChrome({
  url = 'about:blank',
  port = 9222,
  chrome = null,
  headless = true,
  width = 1440,
  height = 900,
  timeout = 20000,
  extraArgs = [],
} = {}) {
  const binary = findChrome({ explicit: chrome });
  if (!binary) {
    throw new CdpError(
      'could not find Chrome. Pass --chrome /path/to/chrome, or start a browser '
      + `yourself with --remote-debugging-port=${port} and attach to it.`,
    );
  }

  const profile = mkdtempSync(join(tmpdir(), 'game-inspector-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,AcceptCHFrame',
    // A game being inspected is a game whose requestAnimationFrame is being
    // watched, so Chrome's habit of throttling a window it thinks is in the
    // background would be throttling the thing you came to look at.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
    ...extraArgs,
    url,
  ];

  const child = spawn(binary, args, { stdio: 'ignore', detached: false });
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch { /* already gone */ }
    await sleep(150);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch { /* the profile is in a temp dir; losing the race is not a problem */ }
  };

  child.on('error', () => {});

  try {
    await waitForPort({ port, timeout });
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { child, profile, binary, args, cleanup };
}
