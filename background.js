/* Service worker: routes keyboard commands, and looks up subscriber counts.

   Subscriber counts are not in the homepage/search markup at all, so each channel is
   fetched once from its channel page and cached. Fetching here rather than in the content
   script keeps one shared queue and one shared cache across every open YouTube tab. */

/* config.js is gitignored and may be absent in a fresh clone; the index is optional, so a
   missing file must degrade to live search rather than killing the service worker. */
try { importScripts('config.js'); } catch (e) { self.YTCopyConfig = { INDEX_API: '' }; }

/* Said once, at startup, in the service worker console. Whether the index is reachable is
   the single most common thing to be wrong, and until now the only way to find out was to
   read the panel's footnote and infer backwards. */
{
  const cfg = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
  console.log('[YouTube Toolkit] index endpoint: ' +
    (cfg ? cfg.split('/k/')[0] + '/k/…' : 'NOT SET — falling back to YouTube search'));
}
importScripts('format.js');
const F = self.YTCopyFormat;

/* ------------------------------------------------------------------- commands */

const COMMANDS = {
  'toggle-select-mode': 'ytc-toggle-select',
  'copy-selection': 'ytc-copy-selection'
};

chrome.commands.onCommand.addListener(async (command) => {
  const type = COMMANDS[command];
  if (!type) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // tab.url can be empty without host permission; if so, let sendMessage be the test.
  if (tab.url && !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url)) return;
  try {
    // The page is focused for shortcut-driven copies, so the content script clipboards it.
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    /* content script not loaded in this tab yet */
  }
});

/* --------------------------------------------------------------- subscribers */

const TTL_OK = 7 * 24 * 60 * 60 * 1000;   // counts barely move, and YouTube rounds them
const TTL_HIDDEN = 12 * 60 * 60 * 1000;   // channel hides its count: no point retrying soon
const TTL_TRANSIENT = 2 * 60 * 1000;      // throttled or offline: worth retrying shortly
/* The count landed but /about never did, so the totals were never on offer. Keep the count —
   it is correct — and come back for the totals well before the count itself goes stale. */
const TTL_NO_TOTALS = 20 * 60 * 1000;

const MAX_ROUNDS = 3;                      // whole-chain retries before giving up
const BACKOFF = [700, 1800];               // waits between rounds, plus jitter

/* A 429 from fetching a dozen channel pages in a row is a temporary state, not a verdict
   about the channel. Those are worth retrying; a 404 or a genuinely hidden count is not. */
const isTransient = F.isTransientFailure;

function failTtl(reason) {
  return isTransient(reason) ? TTL_TRANSIENT : TTL_HIDDEN;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ACTIVE = 2;                      // be gentle: channel pages are ~1MB each
const GAP_MS = 150;
/* Bumped whenever a parsing bug could have written wrong values: entries from older
   versions are ignored, so a bad count can't outlive the fix that corrects it. */
/* Bump whenever a cached value's MEANING changes, not just its shape. Similar-channel
   results are cached for a week, so six rounds of query fixes were invisible to anyone who
   had already opened the panel once — they kept seeing results built by the old logic. */
const CACHE_VERSION = 15; // niche no longer cached from a single-title guess
                          // (14: analytics sourced from the API, not the videos grid)

const MAX_BYTES = 3000000;      // some channel pages bury the count deep in ytInitialData
/* The /about cap is its own number because the lifetime totals sit at the very END of the
   page — measured at 98-99% through, on every channel checked. A cap that truncates even
   slightly loses them, which showed up as "channel average unavailable" on any channel
   whose about page ran past the old 2MB limit (6 of 8 sampled, up to 2.8MB). */
const ABOUT_BYTES = 5000000;
const OVERLAP = 8000;

let active = 0;
const queue = [];
const inflight = new Map();

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active++;
    job.run().then(job.resolve, job.reject).finally(() => {
      active--;
      setTimeout(pump, GAP_MS);
    });
  }
}

/* Google answers a burst of channel lookups with its "unusual traffic" interstitial: the
   request is redirected to google.com/sorry, which is cross-origin, so the fetch is rejected
   by CORS and every lookup after it fails the same way. Retrying into that makes it worse.

   Detect the pattern from consecutive failures rather than the URL, since a CORS rejection
   never exposes where it landed, and stop making requests for a while. Existing cached
   answers keep working; only new lookups pause. */
const BREAKER_TRIP = 4;              // consecutive failures before backing off
const BREAKER_COOLDOWN_MS = 90000;
let consecutiveFailures = 0;
let breakerUntil = 0;

function noteResult(ok) {
  if (ok) { consecutiveFailures = 0; breakerUntil = 0; return; }
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_TRIP) breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

function breakerOpen() {
  if (!breakerUntil) return false;
  if (Date.now() < breakerUntil) return true;
  // Cooldown over: allow one probe through rather than releasing the whole queue at once.
  breakerUntil = 0;
  consecutiveFailures = BREAKER_TRIP - 1;
  return false;
}

function schedule(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    pump();
  });
}

function channelPath(key) {
  // Keys arrive as "@handle", "channel/UC…", "c/Name", "user/Name", or a bare "UC…" id.
  return key.startsWith('@') || key.includes('/') ? key : 'channel/' + key;
}

/* Read only as far as the subscriber count, then abort — the rest of the page is
   megabytes of data we have no use for. */
