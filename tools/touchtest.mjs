// Touch controls check on an emulated phone (needs the dev server and Chrome):
//   node tools/touchtest.mjs
// Drags the joystick and checks the player moved; drags on the right and checks the view turned.
import puppeteer from 'puppeteer-core';

const base = process.env.GAME_URL || 'http://localhost:5173/';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 400, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(base + '?seed=42&speed=0', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 3000));
const get = () => page.evaluate(() => { const f = window.__game.view.fp; return { x: f.pos.x, z: f.pos.z, yaw: f.yaw }; });

// Use CDP touch events so pointer events fire with pointerType "touch".
const cdp = await page.createCDPSession();
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
let failures = 0;

const before = await get();
await touch('touchStart', [[80, 600]]);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[80, 600 - i * 10]]); await new Promise((r) => setTimeout(r, 150)); }
await new Promise((r) => setTimeout(r, 4000)); // hold the stick while frames run
const held = await page.evaluate(() => window.__game.view.fp.touchMove);
await touch('touchEnd', []);
const moved = await get();
const dist = Math.hypot(moved.x - before.x, moved.z - before.z);
console.log(`${dist > 0.3 ? 'ok  ' : 'FAIL'} joystick moved the player ${dist.toFixed(2)} units (stick ${JSON.stringify(held)})`);
if (dist <= 0.3) failures++;

const hit = await page.evaluate(() => { const el = document.elementFromPoint(300, 520); return el.tagName; });
if (hit !== 'CANVAS') { console.log(`FAIL right-side look area is covered by a ${hit}`); failures++; }
await touch('touchStart', [[300, 520]]);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[300 - i * 15, 520]]); await new Promise((r) => setTimeout(r, 100)); }
await touch('touchEnd', []);
const turned = await get();
const dyaw = Math.abs(turned.yaw - moved.yaw);
console.log(`${dyaw > 0.1 ? 'ok  ' : 'FAIL'} look drag turned the view ${dyaw.toFixed(2)} rad`);
if (dyaw <= 0.1) failures++;

// Map mode: one-finger drag pans.
await page.evaluate(() => document.getElementById('t-map').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
await new Promise((r) => setTimeout(r, 1500));
const t0 = await page.evaluate(() => ({ ...window.__game.view.map.goal.target }));
await touch('touchStart', [[200, 400]]);
for (let i = 1; i <= 5; i++) { await touch('touchMove', [[200 + i * 20, 400 + i * 10]]); await new Promise((r) => setTimeout(r, 100)); }
await touch('touchEnd', []);
const t1 = await page.evaluate(() => ({ ...window.__game.view.map.goal.target }));
const pan = Math.hypot(t1.x - t0.x, t1.z - t0.z);
console.log(`${pan > 1 ? 'ok  ' : 'FAIL'} map drag panned ${pan.toFixed(1)} units`);
if (pan <= 1) failures++;

await browser.close();
process.exit(failures ? 1 : 0);
