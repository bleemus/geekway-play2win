// ─── Service worker registration ─────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ─── Sort keys ───────────────────────────────────────────────────────────────

const SORT_KEYS = {
  n:    r => r.name.toLowerCase(),
  tags: r => { const t = TAGS[r.id] || {}; return (t.want ? 2 : 0) + (t.played ? 1 : 0); },
  pmn:  r => r.minPlayers,
  pmx:  r => r.maxPlayers,
  ob:   r => r.bestPlayers && r.bestPlayers.length ? r.bestPlayers[0] : 99,
  or:   r => r.recommendedPlayers && r.recommendedPlayers.length ? Math.min(...r.recommendedPlayers) : 99,
  w:    r => r.weight,
  tmn:  r => r.minTime ?? 999,
  tmx:  r => r.maxTime ?? 999,
  a:    r => r.avgRating,
  g:    r => r.geekRating,
  v:    r => r.votes,
  rank: r => r.bggRank ?? 9999,
};

function getSortFn(key) {
  if (SORT_KEYS[key]) return SORT_KEYS[key];
  if (key.startsWith('sr_')) {
    const k = key.slice(3);
    return r => r.subRanks?.[k] ?? 9999;
  }
  return () => 0;
}

// ─── State ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  q: '',
  hideUnranked: false,
  players: null,
  weight: null,
  timeMax: null,
  minRating: null,
  ratingField: 'a',
  bestOnly: false,
  tags: { played: false, want: false },
  mechanics: [],
  mechanicsMode: 'OR',
  categories: [],
  categoriesMode: 'OR',
  sortKey: 'a',
  sortDir: -1,
  extraRankCols: [],  // array of sub-rank keys e.g. ['strategy','family']
};

let DATA = [];
let MECHANICS  = [];
let CATEGORIES = [];
const state = JSON.parse(JSON.stringify(DEFAULTS));
let TAGS = {};
const EXPANDED = new Set();
let ratingExpanded = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const tbody        = document.getElementById('tbody');
const gamesTable   = document.getElementById('gamesTable');
const countEl      = document.getElementById('count');
const search       = document.getElementById('search');
const hideCheck    = document.getElementById('hideUnranked');
const bestCheck    = document.getElementById('bestOnly');
const ratingFieldSel = document.getElementById('ratingField');
const sortDdBtn    = document.getElementById('sortDdBtn');
const sortDdMenu   = document.getElementById('sortDdMenu');
const sortDdText   = document.getElementById('sortDdText');
const sortDirBtn   = document.getElementById('sortDirBtn');
const pickBtn      = document.getElementById('pickBtn');
const themeBtn     = document.getElementById('themeBtn');
const updatedEl    = document.getElementById('updated');

// multi-select elements
const mechanicSelect   = document.getElementById('mechanicSelect');
const mechanicInput    = document.getElementById('mechanicInput');
const mechanicDropdown = document.getElementById('mechanicDropdown');
const mechanicModeBtn  = document.getElementById('mechanicMode');

const categorySelect   = document.getElementById('categorySelect');
const categoryInput    = document.getElementById('categoryInput');
const categoryDropdown = document.getElementById('categoryDropdown');
const categoryModeBtn  = document.getElementById('categoryMode');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function fmt(n, dec) {
  if (n === 0 || n == null) return '<span class="dim">—</span>';
  return n.toFixed(dec);
}

const SUB_RANK_LABELS = {
  abstracts: 'Abstract',
  cgs:       'Card Game',
  childrens: "Children's",
  family:    'Family',
  party:     'Party',
  strategy:  'Strategy',
  thematic:  'Thematic',
  wargames:  'Wargame',
};

function imgTooltip(r) {
  if (!r.thumbnail) return '';
  return `<div class="hover-tooltip img-tooltip"><img src="${r.thumbnail}" alt="${escapeHtml(r.name)}" width="200" loading="lazy">${r.yearPublished ? `<span class="tt-year">${r.yearPublished}</span>` : ''}</div>`;
}

function rankTooltip(r) {
  const rows = Object.entries(SUB_RANK_LABELS)
    .filter(([k]) => r.subRanks?.[k] != null)
    .map(([k, label]) => `<div class="rt-row"><span class="rt-label">${label}</span><span class="rt-val">#${r.subRanks[k]}</span></div>`)
    .join('');
  if (!rows) return '';
  const overall = `<div class="rt-row rt-overall"><span class="rt-label">Overall</span><span class="rt-val">#${r.bggRank}</span></div>`;
  return `<div class="hover-tooltip rank-tooltip">${overall}<div class="rt-divider"></div>${rows}</div>`;
}

