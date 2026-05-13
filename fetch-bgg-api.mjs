#!/usr/bin/env node
// Fetch game data from the BGG XML API2 and write public/games.json.
// Usage: node fetch-bgg-api.mjs <geeklist-id>
//
// No external dependencies — uses Node 20+ built-in fetch and a minimal
// XML helper tuned to BGG's response shapes.

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'public', 'games.json');

const GEEKLIST_ID = process.argv[2];
if (!GEEKLIST_ID) {
  console.error('Usage: node fetch-bgg-api.mjs <geeklist-id>');
  process.exit(1);
}

// BGG API bearer token — read from BGG_API_TOKEN env var or .env.local
const BGG_API_TOKEN = process.env.BGG_API_TOKEN;
if (!BGG_API_TOKEN) {
  console.error('Set BGG_API_TOKEN in your environment or .env.local');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal XML helpers (not a general parser — just enough for BGG responses)
// ---------------------------------------------------------------------------

/** Extract the value of an attribute from a tag string. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** Return all matches of a regex as an array. */
function matchAll(text, re) {
  const out = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(text)) !== null) out.push(m);
  return out;
}

/** Get text content between open/close tags for a simple element. */
function textContent(xml, tagName) {
  const m = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return m ? m[1].trim() : null;
}

/** Get value="" attribute from a self-closing element like <minplayers value="2"/>. */
function valAttr(xml, tagName) {
  const m = xml.match(new RegExp(`<${tagName}\\s[^>]*value="([^"]*)"`));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// BGG API helpers
// ---------------------------------------------------------------------------

const BGG = 'https://boardgamegeek.com/xmlapi2';
const BATCH_SIZE = 20;           // IDs per /thing request
const RETRY_DELAY_MS = 5000;     // wait when BGG returns 202 (queued)
const MAX_RETRIES = 10;
const REQUEST_GAP_MS = 1200;     // polite gap between requests

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bggFetch(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${BGG_API_TOKEN}` },
    });
    if (res.status === 200) return await res.text();
    if (res.status === 202) {
      // BGG is queuing the request — wait and retry
      console.log(`  ⏳ BGG queued request, retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (res.status === 429) {
      console.log('  ⏳ Rate-limited, backing off 10s…');
      await sleep(10000);
      continue;
    }
    throw new Error(`BGG returned ${res.status} for ${url}`);
  }
  throw new Error(`Gave up after ${MAX_RETRIES} retries for ${url}`);
}

// ---------------------------------------------------------------------------
// Step 1: Fetch geeklist → extract game (thing) IDs
// ---------------------------------------------------------------------------

console.log(`Fetching geeklist ${GEEKLIST_ID}…`);
const geeklistXml = await bggFetch(`${BGG}/geeklist/${GEEKLIST_ID}`);

const itemTags = matchAll(geeklistXml, /<item\s[^>]*objecttype="thing"[^>]*>/g);
const gameIds = [...new Set(
  itemTags.map(m => attr(m[0], 'objectid')).filter(Boolean)
)];

if (gameIds.length === 0) {
  console.error('No game items found in geeklist.');
  process.exit(1);
}
console.log(`Found ${gameIds.length} unique games in geeklist.`);

// ---------------------------------------------------------------------------
// Step 2: Batch-fetch thing details with stats
// ---------------------------------------------------------------------------

const PMAX_CAP = 20;

// Sub-rank name mapping (BGG internal name → our short key)
const SUB_RANK_MAP = {
  'abstracts':          'abstracts',
  'cgs':                'cgs',
  'childrensgames':     'childrens',
  'familygames':        'family',
  'partygames':         'party',
  'strategygames':      'strategy',
  'thematic':           'thematic',
  'wargames':           'wargames',
};