async function fetchOnce(key, url, credentials, cap, wantStats) {
  let res;
  try {
    res = await fetch(url, { credentials, headers: { 'Accept-Language': 'en' } });
  } catch (e) {
    return { text: null, reason: 'fetch failed (' + e.message + ')' };
  }
  if (!res.ok) return { text: null, reason: 'HTTP ' + res.status };

  const landed = res.redirected ? ' → ' + new URL(res.url).host + new URL(res.url).pathname : '';

  if (!res.body) {
    const html = await res.text();
    const hit = F.parseSubscribers(html, true, key) || F.parseSubscribers(html, false, key);
    return { text: hit, reason: hit ? '' : 'not in page' + landed, stats: F.parseChannelStats(html) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let read = 0;
  let candidate = null;   // anchored match seen before any header block
  let pendingSubs = null; // count found, still reading for the lifetime totals
  try {
    while (read < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      buf += decoder.decode(value, { stream: true });
      // Header-anchored only while streaming: any other match could be another channel's.
      if (!pendingSubs) pendingSubs = F.parseSubscribers(buf, true, key);
      if (pendingSubs) {
        /* Only /about carries the lifetime totals, so only there is it worth reading past
           the subscriber count to collect them — they sit in the same metadata block, so
           that costs a little more of one page. On every other tab the totals will never
           arrive, and waiting for them would mean streaming the whole document instead of
           aborting the moment the count is in hand. */
        const stats = wantStats ? F.parseChannelStats(buf) : null;
        if (stats || !wantStats) return { text: pendingSubs, reason: '', stats };
      }
      // Hold anything anchored as a fallback in case no header block ever shows up, since
      // the trim below will eventually carry it out of the buffer.
      if (!candidate) candidate = F.parseAnchored(buf);
      if (buf.length > 400000) {
        // Never trim away the channel header — that's the only region we trust — otherwise
        // keep a tail so a match split across chunk boundaries still lands.
        const at = F.headerIndex(buf);
        buf = at >= 0 ? buf.slice(at) : buf.slice(-OVERLAP);
      }
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* already closed */ }
  }
  // The candidate is unverified, so only fall back to it when this page never showed the
  // channel we asked for — otherwise we'd reintroduce exactly the cross-channel mixups.
  const token = F.identityToken(key);
  const sawIdentity = token && buf.toLowerCase().includes(token);
  const hit = F.parseSubscribers(buf, false, key) || pendingSubs || (sawIdentity ? null : candidate);
  return {
    text: hit,
    reason: hit ? '' : 'no count in ' + Math.round(read / 1024) + 'KB' + landed,
    stats: F.parseChannelStats(buf)
  };
}

/* Three shots at a channel, cheapest first. Cookieless keeps the request clean; cookies get
   past the consent interstitial; /about is a smaller page when the home tab is enormous. */
function attempts(key) {
  const base = 'https://www.youtube.com/' + channelPath(key);
  return [
    // /about leads because it is the only tab carrying viewCountText/videoCountText, the
    // lifetime totals the outlier ratio needs — and it is the smallest of the three pages.
    { url: base + '/about?hl=en', credentials: 'include', cap: ABOUT_BYTES, wantStats: true },
    { url: base + '?hl=en', credentials: 'omit', cap: MAX_BYTES },
    { url: base + '?hl=en', credentials: 'include', cap: MAX_BYTES }
  ];
}

async function fetchSubscribers(key) {
  if (breakerOpen()) {
    return { text: null, reason: 'rate limited by YouTube — backing off', stats: null };
  }
  const notes = [];
  let stats = null;
  /* Whether the /about attempt got far enough to answer the question at all. Without it a
     lookup that fell through to the plain channel tab — which never carries the totals — was
     indistinguishable from one that read /about in full and found none there, and both were
     cached as "this channel publishes no totals" for twelve hours. */
  let aboutRead = false;
  for (const a of attempts(key)) {
    const out = await fetchOnce(key, a.url, a.credentials, a.cap, a.wantStats);
    // Only /about carries the totals, so a later attempt that finds the count must not
    // discard what the first attempt already learned.
    if (a.wantStats && out.text) aboutRead = true;
    if (out.stats && !stats) stats = out.stats;
    if (out.text) { noteResult(true); return { ...out, stats: out.stats || stats, aboutRead }; }
    notes.push((a.credentials === 'omit' ? 'plain' : a.url.includes('/about') ? 'about' : 'cookies') +
      ': ' + out.reason);
  }
  noteResult(false);
  return { text: null, reason: notes.join(' | '), stats, aboutRead };
}

async function readCache(key) {
  const id = 'subs:' + key;
  const store = await chrome.storage.local.get(id);
  const hit = store[id];
  if (!hit || hit.v !== CACHE_VERSION) return null;
  /* A count with no lifetime totals has two very different causes and they were sharing one
     twelve-hour TTL. Read /about in full and found none: the channel does not publish them,
     so there is no point asking again soon. Never got through to /about and took the count
     off another tab, which never carries them: that is a transient miss, and holding it for
     half a day is what left the Outlier cell empty for the rest of the day on a channel whose
     totals were there all along. */
  const ttl = hit.text
    ? (hit.stats ? TTL_OK : (hit.aboutRead ? TTL_HIDDEN : TTL_NO_TOTALS))
    : failTtl(hit.reason);
  return Date.now() - hit.t > ttl ? null : hit;
}

/* Most failures here are transient — YouTube throttling a burst of channel lookups, or a
   consent redirect under load — so retry the whole chain a couple of times with backoff
   before showing the user a badge they have to click. Each round is scheduled separately so
   the queue slot is released while we wait, rather than blocking other channels. */
async function lookupWithRetry(key) {
  let out = { text: null, reason: 'no attempt' };
  let used = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    used = round;
    out = await schedule(() => fetchSubscribers(key));
    if (out.text) {
      return round > 1 ? { ...out, reason: 'ok after ' + round + ' tries' } : out;
    }
    if (!isTransient(out.reason)) break;
    if (round < MAX_ROUNDS) await sleep(BACKOFF[round - 1] + Math.random() * 400);
  }
  return { ...out, reason: out.reason + (used > 1 ? ' (gave up after ' + used + ' tries)' : '') };
}

async function getSubscribers(key, force) {
  const cached = force ? null : await readCache(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const job = lookupWithRetry(key)
    .catch((e) => ({ text: null, reason: 'failed: ' + e.message }))
    .then(async (out) => {
      const entry = {
        text: out.text || null,
        reason: out.reason || '',
        stats: out.stats || null,
        aboutRead: !!out.aboutRead,
        t: Date.now(),
        v: CACHE_VERSION
      };
      await chrome.storage.local.set({ ['subs:' + key]: entry });
      inflight.delete(key);
      return entry;
    });

  inflight.set(key, job);
  return job;
}

/* ---------------------------------------------------------------- monetization */

/* Inferred, not published. See F.monetizationVerdict for why one positive settles it and
   negatives never do.

   Cost control matters here because this is the only feature that fetches watch pages:
     - Stop at the first video with ad placements, so a monetized channel usually costs one.
     - Abort each probe once ytInitialPlayerResponse is complete. adPlacements lives inside
       it (~750KB in), and ytInitialData always follows it (~800KB), so seeing ytInitialData
       means the answer is settled either way — no reason to read the remaining ~500KB.
     - Cache per channel, since a channel's Partner Program status barely changes. */
/* Ad revenue through the Partner Program requires 1,000 subscribers (plus watch hours we
   cannot see). Below that a channel cannot be running ads for its own benefit no matter what
   the player says — YouTube may still serve ads against its videos and keep the revenue,
   which is exactly the false positive the ad signal alone walks into. So the count is checked
   first, and a channel under the bar is answered without fetching a single watch page.
   (A 500-subscriber tier exists for memberships and Super Thanks, but not for ads.) */
const YPP_MIN_SUBS = 1000;
const MON_SAMPLE = 3;              // videos to try before concluding "no ads found"
const MON_BYTES = 1400000;         // ceiling per probe; the stop marker normally hits first
const TTL_MON = 7 * 24 * 60 * 60 * 1000;
const TTL_MON_UNKNOWN = 6 * 60 * 60 * 1000;   // a failed sample is worth retrying sooner

async function recentVideoIds(key, limit) {
  const url = 'https://www.youtube.com/' + channelPath(key) + '/videos?hl=en';
  let res;
  try {
    res = await fetch(url, { credentials: 'include', headers: { 'Accept-Language': 'en' } });
  } catch (e) {
    return [];
  }
  if (!res.ok) return [];
  const html = await res.text();
  const ids = [];
  const seen = new Set();
  // The grid moved to lockupViewModel, whose contentId is the video id.
  const re = /"contentId":"([\w-]{11})"/g;
  let m;
  while ((m = re.exec(html)) && ids.length < limit) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  return ids;
}

async function adSignalFor(videoId) {
  let res;
  try {
    res = await fetch('https://www.youtube.com/watch?v=' + videoId + '&hl=en',
      { credentials: 'include', headers: { 'Accept-Language': 'en' } });
  } catch (e) {
    return null;
  }
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let read = 0;
  try {
    while (read < MON_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      buf += decoder.decode(value, { stream: true });
      /* Both markers, not just the first. Stopping at adPlacements often cut the buffer
         before shortDescription arrived, and the description is where every revenue stream
         other than ads is read from — so the early exit was quietly costing the feature its
         evidence. */
      if (buf.indexOf('"adPlacements"') >= 0 && buf.indexOf('"shortDescription"') >= 0) break;
      if (buf.indexOf('ytInitialData') >= 0) break;         // player response closed: settled
    }
  } catch (e) {
    return null;
  } finally {
    try { await reader.cancel(); } catch (e) { /* already closed */ }
  }
  /* The ad counts stay at the top level so monetizationVerdict keeps reading them where it
     always has; the revenue streams ride alongside. */
  const rev = F.revenueSignals(buf);
  const ads = (rev && rev.ads) || F.adSignalFromHtml(buf);
  if (!ads) return null;
  return Object.assign({}, ads, {
    declaredPaid: !!(rev && rev.declaredPaid),
    streams: (rev && rev.streams) || {}
  });
}

async function getMonetization(key, force) {
  const id = 'mon:' + key;
  if (!force) {
    const store = await chrome.storage.local.get(id);
    const hit = store[id];
    if (hit && hit.v === CACHE_VERSION) {
      const ttl = hit.state === 'unknown' ? TTL_MON_UNKNOWN : TTL_MON;
      if (Date.now() - hit.t <= ttl) return hit;
    }
  }

  /* Eligibility gate. getSubscribers is cached, so this is usually free, and when it rules
     the channel out it saves three watch-page fetches as well as giving a definite answer
     instead of an estimate. */
  const subsEntry = await getSubscribers(key);
  const subs = subsEntry && subsEntry.text ? F.viewsToNumber(subsEntry.text) : null;
  if (subs !== null && subs < YPP_MIN_SUBS) {
    const entry = { state: 'not-eligible', checked: 0, withAds: 0, subs, t: Date.now(), v: CACHE_VERSION };
    await chrome.storage.local.set({ [id]: entry });
    return entry;
  }

  if (breakerOpen()) {
    // Do not cache a rate-limited miss as a verdict; leave it unknown and short-lived.
    return { state: 'unknown', checked: 0, withAds: 0, t: 0, v: CACHE_VERSION };
  }

  const ids = await recentVideoIds(key, MON_SAMPLE);
  const samples = [];
  for (const vid of ids) {
    // Every sample is needed now. The old loop stopped at the first video carrying a
    // placement, which is exactly what let a demonetized channel read as monetized off a
    // single forecasting slot — a ratio cannot be computed from a partial sample.
    const signal = await schedule(() => adSignalFor(vid));
    if (signal) samples.push(signal);
  }

  const verdict = F.monetizationVerdict(samples);
  const entry = {
    state: verdict.state,
    checked: verdict.checked,
    withAds: verdict.withAds,
    streams: F.revenueSummary(samples),
    subs,
    t: Date.now(),
    v: CACHE_VERSION
  };
  await chrome.storage.local.set({ [id]: entry });
  return entry;
}

/* ------------------------------------------------------------ similar channels */

/* Search, not recommendations. YouTube's search results answer a query, so they are topical
   by construction; the watch-page recommendation sidebar is contaminated with generic and
   personalised picks that no ranking can separate (a car channel's sidebar returned
   @LiverpoolFC and @redbull in the top five). Measured on the same channels, search returned
   @TopGear, @DougDeMuro and @ThrottleHouse for cars, and @KingsandGenerals and
   @FreeDocumentaryHistory for history.

   Two search pages per channel, cached for a week. The titles come from the page the user is
   already looking at, so nothing is fetched to build the queries. */
/* Three, not two. With two the result sets came back disjoint, so nothing was ever confirmed
   by more than one topic and the ranking degraded to concatenating them — which is how
   general-interest channels stayed near the top. A third query gives the overlap something to
   happen in. */
const SIM_QUERIES = 3;
const SIM_BYTES = 2500000;
const TTL_SIM = 7 * 24 * 60 * 60 * 1000;
/* An empty result is usually a transient failure — a rate-limited fetch, a dropped
   connection — not a fact about the channel. Caching that for a week would show "nothing
   found" until the entry expired, with no way to ask again. */
const TTL_SIM_EMPTY = 30 * 60 * 1000;

async function searchPage(query) {
  const url = 'https://www.youtube.com/results?hl=en&search_query=' + encodeURIComponent(query);
  let res;
  try {
    res = await fetch(url, { credentials: 'include', headers: { 'Accept-Language': 'en' } });
  } catch (e) {
    return null;
  }
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let read = 0;
  try {
    while (read < SIM_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      buf += decoder.decode(value, { stream: true });
      // Results live in ytInitialData; everything after it is player and layout config.
      if (buf.indexOf('var ytInitialData') >= 0 && read > 900000) break;
    }
  } catch (e) {
    return null;
  } finally {
    try { await reader.cancel(); } catch (e) { /* already closed */ }
  }
  return buf;
}

/* A watch page, read only as far as its recommendation data.

   Shares searchPage's shape and its byte cap: the interesting part is near the top and the
   rest is player configuration, so there is no reason to pull megabytes of it. */
async function watchPage(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) + '&hl=en';
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', headers: { 'Accept-Language': 'en' } });
  } catch (e) {
    return null;
  }
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let read = 0;
  try {
    while (read < SIM_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      buf += decoder.decode(value, { stream: true });
      if (buf.indexOf('var ytInitialData') >= 0 && read > 900000) break;
    }
  } catch (e) {
    return null;
  } finally {
    try { await reader.cancel(); } catch (e) { /* already closed */ }
  }
  return buf;
}