function formatPollList(arr) {
  if (!arr || arr.length === 0) return '<span class="dim">—</span>';
  if (arr.length > 6) return 'any';
  return arr.join(',');
}

/** "2–4" or "3" from a sorted array of player counts */
function playerRangeText(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  if (sorted.length > 6) return 'any';
  const min = sorted[0], max = sorted[sorted.length - 1];
  return min === max ? String(min) : `${min}–${max}`;
}

/** "2–4p" from minPlayers / maxPlayers */
function playerCountText(r) {
  if (r.minPlayers === r.maxPlayers) return String(r.minPlayers);
  return `${r.minPlayers}–${r.maxPlayers}`;
}

/** "30–60 min" or "60 min" from minTime / maxTime */
function timeRangeText(r) {
  if (r.minTime == null && r.maxTime == null) return null;
  if (r.minTime == null) return r.maxTime + ' min';
  if (r.maxTime == null || r.minTime === r.maxTime) return r.minTime + ' min';
  return `${r.minTime}–${r.maxTime} min`;
}

function listText(arr) {
  if (!arr || arr.length === 0) return '—';
  if (arr.length > 6) return 'any';
  return arr.join(',');
}

// ─── Filter logic ─────────────────────────────────────────────────────────────

function matches(r, s) {
  if (s.q && !r.name.toLowerCase().includes(s.q)) return false;
  if (s.hideUnranked && !(r.geekRating > 0)) return false;

  if (s.players != null) {
    const n = s.players;
    if (n === 6) { if (!(r.maxPlayers >= 6)) return false; }
    else { if (!(r.minPlayers <= n && n <= r.maxPlayers)) return false; }
    if (s.bestOnly) {
      if (!Array.isArray(r.bestPlayers) || r.bestPlayers.length === 0) return false;
      if (n === 6) { if (!r.bestPlayers.some(x => x >= 6)) return false; }
      else { if (!r.bestPlayers.includes(n)) return false; }
    }
  }

  if (s.weight === 'light' && !(r.weight > 0 && r.weight < 2)) return false;
  if (s.weight === 'med'   && !(r.weight >= 2 && r.weight <= 3)) return false;
  if (s.weight === 'heavy' && !(r.weight > 3)) return false;

  if (s.timeMax != null && !(r.minTime != null && r.minTime <= s.timeMax)) return false;

  if (s.minRating != null) {
    let rating;
    if (s.ratingField === 'a') rating = r.avgRating;
    else if (s.ratingField === 'g') rating = r.geekRating;
    else rating = r.avgRating;
    if (!(rating > 0 && rating >= s.minRating)) return false;
  }

  if (s.tags.played || s.tags.want || s.tags.unplayed) {
    const t = TAGS[r.id] || {};
    if (s.tags.played   && !t.played)  return false;
    if (s.tags.want     && !t.want)    return false;
    if (s.tags.unplayed &&  t.played)  return false;
  }

  // mechanics filter
  if (s.mechanics.length > 0) {
    const gameMechanics = r.mechanics || [];
    if (s.mechanicsMode === 'AND') {
      if (!s.mechanics.every(m => gameMechanics.includes(m))) return false;
    } else {
      if (!s.mechanics.some(m => gameMechanics.includes(m))) return false;
    }
  }

  // categories filter
  if (s.categories.length > 0) {
    const gameCategories = r.categories || [];
    if (s.categoriesMode === 'AND') {
      if (!s.categories.every(c => gameCategories.includes(c))) return false;
    } else {
      if (!s.categories.some(c => gameCategories.includes(c))) return false;
    }
  }

  return true;
}

// ─── Tags (shortlist) ─────────────────────────────────────────────────────────

const TAGS_KEY = 'gpw.tags';

function loadTags() {
  try { TAGS = JSON.parse(localStorage.getItem(TAGS_KEY) || '{}') || {}; }
  catch { TAGS = {}; }
}

function saveTags() {
  try { localStorage.setItem(TAGS_KEY, JSON.stringify(TAGS)); } catch {}
}

function setTag(id, tag, on) {
  const t = TAGS[id] || (TAGS[id] = {});
  if (on) t[tag] = true;
  else {
    delete t[tag];
    if (Object.keys(t).length === 0) delete TAGS[id];
  }
  saveTags();
}

