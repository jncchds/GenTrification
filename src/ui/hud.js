import { T, DEFS, ECON, rollBuilding, QUIRKS, houseCap, millRadius, parkRadius } from '../sim/rules.js';
import { SEASONS, YEAR_DAYS, SEASON_DAYS, HOURS } from '../sim/climate.js';
import { BIOME_NAMES, N } from '../sim/world.js';
import { previewPlayer } from '../sim/sim.js';
import { ownerColor } from '../render/buildings.js';

const ownerCss = (o) => '#' + ownerColor(o).getHexString();

const TOOLS = [
  { key: '1', type: T.HOUSE }, { key: '2', type: T.FARM }, { key: '3', type: T.MILL }, { key: '4', type: T.PARK },
  { key: '5', type: T.BEACON }, { key: 'X', type: T.DEMOLISH, name: 'Demolish' },
];
const fmt = (milli, d = 0) => (milli / 1000).toFixed(d);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Hud {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    root.innerHTML = `
      <div class="frost" id="h-frost"></div>
      <div class="hud-left">
        <div class="hcol">
          <div class="panel clock"><div class="date" id="h-date"></div><div class="wx" id="h-wx"></div></div>
          <div class="panel needs" id="h-needs"></div>
        </div>
        <div class="panel res" id="h-res"></div>
        <div class="panel mininature" id="h-mini"></div>
      </div>
      <div class="hud-right">
        <div class="speedwrap">
          <button class="panel speedcur" id="h-speedcur" title="Game speed"></button>
          <div class="panel speedopts" id="h-speed" style="display:none"></div>
        </div>
        <button class="panel menubtn" id="h-menu" title="Menu (M)">☰</button>
      </div>
      <div class="panel compass" id="h-compass"><div class="ticks" id="h-cticks"></div><div class="marks" id="h-cmarks"></div><i class="center"></i></div>
      <div class="panel nature" id="h-nature"></div>
      <div class="buildarea" id="h-buildarea">
        <div class="panel buildmenu" id="h-build" style="display:none"></div>
        <div class="panel placing" id="h-placing" style="display:none">
          <span class="pname" id="h-pname"></span>
          <span class="sz"><button id="h-szm" title="Smaller ([)">−</button><span id="h-sz"></span><button id="h-szp" title="Bigger (])">+</button></span>
          <button id="h-reroll" title="Reroll the building (R)">↻</button>
          <button id="h-cancel" title="Cancel (Esc)">✕</button>
        </div>
        <div class="btnrow">
          <button class="panel buildbtn gobtn" id="h-go" style="display:none" title="Go to the pin and walk (G)">🚶<small>Go here</small></button>
          <button class="panel buildbtn" id="h-buildbtn"></button>
        </div>
      </div>
      <div class="crosshair" id="h-cross"></div>
      <div class="panel clickhint" id="h-hint" style="display:none">Click to look around · Esc to release</div>
      <div class="panel help" id="h-help"></div>
      <div class="panel tip" id="h-tip" style="display:none"></div>
      <div class="panel toast" id="h-toast" style="opacity:0"></div>`;
    this.$ = (id) => root.querySelector('#' + id);
    this.$('h-menu').onclick = () => handlers.menu();
    // Speed is collapsed into one button showing the current speed; tap to pick another.
    this.speedBtns = [];
    this.speedOpen = false;
    const setOpen = (o) => { this.speedOpen = o; this.$('h-speed').style.display = o ? 'flex' : 'none'; this.$('h-speedcur').classList.toggle('open', o); };
    this.$('h-speedcur').onclick = () => setOpen(!this.speedOpen);
    for (const [label, sp] of [['❚❚ Pause', 0], ['1×', 1], ['5×', 5], ['20×', 20], ['100×', 100]]) {
      const b = document.createElement('button');
      b.textContent = label; b.onclick = () => { handlers.speed(sp); setOpen(false); };
      b.dataset.sp = sp;
      this.$('h-speed').appendChild(b);
      this.speedBtns.push(b);
    }
    for (const id of ['h-speedcur', 'h-speed', 'h-menu']) this.$(id).addEventListener('pointerdown', (e) => e.stopPropagation());
    this.toolBtns = [];
    for (const t of TOOLS) {
      const b = document.createElement('button');
      const def = DEFS[t.type];
      b.innerHTML = `${t.name || def.name}<small>${def ? fmt(def.cost(def.sizes[0])) + '+ wood' : 'remove yours'}<span class="key"> · ${t.key}</span></small>`;
      b.onclick = () => handlers.tool(t.type);
      b.dataset.type = t.type;
      this.$('h-build').appendChild(b);
      this.toolBtns.push(b);
    }
    this.$('h-szm').onclick = () => handlers.size(-1);
    this.$('h-szp').onclick = () => handlers.size(1);
    this.$('h-reroll').onclick = () => handlers.reroll();
    this.$('h-cancel').onclick = () => handlers.cancel();
    // One button: opens the menu; while placing on touch it becomes the confirm button.
    this.$('h-buildbtn').onclick = () => handlers.buildButton();
    this.$('h-go').onclick = () => handlers.goHere();
    for (const id of ['h-buildarea']) this.$(id).addEventListener('pointerdown', (e) => e.stopPropagation());
    this.last = 0;
    this.lastBuildKey = '';
  }

  // Build button / menu / placing bar. Cheap enough to run every frame, but only touches the DOM on change.
  updateBuild(ui) {
    const def = DEFS[ui.tool];
    const placing = !!ui.tool;
    const key = `${ui.menuOpen}:${ui.tool}:${ui.size}:${ui.touch}:${ui.canPlace}`;
    if (key === this.lastBuildKey) return;
    this.lastBuildKey = key;
    this.$('h-build').style.display = ui.menuOpen && !placing ? 'flex' : 'none';
    this.$('h-placing').style.display = placing ? 'flex' : 'none';
    this.$('h-pname').textContent = def ? def.name : 'Demolish';
    this.$('h-sz').textContent = def ? `size ${ui.size}` : '';
    this.$('h-placing').querySelector('.sz').style.display = def ? '' : 'none';
    this.$('h-reroll').style.display = def ? '' : 'none';
    const btn = this.$('h-buildbtn');
    btn.classList.toggle('confirm', placing && ui.touch);
    btn.classList.toggle('open', ui.menuOpen && !placing);
    btn.classList.toggle('dim', placing && ui.touch && !ui.canPlace);
    btn.style.display = placing && !ui.touch ? 'none' : '';
    btn.innerHTML = placing && ui.touch ? '✓<small>Place</small>' : ui.menuOpen ? '✕<small>Close</small>' : `🔨<small>Build${ui.touch ? '' : ' (B)'}</small>`;
    for (const b of this.toolBtns) b.classList.toggle('on', Number(b.dataset.type) === ui.tool);
  }

  toast(msg, ms = 2500) {
    const el = this.$('h-toast');
    el.textContent = msg; el.style.opacity = 1;
    clearTimeout(this.tt);
    this.tt = setTimeout(() => { el.style.opacity = 0; }, ms);
  }

  update(state, owner, info, ui, mode) {
    const now = performance.now();
    if (now - this.last < 100) return;
    this.last = now;
    const p = state.players[owner] || previewPlayer(owner);
    const t = state.tick, day = Math.floor(t / HOURS), doy = day % YEAR_DAYS;
    const hour = t % HOURS;
    const year = Math.floor(day / YEAR_DAYS) + 1, season = Math.floor(doy / SEASON_DAYS), dos = (doy % SEASON_DAYS) + 1;
    const minute = Math.floor(((info.hourF ?? hour) % 1) * 60 / 5) * 5;
    this.$('h-date').textContent = `Year ${year} · ${SEASONS[season]}, day ${dos} · ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const w = info.weather;
    const sky = w.storm ? (w.snow ? 'Blizzard' : w.season === 1 ? 'Thunderstorm' : 'Gale and rain')
      : info.snowing && w.rain > 0 ? (w.rain > 500 ? 'Heavy snow' : 'Snow')
      : w.rain > 500 ? 'Heavy rain' : w.rain > 0 ? (w.season === 0 ? 'Showers' : 'Rain')
      : w.fog > 400 ? 'Fog' : w.fog > 150 ? 'Mist'
      : w.cloud > 650 ? 'Overcast' : w.cloud > 480 ? 'Cloudy' : w.cloud > 300 ? 'Fair' : info.tempC < -2 ? 'Clear and frosty' : w.season === 1 ? 'Sunny' : 'Clear';
    this.$('h-wx').textContent = `${sky} · ${info.tempC.toFixed(0)}°C · wind ${Math.round(w.wind / 10.23)}%`;

    const foodDays = p.foodUse ? (p.food / p.foodUse) : Infinity;
    const woodDays = p.woodUse ? (p.wood / p.woodUse) : Infinity;
    const peopleNote = p.people > p.cap ? '<span class="minus">overcrowded</span>'
      : p.leftToday ? `<span class="minus">${p.leftToday} moved away</span>`
      : p.staffing < 1000 ? `<span class="minus">${Math.round(p.staffing / 10)}% staffed</span>`
      : p.stocked === false && p.people < p.cap ? '<span class="minus">stores low: no newcomers</span>'
      : `${p.workers} jobs`;
    const res = [
      ['People', `${p.people}<span class="muted" style="font-size:13px"> / ${p.cap}</span>`, peopleNote],
      ['Food', fmt(p.food), `<span class="plus">+${fmt(p.foodDay, 1)}</span> <span class="minus">−${fmt(p.foodUse, 1)}</span>/day${foodDays < 6 ? ' ⚠' : ''}`],
      ['Wood', fmt(p.wood), `<span class="plus">+${fmt(p.woodDay, 1)}</span> <span class="minus">−${fmt(p.woodUse, 1)}</span>/day${woodDays < 6 ? ' ⚠' : ''}`],
    ];
    this.$('h-res').innerHTML = res.map(([k, v, d]) => `<div class="r"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');

    const nat = p.nature / 10, thr = ECON.natureThreshold / 10;
    const col = nat >= thr ? 'var(--good)' : nat >= thr - 10 ? 'var(--warn)' : 'var(--bad)';
    this.$('h-nature').innerHTML = `
      <h3>Nature health</h3>
      <div class="row"><span class="score" style="color:${col}">${nat.toFixed(0)}%</span><span class="muted">needs ${thr}%</span></div>
      <div class="bar"><i style="width:${nat}%;background:${col}"></i><b style="left:${thr}%"></b></div>
      <div class="row"><span>Tree cover</span><span>${((p.cover ?? 1000) / 10).toFixed(0)}%</span></div>
      <div class="row"><span>Healthy forests</span><span>${((p.bio ?? 1000) / 10).toFixed(0)}%</span></div>
      <div class="row"><span>Reserves</span><span>${((p.parkScore ?? 0) / 10).toFixed(0)}%</span></div>
      <div class="row" style="margin-top:8px"><span>World nature</span><span>${(state.worldNature / 10).toFixed(0)}%</span></div>
      <h3 style="margin-top:12px">Sustained population</h3>
      <div class="row"><span class="score">${(p.sustained / 1000).toFixed(1)}</span><span class="muted">${mode === 'remote' ? 'multiplayer' : 'seed ' + ui.seed}</span></div>
      <div class="muted" style="font-size:12px">Average population over recent days, counting only days when nature health is above ${thr}%.</div>`;

    this.$('h-mini').innerHTML = `Nature <b style="color:${col}">${nat.toFixed(0)}%</b> · Score <b>${(p.sustained / 1000).toFixed(1)}</b>`;
    const fp = ui.viewMode === 'fp';
    const pin = !fp && (ui.touch ? true : !ui.tool); // map view: the pin marks where "Go here" takes you
    this.$('h-cross').style.display = fp || pin ? 'block' : 'none';
    this.$('h-cross').classList.toggle('pin', pin);
    this.$('h-go').style.display = fp || ui.tool ? 'none' : '';
    this.$('h-hint').style.display = fp && !ui.locked && !ui.touch ? 'block' : 'none';
    const help = fp
      ? `<b>Walk</b> WASD · <b>Run</b> Shift · <b>Jump</b> Space · <b>Look</b> mouse<br>
         <b>Build</b> B or 1–4, click to place · <b>Size</b> [ ] / wheel · <b>Reroll</b> R<br>
         <b>Map view</b> Tab · <b>Overlays</b> F T · <b>Paint</b> O · <b>Pause</b> P`
      : `<b>Pan</b> WASD / middle-drag · <b>Turn</b> Q E / right-drag · <b>Zoom</b> wheel<br>
         <b>Build</b> B or 1–4, click to place · <b>Size</b> [ ] · <b>Reroll</b> R<br>
         <b>Walk</b> Tab · <b>Go to the pin</b> G · <b>Overlays</b> F T · <b>Pause</b> P / Space`;
    if (this.helpHtml !== help) { this.$('h-help').innerHTML = help; this.helpHtml = help; }
    for (const b of this.speedBtns) b.classList.toggle('on', Number(b.dataset.sp) === ui.speed);
    const cur = ui.speed === 0 ? '❚❚' : `${ui.speed}×`;
    if (this.speedLabel !== cur) { this.speedLabel = cur; this.$('h-speedcur').innerHTML = `${cur}<small>▾</small>`; }
  }

  // The walker's warmth and wetness, and a frosty vignette when cold.
  updateNeeds(ps, viewMode) {
    const w = Math.round(ps.warmth);
    const col = w > 50 ? 'var(--good)' : w > 25 ? 'var(--warn)' : 'var(--bad)';
    const wet = ps.wet > 0.66 ? 'soaked' : ps.wet > 0.33 ? 'wet' : ps.wet > 0.05 ? 'damp' : '';
    const state = ps.hearth ? 'by the fire' : ps.swimming ? 'swimming' : w < 25 ? 'freezing! find a fire: house, mill or barn' : w < 50 ? 'cold' : ps.felt < 12 ? 'chilly' : 'comfortable';
    const key = `${w}|${wet}|${state}|${Math.round(ps.felt ?? 0)}`;
    if (key !== this.needsKey) {
      this.needsKey = key;
      this.$('h-needs').innerHTML = `<div class="row"><span>🔥 Warmth</span><span class="bar"><i style="width:${w}%;background:${col}"></i></span></div>
        <div class="sub">${state}${wet ? ' · 💧 ' + wet : ''} · feels ${Math.round(ps.felt ?? 0)}°C</div>`;
    }
    const frost = viewMode === 'fp' ? Math.max(0, Math.min(1, (55 - ps.warmth) / 55)) : 0;
    this.$('h-frost').style.opacity = frost.toFixed(2);
  }

  // Compass strip: cardinal points, your latest building, and every beacon (owner coloured).
  // heading: degrees clockwise from north (north = towards the top of the map, -z).
  updateCompass(state, owner, heading, pos) {
    const el = this.$('h-compass');
    const W = el.clientWidth || 360, SPAN = 160; // degrees shown across the strip
    const place = (bearing) => {
      const rel = ((bearing - heading + 540) % 360) - 180;
      return Math.abs(rel) > SPAN / 2 ? null : W / 2 + (rel / (SPAN / 2)) * (W / 2);
    };
    let ticks = '';
    for (let a = 0; a < 360; a += 15) {
      const x = place(a);
      if (x === null) continue;
      const label = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[a];
      ticks += label ? `<span class="${a % 90 ? 'ic' : 'card'}" style="left:${x}px">${label}</span>` : `<b style="left:${x}px"></b>`;
    }
    const targets = [];
    let last = null;
    for (const b of state.buildings) {
      if (!b.alive) continue;
      if (b.type === T.BEACON) targets.push({ b, kind: 'beacon' });
      else if (b.owner === owner && (!last || b.tick >= last.tick)) last = b;
    }
    if (last) targets.push({ b: last, kind: 'last' });
    const items = targets.map(({ b, kind }) => {
      const dx = b.x + b.s / 2 - N / 2 - pos.x, dz = b.y + b.s / 2 - N / 2 - pos.z;
      const dist = Math.hypot(dx, dz);
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      let x = place(bearing);
      const off = x === null;
      if (off) x = ((((bearing - heading + 540) % 360) - 180) < 0 ? 8 : W - 8); // pin to the edge
      return { b, kind, dist, x, off };
    }).sort((a, c) => a.dist - c.dist); // nearest first gets its label when markers crowd together
    const labelled = [];
    let marks = '';
    for (const { b, kind, dist, x, off } of items) {
      const color = kind === 'beacon' ? ownerCss(b.owner) : 'var(--ink)';
      const icon = kind === 'beacon' ? '◆' : '⌂';
      const m = Math.round(dist * 4);
      const room = !labelled.some((lx) => Math.abs(lx - x) < 40);
      const label = dist > 1.5 && !off && room;
      if (label) labelled.push(x);
      marks += `<span class="mk${off ? ' off' : ''}" style="left:${x}px;color:${color}" title="${kind === 'beacon' ? 'Beacon' : 'Your latest building'}">${icon}${label ? `<small>${m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km'}</small>` : ''}</span>`;
    }
    const key = ticks + marks;
    if (key !== this.compassKey) { this.compassKey = key; this.$('h-cticks').innerHTML = ticks; this.$('h-cmarks').innerHTML = marks; }
  }

  // Tooltip for the build preview or the hovered cell.
  tip(x, y, html) {
    const el = this.$('h-tip');
    if (!html) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = html;
    const r = el.getBoundingClientRect();
    el.style.left = Math.min(x, window.innerWidth - r.width - 30) + 'px';
    el.style.top = Math.min(y, window.innerHeight - r.height - 30) + 'px';
  }
}

