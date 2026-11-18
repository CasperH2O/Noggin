#!/usr/bin/env node
// Development tool, not run on the robot: renders the store and menu icon, icon.png (330x300),
// from an SVG glyph in a 200x200 box. Classic icon style (ui/jibo-ui-classic iconography): a white
// glyph with a soft long shadow towards the lower right, on a transparent background; BEacon draws
// the coloured button (manifest buttonColor) behind it. The glyph is centred on (165, 165).
// Needs Playwright with Chromium:  node tools/make-icon.mjs [path/to/node_modules/playwright]
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Replace with the skill's own glyph (white shapes; navy #2D2C3B for cut-outs).
const GLYPH = '<circle cx="100" cy="100" r="70" fill="#fff"/><circle cx="100" cy="100" r="30" fill="#2D2C3B"/>';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const svg = (black) => 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">${black ? GLYPH.replace(/#[0-9a-fA-F]{3,6}/g, '#000') : GLYPH}</svg>`).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(async ({ white, black }) => {
  const W = 330, H = 300, BOX = 190, X = 165 - BOX / 2, Y = 165 - BOX / 2, LONG = 140;
  const load = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
  const [g, s] = await Promise.all([load(white), load(black)]);
  const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
  const shadow = canvas(), sx = shadow.getContext('2d');
  for (let d = 0; d <= LONG; d++) sx.drawImage(s, X + d, Y + d, BOX, BOX);
  sx.globalCompositeOperation = 'destination-in';
  const fade = sx.createLinearGradient(165, 165, 165 + LONG, 165 + LONG);
  fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
  sx.fillStyle = fade; sx.fillRect(0, 0, W, H);
  const out = canvas(), ctx = out.getContext('2d');
  ctx.globalAlpha = 0.2; ctx.drawImage(shadow, 0, 0); ctx.globalAlpha = 1;
  ctx.drawImage(g, X, Y, BOX, BOX);
  return out.toDataURL('image/png');
}, { white: svg(false), black: svg(true) });
writeFileSync(join(ROOT, 'icon.png'), Buffer.from(data.split(',')[1], 'base64'));
await browser.close();
console.log('wrote icon.png (330x300)');