// ─── URL / localStorage state ─────────────────────────────────────────────────

const STATE_KEY = 'gpw.state';

function serializeState(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.hideUnranked) p.set('unranked', '1');
  if (s.players != null) p.set('players', String(s.players));
  if (s.weight) p.set('weight', s.weight);
  if (s.timeMax != null) p.set('time', String(s.timeMax));
  if (s.minRating != null) p.set('rating', String(s.minRating));
  if (s.ratingField !== DEFAULTS.ratingField) p.set('ratingField', s.ratingField);
  if (s.bestOnly) p.set('best', '1');
  if (s.sortKey !== DEFAULTS.sortKey || s.sortDir !== DEFAULTS.sortDir) {
    p.set('sort', s.sortKey);
    p.set('dir', s.sortDir === 1 ? 'asc' : 'desc');
  }
  // new: mechanics & categories
  if (s.mechanics.length > 0) p.set('mechanics', s.mechanics.join('|'));
  if (s.mechanicsMode !== 'OR') p.set('mechanicsMode', s.mechanicsMode);
  if (s.categories.length > 0) p.set('categories', s.categories.join('|'));
  if (s.categoriesMode !== 'OR') p.set('categoriesMode', s.categoriesMode);
  if (s.extraRankCols.length > 0) p.set('xrank', s.extraRankCols.join('|'));
  return p;
}

function parseState(params) {
  const out = {};
  if (params.has('q')) out.q = params.get('q');
  if (params.has('unranked')) out.hideUnranked = true;
  if (params.has('players')) {
    const n = parseInt(params.get('players'), 10);
    if (n >= 1 && n <= 6) out.players = n;
  }
  const w = params.get('weight');
  if (w === 'light' || w === 'med' || w === 'heavy') out.weight = w;
  if (params.has('time')) {
    const t = parseInt(params.get('time'), 10);
    if ([30, 60, 90, 120].includes(t)) out.timeMax = t;
  }
  if (params.has('rating')) {
    const v = parseFloat(params.get('rating'));
    if ([6, 6.5, 7, 7.5, 8].includes(v)) out.minRating = v;
  }
  if (params.has('ratingField')) {
    const v = params.get('ratingField');
    if (v === 'a' || v === 'g') out.ratingField = v;
  }
  if (params.get('best') === '1') out.bestOnly = true;
  if (params.has('sort')) {
    const k = params.get('sort');
    if (SORT_KEYS[k] || k.startsWith('sr_')) {
      out.sortKey = k;
      const d = params.get('dir');
      out.sortDir = d === 'asc' ? 1 : (d === 'desc' ? -1 : pickSortDir(k));
    }
  }
  if (params.has('mechanics')) {
    const raw = params.get('mechanics').split('|').map(s => s.trim()).filter(Boolean);
    if (raw.length) out.mechanics = raw;
  }
  const mm = params.get('mechanicsMode');
  if (mm === 'AND' || mm === 'OR') out.mechanicsMode = mm;
  if (params.has('categories')) {
    const raw = params.get('categories').split('|').map(s => s.trim()).filter(Boolean);
    if (raw.length) out.categories = raw;
  }
  const cm = params.get('categoriesMode');
  if (cm === 'AND' || cm === 'OR') out.categoriesMode = cm;
  if (params.has('xrank')) {
    const valid = Object.keys(SUB_RANK_LABELS);
    const raw = params.get('xrank').split('|').filter(k => valid.includes(k));
    if (raw.length) out.extraRankCols = raw;
  }
  return out;
}

function persistState() {
  const qs = serializeState(state).toString();
  const url = qs ? '?' + qs : location.pathname;
  history.replaceState(null, '', url);
  try { localStorage.setItem(STATE_KEY, qs); } catch {}
}

function hydrateState() {
  const urlParams = new URLSearchParams(location.search);
  if ([...urlParams].length > 0) {
    Object.assign(state, parseState(urlParams));
    return;
  }
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) {
      Object.assign(state, parseState(new URLSearchParams(saved)));
      persistState();
    }
  } catch {}
}

function update(partial) {
  Object.assign(state, partial);
  persistState();
  render();
}

// ─── Render ───────────────────────────────────────────────────────────────────


