const SORT_KEYS = {
  n: r => r.name.toLowerCase(),
  tags: r => { const t = TAGS[r.id] || {}; return (t.want ? 2 : 0) + (t.played ? 1 : 0); },
  pmn: r => r.minPlayers,
  pmx: r => r.maxPlayers,
  ob: r => r.bestPlayers && r.bestPlayers.length ? r.bestPlayers[0] : 99,
  or: r => r.recommendedPlayers && r.recommendedPlayers.length ? r.recommendedPlayers[0] : 99,
  w: r => r.weight,
  tmn: r => r.minTime,
  tmx: r => r.maxTime,
  a: r => r.avgRating,
  g: r => r.geekRating,
  h: r => r.hybridRating == null ? -1 : r.hybridRating,
  v: r => r.votes,
};

const DEFAULTS = {
  q: '',
  hideUnranked: false,
  players: null,
  weight: null,
  timeMax: null,
  minRating: null,
  ratingField: 'h',  // 'h' hybrid (default, with avg fallback), 'a' avg, 'g' geek
  bestOnly: false,
  tags: { played: false, want: false },
  sortKey: 'h',
  sortDir: -1,
};

let DATA = [];
const state = JSON.parse(JSON.stringify(DEFAULTS));
let TAGS = {};
const EXPANDED = new Set();

const tbody = document.getElementById('tbody');
const countEl = document.getElementById('count');
const search = document.getElementById('search');
const hideCheck = document.getElementById('hideUnranked');
const bestCheck = document.getElementById('bestOnly');
const ratingFieldSel = document.getElementById('ratingField');
const sortDdBtn = document.getElementById('sortDdBtn');
const sortDdMenu = document.getElementById('sortDdMenu');
const sortDdText = document.getElementById('sortDdText');
const sortDirBtn = document.getElementById('sortDirBtn');
const pickBtn = document.getElementById('pickBtn');
const themeBtn = document.getElementById('themeBtn');
const viewModeBtn = document.getElementById('viewModeBtn');
const updatedEl = document.getElementById('updated');

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

function fmt(n, dec) {
  if (n === 0 || n == null) return '<span class="dim">—</span>';
  return n.toFixed(dec);
}

function formatPollList(arr) {
  if (!arr || arr.length === 0) return '<span class="dim">—</span>';
  if (arr.length > 6) return 'any';
  return arr.join(',');
}

