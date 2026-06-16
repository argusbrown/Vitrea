# Vitrea — TODO

## 1. Reliable TURN relay (highest priority for off-hotspot play)

> **DONE (2026-06-14):** Option B (Cloudflare) is **live**. The credential Worker
> ([`worker/`](worker/)) is deployed at `https://vitrea-turn.vitrea.workers.dev`
> and wired into `public/js/net.js` (`TURN_WORKER_URL`, `resolveIce`). The
> `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` secrets live in the Worker (not the repo).
> To rotate creds: regenerate the key in the dashboard → `wrangler secret put` the
> new values. To verify: home-screen Connection check, relay leg should pass.

**Problem:** On Wi-Fi with client/AP isolation (phones can't talk directly), WebRTC
needs a TURN relay to bridge them. The two *free public* relays currently in
`public/js/net.js` (`ICE_CONFIG`) — PeerJS's own relay and OpenRelay/metered's
open project — are unreachable/dead in testing. Result: phone-to-phone play fails
on isolated Wi-Fi. **Hotspot works** (devices reach each other directly, no relay
needed), and open networks work via STUN. The Connection check on the home screen
(`nettest.js`) confirms: matchmaking ✓, STUN ✓, both relays ✗.

The fix is real TURN credentials. Three options were evaluated:

### Option A — metered.ca (simplest, fits our serverless static site)
- Free tier: 50 GB/month (ample; the game relays kilobytes per move).
- Issues **static** username/password credentials → paste straight into
  `ICE_CONFIG` in `public/js/net.js`. Can be domain-locked to the game URL so
  randoms can't abuse them.
- No backend needed. ~5 min: sign up → create credentials → send the 3 values
  (turn url, username, credential) → bake in.

### Option B — Cloudflare Realtime TURN (best network; needs a tiny Worker)
- Free tier: 1,000 GB/month (shared with their SFU). STUN already free/unlimited
  at `stun.cloudflare.com` (we already use it). Relays on port 443/TCP — punches
  through isolated Wi-Fi well.
- **Catch:** Cloudflare refuses static credentials. You must mint *short-lived*
  credentials server-side via their REST API using a secret API token, which
  CANNOT live in our public static page. So this requires adding a small
  **Cloudflare Worker** (free, ~20 lines) that holds the TURN key + API token and
  hands each phone a fresh ~24h credential on load. Client then fetches creds from
  the Worker before connecting.
- ~15 min: Cloudflare account → create a TURN key (get Token ID + API token) →
  deploy the Worker (code to be written) → client fetches from it.
- Endpoint to mint creds:
  `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate`
  with `Authorization: Bearer $TURN_KEY_API_TOKEN` and body `{"ttl": 86400}`.
- Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/

### Option C — self-host coturn
- Full control, but needs a small always-on VPS (~$4–5/mo) and DNS/TLS setup.
  Overkill unless the game gets heavy use. Not recommended for now.

**Recommendation:** Option A (metered) for least friction; Option B (Cloudflare)
if we want the bigger/faster network and don't mind deploying one Worker.

## 2. Possible balance tuning (after real playtests)
All knobs are constants at the top of `public/js/engine.js`:
- Board size: `ROWS` 5 × `COLS` 5 (square enables the two diagonals).
- Game length feels long? Lower `MAX_ROUNDS` (30) or `COPIES_PER_COLOR` (18).
- Prisms double as shields now — too common/rare? `PRISM_COUNT` (12).
- Scoring weights: `SPECTRUM_TIERS` {4:3, 5:6, 6:12}, `MATCH_BONUS` 3,
  `ROW_BONUS` 5, `COL_BONUS` 6, `DIAG_BONUS` 8, `FINISH_BONUS` 10.
- Diagonals aren't constrained by the no-adjacent-colour rule (diagonal cells
  don't touch orthogonally), so they're a touch easier than rows/cols — tune
  `DIAG_BONUS` down if they feel too cheap.
- Spectrum scoring is tiered (v1.14.0): banking 4/5/6 distinct colours in a turn
  pays 3/6/12 via `SPECTRUM_TIERS`. Holding all six (`SPECTRUM_SIZE`) auto-scores
  the top tier as a Perfect Spectrum; 4–5 score when you stop. The prism shield is
  what makes surviving toward six feasible. A full spectrum is ~1 in 20 (keep
  pressing); a 5-colour bank ~1 in 5. If the top tier feels too rare, raise
  `PRISM_COUNT` or lower `SPECTRUM_SIZE`; if partials feel too cheap, retune the
  tier table.

## 3. Sound effects

> **DONE (shipped v1.13.0):** Approach B (glassy synthesized audio system, zero
> assets) is live in `public/js/sfx.js` — pure Web Audio synthesis, a declarative
> `SOUND_MAP` keyed by game event, single dispatch from `processEvents`. Glassy
> chimes; draw pitch rises with `crackRisk`; synthesized shatter on bust; mute
> toggle (default audible) persisted in localStorage.
> Plan of record:
> `~/.gstack/projects/argusbrown-Vitrea/abrown-main-design-20260615-162732.md`.
> Only Approach C (3a) remains as future work.

### 3a. Approach C — generative glass instrument (future, after B ships)
- **What:** Add a "color → pitch" sound mode toggle mapping each shard color to a
  note in a fixed pleasant scale (pentatonic / just intonation), so a good round
  audibly composes a little melody; a bust shatters the phrase.
- **Why:** The most distinctive "show a friend" delight, and deeply on-theme
  (stained glass = light as color = pitch).
- **Pros:** Unique, memorable; minimal new infra if the B `SOUND_MAP` is built to
  allow swapping cue recipes.
- **Cons:** Tuning risk (gimmicky if the scale is wrong); must stay pleasant across
  up to six near-simultaneous phones.
- **Depends on:** Approach B (`sfx.js` + `SOUND_MAP`) shipping first.

## 4. Nice-to-haves (unprioritised)
- Per-player turn timer / auto-skip for AFK players (host can already manually
  skip a disconnected player).
- Spectator mode for a 7th+ person.
- A "copy join link" button in the lobby as an alternative to the QR code.