function filteredRows() {
  const s = { ...state, q: state.q.toLowerCase() };
  const rows = DATA.filter(r => matches(r, s));
  const k = getSortFn(state.sortKey);
  const dir = state.sortDir;
  rows.sort((a, b) => {
    const av = k(a), bv = k(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
  return rows;
}

const SORT_FIELD = {
  pmn:  r => ['Players', playerCountText(r)],
  pmx:  r => ['Players', playerCountText(r)],
  ob:   r => ['Best', playerRangeText(r.bestPlayers) ?? '—'],
  or:   r => ['Rec', playerRangeText(r.recommendedPlayers) ?? '—'],
  w:    r => r.weight > 0 ? ['Weight', r.weight.toFixed(2)] : null,
  tmn:  r => timeRangeText(r) ? ['Time', timeRangeText(r)] : null,
  tmx:  r => timeRangeText(r) ? ['Time', timeRangeText(r)] : null,
  v:    r => ['Votes', r.votes.toLocaleString()],
  rank: r => r.bggRank != null ? ['BGG Rank', '#' + r.bggRank] : null,
  tags: r => {
    const t = TAGS[r.id] || {};
    const marks = (t.want ? '♥ ' : '') + (t.played ? '✓' : '');
    return ['Shortlist', marks.trim() || '—'];
  },
};

function sortFieldPart(r, sk) {
  const fn = SORT_FIELD[sk];
  if (!fn) return '';
  const result = fn(r);
  if (!result) return '';
  const [label, value] = result;
  return `<span class="rating-part sort-active"><span class="rating-label">${label}</span> ${escapeHtml(String(value))}</span>`;
}

function render() {
  const rows = filteredRows();
  const countText = rows.length === DATA.length
    ? rows.length + ' games'
    : rows.length + ' of ' + DATA.length;
  countEl.textContent = countText;

  tbody.innerHTML = rows.map(r => {
    const t = TAGS[r.id] || {};
    const tagBtns = '<span class="tag-btns">'
      + `<button type="button" class="tag-btn${t.want   ? ' active' : ''}" data-id="${r.id}" data-tag="want"   aria-label="Wishlist" title="Wishlist">${t.want   ? '♥' : '♡'}</button>`
      + `<button type="button" class="tag-btn${t.played ? ' active' : ''}" data-id="${r.id}" data-tag="played" aria-label="Played"   title="Played">✓</button>`
      + '</span>';
    const sk = state.sortKey;
    const cls = key => key === sk ? ' sort-active' : '';
    const ratingPart = (label, n, key) =>
      n > 0 ? `<span class="rating-part${cls(key)}"><span class="rating-label">${label}</span> ${n.toFixed(2)}</span>` : '';
    const sortPart = sortFieldPart(r, sk);
    const summary = `<span class="card-summary">${ratingPart('Avg', r.avgRating, 'a')}${ratingPart('Geek', r.geekRating, 'g')}${sortPart}</span>`;
    const playerRange = playerCountText(r);

    const best    = playerRangeText(r.bestPlayers) ?? '<span class="dim">—</span>';
    const rec     = playerRangeText(r.recommendedPlayers) ?? '<span class="dim">—</span>';
    const time    = timeRangeText(r) ?? '<span class="dim">—</span>';
    const hasSubranks = r.subRanks && Object.values(r.subRanks).some(v => v != null);
    const rankCell = r.bggRank != null
      ? `<span class="${r.bggRank <= 10 ? 'top-ten' : ''}${hasSubranks ? ' has-subranks' : ''}">#${r.bggRank}</span>`
      : '<span class="dim">—</span>';

    return '<tr data-id="' + r.id + '"' + (EXPANDED.has(r.id) ? ' class="expanded"' : '') + '>'
      + '<td class="name" data-label="Game"><span class="card-chevron" aria-hidden="true"></span><span class="card-players">' + playerRange + '</span><a href="https://boardgamegeek.com/boardgame/' + r.id + '" target="_blank" rel="noopener">' + escapeHtml(r.name) + '</a>' + summary + imgTooltip(r) + '</td>'
      + '<td class="ctr tags-cell" data-label="My list">' + tagBtns + '</td>'
      + `<td class="ctr${cls('ob')}" data-label="Best">${best}</td>`
      + `<td class="ctr${cls('pmn')}" data-label="Players">${playerRange}</td>`
      + `<td class="ctr${cls('or')}" data-label="Rec">${rec}</td>`
      + `<td class="num${cls('w')}" data-label="Weight">${fmt(r.weight, 2)}</td>`
      + `<td class="num${cls('tmn')}" data-label="Time">${time}</td>`
      + `<td class="ctr rating-group-start${cls('a')}" data-label="Avg">${fmt(r.avgRating, 2)}</td>`
      + `<td class="num rating-detail${cls('g')}" data-label="Geek">${fmt(r.geekRating, 2)}</td>`
      + `<td class="num rating-detail rating-group-end${cls('v')}" data-label="Votes">${r.votes.toLocaleString()}</td>`
      + `<td class="num rank-col${cls('rank')}" data-label="Rank">${rankCell}${rankTooltip(r)}</td>`
      + state.extraRankCols.map(k => {
          const val = r.subRanks?.[k];
          const sk = 'sr_' + k;
          return `<td class="num extra-rank-td${cls(sk)}" data-label="${SUB_RANK_LABELS[k]}">${val != null ? '#' + val : '<span class="dim">—</span>'}</td>`;
        }).join('')
      + '</tr>';
  }).join('');

  syncControls();
}

function syncControls() {
  document.querySelectorAll('thead th').forEach(th => {
    const arrow = th.querySelector('.arrow');
    if (th.dataset.k === state.sortKey) {
      th.classList.add('active');
      if (arrow) arrow.textContent = state.sortDir === 1 ? '▲' : '▼';
    } else {
      th.classList.remove('active');
      if (arrow) arrow.textContent = '▲';
    }
  });

  document.querySelectorAll('.chip-group').forEach(group => {
    const name = group.dataset.name;
    if (name === 'mechanics' || name === 'categories') return; // handled separately
    group.querySelectorAll('.chip').forEach(c => {
      if (name === 'tags') {
        c.classList.toggle('active', !!state.tags[c.dataset.tag]);
        return;
      }
      const raw = c.dataset.v;
      const v = (name === 'players' || name === 'timeMax') ? parseInt(raw, 10)
        : (name === 'minRating') ? parseFloat(raw)
        : raw;
      c.classList.toggle('active', state[name] === v);
    });
  });

  if (document.activeElement !== search) search.value = state.q;
  hideCheck.checked  = state.hideUnranked;
  bestCheck.checked  = state.bestOnly;
  bestCheck.disabled = state.players == null;
  ratingFieldSel.value = state.ratingField;

  // Sync mobile sort dropdown — add/remove sr_* entries to match extraRankCols
  sortDdMenu.querySelectorAll('li.extra-rank-sort').forEach(el => el.remove());
  state.extraRankCols.forEach(k => {
    const li = document.createElement('li');
    li.className = 'extra-rank-sort';
    li.dataset.k = 'sr_' + k;
    li.textContent = SUB_RANK_LABELS[k] + ' Rank';
    sortDdMenu.appendChild(li);
  });
  sortDdMenu.querySelectorAll('li').forEach(li => {
    li.classList.toggle('selected', li.dataset.k === state.sortKey);
  });
  const selectedLi = sortDdMenu.querySelector('li.selected');
  if (selectedLi) sortDdText.textContent = selectedLi.textContent;
  sortDirBtn.textContent = state.sortDir === 1 ? '▲' : '▼';

  // sync mechanic/category tags and mode buttons
  syncMultiSelect(mechanicSelect, mechanicInput, mechanicModeBtn, 'mechanics', 'mechanicsMode');
  syncMultiSelect(categorySelect, categoryInput, categoryModeBtn, 'categories', 'categoriesMode');

  // Update active filter badge on the panel summary
  const activeCount = [
    state.players != null,
    state.weight != null,
    state.timeMax != null,
    state.minRating != null,
    state.mechanics.length > 0,
    state.categories.length > 0,
    Object.values(state.tags).some(Boolean),
    state.hideUnranked,
  ].filter(Boolean).length;
  const badge = document.getElementById('filterBadge');
  if (badge) {
    badge.hidden = activeCount === 0;
    badge.textContent = activeCount;
  }

}

// ─── Multi-select widget ──────────────────────────────────────────────────────

/**
 * Re-renders the selected tags inside the tag-input container.
 * Leaves the <input> in place (always last child).
 */
function syncMultiSelect(container, input, modeBtn, stateKey, modeKey) {
  // remove existing tags (everything except the input and dropdown)
  container.querySelectorAll('.multi-tag').forEach(el => el.remove());

  // re-insert tags before the input
  state[stateKey].forEach(value => {
    const tag = document.createElement('span');
    tag.className = 'multi-tag';
    tag.dataset.value = value;
    tag.innerHTML = `<span class="multi-tag-label">${escapeHtml(value)}</span>`
      + `<button type="button" class="multi-tag-x" aria-label="Remove ${escapeHtml(value)}">×</button>`;
    container.insertBefore(tag, input);
  });

  modeBtn.textContent = state[modeKey];
  modeBtn.classList.toggle('active', state[stateKey].length > 1);
}

/**
 * Renders dropdown options for a multi-select widget.
 * Shows items matching the query, capped at 40.
 */
function renderDropdown(dropdown, allItems, selectedItems, query) {
  const q = query.toLowerCase();
  const visible = allItems
    .filter(item => !q || item.toLowerCase().includes(q))
    .slice(0, 40);

  if (visible.length === 0) {
    dropdown.innerHTML = '<div class="multi-dropdown-empty">No matches</div>';
    return;
  }

  dropdown.innerHTML = visible.map(item => {
    const sel = selectedItems.includes(item);
    return `<div class="multi-dropdown-item${sel ? ' selected' : ''}" role="option" aria-selected="${sel}" data-value="${escapeHtml(item)}">`
      + `<span class="item-check">✓</span>`
      + `<span>${escapeHtml(item)}</span>`
      + `</div>`;
  }).join('');
}

/**
 * Wires up a multi-select tag input.
 */
function initMultiSelect({ container, input, dropdown, modeBtn, stateKey, modeKey, allItemsFn }) {
  // open dropdown on input focus / typing
  input.addEventListener('focus', () => {
    renderDropdown(dropdown, allItemsFn(), state[stateKey], input.value);
    dropdown.hidden = false;
  });

  input.addEventListener('input', () => {
    renderDropdown(dropdown, allItemsFn(), state[stateKey], input.value);
    dropdown.hidden = false;
  });

  // click on a tag's × dismiss button
  container.addEventListener('click', e => {
    const x = e.target.closest('.multi-tag-x');
    if (x) {
      const value = x.closest('.multi-tag').dataset.value;
      update({ [stateKey]: state[stateKey].filter(v => v !== value) });
      input.focus();
      return;
    }
    // click on the container itself (not input) → focus input
    if (e.target === container) input.focus();
  });

  // click on a dropdown item → toggle selection
  dropdown.addEventListener('mousedown', e => {
    // mousedown so we can prevent blur before click fires
    e.preventDefault();
    const item = e.target.closest('.multi-dropdown-item');
    if (!item) return;
    const value = item.dataset.value;
    const current = state[stateKey];
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    update({ [stateKey]: next });
    input.value = '';
    renderDropdown(dropdown, allItemsFn(), next, '');
    input.focus();
  });

  // close dropdown when focus leaves the container
  container.addEventListener('focusout', e => {
    if (!container.contains(e.relatedTarget)) {
      dropdown.hidden = true;
      input.value = '';
    }
  });

  // OR / AND mode toggle
  modeBtn.addEventListener('click', () => {
    update({ [modeKey]: state[modeKey] === 'OR' ? 'AND' : 'OR' });
  });

  // keyboard: Backspace removes last tag when input is empty
  input.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && input.value === '' && state[stateKey].length > 0) {
      const next = state[stateKey].slice(0, -1);
      update({ [stateKey]: next });
      renderDropdown(dropdown, allItemsFn(), next, '');
    }
    if (e.key === 'Escape') {
      dropdown.hidden = true;
      input.value = '';
      input.blur();
    }
  });
}

