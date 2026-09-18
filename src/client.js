// The script that gets injected into the page.
//
// It is deliberately a plain self-contained IIFE rather than a module: it is
// injected as source text, so it cannot import anything. Everything it needs
// from Three.js it gets by duck-typing what is already in the page — isScene,
// isCamera, a renderer with .render and .domElement — which is also why it works
// on a game whose source you do not have and whose three is bundled, minified
// and unreachable as a global.
//
// Nothing is constructed from THREE. The camera is driven with numbers, and the
// overlays are DOM and 2D canvas. That is the whole trick: an inspector that
// needed the THREE namespace would need the game to expose it.
(() => {
  'use strict';

  const KEY = '__GAME_INSPECTOR__';
  const prior = window[KEY];
  if (prior && prior.active) {
    try { prior.stop(); } catch { /* a half-torn-down inspector is not worth rescuing */ }
  }

  // ---------------------------------------------------------------------------
  // Maths. Plain numbers against the matrices Three.js already maintains.
  // ---------------------------------------------------------------------------

  function applyMatrix4(matrix, x, y, z) {
    const e = matrix.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = w === 0 ? 1 : 1 / w;
    return {
      x: (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw,
      y: (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw,
      z: (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw,
      w,
    };
  }

  function isFinite3(p) {
    return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  }

  /** Walk a subtree the way the renderer does: a hidden parent hides its children. */
  function walk(root, visit) {
    const stack = [[root, true]];
    let index = 0;
    while (stack.length) {
      const [object, inherited] = stack.pop();
      const visible = inherited && object.visible !== false;
      visit(object, visible, index++);
      const children = object.children;
      if (!children) continue;
      for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], visible]);
    }
  }

  /** The box a subtree occupies in world space. */
  function boundsOf(root, visibleOnly = true) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    let meshes = 0;
    try { root.updateWorldMatrix?.(false, true); } catch { /* a stale matrix is better than none */ }

    walk(root, (object, visible) => {
      const geometry = object.geometry;
      if (!geometry || (visibleOnly && !visible)) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox?.();
      const box = geometry.boundingBox;
      if (!box || !object.matrixWorld) return;
      meshes++;
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const p = applyMatrix4(object.matrixWorld, x, y, z);
            if (!isFinite3(p)) continue;
            min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
            min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
            min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z);
          }
        }
      }
    });

    if (!meshes) return null;
    return {
      min,
      max,
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
      meshes,
    };
  }

  function sceneStats(root) {
    let objects = 0;
    let meshes = 0;
    let triangles = 0;
    let hidden = 0;
    walk(root, (object, visible) => {
      objects++;
      if (!visible) { hidden++; return; }
      const geometry = object.geometry;
      if (!geometry) return;
      meshes++;
      const count = geometry.index ? geometry.index.count : (geometry.attributes?.position?.count ?? 0);
      const instances = object.isInstancedMesh ? (object.count ?? 1) : 1;
      triangles += (count / 3) * instances;
    });
    return { objects, meshes, triangles: Math.round(triangles), hidden };
  }

  /** Where a world point lands in the page, in CSS pixels. */
  function project(camera, point) {
    camera.updateMatrixWorld?.(true);
    const view = applyMatrix4(camera.matrixWorldInverse, point.x, point.y, point.z);
    if (view.z >= 0) return null; // behind the lens
    const clip = applyMatrix4(camera.projectionMatrix, view.x, view.y, view.z);
    return { x: clip.x, y: clip.y, depth: -view.z };
  }

  // ---------------------------------------------------------------------------
  // Discovery. Nothing here is game specific: it asks the page what it has.
  // ---------------------------------------------------------------------------

  const SKIP = new Set([
    'window', 'self', 'top', 'parent', 'frames', 'document', 'location', 'history',
    'navigator', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'crypto',
    'performance', 'screen', 'console', 'speechSynthesis', 'visualViewport',
    // A light keeps its shadow camera in here, and a shadow camera answers
    // isCamera just as well as the real one while sitting at the light's
    // position. Orbiting it looks exactly like the inspector being broken.
    'shadow',
  ]);

  const isScene = (v) => !!v && typeof v === 'object' && v.isScene === true && Array.isArray(v.children);
  const isCamera = (v) => !!v && typeof v === 'object' && v.isCamera === true && !!v.position;
  const isPerspectiveCamera = (v) => isCamera(v) && v.isPerspectiveCamera === true;
  const isRenderer = (v) => !!v && typeof v === 'object' && typeof v.render === 'function'
    && !!v.domElement && typeof v.domElement.getContext === 'function';
  // An EffectComposer renders the frame the game actually shows. Talking to it
  // instead of the renderer keeps bloom and any other passes in the picture.
  const isComposer = (v) => !!v && typeof v === 'object' && typeof v.render === 'function'
    && Array.isArray(v.passes) && !!v.renderer;
  // The Three.js namespace itself, if the page has one lying about. Having it
  // is what lets the inspector build its own renderer for a game that never
  // exposes one.
  const isThreeNamespace = (v) => !!v && typeof v === 'object'
    && typeof v.WebGLRenderer === 'function' && typeof v.Scene === 'function';

  /**
   * Breadth-first hunt through the page's globals.
   *
   * Depth limited on purpose: a game puts its scene on a global or one object
   * deep inside one, and going further means walking the whole DOM, extension
   * globals and every library the page ever loaded, for nothing.
   */
  function scan(predicate, { maxDepth = 3, budget = 40000, roots = [window] } = {}) {
    const queue = roots.map((value) => ({ value, level: 0 }));
    const seen = new Set();
    let visited = 0;

    while (queue.length && visited < budget) {
      const { value, level } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited++;

      if (predicate(value)) return value;
      if (level >= maxDepth) continue;

      let keys;
      try { keys = Object.getOwnPropertyNames(value); } catch { continue; }
      for (const key of keys) {
        if (SKIP.has(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (!child || typeof child !== 'object' || child === value || seen.has(child)) continue;
        queue.push({ value: child, level: level + 1 });
      }
    }
    return null;
  }

  const found = {
    scene: scan(isScene),
    renderer: scan(isRenderer),
    three: scan(isThreeNamespace, { maxDepth: 2 }),
  };
  // A perspective camera first: the one a game looks through is almost always
  // one, and the ones it does not are shadow cameras and fitting rigs.
  if (found.scene) found.camera = scan(isPerspectiveCamera, { maxDepth: 8, roots: [found.scene] });
  if (!found.camera && found.scene) found.camera = scan(isCamera, { maxDepth: 8, roots: [found.scene] });
  if (!found.camera) found.camera = scan(isPerspectiveCamera);
  if (!found.camera) found.camera = scan(isCamera);
  found.composer = scan(isComposer);
  if (!found.renderer && found.composer) found.renderer = found.composer.renderer;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    active: false,
    frozen: false,
    useComposer: !!found.composer,
    showBounds: false,
    target: { x: 0, y: 1, z: 0 },
    yaw: 0,
    pitch: 0.5,
    distance: 12,
    picked: null,
    frames: 0,
    fps: 0,
    error: null,
  };

  const realRAF = window.requestAnimationFrame.bind(window);
  const realCAF = window.cancelAnimationFrame.bind(window);
  const listeners = [];
  let rafId = 0;
  let fpsMark = 0;
  let fpsFrames = 0;

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }

  // ---------------------------------------------------------------------------
  // Taking the camera
  // ---------------------------------------------------------------------------

  function readInitialPose() {
    const camera = found.camera;
    if (!camera?.position) return;
    camera.updateMatrixWorld?.(true);
    const e = camera.matrixWorld?.elements;
    // The camera looks down its own -Z, so the third column of its world matrix
    // points backwards.
    let fx = -1;
    let fy = 0;
    let fz = 0;
    if (e) {
      const length = Math.hypot(e[8], e[9], e[10]) || 1;
      fx = -e[8] / length; fy = -e[9] / length; fz = -e[10] / length;
    }
    const distance = state.distance;
    state.target = {
      x: camera.position.x + fx * distance,
      y: camera.position.y + fy * distance,
      z: camera.position.z + fz * distance,
    };
    // A game camera is usually pitched well down, so a target a fixed distance
    // along its view can land under the floor -- and an orbit pivot under the
    // floor swings you underground the moment you rotate. The world's floor is
    // at y = 0 in every engine that uses the usual y-up convention. This only
    // ever raises the pivot, and panning moves it wherever you want.
    state.target.y = Math.max(state.target.y, 0);
    state.pitch = Math.asin(Math.max(-1, Math.min(1, -fy)));
    state.yaw = Math.atan2(-fx, -fz);
    state.distance = distance;
  }

  /** The pose the game's camera was in when the inspector arrived. */
  let homePose = null;

  /**
   * Back to where the game was looking.
   *
   * Not "frame the whole scene": a game's scene is usually a small play area
   * inside a very large ground and sky, so framing all of it puts the camera a
   * quarter of a kilometre up looking at nothing. The useful place to return to
   * is the one the game itself chose.
   */
  function resetView() {
    if (!homePose) return;
    state.target = { ...homePose.target };
    state.yaw = homePose.yaw;
    state.pitch = homePose.pitch;
    state.distance = homePose.distance;
  }

  // Where you were looking, remembered per tab.
  //
  // A refresh used to put you back at the game's camera pose, which is the same
  // place every time: you would fly somewhere, lose it to a reload, and start
  // again. sessionStorage is per tab, so a fresh launch still starts fresh.
  const POSE_KEY = 'game-inspector:pose';

  function savePose() {
    try {
      sessionStorage.setItem(POSE_KEY, JSON.stringify({
        target: state.target,
        yaw: state.yaw,
        pitch: state.pitch,
        distance: state.distance,
        // Paused is part of where you were: coming back from a reload with the
        // world suddenly running is not what "still there" means.
        paused: state.frozen,
      }));
    } catch { /* private mode, or storage full: the pose is a convenience, not a need */ }
  }

  function loadPose() {
    try {
      const pose = JSON.parse(sessionStorage.getItem(POSE_KEY) ?? 'null');
      const finite = (v) => typeof v === 'number' && Number.isFinite(v);
      if (!pose?.target) return null;
      if (!['x', 'y', 'z'].every((axis) => finite(pose.target[axis]))) return null;
      if (!['yaw', 'pitch', 'distance'].every((key) => finite(pose[key]))) return null;
      return pose;
    } catch {
      return null;
    }
  }

  function clearPose() {
    try { sessionStorage.removeItem(POSE_KEY); } catch { /* nothing to clear */ }
  }

  function applySavedPose() {
    const pose = loadPose();
    if (!pose) return false;
    state.target = { ...pose.target };
    state.yaw = pose.yaw;
    state.pitch = pose.pitch;
    state.distance = pose.distance;
    if (pose.paused) freeze();
    return true;
  }

  function basis() {
    const cp = Math.cos(state.pitch);
    const dir = { x: cp * Math.sin(state.yaw), y: Math.sin(state.pitch), z: cp * Math.cos(state.yaw) };
    const forward = { x: -dir.x, y: -dir.y, z: -dir.z };
    const right = { x: -forward.z, y: 0, z: forward.x };
    const rl = Math.hypot(right.x, right.y, right.z) || 1;
    right.x /= rl; right.z /= rl;
    const up = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    };
    return { dir, forward, right, up };
  }

  function applyCamera() {
    const camera = found.camera;
    if (!camera) return;
    const { dir } = basis();
    const eye = {
      x: state.target.x + dir.x * state.distance,
      y: state.target.y + dir.y * state.distance,
      z: state.target.z + dir.z * state.distance,
    };
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(state.target.x, state.target.y, state.target.z);
    camera.updateMatrixWorld?.(true);
  }

  // ---------------------------------------------------------------------------
  // Freezing the game
  //
  // requestAnimationFrame is the one door every game's loop goes through. Swallow
  // the callbacks and the loop stops scheduling itself after one more frame,
  // with no cooperation at all from the game. It only fails if the game kept a
  // private reference to the original function before this ran.
  // ---------------------------------------------------------------------------

  // Callbacks asked for while the loop is frozen. They are held rather than
  // dropped, because a game schedules its next frame from inside the current
  // one: throw that request away and the loop is dead for good, and thawing
  // would only hand back a requestAnimationFrame that nobody was going to call.
  const held = new Map();
  let heldId = 0;

  function freeze() {
    if (state.frozen) return;
    window.requestAnimationFrame = (callback) => {
      const id = --heldId; // negative, so it cannot collide with a real handle
      held.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => { held.delete(id); };
    state.frozen = true;
  }

  function thaw() {
    if (!state.frozen) return;
    window.requestAnimationFrame = realRAF;
    window.cancelAnimationFrame = realCAF;
    state.frozen = false;
    const queued = [...held.values()];
    held.clear();
    // Restored before the replay, so the loop that comes back schedules its
    // next frame against the real thing.
    for (const callback of queued) realRAF(callback);
  }

  // ---------------------------------------------------------------------------
  // Drawing. Prefer the game's own renderer, so the picture is the game's
  // picture. If the game kept it private -- which is common, the renderer is
  // often not on any global -- build one from the Three.js namespace if the
  // page has one, on a canvas laid over the game's. Failing both, say so.
  // ---------------------------------------------------------------------------

  let ownRenderer = null;
  let ownCanvas = null;
  const hijacked = [];
  let drawComposer = null;
  let drawRenderer = null;
  // How many times the game has asked to draw since we took the job off it.
  // Not a problem to be fixed: it is how you tell a game that is playing but
  // hidden from a game that has stopped.
  let swallowed = 0;

  /**
   * Take the game's draw call away from it.
   *
   * Two reasons, and both of them are what make playing the game while
   * inspecting it possible. Only one renderer can own a light's shadow map, so
   * a game painting the same scene alongside us gives broken shadows. And
   * whichever of the two draws last is the one you see, so leaving both in
   * would make the picture depend on the order the browser happens to run its
   * frame callbacks in.
   *
   * The game keeps simulating, animating and reading input. It just stops
   * painting, and the inspector paints instead.
   */
  function takeOverDrawing() {
    const hijack = (object, key) => {
      if (!object || typeof object[key] !== 'function') return null;
      const original = object[key];
      object[key] = function inspectorDrawsThisNow() { swallowed++; };
      hijacked.push({ object, key, original });
      return (...args) => original.apply(object, args);
    };
    // The composer first: it calls the renderer underneath it, so grabbing the
    // renderer alone would swallow the inspector's own draw as well.
    drawComposer = hijack(found.composer, 'render');
    drawRenderer = hijack(found.renderer, 'render');
  }

  function releaseDrawing() {
    for (const { object, key, original } of hijacked.splice(0)) {
      try { object[key] = original; } catch { /* the object went away with the page */ }
    }
    drawComposer = null;
    drawRenderer = null;
  }

  function ensureRenderer() {
    if (found.renderer || ownRenderer) return true;
    if (!found.three) return false;
    const THREE = found.three;
    ownCanvas = document.createElement('canvas');
    ownCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;'
      + 'z-index:2147482000;background:#000;display:block';
    document.body.appendChild(ownCanvas);
    // preserveDrawingBuffer costs a little speed and buys reliable screenshots:
    // without it the browser may hand back a cleared buffer, which makes a tool
    // for looking at things unable to show anyone what it saw. It only affects
    // the canvas the inspector owns.
    ownRenderer = new THREE.WebGLRenderer({ canvas: ownCanvas, antialias: true, preserveDrawingBuffer: true });
    ownRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    ownRenderer.setSize(window.innerWidth, window.innerHeight, false);
    // Match the two settings that change how the scene looks, so the picture
    // is recognisably the game's rather than a flat default.
    if (THREE.PCFSoftShadowMap !== undefined) {
      ownRenderer.shadowMap.enabled = true;
      ownRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    if (THREE.ACESFilmicToneMapping !== undefined) ownRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    return true;
  }

  function resizeOwnCanvas() {
    if (!ownRenderer) return;
    ownRenderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  function renderFrame() {
    if (!state.active) return;
    applyCamera();
    try {
      if (state.useComposer && drawComposer) drawComposer();
      else if (drawRenderer) drawRenderer(found.scene, found.camera);
      else if (ownRenderer) ownRenderer.render(found.scene, found.camera);
      state.error = null;
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
    }
    state.frames++;
    fpsFrames++;
    const now = performance.now();
    if (!fpsMark) fpsMark = now;
    else if (now - fpsMark > 500) {
      state.fps = Math.round((fpsFrames * 1000) / (now - fpsMark));
      fpsMark = now;
      fpsFrames = 0;
      updatePanel();
    }
    if (state.showBounds) drawBounds();
    rafId = realRAF(renderFrame);
  }

  // ---------------------------------------------------------------------------
  // Overlay: a 2D canvas for boxes, and a panel in a shadow root so the page's
  // CSS cannot reach it.
  // ---------------------------------------------------------------------------

  const overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483000';
  const ctx2d = overlay.getContext('2d');

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483001';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .panel {
        position: absolute; top: 12px; left: 12px; min-width: 232px;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #e8e6df; background: rgba(12, 15, 20, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px;
        padding: 10px 12px; pointer-events: auto; backdrop-filter: blur(8px);
        white-space: pre; letter-spacing: 0.02em;
      }
      .panel b { color: #ffd479; font-weight: 600; }
      .panel .dim { color: rgba(232, 230, 223, 0.55); }
      .panel .bad { color: #ff8080; }
      .panel .good { color: #9ef29e; }
      .panel .key { color: #9fd0ff; }
      .panel .row { display: flex; gap: 6px; margin-top: 8px; }
      .panel button {
        font: inherit; letter-spacing: 0.06em; text-transform: uppercase;
        color: inherit; background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 5px;
        padding: 4px 8px; cursor: pointer; pointer-events: auto; flex: 1;
      }
      .panel button:hover { background: rgba(255, 255, 255, 0.15); }
      .panel button.play { color: #9ef29e; }
      .panel button.pause { color: #ffd479; }
    </style>
    <div class="panel"></div>`;
  const panel = shadow.querySelector('.panel');

  // One listener on the shadow root rather than on the buttons: the panel's
  // markup is rebuilt on every update, and delegated handlers survive that.
  shadow.addEventListener('click', (event) => {
    const action = event.target?.dataset?.act;
    if (!action) return;
    event.stopPropagation();
    if (action === 'pause') { if (state.frozen) thaw(); else freeze(); }
    else if (action === 'reset') resetView();
    else if (action === 'stop') { stop(); return; }
    updatePanel();
  });

  /** Is this event from the panel? It is the one thing on the page that is ours to click. */
  function insidePanel(event) {
    const path = event.composedPath?.() ?? [];
    return path.includes(host) || path.some((node) => node?.classList?.contains?.('panel'));
  }

  function line(label, value, cls = '') {
    return `${label.padEnd(8)} ${cls ? `<span class="${cls}">${value}</span>` : value}\n`;
  }

  /** Which renderer the picture on screen is coming from. */
  function renderMode() {
    if (state.useComposer && found.composer) return 'composer';
    if (found.renderer) return 'the game\'s';
    if (ownRenderer) return 'its own';
    return 'not found';
  }

  function updatePanel() {
    if (!state.active) return;
    savePose();
    const stats = found.scene ? sceneStats(found.scene) : null;
    const cam = found.camera?.position;
    const mode = renderMode();
    const drawn = (ownRenderer ?? found.renderer)?.info?.render;
    let html = '<b>game-inspector</b>\n';
    html += line('scene', found.scene ? `ok (${stats.objects} objects)` : 'not found', found.scene ? '' : 'bad');
    html += line('camera', found.camera ? (found.camera.type ?? 'ok') : 'not found', found.camera ? '' : 'bad');
    html += line('render', mode, found.renderer || ownRenderer ? '' : 'bad');
    if (stats) html += line('', `${stats.meshes} meshes, ${stats.triangles.toLocaleString()} tris`);
    // Not every renderer keeps counts here, and a game's own may keep none.
    if (drawn && Number.isFinite(drawn.triangles)) {
      html += line('drawn', `${drawn.calls ?? 0} calls, ${drawn.triangles.toLocaleString()} tris`);
    }
    html += line('state', state.frozen ? 'paused' : 'playing', state.frozen ? 'pause' : 'good');
    html += line('fps', String(state.fps));
    if (cam) html += line('eye', `${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}, ${cam.z.toFixed(1)}`);
    html += line('target', `${state.target.x.toFixed(1)}, ${state.target.y.toFixed(1)}, ${state.target.z.toFixed(1)}`);
    html += line('dist', state.distance.toFixed(2));
    if (state.picked) {
      const p = state.picked;
      html += line('picked', `${p.name} (${p.meshes} meshes)`);
      html += line('', `${p.size.x.toFixed(2)} x ${p.size.y.toFixed(2)} x ${p.size.z.toFixed(2)}`);
    }
    if (state.error) html += line('error', state.error, 'bad');
    html += '\n<span class="dim">drag orbit &middot; wheel zoom &middot; right/shift pan</span>\n';
    html += '<span class="dim">click pick &middot; </span><span class="key">B</span><span class="dim"> bounds &middot; </span>'
      + '<span class="key">C</span><span class="dim"> composer &middot; </span><span class="key">R</span><span class="dim"> reset view &middot; </span>'
      + '<span class="key">Esc</span><span class="dim"> stop</span>';
    html += '<div class="row">'
      + `<button data-act="pause" class="${state.frozen ? 'play' : 'pause'}">${state.frozen ? 'Play' : 'Pause'}</button>`
      + '<button data-act="reset">Reset view</button>'
      + '<button data-act="stop">Stop</button>'
      + '</div>';
    panel.innerHTML = html;
  }

  /** Draw a world box as 12 screen-space edges. No THREE, just projection. */
  function strokeBox(box, colour) {
    const camera = found.camera;
    if (!camera) return;
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    const corners = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) corners.push({ x, y, z });
      }
    }
    const screen = corners.map((c) => {
      const p = project(camera, c);
      if (!p) return null;
      return { x: (p.x * 0.5 + 0.5) * w, y: (1 - (p.y * 0.5 + 0.5)) * h };
    });
    const edges = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
    ctx2d.strokeStyle = colour;
    ctx2d.lineWidth = 1;
    for (const [a, b] of edges) {
      const p = screen[a];
      const q = screen[b];
      if (!p || !q) continue;
      ctx2d.beginPath();
      ctx2d.moveTo(p.x, p.y);
      ctx2d.lineTo(q.x, q.y);
      ctx2d.stroke();
    }
  }

  function drawBounds() {
    if (!ctx2d) return;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, overlay.width, overlay.height);
    const scale = window.devicePixelRatio || 1;
    if (overlay.width !== Math.floor(overlay.clientWidth * scale)) {
      overlay.width = Math.floor(overlay.clientWidth * scale);
      overlay.height = Math.floor(overlay.clientHeight * scale);
      ctx2d.setTransform(scale, 0, 0, scale, 0, 0);
    }
    if (state.picked?.box) strokeBox(state.picked.box, 'rgba(255, 212, 121, 0.95)');
  }

  // ---------------------------------------------------------------------------
  // Picking. Nearest projected centre wins, which is approximate and good
  // enough for "what am I looking at".
  // ---------------------------------------------------------------------------

  function pick(screenX, screenY, radius = 40) {
    const scene = found.scene;
    const camera = found.camera;
    if (!scene || !camera) return null;
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    const scale = window.devicePixelRatio || 1;
    const x = screenX * scale;
    const y = screenY * scale;
    let best = null;

    walk(scene, (object, visible) => {
      const geometry = object.geometry;
      if (!geometry || !visible) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox?.();
      const box = geometry.boundingBox;
      if (!box || !object.matrixWorld) return;
      const c = applyMatrix4(object.matrixWorld, (box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      if (!isFinite3(c)) return;
      const p = project(camera, c);
      if (!p) return;
      const sx = (p.x * 0.5 + 0.5) * w * scale;
      const sy = (1 - (p.y * 0.5 + 0.5)) * h * scale;
      const away = Math.hypot(sx - x, sy - y);
      if (away > radius * scale) return;
      if (!best || away < best.away - 1 || (Math.abs(away - best.away) <= 1 && p.depth < best.depth)) {
        best = { object, away, depth: p.depth };
      }
    });

    if (!best) return null;
    const box = boundsOf(best.object);
    const label = best.object.name || best.object.type || 'Mesh';
    const parent = best.object.parent;
    const parentName = parent?.name || parent?.type || 'scene';
    return {
      name: parentName === 'scene' ? label : `${parentName} / ${label}`,
      meshes: box?.meshes ?? 1,
      box,
      centre: box?.center ?? null,
      size: box?.size ?? null,
      position: best.object.position
        ? { x: best.object.position.x, y: best.object.position.y, z: best.object.position.z }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Input. Captured on the way down and stopped there, so the game underneath
  // never sees the gestures meant for the inspector.
  // ---------------------------------------------------------------------------

  function shield(type, handler, options = {}) {
    listen(window, type, (event) => {
      if (!state.active) return;
      if (insidePanel(event)) return; // the panel is ours to click
      handler(event);
      event.stopPropagation();
      event.preventDefault?.();
    }, { capture: true, passive: false, ...options });
  }

  let drag = null;

  function installInput() {
    shield('pointerdown', (event) => {
      drag = { x: event.clientX, y: event.clientY, button: event.button, moved: 0, shift: event.shiftKey };
      try { event.target?.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointers cannot be captured */ }
    });

    shield('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.button === 2 || drag.button === 1 || drag.shift) pan(dx, dy);
      else orbit(dx, dy);
      updatePanel();
    });

    shield('pointerup', (event) => {
      if (drag && drag.moved < 4) {
        state.picked = pick(event.clientX, event.clientY);
        updatePanel();
      }
      drag = null;
    });

    shield('wheel', (event) => {
      dolly(Math.pow(1.0015, event.deltaY));
      updatePanel();
    });

    shield('keydown', (event) => {
      const step = state.distance * 0.06;
      const { forward, right } = basis();
      switch (event.key) {
        case 'w': moveTarget(forward, step); break;
        case 's': moveTarget(forward, -step); break;
        case 'a': moveTarget(right, -step); break;
        case 'd': moveTarget(right, step); break;
        case 'q': case 'PageDown': moveY(-step); break;
        case 'e': case 'PageUp': moveY(step); break;
        case 'ArrowUp': orbit(0, -8); break;
        case 'ArrowDown': orbit(0, 8); break;
        case 'ArrowLeft': orbit(-8, 0); break;
        case 'ArrowRight': orbit(8, 0); break;
        case '+': case '=': dolly(0.9); break;
        case '-': case '_': dolly(1.1); break;
        case 'f': case 'F': case 'p': case 'P': state.frozen ? thaw() : freeze(); break;
        case 'b': case 'B': state.showBounds = !state.showBounds; break;
        case 'c': case 'C': state.useComposer = !state.useComposer; break;
        case 'r': case 'R': resetView(); break;
        case 'Escape': stop(); return;
        default: return;
      }
      updatePanel();
    });
  }

  function orbit(dx, dy) {
    state.yaw -= dx * 0.005;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + dy * 0.005));
  }

  function dolly(factor) {
    state.distance = Math.max(0.2, Math.min(2000, state.distance * factor));
  }

  function pan(dx, dy) {
    const { right, up } = basis();
    const scale = state.distance * 0.0016;
    moveTarget(right, -dx * scale);
    moveTarget(up, dy * scale);
  }

  function moveTarget(axis, amount) {
    state.target.x += axis.x * amount;
    state.target.y += axis.y * amount;
    state.target.z += axis.z * amount;
  }

  function moveY(amount) {
    state.target.y += amount;
  }

  /** Frame what is actually drawn, ignoring the sky-sized things around it. */
  function reframe() {
    const scene = found.scene;
    if (!scene) return;
    const box = boundsOf(scene);
    if (!box) return;
    const diagonal = Math.hypot(box.size.x, box.size.y, box.size.z);
    state.target = {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2,
    };
    state.distance = Math.max(1, Math.min(diagonal * 0.5, 400));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start() {
    if (state.active) return;
    if (!found.scene || !found.camera) {
      state.error = `no ${!found.scene ? 'scene' : 'camera'} found in this page`;
      return;
    }
    if (!ensureRenderer()) {
      state.error = 'found the scene and the camera, but nothing to draw with: no renderer '
        + 'is reachable and the page has no Three.js namespace. Expose one of them in dev '
        + '(window.THREE = THREE, or the renderer itself) to make this game inspectable.';
      return;
    }
    readInitialPose();
    homePose = {
      target: { ...state.target }, yaw: state.yaw, pitch: state.pitch, distance: state.distance,
    };
    const restored = applySavedPose();
    takeOverDrawing();
    document.body?.appendChild(overlay);
    document.body?.appendChild(host);
    if (ownRenderer) listen(window, 'resize', resizeOwnCanvas);
    installInput();
    // Deliberately not frozen. Taking the draw call is what makes the camera
    // safe, so the game can keep running: animations keep animating, trains
    // keep moving, and the world is not the same frozen place every time.
    // Pausing is a button, for when you want it to hold still.
    state.active = true;
    state.restored = restored;
    fpsMark = 0;
    updatePanel();
    rafId = realRAF(renderFrame);
  }

  function stop() {
    if (!state.active) {
      thaw();
      restoreRAF();
      return;
    }
    state.active = false;
    realCAF(rafId);
    for (const off of listeners.splice(0)) {
      try { off(); } catch { /* already gone */ }
    }
    releaseDrawing();
    overlay.remove();
    host.remove();
    if (ctx2d) ctx2d.clearRect(0, 0, overlay.width, overlay.height);
    // A renderer we built is ours to dispose: leaving it around holds a WebGL
    // context open for the rest of the session.
    if (ownRenderer) {
      try { ownRenderer.dispose(); } catch { /* nothing to dispose */ }
      ownRenderer = null;
    }
    if (ownCanvas) {
      ownCanvas.remove();
      ownCanvas = null;
    }
    thaw();
    restoreRAF();
  }

  function restoreRAF() {
    window.requestAnimationFrame = realRAF;
    window.cancelAnimationFrame = realCAF;
  }

  // ---------------------------------------------------------------------------

  window[KEY] = {
    get active() { return state.active; },
    state,
    found: {
      get scene() { return found.scene; },
      get camera() { return found.camera; },
      get renderer() { return found.renderer; },
      get composer() { return found.composer; },
    },
    start,
    stop,
    freeze,
    thaw,
    /** Pause or resume the game's loop. The camera stays where you put it either way. */
    pause(on = true) { if (on) freeze(); else thaw(); },
    orbit,
    dolly,
    pan,
    pick,
    resetView,
    reframe,
    clearPose,
    updatePanel,
    status() {
      const stats = found.scene ? sceneStats(found.scene) : null;
      const cam = found.camera?.position;
      return {
        active: state.active,
        frozen: state.frozen,
        found: {
          scene: !!found.scene,
          camera: !!found.camera,
          renderer: !!found.renderer,
          composer: !!found.composer,
          three: !!found.three,
          children: found.scene ? found.scene.children.length : 0,
        },
        renderMode: found.composer && state.useComposer ? 'composer'
          : found.renderer ? 'game' : ownRenderer ? 'own' : 'none',
        // Did the inspector take the game's draw call, and where you left the
        // camera remembered for next time.
        suppressed: hijacked.length > 0,
        swallowed,
        restored: !!state.restored,
        // What the renderer actually submitted last frame. "The loop is
        // running" and "the picture is being drawn" are different claims, and
        // the second is the one that matters when the screen looks empty.
        drawn: (() => {
          const info = (ownRenderer ?? found.renderer)?.info?.render;
          if (!info || !Number.isFinite(info.triangles)) return null;
          return { calls: info.calls ?? 0, triangles: info.triangles };
        })(),
        stats,
        frames: state.frames,
        fps: state.fps,
        error: state.error,
        camera: cam ? { x: cam.x, y: cam.y, z: cam.z } : null,
        target: { ...state.target },
        distance: state.distance,
        picked: state.picked
          ? { name: state.picked.name, meshes: state.picked.meshes, size: state.picked.size }
          : null,
        overlay: !!overlay.parentNode,
        panel: !!host.parentNode,
      };
    },
  };

  try {
    window[KEY].start();
    return JSON.stringify(window[KEY].status());
  } catch (err) {
    return JSON.stringify({ error: String(err && err.message ? err.message : err) });
  }
})();
