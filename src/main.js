// Entry point: picks a session (local or multiplayer), wires input, HUD and the render loop.
//
// URL options:
//   ?seed=123            new local world from a seed
//   ?server=ws://host:8787&room=valley&name=Ada   join a multiplayer world
//   ?demo=18             let a settler bot build a village for 18 days first (local, fixed seed)
//   ?hour=17             start the demo at this hour of the day
//   ?view=map            start in the overhead map view (default: first person)
//   ?cam=dist,yaw,pitch  map camera     ?look=yaw,pitch[,dx,dz]  first-person look (and offset from home)
//   ?at=x,y              stand on this cell (first person)
//   ?build=menu|<type>   open the build menu, or start placing a building type
//   ?hud=0               hide the HUD (for screenshots)    ?mobile=1  force touch UI
//   ?warmth=30           start the walker this cold (testing)
import { LocalSession, RemoteSession } from './net/session.js';
import { GameView } from './render/view.js';
import { Hud, previewTip, cellTip } from './ui/hud.js';
import { TouchControls, isTouchDevice } from './ui/touch.js';
import { T, DEFS } from './sim/rules.js';
import { Bot, findHome } from './sim/bot.js';
import { HOURS } from './sim/climate.js';
import { decodeSave } from './sim/engine.js';
import { N } from './sim/world.js';
import { Rng } from './sim/prng.js';
import { stepNeeds, envAt, coldSpeed, replayAway, wakeAtHome } from './player/needs.js';

const params = new URLSearchParams(location.search);
const hudRoot = document.getElementById('hud');
hudRoot.innerHTML = '<div class="loading">Growing a world…</div>';
const touch = params.get('mobile') === '1' || (params.get('mobile') !== '0' && isTouchDevice());
if (touch) document.body.classList.add('touchmode');

async function makeSession() {
  if (params.get('server')) {
    const s = new RemoteSession(params.get('server'), params.get('room') || 'lobby', params.get('name') || 'Settler', (m) => hud?.toast(m, 4000));
    return s.ready;
  }
  if (params.has('seed')) return new LocalSession({ seed: Number(params.get('seed')) >>> 0 });
  if (params.has('demo')) return new LocalSession({ seed: Number(params.get('demoseed') ?? 20261031) >>> 0 });
  return new LocalSession({});
}

let hud = null;

// Closest cell (at least a few cells from home) with open, dry, flat ground around it.
function openGroundNear(engine, hx, hy) {
  const { world, state } = engine;
  const open = (x, y) => {
    if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) return false;
    const i = y * N + x;
    return !state.occ[i] && !world.water[i] && state.trees[i] < 150 && world.slope[i] < 120;
  };
  for (let r = 6; r < 40; r++) {
    for (let a = 0; a < 64; a++) {
      const x = Math.round(hx + Math.cos((a / 64) * Math.PI * 2) * r), y = Math.round(hy + Math.sin((a / 64) * Math.PI * 2) * r);
      if (open(x, y) && open(x + 1, y) && open(x - 1, y) && open(x, y + 1) && open(x, y - 1)) return [x, y];
    }
  }
  return [hx, hy];
}