export function previewTip(e, reason) {
  if (e.type === T.DEMOLISH) return `<div class="t">Demolish</div>${reason ? `<div class="bad">${esc(reason)}</div>` : '<div class="muted">Click to remove this building</div>'}`;
  const def = DEFS[e.type];
  const roll = rollBuilding(e.type, e.seed >>> 0);
  const q = QUIRKS[e.type][roll.quirk];
  const b = { ...e, ...roll };
  let extra = '';
  if (e.type === T.HOUSE) extra = `Room for ${houseCap(b)} people`;
  if (e.type === T.MILL) extra = `Cuts within ${millRadius(b)} cells · ${def.workers(e.s)} workers`;
  if (e.type === T.FARM) extra = `${e.s * e.s} fields · ${def.workers(e.s)} workers`;
  if (e.type === T.PARK) extra = `Protects forest within ${parkRadius(b)} cells`;
  return `<div class="t">${def.name} · size ${e.s}</div>
    <div>${fmt(def.cost(e.s))} wood · ${extra}</div>
    <div class="q">Efficiency ${(roll.eff / 10).toFixed(0)}%${q.text ? ` · <b>${esc(q.name)}</b>: ${esc(q.text)}` : ''}</div>
    <div class="muted" style="font-size:12px">${esc(def.desc)} · R to reroll</div>
    ${reason ? `<div class="bad">${esc(reason)}</div>` : ''}`;
}