/* Repair a thin niche at the moment it shows itself to be thin.

   The crawler does this from a command line, on a schedule, for channels nobody is currently
   looking at. This does it for the one channel someone is looking at right now, and only when
   the panel has just admitted the results are weak — so the effort lands exactly where the
   index is short, and a well-covered niche costs nothing at all.

   Three watch pages, once per channel per session, behind the same limiter and breaker as
   every other scrape. The viewer whose visit triggers it sees the benefit on a refresh; the
   next person sees it immediately. */
async function expandNiche(key, videos) {
  const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
  if (!base || !key || !videos || !videos.length) return { ok: false };
  if (breakerOpen()) return { ok: false, reason: 'rate limited' };

  const pairs = [];
  const seen = new Set();
  for (const id of videos.slice(0, 3)) {
    const html = await schedule(() => watchPage(id));
    if (!html) continue;
    for (const p of F.channelPairsFromSearch(html, 40)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      pairs.push(p);
    }
  }
  noteResult(pairs.length > 0);
  if (!pairs.length) return { ok: false, reason: 'nothing found' };

  // Both halves: the channels themselves, and the fact that they sit beside this one.
  pushToIndex(base, pairs);
  fetch(base.replace(/\/$/, '') + '/edges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: key, targets: pairs.map((p) => p.handle).slice(0, 40) })
  }).catch(() => { /* the panel is unaffected */ });

  return { ok: true, found: pairs.length };
}

