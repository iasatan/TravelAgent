# Travel Agent

Find direct destinations matching a selected month's historical climate, airline preference, and maximum flight time. The UI is Hungarian; the product name remains Travel Agent.

> Screenshot: add a screenshot of the search and results view here.

## Architecture

- Static HTML5 and CSS, plus native TypeScript compiled to browser ES modules.
- No frontend framework, bundler, CSS framework, or production npm dependency.
- Cloudflare Worker calls the airlines' public website endpoints from a fixed upstream allowlist; no aviation API key is required.
- Open-Meteo Archive API supplies historical daily temperatures.
- Small bundled airport subset resolves coordinates and IANA time zones. It is based on OurAirports airport data, which is public domain; source: [OurAirports](https://ourairports.com/data/).

## Local development

Requirements: Node.js 22 or newer and npm.

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

The preview server prints its local URL (default `http://127.0.0.1:4173`). The flight search requires a deployed or locally served Worker and its URL in the `travel-agent-api` meta tag in `index.html`. Climate data uses the public Open-Meteo endpoint directly from the browser.

## Climate calculation

For each destination airport, the app requests daily `temperature_2m_mean` and `temperature_2m_max` from Open-Meteo Archive for 2015–2025, using the airport coordinates and IANA time zone. It averages all available daily values in the selected calendar month across that reference period. This is a multi-year climate estimate, not a forecast. Missing airport climate requests do not discard successful destinations; at most four requests run at once.

Climate results are cached in localStorage for 30 days under a versioned airport/month/reference-period key. “Adatok frissítése” bypasses the climate and browser route caches.

## Flight data and duration

The frontend depends on the normalized `FlightRoute` model, not provider JSON. For Ryanair, the Worker calls the website's monthly `oneWayFares` endpoint and active-airports endpoint. For Wizz Air, it uses the API base configured in `worker/wrangler.jsonc`, starts an anonymous read-only session, loads `asset/map`, and checks monthly operation dates through `FlightDatesMultiArrival` in batches of five. It does not call Wizz's bot-gated fare/booking search endpoints and does not attempt to bypass bot protection. Ryanair uses `FR`; Wizz Air aliases are configurable (`W6`, `W9`, `W4`, `5W`).

Provider results confirm at least one Ryanair fare or Wizz operating date in the selected month; they are not a booking guarantee and can change. Ryanair's times are local airport times without UTC offsets, while the Wizz batch endpoint returns operating dates only. Until a trustworthy elapsed duration is available, flight time is estimated from great-circle Haversine distance at 800 km/h plus 30 minutes and labeled “Becsült repülési idő”. Offset-bearing ISO timestamps are calculated as elapsed instants, not local clock subtraction.

Airport metadata is loaded from the airlines' endpoint responses and merged with a small bundled fallback catalogue. Wizz's map does not provide IANA zones, so Open-Meteo's `timezone=auto` is used for those coordinates.

**Unofficial API notice:** these are the airline websites' undocumented endpoints, not supported public developer APIs. They may change or stop working. Ryanair's [Terms of Use](https://www.ryanair.com/us/en/lp/legal/terms-of-use) restrict automated extraction, especially for commercial use; obtain written permission before using this for a commercial service. Use this experiment for personal, non-commercial searches only. The Worker does not evade bot protection or call gated endpoints.

## Cloudflare Worker

The Worker has no runtime dependency and exposes only `GET /api/destinations` plus CORS preflight. It validates IATA codes, month, year, and airline codes; it does not accept arbitrary upstream URLs. Flight results are cached in browser localStorage for 14 days; airline airport/network reference data is cached at the Worker for 30 days. “Adatok frissítése” bypasses both caches. Climate data remains cached locally for 30 days.

```sh
npx wrangler login
npx wrangler deploy --config worker/wrangler.jsonc
```

Before deploying, replace `YOUR_GITHUB_USERNAME` in `worker/wrangler.jsonc` with the production Pages origin. The Wizz API version is pinned in `WIZZ_API_BASE_URL`; update it if the airline changes its website API version. The deployed Worker origin is in the `travel-agent-api` meta tag in `index.html`. No airline API secret is used. `.env`, `.dev.vars`, and build output are ignored.

The Worker is deployed to `https://travel-agent-api.satanadam.workers.dev`. Replace the placeholder Pages origin in `worker/wrangler.jsonc` with the actual production origin and redeploy before using it from GitHub Pages.

## GitHub Pages

The Actions workflow in `.github/workflows/pages.yml` installs from the lockfile, runs tests and both frontend/Worker typechecks, builds `dist/`, then deploys that directory to Pages. It uses relative asset paths, so the static app works under a repository project path. Enable GitHub Pages with **GitHub Actions** as the build source in repository settings.

## Security, cache, and limitations

- Production runtime dependencies: **0**. TypeScript and `@types/node` are development dependencies.
- The Worker calls only fixed Ryanair and Wizz Air hosts and never accepts arbitrary upstream URLs.
- Flight localStorage TTL: 14 days. Worker airport/network cache: 30 days. Climate localStorage TTL: 30 days. Refresh bypasses caches.
- The Worker CORS allowlist is configured in `worker/wrangler.jsonc`; localhost preview origins are allowed for development.
- Airline website endpoints are undocumented and may change or block requests. The current implementation is best-effort and intended for personal, non-commercial use.
- Climate values summarize 2015–2025 and can differ from future conditions.
- No airline or climate provider API key is embedded in the frontend.