// ─── Dynamic rank column headers ─────────────────────────────────────────────

const rankTh       = document.getElementById('rankTh');
const rankColPicker = document.getElementById('rankColPicker');

// Which sub-rank categories have at least one game with data (computed after load)
let availableSubranks = [];

function renderExtraColHeaders() {
  document.querySelectorAll('.extra-rank-th').forEach(el => el.remove());
  // Build in correct order by inserting sequentially with a moving reference
  let ref = rankTh;
  state.extraRankCols.forEach(k => {
    const th = document.createElement('th');
    th.className = 'num extra-rank-th';
    th.dataset.k = 'sr_' + k;
    th.innerHTML = `${SUB_RANK_LABELS[k]} <span class="arrow">▲</span>`
      + `<button type="button" class="remove-rank-col-btn" data-k="${k}" title="Remove column" aria-label="Remove ${SUB_RANK_LABELS[k]} column">×</button>`;
    ref.after(th);
    ref = th;
  });
}

function updateRankColPicker() {
  const added = new Set(state.extraRankCols);
  const available = availableSubranks.filter(k => !added.has(k));
  rankColPicker.innerHTML = available.length === 0
    ? '<li class="picker-empty">All categories added</li>'
    : available.map(k => `<li role="option" data-k="${k}">${SUB_RANK_LABELS[k]}</li>`).join('');
}

