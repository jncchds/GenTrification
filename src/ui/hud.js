import { T, DEFS, ECON, rollBuilding, QUIRKS, houseCap, millRadius, parkRadius } from '../sim/rules.js';
import { SEASONS, YEAR_DAYS, SEASON_DAYS, HOURS } from '../sim/climate.js';
import { BIOME_NAMES, N } from '../sim/world.js';
import { previewPlayer } from '../sim/sim.js';

const TOOLS = [
  { key: '1', type: T.HOUSE }, { key: '2', type: T.FARM }, { key: '3', type: T.MILL }, { key: '4', type: T.PARK },
  { key: 'X', type: T.DEMOLISH, name: 'Demolish' },
];
const fmt = (milli, d = 0) => (milli / 1000).toFixed(d);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Hud {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    root.innerHTML = `
      <div class="topbar">
        <div class="panel clock"><div class="date" id="h-date"></div><div class="wx" id="h-wx"></div></div>
        <div class="panel res" id="h-res"></div>
        <div class="spacer"></div>
        <div class="panel speed" id="h-speed"></div>
        <div class="panel speed"><button id="h-menu" title="Menu (M)">☰</button></div>
      </div>
      <div class="panel nature" id="h-nature"></div>
      <div class="panel build" id="h-build"></div>
      <div class="panel mininature" id="h-mini"></div>
      <div class="crosshair" id="h-cross"></div>
      <div class="panel clickhint" id="h-hint" style="display:none">Click to look around · Esc to release</div>
      <div class="panel help" id="h-help"></div>
      <div class="panel tip" id="h-tip" style="display:none"></div>
      <div class="panel toast" id="h-toast" style="opacity:0"></div>`;
    this.$ = (id) => root.querySelector('#' + id);
    this.$('h-menu').onclick = () => handlers.menu();
    this.speedBtns = [];
    for (const [label, sp] of [['❚❚', 0], ['1×', 1], ['5×', 5], ['20×', 20], ['100×', 100]]) {
      const b = document.createElement('button');
      b.textContent = label; b.onclick = () => handlers.speed(sp);
      b.dataset.sp = sp;
      this.$('h-speed').appendChild(b);
      this.speedBtns.push(b);
    }
    this.toolBtns = [];
    for (const t of TOOLS) {
      const b = document.createElement('button');
      const def = DEFS[t.type];
      b.innerHTML = `${t.name || def.name}<small>${t.key}${def ? ' · ' + fmt(def.cost(def.sizes[0])) + '+ wood' : ''}</small>`;
      b.onclick = () => handlers.tool(t.type);
      b.dataset.type = t.type;
      this.$('h-build').appendChild(b);
      this.toolBtns.push(b);
    }
    const sz = document.createElement('div');
    sz.className = 'sz';
    sz.innerHTML = `<button id="h-szm">−</button><span id="h-sz"></span><button id="h-szp">+</button>`;
    this.$('h-build').appendChild(sz);
    this.$('h-szm').onclick = () => handlers.size(-1);
    this.$('h-szp').onclick = () => handlers.size(1);
    this.last = 0;
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
    const sky = w.storm ? 'Storm' : info.snowing && w.rain > 0 ? 'Snow' : w.rain > 500 ? 'Heavy rain' : w.rain > 0 ? 'Rain' : w.cloud > 650 ? 'Overcast' : w.cloud > 480 ? 'Cloudy' : 'Clear';
    this.$('h-wx').textContent = `${sky} · ${info.tempC.toFixed(0)}°C · wind ${Math.round(w.wind / 10.23)}%`;

    const foodDays = p.foodUse ? (p.food / p.foodUse) : Infinity;
    const res = [
      ['People', `${p.people}<span class="muted" style="font-size:13px"> / ${p.cap}</span>`, p.people > p.cap ? '<span class="minus">overcrowded</span>' : p.staffing < 1000 ? `<span class="minus">${Math.round(p.staffing / 10)}% staffed</span>` : `${p.workers} jobs`],
      ['Food', fmt(p.food), `<span class="plus">+${fmt(p.foodDay, 1)}</span> <span class="minus">−${fmt(p.foodUse, 1)}</span>/day${foodDays < 6 ? ' ⚠' : ''}`],
      ['Wood', fmt(p.wood), `<span class="plus">+${fmt(p.woodDay, 1)}</span> <span class="minus">−${fmt(p.woodUse, 1)}</span>/day`],
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
    this.$('h-cross').style.display = fp ? 'block' : 'none';
    this.$('h-hint').style.display = fp && !ui.locked && !ui.touch ? 'block' : 'none';
    const help = fp
      ? `<b>Walk</b> WASD · <b>Run</b> Shift · <b>Jump</b> Space · <b>Look</b> mouse<br>
         <b>Build</b> 1–4, click · <b>Size</b> [ ] / wheel · <b>Reroll</b> R · <b>Demolish</b> X<br>
         <b>Map view</b> Tab · <b>Overlays</b> F T · <b>Paint</b> O · <b>Pause</b> P`
      : `<b>Pan</b> WASD / middle-drag · <b>Turn</b> Q E / right-drag · <b>Zoom</b> wheel<br>
         <b>Build</b> 1–4, click · <b>Size</b> [ ] · <b>Reroll</b> R · <b>Demolish</b> X<br>
         <b>Walk</b> Tab · <b>Overlays</b> F T · <b>Paint</b> O · <b>Pause</b> P / Space`;
    if (this.helpHtml !== help) { this.$('h-help').innerHTML = help; this.helpHtml = help; }
    for (const b of this.speedBtns) b.classList.toggle('on', Number(b.dataset.sp) === ui.speed);
    for (const b of this.toolBtns) b.classList.toggle('on', Number(b.dataset.type) === ui.tool);
    const def = DEFS[ui.tool];
    this.$('h-sz').textContent = def ? `size ${ui.size}` : '';
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
    const out = b.type === T.FARM ? `${fmt(b.out, 1)} food yesterday` : b.type === T.MILL ? `${fmt(b.out, 1)} wood yesterday` : b.type === T.HOUSE ? `room for ${houseCap(b)}` : 'protecting the forest';
    return `<div class="t">${def.name} · size ${b.s}</div><div>${out}</div>
      <div class="q">Efficiency ${(b.eff / 10).toFixed(0)}%${q.text ? ` · <b>${esc(q.name)}</b>` : ''}</div>
      <div class="muted" style="font-size:12px">Player ${b.owner} · built day ${Math.floor(b.tick / HOURS) + 1}</div>`;
  }
  return `<div class="t">${BIOME_NAMES[world.biome[i]]}</div>
    <div>Trees ${(state.trees[i] / 10).toFixed(0)}% of ${(world.cap[i] / 10).toFixed(0)}% cap</div>
    <div>Soil ${(state.fert[i] / 10).toFixed(0)}%${state.park[i] ? ' · in a reserve' : ''}</div>`;
}