/* The index, when one is configured.

   Scored by topic rather than by who ranks, which is the whole difference: a channel with
   1,780 subscribers comes back at 66% similarity next to channels a thousand times its size,
   and no amount of searching would ever have surfaced it.

   The channel's own text goes with the request so a channel nobody has crawled yet still gets
   an answer — the server embeds what it is given rather than trying to fetch the channel,
   which from a datacenter IP would mostly be refused. */
async function similarFromIndex(base, key, titles, about, opts) {
  const url = base.replace(/\/$/, '') + '/similar';
  const body = {
    channel: key,
    channelId: (opts && opts.channelId) || null,
    title: (opts && opts.title) || '',
    about: about || '',
    videoTitles: (titles || []).slice(0, 10),
    /* 50, not 25. The filter chips narrow this set client-side, and a chip like "new channels"
       has nothing to bite on if the fetch already cut the list short. Costs one DB query
       either way. */
    limit: 50,
    minSubs: (opts && opts.minSubs) || null,
    maxSubs: (opts && opts.maxSubs) || null,
    /* 0.35, not 0.45. Two horror-film channels scored 0.449 against each other and were
       hidden from both lists — a cliff edge deciding between "closely related" and "does not
       exist". The panel already prints each score and warns when the best is weak, so a
       borderline neighbour is better shown with its number than silently dropped. */
    minSimilarity: 0.35
  };
  /* Two attempts, because a free-tier instance sleeps when idle. Waking it takes upwards of
     50 seconds, and while it wakes the CORS preflight itself fails — the browser blocks the
     request before it is sent, so the fetch throws rather than returning a status, and no
     timeout can help. The first attempt is what wakes it; the second usually lands. */
  for (const attempt of [1, 2]) {
    const controller = new AbortController();
    // 90s: Render warns the first request after a spin-down can take 50 seconds or more.
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      // A status is a real answer — the URL is wrong, or the token is. Retrying cannot fix it.
      if (!res.ok) return { ok: false, reason: 'index ' + res.status };
      return await res.json();
    } catch (e) {
      if (attempt === 2) {
        return { ok: false, reason: 'index unreachable — check the URL includes /k/<token>' };
      }
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      clearTimeout(timer);
    }
  }
}

