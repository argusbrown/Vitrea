# Vitrea

*A game of glass, greed & light* — a push-your-luck, stained-glass drafting game
for **2–6 players**, played on your phones over your local network.

Vitrea blends the bits we love from Azul, Flip 7 and Sagrada: drafting from a
shared pool, pressing your luck one draw too far, and fitting what survives
into a personal stained-glass window under placement constraints.

## Run it

```bash
npm install
npm start
```

Then open the printed network address (e.g. `http://192.168.1.20:3000`) on your
phone, host a game, and let everyone else **scan the QR code** in the lobby to
join. Everyone needs to be on the same Wi-Fi network.

- `PORT=8080 npm start` to use a different port.
- If phones can't connect, check that your machine's firewall allows incoming
  connections on the port.

## How to play

On your turn, draw glass shards from the kiln one at a time. Every draw is
revealed to all players.

- **Crack!** Draw a colour you already drew this turn and your glass shatters —
  you lose every shard you drew and your turn ends.
- **Stop in time** and you set each shard into your window. The same colour may
  never touch side-by-side. A **prism** is wild and may sit anywhere — but two
  prisms in one turn crack like any pair.
- **Perfect Spectrum:** survive 6 draws in one turn and score **+7** on the spot.

### Scoring

| | |
|---|---|
| each shard set in your window | **+1** |
| socket filled with its matching colour | **+3** |
| completed row | **+4** |
| completed column | **+6** |
| Perfect Spectrum | **+7** |
| first to finish their window | **+10** |

When someone completes their window, the round is played out so everyone has
had equal turns — then the brightest window wins.

## Tech

- Node.js server (`server/`) — plain `http` + [`ws`](https://github.com/websockets/ws)
  WebSockets, authoritative game engine, QR codes via
  [`qrcode`](https://github.com/soldair/node-qrcode). No database; rooms live in memory.
- Vanilla HTML/CSS/JS client (`public/`) — no framework, no build step.
- Players can drop and rejoin (state lives server-side; the phone keeps a
  session token). If the active player vanishes, the host can skip their turn.

### Tests

```bash
npm test               # monte-carlo + unit tests for the game engine
node test/e2e.test.js  # boots the real server and plays a full game over WebSockets
```

`test/screenshots.js` and `test/fullgame.browser.js` are optional visual dev
aids that drive the UI with phone-sized headless browsers; they need
`npm i --no-save playwright` plus a Playwright chromium.
