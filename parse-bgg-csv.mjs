#!/usr/bin/env node
// Convert a BGG geeklist CSV export into public/games.json.
// Usage: node parse-bgg-csv.mjs <path-to-csv>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'public', 'games.json');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node parse-bgg-csv.mjs <path-to-csv>');
  process.exit(1);
}

// Minimal RFC-4180 CSV parser: handles quoted fields with embedded commas,
// quotes, and newlines. Returns an array of row arrays.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = readFileSync(resolve(csvPath), 'utf8');
const rows = parseCSV(raw);
if (rows.length < 2) {
  console.error('CSV has no data rows.');
  process.exit(1);
}

const header = rows[0];
const idx = name => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Missing column: ${name}`);
  return i;
};

const required = ['id', 'name', 'minplayers', 'maxplayers', 'minplaytime', 'maxplaytime',
                  'average', 'bayesaverage', 'averageweight', 'usersrated'];
required.forEach(idx);

const pollIdx = Array.from({ length: 20 }, (_, i) => header.indexOf(`${i + 1}player`));

// BGG sometimes records "any" games (e.g., roll-and-write) as 1-99 players.
// Cap at 20 so they don't dominate sorts or stretch the table.
const PMAX_CAP = 20;

function players(mn, mx) {
  if (mx > PMAX_CAP) return mn === mx ? `${PMAX_CAP}+` : `${mn}-${PMAX_CAP}+`;
  return mn === mx ? String(mn) : `${mn}-${mx}`;
}

function timeStr(mn, mx) {
  return mn === mx ? String(mn) : `${mn}-${mx}`;
}

// BGG's per-count poll picks one winner among Best / Recommended / Not Recommended.
// We treat the result hierarchically: a count is "recommended" if it won B *or* R
// (anything not "Not Recommended"); a count is "best" only if it won B. So
// `bestPlayers` is always a subset of `recommendedPlayers`.
function optimal(row) {
  const votes = pollIdx.map((i, k) => i >= 0 ? { n: k + 1, v: (row[i] || '').trim() } : null).filter(Boolean);
  const best = votes.filter(x => x.v === 'B' && x.n <= PMAX_CAP).map(x => x.n);
  const rec = votes.filter(x => (x.v === 'B' || x.v === 'R') && x.n <= PMAX_CAP).map(x => x.n);
  return { best, rec };
}

const games = rows.slice(1).filter(r => r.length > 1 && r[idx('id')]).map(r => {
  const minP = parseInt(r[idx('minplayers')], 10);
  const maxP = parseInt(r[idx('maxplayers')], 10);
  const minT = parseInt(r[idx('minplaytime')], 10) || 0;
  const maxT = parseInt(r[idx('maxplaytime')], 10) || minT; // BGG sometimes omits maxplaytime (0)
  const { best, rec } = optimal(r);
  return {
    id: parseInt(r[idx('id')], 10),
    name: r[idx('name')],
    players: players(minP, maxP),
    minPlayers: minP,
    maxPlayers: Math.min(maxP, PMAX_CAP),
    bestPlayers: best,
    recommendedPlayers: rec,
    weight: Math.round(parseFloat(r[idx('averageweight')]) * 100) / 100,
    time: timeStr(minT, maxT),
    minTime: minT,
    maxTime: maxT,
    avgRating: Math.round(parseFloat(r[idx('average')]) * 100) / 100,
    geekRating: Math.round(parseFloat(r[idx('bayesaverage')]) * 100) / 100,
    votes: parseInt(r[idx('usersrated')], 10),
  };
});

writeFileSync(OUT, JSON.stringify(games));
console.log(`Wrote ${games.length} games to ${OUT}`);
