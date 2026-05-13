# Geekway 2026 Prime PnW — sortable game list

Static site that displays the BoardGameGeek geeklist for Geekway 2026 Prime's Play & Win shelves as a sortable, filterable table. Deploys to Azure Static Web Apps.

## Architecture

No build step. `public/` is the deploy artifact.
`public/index.html` is markup only; `public/app.js` does the fetch / render / sort / filter / state-persistence work; `public/styles.css` carries every visual rule. Everything is vanilla HTML/CSS/JS — no frameworks, no bundler.

## Files

- `public/index.html` — page markup
- `public/app.js` — all behavior (state, filtering, sorting, render, URL/localStorage persistence, theme & view toggles, mobile card expansion, keyboard shortcuts)
- `public/styles.css` — all styles, light/dark via `prefers-color-scheme` plus a manual override
- `public/games.json` — game data (regenerated via `npm run refresh`)
- `public/staticwebapp.config.json` — Azure SWA routing/headers (lives at the SWA app root, which is `public/`)
- `fetch-bgg-api.mjs` — fetches game data from the BGG XML API2 and writes `public/games.json`
- `.github/workflows/azure-static-web-apps.yml` — auto-deploy on push to `main` (CI path)
- `.env.local.example` — template for the SWA CLI deployment token and BGG API token

## Commands

```bash
npm install                     # one time, installs serve + swa-cli
npm run dev                     # serve public/ on http://localhost:3000
npm run refresh -- <geeklist-id> # rebuild games.json from BGG XML API2 (needs BGG_API_TOKEN in .env.local)
npm run deploy                  # one-shot SWA CLI deploy (sources .env.local)
```

## State the UI persists

- Filters + sort state → URL query params and `localStorage['gpw.state']`. URL wins on load; localStorage is the fallback. Anything matching `DEFAULTS` is omitted from the URL.
- Per-game `wishlist` / `played` tags → `localStorage['gpw.tags']` keyed by game id.
- Theme override (light / dark / system) → `localStorage['gpw.theme']`.
- Desktop-mode override on phones → `localStorage['gpw.view']` (swaps the viewport `<meta>` to `width=1280`).

## Data shape

Each entry in `games.json` uses verbose field names so the file is self-describing for outside consumers:

```json
{
  "id": 418059,
  "name": "SETI: Search for Extraterrestrial Intelligence",
  "players": "1-4",
  "minPlayers": 1,
  "maxPlayers": 4,
  "bestPlayers": [3],
  "recommendedPlayers": [3],
  "weight": 3.83,
  "time": "40-160",
  "minTime": 40,
  "maxTime": 160,
  "avgRating": 8.42,
  "geekRating": 8.03,
  "votes": 19245
}
```

`players` and `time` are display strings (e.g. `"1-4"`, `"40-160"`); the `min*`/`max*` numeric fields are what the UI sorts by. `bestPlayers` and `recommendedPlayers` come from the BGG community poll, treated hierarchically: a player count where the winning vote was "Best" goes into both arrays; a count where the winning vote was "Recommended" goes only into `recommendedPlayers`. So **`bestPlayers` is always a subset of `recommendedPlayers`**. Player counts above 20 are capped to 20 (`PMAX_CAP` in the parser); poll lists with more than 6 entries render as `any` in the UI. `geekRating` is `0` when BGG has not yet issued a Bayesian rating (too few votes); the UI renders that as `—` and skips those games in the Hybrid column.

The runtime adds a derived `hybridRating = (avgRating + geekRating) / 2` after fetch (when `geekRating > 0`).

## BGG XML API2 refresh

`fetch-bgg-api.mjs` fetches game data directly from the BGG XML API2. It requires a `BGG_API_TOKEN` bearer token in `.env.local` (or the environment). Usage:

```bash
npm run refresh -- 358871
```

The script fetches the geeklist to get game IDs, then batch-fetches `/xmlapi2/thing?id=...&stats=1` (20 per request) with polite rate-limiting. It handles BGG 202 (queued) and 429 (rate-limited) responses with automatic retries.

## Conventions

- Keep dependencies near zero. The whole point is a single-page site that loads instantly.
- Don't introduce a bundler or framework without a strong reason.
- `SORT_KEYS` map keys in `app.js` are intentionally short (e.g. `pmn`, `tmn`, `ob`) because they appear in the URL (`?sort=...`). The *values* they map to use the verbose JSON field names. Changing a key breaks shared/bookmarked URLs.
- `.env.local` is gitignored. The deployment token and BGG API token live there. Never commit it.

## Deploy

Two paths, both work:

- **GitHub Actions (CI)** — workflow lives at `.github/workflows/azure-static-web-apps.yml`. Set `AZURE_STATIC_WEB_APPS_API_TOKEN` as a repo secret in GitHub. Pushing to `main` triggers a deploy.
- **Manual SWA CLI** — put the deployment token in `.env.local` (copy `.env.local.example` first), then `npm run deploy`. Useful for ad-hoc pushes without going through CI.
