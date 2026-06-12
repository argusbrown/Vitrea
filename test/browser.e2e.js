'use strict';

// Full peer-to-peer end-to-end test: two phone-sized headless browsers,
// a local PeerJS signaling server standing in for the public cloud, the
// real static site. Joins via the QR-code URL, plays a complete game with
// greedy bots, reloads the host mid-game to prove the room resurrects,
// and captures screenshots along the way.
//
// Needs: npm i --no-save peer playwright   (plus a Playwright chromium)

process.env.PORT = '3460';
require('../server/index'); // static file server
const { PeerServer } = require('peer');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const PS_PORT = 9460;
const BASE = `http://localhost:3460/?ps=127.0.0.1:${PS_PORT}`;
const OUT = __dirname + '/../shots';

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

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
  PeerServer({ host: '127.0.0.1', port: PS_PORT, path: '/vitrea' });

  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];
  const hostCtx = await browser.newContext({ ...phone });
  const guestCtx = await browser.newContext({ ...phone });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  host.on('pageerror', (e) => fail('host page error: ' + e.message));
  guest.on('pageerror', (e) => fail('guest page error: ' + e.message));

  // --- host creates a room ---
  await host.goto(BASE);
  await host.waitForTimeout(600);
  await host.screenshot({ path: `${OUT}/1-home.png` });
  await host.fill('#name-input', 'Wren');
  await host.click('#btn-primary');
  await host.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  const code = (await host.textContent('#lobby-code')).trim();
  console.log('room code:', code);

  // QR canvas painted?
  const qrPainted = await host.evaluate(() => {
    const c = document.querySelector('#lobby-qr');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 100) dark++;
    return c.width > 200 && dark > 500;
  });
  if (!qrPainted) fail('QR code not painted');
  console.log('ok — QR code painted');

  // --- guest joins via the QR-code URL ---
  const joinUrl = (await host.evaluate(() => document.querySelector('#lobby-url').textContent));
  if (!joinUrl.includes(`room=${code}`) || !joinUrl.includes('ps=')) fail('join url incomplete: ' + joinUrl);
  await guest.goto('http://' + joinUrl);
  await guest.fill('#name-input', 'Mira');
  await guest.click('#btn-primary');
  await guest.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  await host.waitForSelector('text=Mira', { timeout: 15000 });
  await host.waitForTimeout(400);
  await host.screenshot({ path: `${OUT}/2-lobby.png` });
  console.log('ok — guest joined over WebRTC');

  // --- start and play a bit ---
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
  await guest.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });

  for (let i = 0; i < 14; i++) {
    await act(host);
    await act(guest);
    await host.waitForTimeout(160);
  }
  await host.screenshot({ path: `${OUT}/3-midgame-host.png` });
  await guest.screenshot({ path: `${OUT}/4-midgame-guest.png` });

  // --- host phone "crashes": reload must resurrect the room ---
  const scoreBefore = await host.evaluate(() =>
    [...document.querySelectorAll('.chip-score')].map((e) => e.textContent).join(','));
  await host.reload();
  await host.waitForSelector('#screen-game:not([hidden])', { timeout: 20000 });
  const scoreAfter = await host.evaluate(() =>
    [...document.querySelectorAll('.chip-score')].map((e) => e.textContent).join(','));
  if (scoreBefore !== scoreAfter) fail(`host resume lost state (${scoreBefore} -> ${scoreAfter})`);
  console.log('ok — host reload resurrected the game, scores intact:', scoreAfter);

  // guest must find the host again on its own
  await guest.waitForFunction(() => {
    const chips = document.querySelectorAll('.player-chip');
    return chips.length === 2 && ![...chips].some((c) => c.classList.contains('away'));
  }, { timeout: 30000 });
  console.log('ok — guest reconnected automatically');

  // --- play to the end ---
  let steps = 0;
  while (steps++ < 1200) {
    if (await host.isVisible('#screen-end:not([hidden])')) break;
    const moved = (await act(host)) || (await act(guest));
    await host.waitForTimeout(moved ? 140 : 350);
  }
  if (!(await host.isVisible('#screen-end:not([hidden])'))) {
    await host.screenshot({ path: `${OUT}/9-stuck-host.png` });
    await guest.screenshot({ path: `${OUT}/9-stuck-guest.png` });
    fail('game did not finish within step budget');
  }
  await guest.waitForSelector('#screen-end:not([hidden])', { timeout: 10000 });
  await host.waitForTimeout(2100); // let the final banner fade
  await host.screenshot({ path: `${OUT}/5-end.png` });
  console.log(`ok — full P2P game finished in ${steps} steps`);

  // --- rematch ---
  await host.click('#btn-again');
  await host.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
  await guest.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
  console.log('ok — rematch works');

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