// ─── Existing event wiring ────────────────────────────────────────────────────

function pickSortDir(k) {
  return (k === 'n' || k === 'o' || k === 'rank' || k.startsWith('sr_')) ? 1 : -1;
}

// Thead sort — event delegation handles static + dynamic ths
document.querySelector('thead').addEventListener('click', e => {
  // Don't sort when clicking the expand, remove, or picker buttons
  if (e.target.closest('.rating-expand-btn, .remove-rank-col-btn, #addRankColBtn, #rankColPicker')) return;
  const th = e.target.closest('th[data-k]');
  if (!th) return;
  const k = th.dataset.k;
  if (k === state.sortKey) update({ sortDir: state.sortDir * -1 });
  else update({ sortKey: k, sortDir: pickSortDir(k) });
});

// Remove extra rank col
document.querySelector('thead').addEventListener('click', e => {
  const btn = e.target.closest('.remove-rank-col-btn');
  if (!btn) return;
  e.stopPropagation();
  const k = btn.dataset.k;
  const next = state.extraRankCols.filter(c => c !== k);
  if (state.sortKey === 'sr_' + k) update({ extraRankCols: next, sortKey: 'rank', sortDir: 1 });
  else update({ extraRankCols: next });
  renderExtraColHeaders();
});

// Add rank col picker toggle
const addRankColBtn = document.getElementById('addRankColBtn');
addRankColBtn.addEventListener('click', e => {
  e.stopPropagation();
  updateRankColPicker();
  rankColPicker.hidden = !rankColPicker.hidden;
});