function parseTmx(t) {
  if (t == null) return null;
  const m = String(t).match(/-(\d+)/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? null : n;
}

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
  if (s.weight === 'med' && !(r.weight >= 2 && r.weight <= 3)) return false;
  if (s.weight === 'heavy' && !(r.weight > 3)) return false;
  if (s.timeMax != null && !(r.minTime != null && r.minTime <= s.timeMax)) return false;
  if (s.minRating != null) {
    let rating;
    if (s.ratingField === 'a') rating = r.avgRating;
    else if (s.ratingField === 'g') rating = r.geekRating;
    else rating = (r.hybridRating != null) ? r.hybridRating : r.avgRating;
    if (!(rating > 0 && rating >= s.minRating)) return false;
  }
  if (s.tags.played || s.tags.want) {
    const t = TAGS[r.id] || {};
    if (s.tags.played && !t.played) return false;
    if (s.tags.want && !t.want) return false;
  }
  return true;
}

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
    if (v === 'h' || v === 'a' || v === 'g') out.ratingField = v;
  }
  if (params.get('best') === '1') out.bestOnly = true;
  if (params.has('sort')) {
    const k = params.get('sort');
    if (SORT_KEYS[k]) {
      out.sortKey = k;
      const d = params.get('dir');
      out.sortDir = d === 'asc' ? 1 : (d === 'desc' ? -1 : pickSortDir(k));
    }
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

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function filteredRows() {
  const s = { ...state, q: state.q.toLowerCase() };
  const rows = DATA.filter(r => matches(r, s));
  const k = SORT_KEYS[state.sortKey];
  const dir = state.sortDir;
  rows.sort((a, b) => {
    const av = k(a), bv = k(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
  return rows;
}

function listText(arr) {
  if (!arr || arr.length === 0) return '—';
  if (arr.length > 6) return 'any';
  return arr.join(',');
}

const SORT_FIELD = {
  pmn: r => ['Min plr', r.minPlayers],
  pmx: r => ['Max plr', r.maxPlayers],
  ob:  r => ['Best', listText(r.bestPlayers)],
  or:  r => ['Rec', listText(r.recommendedPlayers)],
  w:   r => r.weight > 0 ? ['Weight', r.weight.toFixed(2)] : null,
  tmn: r => r.minTime != null ? ['Min time', r.minTime + ' min'] : null,
  tmx: r => r.maxTime != null ? ['Max time', r.maxTime + ' min'] : null,
  v:   r => ['Votes', r.votes.toLocaleString()],
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
  return `<span class="rating-part sort-active"><span class="rating-label">${label}</span> ${escapeHtml(value)}</span>`;
}

function render() {
  const rows = filteredRows();
  const countText = rows.length === DATA.length
    ? rows.length + ' games'
    : rows.length + ' of ' + DATA.length;
  if (rows.length > 0) {
    const mw = median(rows.filter(r => r.weight > 0).map(r => r.weight));
    const mt = median(rows.filter(r => r.minTime != null).map(r => r.minTime));
    const parts = [countText];
    if (mw != null) parts.push('median weight ' + mw.toFixed(2));
    if (mt != null) parts.push('median time ' + Math.round(mt) + ' min');
    countEl.textContent = parts.join(' · ');
  } else {
    countEl.textContent = countText;
  }
  tbody.innerHTML = rows.map(r => {
    const t = TAGS[r.id] || {};
    const tagBtns = '<span class="tag-btns">'
      + `<button type="button" class="tag-btn${t.want ? ' active' : ''}" data-id="${r.id}" data-tag="want" aria-label="Wishlist" title="Wishlist">${t.want ? '♥' : '♡'}</button>`
      + `<button type="button" class="tag-btn${t.played ? ' active' : ''}" data-id="${r.id}" data-tag="played" aria-label="Played" title="Played">✓</button>`
      + '</span>';
    const sk = state.sortKey;
    const cls = key => key === sk ? ' sort-active' : '';
    const ratingPart = (label, n, key) => n > 0 ? `<span class="rating-part${cls(key)}"><span class="rating-label">${label}</span> ${n.toFixed(2)}</span>` : '';
    const sortPart = sortFieldPart(r, sk);
    const summary = `<span class="card-summary">${ratingPart('Avg', r.avgRating, 'a')}${ratingPart('Geek', r.geekRating, 'g')}${ratingPart('Hybrid', r.hybridRating, 'h')}${sortPart}</span>`;
    const playerRange = r.minPlayers === r.maxPlayers ? String(r.minPlayers) : r.minPlayers + '–' + r.maxPlayers;
    return '<tr data-id="' + r.id + '"' + (EXPANDED.has(r.id) ? ' class="expanded"' : '') + '>'
    + '<td class="name" data-label="Game"><span class="card-chevron" aria-hidden="true"></span><span class="card-players">' + playerRange + 'p</span><a href="https://boardgamegeek.com/boardgame/' + r.id + '" target="_blank" rel="noopener">' + escapeHtml(r.name) + '</a>' + summary + '</td>'
    + '<td class="ctr tags-cell" data-label="My list">' + tagBtns + '</td>'
    + '<td class="ctr" data-label="Min players">' + r.minPlayers + '</td>'
    + '<td class="ctr" data-label="Max players">' + r.maxPlayers + '</td>'
    + '<td class="ctr" data-label="Best">' + formatPollList(r.bestPlayers) + '</td>'
    + '<td class="ctr" data-label="Recommended">' + formatPollList(r.recommendedPlayers) + '</td>'
    + '<td class="num" data-label="Weight">' + fmt(r.weight, 2) + '</td>'
    + '<td class="num" data-label="Min time">' + (r.minTime != null ? r.minTime : '<span class="dim">—</span>') + '</td>'
    + '<td class="num" data-label="Max time">' + (r.maxTime != null ? r.maxTime : '<span class="dim">—</span>') + '</td>'
    + '<td class="num" data-label="Avg">' + fmt(r.avgRating, 2) + '</td>'
    + '<td class="num" data-label="Geek">' + fmt(r.geekRating, 2) + '</td>'
    + '<td class="num hyb" data-label="Hybrid">' + (r.hybridRating == null ? '<span class="dim">—</span>' : r.hybridRating.toFixed(2)) + '</td>'
    + '<td class="num" data-label="Votes">' + r.votes.toLocaleString() + '</td>'
    + '</tr>';
  }).join('');
  syncControls();
}

function syncControls() {
  document.querySelectorAll('thead th').forEach(th => {
    const arrow = th.querySelector('.arrow');
    if (th.dataset.k === state.sortKey) {
      th.classList.add('active');
      arrow.textContent = state.sortDir === 1 ? '▲' : '▼';
    } else {
      th.classList.remove('active');
      arrow.textContent = '▲';
    }
  });
  document.querySelectorAll('.chip-group').forEach(group => {
    const name = group.dataset.name;
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
  hideCheck.checked = state.hideUnranked;
  bestCheck.checked = state.bestOnly;
  bestCheck.disabled = state.players == null;
  ratingFieldSel.value = state.ratingField;
  sortDdMenu.querySelectorAll('li').forEach(li => {
    li.classList.toggle('selected', li.dataset.k === state.sortKey);
  });
  const selectedLi = sortDdMenu.querySelector('li.selected');
  if (selectedLi) sortDdText.textContent = selectedLi.textContent;
  sortDirBtn.textContent = state.sortDir === 1 ? '▲' : '▼';
}

function pickSortDir(k) { return (k === 'n' || k === 'o') ? 1 : -1; }

document.querySelectorAll('thead th').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (k === state.sortKey) update({ sortDir: state.sortDir * -1 });
    else update({ sortKey: k, sortDir: pickSortDir(k) });
  });
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

document.querySelectorAll('.chip-group').forEach(group => {
  const name = group.dataset.name;
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

const THEME_KEY = 'gpw.theme';

function syncThemeIcon() {
  const cur = document.documentElement.getAttribute('data-theme');
  const isDark = cur === 'dark' || (!cur && window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeBtn.textContent = isDark ? '☀' : '🌙';
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
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

const VIEW_KEY = 'gpw.view';
const viewportMeta = document.querySelector('meta[name="viewport"]');

function applyView(mode) {
  if (mode === 'desktop') {
    viewportMeta.setAttribute('content', 'width=1280');
    viewModeBtn.textContent = '📱';
    viewModeBtn.title = 'Switch to mobile view';
  } else {
    viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0');
    viewModeBtn.textContent = '⤢';
    viewModeBtn.title = 'Switch to desktop view';
  }
}

viewModeBtn.addEventListener('click', () => {
  const cur = viewportMeta.getAttribute('content') || '';
  const next = cur.startsWith('width=device-width') ? 'desktop' : 'mobile';
  applyView(next);
  try { localStorage.setItem(VIEW_KEY, next); } catch {}
});

(function initView() {
  let saved = null;
  try { saved = localStorage.getItem(VIEW_KEY); } catch {}
  if (saved === 'desktop') applyView('desktop');
  if (typeof screen !== 'undefined' && screen.width >= 700) {
    viewModeBtn.style.display = 'none';
  }
})();

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
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
    search.select();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    pickRandom();
  }
});

loadTags();
hydrateState();
syncControls();

fetch('games.json')
  .then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const lm = r.headers.get('Last-Modified');
    if (lm) {
      const d = new Date(lm);
      if (!Number.isNaN(d.getTime())) {
        updatedEl.textContent = 'Last refreshed ' + d.toLocaleDateString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric'
        });
      }
    }
    return r.json();
  })
  .then(raw => {
    DATA = raw.map(r => ({
      ...r,
      bestPlayers: r.bestPlayers || [],
      recommendedPlayers: r.recommendedPlayers || [],
      hybridRating: (r.geekRating > 0) ? Math.round(((r.avgRating + r.geekRating) / 2) * 100) / 100 : null,
      maxTime: r.maxTime != null ? r.maxTime : parseTmx(r.time),
    }));
    render();
  })
  .catch(err => {
    tbody.innerHTML = '<tr><td colspan="13" class="loading">Failed to load games.json: ' + escapeHtml(err.message) + '</td></tr>';
  });
