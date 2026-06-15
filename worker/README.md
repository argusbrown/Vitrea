# Vitrea TURN credential broker

A tiny Cloudflare Worker that mints **short-lived** Cloudflare Realtime TURN
credentials for the game. It exists because Cloudflare refuses static TURN
credentials — and because this game's source is public, any secret baked into
`public/js/net.js` would be world-readable. The Worker keeps the relay key in
encrypted secrets and only hands credentials to requests coming from the real
game page (Origin allowlist in `index.js`).

## One-time setup

1. **Cloudflare account** → dashboard → **Realtime** → **TURN** → *Create a TURN key*.
   Copy the two values it shows:
   - **Token ID**  → this is `TURN_KEY_ID`
   - **API token** → this is `TURN_KEY_API_TOKEN` (the secret — shown once)

2. **Deploy the Worker** (from this `worker/` dir):
   ```bash
   npx wrangler login
   npx wrangler secret put TURN_KEY_ID          # paste the Token ID
   npx wrangler secret put TURN_KEY_API_TOKEN   # paste the API token
   npx wrangler deploy
   ```
   Wrangler prints the deployed URL, e.g. `https://vitrea-turn.<your-subdomain>.workers.dev`.

3. **Wire it into the game:** put that URL in `TURN_WORKER_URL` near the top of
   [`../public/js/net.js`](../public/js/net.js). Commit + push → Pages redeploys.

4. **Verify:** open the game, tap **Connection check** on the home screen — the
   Cloudflare relay leg should now pass. Or hit the Worker URL from the game page
   and confirm it returns `{ "iceServers": { ... } }`.

## How the client uses it

On connect, `net.js` fetches credentials from the Worker (cached ~24h, with a
4s timeout) and prepends the Cloudflare relay to the ICE list. If the Worker is
unreachable it silently falls back to the static STUN + free relays, so play on
hotspot/open networks never depends on this.

## Abuse / cost notes

- The endpoint is intentionally unauthenticated (every player's phone must reach
  it before they have an account). The **Origin allowlist** blocks casual
  web-based leeching; it is *soft* (a scripted client can forge `Origin`), so it
  is backed by the **24h TTL** (`TTL_SECONDS` in `index.js`).
- Free tier is 1,000 GB/month; the game relays kilobytes per move, so real abuse
  is unlikely. If you want a hard cap, add a **Rate limiting rule** on the
  Worker route in the Cloudflare dashboard (e.g. N requests / IP / minute), and
  set a **usage alert**.
- To revoke everything instantly: delete the TURN key in the dashboard (all
  outstanding credentials stop working) or `npx wrangler delete` the Worker.
