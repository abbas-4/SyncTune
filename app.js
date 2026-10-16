'use strict';
/* ============================================================
   SynceTune — logic

   What makes this fast:
     1. One parallel health check picks live YouTube-search instances up
        front, sorted fastest-first. A dead instance costs ~3s once for the
        whole run instead of ~13s per track.
     2. Work is round-robined across every live instance, so no single one
        gets hammered into rate-limiting. Concurrency scales with how many
        answered.
     3. An instance that errors three times is dropped for the rest of the
        run. No worker rediscovers the same corpse.
     4. Matches are cached in memory and on this device, so a repeat run of
        the same playlist needs zero requests.
     5. Spotify relays are raced once, then the winner is pinned.
     6. The UI paints on requestAnimationFrame, not once per track, and the
        188-row tracklist is only built if you open it.
     7. Stop aborts requests in flight instead of waiting them out.
   ============================================================ */

/* ---------- helpers ---------- */
const enc = encodeURIComponent;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const link = (href, text) => {
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
  return a;
};

/* timeouts, in ms */
const T_PROBE = 4000;   // health check per instance
const T_SEARCH = 6500;  // one search request
const T_RELAY = 9000;   // one relay request
const T_DIRECT = 3000;  // no-relay attempt

/* ---------- dom, looked up once ---------- */
const D = {};

/* ---------- run control ---------- */
let state = { name: '', tracks: [] };
let ctrl = new AbortController();
let stopFlag = false;
let ytAnswered = false;

function startRun() { stopFlag = false; ctrl = new AbortController(); }
function stopRun() { stopFlag = true; ctrl.abort(); }
const stopErr = () => Object.assign(new Error('stopped'), { code: 'STOP' });
const netErr = () => Object.assign(new Error('net'), { code: 'NET' });
function checkStop() { if (stopFlag) throw stopErr(); }

