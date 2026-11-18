#!/usr/bin/env node
// Post-run screenshots for the nav restructure: menu, homepage and every collection page in the
// menu (plus Block Print), on desktop (1440x900) and mobile (390x844).
//
//   node screenshots.mjs <out-dir> [base-url]
//
// base-url defaults to https://jannatandsadaf.com; pass a ?preview_theme_id= URL to shoot a preview.
// Needs Playwright with the system Chrome:  npm i --prefix <tmp> playwright@1.48.2
// and run with NODE_PATH=<tmp>/node_modules, or run it from a folder that has playwright installed.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [out, base = 'https://jannatandsadaf.com'] = process.argv.slice(2);
if (!out) throw new Error('usage: node screenshots.mjs <out-dir> [base-url]');
mkdirSync(out, { recursive: true });

const COLLECTIONS = [
  'new-in', 'pret', 'co-ord-sets', 'formals', 'festive-wear', 'dinner-wear',
  'winter', 'all-year-round', 'summer', 'special-prices', 'block-print',
];
const url = (path) => {
  const u = new URL(path, base);
  for (const [k, v] of new URL(base).searchParams) u.searchParams.set(k, v);
  return u.toString();
};
const settle = (page, ms = 2500) => page.waitForTimeout(ms);
// Navigate with one retry and a 60s budget; returns false instead of throwing.
async function go(page, path) {
  for (let i = 0; i < 2; i++) {
    try { await page.goto(url(path), { waitUntil: 'domcontentloaded', timeout: 60_000 }); return true; } catch {}
  }
  report.push(`FAILED to load ${path}`);
  return false;
}

const report = [];
const browser = await chromium.launch({ channel: 'chrome' });

// Desktop
const d = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await go(d, '/'); await settle(d, 3500);
await d.screenshot({ path: join(out, 'desktop-home-hero.png') });
// Menu first: the sticky header hides once the page has been scrolled.
await d.locator('a.menu-list__link', { hasText: 'SHOP' }).first().hover(); await settle(d, 1200);
await d.screenshot({ path: join(out, 'desktop-menu.png') });
report.push('rail: ' + (await d.evaluate(() => [...document.querySelectorAll('.shop-mega__rail-heading, .shop-mega__rail-link')]
  .map((e) => `${e.textContent.trim()}${e.href ? ' ' + new URL(e.href).pathname : ''}`).join(' | '))));
await d.mouse.move(5, 895);
await go(d, '/'); await settle(d, 3500);
const tiles = d.locator('.sak-tiles__grid').first();
if (await tiles.count()) {
  await tiles.evaluate((el) => el.scrollIntoView({ block: 'center' })); await settle(d);
  await d.screenshot({ path: join(out, 'desktop-home-tiles.png') });
  report.push('tiles: ' + (await d.evaluate(() => [...document.querySelectorAll('.sak-tile')].map((t) => {
    const img = t.querySelector('img');
    return `${t.querySelector('.sak-tile__name')?.textContent.trim()} -> ${t.getAttribute('href')} [${img ? new URL(img.src).pathname.split('/').pop() : 'placeholder'}]`;
  }).join(' | '))));
}
for (const h of COLLECTIONS) {
  if (!(await go(d, `/collections/${h}`))) continue; await settle(d);
  await d.screenshot({ path: join(out, `desktop-collection-${h}.png`) });
  const info = await d.evaluate(() => ({ title: document.querySelector('h1')?.textContent.trim(), path: location.pathname, products: new Set([...document.querySelectorAll('main a[href*="/products/"]')].map((a) => new URL(a.href).pathname.split('/products/')[1])).size }));
  report.push(`desktop /collections/${h}: final ${info.path}, h1 "${info.title}", ${info.products} products linked`);
}

// Mobile
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await go(m, '/'); await settle(m, 3500);
await m.screenshot({ path: join(out, 'mobile-home-hero.png') });
await m.locator('summary.header__icon--menu').first().click(); await settle(m, 900);
await m.locator('summary.menu-drawer__menu-item', { hasText: 'SHOP' }).first().click(); await settle(m, 900);
await m.screenshot({ path: join(out, 'mobile-menu.png') });
await go(m, '/'); await settle(m, 3500);
const mt = m.locator('.sak-tiles__grid').first();
if (await mt.count()) {
  await mt.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(m);
  await m.screenshot({ path: join(out, 'mobile-home-tiles.png') });
}
for (const h of COLLECTIONS) {
  if (!(await go(m, `/collections/${h}`))) continue; await settle(m);
  await m.screenshot({ path: join(out, `mobile-collection-${h}.png`) });
}

await browser.close();
console.log(report.join('\n'));
