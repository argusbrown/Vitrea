'use strict';

// Screenshot the END screen with 4 players to check every score is visible.
process.env.PORT = '3540';
require('../server/index');
const { PeerServer } = require('peer');
const { chromium, devices } = require('playwright');

const BASE = 'http://localhost:3540/?ps=127.0.0.1:9540';
const OUT = __dirname + '/../shots';

async function act(page) {
  if (await page.isVisible('text=Draw a shard')) {
    const hand = await page.locator('#hand-row .shard').count();
    if (hand < 2) await page.click('text=Draw a shard');
    else await page.click('#kiln-actions .btn:nth-child(2)');
    return true;
  }
  if (await page.isVisible('text=Set your glass')) {
    const shard = page.locator('#hand-row .shard').first();
    if ((await shard.count()) === 0) return false;
    await shard.click();
    await page.waitForTimeout(80);
    const legal = page.locator('.cell.legal').first();
    if ((await legal.count()) > 0) await legal.click();
    else if (await page.isVisible('text=Discard shard')) await page.click('text=Discard shard');
    return true;
  }
  return false;
}

async function main() {
  PeerServer({ host: '127.0.0.1', port: 9540, path: '/vitrea' });
  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await (await browser.newContext({ ...phone })).newPage());

  const [host, ...guests] = pages;
  await host.goto(BASE);
  await host.fill('#name-input', 'Wren');
  await host.click('#btn-primary');
  await host.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  const code = (await host.textContent('#lobby-code')).trim();

  const names = ['Mira', 'Soren', 'Linnea'];
  for (let i = 0; i < guests.length; i++) {
    await guests[i].goto(`${BASE}&room=${code}`);
    await guests[i].fill('#name-input', names[i]);
    await guests[i].click('#btn-primary');
    await guests[i].waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  }
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 4, { timeout: 15000 });
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });

  let steps = 0;
  while (steps++ < 4000) {
    if (await host.isVisible('#screen-end:not([hidden])')) break;
    let moved = false;
    for (const p of pages) moved = (await act(p)) || moved;
    await host.waitForTimeout(moved ? 60 : 200);
  }

  await host.waitForTimeout(2200);
  await host.screenshot({ path: `${OUT}/end-4p.png` });

  const visible = await host.evaluate(() => {
    const lis = [...document.querySelectorAll('#standings li')];
    const vh = window.innerHeight;
    return lis.map((li) => {
      const r = li.getBoundingClientRect();
      return { text: li.textContent.replace(/\s+/g, ' ').trim(), onscreen: r.top >= 0 && r.bottom <= vh };
    });
  });
  console.log('standings rows:', visible.length);
  for (const v of visible) console.log(v.onscreen ? 'VISIBLE ' : 'OFFSCREEN', v.text);
  await browser.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
