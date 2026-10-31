// Screenshots via the system Chrome:
//   node tools/shot.mjs <out.png> "<query string>" [waitMs] [width] [height]
// e.g. node tools/shot.mjs docs/shots/village.png "demo=60&hour=10&cam=40,0.8,0.6" 8000
import puppeteer from 'puppeteer-core';

const [out = 'shot.png', query = 'demo=40', wait = '8000', w = '1600', h = '900'] = process.argv.slice(2);
const base = process.env.GAME_URL || 'http://localhost:5173/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--window-size=${w},${h}`],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h) });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 500)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(base + '?' + query, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, Number(wait)));
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res((n * 1000) / (performance.now() - t0)); }; requestAnimationFrame(f); }));
const gl = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
await page.screenshot({ path: out });
console.log(`saved ${out} · ${fps.toFixed(1)} fps · ${gl}`);
await browser.close();