function parseGame(itemXml) {
  const id = parseInt(attr(itemXml, 'id'), 10);

  // Primary name
  const nameMatch = itemXml.match(/<name\s[^>]*type="primary"[^>]*value="([^"]*)"/);
  const name = nameMatch ? decodeEntities(nameMatch[1]) : 'Unknown';

  // Basic numeric fields
  const minPlayers = parseInt(valAttr(itemXml, 'minplayers') || '0', 10);
  const rawMaxPlayers = parseInt(valAttr(itemXml, 'maxplayers') || '0', 10);
  const maxPlayers = Math.min(rawMaxPlayers, PMAX_CAP);
  const minTime = parseInt(valAttr(itemXml, 'minplaytime') || '0', 10);
  const maxTime = parseInt(valAttr(itemXml, 'maxplaytime') || valAttr(itemXml, 'playingtime') || '0', 10) || minTime;
  const yearPublished = parseInt(valAttr(itemXml, 'yearpublished') || '0', 10);
  const minAge = parseInt(valAttr(itemXml, 'minage') || '0', 10);

  // Description, thumbnail, image
  const description = decodeEntities(textContent(itemXml, 'description') || '');
  const thumbnail = textContent(itemXml, 'thumbnail') || null;
  const image = textContent(itemXml, 'image') || null;

  // Player-count poll
  const { best, rec } = parsePlayerPoll(itemXml);

  // Statistics
  const statsBlock = itemXml.match(/<statistics[\s\S]*?<\/statistics>/)?.[0] || '';
  const avgRating = round2(parseFloat(valAttr(statsBlock, 'average') || '0'));
  const geekRating = round2(parseFloat(valAttr(statsBlock, 'bayesaverage') || '0'));
  const weight = round2(parseFloat(valAttr(statsBlock, 'averageweight') || '0'));
  const votes = parseInt(valAttr(statsBlock, 'usersrated') || '0', 10);

  // Ranks
  const bggRank = parseBggRank(statsBlock);
  const subRanks = parseSubRanks(statsBlock);

  // Links (categories, mechanics, families, designers)
  const mechanics = parseLinks(itemXml, 'boardgamemechanic');
  const categories = parseLinks(itemXml, 'boardgamecategory');
  const families = parseLinks(itemXml, 'boardgamefamily');
  const designers = parseLinks(itemXml, 'boardgamedesigner');

  return {
    id, name,
    minPlayers, maxPlayers,
    bestPlayers: best, recommendedPlayers: rec,
    weight, minTime, maxTime,
    avgRating, geekRating, votes,
    bggRank, subRanks,
    mechanics, categories, families, designers,
    description, thumbnail, image,
    yearPublished, minAge,
  };
}

function parsePlayerPoll(xml) {
  const pollMatch = xml.match(/<poll\s[^>]*name="suggested_numplayers"[\s\S]*?<\/poll>/);
  if (!pollMatch) return { best: [], rec: [] };
  const pollXml = pollMatch[0];

  const best = [];
  const rec = [];

  const resultsBlocks = matchAll(pollXml, /<results\s[^>]*numplayers="(\d+)"[^>]*>([\s\S]*?)<\/results>/g);
  for (const m of resultsBlocks) {
    const n = parseInt(m[1], 10);
    if (n > PMAX_CAP) continue;

    const inner = m[2];
    const vBest = parseInt((inner.match(/value="Best"\s+numvotes="(\d+)"/) || [])[1] || '0', 10);
    const vRec = parseInt((inner.match(/value="Recommended"\s+numvotes="(\d+)"/) || [])[1] || '0', 10);
    const vNot = parseInt((inner.match(/value="Not Recommended"\s+numvotes="(\d+)"/) || [])[1] || '0', 10);

    // Winner is whichever category got the most votes
    const max = Math.max(vBest, vRec, vNot);
    if (max === 0) continue;
    if (vBest === max) {
      best.push(n);
      rec.push(n);
    } else if (vRec === max) {
      rec.push(n);
    }
    // "Not Recommended" wins → neither array
  }

  return { best, rec };
}

function parseBggRank(statsXml) {
  const m = statsXml.match(/<rank[^>]*type="subtype"[^>]*name="boardgame"[^>]*value="(\d+)"/);
  return m ? parseInt(m[1], 10) : null;
}

function parseSubRanks(statsXml) {
  const out = { abstracts: null, cgs: null, childrens: null, family: null, party: null, strategy: null, thematic: null, wargames: null };
  const ranks = matchAll(statsXml, /<rank[^>]*type="family"[^>]*name="([^"]*)"[^>]*value="([^"]*)"/g);
  for (const m of ranks) {
    const key = SUB_RANK_MAP[m[1]];
    if (key && m[2] !== 'Not Ranked') {
      out[key] = parseInt(m[2], 10);
    }
  }
  return out;
}

function parseLinks(xml, type) {
  const re = new RegExp(`<link\\s+type="${type}"[^>]*value="([^"]*)"`, 'g');
  return matchAll(xml, re).map(m => decodeEntities(m[1]));
}

function round2(n) { return Math.round(n * 100) / 100; }

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Fetch in batches
const games = [];
const batches = [];
for (let i = 0; i < gameIds.length; i += BATCH_SIZE) {
  batches.push(gameIds.slice(i, i + BATCH_SIZE));
}

for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  const ids = batch.join(',');
  console.log(`Fetching batch ${bi + 1}/${batches.length} (${batch.length} games)…`);

  const xml = await bggFetch(`${BGG}/thing?id=${ids}&stats=1`);

  // Split into individual <item>…</item> blocks
  const items = matchAll(xml, /<item\s[^>]*type="boardgame(?:expansion)?"[^>]*>[\s\S]*?<\/item>/g);
  for (const m of items) {
    try {
      games.push(parseGame(m[0]));
    } catch (err) {
      const failId = attr(m[0], 'id');
      console.error(`  ⚠ Failed to parse game ${failId}: ${err.message}`);
    }
  }

  if (bi < batches.length - 1) await sleep(REQUEST_GAP_MS);
}

// Sort by name for stable output
games.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(OUT, JSON.stringify(games));
console.log(`\nWrote ${games.length} games to ${OUT}`);
