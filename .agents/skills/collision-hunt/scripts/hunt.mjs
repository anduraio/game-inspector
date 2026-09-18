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
const SEED = process.env.HUNT_SEED || '7';   // one crossing, so two runs see the same rows
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
  const url = `${GAME_URL}${GAME_URL.includes('?') ? '&' : '?'}seed=${SEED}&paused=1`;
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
  // --revert-ground puts the body back on y = 0, the way it was before the ground
  // fix. Nothing else changes, so a scan run both ways is a demonstration that
  // the scan catches the bug it was built for rather than a story about it.
  if (opts['revert-ground']) {
    await session.evaluate("Object.defineProperty(AAL.player, 'groundY', { get: () => 0, configurable: true }); 'reverted'");
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
    // Without a row, stand it on a lane: that is where a body meets the track.
    const parked = JSON.parse(await session.evaluate(`(() => {
      const age = ${opts.age ? Number(opts.age) : 'null'};
      const lanes = AAL.track.lanes.map((l) => l.row).sort((a, b) => a - b);
      const row = ${opts.row ? Number(opts.row) : '(lanes[1] ?? lanes[0] ?? 0)'};
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


/**
 * The per-move loop: one step at a time, paused, measured, photographed, logged.
 *
 * This is the same hunt walked by hand — play, stop, look, write down what you
 * saw, play on — with the stop, the look, the photograph and the note made by the
 * same code every time, so two runs are comparable and nothing depends on keeping
 * your nerve. The body is held between moves (the game's own loop is paused and
 * the sim is stepped by hand), every step of every move is tested, and the frame
 * that is kept for a move is the one at its worst moment.
 */
async function walk(opts) {
  const rows = Number(opts.rows || 8);
  const ages = opts.ages ? String(opts.ages).split(',').map(Number) : [1, 34, 75];
  const shots = opts.shots || 'all';
  const label = opts.label || 'walk';
  const { session, cleanup } = await open(opts);
  const lines = [];
  try {
    for (const age of ages) {
      const log = JSON.parse(await session.evaluate(`(async () => {
        const m = await import('/scripts/collide.js');
        AAL.pause(true);
        const player = AAL.player;
        const out = [];
        AAL.go(${age});
        player.reset({ col: 2, row: 2 });
        AAL.step(0.016, 60, false);
        for (let move = 0; move < ${rows}; move++) {
          const from = Math.round(player.row);
          player.pressDown({ col: 0, row: 1 });
          if (player.charging) AAL.release();
          let worst = null;
          let at = null;
          for (let i = 0; i < 400; i++) {
            AAL.step(1 / 120, 120, false);
            const reading = m.measure();
            const bad = reading.overlaps[0];
            if (bad && (!worst || bad.depth > worst.depth)) { worst = bad; at = reading.at; }
            if (player.state === 'ground' && player.recover <= 0 && player.row > from) break;
          }
          out.push({
            move: move,
            age: ${age},
            body: player.age.id,
            from,
            to: Math.round(player.row * 100) / 100,
            x: Math.round(player.x * 100) / 100,
            z: Math.round(player.z * 100) / 100,
            ground: Math.round(player.groundY * 100) / 100,
            want: Math.round(m.measure().want * 100) / 100,
            worst: worst ? { depth: worst.depth, mesh: worst.mesh, top: worst.top, at: worst.at } : null,
          });
        }
        return JSON.stringify(out);
      })()`));

      for (const step of log) {
        const hit = step.worst && step.worst.depth > 0.03;
        if (shots === 'all' || (shots === 'hits' && hit)) {
          const aim = step.worst ? step.worst.at : [step.x, step.ground + 0.5, step.z];
          await session.evaluate(`(() => {
            const p = AAL.player;
            AAL.rig.update = () => {};
            for (const el of [...document.body.children]) if (el.tagName !== 'CANVAS') el.style.display = 'none';
            AAL.camera.position.set(${aim[0]}, ${aim[1]} + 0.3, ${aim[2]} + 3.4);
            AAL.camera.lookAt(${aim[0]}, ${aim[1]}, ${aim[2]});
            AAL.camera.updateMatrixWorld(true);
            AAL.step(0.0001, 60, true);
            return 'ok';
          })()`);
          const file = await shot(session, join(SHOTS, `${label}-a${step.age}-m${String(step.move).padStart(2, '0')}.png`));
          step.shot = file.split('/').pop();
        }
        lines.push([
          `age ${step.age} (${step.body})`, `move ${step.move}`, `row ${step.from} -> ${step.to}`,
          `ground ${step.ground} of ${step.want}`,
          hit ? `INSIDE ${step.worst.mesh} ${step.worst.depth} deep (top ${step.worst.top}) at ${step.worst.at.join(',')}` : 'clear',
          step.shot || '',
        ].join(' | '));
      }
    }

    const logFile = join(SHOTS, `${label}.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, lines.join('\n') + '\n');
    const hits = lines.filter((l) => l.includes('INSIDE'));
    console.log(`${lines.length} moves walked at ${ages.join(', ')}y; ${hits.length} with something inside the body`);
    for (const line of hits) console.log('  ' + line);
    console.log(`log: ${logFile}`);
    if (shots !== 'none') console.log(`frames: ${SHOTS}/${label}-a*.png`);
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
else if (command === 'walk') await walk(opts);
else if (command === 'frame') await frame(opts);
else if (command === 'strays') await strays(Boolean(opts.kill));
else {
  console.log('usage: hunt.mjs <scan|walk|frame|strays> [--headed] [--ages 1,34 --rows 8 --shots all|hits|none]');
  console.log('       hunt.mjs frame --label x --phase before|after --age N [--row R --col C --at x,y,z]');
  process.exit(1);
}
