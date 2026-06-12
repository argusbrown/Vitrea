'use strict';

// End-to-end smoke test: boots the real server, connects two WebSocket
// clients, creates/joins/starts a game and plays until it finishes.

process.env.PORT = '3199';
const WebSocket = require('ws');
require('../server/index');

const URL = 'ws://localhost:3199';

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT FAILED: ' + msg);
    process.exit(1);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.you = null;
    this.state = null;
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') this.you = msg.you;
        if (msg.type === 'state') this.state = msg;
        if (msg.type === 'error') this.lastError = msg.message;
        this.waiters = this.waiters.filter((w) => !w(msg));
      });
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  // resolves when a message arrives that makes pred(state) true
  until(pred, label) {
    if (this.state && pred(this.state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: ' + label)), 8000);
      this.waiters.push(() => {
        if (this.state && pred(this.state)) {
          clearTimeout(t);
          resolve();
          return true;
        }
        return false;
      });
    });
  }
}

async function main() {
  // static serving
  const res = await fetch('http://localhost:3199/');
  assert(res.ok, 'index served');
  const html = await res.text();
  assert(html.includes('Vitrea'), 'app shell content');
  const css = await fetch('http://localhost:3199/css/style.css');
  assert(css.ok && (css.headers.get('content-type') || '').includes('text/css'), 'css served');
  const fallback = await fetch('http://localhost:3199/?room=ABCD');
  assert(fallback.ok && (await fallback.text()).includes('Vitrea'), 'room URL falls back to shell');

  const host = new Client('Hosty');
  const guest = new Client('Guesty');
  await host.connect();
  await guest.connect();

  host.send({ type: 'create', name: 'Hosty' });
  await host.until((s) => s.phase === 'lobby', 'lobby created');
  const code = host.state.code;
  assert(/^[A-Z2-9]{4}$/.test(code), 'room code shape: ' + code);
  assert(host.state.qrDataUrl.startsWith('data:image/png'), 'QR data url present');
  assert(host.state.joinUrl.includes(code), 'join url contains code');

  guest.send({ type: 'join', code, name: 'Guesty' });
  await guest.until((s) => s.players && s.players.length === 2, 'guest joined');
  await host.until((s) => s.players.length === 2, 'host sees guest');

  // non-host cannot start
  guest.send({ type: 'start' });
  await new Promise((r) => setTimeout(r, 200));
  assert(guest.state.phase === 'lobby', 'non-host start rejected');

  host.send({ type: 'start' });
  await host.until((s) => s.phase === 'playing', 'game started');
  await guest.until((s) => s.phase === 'playing', 'guest sees game');
  assert(host.state.game.players.length === 2, 'two seats');

  // play the whole game through the wire with a simple greedy policy
  const byId = (c) => c.state.game.players.find((p) => p.id === c.you.id);
  const clients = { [host.you.id]: host, [guest.you.id]: guest };

  let safety = 4000;
  while (host.state.phase === 'playing' && safety-- > 0) {
    const g = host.state.game;
    const active = g.players[g.turnSeat];
    const c = clients[active.id];
    const before = JSON.stringify(c.state.game);

    if (g.turnPhase === 'draw') {
      if (g.hand.length < 2) c.send({ type: 'draw' });
      else c.send({ type: 'stop' });
    } else {
      const me = byId(c);
      const shard = g.hand[0];
      let placed = false;
      outer: for (let r = 0; r < g.rules.rows; r++) {
        for (let col = 0; col < g.rules.cols; col++) {
          if (me.window[r][col] !== null) continue;
          if (shard !== g.rules.prism) {
            const around = [[r - 1, col], [r + 1, col], [r, col - 1], [r, col + 1]];
            const bad = around.some(([nr, nc]) =>
              nr >= 0 && nr < g.rules.rows && nc >= 0 && nc < g.rules.cols && me.window[nr][nc] === shard);
            if (bad) continue;
          }
          c.send({ type: 'place', i: 0, r, c: col });
          placed = true;
          break outer;
        }
      }
      if (!placed) c.send({ type: 'discard', i: 0 });
    }
    await host.until((s) => JSON.stringify(s.game) !== before || s.phase !== 'playing', 'state advanced');
    await new Promise((r) => setTimeout(r, 5));
  }

  assert(host.state.phase === 'finished', 'game reached the end');
  assert(host.state.game.standings.length === 2, 'standings published');
  const scores = host.state.game.players.map((p) => p.score);
  console.log(`ok — e2e game finished, scores: ${scores.join(' vs ')}`);

  // play again resets
  host.send({ type: 'playAgain' });
  await host.until((s) => s.phase === 'playing', 'rematch starts');
  assert(host.state.game.players.every((p) => p.score === 0), 'rematch scores reset');
  console.log('ok — rematch works');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