/* ---------- fetch with timeout + Stop support ---------- */
async function fetchText(url, ms) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  const relay = () => c.abort();
  ctrl.signal.addEventListener('abort', relay);
  try {
    const r = await fetch(url, { signal: c.signal, referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
    ctrl.signal.removeEventListener('abort', relay);
  }
}
const fetchJson = async (url, ms) => JSON.parse(await fetchText(url, ms));

/* ---------- ui, painted at most once per frame ---------- */
const ui = { msg: '', kind: null, done: 0, total: 0, bar: false };
let frame = 0;

function paint() {
  frame = 0;
  D.status.textContent = ui.msg;
  D.status.className = 'status' + (ui.kind ? ' ' + ui.kind : '');
  if (ui.bar) {
    D.bar.classList.add('on');
    D.fill.style.width = (ui.total ? Math.round(ui.done / ui.total * 100) : 0) + '%';
  } else {
    D.bar.classList.remove('on');
    D.fill.style.width = '0%';
  }
}
function schedule() { if (!frame) frame = requestAnimationFrame(paint); }
function status(msg, kind) { ui.msg = msg || ''; ui.kind = kind || null; schedule(); }
function statusNow(msg, kind) { status(msg, kind); if (frame) { cancelAnimationFrame(frame); } paint(); }
function progress(done, total) {
  if (total == null) { ui.bar = false; } else { ui.bar = true; ui.done = done; ui.total = total; }
  schedule();
}
function busy(on) {
  D.go.disabled = on;
  D.go.textContent = on ? 'Working…' : 'Transfer →';
  D.stop.hidden = !on;
}
function notice(lines) {
  if (!lines) { D.notice.hidden = true; return; }
  const frag = document.createDocumentFragment();
  lines.forEach((l, i) => {
    const d = el('div');
    if (i === 0) d.appendChild(el('b', null, l)); else d.textContent = l;
    frag.appendChild(d);
  });
  D.notice.textContent = '';
  D.notice.appendChild(frag);
  D.notice.hidden = false;
}

/* ---------- match cache: memory + this device ---------- */
const CACHE_KEY = 'syncetune.matches.v1';
const CACHE_MAX = 4000;
const cache = new Map();
let saveTimer = 0;

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    for (const k in obj) if (typeof obj[k] === 'string') cache.set(k, obj[k]);
  } catch (e) { /* storage blocked — memory-only is fine */ }
}
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const hits = [...cache].filter(e => e[1]);          // never persist misses
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(hits.slice(-CACHE_MAX))));
    } catch (e) { /* full or blocked — ignore */ }
  }, 900);
}
function clearCache() {
  cache.clear();
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

/* ---------- search query ---------- */
/* Trimming feat./remaster noise both matches better and collapses duplicates
   into one cache entry. "(Live)" and "(Acoustic)" stay — different recordings. */
const FEAT_RE = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi;
const TAIL_RE = /\s*[-–—]\s*(?:\d{4}\s+)?(?:re-?master(?:ed)?|radio edit|single version|album version|mono version|stereo version|bonus track|deluxe(?:\s+edition)?)(?:\s+\d{4})?\s*(?:version)?\s*$/i;

function queryFor(t) {
  const title = (t.title || '').replace(FEAT_RE, '').replace(TAIL_RE, '');
  const artist = (t.artist || '').split(',').slice(0, 2).join(' ');
  return (title + ' ' + artist).replace(/\s+/g, ' ').trim().toLowerCase();
}

/* ============================================================
   Spotify side: free relays, raced once then pinned
   ============================================================ */
const RELAYS = [
  u => 'https://api.allorigins.win/raw?url=' + enc(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + enc(u),
  u => 'https://corsproxy.io/?url=' + enc(u),
];
let pinnedRelay = -1;
let directOk = null;   // null = untested, true/false = decided for this run

async function viaRelay(i, url) {
  const txt = await fetchText(RELAYS[i](url), T_RELAY);
  if (!txt || txt.length < 60) throw new Error('thin');
  return txt;
}

/* tryDirect: only worth it for endpoints that send CORS headers (oembed).
   The embed page never does, so we skip straight to a relay for it. */
async function relayFetch(url, tryDirect) {
  checkStop();

  if (tryDirect && directOk !== false) {
    try {
      const txt = await fetchText(url, T_DIRECT);
      if (txt && txt.length > 40) { directOk = true; return txt; }
      directOk = false;
    } catch (e) { checkStop(); directOk = false; }
  }

  if (pinnedRelay >= 0) {
    try { return await viaRelay(pinnedRelay, url); }
    catch (e) { checkStop(); pinnedRelay = -1; }
  }

  // no known-good relay yet: race them, keep whoever answers first
  try {
    const winner = await Promise.any(RELAYS.map(async (fn, i) => ({ i, txt: await viaRelay(i, url) })));
    pinnedRelay = winner.i;
    return winner.txt;
  } catch (e) {
    checkStop();
    throw netErr();
  }
}

/* ============================================================
   YouTube side: public Piped / Invidious instances
   These are open-source YouTube front-ends that answer plain JSON with CORS
   on, so no key and no login. Instances come and go constantly — the health
   check below is what keeps a dead one from costing you anything. To add one:
   docs.piped.video and docs.invidious.io keep live lists.
   ============================================================ */
const PROVIDERS = [
  { base: 'https://pipedapi.adminforge.de',    kind: 'piped' },
  { base: 'https://api.piped.private.coffee',  kind: 'piped' },
  { base: 'https://pipedapi.kavin.rocks',      kind: 'piped' },
  { base: 'https://pipedapi.reallyaweso.me',   kind: 'piped' },
  { base: 'https://inv.nadeko.net',            kind: 'inv' },
  { base: 'https://invidious.nerdvpn.de',      kind: 'inv' },
  { base: 'https://iv.melmac.space',           kind: 'inv' },
  { base: 'https://invidious.f5.si',           kind: 'inv' },
];

const searchUrl = (p, q, wide) => p.kind === 'piped'
  ? p.base + '/search?q=' + enc(q) + '&filter=' + (wide ? 'all' : 'music_songs')
  : p.base + '/api/v1/search?q=' + enc(q) + '&type=video';

const ID_RE = /^[\w-]{11}$/;

function pickPiped(data) {
  const items = Array.isArray(data && data.items) ? data.items : (Array.isArray(data) ? data : []);
  for (const it of items) {
    const m = it && it.url && String(it.url).match(/v=([\w-]{11})/);
    if (m) return m[1];
  }
  return null;
}
function pickInv(data) {
  const arr = Array.isArray(data) ? data : [];
  const v = arr.find(x => x && x.type === 'video' && x.videoId) || arr[0];
  return (v && typeof v.videoId === 'string' && ID_RE.test(v.videoId)) ? v.videoId : null;
}
const pick = (p, data) => p.kind === 'piped' ? pickPiped(data) : pickInv(data);
const shapeOk = (p, data) => p.kind === 'piped'
  ? !!(data && (Array.isArray(data.items) || Array.isArray(data)))
  : Array.isArray(data);

let live = [];              // healthy instances, fastest first
let cursor = 0;             // round-robin position
const strikes = new Map();  // provider -> consecutive failures

/* One parallel round-trip decides which instances are usable, and warms
   their DNS/TLS while it's at it. Costs T_PROBE at worst, total — and it
   runs while Spotify is still loading, so usually it costs nothing. */
let probing = null;
function startProbe() {
  probing = probeProviders(true).catch(() => 0);
  return probing;
}
function awaitProbe() {
  if (!probing) probing = probeProviders(false).catch(() => 0);
  return probing;
}

const PROBE_Q = 'daft punk one more time';
const PROBE_ENOUGH = 3;

async function probeProviders(quiet) {
  if (!quiet) status('Finding live search instances…');
  live = [];
  cursor = 0;
  strikes.clear();

  let enoughNow;
  const enough = new Promise(r => { enoughNow = r; });

  const all = Promise.all(PROVIDERS.map(async p => {
    try {
      const data = await fetchJson(searchUrl(p, PROBE_Q, false), T_PROBE);
      if (pick(p, data) || shapeOk(p, data)) {
        ytAnswered = true;
        live.push(p);                       // arrival order == fastest first
        if (live.length >= PROBE_ENOUGH) enoughNow();
      }
    } catch (e) { /* dead or slow — skipped, and a straggler can still join */ }
  }));

  // don't sit through the dead ones' timeouts; slow instances that answer
  // later just join the pool mid-run
  await Promise.race([all, enough]);
  return live.length;
}

function nextProvider() {
  if (!live.length) return null;
  return live[cursor++ % live.length];
}
function strike(p) {
  const n = (strikes.get(p) || 0) + 1;
  strikes.set(p, n);
  if (n >= 3) {
    const i = live.indexOf(p);
    if (i > -1) live.splice(i, 1);
  }
}

async function searchOn(p, q) {
  let data = await fetchJson(searchUrl(p, q, false), T_SEARCH);
  ytAnswered = true;
  strikes.set(p, 0);
  let vid = pick(p, data);
  if (!vid && p.kind === 'piped') {           // music filter misses remixes — widen once
    data = await fetchJson(searchUrl(p, q, true), T_SEARCH);
    vid = pick(p, data);
  }
  return vid;
}

/* last resort: scrape the real results page through a relay */
async function scrapeSearch(q) {
  const html = await relayFetch('https://www.youtube.com/results?search_query=' + enc(q), false);
  const m = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (m || /ytInitialData/.test(html)) ytAnswered = true;
  return m ? m[1] : null;
}

/* Two shots at two different live instances, then the relay. Bounded at
   roughly 20s worst case per track instead of the old ~80s. */
async function findVid(t) {
  const q = t.q;
  if (cache.has(q)) return cache.get(q);

  for (let i = 0; i < 2; i++) {
    checkStop();
    const p = nextProvider();
    if (!p) break;
    try {
      const vid = await searchOn(p, q);
      cache.set(q, vid);
      if (vid) saveCache();
      return vid;
    } catch (e) {
      checkStop();
      strike(p);
    }
  }

  checkStop();
  const vid = await scrapeSearch(q);
  cache.set(q, vid);
  if (vid) saveCache();
  return vid;
}

/* ---------- work pool ---------- */
async function pool(items, worker, size) {
  if (!items.length) return;
  let i = 0;
  const run = async () => {
    while (i < items.length && !stopFlag) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

async function matchAll(tracks) {
  const todo = tracks.filter(t => !t.vid && !t.tried);
  if (!todo.length) return;
  for (const t of todo) t.q = queryFor(t);

  // cached matches are free — settle them before touching the network
  let done = 0;
  const net = [];
  for (const t of todo) {
    if (cache.has(t.q) && cache.get(t.q)) { t.vid = cache.get(t.q); t.tried = true; done++; }
    else net.push(t);
  }
  if (done) {
    progress(done, todo.length);
    status('Reused ' + done + ' match' + (done === 1 ? '' : 'es') + ' from last time…');
  }
  if (!net.length) { progress(); return; }

  const n = await awaitProbe();
  if (n) status(n + ' instance' + (n === 1 ? '' : 's') + ' live — matching…');
  else status('No search instance answered — trying a relay…');

  // one instance gets 2 workers, four get 8: fast without triggering 429s
  const width = n ? Math.min(8, Math.max(2, n * 2)) : 2;
  // with no live instance every track falls to a slow relay scrape, so give
  // up after the first round instead of grinding through the whole playlist
  const bailAt = n ? 8 : 2;
  let hits = 0, fails = 0, bail = false;

  await pool(net, async t => {
    if (stopFlag || bail) return;
    try {
      t.vid = await findVid(t);
      if (t.vid) { hits++; fails = 0; }
    } catch (e) {
      if (stopFlag) return;
      fails++;
      if (fails >= bailAt && !hits) bail = true;   // nothing is reachable; stop grinding
    }
    t.tried = true;
    done++;
    status('Matching… ' + done + ' / ' + todo.length + ' · ' + t.title);
    progress(done, todo.length);
  }, width);

  progress();
  if (bail) throw Object.assign(new Error('no search'), { code: 'NOYT' });
}

/* ============================================================
   step 1: get the tracklist
   ============================================================ */
const PL_RE = /(?:open\.)?spotify\.com\/(?:[a-z-]+\/)?(playlist|album)\/([A-Za-z0-9]+)|spotify:(playlist|album):([A-Za-z0-9]+)/;
const TRACK_RE = /(?:open\.)?spotify\.com\/(?:[a-z-]+\/)?track\/([A-Za-z0-9]{8,})|spotify:track:([A-Za-z0-9]{8,})/g;
const SHORT_RE = /https?:\/\/spotify\.link\/[A-Za-z0-9]+/;
const MAX_TRACKS = 188;

/* Trim to the limit and remember how many were left behind, so the run can
   say so instead of quietly dropping them. */
let dropped = 0;
function cap(arr) {
  if (arr.length > MAX_TRACKS) dropped = arr.length - MAX_TRACKS;
  return arr.slice(0, MAX_TRACKS);
}

const mk = (t, a) => ({ title: (t || '').trim(), artist: (a || '').trim(), vid: null, tried: false, q: '' });

async function getTracks(raw) {
  const short = raw.match(SHORT_RE);
  if (short && !PL_RE.test(raw) && !/track\//.test(raw)) {
    status('Following the short link…');
    const html = await relayFetch(short[0], false);
    const canon = html.match(/(?:open\.)?spotify\.com\/(?:[a-z-]+\/)?(playlist|album|track)\/([A-Za-z0-9]+)/);
    if (canon) raw = 'https://open.spotify.com/' + canon[1] + '/' + canon[2];
  }

  const pl = raw.match(PL_RE);
  if (pl) return await fromEmbed(pl[1] || pl[3], pl[2] || pl[4]);

  const ids = []; const seen = new Set(); let m;
  TRACK_RE.lastIndex = 0;
  while ((m = TRACK_RE.exec(raw))) {
    const id = m[1] || m[2];
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  if (ids.length) return await fromTrackLinks(cap(ids));

  const t = parseText(raw);
  return t ? { name: '', tracks: t.tracks } : { name: '', tracks: [] };
}

async function fromEmbed(kind, id) {
  status('Reading the ' + kind + ' from Spotify…');
  const html = await relayFetch('https://open.spotify.com/embed/' + kind + '/' + id, false);
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let items = null, name = '';
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      items = deepFindTracks(data);
      name = deepEntityName(data);
    } catch (e) { /* fall through to the title tag */ }
  }
  if (!name) {
    const tm = html.match(/<title>([^<]*)<\/title>/);
    if (tm) name = tm[1].replace(/\s*[|–-]\s*Spotify.*$/i, '').trim();
  }
  if (!items || !items.length) throw Object.assign(new Error('empty'), { code: 'EMPTY_EMBED' });
  return { name, tracks: cap(items).map(x => mk(x.title, x.subtitle || joinArtists(x.artists))) };
}

const joinArtists = a => Array.isArray(a) ? a.map(x => (x && (x.name || x.title)) || '').filter(Boolean).join(', ') : '';

function deepFindTracks(root) {
  const seen = new Set();
  let best = null;
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 14 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      const isTracks = o.length && o.every(x => x && typeof x === 'object' && typeof x.title === 'string' && ('subtitle' in x || 'artists' in x));
      if (isTracks) {
        if (!best || o.length > best.length) best = o;
        return;                    // no reason to walk every track object
      }
      for (const v of o) walk(v, d + 1);
      return;
    }
    for (const k in o) walk(o[k], d + 1);
  })(root, 0);
  return best;
}
function deepEntityName(data) {
  try {
    const n = data.props.pageProps.state.data.entity.name;
    return typeof n === 'string' ? n : '';
  } catch (e) { return ''; }
}