/* Hand channels to the index without waiting. Never allowed to delay or break the answer
   being returned now — a failed ingest costs the corpus one row, not the user their panel. */
/* Cached briefly rather than not at all: the panel re-renders on every scan, and the series
   only moves when the sampler runs. Short, because the whole point is that it is live. */
const TTL_SERIES = 5 * 60 * 1000;

async function keywordSeries(keyword, hours) {
  const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
  if (!base) return { ok: false, reason: 'no index' };
  const id = 'kw:' + keyword + ':' + (hours || 168);
  const store = await chrome.storage.local.get(id);
  const hit = store[id];
  if (hit && hit.v === CACHE_VERSION && Date.now() - hit.t <= TTL_SERIES) return hit;
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/keyword-series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, hours: hours || 168 })
    });
    if (!res.ok) return { ok: false, reason: 'series ' + res.status };
    const out = await res.json();
    const entry = Object.assign({}, out, { t: Date.now(), v: CACHE_VERSION });
    await chrome.storage.local.set({ [id]: entry });
    return entry;
  } catch (e) {
    return { ok: false, reason: 'series unreachable' };
  }
}

function pushToIndex(base, pairs) {
  if (!base || !pairs || !pairs.length) return;
  fetch(base.replace(/\/$/, '') + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels: pairs.slice(0, 40) })
  }).catch(() => { /* the answer above is unaffected */ });
}

const TTL_ANALYTICS = 12 * 60 * 60 * 1000;    // upload counts and view totals move daily-ish

/* Everything the analytics panel shows, from one page fetch plus two lookups it already had.
   Assembled here rather than in the panel so the numbers are computed once and cached
   together — a panel that recomputed on every open would refetch the channel each time. */
async function getAnalytics(key, force) {
  const id = 'stats:' + key;
  if (!force) {
    const store = await chrome.storage.local.get(id);
    const hit = store[id];
    if (hit && hit.v === CACHE_VERSION && Date.now() - hit.t <= TTL_ANALYTICS) return hit;
  }
  if (breakerOpen()) return { ok: false, reason: 'rate limited' };

  const [subs, niche] = await Promise.all([getSubscribers(key), getNiche(key, {})]);

  /* The channel's uploads through the index service, which holds the API key. Scraping the
     videos grid was tried first and failed twice: the markup moved to a renderer the parser
     did not know, and the fetch is rate-limited by IP in any case. Two quota units returns
     durations the grid only renders as text. */
  let videos = [];
  let videosOk = false;
  const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
  if (base) {
    try {
      const res = await fetch(base.replace(/\/$/, '') + '/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: key })
      });
      if (res.ok) {
        const out = await res.json();
        if (out && out.ok) {
          videosOk = true;
          videos = (out.videos || []).map((v) => ({
            id: v.id,
            title: v.title || '',
            seconds: v.seconds || null,
            views: v.views == null ? null : v.views,
            publishedAt: v.publishedAt || '',
            // The API has no shorts flag. Under a minute is the practical test.
            shorts: !!v.seconds && v.seconds <= 60
          }));
        }
      }
    } catch (e) { /* leave videosOk false; the panel says so */ }
  }

  const entry = {
    ok: true,
    subs: subs && subs.text ? F.viewsToNumber(subs.text) : null,
    stats: (subs && subs.stats) || null,
    niche: niche && niche.ok ? { label: niche.niche, rpm: niche.rpm, z: niche.z } : null,
    videos: videos.slice(0, 60),
    videosOk: videosOk,
    t: Date.now(),
    v: CACHE_VERSION
  };
  await chrome.storage.local.set({ [id]: entry });
  return entry;
}