export function cellTip(world, state, x, y) {
  if (x < 0 || y < 0 || x >= N || y >= N) return null;
  const i = y * N + x;
  const id = state.occ[i];
  if (id) {
    const b = state.buildings[id - 1], def = DEFS[b.type];
    const q = QUIRKS[b.type][b.quirk];
    const out = b.type === T.FARM ? `${fmt(b.out, 1)} food yesterday` : b.type === T.MILL ? `${fmt(b.out, 1)} wood yesterday` : b.type === T.HOUSE ? `room for ${houseCap(b)}` : b.type === T.BEACON ? 'a waymarker' : 'protecting the forest';
    return `<div class="t">${def.name} · size ${b.s}</div><div>${out}</div>
      <div class="q">Efficiency ${(b.eff / 10).toFixed(0)}%${q.text ? ` · <b>${esc(q.name)}</b>` : ''}</div>
      <div class="muted" style="font-size:12px">Player ${b.owner} · built day ${Math.floor(b.tick / HOURS) + 1}</div>`;
  }
  return `<div class="t">${BIOME_NAMES[world.biome[i]]}</div>
    <div>Trees ${(state.trees[i] / 10).toFixed(0)}% of ${(world.cap[i] / 10).toFixed(0)}% cap</div>
    <div>Soil ${(state.fert[i] / 10).toFixed(0)}%${state.park[i] ? ' · in a reserve' : ''}</div>`;
}
