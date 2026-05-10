/**
 * enrich-from-bgg.js
 *
 * Fetches enriched data from the BGG geekitems API for each game in the deployed
 * games.json and outputs an enriched dataset that adds:
 *   - mechanics        (array of strings)
 *   - categories       (array of strings, e.g. "Card Game", "Fantasy")
 *   - families         (array of strings)
 *   - designers        (array of strings)
 *   - description      (string)
 *   - thumbnail        (URL string)
 *   - image            (URL string)
 *   - yearPublished    (number)
 *   - minAge           (number)
 *
 * Usage:
 *   node scripts/enrich-from-bgg.js
 *   node scripts/enrich-from-bgg.js --merge-only   (skip fetching, just merge cached data)
 *
 * Each game is fetched one at a time with a randomized 30–120 second delay to
 * avoid taxing BGG's servers. Progress is cached in scripts/.bgg-cache/ so the
 * script can be safely interrupted and resumed — already-fetched games are skipped.
 *
 * Output: src/assets/data/games-enriched.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const DEPLOYED_GAMES_URL = 'https://p2w.bleemus.dev/games.json';
const LOCAL_GAMES_PATH   = path.join(__dirname, '../src/assets/data/games.json');
const RANKS_CSV_PATH     = path.join(__dirname, '../src/assets/data/boardgames_ranks.csv');
const OUT_PATH           = path.join(__dirname, '../src/assets/data/games-enriched.json');
const CACHE_DIR          = path.join(__dirname, '.bgg-cache');

const BGG_API      = 'https://api.geekdo.com/api/geekitems';
const MIN_DELAY_MS = 30 * 1000;   // 30 seconds
const MAX_DELAY_MS = 120 * 1000;  // 2 minutes

const MERGE_ONLY = process.argv.includes('--merge-only');

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function loadRanksCSV() {
  if (!fs.existsSync(RANKS_CSV_PATH)) return {};
  const lines = fs.readFileSync(RANKS_CSV_PATH, 'utf8').split('\n');
  const headers = parseCSVLine(lines[0]);
  const lookup = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, j) => { obj[h.trim()] = (row[j] || '').trim(); });
    const id = parseInt(obj.id, 10);
    if (id) lookup[id] = obj;
  }
  return lookup;
}

function parseRank(s) {
  const n = parseInt(s, 10);
  return (Number.isNaN(n) || n === 0) ? null : n;
}

function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function get(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://boardgamegeek.com/',
      'Accept': 'application/json',
    };
    https.get(url, { headers }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function getCachePath(id) {
  return path.join(CACHE_DIR, `${id}.json`);
}

function loadFromCache(id) {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveToCache(id, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(getCachePath(id), JSON.stringify(data));
}

function parseGeekItem(item) {
  const links = item.links || {};
  const extract = key => (links[key] || []).map(l => l.name).filter(Boolean);

  return {
    mechanics:    extract('boardgamemechanic'),
    categories:   extract('boardgamecategory'),
    families:     extract('boardgamefamily'),
    designers:    extract('boardgamedesigner'),
    description:  (item.short_description || '').trim(),
    thumbnail:    item.images?.thumb || null,
    image:        item.images?.medium || null,
    yearPublished: item.yearpublished ? parseInt(item.yearpublished, 10) : null,
    minAge:       item.minage ? parseInt(item.minage, 10) : null,
  };
}

async function fetchGame(id) {
  const cached = loadFromCache(id);
  if (cached) return cached;

  const url = `${BGG_API}?objecttype=thing&subtype=boardgame&objectid=${id}&nosession=1`;
  const body = await get(url);
  const json = JSON.parse(body);
  const data = parseGeekItem(json.item || {});
  saveToCache(id, data);
  return data;
}

async function main() {
  // 1. Load deployed games.json for BGG IDs + existing stats
  console.log('Fetching deployed games.json from p2w.bleemus.dev...');
  const deployedJson = await get(DEPLOYED_GAMES_URL);
  const deployedGames = JSON.parse(deployedJson);
  console.log(`  ${deployedGames.length} games with BGG IDs`);

  // 2. Load local games.json (mechanics + descriptions as fallback)
  const localGames = JSON.parse(fs.readFileSync(LOCAL_GAMES_PATH, 'utf8'));
  const localByTitle = {};
  for (const g of localGames) {
    localByTitle[g.title.toLowerCase().trim()] = g;
  }
  console.log(`  ${localGames.length} local games with mechanics/descriptions (fallback)`);

  // 3. Fetch from BGG one at a time, skipping cached
  if (!MERGE_ONLY) {
    const ids = deployedGames.map(g => g.id);
    const cached = ids.filter(id => loadFromCache(id) !== null);
    const todo = ids.filter(id => loadFromCache(id) === null);

    console.log(`\nCache: ${cached.length}/${ids.length} already fetched, ${todo.length} remaining`);

    if (todo.length > 0) {
      const estMin = Math.round(todo.length * MIN_DELAY_MS / 60000);
      const estMax = Math.round(todo.length * MAX_DELAY_MS / 60000);
      console.log(`Estimated time remaining: ${estMin}–${estMax} minutes\n`);

      for (let i = 0; i < todo.length; i++) {
        const id = todo[i];
        const game = deployedGames.find(g => g.id === id);
        process.stdout.write(`  [${i + 1}/${todo.length}] ${game?.name || id}... `);
        try {
          await fetchGame(id);
          console.log('✓');
        } catch (err) {
          console.log(`✗ ${err.message}`);
        }

        if (i < todo.length - 1) {
          const delay = randomDelay();
          const mins = Math.floor(delay / 60000);
          const secs = Math.floor((delay % 60000) / 1000);
          console.log(`    (waiting ${mins}m ${secs}s before next request...)`);
          await sleep(delay);
        }
      }
    }
  } else {
    console.log('\n--merge-only: skipping fetch, using cached data only');
  }

  // 4. Load BGG ranks from CSV dump
  const ranksById = loadRanksCSV();
  const ranksFound = Object.keys(ranksById).length;
  console.log(`  ${ranksFound} games in ranks CSV`);

  // 5. Merge everything together
  console.log('\nMerging datasets...');
  const enriched = deployedGames.map(game => {
    const bgg   = loadFromCache(game.id) || {};
    const local = localByTitle[game.name.toLowerCase().trim()] || {};
    const csv   = ranksById[game.id] || {};

    const mechanics   = bgg.mechanics?.length ? bgg.mechanics : (local.mechanics || []);
    const description = bgg.description?.length > 20 ? bgg.description : (local.description || '');

    return {
      id:                  game.id,
      name:                game.name,
      minPlayers:          game.minPlayers,
      maxPlayers:          game.maxPlayers,
      bestPlayers:         game.bestPlayers || [],
      recommendedPlayers:  game.recommendedPlayers || [],
      weight:              game.weight,
      minTime:             game.minTime,
      maxTime:             game.maxTime,
      avgRating:           game.avgRating,
      geekRating:          game.geekRating,
      votes:               game.votes,
      bggRank:             parseRank(csv.rank),
      subRanks: {
        abstracts:     parseRank(csv.abstracts_rank),
        cgs:           parseRank(csv.cgs_rank),
        childrens:     parseRank(csv.childrensgames_rank),
        family:        parseRank(csv.familygames_rank),
        party:         parseRank(csv.partygames_rank),
        strategy:      parseRank(csv.strategygames_rank),
        thematic:      parseRank(csv.thematic_rank),
        wargames:      parseRank(csv.wargames_rank),
      },
      mechanics,
      categories:          bgg.categories   || [],
      families:            bgg.families     || [],
      designers:           bgg.designers    || [],
      description,
      thumbnail:           bgg.thumbnail    || null,
      image:               bgg.image        || null,
      yearPublished:       bgg.yearPublished || null,
      minAge:              bgg.minAge       || null,
    };
  });

  // 6. Coverage report
  const pct = (n, t) => `${n}/${t} (${Math.round(n/t*100)}%)`;
  const w = key => enriched.filter(g => Array.isArray(g[key]) ? g[key].length > 0 : g[key]).length;
  console.log(`\nCoverage:`);
  console.log(`  mechanics:   ${pct(w('mechanics'),   enriched.length)}`);
  console.log(`  categories:  ${pct(w('categories'),  enriched.length)}`);
  console.log(`  description: ${pct(w('description'), enriched.length)}`);
  console.log(`  thumbnail:   ${pct(w('thumbnail'),   enriched.length)}`);
  const ranked = enriched.filter(g => g.bggRank != null).length;
  console.log(`  bggRank:     ${pct(ranked, enriched.length)}`);

  // 7. Write output files
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(enriched, null, 2));
  console.log(`\nWrote ${enriched.length} games → ${OUT_PATH}`);

  const allMechanics  = [...new Set(enriched.flatMap(g => g.mechanics))].sort();
  const allCategories = [...new Set(enriched.flatMap(g => g.categories))].sort();
  const mechPath = path.join(path.dirname(OUT_PATH), 'mechanics-enriched.json');
  const catPath  = path.join(path.dirname(OUT_PATH), 'categories.json');
  fs.writeFileSync(mechPath, JSON.stringify(allMechanics, null, 2));
  fs.writeFileSync(catPath,  JSON.stringify(allCategories, null, 2));
  console.log(`  ${allMechanics.length} unique mechanics  → mechanics-enriched.json`);
  console.log(`  ${allCategories.length} unique categories → categories.json`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