rankColPicker.addEventListener('click', e => {
  const li = e.target.closest('li[data-k]');
  if (!li) return;
  const k = li.dataset.k;
  if (!state.extraRankCols.includes(k)) {
    update({ extraRankCols: [...state.extraRankCols, k] });
    renderExtraColHeaders();
  }
  rankColPicker.hidden = true;
});

document.addEventListener('click', e => {
  if (!rankColPicker.hidden && !e.target.closest('#rankTh')) {
    rankColPicker.hidden = true;
  }
});

search.addEventListener('input', e => update({ q: e.target.value }));
hideCheck.addEventListener('change', e => update({ hideUnranked: e.target.checked }));
bestCheck.addEventListener('change', e => update({ bestOnly: e.target.checked }));
ratingFieldSel.addEventListener('change', e => update({ ratingField: e.target.value }));

sortDdBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = sortDdMenu.hidden;
  sortDdMenu.hidden = !open;
  sortDdBtn.setAttribute('aria-expanded', String(open));
});

sortDdMenu.addEventListener('click', e => {
  const li = e.target.closest('li[data-k]');
  if (!li) return;
  const k = li.dataset.k;
  if (k !== state.sortKey) update({ sortKey: k, sortDir: pickSortDir(k) });
  sortDdMenu.hidden = true;
  sortDdBtn.setAttribute('aria-expanded', 'false');
});

document.addEventListener('click', e => {
  if (sortDdMenu.hidden) return;
  if (e.target.closest('#sortDd')) return;
  sortDdMenu.hidden = true;
  sortDdBtn.setAttribute('aria-expanded', 'false');
});

sortDirBtn.addEventListener('click', () => update({ sortDir: state.sortDir * -1 }));

// Rating expand/collapse
const ratingExpandBtn = document.getElementById('ratingExpandBtn');
if (ratingExpandBtn) {
  ratingExpandBtn.addEventListener('click', e => {
    e.stopPropagation(); // don't trigger column sort
    const expanded = gamesTable.classList.toggle('ratings-expanded');
    ratingExpandBtn.textContent = expanded ? '−' : '+';
  });
}


