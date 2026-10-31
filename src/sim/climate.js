// Calendar, temperature and weather: pure functions of (seed, tick). Never stored.
// 1 tick = 1 hour. Integer math only (temperatures in deci-degrees C).
import { vnoise } from './noise.js';
import { WATER } from './world.js';

export const HOURS = 24;
export const SEASON_DAYS = 12;
export const YEAR_DAYS = SEASON_DAYS * 4;
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];

export const hourOf = (t) => t % HOURS;
export const dayOf = (t) => Math.floor(t / HOURS);
export const dayOfYear = (t) => dayOf(t) % YEAR_DAYS;
export const yearOf = (t) => Math.floor(dayOf(t) / YEAR_DAYS);
export const seasonOf = (t) => Math.floor(dayOfYear(t) / SEASON_DAYS);

// Integer sine in degrees -> -1000..1000 (Bhaskara I approximation).
export function isin(deg) {
  deg = ((deg % 360) + 360) % 360;
  const neg = deg >= 180;
  const d = neg ? deg - 180 : deg;
  const p = d * (180 - d);
  const v = Math.floor((4000 * p) / (40500 - p));
  return neg ? -v : v;
}
export const icos = (deg) => isin(deg + 90);

// Sunrise / sunset hour per season (work happens in daylight).
const SUNRISE = [6, 5, 7, 8];
const SUNSET = [19, 21, 18, 16];
export const isDaylight = (t) => { const s = seasonOf(t), h = hourOf(t); return h >= SUNRISE[s] && h < SUNSET[s]; };
export const sunTimes = (season) => [SUNRISE[season], SUNSET[season]];

const WET = [90, -70, 110, 40]; // seasonal wetness bias

// Weather at tick t (sea level). Temperatures in deci-degrees C.
export function weather(seed, t) {
  const day = dayOf(t), doy = day % YEAR_DAYS, hour = t % HOURS, season = Math.floor(doy / SEASON_DAYS);
  // Annual curve: coldest in mid-winter (day 42 of 48).
  const annual = 100 - Math.floor((130 * icos(Math.floor(((doy - 42) * 360) / YEAR_DAYS))) / 1000);
  const dayNoise = Math.floor(((vnoise(seed + 21, day, 0, 3) - 512) * 80) / 1024);
  const cloud = Math.floor((vnoise(seed + 31, t, 0, 4) * 2 + vnoise(seed + 33, t, 7, 6)) / 3);
  const swing = cloud > 600 ? 25 : 55; // cloudy days swing less
  let temp = annual + dayNoise + Math.floor((swing * isin((hour - 9) * 15)) / 1000);
  const thr = 600 - WET[season];
  const rain = cloud > thr ? Math.floor(((cloud - thr) * 1000) / (1023 - thr)) : 0;
  if (rain > 0) temp -= 15;
  const wind = vnoise(seed + 41, t, 3, 3);
  const storm = rain > 550 && wind > 680;
  return { t, day, doy, hour, season, temp, cloud, rain, wind, storm, snow: rain > 0 && temp < 15 };
}

// Temperature adjusted for altitude (about -13 C from sea level to the highest peaks).
export const tempAt = (seaTemp, h) => (h > WATER ? seaTemp - Math.floor(((h - WATER) * 13) / 300) : seaTemp);

// Daily averages, cached (pure, so caching is safe).
const dayCache = new Map();
export function dayStats(seed, day) {
  const key = seed * 100003 + day;
  let r = dayCache.get(key);
  if (r) return r;
  let temp = 0, rain = 0, storm = 0;
  for (let h = 0; h < HOURS; h++) {
    const w = weather(seed, day * HOURS + h);
    temp += w.temp; rain += w.rain; if (w.storm) storm++;
  }
  r = { temp: Math.floor(temp / HOURS), rain: Math.floor(rain / HOURS), storm };
  if (dayCache.size > 512) dayCache.clear();
  dayCache.set(key, r);
  return r;
}
