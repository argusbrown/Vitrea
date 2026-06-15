# CLAUDE.md — Vitrea

Guidance for AI agents (and humans) working in this repo.

## What this is

**Vitrea** is a push-your-luck stained-glass drafting game for 2–6 players, each
on their own phone. It blends Azul/Sagrada (draft & place under constraints) with
Flip 7 (press your luck on each draw). It is a **static web app** played
peer-to-peer — there is no game server.

- **Live:** https://argusbrown.github.io/Vitrea/
- **Default branch:** `main` (auto-deploys to GitHub Pages on every push).

## Architecture (read this before changing networking)

**The host's browser tab IS the server.** Whoever taps "Host a game" runs the
authoritative game engine in their tab. Other phones connect **directly to the
host over WebRTC data channels** (via PeerJS). A public PeerJS signaling server
is used only to introduce peers; after that, traffic is phone-to-phone. All game
state is public, so the host broadcasts one full snapshot to every client.

Wire protocol (identical for the host's own UI via loopback and for guests):
- client → room: `{type: join|rejoin|start|draw|stop|place|discard|skipTurn|endGame|leave|playAgain}`
- room → client: `{type: joined|state|error}`

## Files

```
public/
  index.html            app shell (all screens; [hidden] toggled by app.js)
  css/style.css         all styling; stained-glass theme
  js/
    engine.js           PURE game logic. UMD: module.exports AND window.VitreaEngine.
                        Game class + toJSON/fromJSON. Tuning constants at the top.
    net.js              VitreaNet: authoritative Room (host side) + host()/join()
                        WebRTC transports, reconnect, host-resume. ICE_CONFIG holds
                        STUN only; the Cloudflare TURN relay is fetched at runtime
                        (TURN_WORKER_URL). ?ps=host:port overrides signaling (tests).
    nettest.js          VitreaNetTest: home-screen "Connection check" diagnostics
                        (probes signaling, STUN, and the Cloudflare relay).
    version.js          window.VITREA_VERSION {semver, build}. "__BUILD__" is
                        replaced with commit+date by the deploy workflow.
    app.js              UI: single state-driven render(), no framework.
    vendor/             peerjs.min.js, qrcode.js (both MIT, vendored — no CDN).
server/index.js         OPTIONAL zero-dependency static dev server (npm start).
                        NOT used in production; Pages serves public/ directly.
worker/                 Cloudflare Worker that mints short-lived TURN credentials
                        (index.js + wrangler.toml + README). Keeps the relay key
                        out of this public page; net.js fetches creds via
                        TURN_WORKER_URL — if unset/unreachable it uses STUN only
                        (direct connections, no relay).
test/
  game.test.js          monte-carlo + unit tests for the engine (npm test).
  browser.e2e.js        full P2P game in 2 headless browsers w/ local PeerJS.
  endscreen.shot.js     screenshots the end screen with 4 players.
.github/workflows/pages.yml   deploy public/ to Pages on push to main; stamps version.
```

## Dev / test commands

```bash
npm start               # static dev server on :3000 (optional; for local play)
npm test                # engine tests — fast, no deps, run this for any engine change
node test/browser.e2e.js    # full P2P regression; needs: npm i --no-save peer playwright
                            # (+ a Playwright chromium). Drives 2 phone-sized browsers.
```

There is no build step and no production dependencies — `public/` is shipped as-is.
`peer` and `playwright` are dev-only and installed with `--no-save`.

## Conventions / gotchas

- **The engine is the source of truth.** Clients send intents; the host's engine
  validates and rejects illegal moves. Don't trust client-side checks for rules.
- **Keep the engine pure** (no DOM, no I/O) so it runs in both Node (tests) and the
  browser. It's loaded via the UMD wrapper at the top/bottom of `engine.js`.
- **Tuning the game:** all constants (board size, bag composition, scoring,
  `DISCARD_PENALTY`, MAX_ROUNDS) are at the top of `engine.js`. Change there only.
- **Scores can go negative.** Each deliberate discard costs `DISCARD_PENALTY`
  points, so a player's `score` may dip below zero — tests assert an integer
  score, not a non-negative one.
- **No accidental control characters in regexes.** `sanitizeName` uses
  `\u0000-\u001f` escapes on purpose — don't paste literal control ranges.
- **Versioning:** bump `semver` in BOTH `public/js/version.js` and `package.json`
  when shipping a user-visible change. The build hash is stamped automatically.
- **Screens must scroll, not clip.** `.screen` uses `overflow-y:auto` and
  `justify-content: safe center`; tall content (big lobbies, full standings) must
  remain reachable on short phone viewports.

## Deploy

Push to `main` → `.github/workflows/pages.yml` stamps the version and publishes
`public/` to Pages. The `github-pages` environment is restricted to `main`. The
home screen shows `v<semver> · <commit> · <date>` so two phones can confirm they
run the same build (Pages caches assets up to ~10 min).

## Known limitations

- **TURN relay:** networks with client/AP isolation (some guest/hotel/office
  Wi-Fi) block direct phone-to-phone links. The `worker/` Cloudflare broker
  (deployed at `https://vitrea-turn.vitrea.workers.dev`; `TURN_WORKER_URL` in
  `net.js`) mints short-lived credentials and relays around that. The dead free
  public relays were removed once it went live, so there is **no relay fallback**
  if the Worker is unreachable — play then needs a phone hotspot or cellular.
  The "Connection check" button diagnoses which leg fails.
- Some restrictive cellular carriers (CGNAT) also block direct links → same fix.

## Git

- **Every new feature or change happens in a git worktree** — never commit
  feature work directly on `main`. Create one per branch before you start.
- **Worktrees live locally at `.claude/worktrees/<branch>`.** Create with:
  ```bash
  git worktree add .claude/worktrees/<branch> -b <branch>
  ```
  Remove when merged: `git worktree remove .claude/worktrees/<branch>`.
- `.claude/` is gitignored, so worktrees never get committed into the tree.
- Develop on the feature branch, then merge to `main` (which deploys).
- Do not commit `node_modules/` or `shots/` (gitignored).
