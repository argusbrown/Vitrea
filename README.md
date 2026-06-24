# Vitrea

*A game of glass, greed & light* — a push-your-luck, stained-glass drafting game
for **2–6 players**, played on phones, anywhere.

Vitrea blends the bits we love from Azul, Flip 7 and Sagrada: drafting from a
shared pool, pressing your luck one draw too far, and fitting what survives
into a personal stained-glass window under placement constraints.

## How it works

**There is no game server.** The whole game is a static web page; whoever taps
*Host a game on this phone* runs the authoritative game inside their browser
tab, and everyone else's phone connects **directly to it over WebRTC**
(peer-to-peer, via [PeerJS](https://peerjs.com)). A public signaling service is
used once to introduce the phones to each other; after that, game traffic flows
phone-to-phone. When a network blocks those direct links, the game falls back to
a **TURN relay** so it still connects (see [If a phone can't join](#if-a-phone-cant-join)).

So you can play at a pub, a campsite with cell coverage, or on a train:

1. Open the game page on your phone and **host a game**.
2. Friends **scan the QR code** on your screen (or type the 4-letter code on
   the same page).
3. Play. Everyone just needs an internet connection — any network, no shared
   Wi-Fi required.

The host's phone keeps the game in `localStorage`, so even if the host's
browser reloads, the room resurrects and everyone reconnects automatically.
Guests who drop (phone locked, tunnel, …) rejoin with their seat and score
intact.

## Deploying / running it

The game is the `public/` folder — plain static files, no build step. Host it
on anything that serves files over HTTPS and share that URL:

- **GitHub Pages, Netlify, Cloudflare Pages, …** — point it at `public/`, done.
- For local development (or LAN play at home): `npm start` serves `public/` on
  port 3000 with zero dependencies, and prints your LAN address.

If the public PeerJS cloud is ever unreachable, you can run your own signaling
server (`npx peer --port 9000 --path /vitrea`) and append
`?ps=yourhost:9000` to the game URL.

### If a phone can't join

The home screen has a **Connection check** button that probes each leg of the
connection separately — the matchmaking service, address discovery (STUN), and
the relay — so a failure names its cause instead of leaving you guessing.

Joining also reports exactly where it got stuck instead of hanging:

- **"Could not reach the matchmaking service"** — that phone has no working
  path to the internet (or something is blocking `peerjs.com`).
- **"…couldn't open a direct link between the phones"** — the network blocks
  device-to-device traffic (guest/hotel/office Wi-Fi often does, via AP
  isolation). The game automatically falls back to a **TURN relay** that bridges
  the two phones, so this usually still connects. If the relay is *also* blocked
  or unreachable, have everyone switch to cellular data, or have the host start a
  phone hotspot and the others join it.
- Make sure the **host's screen stays on** while people are joining — the game
  lives in the host's browser tab.

## How to play

On your turn, draw glass shards from the kiln one at a time. Every draw is
revealed to all players.

- **Crack!** Draw a colour you already drew this turn and your glass shatters —
  you lose every shard you drew and your turn ends.
- **Prism shield.** A **prism** is wild — it never clashes, so you can stockpile
  prisms, and if you draw a colour you already hold you may spend one to absorb
  the clash instead of cracking. When placed, a prism may sit anywhere.
- **Stop in time** and you set each shard into your window. The same colour may
  never touch side-by-side.
- **Chase the spectrum.** The more distinct colours you bank in one turn, the
  bigger the bonus — **+3 / +6 / +12** for 4 / 5 / all 6 colours — so pushing
  pays even short of the full set. Holding all six is a **Perfect Spectrum**,
  scored the instant you draw the sixth.
- **Discarding costs you.** A shard with no legal cell (or one you don't want)
  may be discarded, but each discard costs **−1** point.

### Scoring

| | |
|---|---|
| set a shard in your window | **+ the length of the contiguous row/column run it joins** (both, if it lands at a junction) |
| socket filled with its matching colour | **+3** |
| completed single-colour diagonal (prism is wild) | **+8** |
| bank 4 / 5 / all 6 colours in a turn (6 = Perfect Spectrum) | **+3 / +6 / +12** |
| first to finish their window | **+10** |
| each shard discarded | **−1** |

When someone completes their window, the round is played out so everyone has
had equal turns — then the brightest window wins.

## Code layout

- `public/js/engine.js` — the pure game engine (runs in the host's browser;
  also loaded by Node for tests). Bag composition, scoring values and board
  size are constants at the top.
- `public/js/net.js` — the authoritative Room (host side) and the WebRTC
  host/guest transports, including reconnect and host-resume logic. Uses STUN
  plus a Cloudflare TURN relay (credentials fetched at runtime) for networks
  that block direct links.
- `public/js/nettest.js` — the **Connection check** diagnostics on the home
  screen (matchmaking, STUN, relay).
- `public/js/app.js` — UI: state-driven rendering, no frameworks.
- `public/js/vendor/` — vendored [PeerJS](https://github.com/peers/peerjs) and
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
- `server/index.js` — optional zero-dependency static server for development.
- `worker/` — a small [Cloudflare Worker](worker/README.md) that mints
  short-lived TURN-relay credentials. It's a credential broker, **not** a game
  server (the game stays serverless); it keeps the relay key out of the public
  page. The game still works peer-to-peer without it — just without the relay.

### Tests

```bash
npm test                  # monte-carlo + unit tests for the game engine
node test/browser.e2e.js  # full P2P game in two headless phone browsers,
                          # incl. a mid-game host reload; needs:
                          # npm i --no-save peer playwright
```
