// Load the game headless and print HUD / player state (for checking UI without a GPU):
//   node tools/probe.mjs "<query string>" [waitMs] ["<js to run in the page first>"]
import puppeteer from 'puppeteer-core';

const base = process.env.GAME_URL || 'http://localhost:5173/';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 500 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text(), m.location()?.url || ''); });
await page.goto(base + '?' + (process.argv[2] || ''), { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, Number(process.argv[3] || 15000)));
if (process.argv[4]) console.log('eval:', JSON.stringify(await page.evaluate(process.argv[4])));
console.log(await page.evaluate(() => JSON.stringify({
  toast: document.querySelector('#h-toast')?.textContent,
  needs: document.querySelector('#h-needs')?.textContent.replace(/\s+/g, ' ').trim(),
  frost: document.querySelector('#h-frost')?.style.opacity,
  goButton: document.querySelector('#h-go')?.style.display,
  mode: window.__game?.view.mode,
  player: window.__game?.session.player,
}, null, 1)));
await browser.close();