const TTL_NICHE = 30 * 24 * 60 * 60 * 1000;   // a channel's subject does not drift weekly
const TTL_NICHE_MISS = 24 * 60 * 60 * 1000;   // a refusal is worth rechecking sooner than that

async function getNiche(key, opts) {
  const id = 'niche:' + key;
  const store = await chrome.storage.local.get(id);
  const hit = store[id];
  if (hit && hit.v === CACHE_VERSION && Date.now() - hit.t <= TTL_NICHE) return hit;

  const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
  if (!base) return { ok: false, reason: 'no index' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/niche', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: key,
        title: opts.title || '',
        about: opts.about || '',
        videoTitles: (opts.videoTitles || opts.titles || []).slice(0, 10)
      }),
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, reason: 'niche ' + res.status };
    const out = await res.json();
    /* Only an answer built from the channel's own stored vector is worth keeping. A hit on a
       channel that is not indexed yet was classified from a single video title — the same
       thin signal the refusal below refuses to cache, and no sounder for having cleared the
       floor instead of falling under it. Titles scatter badly within one channel: on a
       boxing channel "KNOCKOUT POWER" reads as combat sports, "ANARCHY IN ATLANTA" as legal
       commentary and "The Food Stamps King Fights For Glory" as challenges. Caching whichever
       one happened to be opened first pinned that guess to the channel for thirty days, long
       after ingestion had built the real vector — which is how a boxing channel came to be
       priced as basketball. Return it, because a provisional rate beats the flat band, but do
       not store it. */
    if (out && out.ok) {
      if (!out.indexed) return out;
      const entry = Object.assign({}, out, { t: Date.now(), v: CACHE_VERSION });
      await chrome.storage.local.set({ [id]: entry });
      return entry;
    }
    /* Only a refusal about a channel the index actually holds is worth keeping. A miss on a
       channel that is not indexed yet is a "not yet", not a "no": the first visit asks before
       ingestion has finished, so the answer came from one video title, which is a thin enough
       signal to fall under the floor on its own. Caching that would hide the real
       classification for a day — a cooking channel scored 0.485 from its own vector and 0.357
       from a single title. */
    if (out && out.reason && out.indexed) {
      const entry = Object.assign({}, out, { t: Date.now() - TTL_NICHE + TTL_NICHE_MISS,
                                             v: CACHE_VERSION });
      await chrome.storage.local.set({ [id]: entry });
    }
    return out || { ok: false };
  } catch (e) {
    return { ok: false, reason: 'niche unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function getSimilarChannels(key, titles, about, force, opts) {
  // Baked in at build time. Users were never in a position to know this value, and asking
  // them for it in the popup made an internal detail look like a setting.
  const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
  let indexProblem = '';

  /* The index answers differently depending on the filters, so its results are not cached
     here — the server holds the corpus, and a cached list would go stale the moment the
     filter changed. The search fallback below is cached, because each lookup there costs two
     page fetches. */
  /* The channel being looked at is the one channel we know is real, is current, and someone
     cares about — and it was the only one never being added. Ingest ran solely on the search
     fallback, and only for channels search turned up, so visiting Bellator taught the index
     nothing about Bellator: its niche stayed one-sided, and UFC could not find it back. */
  if (base && key.startsWith('@')) {
    pushToIndex(base, [{ id: (opts && opts.channelId) || '', handle: key }]);
  }

  if (base) {
    const out = await similarFromIndex(base, key, titles, about, opts);
    /* An empty index answer is not an answer. The index only knows the niches that have been
       seeded, so a channel from an unseeded one matches nothing above the similarity floor —
       Law&Crime against an index holding only aviation channels returns zero rows, correctly,
       and showing "nothing found" would be wrong when a live search would have found plenty.
       Treat empty as a miss and fall through. */
    if (out && out.ok && (out.channels || []).length) {
      return {
        channels: (out.channels || []).map((c) => ({
          handle: c.handle || c.title,
          title: c.title,
          avatar: c.avatar_url,
          similarity: c.similarity,
          subscribers: c.subscribers,
          avgViews: c.avg_views,
          uploadsPerMo: c.uploads_per_mo,
          lastUpload: c.last_upload_at,
          publishedAt: c.published_at,
          videoCount: c.video_count
        })),
        source: 'index',
        indexed: !!out.indexed,
        queries: [],
        reason: '',
        t: Date.now(),
        v: CACHE_VERSION
      };
    }
    /* Falling back keeps the panel useful, but silently swapping to a weaker source taught
       the user nothing — a URL missing its /k/<token> prefix answers 404, and the panel just
       quietly showed search results instead. Carry the reason through so the panel can say
       what happened. */
    indexProblem = (out && out.ok)
      ? 'no match in the index yet — this niche has not been seeded'
      : ((out && out.reason) || 'index unavailable');
  }

  const id = 'sim:' + key;
  if (!force) {
    const store = await chrome.storage.local.get(id);
    const hit = store[id];
    const ttl = hit && hit.channels && hit.channels.length ? TTL_SIM : TTL_SIM_EMPTY;
    if (hit && hit.v === CACHE_VERSION && Date.now() - hit.t <= ttl) return hit;
  }
  if (breakerOpen()) return { channels: [], queries: [], reason: 'rate limited', t: 0, v: CACHE_VERSION };

  const queries = F.topicQueries(titles || [], key, SIM_QUERIES, about);
  if (!queries.length) {
    return { channels: [], queries: [], reason: 'not enough video titles to search with', t: 0, v: CACHE_VERSION };
  }

  const perQuery = [];
  const discovered = [];
  for (const q of queries) {
    const html = await schedule(() => searchPage(q));
    if (!html) continue;
    perQuery.push(F.channelsFromSearch(html, key));
    // The same scrape already contains the ids the index needs. Throwing them away was why
    // an unseeded niche stayed unseeded no matter how many people looked at it.
    for (const pair of F.channelPairsFromSearch(html)) discovered.push(pair);
  }
  noteResult(perQuery.length > 0);

  /* Hand the discovery to the index. The extension can scrape search because it runs on a
     residential connection; the server cannot, but it holds the keys to enrich and embed.
     Fire-and-forget — this fills the niche for whoever looks next, and must never delay or
     break the answer being given now. */
  pushToIndex(base, discovered);

  const channels = F.rankSimilar(perQuery, 25);
  const entry = { channels, queries, source: 'search', reason: '',
                  indexProblem: indexProblem, t: Date.now(), v: CACHE_VERSION };
  await chrome.storage.local.set({ [id]: entry });
  return entry;
}

/* ---------------------------------------------------------------- thumbnails */

/* maxres only exists for videos uploaded with a big enough thumbnail, and YouTube 404s
   rather than falling back, so walk down until one resolves. */
const THUMB_SIZES = ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault'];

async function thumbnailUrl(id) {
  for (const size of THUMB_SIZES) {
    const url = 'https://i.ytimg.com/vi/' + id + '/' + size + '.jpg';
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return url;
    } catch (e) {
      /* try the next size down */
    }
  }
  return null;
}

