# Vitrea — TODO

## 1. Reliable TURN relay (highest priority for off-hotspot play)

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
- Game length feels long? Lower `MAX_ROUNDS` (30) or `COPIES_PER_COLOR` (16).
- Prisms too common/rare? `PRISM_COUNT` (8).
- Scoring weights: `SPECTRUM_BONUS` 7, `MATCH_BONUS` 3, `ROW_BONUS` 4,
  `COL_BONUS` 6, `FINISH_BONUS` 10.
- Board size: `ROWS` 5 × `COLS` 4.

## 3. Nice-to-haves (unprioritised)
- Per-player turn timer / auto-skip for AFK players (host can already manually
  skip a disconnected player).
- Sound effects (draw, crack, spectrum, win).
- Spectator mode for a 7th+ person.
- A "copy join link" button in the lobby as an alternative to the QR code.
