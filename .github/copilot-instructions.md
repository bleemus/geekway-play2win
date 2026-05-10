# Copilot Instructions — Geekway Play & Win Index

## Commands

```bash
npm run dev                     # serve public/ on http://localhost:3000
npm run refresh -- <csv-path>   # rebuild games.json from a BGG CSV export
npm run deploy                  # manual SWA CLI deploy (requires .env.local)
node scripts/enrich-from-bgg.js             # fetch enriched BGG data (slow — rate-limited 30–120s per game)
node scripts/enrich-from-bgg.js --merge-only  # skip fetching, just merge from cache in scripts/.bgg-cache/
```

No build step. `public/` is the deploy artifact as-is.

## Architecture

No framework, no bundler. Three files own everything:

- **`public/index.html`** — static markup only; no logic
- **`public/app.js`** — all behavior: fetch, render, filter, sort, state persistence, theme, keyboard shortcuts, service worker registration
- **`public/styles.css`** — all styles; light/dark via `prefers-color-scheme` + manual `data-theme` override on `<html>`

### Data pipeline

```
BGG CSV export
  └─ parse-bgg-csv.mjs  →  public/games.json          (base stats)
  └─ scripts/enrich-from-bgg.js  →  public/games.json  (adds mechanics, categories, ranks, thumbnail, etc.)
```

`public/mechanics.json` and `public/categories.json` are also produced by the enrich script and loaded in parallel at runtime alongside `games.json`.

The service worker (`public/sw.js`) pre-caches all local assets and uses a cache-first + background-refresh strategy for HTML/JS/CSS. Bump `CACHE_VERSION` in `sw.js` whenever cached assets must be invalidated.

### Runtime data flow

On page load, `app.js`:
1. Runs `hydrateState()` — URL params win over `localStorage['gpw.state']`
2. Fetches `games.json`, `mechanics.json`, `categories.json` in parallel
3. Derives `hybridRating = (avgRating + geekRating) / 2` (only when `geekRating > 0`)
4. Calls `render()` — filters via `matches()`, sorts via `SORT_KEYS`, builds innerHTML

All state mutations go through `update(partial)`, which merges into `state`, calls `persistState()` (URL + localStorage), then `render()`.

## Key Conventions

### URL-stable sort keys
`SORT_KEYS` in `app.js` maps **short keys** (e.g. `pmn`, `tmn`, `ob`) to sort functions. These short keys appear in the URL (`?sort=pmn`). **Never rename a key** — it breaks bookmarked/shared URLs. The verbose JSON field names are used in the sort functions themselves.

### State shape
`DEFAULTS` in `app.js` is the canonical state shape. Anything matching `DEFAULTS` is omitted from the URL. Add new filter/sort state to `DEFAULTS` first, then to `serializeState` / `parseState`.

### `bestPlayers` is a subset of `recommendedPlayers`
Poll counts where the community voted "Best" land in **both** arrays. Counts voted "Recommended" land only in `recommendedPlayers`. This hierarchy is enforced in `parse-bgg-csv.mjs` and must be preserved in any data transformation.

### Player count cap
`PMAX_CAP = 20` in the parser caps `maxPlayers` and poll arrays. Poll lists with > 6 entries render as `any` in the UI.

### `geekRating === 0` means unrated
BGG returns `0` (not `null`) when a game has too few votes for a Bayesian rating. The UI renders it as `—` and excludes those games from the Hybrid sort. Never treat `0` as a valid rating.

### localStorage keys
| Key | Contents |
|---|---|
| `gpw.state` | Serialized URL params (filters + sort) |
| `gpw.tags` | `{ [gameId]: { want?: true, played?: true } }` |
| `gpw.theme` | `"light"` \| `"dark"` (absent = system) |
| `gpw.view` | Desktop-mode override on phones |

### Sub-rank columns
`SUB_RANK_LABELS` defines the 8 BGG sub-categories (abstracts, cgs, childrens, family, party, strategy, thematic, wargames). Sort keys for these use the `sr_` prefix (e.g. `sr_strategy`). `extraRankCols` in state tracks which sub-rank columns the user has pinned; serialized as `?xrank=strategy|family`.

### Enrichment script behavior
`scripts/enrich-from-bgg.js` caches each BGG API response to `scripts/.bgg-cache/<id>.json`. It can be safely interrupted and resumed. The `--merge-only` flag skips all network requests and rebuilds the output from cache + the ranks CSV alone.

### No secrets in source
`.env.local` holds the SWA deployment token and is gitignored. Never commit it. Use `.env.local.example` as the template.
