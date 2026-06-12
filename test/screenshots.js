'use strict';

// Drives the real app with two phone-sized headless browsers and captures
// screenshots of every screen. Dev aid only.

process.env.PORT = '3299';
require('../server/index');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:3299';
const OUT = __dirname + '/../shots';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];

  const hostCtx = await browser.newContext({ ...phone });
  const guestCtx = await browser.newContext({ ...phone });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // --- home ---
  await host.goto(BASE);
  await host.waitForTimeout(800);
  await host.screenshot({ path: `${OUT}/1-home.png` });

  // --- lobby ---
  await host.fill('#name-input', 'Wren');
  await host.click('#btn-primary');
  await host.waitForSelector('#screen-lobby:not([hidden])');
  const code = (await host.textContent('#lobby-code')).trim();
  console.log('room code:', code);

  await guest.goto(`${BASE}/?room=${code}`);
  await guest.fill('#name-input', 'Mira');
  await guest.click('#btn-primary');
  await guest.waitForSelector('#screen-lobby:not([hidden])');
  await host.waitForTimeout(600);
  await host.screenshot({ path: `${OUT}/2-lobby.png` });

  // --- game: draw phase ---
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])');
  await guest.waitForSelector('#screen-game:not([hidden])');
  await host.waitForTimeout(2200); // let the "your turn" banner pass

  // draw until someone is holding 2 shards, surviving any busts on the way
  let active = null;
  let shotsTaken = false;
  for (let tries = 0; tries < 60; tries++) {
    active = (await host.isVisible('text=Draw a shard')) ? host
      : (await guest.isVisible('text=Draw a shard')) ? guest : null;
    if (!active) { await host.waitForTimeout(300); continue; }
    const hand = await active.locator('#hand-row .shard').count();
    if (hand >= 2) {
      if (!shotsTaken) {
        shotsTaken = true;
        await active.screenshot({ path: `${OUT}/3-drawing.png` });
        await (active === host ? guest : host).screenshot({ path: `${OUT}/4-spectating.png` });
      }
      await active.click('#kiln-actions .btn:nth-child(2)'); // Keep N shards
      await active.waitForTimeout(400);
      if (await active.isVisible('text=Set your glass')) break;
    } else {
      await active.click('text=Draw a shard');
      await active.waitForTimeout(350);
    }
  }
  await active.click('#hand-row .shard');
  await active.waitForTimeout(500);
  await active.screenshot({ path: `${OUT}/5-placing.png` });

  // place both shards legally via the highlighted cells
  for (let i = 0; i < 2; i++) {
    const cell = await active.$('.cell.legal');
    if (!cell) {
      await active.click('text=Discard shard');
    } else {
      await cell.click();
    }
    await active.waitForTimeout(400);
    const shard = await active.$('#hand-row .shard');
    if (shard) await shard.click();
    await active.waitForTimeout(300);
  }
  await active.waitForTimeout(500);
  await active.screenshot({ path: `${OUT}/6-after-place.png` });

  // --- rules overlay ---
  await host.click('#btn-game-help');
  await host.waitForTimeout(400);
  await host.screenshot({ path: `${OUT}/7-rules.png` });

  await browser.close();
  console.log('screenshots written to', OUT);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
