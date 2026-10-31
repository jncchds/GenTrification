// Balance simulator: plays a few strategies on several seeds and prints how the settlements fare.
//   node tools/balance.mjs [years=3] [seeds=4] [strategy,...]
// Strategies: idle, plan (the demo bot), steward (reacts to needs), greedy (mills + farms, no reserves).
import { Engine } from '../src/sim/engine.js';
import { findHome } from '../src/sim/bot.js';
import { T, DEFS, ECON } from '../src/sim/rules.js';
import { checkEntry } from '../src/sim/sim.js';
import { HOURS, YEAR_DAYS, SEASON_DAYS, SEASONS } from '../src/sim/climate.js';
import { N } from '../src/sim/world.js';
import { Rng } from '../src/sim/prng.js';

// Try constants without editing rules.js: --set=heatPerDegree=11,millCut=20
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const a of process.argv.slice(2)) if (a.startsWith('--set=')) for (const kv of a.slice(6).split(',')) { const [k, v] = kv.split('='); ECON[k] = Number(v); }
const years = Number(args[0] ?? 3);
const nSeeds = Number(args[1] ?? 4);
const only = args[2]?.split(',');
const brief = process.argv.includes('--brief');
const OWNER = 1;

// Find a free spot for a building, spiralling out from home.
function spot(world, state, home, type, size, rng, minR = 0) {
  const [hx, hy] = home;
  for (let r = minR; r < 40; r++) {
    for (let k = 0; k < 10 + r * 4; k++) {
      const a = rng.int(6283) / 1000;
      const x = Math.round(hx + Math.cos(a) * r * 1.3), y = Math.round(hy + Math.sin(a) * r * 1.3);
      const e = { tick: state.tick, owner: OWNER, type, x, y, s: size, seed: rng.next() };
      if (!checkEntry(world, state, e)) return e;
    }
  }
  return null;
}

const PLAN = [
  [T.FARM, 4], [T.HOUSE, 3], [T.MILL, 2], [T.HOUSE, 2], [T.FARM, 5], [T.HOUSE, 3], [T.PARK, 3],
  [T.FARM, 4], [T.HOUSE, 4], [T.HOUSE, 3], [T.MILL, 2], [T.FARM, 5], [T.PARK, 4], [T.HOUSE, 3],
];
const GREEDY = [
  [T.FARM, 5], [T.MILL, 3], [T.HOUSE, 3], [T.MILL, 4], [T.HOUSE, 4], [T.FARM, 7], [T.HOUSE, 4], [T.MILL, 4],
  [T.FARM, 7], [T.HOUSE, 4], [T.HOUSE, 4], [T.MILL, 4], [T.FARM, 7], [T.HOUSE, 4], [T.HOUSE, 4], [T.MILL, 4],
];

function planBot(plan) {
  return (ctx) => {
    if (ctx.i >= plan.length) return null;
    const [type, size] = plan[ctx.i];
    if (ctx.p && ctx.p.wood < DEFS[type].cost(size)) return null;
    const e = spot(ctx.world, ctx.state, ctx.home, type, size, ctx.rng, type === T.MILL ? 8 : 0);
    ctx.i++;
    return e;
  };
}

// A player who reacts to what the village needs, the way a thoughtful human might.
function steward(ctx) {
  const { p, state } = ctx;
  if (!p) return spot(ctx.world, state, ctx.home, T.FARM, 4, ctx.rng);
  const mine = state.buildings.filter((b) => b.alive && b.owner === OWNER);
  const count = (t) => mine.filter((b) => b.type === t).length;
  const doy = (Math.floor(state.tick / HOURS)) % YEAR_DAYS;
  const daysToWinter = (36 - doy + YEAR_DAYS) % YEAR_DAYS;
  const want = [];
  // Food for the winter: about 100 milli-food per person per day for the 12 winter days plus margin.
  const foodGoal = p.people * 100 * Math.min(daysToWinter + 14, 30);
  if (p.food < foodGoal / 2 || count(T.FARM) * 9 < p.people) want.push([T.FARM, 5]);
  // Firewood for the coming winter: ~20 degrees below 16 C for 12 days, plus building wood.
  const woodGoal = Math.floor((p.people * (ECON.heatBase * 10 + ECON.heatPerDegree * 200)) / 10) * 14 + 40000;
  if (count(T.MILL) === 0 || (p.wood < woodGoal && p.woodDay * 30 < woodGoal && count(T.MILL) < 2 + p.people / 25)) want.push([T.MILL, 2]);
  if (p.people >= p.cap - 2 && p.fed && p.warm) want.push([T.HOUSE, 3]);
  if (p.nature < 680 && count(T.PARK) < 6) want.push([T.PARK, 3]);
  if (p.staffing < 900) want.length = 0, want.push([T.HOUSE, 3]);
  for (const [type, size] of want) {
    if (p.wood < DEFS[type].cost(size) + 15000) continue;
    const e = spot(ctx.world, state, ctx.home, type, size, ctx.rng, type === T.MILL ? 8 : 0);
    if (e) return e;
  }
  return null;
}

const STRATS = {
  idle: (ctx) => (ctx.i++ === 0 ? spot(ctx.world, ctx.state, ctx.home, T.HOUSE, 2, ctx.rng) : null),
  plan: planBot(PLAN),
  steward,
  greedy: planBot(GREEDY),
};

