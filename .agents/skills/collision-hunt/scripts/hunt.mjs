#!/usr/bin/env node
// The driver behind the collision-hunt skill: run the scan in a browser, frame
// what it finds, shoot before and after, and clean up the browsers it starts.
//
//   node hunt.mjs scan
//   node hunt.mjs frame --label ground --phase before --age 1 --row 5 --col 2
//   node hunt.mjs strays [--kill]
//
// It borrows the game-inspector's launcher and CDP client rather than carrying
// its own: that is the tool for attaching to a running Three.js game, and this
// is that same attach with a purpose. Point it elsewhere with GAME_INSPECTOR,
// and at another page with GAME_URL.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSPECTOR = process.env.GAME_INSPECTOR || join(homedir(), 'Code/game-inspector');
const GAME_URL = process.env.GAME_URL || 'http://localhost:5173/';
const PORT = Number(process.env.HUNT_PORT || 9350);
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(process.env.HUNT_SHOTS || join(process.cwd(), 'collision-shots'));

const { launchChrome } = await import(join(INSPECTOR, 'src/chrome.js'));
const { listTargets, chooseTarget, Session } = await import(join(INSPECTOR, 'src/cdp.js'));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(argv[i]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A browser of its own, on its own port, with the game loaded and ready. */
async function open(opts) {
  const url = `${GAME_URL}${GAME_URL.includes('?') ? '&' : '?'}paused=1`;
  const { cleanup } = await launchChrome({
    url,
    port: PORT,
    headless: opts.headed ? false : true,
    width: 1200,
    height: 800,
  });
  const session = await Session.open(chooseTarget(await listTargets({ port: PORT }), 'localhost').webSocketDebuggerUrl);
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  for (let i = 0; i < 120; i++) {
    if (await session.evaluate('!!(window.AAL && window.AAL.player)')) break;
    await sleep(250);
  }
  return { session, cleanup };
}

async function shot(session, file) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function scan(opts) {
  const { session, cleanup } = await open(opts);
  try {
    const options = {};
    if (opts.ages) options.ages = String(opts.ages).split(',').map(Number);
    if (opts.rows) options.rows = Number(opts.rows);
    const result = JSON.parse(await session.evaluate(
      `import('/scripts/collide.js').then((m) => JSON.stringify(m.scan(${JSON.stringify(options)})))`,
    ));
    console.log(result.summary);
    if (result.worst.length) console.table(result.worst.map((w) => ({
      depth: w.depth, dy: w.dy, age: w.age, body: w.body, row: w.row, col: w.col,
      mesh: w.mesh, top: w.top, at: w.at.join(', '),
    })));
    else console.log('nothing: the body is not inside anything these steps walked it past.');
  } finally {
    await cleanup();
  }
}

async function frame(opts) {
  const label = opts.label || 'collision';
  const phase = opts.phase === 'after' ? 'after' : 'before';
  const { session, cleanup } = await open(opts);
  try {
    const parked = JSON.parse(await session.evaluate(`(() => {
      const age = ${opts.age ? Number(opts.age) : 'null'};
      const row = ${opts.row ? Number(opts.row) : 0};
      const col = ${opts.col ? Number(opts.col) : 2};
      return import('/scripts/collide.js').then((m) => JSON.stringify(m.probe({ age, row, col })));
    })()`));

    // The inspector's own camera convention: eye = target + dir * distance, so
    // the same numbers move its orbit and this camera.
    const aim = opts.at ? String(opts.at).split(',').map(Number)
      : (parked.overlaps[0] ? parked.overlaps[0].at : [parked.at.x, parked.at.y + 0.6, parked.at.z]);
    const distance = Number(opts.distance || 3.6);
    await session.evaluate(`(() => {
      const p = AAL.player;
      AAL.rig.update = () => {};
      const t = { x: ${aim[0]}, y: ${aim[1]}, z: ${aim[2]} };
      const d = ${distance};
      AAL.camera.position.set(t.x, t.y + 0.08 * d, t.z + d);
      AAL.camera.lookAt(t.x, t.y, t.z);
      AAL.camera.updateMatrixWorld(true);
      for (const el of [...document.body.children]) if (el.tagName !== 'CANVAS') el.style.display = 'none';
      AAL.step(0.0001, 60, true);
      return 'ok';
    })()`);

    const file = await shot(session, join(SHOTS, `${label}-${phase}.png`));
    console.log(`${phase}: ${file}`);
    if (parked.overlaps.length) console.log(`  overlaps there: ${parked.overlaps.map((o) => `${o.mesh} ${o.depth} deep (${o.top} top)`).join('; ')}`);
    else console.log('  nothing overlapping at that spot.');
  } finally {
    await cleanup();
  }
}

async function strays(kill) {
  const { execFileSync } = await import('node:child_process');
  // grep exits 1 when it matches nothing, which is the good case here.
  const list = execFileSync('bash', ['-lc',
    "(ps -Ao pid,args | grep -E 'Chrome|chromium' | grep -E 'user-data-dir=.*game-inspector-|remote-debugging-port=93' | grep -v grep) || true"],
    { encoding: 'utf8' }).trim();
  if (!list) { console.log('no stray browsers'); return; }
  console.log(list);
  if (!kill) { console.log('\nadd --kill to take them down'); return; }
  for (const line of list.split('\n')) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  console.log('killed');
}

const opts = args(process.argv.slice(2));
const command = opts._[0] || 'scan';
if (command === 'scan') await scan(opts);
else if (command === 'frame') await frame(opts);
else if (command === 'strays') await strays(Boolean(opts.kill));
else {
  console.log('usage: hunt.mjs <scan|frame|strays> [--headed] [--label x --phase before|after --age N --row R --col C --at x,y,z]');
  process.exit(1);
}