document.querySelectorAll('.chip-group').forEach(group => {
  const name = group.dataset.name;
  if (name === 'mechanics' || name === 'categories') return; // handled by initMultiSelect
  group.addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    if (name === 'tags') {
      const tag = btn.dataset.tag;
      update({ tags: { ...state.tags, [tag]: !state.tags[tag] } });
      return;
    }
    const raw = btn.dataset.v;
    const parsed = (name === 'players' || name === 'timeMax') ? parseInt(raw, 10)
      : (name === 'minRating') ? parseFloat(raw)
      : raw;
    const next = state[name] === parsed ? null : parsed;
    const partial = { [name]: next };
    if (name === 'players' && next == null) partial.bestOnly = false;
    update(partial);
  });
});

tbody.addEventListener('click', e => {
  const btn = e.target.closest('.tag-btn');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    const id = parseInt(btn.dataset.id, 10);
    const tag = btn.dataset.tag;
    const on = !(TAGS[id] && TAGS[id][tag]);
    setTag(id, tag, on);
    render();
    return;
  }
  if (e.target.closest('a')) return;
  if (!window.matchMedia('(max-width: 700px)').matches) return;
  const tr = e.target.closest('tr');
  if (!tr || tr.querySelector('td.loading')) return;
  const id = parseInt(tr.dataset.id, 10);
  if (EXPANDED.has(id)) EXPANDED.delete(id);
  else EXPANDED.add(id);
  tr.classList.toggle('expanded');
});

function pickRandom() {
  const rows = filteredRows();
  if (rows.length === 0) return;
  const r = rows[Math.floor(Math.random() * rows.length)];
  const tr = tbody.querySelector('tr[data-id="' + r.id + '"]');
  if (!tr) return;
  tbody.querySelectorAll('tr.picked').forEach(t => t.classList.remove('picked'));
  tr.classList.add('picked');
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => tr.classList.remove('picked'), 3000);
}

pickBtn.addEventListener('click', pickRandom);

// ─── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = 'gpw.theme';

function syncThemeIcon() {
  const cur = document.documentElement.getAttribute('data-theme');
  const isDark = cur === 'dark' || (!cur && window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeBtn.textContent = isDark ? '☀' : '🌙';
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  syncThemeIcon();
}

themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const isDark = cur === 'dark' || (!cur && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = isDark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
});

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  applyTheme(saved);
})();

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcon);

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';
  if (e.key === 'Escape') {
    if (e.target === search) {
      if (search.value) update({ q: '' });
      else search.blur();
    }
    return;
  }
  if (isInput) return;
  if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); pickRandom(); }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

loadTags();
hydrateState();
syncControls();

// Load mechanics list, categories list, and game data in parallel.
// games.json is a superset of bleemus's games.json — all existing
// fields are preserved, plus mechanics, categories, description, thumbnail, etc.
Promise.all([
  fetch('games.json').then(r => r.json()),
  fetch('mechanics.json').then(r => r.json()).catch(() => []),
  fetch('categories.json').then(r => r.json()).catch(() => []),
]).then(([games, mechanics, categories]) => {
  MECHANICS  = mechanics;
  CATEGORIES = categories;

  DATA = games.map(r => ({
    ...r,
    bestPlayers:        r.bestPlayers        || [],
    recommendedPlayers: r.recommendedPlayers || [],
    mechanics:          r.mechanics          || [],
    categories:         r.categories         || [],
    maxTime: r.maxTime != null ? r.maxTime : null,
  }));

  // Compute which sub-rank categories have data for at least one game
  availableSubranks = Object.keys(SUB_RANK_LABELS).filter(k =>
    DATA.some(r => r.subRanks?.[k] != null)
  );

  // Restore any extra rank columns from hydrated state
  renderExtraColHeaders();

  // Wire up multi-select widgets now that MECHANICS / CATEGORIES are loaded
  initMultiSelect({
    container: mechanicSelect,
    input:     mechanicInput,
    dropdown:  mechanicDropdown,
    modeBtn:   mechanicModeBtn,
    stateKey:  'mechanics',
    modeKey:   'mechanicsMode',
    allItemsFn: () => MECHANICS,
  });

  initMultiSelect({
    container: categorySelect,
    input:     categoryInput,
    dropdown:  categoryDropdown,
    modeBtn:   categoryModeBtn,
    stateKey:  'categories',
    modeKey:   'categoriesMode',
    allItemsFn: () => CATEGORIES,
  });

  render();
}).catch(err => {
  tbody.innerHTML = '<tr><td colspan="13" class="loading">Failed to load data: ' + escapeHtml(err.message) + '</td></tr>';
});