function run(seed, name) {
  const eng = new Engine(seed);
  const rng = new Rng(seed ^ 0x5eed);
  const home = findHome(eng.world, eng.state, OWNER, new Rng(seed ^ OWNER)) || [N / 2, N / 2];
  const ctx = { world: eng.world, home, rng, i: 0 };
  const days = years * YEAR_DAYS;
  const rows = [];
  let prevPeople = 8;
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < HOURS; h++) {
      if (h % 6 === 0) {
        ctx.state = eng.state; ctx.p = eng.state.players[OWNER];
        const e = STRATS[name](ctx);
        if (e) eng.add(e);
      }
      eng.advanceTo(eng.state.tick + 1);
    }
    const p = eng.state.players[OWNER];
    if (!p) { rows.push(null); continue; }
    rows.push({ d, people: p.people, cap: p.cap, food: p.food, wood: p.wood, nature: p.nature, fed: p.fed, warm: p.warm,
      died: p.leftToday || 0, foodDay: p.foodDay, woodDay: p.woodDay, woodUse: p.woodUse, foodUse: p.foodUse,
      staffing: p.staffing, sustained: p.sustained });
    prevPeople = p.people;
  }
  const b = eng.state.buildings.filter((x) => x.alive && x.owner === OWNER);
  return { rows, buildings: b.length, byType: [1, 2, 3, 4].map((t) => b.filter((x) => x.type === t).length) };
}

const seeds = [20261031, 7, 4242, 99991, 123456, 31337, 2718, 1618].slice(0, nSeeds);
for (const name of Object.keys(STRATS)) {
  if (only && !only.includes(name)) continue;
  console.log(`\n=== ${name} (${seeds.length} seeds, ${years} years) ===`);
  // Season summary averaged across seeds: end population, hungry/cold days, deaths, nature, stocks.
  const agg = {};
  const ends = [];
  for (const seed of seeds) {
    const r = run(seed, name);
    ends.push(`${seed}: pop ${r.rows.at(-1)?.people} H/F/M/R ${r.byType.join('/')}`);
    for (const row of r.rows) {
      if (!row) continue;
      const y = Math.floor(row.d / YEAR_DAYS), s = Math.floor((row.d % YEAR_DAYS) / SEASON_DAYS), k = `${y}.${s}`;
      const a = (agg[k] ||= { minNat: 1000, n: 0, people: 0, hungry: 0, cold: 0, died: 0, nature: 0, food: 0, wood: 0, fin: 0, win: 0, wuse: 0, staff: 0 });
      a.n++; a.people += row.people; a.hungry += row.fed ? 0 : 1; a.cold += row.warm ? 0 : 1; a.died += row.died;
      a.nature += row.nature; a.food += row.food; a.wood += row.wood; a.fin += row.foodDay; a.win += row.woodDay; a.wuse += row.woodUse;
      a.staff += row.staffing; a.minNat = Math.min(a.minNat, row.nature);
    }
  }
  if (brief) { summary(agg, ends); continue; }
  console.log('yr season  pop  hungry% cold%  died/seed nature  food   wood  food+/d wood+/d wood-/d staff');
  for (const [k, a] of Object.entries(agg)) {
    const [y, s] = k.split('.').map(Number);
    const f = (v, d = 0) => (v / a.n).toFixed(d);
    console.log(`${y}  ${SEASONS[s].padEnd(7)}${f(a.people, 1).padStart(5)} ${((a.hungry * 100) / a.n).toFixed(0).padStart(6)}% ${((a.cold * 100) / a.n).toFixed(0).padStart(4)}%  ${(a.died / seeds.length).toFixed(1).padStart(8)}  ${(a.nature / a.n / 10).toFixed(0).padStart(5)}% ${(a.food / a.n / 1000).toFixed(0).padStart(5)} ${(a.wood / a.n / 1000).toFixed(0).padStart(6)} ${(a.fin / a.n / 1000).toFixed(1).padStart(7)} ${(a.win / a.n / 1000).toFixed(1).padStart(7)} ${(a.wuse / a.n / 1000).toFixed(1).padStart(7)} ${(a.staff / a.n / 10).toFixed(0).padStart(4)}%`);
  }
  console.log(ends.join('\n'));
}

// One line per strategy: population at the end of each year, worst season for leaving, lowest nature.
function summary(agg, ends) {
  const vals = Object.entries(agg);
  const yEnd = vals.filter(([k]) => k.endsWith('.3')).map(([, a]) => (a.people / a.n).toFixed(0));
  const left = vals.reduce((m, [, a]) => Math.max(m, a.died / seeds.length), 0);
  const minNat = vals.reduce((m, [, a]) => Math.min(m, a.minNat), 1000);
  const cold = vals.reduce((m, [, a]) => Math.max(m, a.cold / a.n), 0);
  const hungry = vals.reduce((m, [, a]) => Math.max(m, a.hungry / a.n), 0);
  console.log(`winter pop by year ${yEnd.join(' > ')} | worst season: ${left.toFixed(0)} left, ${(hungry * 100).toFixed(0)}% hungry days, ${(cold * 100).toFixed(0)}% cold days | min nature ${minNat / 10}%`);
  console.log('  ' + ends.join(' | '));
}
