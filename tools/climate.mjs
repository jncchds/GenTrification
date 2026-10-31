// Climate statistics per season over a few years: node tools/climate.mjs [seed] [years]
import { weather, SEASONS, HOURS, YEAR_DAYS } from '../src/sim/climate.js';

const seed = Number(process.argv[2] ?? 20261031), years = Number(process.argv[3] ?? 4);
const s = SEASONS.map(() => ({ n: 0, temp: 0, min: 1e9, max: -1e9, rain: 0, snow: 0, storm: 0, clear: 0, fog: 0, rainDays: new Set() }));
for (let t = 0; t < years * YEAR_DAYS * HOURS; t++) {
  const w = weather(seed, t), a = s[w.season];
  a.n++; a.temp += w.temp; a.min = Math.min(a.min, w.temp); a.max = Math.max(a.max, w.temp);
  if (w.rain > 0) { a.rain++; a.rainDays.add(w.day); if (w.snow) a.snow++; }
  if (w.storm) a.storm++;
  if (w.cloud < 430) a.clear++;
  if (w.fog > 300) a.fog++;
}
const pct = (x, n) => `${((x * 100) / n).toFixed(0)}%`.padStart(4);
console.log('season   mean    min    max  precip  snow  storm  clear  fog  wet days');
for (let i = 0; i < 4; i++) {
  const a = s[i], days = (a.n / HOURS);
  console.log(`${SEASONS[i].padEnd(7)} ${(a.temp / a.n / 10).toFixed(1).padStart(5)}C ${(a.min / 10).toFixed(0).padStart(5)}C ${(a.max / 10).toFixed(0).padStart(5)}C   ${pct(a.rain, a.n)}  ${pct(a.snow, a.n)}   ${pct(a.storm, a.n)}   ${pct(a.clear, a.n)}  ${pct(a.fog, a.n)}  ${pct(a.rainDays.size, days)}`);
}
