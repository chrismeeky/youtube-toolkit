/* Service worker: routes keyboard commands, and looks up subscriber counts.

   Subscriber counts are not in the homepage/search markup at all, so each channel is
   fetched once from its channel page and cached. Fetching here rather than in the content
   script keeps one shared queue and one shared cache across every open YouTube tab. */

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
const CACHE_VERSION = 4;

const MAX_BYTES = 3000000;      // some channel pages bury the count deep in ytInitialData
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
async function fetchOnce(key, url, credentials, cap) {
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
    return { text: hit, reason: hit ? '' : 'not in page' + landed };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let read = 0;
  let candidate = null;   // anchored match seen before any header block
  try {
    while (read < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      buf += decoder.decode(value, { stream: true });
      // Header-anchored only while streaming: any other match could be another channel's.
      const hit = F.parseSubscribers(buf, true, key);
      if (hit) return { text: hit, reason: '' };
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
  const hit = F.parseSubscribers(buf, false, key) || (sawIdentity ? null : candidate);
  return { text: hit, reason: hit ? '' : 'no count in ' + Math.round(read / 1024) + 'KB' + landed };
}

/* Three shots at a channel, cheapest first. Cookieless keeps the request clean; cookies get
   past the consent interstitial; /about is a smaller page when the home tab is enormous. */
function attempts(key) {
  const base = 'https://www.youtube.com/' + channelPath(key);
  return [
    { url: base + '?hl=en', credentials: 'omit', cap: MAX_BYTES },
    { url: base + '?hl=en', credentials: 'include', cap: MAX_BYTES },
    { url: base + '/about?hl=en', credentials: 'include', cap: 2000000 }
  ];
}

async function fetchSubscribers(key) {
  const notes = [];
  for (const a of attempts(key)) {
    const out = await fetchOnce(key, a.url, a.credentials, a.cap);
    if (out.text) return out;
    notes.push((a.credentials === 'omit' ? 'plain' : a.url.includes('/about') ? 'about' : 'cookies') +
      ': ' + out.reason);
  }
  return { text: null, reason: notes.join(' | ') };
}

async function readCache(key) {
  const id = 'subs:' + key;
  const store = await chrome.storage.local.get(id);
  const hit = store[id];
  if (!hit || hit.v !== CACHE_VERSION) return null;
  const ttl = hit.text ? TTL_OK : failTtl(hit.reason);
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
      const entry = { text: out.text || null, reason: out.reason || '', t: Date.now(), v: CACHE_VERSION };
      await chrome.storage.local.set({ ['subs:' + key]: entry });
      inflight.delete(key);
      console.log('[YT Copy] %s -> %s', key, entry.text || 'NOT FOUND — ' + entry.reason);
      return entry;
    });

  inflight.set(key, job);
  return job;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ytc-subs' && msg.key) {
    getSubscribers(msg.key, msg.force)
      .then((entry) => sendResponse({ key: msg.key, text: entry.text, reason: entry.reason }))
      .catch((e) => sendResponse({ key: msg.key, text: null, reason: String(e) }));
    return true;
  }
  if (msg.type === 'ytc-clear-subs') {
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith('subs:'));
      chrome.storage.local.remove(keys).then(() => sendResponse({ cleared: keys.length }));
    });
    return true;
  }
});
