// Random Manga Generator
// AniList (GraphQL, no key) picks the random manga and supplies cover/synopsis/metadata.
// MangaDex (REST, no key) supplies actual chapter pages for the "panels" section.
// MangaUpdates (via the dev server's /api/mu proxy) tells us whether an English translation exists.

const ANILIST = 'https://graphql.anilist.co';
const MANGADEX = 'https://api.mangadex.org';
// AniList caps pageInfo.total at 5000, so above that we pick by random id instead of random page.
const ANILIST_PAGE_CAP = 5000;
const PANEL_PREVIEW_COUNT = 9; // one big page plus eight small ones fills the grid at every width
const HISTORY_MAX = 12;
const MAX_CANDIDATES = 300; // stop looking after this many rejected candidates
const MAX_ENGLISH_CHECKS = 20; // MangaUpdates lookups per roll

const $ = (id) => document.getElementById(id);
const genreState = new Map(); // genre -> 'include' | 'exclude'
let history = [];
let disliked = []; // [{ id, title, cover, features: [genre/tag names] }]
const seenThisSession = new Set(); // ids shown since this page loaded; deliberately not stored anywhere
let readIds = new Set();
let readSeries = [];
let readTitleKeys = new Set();
let localServer = false; // true when dev-server.js is behind the page; false on static hosting like GitHub Pages
let rolling = false;
let current = null; // media currently shown
let lightboxPages = [];
let lightboxIndex = 0;
let rollToken = 0;

