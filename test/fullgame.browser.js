'use strict';

// Plays an entire game through the real browser UI with two phone-sized
// pages clicking real buttons, then screenshots the end screen. Dev aid.

process.env.PORT = '3399';
require('../server/index');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:3399';
const OUT = __dirname + '/../shots';

async function act(page) {
  // one greedy bot action, if any is available on this page
  if (await page.isVisible('text=Draw a shard')) {
    const handSize = await page.locator('#hand-row .shard').count();
    if (handSize < 2) await page.click('text=Draw a shard');
    else await page.click('#kiln-actions .btn:nth-child(2)'); // Keep N shards
    return true;
  }
  if (await page.isVisible('text=Set your glass')) {
    const shard = page.locator('#hand-row .shard').first();
    if ((await shard.count()) === 0) return false;
    await shard.click();
    await page.waitForTimeout(120);
    const legal = page.locator('.cell.legal').first();
    if ((await legal.count()) > 0) await legal.click();
    else if (await page.isVisible('text=Discard shard')) await page.click('text=Discard shard');
    return true;
  }
  return false;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];
  const host = await (await browser.newContext({ ...phone })).newPage();
  const guest = await (await browser.newContext({ ...phone })).newPage();

  await host.goto(BASE);
  await host.fill('#name-input', 'Wren');
  await host.click('#btn-primary');
  await host.waitForSelector('#screen-lobby:not([hidden])');
  const code = (await host.textContent('#lobby-code')).trim();

  await guest.goto(`${BASE}/?room=${code}`);
  await guest.fill('#name-input', 'Mira');
  await guest.click('#btn-primary');
  await host.waitForSelector('#btn-start:not([disabled])');
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])');

  let steps = 0;
  while (steps++ < 1200) {
    if (await host.isVisible('#screen-end:not([hidden])')) break;
    const moved = (await act(host)) || (await act(guest));
    await host.waitForTimeout(moved ? 140 : 350);
  }

  if (!(await host.isVisible('#screen-end:not([hidden])'))) {
    console.error('game did not finish within step budget (steps=' + steps + ')');
    await host.screenshot({ path: `${OUT}/9-stuck.png` });
    process.exit(1);
  }

  await host.waitForTimeout(900);
  await host.screenshot({ path: `${OUT}/8-end.png` });
  console.log('ok — full game played through the UI in', steps, 'steps');
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