async function fromTrackLinks(ids) {
  status('Reading ' + ids.length + ' track link' + (ids.length === 1 ? '' : 's') + '…');
  const out = ids.map(() => null);
  let done = 0, fails = 0;
  await pool(ids, async (id, i) => {
    try {
      const d = JSON.parse(await relayFetch('https://open.spotify.com/oembed?url=' + enc('https://open.spotify.com/track/' + id), true));
      if (d && d.title) out[i] = mk(d.title, '');
    } catch (e) { if (e.code === 'NET') fails++; }
    done++;
    status('Reading track links… ' + done + ' / ' + ids.length);
    progress(done, ids.length);
  }, 5);
  progress();
  const got = out.filter(Boolean);
  if (!got.length && fails) throw netErr();
  return { name: '', tracks: got };
}

/* ---------- pasted-text fallback parser ---------- */
const DUR_RE = /^\(?\d{1,3}:\d{2}\)?$/;
const NOISE_RE = /^(#|\d{1,4}|e|explicit|title|track|song|name|artist|album|added.*|duration|time|\d+\s+(day|week|month|year)s?\s+ago)$/i;
const clean = s => s.replace(/\u00a0/g, ' ')
  .replace(/^\s*#?\d{1,4}[.):\-]?\s+/, '')
  .replace(/\s+\(?\d{1,3}:\d{2}\)?\s*$/, '')
  .replace(/\s+/g, ' ').trim();

function splitPair(s) {
  const tabs = s.split('\t').map(x => x.trim()).filter(Boolean);
  if (tabs.length >= 2) return [tabs[0], tabs[1]];
  const d = s.match(/^(.+?)\s+[-\u2013\u2014|\u2022]\s+(.+)$/);
  if (d) return [d[1].trim(), d[2].trim()];
  const b = s.match(/^(.+?)\s+by\s+(.+)$/i);
  if (b) return [b[1].trim(), b[2].trim()];
  return null;
}
const useful = c => c && !NOISE_RE.test(c) && !DUR_RE.test(c);

/* One line in, one track out — or null if the line is a header, an index,
   a duration, or anything else that isn't a song. Handles tab columns and
   plain "Title – Artist" with the same rules. */
function rowToTrack(l) {
  const cells = l.split('\t').map(c => c.trim()).filter(useful);
  if (!cells.length) return null;
  const title = clean(cells[0]);
  if (!title) return null;
  if (cells.length > 1) return mk(title, clean(cells[1]));
  const p = splitPair(title);
  return p ? mk(p[0], p[1]) : mk(title, '');
}

function parseText(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.replace(/\u00a0/g, ' ')).filter(l => l.trim());

  /* A. one row per track, columns split by tabs — spreadsheets, exports,
        and anything copied out of a table. Index / duration / "added"
        columns and the header row all drop out on their own. */
  const rows = lines.filter(l => l.includes('\t'));
  if (rows.length >= 2) {
    const tracks = [];
    for (const l of rows) {
      const t = rowToTrack(l);
      if (t) tracks.push(t);
    }
    if (tracks.length) return { tracks: cap(tracks) };
  }

  /* B. one cell per line, each track ending in its duration — what the
        Spotify web player gives you on a plain select-and-copy. */
  if (lines.filter(l => DUR_RE.test(l.trim())).length >= 3) {
    const tracks = []; let buf = [];
    for (const l of lines) {
      const s = l.trim();
      if (DUR_RE.test(s)) {
        const cells = buf.filter(useful);
        if (cells.length) tracks.push(mk(clean(cells[0]), cells[1] ? clean(cells[1]) : ''));
        buf = [];
      } else buf.push(s);
    }
    if (tracks.length >= 3) return { tracks: cap(tracks) };
  }

  /* C. plain "Title – Artist" or "Title by Artist", one per line. */
  const tracks = [];
  for (const l of lines) {
    const t = rowToTrack(l);
    if (t) tracks.push(t);
  }
  return tracks.length ? { tracks: cap(tracks) } : null;
}

/* ============================================================
   connection check
   ============================================================ */
async function runDiag() {
  status('Checking what\u2019s reachable…');
  const probeUrl = 'https://open.spotify.com/oembed?url=' + enc('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  let sp = false;
  try {
    await Promise.any(RELAYS.map((fn, i) => viaRelay(i, probeUrl)));
    sp = true;
  } catch (e) { /* all relays down */ }

  const n = live.length || await awaitProbe();

  const lines = ['Connection check'];
  lines.push('Spotify via relay: ' + (sp ? 'reachable ✓' : 'blocked ✗'));
  lines.push('YouTube search: ' + n + ' of ' + PROVIDERS.length + ' instances live ' + (n ? '✓' : '✗'));
  if (!sp && !n) {
    lines.push('Nothing gets out from here. If you opened this inside a preview pane, save the three files to a folder and open index.html directly. If you already did, your network is filtering these hosts.');
  } else if (!n) {
    lines.push('Every search instance is down or filtered right now. Try again in a minute — or paste the tracklist as text and use the per-song search links.');
  } else if (!sp) {
    lines.push('The free Spotify relays are busy. Try again shortly, or paste the tracklist as text (Title – Artist per line) — matching still works.');
  }
  notice(lines);
}

/* ============================================================
   result
   ============================================================ */
const ytSearch = t => 'https://www.youtube.com/results?search_query=' + enc((t.title + ' ' + t.artist).trim());
const chunk = (arr, n) => arr.reduce((a, x, i) => { (a[(i / n) | 0] ||= []).push(x); return a; }, []);
const MISS_SHOWN = 60;

function trackRow(t, tag) {
  const li = el('li', tag);
  li.append(t.title || '(untitled)');
  if (t.artist) li.appendChild(el('span', 'a', ' — ' + t.artist));
  li.appendChild(t.vid
    ? link('https://www.youtube.com/watch?v=' + t.vid, 'open ↗')
    : link(ytSearch(t), 'search ↗'));
  return li;
}

function renderResult() {
  const box = D.result;
  box.textContent = '';
  const tracks = state.tracks;
  const hits = tracks.filter(t => t.vid);
  const miss = tracks.filter(t => !t.vid);
  const frag = document.createDocumentFragment();

  const head = el('div', 'big');
  head.append('Found ');
  head.appendChild(el('em', null, String(hits.length)));
  head.append(' of ' + tracks.length + ' on YouTube' + (state.name ? ' — \u201c' + state.name + '\u201d' : ''));
  frag.appendChild(head);

  if (dropped) {
    frag.appendChild(el('p', 'tag', 'This playlist has ' + (tracks.length + dropped)
      + ' tracks. SynceTune handles ' + MAX_TRACKS + ' per run, so the last ' + dropped
      + ' were left out.'));
  }

  if (hits.length) {
    const openers = el('div', 'openers');
    const parts = chunk(hits.map(t => t.vid), 50);
    const urls = parts.map(ids => 'https://www.youtube.com/watch_videos?video_ids=' + ids.join(','));

    if (parts.length > 1) {
      const all = el('button', 'btn btn-primary', 'Open all ' + parts.length + ' parts (' + hits.length + ' songs)');
      all.addEventListener('click', () => {
        // synchronous, inside the click: browsers allow this and at least
        // *offer* to unblock the rest. setTimeout loses the gesture and the
        // extra tabs get killed silently.
        for (const u of urls) window.open(u, '_blank', 'noopener');
        const old = all.textContent;
        all.textContent = 'Opening ' + parts.length + ' tabs — allow pop-ups if blocked';
        setTimeout(() => { all.textContent = old; }, 3000);
      });
      openers.appendChild(all);
    }
    parts.forEach((ids, i) => {
      const a = link(urls[i], parts.length === 1 ? 'Open the playlist on YouTube' : 'Open part ' + (i + 1) + ' (' + ids.length + ' songs)');
      a.className = parts.length === 1 ? 'btn btn-primary' : 'btn';
      openers.appendChild(a);
    });
    frag.appendChild(openers);

    const then = el('p', 'then');
    then.append('In the tab that opens: ');
    then.appendChild(el('b', null, '⋮ → Save playlist'));
    then.append('. That\u2019s it — it shows up in YouTube Music too.');
    frag.appendChild(then);
  }

  if (miss.length) {
    const mw = el('div', 'miss');
    mw.appendChild(el('h3', null, hits.length ? 'Couldn\u2019t match (' + miss.length + ')' : 'Search each song instead'));
    const ul = el('ul');
    miss.slice(0, MISS_SHOWN).forEach(t => {
      const li = el('li');
      li.append(t.title || '(untitled)');
      if (t.artist) li.appendChild(el('span', 'a', ' — ' + t.artist));
      li.appendChild(link(ytSearch(t), 'search ↗'));
      ul.appendChild(li);
    });
    if (miss.length > MISS_SHOWN) ul.appendChild(el('li', 'more', '+ ' + (miss.length - MISS_SHOWN) + ' more — see the full list below'));
    mw.appendChild(ul);
    frag.appendChild(mw);
  }

  // the full list can be 188 rows; only build it if it gets opened
  const det = el('details', 'list');
  det.appendChild(el('summary', null, 'All tracks (' + tracks.length + ')'));
  let built = false;
  det.addEventListener('toggle', () => {
    if (built || !det.open) return;
    built = true;
    const ol = el('ol');
    const rows = document.createDocumentFragment();
    for (const t of tracks) rows.appendChild(trackRow(t, t.vid ? 'ok' : ''));
    ol.appendChild(rows);
    det.appendChild(ol);
  });
  frag.appendChild(det);

  const tools = el('div', 'tools');
  const add = (label, fn) => {
    if (tools.childNodes.length) tools.appendChild(el('span', 'sep', '·'));
    const b = el('button', 'btn-link', label);
    b.addEventListener('click', () => fn(b));
    tools.appendChild(b);
  };
  add('copy list', copyList);
  add('download csv', downloadCsv);
  if (miss.length) add('retry misses', retryMisses);
  add('start over', startOver);
  add('clear cache', b => { clearCache(); flash(b, 'cleared ✓'); });
  frag.appendChild(tools);

  box.appendChild(frag);
  box.hidden = false;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1500);
}

async function retryMisses() {
  startRun();
  busy(true); notice(null);
  for (const t of state.tracks) if (!t.vid) t.tried = false;
  for (const [k, v] of [...cache]) if (!v) cache.delete(k);   // misses only
  live = []; strikes.clear(); probing = null;
  try { await matchAll(state.tracks); } catch (e) { /* reported below */ }
  const hits = state.tracks.filter(t => t.vid).length;
  statusNow('Done — ' + hits + ' of ' + state.tracks.length + ' matched.', hits ? 'ok' : 'err');
  renderResult();
  busy(false);
}

function startOver() {
  stopRun();
  state = { name: '', tracks: [] };
  D.result.hidden = true;
  D.in.value = '';
  statusNow(''); progress(); notice(null);
  D.in.focus();
}

/* ---------- exports ---------- */
const lineOf = t => t.artist ? t.title + ' \u2013 ' + t.artist : t.title;

async function copyList(btn) {
  const text = state.tracks.map(lineOf).join('\n');
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (e) {
    const ta = el('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }
  flash(btn, ok ? 'copied ✓' : 'copy blocked');
}

const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
function downloadCsv() {
  const rows = [['Title', 'Artist', 'YouTube'].map(cell).join(',')].concat(
    state.tracks.map(t => [t.title, t.artist, t.vid ? 'https://www.youtube.com/watch?v=' + t.vid : ''].map(cell).join(','))
  );
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = ((state.name || 'playlist').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'playlist') + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ============================================================
   main flow
   ============================================================ */
async function transfer() {
  const raw = D.in.value.trim();
  if (!raw) { statusNow('Paste a Spotify playlist link first.', 'err'); D.in.focus(); return; }

  startRun();
  ytAnswered = false;
  dropped = 0;
  pinnedRelay = -1;
  directOk = null;
  live = [];
  busy(true);
  D.result.hidden = true;
  notice(null);

  const t0 = performance.now();
  startProbe();          // runs while Spotify loads, so it costs nothing
  try {
    const src = await getTracks(raw);
    if (!src.tracks.length) {
      statusNow('That isn\u2019t a Spotify link or a tracklist. Paste the playlist link, or the songs as text — one "Title – Artist" per line.', 'err');
      busy(false);
      return;
    }
    state.name = src.name;
    state.tracks = src.tracks;
    status('Got ' + src.tracks.length + ' tracks'
      + (src.name ? ' from \u201c' + src.name + '\u201d' : '')
      + (dropped ? ' (first ' + MAX_TRACKS + ' only)' : '') + '…');

    await matchAll(state.tracks);

    const hits = state.tracks.filter(t => t.vid).length;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (stopFlag) statusNow('Stopped — ' + hits + ' matched so far.');
    else if (hits === state.tracks.length) statusNow('All ' + hits + ' matched ✓  ·  ' + secs + 's', 'ok');
    else statusNow(hits + ' of ' + state.tracks.length + ' matched  ·  ' + secs + 's', hits ? 'ok' : 'err');
    renderResult();
  } catch (e) {
    progress();
    if (e.code === 'STOP') statusNow('Stopped.');
    else if (e.code === 'NOYT') {
      statusNow('YouTube search isn\u2019t answering from here.', 'err');
      await runDiag();
      if (state.tracks.length) renderResult();
    } else if (e.code === 'NET') {
      statusNow('Couldn\u2019t reach Spotify — the link is fine, the connection isn\u2019t.', 'err');
      await runDiag();
    } else if (e.code === 'EMPTY_EMBED') {
      statusNow('Spotify returned that playlist empty. If it\u2019s private, make it public for a minute — or paste the tracklist as text.', 'err');
    } else {
      statusNow('Couldn\u2019t read that. Paste the tracklist as text — one "Title – Artist" per line.', 'err');
    }
  }
  busy(false);
}

/* ---------- wiring ---------- */
function init() {
  D.in = document.getElementById('in');
  D.go = document.getElementById('go');
  D.stop = document.getElementById('stop');
  D.status = document.getElementById('status');
  D.bar = document.getElementById('bar');
  D.fill = document.getElementById('barFill');
  D.notice = document.getElementById('netNotice');
  D.result = document.getElementById('result');

  loadCache();

  D.go.addEventListener('click', transfer);
  D.stop.addEventListener('click', () => { stopRun(); status('Stopping…'); });
  D.in.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); transfer(); }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