async function start() {
  await new Promise((r) => setTimeout(r, 30)); // let the loading text paint
  const session = await makeSession();
  const engine = session.engine;

  // Demo: a bot builds a village, then we jump to the requested hour.
  if (params.has('demo') && session.mode === 'local' && engine.log.length === 0) {
    const days = Number(params.get('demo')) || 18;
    const bot = new Bot(engine, session.owner, 7);
    for (let t = 0; t < days * HOURS; t++) {
      if (t % 30 === 0) { const e = bot.think(); if (e) engine.add(e); }
      engine.advanceTo(t + 1);
    }
    const hour = Number(params.get('hour') ?? 10);
    const end = engine.state.tick + ((hour - (engine.state.tick % HOURS) + HOURS) % HOURS);
    engine.advanceTo(end);
    session.target = end;
  }
  if (params.get('speed') !== null) session.speed = Number(params.get('speed'));

  const view = new GameView(document.getElementById('view'), engine, { mobile: touch });
  const ui = {
    tool: 0, size: 3, seed: engine.seed, speed: session.speed, overlay: 0, rollSeed: (Math.random() * 2 ** 32) >>> 0,
    hover: null, mouse: { x: innerWidth / 2, y: innerHeight / 2 }, viewMode: 'fp', locked: false, touch,
  };

  // Start at our own village, or at a promising spot for a new one.
  const mine = engine.state.buildings.filter((b) => b.owner === session.owner && b.alive);
  let home;
  if (mine.length) home = [mine[0].x + mine[0].s + 1, mine[0].y + mine[0].s + 1];
  else home = findHome(engine.world, engine.state, session.owner, new Rng(engine.seed ^ session.owner)) || [N / 2, N / 2];
  // Stand in a nearby clearing, facing the village.
  const spawn = openGroundNear(engine, home[0], home[1]);
  view.focus(spawn[0] + 0.5 - N / 2, spawn[1] + 0.5 - N / 2);
  view.fp.yaw = Math.atan2(-(home[0] - spawn[0]), -(home[1] - spawn[1]));
  if (params.get('at')) {
    const [ax, ay] = params.get('at').split(',').map(Number);
    view.focus(ax + 0.5 - N / 2, ay + 0.5 - N / 2);
  }
  if (params.get('look')) {
    const [yaw, pitch, dx = 0, dz = 0] = params.get('look').split(',').map(Number);
    if (dx || dz) view.focus(home[0] - N / 2 + dx, home[1] - N / 2 + dz);
    view.fp.yaw = yaw; view.fp.pitch = pitch;
  }

  // The walker: pick up where we left off (position, warmth, wetness). If time passed while we were
  // away, replay their needs against the weather; if the cold got them, they wake at their last house.
  const ps = session.player;
  const spawnPos = [spawn[0] + 0.5 - N / 2, spawn[1] + 0.5 - N / 2];
  let awayNote = null;
  if (ps.x !== null && Number.isFinite(ps.x)) {
    if (session.awayTicks > 0) {
      if (session.mode === 'remote') engine.advanceTo(session.serverTick());
      if (replayAway(engine.world, engine.state, engine.seed, ps, session.awayFrom, session.awayFrom + session.awayTicks, session.owner, spawnPos) === 'faint')
        awayNote = 'You got too cold while you were away, and woke up warm by the fire at your house.';
    }
    if (!params.get('at') && !params.get('look')) { view.focus(ps.x, ps.z); view.fp.yaw = ps.yaw; }
  }

  if (params.has('warmth')) ps.warmth = Number(params.get('warmth'));
  if (params.get('view') === 'map' || params.get('cam')) {
    view.setMode('map');
    if (params.get('cam')) {
      const [d, y, p] = params.get('cam').split(',').map(Number);
      Object.assign(view.map.goal, { dist: d, yaw: y, pitch: p });
      Object.assign(view.map, { dist: d, yaw: y, pitch: p });
    }
  }

  hud = new Hud(hudRoot, {
    menu: () => openMenu(session),
    speed: (s) => setSpeed(s),
    tool: (t) => { selectTool(t); ui.menuOpen = false; },
    size: (d) => resize(d),
    reroll: () => { ui.rollSeed = (Math.random() * 2 ** 32) >>> 0; },
    cancel: () => { ui.tool = 0; ui.menuOpen = false; },
    goHere: () => goHere(),
    // Build button: opens/closes the menu; while placing on touch it confirms.
    buildButton: () => {
      if (ui.tool && touch) placeCurrent();
      else if (ui.tool) ui.tool = 0;
      else ui.menuOpen = !ui.menuOpen;
    },
  });
  if (params.get('hud') === '0') hudRoot.style.display = 'none';
  // Debug: hide a layer by name (?hide=mist,grass,weather,bloom) to track down visual artifacts.
  for (const h of (params.get('hide') || '').split(',')) {
    if (h === 'mist' && view.water.mist) view.water.mist.visible = false;
    if (h === 'grass') view.grass.mesh.visible = false;
    if (h === 'weather') view.fx.group.visible = false;
    if (h === 'bloom') view.post.bloom.enabled = false;
  }
  if (params.get('build') === 'menu') ui.menuOpen = true;
  else if (params.get('build')) selectTool(Number(params.get('build')));
  if (session.offlineTicks > HOURS) hud.toast(`While you were away, ${Math.round(session.offlineTicks / HOURS)} days passed.${awayNote ? ' ' + awayNote : ''}`, 6000);
  else if (awayNote) hud.toast(awayNote, 6000);
  if (session.mode === 'remote') hud.toast(`Joined as player ${session.owner}`);

  function setSpeed(s) {
    if (session.mode !== 'local') { hud.toast('Multiplayer runs on the server clock'); return; }
    session.speed = s; ui.speed = s;
  }
  function selectTool(t) {
    ui.tool = ui.tool === t ? 0 : t;
    const def = DEFS[ui.tool];
    if (def) ui.size = Math.min(Math.max(ui.size, def.sizes[0]), def.sizes[1]);
    ui.rollSeed = (Math.random() * 2 ** 32) >>> 0;
  }
  function resize(d) {
    const def = DEFS[ui.tool];
    if (!def) return;
    ui.size = Math.min(Math.max(ui.size + d, def.sizes[0]), def.sizes[1]);
  }
  // Map view: walk from the pin at the screen centre.
  function goHere() {
    if (view.mode !== 'map') return;
    const t = view.map.goal.target;
    const cx = Math.floor(t.x + N / 2), cy = Math.floor(t.z + N / 2);
    if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1) { hud.toast('Move the pin onto the island'); return; }
    const i = cy * N + cx, id = engine.state.occ[i];
    if (id && [T.HOUSE, T.MILL].includes(engine.state.buildings[id - 1].type)) { hud.toast('Move the pin off the building'); return; }
    if (engine.world.water[i]) { hud.toast('Move the pin onto dry land'); return; }
    view.teleport(t.x, t.z);
    toggleView();
  }
  function toggleView() {
    view.setMode(view.mode === 'fp' ? 'map' : 'fp');
    ui.viewMode = view.mode;
    ui.hover = null; ui.moved = true;
  }
  const currentEntry = () => {
    if (!ui.tool || !ui.hover) return null;
    const s = ui.tool === T.DEMOLISH ? 1 : ui.size;
    const off = ui.tool === T.DEMOLISH ? 0 : Math.floor(s / 2);
    return { type: ui.tool, x: ui.hover.x - off, y: ui.hover.y - off, s, seed: ui.rollSeed, owner: session.owner, tick: engine.state.tick };
  };
  function placeCurrent() {
    const entry = currentEntry();
    if (!entry) { hud.toast(ui.tool ? 'Look at open ground to build' : 'Pick something to build first'); return; }
    const reason = engine.check(entry);
    if (reason) { hud.toast(reason); return; }
    session.place(entry);
    ui.rollSeed = (Math.random() * 2 ** 32) >>> 0;
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,textarea')) return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '5') { selectTool([T.HOUSE, T.FARM, T.MILL, T.PARK, T.BEACON][k - 1]); ui.menuOpen = false; }
    else if (k === 'x') { selectTool(T.DEMOLISH); ui.menuOpen = false; }
    else if (k === 'b') { if (ui.tool) ui.tool = 0; ui.menuOpen = !ui.menuOpen; }
    else if (k === 'escape') { ui.tool = 0; ui.menuOpen = false; closeMenu(); }
    else if (k === '[') resize(-1);
    else if (k === ']') resize(1);
    else if (k === 'r') ui.rollSeed = (Math.random() * 2 ** 32) >>> 0;
    else if (k === 'f') ui.overlay = ui.overlay === 1 ? 0 : 1;
    else if (k === 't') ui.overlay = ui.overlay === 2 ? 0 : 2;
    else if (k === 'o') view.paint = !view.paint;
    else if (k === 'm') openMenu(session);
    else if (k === 'tab') { e.preventDefault(); toggleView(); }
    else if (k === 'g') goHere();
    else if (k === 'p' || (k === ' ' && view.mode === 'map')) { setSpeed(session.speed ? 0 : 1); e.preventDefault(); }
    else if (k === ' ') e.preventDefault();
  });
  const canvas = view.renderer.domElement;
  canvas.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') { ui.mouse = { x: e.clientX, y: e.clientY }; ui.moved = true; } });
  canvas.addEventListener('pointerleave', () => { if (view.mode === 'map') ui.hover = null; });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (view.mode === 'fp' && !view.fp.locked) { view.fp.lock(); return; }
    if (ui.tool) placeCurrent();
  });
  canvas.addEventListener('wheel', (e) => { if (view.mode === 'fp' && ui.tool) resize(e.deltaY > 0 ? -1 : 1); }, { passive: true });

  if (touch) {
    ui.touchCtl = new TouchControls(hudRoot, canvas, view, {
      toggleMap: toggleView,
      // Map view on touch: building happens at the centre pin; a tap glides the map to that spot.
      tapAt: (x, y) => { const h = view.pick(x, y); if (h) view.map.goal.target.set(h.p.x, 0, h.p.z); },
    });
  }

  let lastFrame = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 1000, 0.25);
    lastFrame = now;
    const caughtUp = session.advance(dt);
    ui.locked = view.fp.locked;
    ui.viewMode = view.mode;
    // First person aims with the crosshair; the map aims with the mouse (or the last tap).
    if (view.mode === 'fp') ui.hover = view.pickAt();
    else if (touch) ui.hover = view.pick(innerWidth / 2, innerHeight / 2); // pin at the screen centre
    else if (ui.moved) { ui.hover = view.pick(ui.mouse.x, ui.mouse.y); }
    ui.moved = false;
    const entry = currentEntry();
    const reason = entry ? engine.check(entry) : null;
    ui.canPlace = !!entry && !reason;
    view.setPreview(entry, !reason);
    view.terrain.uniforms.uOverlay.value = ui.overlay;
    const st = engine.state;
    const info = view.frame(st, st.tick + (caughtUp ? session.frac : 0), engine.epoch);
    updateWalker(dt, st);
    hud.update(st, session.owner, info, ui, session.mode);
    hud.updateBuild(ui);
    hud.updateCompass(st, session.owner, view.heading(), view.controls.target);
    ui.touchCtl?.update();
    const tx = view.mode === 'fp' ? innerWidth / 2 : ui.mouse.x, ty = view.mode === 'fp' ? innerHeight / 2 + 10 : ui.mouse.y;
    if (entry) hud.tip(tx, ty, previewTip(entry, reason));
    else if (ui.hover && view.mode === 'map' && !touch) hud.tip(tx, ty, cellTip(engine.world, st, ui.hover.x, ui.hover.y));
    else hud.tip(0, 0, null);
    requestAnimationFrame(loop);
  }
  // The walker's needs, in real seconds (paused with the game).
  const hinted = new Set();
  const hint = (key, msg) => { if (!hinted.has(key)) { hinted.add(key); hud.toast(msg, 5000); } };
  function updateWalker(dt, st) {
    const fp = view.fp;
    ps.x = fp.pos.x; ps.z = fp.pos.z; ps.yaw = fp.yaw;
    const cx = Math.floor(ps.x + N / 2), cy = Math.floor(ps.z + N / 2);
    const env = envAt(engine.world, st, engine.seed, st.tick, cx, cy, {
      depth: fp.depth, swimming: fp.swimming, running: view.mode === 'fp' && !!fp.running,
    });
    ps.hearth = env.hearth; ps.swimming = fp.swimming;
    const paused = session.mode === 'local' && session.speed === 0;
    if (!paused && stepNeeds(ps, env, dt) === 'faint') {
      const house = wakeAtHome(engine.world, st, ps, session.owner, spawnPos);
      fp.focus(ps.x, ps.z);
      hud.toast(house ? 'Too cold! You wake up warm by the fire at your house.'
        : 'Too cold! You wake up back where you arrived. Build a house to have a fire to come home to.', 6000);
    }
    fp.speedMul = coldSpeed(ps.warmth);
    if (fp.swimming) hint('swim', 'The water is cold! You will dry off in the sun or by a house.');
    else if (ps.warmth < 50 && !env.hearth) hint('cold', 'You are getting cold. Stand by a house to warm up by the fire.');
    hud.updateNeeds(ps, view.mode);
  }

  requestAnimationFrame(loop);
  window.__game = { engine, view, session, ui };
  window.addEventListener('beforeunload', () => session.save());
  document.addEventListener('visibilitychange', () => { if (document.hidden) session.save(); });
}

