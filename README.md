# Geekway 2026 Prime PnW

Sortable, filterable web table of the games on the Play & Win shelves at [Geekway Prime 2026](https://geekway.com/), pulled from [BGG geeklist 358871](https://boardgamegeek.com/geeklist/358871/geekway-2026-prime-pnw-lineup).

Single-page static site — no framework, no bundler, no build step. Deploys to Azure Static Web Apps.

## Features

- Sort and filter by player count, weight, playtime, rating, BGG rank, sub-category ranks (Strategy, Family, etc.), "best at N" optimal counts, mechanics, categories, and personal wishlist / played tags.
- Mechanics and categories use searchable multi-select dropdowns with OR / AND mode toggle.
- Filter state survives reload (localStorage) and is shareable via URL. Active filters shown as a badge; one-click reset.
- Mobile card layout: cover image + mini stats grid when collapsed; tap to expand full details (rec. players, mechanics, categories, rank breakdown).
- Cover-image tooltip on hover; sub-rank breakdown tooltip on BGG rank cell.
- Installable as a PWA — service worker (cache-first + background refresh), web app manifest, home-screen icons.
- Dark / light theme that follows your system or can be toggled manually.
- Random-pick button (`r`), `/` to focus search, `Esc` to clear.

## Quick start

```bash
npm install            # installs the `serve` dev server and the SWA CLI
npm run dev            # http://localhost:3000
```

## Refreshing the data

### 1. Base stats from BGG CSV

Export the geeklist as CSV from BGG (e.g. with [BGG1Tool](https://boardgamegeek.com/wiki/page/BGG1Tool)) and run:

```bash
npm run refresh -- /path/to/export.csv
```

This regenerates `public/games.json` with base stats (player counts, playtime, ratings, poll data).

### 2. Enriched data from the BGG API

```bash
node scripts/enrich-from-bgg.js             # fetch + merge (slow — rate-limited)
node scripts/enrich-from-bgg.js --merge-only  # skip fetching, rebuild from cache
```

This adds sub-category ranks, mechanics, categories, thumbnail URLs, designers, year, and age rating. API responses are cached in `scripts/.bgg-cache/` so the script can be interrupted and resumed. Also produces `public/mechanics.json` and `public/categories.json`.

Commit + push (CI deploy) or `npm run deploy` to update the live site.

## Deploying

### GitHub Actions (recommended)

A workflow file already lives at `.github/workflows/azure-static-web-apps.yml`. To activate it:

1. Create an Azure Static Web App in the Azure portal (if you haven't already) and grab the deployment token from "Manage deployment token".
2. In your GitHub repo: Settings → Secrets and variables → Actions → "New repository secret". Name it `AZURE_STATIC_WEB_APPS_API_TOKEN`, paste the token as the value.
3. Push to `main`. The Action runs and deploys.

### One-shot CLI deploy

Useful if you don't want to use CI/CD or want a quick push without committing.

1. Copy `.env.local.example` to `.env.local` and paste your deployment token after `SWA_CLI_DEPLOYMENT_TOKEN=`.
2. `npm run deploy` — the script sources `.env.local` and runs `swa deploy public --env production`.

`.env.local` is gitignored.

## Project layout

```
public/                                  what gets deployed
  index.html                             page markup
  app.js                                 fetch, sort, filter, render, state
  styles.css                             all styling
  games.json                             game data (base + enriched)
  mechanics.json                         mechanic id→name map
  categories.json                        category id→name map
  sw.js                                  service worker (cache-first + refresh)
  manifest.json                          PWA web app manifest
  icon.svg / icon-192.png / icon-512.png app icons
  staticwebapp.config.json               Azure SWA routing/headers
scripts/
  enrich-from-bgg.js                     BGG API enrichment (ranks, mechanics, etc.)
  .bgg-cache/                            per-game API response cache (gitignored)
parse-bgg-csv.mjs                        BGG CSV → games.json (base stats)
.github/workflows/
  azure-static-web-apps.yml              CI deploy on push to main
.env.local.example                       template for the SWA CLI token
CLAUDE.md                                project context for Claude Code
```

## Data shape

`public/games.json` is a JSON array. Each entry uses verbose, self-documenting field names so the file is reusable outside this site:

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
  "votes": 19245,
  "bggRank": 14,
  "subRanks": { "strategy": 7, "thematic": null },
  "mechanics": [2023, 2664],
  "categories": [1021],
  "thumbnail": "https://cf.geekdo-images.com/...",
  "yearPublished": 2023,
  "designers": ["David Turczi"]
}
```

`bestPlayers` is always a subset of `recommendedPlayers` — a count is "best" only if the BGG community-poll winner for that count was "Best", and a count is "recommended" if the winner was either "Best" or "Recommended". `geekRating` is `0` for games BGG hasn't issued a Bayesian rating for yet. The enriched fields (`bggRank`, `subRanks`, `mechanics`, etc.) are added by `scripts/enrich-from-bgg.js` and absent if the enrichment script hasn't been run.

## License

Game data is from BoardGameGeek and remains theirs. Site code: see [LICENSE](LICENSE).
