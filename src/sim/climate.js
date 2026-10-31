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

// Seasonal character (spring, summer, autumn, winter):
//  spring: mild, showery, breezy    summer: warm, mostly sunny, afternoon thunderstorms
//  autumn: grey, wet, gales, fog    winter: cold, snow, clear frosty nights, blizzards
const CLOUD_BIAS = [30, -170, 110, 20];
const WIND_BIAS = [70, -60, 130, 60];
const RAIN_THR = [655, 690, 635, 650];
const FOGGY = [400, 0, 900, 600]; // how prone each season is to calm, misty mornings

// Weather at tick t (sea level). Temperatures in deci-degrees C.
export function weather(seed, t) {
  const day = dayOf(t), doy = day % YEAR_DAYS, hour = t % HOURS, season = Math.floor(doy / SEASON_DAYS);
  // Annual curve: coldest in mid-winter (day 41 of 48), about -6 C .. 24 C.
  const annual = 90 - Math.floor((150 * icos(Math.floor(((doy - 41) * 360) / YEAR_DAYS))) / 1000);
  const dayNoise = Math.floor(((vnoise(seed + 21, day, 0, 3) - 512) * 70) / 1024);
  // Weather fronts: a slow regime lasting several days (positive = unsettled).
  const regime = vnoise(seed + 51, day, 3, 2) - 512;
  let cloud = Math.floor((vnoise(seed + 31, t, 0, 4) * 2 + vnoise(seed + 33, t, 7, 6)) / 3);
  cloud += CLOUD_BIAS[season] + Math.floor((regime * 35) / 100);
  // Summer: on humid days, clouds tower up in the afternoon and break into thunderstorms.
  const convective = season === 1 && hour >= 13 && hour <= 19 && regime > 40;
  if (convective) cloud += Math.floor(((regime - 40) * isin((hour - 13) * 30)) / 380);
  cloud = cloud < 0 ? 0 : cloud > 1023 ? 1023 : cloud;
  const clear = cloud < 430;
  const swing = cloud > 600 ? 25 : clear ? 70 : 50; // clear days swing more
  let temp = annual + dayNoise + Math.floor((swing * isin((hour - 9) * 15)) / 1000);
  if (clear && (hour < 7 || hour > 20)) temp -= season === 3 ? 35 : 15; // radiative cooling: frosty clear nights
  if (clear && hour >= 10 && hour <= 17 && season === 1) temp += 20;   // summer sun
  const thr = RAIN_THR[season];
  const rain = cloud > thr ? Math.floor(((cloud - thr) * 1000) / (1023 - thr)) : 0;
  if (rain > 0) temp -= 15;
  let wind = vnoise(seed + 41, t, 3, 3) + WIND_BIAS[season] + (rain > 0 ? 80 : 0) + Math.floor(regime / 6);
  wind = wind < 0 ? 0 : wind > 1023 ? 1023 : wind;
  const storm = (rain > 450 && wind > 640) || (convective && rain > 350);
  // Fog: calm, humid mornings in the cooler seasons.
  let fog = 0;
  if (hour >= 3 && hour <= 10 && wind < 560 && cloud > 300 && rain < 200) {
    fog = Math.floor(((560 - wind) * FOGGY[season]) / 300);
    if (fog > 1000) fog = 1000;
    if (hour > 7) fog = Math.floor((fog * (11 - hour)) / 4);
  }
  return { t, day, doy, hour, season, temp, cloud, rain, wind, storm, fog, snow: rain > 0 && temp < 15 };
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
