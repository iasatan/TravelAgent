# Cloudflare Worker

The Worker exposes only `GET /api/destinations` and `OPTIONS` for that endpoint. It calls fixed Ryanair and Wizz Air website endpoints; callers cannot select an upstream URL. It does not use a paid API key or call bot-gated endpoints.

## Configure and deploy

Run the following commands from the repository root.

1. Replace `YOUR_GITHUB_USERNAME` in `worker/wrangler.jsonc` with the exact GitHub Pages origin, for example `https://owner.github.io`. Add `http://localhost:4173` if using the local preview server.
2. Authenticate with `npx wrangler login`.
3. Deploy with `npx wrangler deploy --config worker/wrangler.jsonc`.
4. The Worker is deployed at `https://travel-agent-api.satanadam.workers.dev`; this URL is already configured in the `travel-agent-api` meta tag in the root `index.html`.

`WIZZ_API_BASE_URL` is pinned to the current website API version. If Wizz changes that version, update the value in `wrangler.jsonc` and redeploy.

The Worker does not store or expose API credentials. Airline endpoints are undocumented, may change, and must be used only in compliance with each airline's terms. No bot protection is bypassed.

Monthly destination results are cached at the Worker for 14 days; airline airport/network reference data is cached for 30 days. The browser independently caches results in localStorage for 14 days.