// ---------- helpers ----------

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function setStatus(msg, isError = false) {
  const el = $('status-msg');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

function prettyEnum(value) {
  if (!value) return '?';
  const map = { FINISHED: 'Complete', RELEASING: 'Ongoing', NOT_YET_RELEASED: 'Not yet released',
    CANCELLED: 'Cancelled', HIATUS: 'On hiatus', ONE_SHOT: 'One-shot', MANGA: 'Manga', NOVEL: 'Novel' };
  return map[value] ?? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

// AniList descriptions contain a little HTML (<br>, <i>, <b>). Convert to plain paragraphs safely.
function descriptionToParagraphs(html) {
  if (!html) return [el('p', { className: 'muted' }, 'No synopsis available.')];
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  const text = new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent;
  return text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean).map((p) => el('p', {}, p));
}

// ---------- AniList ----------

async function anilist(query, variables) {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) throw new Error('AniList rate limit hit — wait a minute and try again.');
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// Filter arguments: [graphql variable type, AniList media argument]. AniList rejects null for
// some arguments, so queries only declare the filters that are actually set.
const FILTER_DEFS = {
  status: ['MediaStatus', 'status'],
  country: ['CountryCode', 'countryOfOrigin'],
  formats: ['[MediaFormat]', 'format_in'],
  genreIn: ['[String]', 'genre_in'], // AniList treats genre_in as "has all of these"
  genreNotIn: ['[String]', 'genre_not_in'],
  minScore: ['Int', 'averageScore_greater'],
  startAfter: ['FuzzyDateInt', 'startDate_greater'],
  startBefore: ['FuzzyDateInt', 'startDate_lesser'],
  isAdult: ['Boolean', 'isAdult'],
};

function mediaListQuery(filters, extraVars, extraArgs, fields = 'id') {
  const set = Object.keys(FILTER_DEFS).filter((k) => filters[k] != null);
  const decls = [...set.map((k) => `$${k}: ${FILTER_DEFS[k][0]}`), ...extraVars, '$page: Int', '$perPage: Int'];
  const args = ['type: MANGA', ...set.map((k) => `${FILTER_DEFS[k][1]}: $${k}`), ...extraArgs];
  return `query (${decls.join(', ')}) {
    Page(page: $page, perPage: $perPage) { media(${args.join(', ')}) { ${fields} } }
  }`;
}

// Just enough of each candidate to run the synopsis / similarity / English checks without extra requests.
const CANDIDATE_FIELDS = `id idMal isAdult title { romaji english native } synonyms
  description(asHtml: false) genres tags { name rank } startDate { year }`;

async function fetchMedia(filters, { page = 1, perPage = 50, ids = null, sort = 'ID', fields = CANDIDATE_FIELDS } = {}) {
  const extraVars = ['$sort: [MediaSort]'];
  const extraArgs = ['sort: $sort'];
  if (ids) { extraVars.push('$ids: [Int]'); extraArgs.push('id_in: $ids'); }
  const query = mediaListQuery(filters, extraVars, extraArgs, fields);
  const data = await anilist(query, { ...filters, page, perPage, sort: [sort], ids });
  return data.Page.media;
}

async function fetchIds(filters, options = {}) {
  return (await fetchMedia(filters, { ...options, fields: 'id' })).map((m) => m.id);
}

const DETAILS_QUERY = `query ($id: Int) {
  Media(id: $id, type: MANGA) {
    id idMal siteUrl status format countryOfOrigin isAdult
    title { romaji english native }
    synonyms
    description(asHtml: false)
    coverImage { extraLarge large color }
    genres tags { name rank }
    averageScore popularity chapters volumes
    startDate { year } endDate { year }
    staff(perPage: 3, sort: RELEVANCE) { edges { role node { name { full } } } }
  }
}`;

// Genres AniList only uses for adult titles; hidden unless 18+ is enabled.
const ADULT_GENRES = new Set(['Hentai']);

async function loadGenres() {
  const box = $('genres');
  try {
    const data = await anilist('{ GenreCollection }');
    box.replaceChildren();
    for (const genre of data.GenreCollection) {
      const chip = el('button', { type: 'button', className: 'chip' }, genre);
      chip.dataset.genre = genre;
      if (ADULT_GENRES.has(genre)) chip.dataset.adult = '';
      chip.addEventListener('click', () => {
        const next = { undefined: 'include', include: 'exclude', exclude: undefined }[genreState.get(genre)];
        if (next) genreState.set(genre, next); else genreState.delete(genre);
        renderGenreChips();
        saveFilters();
      });
      box.append(chip);
    }
    renderGenreChips();
  } catch (err) {
    box.replaceChildren(el('span', { className: 'muted' }, `Couldn't load genres: ${err.message}`));
  }
}

function renderGenreChips() {
  const adult = $('adult').checked;
  for (const chip of $('genres').children) {
    const state = genreState.get(chip.dataset.genre);
    if (state) chip.dataset.state = state; else delete chip.dataset.state;
    chip.hidden = 'adult' in chip.dataset && !adult;
  }
}

function readFilters() {
  const include = [...genreState].filter(([, s]) => s === 'include').map(([g]) => g);
  const exclude = [...genreState].filter(([, s]) => s === 'exclude').map(([g]) => g);
  const yearFrom = parseInt($('yearFrom').value, 10);
  const yearTo = parseInt($('yearTo').value, 10);
  const minScore = parseInt($('minScore').value, 10);
  const adult = $('adult').checked;
  if (!adult) exclude.push(...ADULT_GENRES);

  return {
    status: $('status').value || null,
    country: $('country').value || null,
    formats: $('format').value ? [$('format').value] : ['MANGA', 'ONE_SHOT'],
    genreIn: include.length ? include : null,
    genreNotIn: exclude.length ? exclude : null,
    minScore: minScore > 0 ? minScore - 1 : null,
    startAfter: Number.isFinite(yearFrom) ? yearFrom * 10000 : null,
    startBefore: Number.isFinite(yearTo) ? (yearTo + 1) * 10000 : null,
    isAdult: adult ? null : false,
  };
}

// AniList's pageInfo.total is unreliable (it reports 5000 for most queries), so we count matches
// ourselves: probe the last allowed page, then binary-search for the real last page.
// Result is cached per filter set: { total } for countable sets, { broad: true } otherwise.
const PAGE_SIZE = 50;
const MAX_PAGE = ANILIST_PAGE_CAP / PAGE_SIZE;
const countCache = new Map();
let maxMangaId = null;

async function countMatches(filters) {
  const key = JSON.stringify(filters);
  if (countCache.has(key)) return countCache.get(key);

  let result;
  if ((await fetchIds(filters, { page: MAX_PAGE })).length === PAGE_SIZE) {
    result = { broad: true };
  } else {
    let lo = 1, hi = MAX_PAGE, lastSize = 0; // find the last page that has any results
    const first = await fetchIds(filters, { page: 1 });
    if (first.length < PAGE_SIZE) {
      result = { total: first.length };
    } else {
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const size = (await fetchIds(filters, { page: mid })).length;
        if (size > 0) { lo = mid; lastSize = size; } else hi = mid - 1;
      }
      if (!lastSize) lastSize = (await fetchIds(filters, { page: lo })).length;
      result = { total: (lo - 1) * PAGE_SIZE + lastSize };
    }
  }
  countCache.set(key, result);
  return result;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Yields random manga matching the filters (with CANDIDATE_FIELDS), never repeating one.
async function* candidates(filters) {
  const count = await countMatches(filters);
  if (count.total === 0) return;

  if (!count.broad) {
    // Visit pages of PAGE_SIZE in random order, shuffling each page.
    const pages = shuffle(Array.from({ length: Math.ceil(count.total / PAGE_SIZE) }, (_, i) => i + 1));
    for (const page of pages) yield* shuffle(await fetchMedia(filters, { page }));
    return;
  }

  // Too many matches to page through: sample random ids and keep the ones that match.
  if (!maxMangaId) maxMangaId = (await fetchIds({}, { perPage: 1, sort: 'ID_DESC' }))[0];
  const seen = new Set();
  for (let attempt = 0; attempt < 30; attempt++) {
    const sample = Array.from({ length: 150 }, () => randInt(30000, maxMangaId));
    const hits = (await fetchMedia(filters, { ids: sample })).filter((m) => !seen.has(m.id));
    hits.forEach((m) => seen.add(m.id));
    yield* shuffle(hits);
  }
}

// ---------- recommendation checks ----------

// AniList sometimes has only a source credit or notes instead of a real synopsis.
function hasSynopsis(description) {
  if (!description) return false;
  const text = description
    .replace(/<[^>]*>/g, ' ')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/Notes?:[\s\S]*$/i, '')
    .trim();
  return text.length >= 80;
}

