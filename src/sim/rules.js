// Game rules: building types, costs, quirks and economy constants.
// Resources are stored in milli-units (1000 = 1 wood / 1 food). 1 tick = 1 hour.
import { hash3 } from './prng.js';

export const T = { HOUSE: 1, FARM: 2, MILL: 3, PARK: 4, BEACON: 5, DEMOLISH: 9 };

export const DEFS = {
  [T.HOUSE]: { key: 'house', name: 'House', sizes: [2, 4], maxSlope: 150, cost: (s) => 4000 * s * s, workers: () => 0,
    desc: 'Shelter. Capacity grows with size.' },
  [T.FARM]: { key: 'farm', name: 'Farm', sizes: [3, 7], maxSlope: 90, cost: (s) => 1500 * s * s, workers: (s) => Math.ceil((s * s) / 4),
    desc: 'Grows food in warm weather from soil fertility. Wears the soil; flat land near water is best.' },
  [T.MILL]: { key: 'mill', name: 'Lumber mill', sizes: [2, 4], maxSlope: 180, cost: (s) => 20000 * s, workers: (s) => 2 * s,
    desc: 'Cuts trees in a radius in daylight. Big mills can strip their forest bare.' },
  [T.PARK]: { key: 'park', name: 'Reserve', sizes: [2, 6], maxSlope: 400, cost: (s) => 2500 * s * s, workers: () => 1,
    desc: 'No output. Protects and regrows nearby forest, raises nature health.' },
  [T.BEACON]: { key: 'beacon', name: 'Beacon', sizes: [1, 1], maxSlope: 600, cost: () => 1000, workers: () => 0,
    desc: 'A waymarker: a light beam you can see from afar, shown on everyone\'s compass.' },
};

// Quirks rolled from the building seed. Multipliers are per-mille.
export const QUIRKS = {
  [T.HOUSE]: [
    { name: 'Plain' },
    { name: 'Cozy', cap: 1300, heat: 1100, text: '+30% capacity, a bit more firewood' },
    { name: 'Drafty', heat: 1600, text: '+60% firewood use' },
    { name: 'Lively', births: 1400, text: '+40% births' },
    { name: 'Stone-built', heat: 700, cap: 900, text: '-30% firewood, -10% capacity' },
  ],
  [T.FARM]: [
    { name: 'Plain' },
    { name: 'Intensive', out: 1250, wear: 2000, text: '+25% food, soil wears 2x faster' },
    { name: 'Rotational', out: 850, wear: 400, text: '-15% food, soil wears 60% slower' },
    { name: 'Greenhouse', out: 900, cold: 60, text: '-10% food, grows down to -2 C' },
  ],
  [T.MILL]: [
    { name: 'Plain' },
    { name: 'Greedy saws', out: 1350, text: '+35% cutting' },
    { name: 'Selective', out: 750, selective: true, text: '-25% cutting, only thins mature stands' },
    { name: 'Long reach', reach: 3, text: '+3 radius' },
  ],
  [T.PARK]: [
    { name: 'Plain' },
    { name: 'Old grove', grow: 2, text: 'stronger regrowth nearby' },
    { name: 'Wildflower meadow', nature: 1500, text: '+50% nature value' },
    { name: 'Bird sanctuary', reach: 3, text: '+3 radius' },
  ],
  [T.BEACON]: [{ name: 'Plain' }],
};

// Efficiency is 800..1200 per-mille (+-20%); 40% of buildings are plain.
export function rollBuilding(type, seed) {
  const eff = 800 + (hash3(seed, type, 1, 0xb1d) % 401);
  const q = QUIRKS[type];
  const r = hash3(seed, type, 2, 0xb1d) % 100;
  const quirk = r < 40 || !q ? 0 : 1 + (r % (q.length - 1));
  return { eff, quirk };
}
export const quirkOf = (b) => QUIRKS[b.type]?.[b.quirk] ?? { name: 'Plain' };

export const millRadius = (b) => 4 + 2 * b.s + (quirkOf(b).reach || 0);
export const parkRadius = (b) => b.s + 5 + (quirkOf(b).reach || 0);
export const houseCap = (b) => Math.floor((b.s * b.s * 3 * b.eff * (quirkOf(b).cap || 1000)) / 1e6);

export const START = { wood: 120000, food: 45000, people: 8, baseCap: 8 };
export const ECON = {
  foodPerPerson: 100,    // milli-food / person / day
  heatPerDegree: 5,      // milli-wood / person / day for each degree C below 16 C
  heatBase: 4,           // milli-wood / person / day for cooking, all year
  farmYield: 22,         // milli-food / cell / daylight hour at fertility 1000
  millCut: 14,           // tree units / daylight hour per size step (1 tree unit = 10 milli-wood)
  woodPerTreeUnit: 10,
  clearShare: 2,         // clearing a cell for a building returns half its wood
  natureThreshold: 600,  // per-mille; score only accrues above this
};