// ---- menu: new world, seed, save codes, multiplayer
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function openMenu(session) {
  if (menuEl) { closeMenu(); return; }
  if (document.pointerLockElement) document.exitPointerLock();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  const defServer = params.get('server') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:8787`;
  menuEl.innerHTML = `
    <div class="card panel">
      <h1>GenTrification</h1>
      <p>The whole world grows from one seed. Build a settlement that lasts: feed and warm your people through the winters, and keep nature health above the line.</p>
      <label>Seed</label><input id="m-seed" value="${session.seed}">
      <div class="btns"><button class="primary" id="m-new">New world from seed</button><button id="m-rand">Random world</button></div>
      <label>Save code (a save is just numbers)</label><textarea id="m-code" readonly>${session.saveCode()}</textarea>
      <div class="btns"><button id="m-copy">Copy</button><button id="m-load">Load a code…</button></div>
      <label>Multiplayer</label>
      <input id="m-server" placeholder="ws://localhost:8787" value="${defServer}">
      <div class="btns"><input id="m-room" placeholder="room" value="${params.get('room') || 'valley'}" style="flex:1"><input id="m-name" placeholder="your name" value="${params.get('name') || 'Settler'}" style="flex:1"><button id="m-join">Join</button></div>
      <div class="btns" style="justify-content:flex-end"><button id="m-close">Back to game</button></div>
    </div>`;
  document.body.appendChild(menuEl);
  const $ = (id) => menuEl.querySelector('#' + id);
  const go = (q) => { LocalSession.clearSave(); location.search = q; };
  $('m-new').onclick = () => go('seed=' + (Number($('m-seed').value) >>> 0 || 1));
  $('m-rand').onclick = () => go('seed=' + ((Math.random() * 2 ** 32) >>> 0));
  $('m-copy').onclick = () => navigator.clipboard?.writeText($('m-code').value);
  $('m-load').onclick = () => {
    const code = prompt('Paste a save code');
    if (!code) return;
    try { decodeSave(code); } catch { alert('That is not a valid save code.'); return; }
    localStorage.setItem('gentrification.save.v1', JSON.stringify({ code, savedAt: Date.now() }));
    location.search = '';
  };
  $('m-join').onclick = () => { location.search = `server=${encodeURIComponent($('m-server').value)}&room=${encodeURIComponent($('m-room').value)}&name=${encodeURIComponent($('m-name').value)}`; };
  $('m-close').onclick = closeMenu;
  menuEl.onclick = (e) => { if (e.target === menuEl) closeMenu(); };
}

start().catch((err) => {
  console.error(err);
  hudRoot.innerHTML = `<div class="loading"><div class="panel" style="padding:16px 20px;max-width:520px">Could not start: ${String(err.message || err)}</div></div>`;
});