async function downloadThumbnail(video) {
  if (!video || !video.id) return { ok: false, reason: 'no video id' };
  const url = await thumbnailUrl(video.id);
  if (!url) return { ok: false, reason: 'no thumbnail found' };

  const filename = 'yt-thumbnails/' + F.safeFilename(video.title, video.id, 'jpg');
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    return { ok: true, filename };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ---------------------------------------------------------------- transcript */

/* Fallback only: the content script tries first from the page's own origin, which InnerTube
   accepts. This path exists for when that isn't possible. */
/* ---------------------------------------------------------------- captions */

/* Whether a video's transcript mentions a term.
 *
 * The reference tool reports this as "Captions n/20" and it is the relevance signal titles
 * cannot give: a video called "Nolan Wells: New Developments" may spend four minutes on the
 * preliminary autopsy report without either word reaching its title. On a long-tail search
 * that is the difference between four real results and a page written off as padding.
 *
 * It is expensive and so it is never automatic. Captions are only reachable from a real
 * session — the InnerTube player endpoint answers a server with a stripped response carrying
 * no caption tracks at all — so each video costs a ~1.3MB watch page, about 27MB for a sample
 * of twenty. That is a cost the reader chooses per keyword, not one every search pays.
 *
 * The transcript is cached rather than the answer, so asking about a second term on the same
 * results costs nothing. Truncated because the cache is shared with everything else the
 * extension stores and a long interview transcript is a quarter of a megabyte on its own. */
const TTL_CAPTIONS = 7 * 24 * 60 * 60 * 1000;   // a video's words do not change
const CAPTION_CHARS = 60000;                    // ~10k words: far past where a term would sit
const CAPTION_MAX = 25;                         // ceiling per request, whatever is asked for

async function captionText(id) {
  const key = 'cap:' + id;
  const store = await chrome.storage.local.get(key);
  const hit = store[key];
  if (hit && hit.v === CACHE_VERSION && Date.now() - hit.t <= TTL_CAPTIONS) return hit.text;

  let text = '';
  try {
    const out = await F.loadTranscript(id, fetch);
    if (out && out.ok) {
      text = (out.segments || []).map((seg) => seg.text || '').join(' ')
        .replace(/\s+/g, ' ').trim().slice(0, CAPTION_CHARS).toLowerCase();
    }
  } catch (e) { /* a video without captions is an answer, not a failure */ }
  // Stored even when empty: "this one has no usable transcript" is worth not re-fetching.
  await chrome.storage.local.set({ [key]: { text, t: Date.now(), v: CACHE_VERSION } });
  return text;
}

/* Whole words, matching how the panel counts a title — "wells" must not be found inside
   "farewells", or the count would flatter every term with a common syllable in it. */
function captionsMention(text, words) {
  if (!text || !words.length) return false;
  const hay = ' ' + text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
  return words.every((w) => hay.indexOf(' ' + w + ' ') >= 0);
}

async function captionMatches(ids, words) {
  const wanted = (ids || []).filter((v) => typeof v === 'string').slice(0, CAPTION_MAX);
  const hits = [];
  let withCaptions = 0;
  /* Serial on purpose. Each of these is a megabyte-plus page, and the subscriber lookups run
     through their own queue on the same connection — firing twenty at once is how the
     rate-limit breaker trips and every other feature goes dark with it. */
  for (const id of wanted) {
    const text = await captionText(id);
    if (text) withCaptions++;
    if (captionsMention(text, words)) hits.push(id);
  }
  return { ok: true, checked: wanted.length, withCaptions, hits };
}

async function transcriptFor(id) {
  const out = await F.loadTranscript(id, fetch);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ytc-subs' && msg.key) {
    getSubscribers(msg.key, msg.force)
      .then((entry) => sendResponse({
        key: msg.key, text: entry.text, reason: entry.reason, stats: entry.stats || null
      }))
      .catch((e) => sendResponse({ key: msg.key, text: null, reason: String(e) }));
    return true;
  }
  if (msg.type === 'ytc-monetization' && msg.key) {
    getMonetization(msg.key, msg.force)
      .then((entry) => sendResponse(entry))
      .catch((e) => sendResponse({ state: 'unknown', checked: 0, reason: String(e) }));
    return true;
  }
  /* Visiting a channel is the signal; opening the panel is not. Ingest used to ride along
     with the similarity request, so a channel only entered the index if someone happened to
     click the tab there — three horror channels were opened and only the two whose tab was
     used got indexed. */
  if (msg.type === 'ytc-seen' && msg.key) {
    (async () => {
      const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
      if (base && msg.key.startsWith('@')) {
        pushToIndex(base, [{ id: msg.channelId || '', handle: msg.key }]);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  /* Free graph growth: the extension saw these side by side on a page the viewer opened
     anyway, so there is nothing to fetch and nothing to rate limit. */
  if (msg.type === 'ytc-edges' && msg.source) {
    const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
    if (base) {
      fetch(base.replace(/\/$/, '') + '/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: msg.source,
          sourceId: msg.sourceId || '',
          targets: (msg.targets || []).slice(0, 30),
          videos: (msg.videos || []).slice(0, 30)
        })
      }).catch(() => { /* the page is unaffected either way */ });
    }
    sendResponse({ ok: true });
    return true;
  }
  /* Free again: the ids come off a search page the user opened anyway, so registering a
     keyword costs no fetch here and no search scraping on the server. */
  if (msg.type === 'ytc-keyword-seen' && msg.keyword) {
    const base = ((self.YTCopyConfig && self.YTCopyConfig.INDEX_API) || '').trim();
    if (base) {
      fetch(base.replace(/\/$/, '') + '/keyword-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: msg.keyword, videos: (msg.videos || []).slice(0, 50) })
      }).catch(() => { /* the panel is unaffected either way */ });
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ytc-keyword-series' && msg.keyword) {
    keywordSeries(msg.keyword, msg.hours)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'ytc-expand' && msg.key) {
    expandNiche(msg.key, msg.videos || [])
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  /* Cached hard: a channel's niche does not change between videos, and the classification is
     the same vector comparison every time. */
  if (msg.type === 'ytc-analytics' && msg.key) {
    getAnalytics(msg.key, msg.force)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg.type === 'ytc-niche' && msg.key) {
    getNiche(msg.key, msg.opts || {})
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'ytc-similar' && msg.key) {
    getSimilarChannels(msg.key, msg.titles, msg.about, msg.force, msg.opts)
      .then(sendResponse)
      .catch((e) => sendResponse({ channels: [], queries: [], reason: String(e) }));
    return true;
  }
  if (msg.type === 'ytc-thumbs') {
    const videos = msg.videos || [];
    Promise.all(videos.map(downloadThumbnail)).then((results) => {
      const saved = results.filter((r) => r.ok).length;
      sendResponse({ saved, failed: results.length - saved });
    });
    return true;
  }
  if (msg.type === 'ytc-captions' && Array.isArray(msg.videos)) {
    captionMatches(msg.videos, msg.words || [])
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg.type === 'ytc-transcript') {
    transcriptFor(msg.id)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }
  if (msg.type === 'ytc-save-text') {
    // data: URL rather than a blob — a content script's blob URL isn't reachable from here.
    const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(msg.text || '');
    chrome.downloads
      .download({ url, filename: 'yt-transcripts/' + msg.filename, conflictAction: 'uniquify' })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }
  if (msg.type === 'ytc-clear-subs') {
    chrome.storage.local.get(null).then((all) => {
      // Every cache the extension owns. This used to clear only subs:, leaving the
      // monetization and similar-channel entries unreachable from the popup that claims
      // to clear the cache.
      const keys = Object.keys(all).filter((k) =>
        k.startsWith('subs:') || k.startsWith('mon:') || k.startsWith('sim:') ||
        k.startsWith('kw:') || k.startsWith('cap:'));
      chrome.storage.local.remove(keys).then(() => sendResponse({ cleared: keys.length }));
    });
    return true;
  }
});
