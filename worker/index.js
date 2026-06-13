/**
 * Vitrea TURN credential broker (Cloudflare Worker).
 *
 * Cloudflare Realtime TURN refuses static credentials, so this Worker mints
 * SHORT-LIVED ones on demand. It holds the relay key + API token as Worker
 * secrets (never in this public repo) and hands each phone a fresh ~24h
 * credential when it loads the game. Requests are only served to an allowed
 * Origin, so other people's copies of the game can't leech the relay.
 *
 * Set the secrets once (they are never committed):
 *   npx wrangler secret put TURN_KEY_ID          # the TURN key's Token ID
 *   npx wrangler secret put TURN_KEY_API_TOKEN   # the TURN key's API token
 *
 * Then: npx wrangler deploy
 *
 * The Origin check is a soft wall (a non-browser client can forge the header),
 * so it is backed by short TTLs. For heavy abuse, add Cloudflare rate limiting
 * on the route in the dashboard — see README.md.
 */

// Only these page origins may mint credentials. Add your custom domain here if
// you ever move off github.io. localhost entries let `npm start` test locally.
const ALLOWED_ORIGINS = [
  'https://argusbrown.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const TTL_SECONDS = 86400; // 24h — short enough that a leaked cred expires fast.

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (body, status) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!allowed) return json({ error: 'origin not allowed' }, 403);

    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return json({ error: 'worker is missing TURN secrets' }, 500);
    }

    let upstream;
    try {
      upstream = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TTL_SECONDS }),
        },
      );
    } catch {
      return json({ error: 'could not reach Cloudflare TURN API' }, 502);
    }

    if (!upstream.ok) return json({ error: 'could not mint credentials' }, 502);

    // Cloudflare returns { iceServers: { urls: [...], username, credential } }.
    const data = await upstream.json();
    return json({ iceServers: data.iceServers, ttl: TTL_SECONDS }, 200);
  },
};
