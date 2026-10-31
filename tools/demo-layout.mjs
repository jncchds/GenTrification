// Prints the buildings the demo bot builds: node tools/demo-layout.mjs [days] [seed]
import { Engine } from '../src/sim/engine.js';
import { Bot } from '../src/sim/bot.js';
import { DEFS } from '../src/sim/rules.js';

const days = Number(process.argv[2] ?? 18), seed = Number(process.argv[3] ?? 20261031);
const engine = new Engine(seed);
const bot = new Bot(engine, 1, 7);
for (let t = 0; t < days * 24; t++) {
  if (t % 30 === 0) { const e = bot.think(); if (e) engine.add(e); }
  engine.advanceTo(t + 1);
}
console.log('home', bot.home);
for (const b of engine.state.buildings) console.log(DEFS[b.type].name.padEnd(12), 'x', b.x, 'y', b.y, 's', b.s, b.alive ? '' : '(gone)');
const p = engine.state.players[1];
console.log(`people ${p.people}/${p.cap} food ${(p.food / 1000).toFixed(0)} wood ${(p.wood / 1000).toFixed(0)} staffing ${p.staffing}`);