// A manga's "fingerprint": its genres plus its strongest tags. Capping the tag count keeps
// tag-heavy titles (Berserk has 50+) comparable with sparsely tagged ones.
const FEATURE_TAGS = 8;
function features(media) {
  const tags = (media.tags ?? []).filter((t) => t.rank >= 60)
    .sort((a, b) => b.rank - a.rank).slice(0, FEATURE_TAGS).map((t) => t.name);
  return [...new Set([...media.genres, ...tags])];
}

function similarity(a, b) {
  const setB = new Set(b);
  const shared = a.filter((x) => setB.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? shared / union : 0;
}

// Returns the disliked manga this one is too similar to, or null.
function similarDislike(media, threshold) {
  if (!threshold) return null;
  const mine = features(media);
  if (mine.length < 2) return null; // too little info to judge
  let best = null;
  for (const d of disliked) {
    const score = similarity(mine, d.features);
    if (score >= threshold && (!best || score > best.score)) best = { ...d, score };
  }
  return best;
}

function normalizeTitle(t) {
  return t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

async function mangaupdates(path, body) {
  const res = await fetch(`/api/mu/${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    throw new Error('The English-translation check needs the site running with `npm run dev`.');
  }
  if (!res.ok) throw new Error(`MangaUpdates ${res.status}`);
  return res.json();
}

const ENGLISH_CACHE_DAYS = 7;
const englishCache = new Map(Object.entries(load('rmg.english', {})));

// Looks the manga up on MangaUpdates (matching on any of its titles + year) and reports whether
// any English scanlation has been released or it's licensed in English.
async function checkEnglish(media) {
  const cached = englishCache.get(String(media.id));
  if (cached && Date.now() - cached.at < ENGLISH_CACHE_DAYS * 864e5) return cached;

  const names = [media.title.romaji, media.title.english, media.title.native, ...(media.synonyms ?? [])].filter(Boolean);
  const wanted = new Set(names.map(normalizeTitle));
  const year = media.startDate?.year;
  let match = null;
  for (const search of [...new Set([media.title.romaji, media.title.english, media.title.native])].filter(Boolean)) {
    const { results = [] } = await mangaupdates('series/search', { search, perpage: 10 });
    match = results.find((r) => {
      const titleOk = wanted.has(normalizeTitle(r.hit_title ?? '')) || wanted.has(normalizeTitle(r.record.title));
      const muYear = parseInt(r.record.year, 10);
      return titleOk && (!year || !muYear || Math.abs(muYear - year) <= 2);
    });
    if (match) break;
  }

  let result = { english: false, at: Date.now() };
  if (match) {
    const id = match.record.series_id;
    result.url = match.record.url;
    const releases = await mangaupdates('releases/search', { search: String(id), search_type: 'series', perpage: 1 });
    if (releases.total_hits > 0) {
      result = { ...result, english: true, releases: releases.total_hits };
    } else {
      const series = await mangaupdates(`series/${id}`);
      if (series.licensed) result = { ...result, english: true, licensed: true };
    }
  }
  englishCache.set(String(media.id), result);
  store('rmg.english', Object.fromEntries(englishCache));
  return result;
}

// ---------- never-show rules ----------

function isRead(media) {
  if (readIds.has(media.id)) return true;
  const { romaji, english, native } = media.title;
  const names = [romaji, english, native, ...(media.synonyms ?? [])].filter(Boolean);
  return names.some((n) => readTitleKeys.has(normalizeTitle(n)) || readSeries.some((series) => series.test(n)));
}

const isDisliked = (id) => disliked.some((d) => d.id === id);

function renderCaption() {
  $('read-count').textContent = readIds.size + readTitleKeys.size;
  $('read-part').hidden = !readIds.size;
  $('dislike-count').textContent = disliked.length;
  $('seen-count').textContent = seenThisSession.size;
}

function startOver() {
  seenThisSession.clear();
  renderCaption();
  setStatus('Fresh start. Anything from this session can come up again.');
}

// ---------- MangaDex ----------

async function mangadex(path, params = {}) {
  const url = new URL(MANGADEX + path);
  for (const [k, v] of Object.entries(params)) {
    for (const item of [].concat(v)) url.searchParams.append(k, item);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MangaDex ${res.status}`);
  return res.json();
}

function contentRatings(media) {
  return media.isAdult ? ['safe', 'suggestive', 'erotica', 'pornographic'] : ['safe', 'suggestive'];
}

// MangaDex entries store their AniList/MAL ids in attributes.links, so search by title and match on those.
async function findMangaDexEntry(media) {
  const titles = [...new Set([media.title.romaji, media.title.english, media.title.native].filter(Boolean))];
  for (const title of titles) {
    const data = await mangadex('/manga', { title, limit: 20, 'contentRating[]': contentRatings(media) });
    const hit = data.data.find((m) => {
      const links = m.attributes.links ?? {};
      return links.al === String(media.id) || (media.idMal && links.mal === String(media.idMal));
    });
    if (hit) return hit;
  }
  return null;
}

async function findReadableChapters(mdId, media) {
  const base = {
    limit: 100, includeExternalUrl: 0, 'order[chapter]': 'asc',
    'contentRating[]': contentRatings(media),
  };
  let data = await mangadex(`/manga/${mdId}/feed`, { ...base, 'translatedLanguage[]': 'en' });
  let chapters = data.data.filter((c) => c.attributes.pages > 0);
  let english = true;
  if (!chapters.length) {
    data = await mangadex(`/manga/${mdId}/feed`, base);
    chapters = data.data.filter((c) => c.attributes.pages > 0);
    english = false;
  }
  return { chapters, english };
}

async function loadPanels(media, token) {
  const section = $('panels-section');
  const grid = $('panels-grid');
  const note = $('panels-note');
  section.hidden = false;
  $('panels-title').textContent = 'Panels';
  note.textContent = 'Searching MangaDex for pages…';
  grid.replaceChildren();

  try {
    const entry = await findMangaDexEntry(media);
    if (token !== rollToken) return;
    if (!entry) {
      note.textContent = 'This title isn’t on MangaDex, so no panels are available.';
      return;
    }
    const mdUrl = `https://mangadex.org/title/${entry.id}`;
    const { chapters, english } = await findReadableChapters(entry.id, media);
    if (token !== rollToken) return;
    if (!chapters.length) {
      note.replaceChildren('Found on MangaDex, but it has no hosted chapters (often due to licensing). ',
        el('a', { href: mdUrl, target: '_blank', rel: 'noopener' }, 'View on MangaDex'));
      return;
    }

    const chapter = chapters[randInt(0, chapters.length - 1)];
    const { baseUrl, chapter: files } = await mangadex(`/at-home/server/${chapter.id}`);
    if (token !== rollToken) return;

    const a = chapter.attributes;
    const label = [a.volume && `Vol. ${a.volume}`, a.chapter ? `Ch. ${a.chapter}` : 'Oneshot', a.title].filter(Boolean).join(' · ');
    $('panels-title').textContent = `Panels — ${label}`;
    note.replaceChildren(
      `Random chapter, ${a.pages} pages${english ? '' : ` (language: ${a.translatedLanguage})`}. Click a page to read. `,
      el('a', { href: `https://mangadex.org/chapter/${chapter.id}`, target: '_blank', rel: 'noopener' }, 'Read on MangaDex'),
    );

    lightboxPages = files.data.map((f) => `${baseUrl}/data/${files.hash}/${f}`);
    const previews = files.dataSaver.map((f) => `${baseUrl}/data-saver/${files.hash}/${f}`);
    // Skip the first page when we can, it's often a credits/cover page.
    const start = previews.length > PANEL_PREVIEW_COUNT ? 1 : 0;
    previews.slice(start, start + PANEL_PREVIEW_COUNT).forEach((src, i) => {
      const btn = el('button', { type: 'button', title: `Page ${start + i + 1}` },
        el('img', { src, alt: `Page ${start + i + 1}`, loading: 'lazy' }));
      btn.addEventListener('click', () => openLightbox(start + i));
      grid.append(btn);
    });
  } catch (err) {
    if (token === rollToken) note.textContent = `Couldn't load panels: ${err.message}`;
  }
}

// ---------- rendering ----------

const SFX = ['ドン!', 'バン!', 'ドドド', 'ゴゴゴ', 'ズバッ'];

function renderMedia(media) {
  const title = media.title.english || media.title.romaji;
  $('title').textContent = title;
  $('title').classList.toggle('long', title.length > 42);
  const alts = [media.title.romaji, media.title.native].filter((t) => t && t !== title);
  $('alt-title').textContent = alts.join(' · ');

  const cover = $('cover');
  cover.style.opacity = 0; // don't show the previous cover while the new one loads
  cover.onload = () => { cover.style.opacity = 1; };
  cover.src = media.coverImage.extraLarge || media.coverImage.large;
  cover.alt = `Cover of ${title}`;
  cover.style.backgroundColor = media.coverImage.color || '';

  const years = media.startDate.year
    ? media.endDate.year && media.endDate.year !== media.startDate.year
      ? `${media.startDate.year}–${media.endDate.year}` : `${media.startDate.year}`
    : '?';
  const authors = media.staff.edges.filter((e) => /story|art|original/i.test(e.role)).map((e) => e.node.name.full);
  const meta = [
    ['Status', prettyEnum(media.status)],
    ['Format', prettyEnum(media.format)],
    ['Years', years],
    ['Chapters', media.chapters ?? '?'],
    ['Volumes', media.volumes ?? '?'],
    ['Score', media.averageScore ? `${media.averageScore}%` : '—'],
    ['Origin', { JP: 'Japan', KR: 'Korea', CN: 'China', TW: 'Taiwan' }[media.countryOfOrigin] ?? media.countryOfOrigin],
  ];
  if (authors.length) meta.push(['By', [...new Set(authors)].join(', ')]);
  $('meta').replaceChildren(...meta.map(([k, v]) => el('li', {}, [`${k}: `, el('b', {}, String(v))])));

  $('genre-list').replaceChildren(...media.genres.map((g) => el('li', {}, g)));
  $('synopsis').replaceChildren(...descriptionToParagraphs(media.description));
  $('synopsis').scrollTop = 0;

  const links = [el('a', { href: media.siteUrl, target: '_blank', rel: 'noopener' }, 'AniList')];
  if (media.idMal) {
    links.push(el('a', { href: `https://myanimelist.net/manga/${media.idMal}`, target: '_blank', rel: 'noopener' }, 'MyAnimeList'));
  }
  $('links').replaceChildren(...links);
  $('sfx').textContent = SFX[randInt(0, SFX.length - 1)];
  $('empty').hidden = true;
  $('result').hidden = false;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('result').animate(
      [{ transform: 'scale(1.03) rotate(-.5deg)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 160, easing: 'cubic-bezier(.2,.9,.3,1)' },
    );
  }
}

// Shows the English-translation result; looks it up if we don't have it yet (e.g. from history).
async function renderEnglish(media, english, token) {
  const box = $('english');
  box.hidden = false;
  box.className = 'english muted';
  box.textContent = 'Checking for an English translation…';
  try {
    english ??= await checkEnglish(media);
  } catch (err) {
    if (token === rollToken) box.textContent = err.message;
    return;
  }
  if (token !== rollToken) return;
  const text = english.releases
    ? `English translation available (${english.releases} release${english.releases === 1 ? '' : 's'} tracked on MangaUpdates). `
    : english.licensed ? 'Officially licensed in English. '
    : 'No English translation found. ';
  box.className = `english ${english.english ? 'yes' : 'no'}`;
  box.replaceChildren(text);
  if (english.url) box.append(el('a', { href: english.url, target: '_blank', rel: 'noopener' }, 'MangaUpdates'));
}

function addToHistory(media) {
  history = [
    { id: media.id, title: media.title.english || media.title.romaji, cover: media.coverImage.large },
    ...history.filter((h) => h.id !== media.id),
  ].slice(0, HISTORY_MAX);
  store('rmg.history', history);
  renderHistory();
}

function renderHistory() {
  $('history-section').hidden = !history.length;
  $('history').replaceChildren(...history.map((h) => {
    const btn = el('button', { type: 'button', title: h.title },
      [el('img', { src: h.cover, alt: '', loading: 'lazy' }), el('span', {}, h.title)]);
    btn.addEventListener('click', () => showById(h.id));
    return btn;
  }));
}

async function show(media, english) {
  const token = ++rollToken;
  current = media;
  seenThisSession.add(media.id);
  renderCaption();
  renderMedia(media);
  if (localServer) renderEnglish(media, english, token);
  else $('english').hidden = true;
  addToHistory(media);
  window.scrollTo({ top: $('result').getBoundingClientRect().top + window.scrollY - 16, behavior: 'smooth' });
  if ($('panels').checked) loadPanels(media, token);
  else $('panels-section').hidden = true;
}

async function showById(id) {
  setStatus('Loading…');
  try {
    const { Media } = await anilist(DETAILS_QUERY, { id });
    setStatus('');
    show(Media, englishCache.get(String(id)));
  } catch (err) {
    setStatus(err.message, true);
  }
}

function readPrefs() {
  return {
    englishOnly: localServer && $('englishOnly').checked,
    requireSynopsis: $('requireSynopsis').checked,
    threshold: parseFloat($('similarity').value) || 0,
  };
}

function skippedSummary(skipped) {
  const parts = [];
  if (skipped.read) parts.push(`${skipped.read} you've read`);
  if (skipped.seen) parts.push(`${skipped.seen} already seen this session`);
  if (skipped.similar.length) {
    const names = [...new Set(skipped.similar)].slice(0, 3).join(', ');
    parts.push(`${skipped.similar.length} too similar to ${names}`);
  }
  if (skipped.noSynopsis) parts.push(`${skipped.noSynopsis} without a synopsis`);
  if (skipped.noEnglish) parts.push(`${skipped.noEnglish} without an English translation`);
  if (skipped.disliked) parts.push(`${skipped.disliked} marked not for you`);
  return parts.length ? `Skipped ${parts.join(', ')}.` : '';
}

async function roll() {
  if (rolling) return;
  rolling = true;
  document.body.classList.add('rolling');
  setStatus('Rolling the dice…');
  await dislikesLoaded;
  const prefs = readPrefs();
  const skipped = { read: 0, seen: 0, disliked: 0, similar: [], noSynopsis: 0, noEnglish: 0 };
  let matched = 0;
  let tried = 0;
  let englishChecks = 0;
  let found = null;

  try {
    for await (const media of candidates(readFilters())) {
      matched++;
      // These three cost no requests, so they don't count towards the give-up limit.
      if (isRead(media)) { skipped.read++; continue; }
      if (isDisliked(media.id)) { skipped.disliked++; continue; }
      if (seenThisSession.has(media.id)) { skipped.seen++; continue; }
      if (++tried > MAX_CANDIDATES) break;
      if (prefs.requireSynopsis && !hasSynopsis(media.description)) { skipped.noSynopsis++; continue; }
      const similar = similarDislike(media, prefs.threshold);
      if (similar) { skipped.similar.push(similar.title); continue; }
      if (prefs.englishOnly) {
        if (++englishChecks > MAX_ENGLISH_CHECKS) break;
        setStatus(`Checking for an English translation of ${media.title.romaji}…`);
        const english = await checkEnglish(media);
        if (!english.english) { skipped.noEnglish++; continue; }
        found = { id: media.id, english };
      } else {
        found = { id: media.id };
      }
      break;
    }

    if (!found) {
      setStatus(!matched
        ? 'No manga match those filters. Try loosening them.'
        : tried
          ? `Couldn't find one that passes all your filters this time. ${skippedSummary(skipped)} Try again or loosen them.`
          : `That's everything matching these filters. ${skippedSummary(skipped)} Loosen them, or press Start over.`, true);
      return;
    }
    const { Media: media } = await anilist(DETAILS_QUERY, { id: found.id });
    const summary = skippedSummary(skipped);
    setStatus('');
    if (summary) $('status-msg').append(el('small', {}, summary));
    show(media, found.english);
  } catch (err) {
    setStatus(`Something went wrong: ${err.message}`, true);
  } finally {
    rolling = false;
    document.body.classList.remove('rolling');
  }
}

// ---------- dislikes ----------

let dislikeWrites = Promise.resolve();

function saveDisliked() {
  store('rmg.disliked', disliked);
  if (!localServer) return;
  const body = JSON.stringify(disliked);
  dislikeWrites = dislikeWrites
    .then(() => fetch('/api/disliked', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }))
    .then((res) => { if (!res.ok) throw new Error(`server said ${res.status}`); })
    .catch((err) => setStatus(`Couldn't save your "Not for me" list to disk (${err.message}). It's only in this browser for now.`, true));
}

function loadReadList() {
  return new Promise((resolve) => {
    const script = el('script', { src: 'read-list.js' });
    script.onload = () => {
      readIds = READ_LIST.ids;
      readSeries = READ_LIST.series;
      readTitleKeys = new Set(READ_LIST.titles.map(normalizeTitle));
      renderCaption();
      resolve();
    };
    script.onerror = resolve; // a fresh clone has no read list
    document.head.append(script);
  });
}

// The file on disk wins. The first time each address connects, anything that was only in this
// browser's localStorage gets merged in; after that, a removal stays removed.
async function loadDisliked() {
  let saved;
  try {
    const res = await fetch('/api/disliked');
    if (!res.ok) return; // static hosting: localStorage is all we have
    saved = await res.json();
    if (!Array.isArray(saved)) return;
  } catch {
    return;
  }
  localServer = true;
  $('english-option').hidden = false;
  await loadReadList();
  const firstSync = !load('rmg.dislikedSynced', false);
  const savedIds = new Set(saved.map((d) => d.id));
  const localOnly = firstSync ? disliked.filter((d) => !savedIds.has(d.id)) : [];
  disliked = [...saved, ...localOnly];
  store('rmg.dislikedSynced', true);
  store('rmg.disliked', disliked);
  if (localOnly.length) saveDisliked();
  forgetHiddenHistory();
  renderDisliked();
}

// Past history can hold titles that have since been marked as read or disliked.
function forgetHiddenHistory() {
  history = history.filter((h) => !isDisliked(h.id) && !isRead({ id: h.id, title: { romaji: h.title } }));
  store('rmg.history', history);
  renderHistory();
}

async function dislikeCurrent() {
  if (!current) return;
  const media = current;
  await dislikesLoaded;
  disliked = [
    { id: media.id, title: media.title.english || media.title.romaji, cover: media.coverImage.large, features: features(media) },
    ...disliked.filter((d) => d.id !== media.id),
  ];
  saveDisliked();
  forgetHiddenHistory();
  renderDisliked();
  roll();
}

function renderDisliked() {
  $('disliked-section').hidden = !disliked.length;
  $('disliked-count').textContent = `(${disliked.length})`;
  renderCaption();
  $('disliked').replaceChildren(...disliked.map((d) => {
    const btn = el('button', { type: 'button', title: `Remove ${d.title} from "Not for me"` },
      [el('img', { src: d.cover, alt: '', loading: 'lazy' }), el('span', {}, d.title)]);
    btn.addEventListener('click', () => {
      disliked = disliked.filter((x) => x.id !== d.id);
      saveDisliked();
      renderDisliked();
    });
    return btn;
  }));
}

async function copyTitle() {
  if (!current) return;
  const button = $('copy-title');
  try {
    await navigator.clipboard.writeText(current.title.romaji || current.title.english);
    button.textContent = 'Copied!';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = 'Copy title (for Mihon search)'; }, 1500);
}

// ---------- lightbox ----------

function openLightbox(index) {
  lightboxIndex = index;
  updateLightbox();
  $('lightbox').showModal();
}
function updateLightbox() {
  $('lightbox-img').src = lightboxPages[lightboxIndex];
  $('lb-count').textContent = `${lightboxIndex + 1} / ${lightboxPages.length}`;
}
function stepLightbox(delta) {
  lightboxIndex = (lightboxIndex + delta + lightboxPages.length) % lightboxPages.length;
  updateLightbox();
}

// ---------- filters persistence ----------

const FILTER_INPUTS = ['status', 'country', 'format', 'minScore', 'yearFrom', 'yearTo', 'adult', 'panels',
  'englishOnly', 'requireSynopsis', 'similarity'];

function saveFilters() {
  const values = Object.fromEntries(FILTER_INPUTS.map((id) => {
    const input = $(id);
    return [id, input.type === 'checkbox' ? input.checked : input.value];
  }));
  store('rmg.filters', { values, genres: [...genreState] });
}

function restoreFilters() {
  const saved = load('rmg.filters', null);
  if (!saved) return;
  for (const [id, value] of Object.entries(saved.values ?? {})) {
    const input = $(id);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
  }
  for (const [genre, state] of saved.genres ?? []) genreState.set(genre, state);
}

function updateScoreLabel() {
  const v = parseInt($('minScore').value, 10);
  $('scoreOut').textContent = v > 0 ? `${v}%+` : 'any';
}

// ---------- init ----------

let dislikesLoaded = Promise.resolve();

function init() {
  restoreFilters();
  updateScoreLabel();
  disliked = load('rmg.disliked', []);
  history = load('rmg.history', []);
  forgetHiddenHistory();
  renderDisliked();
  dislikesLoaded = loadDisliked();
  loadGenres();

  $('roll').addEventListener('click', roll);
  $('next').addEventListener('click', roll);
  $('start-over').addEventListener('click', startOver);
  $('dislike').addEventListener('click', dislikeCurrent);
  $('copy-title').addEventListener('click', copyTitle);
  for (const id of FILTER_INPUTS) $(id).addEventListener('change', saveFilters);
  $('minScore').addEventListener('input', updateScoreLabel);
  $('adult').addEventListener('change', renderGenreChips);
  $('reset').addEventListener('click', () => {
    $('status').value = '';
    $('country').value = '';
    $('format').value = '';
    $('minScore').value = 0;
    $('yearFrom').value = '';
    $('yearTo').value = '';
    $('adult').checked = false;
    genreState.clear();
    updateScoreLabel();
    renderGenreChips();
    saveFilters();
  });

  $('lb-prev').addEventListener('click', () => stepLightbox(-1));
  $('lb-next').addEventListener('click', () => stepLightbox(1));
  $('lb-close').addEventListener('click', () => $('lightbox').close());
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) $('lightbox').close(); });
  document.addEventListener('keydown', (e) => {
    if (!$('lightbox').open) return;
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });
}

init();
