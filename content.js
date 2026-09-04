/* YouTube Toolkit — injects per-video copy buttons and a multi-select bar into YouTube. */
(function () {
  'use strict';

  const F = window.YTCopyFormat;
  let settings = F.merge(null);
  const TRANSCRIPT_UI = true;    // restored: reads YouTube's own panel, no server involved
  let selectMode = false;
  const selected = new Map(); // card element -> video object

  /* ---------------------------------------------------------------- cards */

  const CARD_SELECTOR = [
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-rich-item-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model'
  ].join(',');

  /* The primary video on a watch page isn't a card renderer, but its metadata block plays
     the same role: title, views, date, channel. Treat it as one. */
  const WATCH_SELECTOR = 'ytd-watch-metadata, #above-the-fold';

  function watchCard() {
    if (!/^\/watch/.test(location.pathname)) return null;
    return document.querySelector('ytd-watch-metadata') ||
      document.querySelector('#above-the-fold');
  }

  function isWatchCard(card) {
    return !!card && typeof card.matches === 'function' && card.matches(WATCH_SELECTOR);
  }

  function isOutermost(el) {
    const parent = el.parentElement && el.parentElement.closest(CARD_SELECTOR);
    return !parent;
  }

  function text(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function findTitle(card) {
    const el =
      card.querySelector('#video-title') ||
      card.querySelector('a.yt-lockup-metadata-view-model-wiz__title') ||
      card.querySelector('[class*="lockup-metadata"][class*="title"]') ||
      card.querySelector('h3 a, h3 span[role="text"]') ||
      card.querySelector('a#video-title-link') ||
      card.querySelector('#title h1, h1');
    if (!el) return '';
    // The `title` attribute is the untruncated version when YouTube clamps the text.
    const attr = el.getAttribute('title') || (el.querySelector('[title]') || {}).title;
    return (attr && attr.trim()) || text(el);
  }

  function findUrl(card) {
    const a =
      card.querySelector('a#video-title, a#video-title-link, a#thumbnail[href]') ||
      card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (!a) {
      // Only for the watch card — a sidebar card mid-hydration must not inherit this id.
      if (isWatchCard(card)) {
        const v = new URL(location.href).searchParams.get('v');
        if (v) return { url: 'https://www.youtube.com/watch?v=' + v, id: v };
      }
      return { url: '', id: '' };
    }
    const href = a.getAttribute('href') || '';
    if (!href) return { url: '', id: '' };
    const abs = new URL(href, location.origin);
    const id = abs.searchParams.get('v') || (abs.pathname.match(/\/shorts\/([\w-]+)/) || [])[1] || '';
    const url = id ? 'https://www.youtube.com/watch?v=' + id : abs.origin + abs.pathname;
    return { url, id };
  }

  function findChannel(card) {
    const el =
      card.querySelector('ytd-channel-name a, #channel-name a') ||
      card.querySelector('.yt-content-metadata-view-model-wiz__metadata-row a[href^="/@"]') ||
      card.querySelector('a[href^="/@"], a[href^="/channel/"], a[href^="/c/"]') ||
      // Some cards render the channel as plain text rather than a link.
      card.querySelector('ytd-channel-name #text, ytd-channel-name yt-formatted-string, ytd-channel-name');
    if (el) return text(el);

    // Newer builds put a bare channel name in the first metadata row.
    const title = findTitle(card);
    for (const row of card.querySelectorAll('[class*="metadata-row"]')) {
      const t = text(row);
      if (!t || t === title || t.length > 60) continue;
      if (VIEWS_RE.test(t) || DATE_RE.test(t)) continue;
      if (/\bviews?\b|\bago\b/i.test(t)) continue;  // combined "views • ago" row
      return t;
    }

    // Or read it out of the thumbnail aria-label: "Title by CHANNEL 68,412 views …".
    const labelled = card.querySelector('a[aria-label][href*="/watch"]');
    const label = labelled && labelled.getAttribute('aria-label');
    const m = label && label.match(/\bby\s+(.+?)\s+(?:[\d.,]+\s*[KMB]?|No)\s+views?\b/i);
    return m ? m[1].trim() : '';
  }

  /* View count and upload time live in unlabeled sibling spans, and YouTube renames the
     wrapper classes between builds — so match on the text itself, not on the markup. */
  const VIEWS_RE = /^(no views|[\d.,]+\s*[kmb]?\s*(views?|watching(\s+now)?))$/i;
  /* "mo" must precede "m" in the alternation, otherwise "2mo ago" matches as 2 minutes and
     leaves a stray "o". YouTube uses the compact forms in search and increasingly elsewhere;
     the long forms remain in other surfaces, so both are accepted. */
  const DATE_RE = new RegExp(
    '^((streamed|premiered)\\s+)?\\d+\\s+(second|minute|hour|day|week|month|year)s?\\s+ago$' +
    '|^((streamed|premiered)\\s+)?\\d+\\s*(mo|s|m|h|d|w|y)\\s+ago$' +
    '|^(premieres?|scheduled|starts|live)\\b' +
    '|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2},?\\s*\\d{0,4}$',
    'i'
  );

  const KNOWN_META = [
    '#metadata-line span',
    '.inline-metadata-item',
    '[class*="metadata-row"] span',
    '[class*="metadata-text"]',
    '#video-info span',
    'ytd-video-meta-block span'
  ].join(',');

  /* A view count with no word attached. YouTube's newer search and feed layouts render the
     metadata line as "285K • 1mo ago" rather than "285K views • 1mo ago", so requiring the
     word "views" silently lost the count — and with it the outlier ratio, which needs a
     numerator. Durations are excluded by the absence of a colon. */
  const BARE_COUNT_RE = /^[\d.,]+\s*[kmb]?$/i;

  function findMeta(card) {
    let views = '';
    let date = '';
    const seen = new Set();
    const ordered = [];          // candidate texts, in document order

    function collect(nodes) {
      for (const n of nodes) {
        const t = text(n);
        if (!t || t.length > 60 || seen.has(t)) continue;
        seen.add(t);
        ordered.push(t);
        if (!views && VIEWS_RE.test(t)) views = t;
        else if (!date && DATE_RE.test(t)) date = t;
        if (views && date) return true;
      }
      return false;
    }

    const done = collect(card.querySelectorAll(KNOWN_META));
    if (!done) {
      // Unknown build: check every leaf element in the card.
      collect(Array.from(card.querySelectorAll('span, div')).filter((el) => !el.children.length));
    }

    /* Only accept a bare number as the view count when it sits just before the date in the
       same metadata line. A number anywhere else on the card — a duration, a figure in the
       title, a channel name — must not be mistaken for a view count. */
    if (!views && date) {
      const at = ordered.indexOf(date);
      for (let i = at - 1; i >= 0 && i >= at - 3; i--) {
        if (BARE_COUNT_RE.test(ordered[i])) { views = ordered[i]; break; }
      }
    }

    if (views && date) return { views, date };

    // Last resort: the thumbnail link's aria-label, e.g.
    // "Title by CHANNEL 129,383 views 6 hours ago 16 minutes, 52 seconds".
    const labelled = card.querySelector('a[aria-label][href*="/watch"], [aria-label][id="video-title"]');
    const label = labelled && labelled.getAttribute('aria-label');
    if (label) {
      if (!views) {
        const m = label.match(/((?:[\d.,]+\s*[KMB]?|No)\s+views?)/i);
        if (m) views = m[1].trim();
      }
      if (!date) {
        const m = label.match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);
        if (m) date = m[1].trim();
      }
    }
    return { views, date };
  }

  /* Which channel a card belongs to. Cards link to a channel in several forms — "/@handle",
     "/channel/UC…", legacy "/c/Name" and "/user/Name" — and sometimes as absolute URLs, so
     parse every anchor rather than pattern-matching one selector. On a channel's own page the
     cards carry no channel link at all, so fall back to the page we're on. */
  function keyFromPath(path) {
    const m = path.match(/^\/(@[^/?#]+)/) ||
      path.match(/^\/(channel\/UC[\w-]+)/) ||
      path.match(/^\/(c\/[^/?#]+)/) ||
      path.match(/^\/(user\/[^/?#]+)/);
    return m ? m[1] : '';
  }

  function findChannelKey(card) {
    /* Resolved by id, for a card whose markup never names its channel. Checked first because
       it is the authoritative answer once we have it, and because putting it here is what
       makes the subscriber badge, the outlier, the filter modal's channel column and the
       hover preview all work for shorts without any of them knowing shorts exist. */
    if (card.dataset && card.dataset.ytcChan) return card.dataset.ytcChan;
    let fallback = '';
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href || href[0] === '#') continue;
      let path;
      try { path = new URL(href, location.origin).pathname; } catch (e) { continue; }
      const key = keyFromPath(path);
      if (!key) continue;
      // A card may link to the same channel by handle and by id; settle on the handle so
      // both don't get looked up and cached separately.
      if (key[0] === '@') return key;
      if (!fallback) fallback = key;
    }
    return fallback || keyFromPath(location.pathname);
  }

  /* Feed ads have no channel behind them; badging them is noise. */
  function isAd(card) {
    return !!card.closest('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer') ||
      !!card.querySelector('ytd-ad-slot-renderer, [class*="ad-badge"], .badge-style-type-ad');
  }

  function readCard(card) {
    const title = findTitle(card);
    if (!title) return null;
    const { url, id } = findUrl(card);
    const { views, date } = findMeta(card);
    return { title, views, date, channel: findChannel(card), url, id };
  }

  /* ------------------------------------------------------------- clipboard */

  async function copyText(str) {
    if (!str) return false;
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  let toastTimer = null;
  function toast(msg, isError) {
    if (!settings.toast) return;
    let el = document.querySelector('.ytc-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ytc-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('ytc-toast--error', !!isError);
    el.classList.add('ytc-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('ytc-toast--show'), 1800);
  }

  async function copyVideos(videos, label) {
    const out = F.formatList(videos, settings);
    if (!out) { toast('Nothing to copy', true); return; }
    const ok = await copyText(out);
    toast(ok ? (label || `Copied ${videos.length} video${videos.length > 1 ? 's' : ''}`) : 'Copy failed', !ok);
  }

  /* ------------------------------------------------------------------- UI */

  function makeButton(card) {
    const btn = document.createElement('button');
    btn.className = 'ytc-btn';
    btn.type = 'button';
    btn.title = 'Copy this video (YouTube Toolkit)';
    btn.setAttribute('aria-label', 'Copy video details');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
      '<path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>' +
      '</svg><span class="ytc-btn__label">Copy</span>';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = readCard(card);
      if (!v) { toast('Could not read this video', true); return; }
      await copyVideos([v], 'Copied');
      btn.classList.add('ytc-btn--done');
      setTimeout(() => btn.classList.remove('ytc-btn--done'), 1200);
    });
    return btn;
  }

  async function saveThumbs(videos, label) {
    if (!videos.length) { toast('Nothing to download', true); return; }
    sendMessage({ type: 'ytc-thumbs', videos }, (res) => {
      if (chrome.runtime.lastError || !res) { toast('Download failed', true); return; }
      if (!res.saved) { toast('No thumbnail found', true); return; }
      toast(label || ('Saved ' + res.saved + ' thumbnail' + (res.saved > 1 ? 's' : '')) +
        (res.failed ? ' (' + res.failed + ' unavailable)' : ''));
    });
  }

  function makeThumbButton(card) {
    const btn = document.createElement('button');
    btn.className = 'ytc-thumb';
    btn.type = 'button';
    btn.title = 'Download this thumbnail (highest resolution available)';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z"/>' +
      '</svg><span class="ytc-btn__label">Thumb</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = readCard(card);
      if (!v || !v.id) { toast('Could not read this video', true); return; }
      saveThumbs([{ id: v.id, title: v.title }], 'Saved thumbnail');
      btn.classList.add('ytc-btn--done');
      setTimeout(() => btn.classList.remove('ytc-btn--done'), 1200);
    });
    return btn;
  }

  /* ------------------------------------------------------------- transcript */

  function transcriptPanel() {
    return document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ' +
      'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"], ' +
      '[target-id*="transcript"]');
  }

  /* YouTube is migrating its renderers to view-models — the channel grid went from
     gridVideoRenderer to lockupViewModel — so a single hardcoded tag name is a liability.
     Try the known shapes in turn and report which one matched. */
  const SEGMENT_SELECTORS = [
    'ytd-transcript-segment-renderer',
    'yt-transcript-segment-renderer',
    'ytd-transcript-body-renderer [role="button"]',
    '[class*="transcript-segment"]',
    'ytd-transcript-segment-list-renderer > div',
    'transcript-segment-view-model',
    'yt-transcript-segment-view-model'
  ];

  const STAMP_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  /* The screen-reader duration label that sits beside the timestamp: "9 seconds",
     "1 minute, 30 seconds", "1 hour, 2 minutes". Visually hidden, but textContent picks it
     up, which is how "9 secondsWelcome back to..." reached the caption text. */
  const A11Y_DURATION_RE =
    /^\s*\d+\s+(?:hour|minute|second)s?(?:\s*(?:,|and)\s*\d+\s+(?:hour|minute|second)s?)*\s*/i;

  /* Identify the parts by shape and role, not by class name.

     YouTube renamed these elements out from under us once already — the panel moved to
     transcript-segment-view-model — and the previous extraction, keyed on .segment-timestamp
     and .segment-text, degraded silently rather than failing: 181 segments of about 4.6
     characters each, which was the timestamps being read as the captions.

     The real markup is three leaves: an aria-hidden timestamp, a screen-reader duration
     label, and the caption in a span carrying role="text". role is the most stable handle
     of the three — it describes what the element IS, where class names describe how it is
     currently built — so prefer it, and fall back to subtracting the recognisable parts
     from the segment's whole text when it is absent. */
  function segmentsFrom(nodes) {
    return Array.from(nodes)
      .map((n) => {
        const whole = text(n);
        if (!whole) return null;

        const leaves = Array.from(n.querySelectorAll('*')).filter((el) => !el.children.length);
        const stampEl = leaves.find((el) => STAMP_RE.test(text(el)));
        const time = stampEl ? text(stampEl) : '';

        const spoken = n.querySelector('[role="text"]');
        let body;
        if (spoken && text(spoken)) {
          body = text(spoken);
        } else {
          body = whole;
          if (time) {
            body = body.startsWith(time) ? body.slice(time.length) : body.replace(time, '');
          }
          body = body.replace(A11Y_DURATION_RE, '');
        }
        body = body.trim();
        return { time, text: body };
      })
      .filter((seg) => seg && seg.text && !STAMP_RE.test(seg.text));
  }

  function transcriptSegments() {
    for (const sel of SEGMENT_SELECTORS) {
      const found = segmentsFrom(document.querySelectorAll(sel));
      if (found.length) return found;
    }
    return [];
  }

  function findShowTranscriptButton() {
    const direct = document.querySelector(
      'ytd-video-description-transcript-section-renderer button, ' +
      'button[aria-label*="transcript" i]');
    if (direct) return direct;
    // Older builds put it behind the "..." menu; match on the visible label instead.
    const byText = Array.from(document.querySelectorAll('button, tp-yt-paper-item, yt-formatted-string'))
      .find((el) => /show transcript/i.test((el.textContent || '').trim()));
    return byText || null;
  }

  function closeTranscriptPanel() {
    const panel = transcriptPanel();
    const close = panel && panel.querySelector(
      'ytd-engagement-panel-title-header-renderer button[aria-label*="Close" i], ' +
      'ytd-engagement-panel-title-header-renderer #visibility-button button');
    if (close) close.click();
  }

  function askBackgroundTranscript(id) {
    return askBackground('ytc-transcript', id);
  }

  /* YouTube signs its own InnerTube calls with a SAPISIDHASH built from a session cookie —
     an unsigned request gets a 400. The cookie is readable here, so build the same header. */
  async function sapisidHash() {
    const jar = document.cookie || '';
    const m = jar.match(/(?:^|;\s*)SAPISID=([^;]+)/) ||
      jar.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/) ||
      jar.match(/(?:^|;\s*)__Secure-1PAPISID=([^;]+)/);
    if (!m || !window.crypto || !window.crypto.subtle) return '';
    const origin = 'https://www.youtube.com';
    const seconds = Math.floor(Date.now() / 1000);
    try {
      const digest = await window.crypto.subtle.digest(
        'SHA-1',
        new TextEncoder().encode(seconds + ' ' + m[1] + ' ' + origin)
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return 'SAPISIDHASH ' + seconds + '_' + hex;
    } catch (e) {
      return '';
    }
  }

  /* Ask the MAIN-world script for values only the live page holds. */
  function pageData() {
    return new Promise((resolve) => {
      const id = 'ytc' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(payload);
      };
      const onMessage = (event) => {
        if (event.source && event.source !== window) return;
        const data = event.data;
        // The random id is what actually pairs request and reply.
        if (!data || data.type !== 'YTC_PAGE_DATA' || data.id !== id) return;
        finish(data.payload || null);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({ type: 'YTC_PAGE_REQUEST', id }, '*');
      // The reply is same-tick when page.js is present; this only bounds the case where it
      // isn't (an older Chrome without world:"MAIN" support).
      setTimeout(() => finish(null), 400);
    });
  }

  /* Fetch from the page's own origin first. YouTube's transcript API rejects requests
     carrying a chrome-extension:// origin, which is what the service worker sends. */
  function askBackground(type, id) {
    return new Promise((resolve) => {
      sendMessage({ type, id }, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, reason: 'extension not loaded' });
        else resolve(res || { ok: false, reason: 'no response' });
      });
    });
  }

  /* Read the transcript out of YouTube's own panel.

     This is the only route that survives. The InnerTube endpoint returns 400 in the page and
     403 from the service worker, and the caption URLs come back empty because they are gated
     behind proof-of-origin tokens an extension cannot mint. yt-dlp worked but needed a helper
     process running locally, and hosting that helper failed too: YouTube blocks datacenter
     IPs, measured at 1 of 4 videos succeeding from Render against 4 of 4 residentially.

     The panel sidesteps all of it by never leaving the page. YouTube renders the transcript
     itself, on the user's own session, so there is nothing to intercept. Measured on a
     24-minute video: 181 segments, 23,099 characters, 97% coverage, 0.6 seconds, and no
     virtualisation — the whole transcript is in the DOM, not just the visible part. */
  const PANEL_TIMEOUT_MS = 12000;

  async function transcriptViaPanel() {
    const already = transcriptSegments();
    if (already.length) return { ok: true, segments: already };   // user already opened it

    const btn = findShowTranscriptButton();
    if (!btn) {
      return { ok: false, reason: 'No transcript available for this video' };
    }

    /* Hide before clicking, not after. The class is on <html> and the rule is in our
       stylesheet, so the panel is suppressed from the moment it exists — waiting until it
       appeared to style it would flash it on screen first. visibility plus off-screen
       positioning rather than display:none, which can stop the content rendering at all. */
    document.documentElement.classList.add('ytc-grabbing-transcript');
    let segments = [];
    try {
      btn.click();
      const deadline = Date.now() + PANEL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        segments = transcriptSegments();
        if (segments.length) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (segments.length) {
        // Let the list finish populating before taking the final count.
        await new Promise((r) => setTimeout(r, 400));
        segments = transcriptSegments();
      }
      closeTranscriptPanel();
    } finally {
      document.documentElement.classList.remove('ytc-grabbing-transcript');
    }

    if (!segments.length) {
      return { ok: false, reason: 'Transcript panel did not load — try again' };
    }
    return { ok: true, segments };
  }

  async function grabTranscript(card, btn) {
    const video = readCard(card) || {};
    btn.classList.add('ytc-busy');
    const res = await transcriptViaPanel();
    btn.classList.remove('ytc-busy');
    if (!res.ok) { toast(res.reason || 'No transcript available', true); return; }
    const segments = res.segments || [];
    if (!segments.length) { toast('No transcript available for this video', true); return; }

    const out = F.formatTranscript(segments, {
      timestamps: settings.transcriptTimestamps,
      title: video.title,
      url: video.url
    });

    if (settings.transcriptSave) {
      sendMessage({
        type: 'ytc-save-text',
        text: out,
        filename: F.safeFilename(video.title, video.id || 'transcript', 'txt')
      }, (res) => {
        if (res && res.ok) toast('Saved transcript (' + segments.length + ' lines)');
        else copyText(out).then((ok) => toast(ok ? 'Copied transcript instead' : 'Transcript failed', !ok));
      });
      return;
    }

    const ok = await copyText(out);
    toast(ok ? 'Copied transcript (' + segments.length + ' lines)' : 'Copy failed', !ok);
  }

  function makeTranscriptButton(card) {
    const btn = document.createElement('button');
    btn.className = 'ytc-transcript';
    btn.type = 'button';
    btn.title = 'Copy this video\'s transcript';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
      '<path fill="currentColor" d="M3 5h18v2H3V5zm0 4h12v2H3V9zm0 4h18v2H3v-2zm0 4h12v2H3v-2z"/>' +
      '</svg><span class="ytc-btn__label">Transcript</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.blur();          // a focused button in a scrolled-away panel drags the view to it
      grabTranscript(card, btn);
    });
    return btn;
  }

  function makeCheckbox(card) {
    const label = document.createElement('label');
    label.className = 'ytc-check';
    label.title = 'Select for bulk copy';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      if (input.checked) {
        const v = readCard(card);
        if (v) selected.set(card, v);
      } else {
        selected.delete(card);
      }
      card.classList.toggle('ytc-card--selected', input.checked);
      updateBar();
    });
    label.appendChild(input);
    label.addEventListener('click', (e) => e.stopPropagation());
    return label;
  }

  /* Re-add each control independently. YouTube re-renders a card's contents when its hover
     preview starts, which can take our controls with it — and checking only for the button
     meant a wiped checkbox never came back. */
  function decorate(card) {
    const fresh = card.dataset.ytcReady !== '1';
    card.dataset.ytcReady = '1';
    card.classList.add('ytc-card');

    const tools = ensureTools(card);

    // Re-add each control independently: a hover preview makes YouTube re-render the card,
    // which can take them with it, and checking only for one leaves the other missing.
    if (!isWatchCard(card) && !tools.querySelector('.ytc-check')) {
      const box = makeCheckbox(card);
      tools.insertBefore(box, tools.firstChild);
      // Restore the tick if this card was selected before the re-render.
      if (selected.has(card)) {
        box.querySelector('input').checked = true;
        card.classList.add('ytc-card--selected');
      }
    }
    if (!tools.querySelector('.ytc-btn')) {
      const btn = makeButton(card);
      const box = tools.querySelector('.ytc-check');
      tools.insertBefore(btn, box ? box.nextSibling : tools.firstChild);
    }
    if (!tools.querySelector('.ytc-thumb')) {
      const thumb = makeThumbButton(card);
      const btn = tools.querySelector('.ytc-btn');
      tools.insertBefore(thumb, btn ? btn.nextSibling : null);
    }
    // Only on the watch page: a transcript needs the video open to read it.
    // Deprecated, so the button is not built at all rather than being built and hidden.
    if (TRANSCRIPT_UI && isWatchCard(card) && !tools.querySelector('.ytc-transcript')) {
      const tr = makeTranscriptButton(card);
      const thumb = tools.querySelector('.ytc-thumb');
      tools.insertBefore(tr, thumb ? thumb.nextSibling : null);
    }

    if (fresh) watchForSubs(card);
    if (isWatchCard(card)) syncWatchMoney(card);
  }

  let lastCount = -1;
  /* After the extension reloads, every content script left on an already-open page keeps
     running against a dead context: chrome.runtime.id is gone and every API call throws
     "Extension context invalidated". Scans fire on each mutation, so a single stale tab
     emits that error forever and buries whatever is actually wrong. Stand down instead —
     the page needs reloading, and nothing here can do that for it. */
  let contextDead = false;
  function contextAlive() {
    if (contextDead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch (e) { /* reading chrome.runtime can itself throw once torn down */ }
    contextDead = true;
    try { if (typeof observer !== 'undefined' && observer) observer.disconnect(); } catch (e) {}
    return false;
  }

  /* One way in and out for messaging, so a dead context is checked in one place rather than
     at nine call sites that each had to remember. The callback simply never fires — the same
     thing that happens when the service worker has nothing to say. */
  function sendMessage(msg, cb) {
    if (!contextAlive()) return;
    try {
      chrome.runtime.sendMessage(msg, cb);
    } catch (e) {
      contextDead = true;
    }
  }

  function scan() {
    if (!contextAlive()) return;
    const cards = document.querySelectorAll(CARD_SELECTOR);
    let n = 0;
    for (const card of cards) {
      if (!isOutermost(card)) continue;
      decorate(card);
      resyncCard(card);
      n++;
    }
    decorateChannelHeader();
    /* Kept out of decorateChannelHeader deliberately: that function returns early when the
       monetization badge is switched off, which would silently take the tab with it. */
    try { ensurePocketButton(); } catch (e) { /* keep the rest of the scan */ }
    try { ensurePocketNav(); } catch (e) { /* keep the rest of the scan */ }
    ensureSimilarTab();
    /* After the tabs, because a rebuild there drops the active class and this puts it back. */
    try { reassertPanels(); } catch (e) { /* keep the rest of the scan */ }
    /* Wrapped like its neighbours: a throw here would take the filter button, the companion
       and the stats card down with it. */
    try { ensureShortsPanel(); } catch (e) { /* keep the rest of the scan */ }
    ensureFilterButton();
    /* Wrapped because it runs before noteChannelSeen and the stats card, and a throw here
       would silently stop both — the same failure the badge row was wrapped against. */
    try { ensureCompanion(); } catch (e) { /* keep the rest of the scan */ }
    noteChannelSeen();
    renderStatsCard();
    const watch = watchCard();
    if (watch) {
      decorate(watch);
      resyncCard(watch);
      n++;
    }

    // Drop selections whose cards were recycled out of the DOM.
    for (const card of Array.from(selected.keys())) {
      if (!card.isConnected) selected.delete(card);
    }
    updateBar();
  }

  /* ------------------------------------------------------------ subscribers */

  const STALE_FAIL_MS = 30000;      // re-ask a failed channel if it scrolls back into view
  const RETRY_DELAYS = [8000, 25000];    // and retry on a timer even if it just sits there
  const DETECT_DELAYS = [400, 1200, 3000, 5000];  // waiting for YouTube to hydrate the card

  const subsByKey = new Map();      // channel key -> { text, reason, t, tries }
  const cardsByKey = new Map();     // channel key -> Set of cards awaiting a badge
  const requested = new Set();
  const statsRequested = new Set(); // watch-page channels whose lifetime totals are in flight

  function badgeOf(card) {
    return card.querySelector('.ytc-subs');
  }

  /* Everything we add lives in one row with the card's text, under the views/date line.
     Nothing sits over the thumbnail: YouTube's hover-preview player renders in a stacking
     context we can't outrank on search results, so anything overlapping the thumbnail
     disappears the moment the preview starts. */
  function ensureTools(card) {
    let tools = card.querySelector('.ytc-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'ytc-tools';
    }
    let anchor;
    if (isWatchCard(card)) {
      // Above the description, just under the channel/actions row.
      anchor = card.querySelector('#top-row') || card.querySelector('#title') ||
        card.querySelector('h1');
    } else {
      const rows = card.querySelectorAll('#metadata-line, [class*="metadata-row"]');
      anchor = rows.length ? rows[rows.length - 1]
        : card.querySelector('#video-title, h3, #title, h1');
    }
    if (anchor && anchor.parentElement) {
      if (tools.previousElementSibling !== anchor || tools.parentElement !== anchor.parentElement) {
        anchor.parentElement.insertBefore(tools, anchor.nextSibling);
      }
    } else if (tools.parentElement !== card) {
      card.appendChild(tools);
    }
    markFlow(tools);
    return tools;
  }

  function attachBadge(card, badge) {
    const tools = ensureTools(card);
    if (badge.parentElement !== tools) tools.appendChild(badge);
  }

  /* Search results lay their metadata out as a row flex, so the badge lands beside the
     views/date text and needs a left gap and vertical centring. Grid cards stack in a
     column, where the badge gets its own line and neither applies. */
  function markFlow(el) {
    const parent = el.parentElement;
    if (!parent || typeof getComputedStyle !== 'function') return;
    const style = getComputedStyle(parent);
    const inRow = /flex|box/.test(style.display || '') &&
      !/column/.test(style.flexDirection || '');
    el.classList.toggle('ytc-tools--inline', inRow);
  }

  function makeBadge(card) {
    let badge = badgeOf(card);
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'ytc-subs';
    }
    attachBadge(card, badge);
    return badge;
  }

  /* Colour from the number we display, not the exact one. The label is rounded, so an exact
     0.4509 shows as "0.5×" — colouring it by the exact value would paint two badges reading
     "0.5×" different colours, which just looks broken. */
  function ratioLabel(r) {
    if (r >= 10) {
      const v = Math.round(r);
      return { text: v + '×', value: v };
    }
    if (r < 0.1) return { text: '<0.1×', value: r };
    const v = Number(r.toFixed(1));
    return { text: v + '×', value: v };
  }

  /* Green = it outperformed the denominator, red = it underperformed. The scale runs
     good → bad, so a 224× breakout reads as a win at a glance.

     Every ratio in the extension is coloured from this one ladder — the video badges, the
     channel header pill and the Outlier column all call it — so the same multiple is never
     two different colours in two places. */
  function ratioTier(r) {
    if (r >= 10) return 'great';   // breakout
    if (r >= 3) return 'good';     // strong
    if (r >= 1) return 'ok';       // beat the denominator
    if (r >= 0.5) return 'low';    // soft
    return 'poor';                 // flopped
  }

  function ratioClass(r) {
    return 'ytc-ratio--' + ratioTier(r);
  }

  /* Two different denominators can end up here, and they do not mean the same thing, so the
     tooltip always says which one produced the number. */
  function ratioTitle(r, avgViews) {
    const label = r >= 10 ? 'breakout' : r >= 3 ? 'strong' : r >= 1 ? 'above channel average'
      : r >= 0.5 ? 'below channel average' : 'well below channel average';
    return 'Outlier \u2014 views ÷ this channel\'s lifetime average (' +
      (F.compact(avgViews) || avgViews) + ' per video) \u2014 ' + label;
  }

  /* A different question from the outlier, and worth asking separately: the outlier says
     whether a video beat what the channel normally gets, this says whether it travelled
     beyond the channel's own audience. A small channel can be 8x its own average and still
     under its subscriber count; a large one can be under its average and far over it. */
  function subRatioTitle(r, subs) {
    const label = r >= 10 ? 'far beyond its audience' : r >= 3 ? 'well beyond its audience'
      : r >= 1 ? 'more views than subscribers' : r >= 0.5 ? 'under its subscriber count'
      : 'well under its subscriber count';
    return 'Views ÷ subscribers (' + (F.compact(subs) || subs) + ') \u2014 ' + label;
  }

  /* ------------------------------------------------------------- video metrics */

  /* A card in the watch sidebar rather than pills in the button row: these are five numbers
     that want labels, and the row has no space for labelled values.

     The sidebar is built by the SPA after navigation, so the mount point is resolved from a
     fallback chain and re-checked on every scan — the same lesson as the channel header,
     which stopped appearing because it latched onto a "handled" flag instead of verifying
     the element was still there. */
  const SIDEBAR_HOSTS = ['#secondary-inner', '#secondary', 'ytd-watch-flexy #secondary'];

  /* Whether each half of the card is still waiting or has given up. A dash means "there is
     no number"; a sweeping bar means "one is coming". Without the distinction a cell waiting
     on its lookup was drawn exactly like one whose lookup had failed, and the only way to
     tell them apart was to reload and watch it fill in. */
  const cardState = { videoId: '', metrics: null, outlier: null, stats: null,
                      pending: { metrics: true, outlier: true }, giveUp: 0 };

  /* Comfortably past every retry chain that feeds this card. Each of those settles its own
     cells, so this only fires on a path that failed in a way none of them anticipated — and
     a placeholder promising a number that is never coming is worse than a dash. If a slow
     chain does land afterwards it simply overwrites the dash with the real figure. */
  const CARD_GIVE_UP_MS = 30000;

  function settleOutlier() {
    if (!cardState.pending.outlier) return;
    cardState.pending.outlier = false;
    renderStatsCard();
  }

  function sidebarHost() {
    if (!/^\/watch/.test(location.pathname)) return null;
    for (const sel of SIDEBAR_HOSTS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function cell(label, value, title, cls) {
    return '<div class="ytc-cs__cell' + (cls ? ' ' + cls : '') + '"' +
      (title ? ' title="' + String(title).replace(/"/g, '&quot;') + '"' : '') + '>' +
      '<div class="ytc-cs__label">' + label + '</div>' +
      '<div class="ytc-cs__value">' + value + '</div></div>';
  }

  function renderStatsCard() {
    const onWatch = /^\/watch/.test(location.pathname);
    const existing = document.querySelector('.ytc-cs');

    /* Removal is reserved for actually leaving — anything else caused the flicker. scan()
       runs on every DOM mutation, and the card used to be torn down whenever the sidebar was
       mid-rebuild or the metrics had not landed yet, then rebuilt a moment later. So it now
       persists while the page does, showing placeholders instead of vanishing. */
    if (!onWatch || !settings.showStats) {
      if (existing) existing.remove();
      return;
    }

    const host = sidebarHost();
    // Sidebar mid-rebuild: leave whatever is on screen and try again next scan.
    if (!host && !existing) return;

    let card = existing;
    if (!card) {
      card = document.createElement('div');
      card.className = 'ytc-cs';
    }
    // Reattach the SAME element rather than replacing it, so a re-render moves the card
    // instead of flashing a new one into place.
    if (host && card.parentElement !== host) host.insertBefore(card, host.firstChild);

    const m = cardState.metrics;
    const ol = cardState.outlier;
    const dash = '—';
    /* Only ever waiting on something that is actually coming: the outlier needs the
       subscriber lookup, so with that switched off it is settled from the start rather than
       sweeping for a request nobody is going to make. */
    const waitOl = cardState.pending.outlier && settings.showSubs;
    const waitM = cardState.pending.metrics;
    const skel = '<span class="ytc-cs__skel"></span>';
    const soon = (waiting) => (waiting ? skel : dash);

    const rows =
      '<div class="ytc-cs__row">' +
        cell('Outlier', ol == null ? soon(waitOl) : (ol >= 10 ? Math.round(ol) : Number(ol.toFixed(1))) + '×',
          ol == null
            ? (waitOl ? 'Waiting for the channel average'
                      : 'No channel average available — this channel publishes no lifetime ' +
                        'totals, or the lookup could not reach them')
            : 'Views against this channel\'s lifetime average views per video') +
        cell('VPH', m ? F.formatVph(m.vph) : soon(waitM),
          !m ? (waitM ? 'Reading video data' : 'Video data could not be read')
            : m.vph == null ? 'Publish date unavailable'
            : Math.round(m.vph).toLocaleString() + ' views/hour averaged since publishing — a lifetime rate, not current velocity') +
        cell('Engagement', !m ? soon(waitM) : m.engagement != null ? m.engagement.toFixed(1) + '%' : dash,
          !m ? (waitM ? 'Reading video data' : 'Video data could not be read')
            : m.engagement == null ? 'Likes hidden on this video'
            : (m.likes || 0).toLocaleString() + ' likes on ' + m.views.toLocaleString() + ' views. Comments are not counted') +
      '</div>' +
      '<div class="ytc-cs__row">' +
        /* Named by niche once the index has classified the channel, because "RPM (assumed)"
           invites the question "assumed from what". A name matched from this one video's
           title carries a question mark: single titles scatter across niches even within one
           channel, so presenting that guess the same way as a classification built from the
           channel's own vector claims a confidence it has not earned. */
        cell(m && m.nicheLabel
              ? 'RPM (' + m.nicheLabel.toLowerCase() + (m.nicheProvisional ? '?' : '') + ')'
              : 'RPM (assumed)',
          !m ? soon(waitM) : m.rpm == null ? 'n/a' : '$' + (Math.round(m.rpm * 100) / 100),
          !m ? (waitM ? 'Reading video data' : 'Video data could not be read')
            : m.rpm == null
              ? 'Shorts are paid from a separate ad-share pool, not a long-form RPM'
              : (m.nicheLabel
                  ? 'Reference rate for ' + m.nicheLabel + ', scaled for a video ' +
                    m.length.label +
                    (m.nicheProvisional
                      ? '. Guessed from this video\'s title alone — the channel is not in ' +
                        'the index yet, so this may change once it is'
                      : '. Matched from what the channel publishes')
                  : 'Assumed rate for a video ' + m.length.label + '. Base band $' + F.RPM_LOW +
                    '-$' + F.RPM_HIGH + ', scaled for length') +
                /* Only mentioned when it actually moved the number. A line explaining a
                   1.02x adjustment is noise; one explaining 1.45x is the difference between
                   this figure and the one the reader saw last month. */
                (m.season && Math.abs(m.season - 1) >= 0.05
                  ? '. Adjusted ' + (Math.round(m.season * 100) / 100) + 'x for the time of ' +
                    'year: ad rates peak in December and bottom out in January'
                  : '') +
                '. Real RPM is private to the channel, and audience country moves it further ' +
                'than niche does' +
                (m.category ? '. Category: ' + m.category : '')) +
        cell('Est. earnings',
          !m ? soon(waitM) : m.earnings == null ? dash : F.formatMoney(m.earnings.mid),
          !m ? (waitM ? 'Reading video data' : 'Video data could not be read')
            : m.earnings == null
              ? 'Not estimated for Shorts. They earn from a revenue-share pool at roughly ' +
                'cents per 1,000 views, so a long-form RPM would be the wrong unit entirely'
              : F.formatMoney(m.earnings.low) + ' to ' + F.formatMoney(m.earnings.high) +
                ' (' + m.length.label + '). Not real revenue') +
      '</div>' +
      '<div class="ytc-cs__note">' +
        (m && m.earnings == null
          ? 'Shorts earn from a separate pool — no long-form estimate applies.'
          : 'Earnings are views x an assumed RPM, adjusted for length. Not actual revenue.') +
        (m && m.approx ? ' Figures read from the page, so rounded.' : '') +
      '</div>';

    if (card.dataset.sig !== rows) {   // avoid rewriting the DOM on every scan
      card.dataset.sig = rows;
      card.innerHTML = rows;
    }
  }

  /* Which video the card describes is decided by the address bar, not by whichever feature
     happens to report first. Tying it to the metrics read meant a failed player read also
     suppressed the outlier — which needs no player data at all, only the view count from the
     DOM and the channel average from the background. */
  function trackCardVideo(videoId) {
    if (!videoId || cardState.videoId === videoId) return;
    cardState.videoId = videoId;
    cardState.outlier = null;          // all of these belong to the previous video
    cardState.metrics = null;
    cardState.stats = null;
    cardState.pending.metrics = true;
    cardState.pending.outlier = true;
    if (cardState.giveUp) clearTimeout(cardState.giveUp);
    cardState.giveUp = setTimeout(() => {
      if (cardState.videoId !== videoId) return;
      if (!cardState.pending.metrics && !cardState.pending.outlier) return;
      cardState.pending.metrics = false;
      cardState.pending.outlier = false;
      renderStatsCard();
    }, CARD_GIVE_UP_MS);
  }

  /* The channel's niche rate, once the index has classified it. Held for the current channel
     only, so a soft navigation to a different channel cannot price this video at the last
     one's rate. */
  const nicheState = { key: '', rpm: 0, label: '', provisional: false, asked: false,
                       tries: 0, timer: 0 };

  /* The index answers "not indexed yet" on the first visit to a channel — asking is what
     starts the ingest, and it finishes after the answer has already been sent. The background
     treats that as a "not yet" and deliberately leaves it uncached so the next ask can do
     better, but nothing here ever asked again: one miss set asked and the card kept the flat
     assumed band for the rest of the visit. The real niche rate appeared only after a manual
     reload, which is the refresh people were reaching for. */
  const NICHE_MAX_TRIES = 4;
  const NICHE_RETRY_DELAYS = [2000, 6000, 15000];

  function resetNiche(key) {
    if (nicheState.timer) clearTimeout(nicheState.timer);
    nicheState.timer = 0;
    nicheState.key = key;
    nicheState.rpm = 0;
    nicheState.label = '';
    nicheState.provisional = false;
    nicheState.asked = false;
    nicheState.tries = 0;
  }

  /* Reprices whatever the card is showing now, from the stats it was drawn with, rather than
     the stats captured when the lookup was sent. A reply can land after a soft navigation
     within the same channel, and repricing the captured copy wrote the previous video's views
     and earnings back onto the card. */
  function repriceCard() {
    const again = F.videoMetrics(cardState.stats, Date.now(), nicheState.rpm);
    if (!again) return;
    again.nicheLabel = nicheState.rpm > 0 ? nicheState.label : '';
    again.nicheProvisional = nicheState.rpm > 0 && nicheState.provisional;
    cardState.metrics = again;
    renderStatsCard();
  }

  function askNiche(card, key) {
    nicheState.asked = true;
    /* The video's title, only as a fallback for a channel the index has not classified yet.
       One title is a thin signal — the point of asking the index is that its vector was built
       from the channel's description and many titles together — but it beats no answer, and
       visiting the page indexes the channel for next time anyway. */
    const opts = { videoTitles: [findTitle(card) || ''].filter(Boolean) };
    sendMessage({ type: 'ytc-niche', key, opts }, (res) => {
      if (nicheState.key !== key) return;              // moved on to another channel
      if (!chrome.runtime.lastError && res && res.ok) {
        nicheState.rpm = Number(res.rpm) || 0;
        nicheState.label = res.niche || '';
        nicheState.provisional = !res.indexed;
        repriceCard();
        /* An answer from the channel's own vector is final. One guessed from a single video
           title is not — it is built from the same thin signal that gets refused when it
           falls under the floor — so show it, because a provisional rate beats the flat
           band, and keep asking. Ingestion was started by this very request, and the stored
           vector supersedes the guess within seconds. */
        if (res.indexed) return;
      }
      /* Settled the moment the index says it holds the channel, whether it classified it or
         refused to: either is an answer from the stored vector, the background caches it, and
         asking again would only replay that cache. Settled too when there is no index to ask
         — a build without one answers the same way however often it is asked. Anything else
         — not indexed yet, unreachable, a dead service worker — is worth one more try. */
      const reason = (res && res.reason) || '';
      const settled = !chrome.runtime.lastError && res &&
        (res.indexed || reason === 'no index' || /not configured/.test(reason));
      if (settled || nicheState.tries >= NICHE_MAX_TRIES - 1) return;
      const wait = NICHE_RETRY_DELAYS[Math.min(nicheState.tries, NICHE_RETRY_DELAYS.length - 1)];
      nicheState.tries++;
      nicheState.timer = setTimeout(() => {
        nicheState.timer = 0;
        if (nicheState.key === key && card.isConnected) askNiche(card, key);
      }, wait);
    });
  }

  function renderMetrics(card, stats, videoId) {
    trackCardVideo(videoId);

    /* Cleared before anything is drawn, not after. Navigating from a car review to a politics
       interview kept pricing at the automotive rate: the card was rendered with the previous
       channel's figure and only then was the state reset, so a lookup that came back with no
       niche left the stale rate on screen with nothing to replace it. */
    /* The player names the channel; the DOM fallback that stands in when the player cannot be
       read does not, and losing the handle lost the niche with it — the lookup below needs a
       key and gives up without one, so every video whose player data failed was priced at the
       flat band however obvious its subject. A music video on a 3M-subscriber music channel
       read as "RPM (assumed)" for exactly that reason. The owner link sits in the same
       metadata block the views were just read from, so read it rather than give up.
       Handles only: the endpoint prefixes a bare key with "@", which would turn a
       "channel/UC..." id into nonsense, and the player reports a handle too, so both sources
       agree on the cache key. */
    let key = (stats && stats.channelHandle) || '';
    if (!key) {
      const fromDom = findChannelKey(card);
      if (fromDom && fromDom[0] === '@') key = fromDom;
    }
    if (nicheState.key !== key) resetNiche(key);

    const m = F.videoMetrics(stats, Date.now(), nicheState.rpm);
    // Only overwrite on success: a read that came back empty should leave a card that is
    // already showing this video's numbers alone rather than removing it.
    if (m) {
      m.nicheLabel = nicheState.rpm > 0 ? nicheState.label : '';
      m.nicheProvisional = nicheState.rpm > 0 && nicheState.provisional;
      cardState.metrics = m;
      cardState.stats = stats;       // what a late niche reply reprices
      cardState.pending.metrics = false;
    }
    renderStatsCard();

    /* Asked once per channel and cached in the service worker, then retried on backoff for as
       long as the answer is only a "not yet". When it lands the card is drawn again, because
       the first draw used the flat rate. */
    if (!key || !settings.showStats || nicheState.asked) return;
    askNiche(card, key);
  }

  /* Likes as rendered on the page. Abbreviated ("32K") and localised, so this is a fallback
     for when the player response is unavailable, never the preferred source. */
  function domLikes() {
    const el = document.querySelector(
      'like-button-view-model button[aria-label], #segmented-like-button button[aria-label], ' +
      'ytd-toggle-button-renderer button[aria-label*="like" i]');
    const label = el && el.getAttribute('aria-label');
    const exact = label && label.match(/([\d][\d,.]{2,})/);
    if (exact) {
      const n = F.viewsToNumber(exact[1]);
      if (n != null) return n;
    }
    const shown = el && text(el);
    return shown ? F.viewsToNumber(shown) : null;
  }

  /* Everything the card needs can be read off the rendered page too. It is coarser — view
     counts and timestamps are abbreviated there — but an approximate card beats five dashes
     when the player response cannot be reached. */
  function domStats(card) {
    const meta = findMeta(card);
    const views = F.viewsToNumber(meta.views);
    if (!views) return null;
    const iso = meta.date ? F.relativeToISO(meta.date, new Date()) : '';   // wants a Date, not a timestamp
    return {
      approx: true,
      views,
      likes: domLikes(),
      publishDate: /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso : '',
      category: '',
      lengthSeconds: null,
      shortsEligible: false,
      shortsPath: /^\/shorts\//.test(location.pathname)
    };
  }

  /* The outlier needs the channel's lifetime average, which arrives from the background
     lookup rather than the page, so it lands separately and updates the card in place. */
  function setCardOutlier(videoId, value) {
    if (cardState.videoId !== videoId) return;
    cardState.outlier = value;
    cardState.pending.outlier = false;
    renderStatsCard();
  }

  /* ---------------------------------------------------------- similar channels */

  /* Titles are read from the grid already on screen — the queries are built from what the
     user is looking at, so discovering the topic costs no request at all. */
  function channelVideoTitles(limit) {
    const nodes = document.querySelectorAll(
      'ytd-rich-item-renderer #video-title, ytd-grid-video-renderer #video-title, ' +
      'ytd-rich-grid-media #video-title, a#video-title-link, ' +
      'yt-lockup-view-model a[href*="/watch"] span');
    const out = [];
    const seen = new Set();
    for (const n of nodes) {
      const t = (n.getAttribute('title') || text(n) || '').trim();
      if (t.length < 8 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= (limit || 20)) break;
    }
    return out;
  }

  /* The channel's own description of itself. Titles say what the latest videos are about;
     the description says what the channel is about, and on a news or case-driven channel
     those are entirely different things. */
  /* Strictly the channel header. Searching the whole document found the featured video's
     description instead — "How did a small fire create chaos onboard a cargo airliner..." —
     and built the queries "air story", "ocean story" and "flight story" from it, which
     returned @NatGeo, @FreeDocumentaryNature and @bedtimestoryco. A video's description
     describes a video; only the header describes the channel. */
  function channelAboutText() {
    const header = document.querySelector(
      'yt-page-header-view-model, #channel-header, ytd-channel-tagline-renderer');
    if (!header) return '';
    const el = header.querySelector(
      'yt-description-preview-view-model, #description-container, #channel-tagline, ' +
      'yt-attributed-string') || header;
    const t = text(el);
    return t.length > 12 ? t.slice(0, 600) : '';
  }

  function channelOwnStats() {
    const header = document.querySelector('yt-page-header-view-model, #channel-header');
    /* Read the title from a copy with our own badge stripped out. The badge lives inside the
       h1 so it sits on the title line, and without this the name sent to the index would be
       "Uche Okafor 2.4×". */
    const h1 = header && header.querySelector('h1, .yt-core-attributed-string');
    let title = '';
    if (h1) {
      const clone = h1.cloneNode(true);
      clone.querySelectorAll('.ytc-out').forEach((n) => n.remove());
      title = text(clone);
    }
    let subscribers = null;
    if (header) {
      const el = Array.from(header.querySelectorAll('span, div'))
        .find((n) => !n.children.length && /subscriber/i.test(text(n)));
      if (el) subscribers = F.viewsToNumber(text(el));
    }
    /* The canonical link, not the first "channelId" in the document.
       A channel page contains no "channelId" key of its own — that key belongs to video
       items, so the old match returned some other channel's id, or a stale one from the
       previous page. Two different channels were consequently recorded under one id in the
       sightings queue, each overwriting the other. The canonical link names this channel and
       nothing else. */
    let channelId = null;
    const canon = document.querySelector('link[rel="canonical"]');
    const href = canon && canon.getAttribute('href');
    const fromCanon = href && href.match(/\/channel\/(UC[\w-]{20,24})/);
    if (fromCanon) {
      channelId = fromCanon[1];
    } else {
      // externalId appears once, in the channel's own metadata block.
      const m = document.documentElement.innerHTML.match(/"externalId":"(UC[\w-]{20,24})"/);
      if (m) channelId = m[1];
    }
    return { channelId: channelId, title: title || '', subscribers: subscribers };
  }

  const simFilter = { smallOnly: false, sort: 'similarity', desc: true, open: false,
    chip: 'all', reveal: 0 };
  /* Row height in pixels, for turning a drag distance into a number of rows. Measured from
     the rendered table when possible; this is only the value used before one exists. */
  const SIM_ROW_H = 44;

  /* Below this, the list is treated as a failure: the note says so, and the extension goes
     looking for more channels in the niche.

     0.65 rather than 0.55, which was set before there was anything to calibrate against.
     Measured on a filled index, a niche that is genuinely covered lands well above it —
     aviation 0.91, tech 0.81, MMA 0.77, horror 0.73, YouTube-growth 0.69 — while a niche
     with nothing in it sits below: aviation before it was walked returned true-crime
     channels at 0.59, and the old threshold called that a good answer and stayed quiet. */
  const WEAK_BELOW = 0.65;
  /* Never fold the table away to nothing. In a thinly indexed niche every match can sit under
     the confidence line, and an empty table under a chip reporting matches reads as a bug. */
  const TRUST_MIN_ROWS = 5;

  /* Ad monetization needs 1,000 subscribers. Below that the question "is it monetized" has no
     answer worth giving, which is the same gate the channel badge uses. */
  const YPP_MIN_SUBS = 1000;

  /* Preset views over the fetched rows. These filter what was already returned rather than
     asking the server again, so switching between them is instant and costs nothing. Each
     one answers a question a channel hunter actually asks — the point of the list is finding
     channels punching above their size, not admiring the biggest ones. */
  const SIM_CHIPS = [
    { key: 'all', label: 'All channels', test: () => true },
    /* Deliberately NOT called "Outliers". That word already means something exact in this
       extension — a video's views against its own channel's lifetime average — and the index
       holds no per-video data for other channels, so that score cannot be computed here. This
       is the views-to-subscribers ratio, which is a different question: who is reaching far
       past their own audience. */
    { key: 'outliers', label: 'Overperforming',
      test: (c) => c.subscribers > 0 && c.avgViews >= c.subscribers * 2 },
    { key: 'lowsub', label: 'Low subs, high views',
      test: (c) => c.subscribers > 0 && c.subscribers <= 25000 && c.avgViews >= 50000 },
    { key: 'newfast', label: 'High views, new channel',
      test: (c) => c.avgViews >= 50000 && (daysSince(c.publishedAt) || 1e9) <= 365 },
    { key: 'big', label: 'Above 50k avg views', test: (c) => c.avgViews >= 50000 },
    /* Audience size, where "Above 50k avg views" is reach per video. The two come apart often
       enough to be worth separating: a small channel with one runaway video clears the views
       chip, and a large channel posting to a fraction of its subscribers clears this one. */
    { key: 'popular', label: 'Popular', test: (c) => c.subscribers >= 100000 },
    /* Monetization is not on the row — it costs three watch page reads per channel, so it is
       normally filled in only for rows on screen. This chip therefore works in two stages:
       newMonCandidate is free and narrows 50 channels to the handful worth asking about, and
       selecting the chip forces the verdict for exactly those. Without the pre-filter the
       sweep would be 150 page reads; with it, usually under a dozen. */
    { key: 'newmon', label: 'Newly monetized',
      test: (c) => newMonCandidate(c) && MON_STATE.get(c.handle) === 'likely-monetized' },
    { key: 'new', label: 'New channels',
      test: (c) => (daysSince(c.publishedAt) || 1e9) <= 180 },
    { key: 'active', label: 'Active this month',
      test: (c) => (daysSince(c.lastUpload) === null ? 1e9 : daysSince(c.lastUpload)) <= 31 }
  ];

  /* Old enough to have crossed the subscriber gate, young enough that crossing it must have
     been recent — a channel cannot have been monetized for longer than it has existed. Six
     months, as asked. Both figures come with the row, so this costs nothing to evaluate. */
  const NEWMON_MAX_AGE = 180;
  function newMonCandidate(c) {
    return (c.subscribers || 0) >= YPP_MIN_SUBS &&
      (daysSince(c.publishedAt) === null ? 1e9 : daysSince(c.publishedAt)) <= NEWMON_MAX_AGE;
  }

  /* handle -> verdict, for this page view. Filled by the lazy per-row hydration as well as by
     the sweep, so scrolling the list makes the chip cheaper without anyone asking it to. */
  const MON_STATE = new Map();
  const MON_SWEEP = { running: false, done: 0, total: 0 };

  const ROW_MONEY = {
    'likely-monetized': { label: 'Monetized', cls: 'ytc-mon--yes',
      tip: 'Ads run on most recent videos' },
    'likely-not': { label: 'Not monetized', cls: 'ytc-mon--no',
      tip: 'No ad slots on most recent videos' },
    'not-eligible': { label: 'Not eligible', cls: 'ytc-mon--off',
      tip: 'Under the 1,000 subscribers ad monetization requires' },
    unknown: { label: 'Unknown', cls: 'ytc-mon--off',
      tip: 'Could not read enough videos to judge' }
  };

  /* Average views against subscriber count: how far a channel reaches past the audience it
     has already earned. This is NOT the outlier score the rest of the extension computes for
     videos — that one divides by the channel's own lifetime average, and the index holds no
     per-video data for other channels. Same word, different denominator, so every tooltip
     here names the two numbers it divided. */
  /* Wording only. The thresholds are ratioTier's, so this can never drift from the colour. */
  const OUT_WORDS = {
    great: 'far past its subscriber base',
    good: 'well past its subscriber base',
    ok: 'past its subscriber base',
    low: 'below its subscriber count',
    poor: 'well below its subscriber count'
  };

  function outlierRatio(c) {
    if (!c || !c.subscribers || !c.avgViews) return 0;
    return c.avgViews / c.subscribers;
  }

  function outlierTitle(c, tier) {
    return 'Avg views (' + F.compact(c.avgViews) + ') \u00f7 subscribers (' +
      F.compact(c.subscribers) + ') \u2014 reaching ' + OUT_WORDS[tier];
  }

  /* The pill beside the channel's own name in the page header. Tiered on the rounded label
     rather than the raw ratio — otherwise two badges both reading "1.0×" can land in
     different colours, which reads as a rendering fault. */
  function outlierPill(c) {
    const r = outlierRatio(c);
    if (!r) return '';
    const shown = ratioLabel(r);
    const tier = ratioTier(shown.value);
    return '<span class="ytc-out ytc-out--' + tier + '" title="' +
      escapeHtml(outlierTitle(c, tier)) + '">' + shown.text + '</span>';
  }

  /* The same number as a table cell, on the same ladder, so a column scanned top to bottom
     sorts itself by eye before it is sorted by click. */
  function outlierCell(c) {
    const r = outlierRatio(c);
    if (!r) return '\u2014';
    const shown = ratioLabel(r);
    const tier = ratioTier(shown.value);
    return '<span class="ytc-onum ytc-onum--' + tier + '" title="' +
      escapeHtml(outlierTitle(c, tier)) + '">' + shown.text + '</span>';
  }

  /* Subscriber count settles the cheap half of the question: below the threshold nothing needs
     fetching, which is the same gate the channel badge uses. Above it the verdict costs watch
     page reads, so the pill starts as a placeholder and is filled in by hydrateRowMoney. */
  function monetizationPill(c) {
    const handle = c.handle || '';
    if (c.subscribers && c.subscribers < YPP_MIN_SUBS) {
      const m = ROW_MONEY['not-eligible'];
      return '<span class="ytc-mon ' + m.cls + '" title="' + m.tip + '">' + m.label + '</span>';
    }
    if (!handle.startsWith('@')) return '';
    return '<span class="ytc-mon ytc-mon--wait" data-mon="' + escapeHtml(handle) +
      '" title="Checking recent videos for ad slots">\u2026</span>';
  }

  /* Each verdict costs a few watch page reads, so this never runs ahead of the reader: a row
     is only checked once it is actually on screen, two at a time. Cached verdicts come back
     immediately and cost nothing, so scrolling back over seen rows is free. The breaker in the
     service worker still governs the rest. */
  let moneyQueue = [];
  let moneyBusy = 0;

  function pumpRowMoney() {
    while (moneyBusy < 2 && moneyQueue.length) {
      const el = moneyQueue.shift();
      if (!el.isConnected || !el.dataset.mon) continue;
      const key = el.dataset.mon;
      delete el.dataset.mon;              // claim it, so a re-observe cannot double-fetch
      moneyBusy++;
      sendMessage({ type: 'ytc-monetization', key }, (entry) => {
        moneyBusy--;
        if (!chrome.runtime.lastError && entry && entry.state) MON_STATE.set(key, entry.state);
        if (!chrome.runtime.lastError && el.isConnected) {
          const m = ROW_MONEY[(entry && entry.state)] || ROW_MONEY.unknown;
          el.className = 'ytc-mon ' + m.cls;
          el.textContent = m.label;
          el.title = m.tip +
            (entry && entry.checked ? ' (' + entry.withAds + ' of ' + entry.checked + ' checked)' : '');
        }
        pumpRowMoney();
      });
    }
  }

  /* Resolve every candidate the chip depends on. Two at a time, matching the per-row
     hydration, so a sweep and a scroll cannot together stampede the service worker's breaker.
     Cached verdicts return immediately and cost nothing, so re-selecting the chip is free. */
  function sweepMonetization(rows, onChange) {
    const pending = rows.filter((c) => newMonCandidate(c) &&
      (c.handle || '').startsWith('@') && !MON_STATE.has(c.handle));
    if (!pending.length || MON_SWEEP.running) return false;
    MON_SWEEP.running = true;
    MON_SWEEP.total = pending.length;
    MON_SWEEP.done = 0;
    let live = 0;
    /* Finishing is checked in two places — after the last response, and after a step that
       starts nothing — so it needs a latch. Without one the final redraw runs twice, which on
       a fifty-row table is a whole second rebuild for nothing. */
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      MON_SWEEP.running = false;
      onChange();
    };
    const step = () => {
      while (live < 2 && pending.length) {
        const c = pending.shift();
        live++;
        sendMessage({ type: 'ytc-monetization', key: c.handle }, (entry) => {
          live--;
          MON_SWEEP.done++;
          if (!chrome.runtime.lastError && entry && entry.state) {
            MON_STATE.set(c.handle, entry.state);
          } else {
            // Never leave a handle unresolved: an unrecorded failure would restart the sweep
            // on the next redraw and check it again, forever.
            MON_STATE.set(c.handle, 'unknown');
          }
          if (!live && !pending.length) finish();
          else onChange();
          step();
        });
      }
      if (!live && !pending.length) finish();
    };
    step();
    return true;
  }

  let moneyIO = null;

  function hydrateRowMoney(host) {
    // A chip or sort redraw replaces every row; the previous observer would otherwise sit on
    // detached nodes that can never intersect.
    if (moneyIO) { moneyIO.disconnect(); moneyIO = null; }
    const pending = host.querySelectorAll('.ytc-mon--wait[data-mon]');
    if (!pending.length) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        moneyQueue.push(e.target);
      }
      pumpRowMoney();
    }, { rootMargin: '100px' });
    moneyIO = io;
    pending.forEach((el) => io.observe(el));
  }

  function daysSince(iso) {
    const t = Date.parse(iso || '');
    if (!t) return null;
    return Math.max(0, Math.round((Date.now() - t) / 86400000));
  }

  /* Age reads in the largest unit that still says something: a channel opened last week is
     "3w", not "0.0y", and one opened years ago carries its months so two old channels are
     still tellable apart. */
  function ageLabel(iso) {
    const d = daysSince(iso);
    if (d === null) return '\u2014';
    if (d < 7) return d + 'd';
    if (d < 30) return Math.floor(d / 7) + 'w';
    if (d < 365) return Math.floor(d / 30) + 'mo';
    const y = Math.floor(d / 365);
    const mo = Math.floor((d % 365) / 30);
    return mo ? y + 'y ' + mo + 'mo' : y + 'y';
  }

  function agoLabel(iso) {
    const d = daysSince(iso);
    if (d === null) return '\u2014';
    if (d === 0) return 'today';
    if (d < 30) return d + 'd ago';
    if (d < 365) return Math.round(d / 30) + 'mo ago';
    return (d / 365).toFixed(1) + 'y ago';
  }

  /* These double as the table's columns. One definition drives the header, the sort and the
     cell, so a column can never end up sorting by something other than what it shows.

     "Age" sorts inverted deliberately: descending on a date means newest first, but the
     column reads as an age, and the largest age is the oldest channel. */
  const SIM_COLS = [
    { key: 'similarity', label: 'Similarity', cls: 'ytc-t__sim',
      get: (c) => c.similarity || 0,
      /* The dot marks a score that carries a search-agreement boost, so a reader comparing
         two rows can see that one of them is not resting on the embedding alone. Deliberately
         a mark and not a second number: the column is sorted and thresholded on one value. */
      cell: (c) => Math.round((c.similarity || 0) * 100) + '%' +
        ((c.searchHits || 0) > 0
          ? '<span class="ytc-t__agree" title="' + escapeHtml('Also ranked in YouTube’s ' +
            'own results for ' + c.searchHits + ' of this channel’s topics') + '">●</span>'
          : '') },
    { key: 'subs', label: 'Subscribers',
      get: (c) => c.subscribers || 0,
      cell: (c) => (c.subscribers ? F.compact(c.subscribers) : '\u2014') },
    { key: 'views', label: 'Avg views',
      get: (c) => c.avgViews || 0,
      cell: (c) => (c.avgViews ? F.compact(c.avgViews) : '\u2014') },
    /* Sits beside Avg views because it is that column divided by Subscribers — the two it
       is read against are its immediate neighbours. */
    { key: 'outlier', label: 'Outlier', cls: 'ytc-t__out',
      get: outlierRatio,
      cell: outlierCell },
    { key: 'uploads', label: 'Uploads/mo',
      get: (c) => c.uploadsPerMo || 0,
      cell: (c) => (c.uploadsPerMo ? Number(c.uploadsPerMo).toFixed(1) : '\u2014') },
    { key: 'age', label: 'Age',
      get: (c) => daysSince(c.publishedAt) || 0,
      cell: (c) => ageLabel(c.publishedAt) },
    { key: 'last', label: 'Last upload',
      get: (c) => Date.parse(c.lastUpload || 0) || 0,
      cell: (c) => agoLabel(c.lastUpload) }
  ];

  /* Shown while the lookup is in flight. Built from the same grid classes as the real
     table, so the rows that replace it land in the same columns instead of reflowing the
     page under the reader's eye. A lookup can take several seconds — long enough that a
     bare spinner reads as nothing happening. */
  function similarSkeleton() {
    const chips = '<div class="ytc-chips">' +
      [56, 92, 78, 86, 70].map((w) =>
        '<span class="ytc-sk ytc-sk--chip" style="width:' + w + 'px"></span>').join('') +
      '</div>';

    const head = '<div class="ytc-t__row ytc-t__row--head ytc-t__row--sk">' +
      '<span class="ytc-t__chan"><span class="ytc-sk ytc-sk--head"></span></span>' +
      SIM_COLS.map(() =>
        '<span class="ytc-t__c"><span class="ytc-sk ytc-sk--head"></span></span>').join('') +
      '</div>';

    /* Percentages of the names column, which the stylesheet stretches to fill its grid
       cell — so the block spans the container at any width. They still vary per row, so it
       reads as a list of different channels rather than a stack of identical bars. */
    const NAME_W = [88, 62, 96, 72, 84, 56, 78, 66];
    const rows = NAME_W.map((w) =>
      '<div class="ytc-t__row ytc-t__row--sk">' +
        '<span class="ytc-t__chan">' +
          '<span class="ytc-sk ytc-sk--pic"></span>' +
          '<span class="ytc-t__names">' +
            '<span class="ytc-sk ytc-sk--name" style="width:' + w + '%"></span>' +
            '<span class="ytc-sk ytc-sk--handle" style="width:' +
              Math.round(w * 0.55) + '%"></span>' +
          '</span>' +
        '</span>' +
        SIM_COLS.map(() =>
          '<span class="ytc-t__c"><span class="ytc-sk ytc-sk--cell"></span></span>').join('') +
      '</div>').join('');

    return '<div class="ytc-sk-view" aria-busy="true" aria-label="Loading similar channels">' +
      '<div class="ytc-t__bar">' +
        '<span class="ytc-t__title">Similar channels</span>' +
        '<span class="ytc-t__actions"><span class="ytc-sk ytc-sk--btn"></span></span>' +
      '</div>' + chips +
      '<div class="ytc-t">' + head + rows + '</div>' +
      '<p class="ytc-t__note"><span class="ytc-spin"></span> Searching\u2026</p>' +
    '</div>';
  }

  function renderSimilar(res) {
    const host = similarHost();
    if (!host) return;
    host.dataset.loaded = '1';

    const all = (res && res.channels) || [];
    const fromIndex = res && res.source === 'index';

    /* Chips only where the numbers behind them exist. The search fallback returns names, not
       stats, so a chip row there would filter on fields that are all undefined. */
    const chip = (fromIndex && SIM_CHIPS.find((x) => x.key === simFilter.chip)) || SIM_CHIPS[0];
    /* Selecting the chip is what pays for the verdicts; nothing is fetched until then. The
       redraw on each result is what turns the count from a spinner into a number. */
    const unchecked = !fromIndex ? 0 : all.filter((c) =>
      newMonCandidate(c) && (c.handle || '').startsWith('@') && !MON_STATE.has(c.handle)).length;
    if (fromIndex && chip.key === 'newmon' && unchecked) {
      sweepMonetization(all, () => renderSimilar(res));
    }
    const list = fromIndex ? all.filter(chip.test) : all;

    /* Confidence, not quantity, decides what is on screen. The fetch now asks for everything
       above the similarity floor, which in a well-populated niche is a hundred channels — and
       a hundred rows ordered by a score that has quietly stopped meaning anything by row
       forty is worse than fifty, not better. So the tail below the same threshold the "weak
       matches" warning already uses is folded away behind a reveal, and the reader is told it
       exists rather than being handed it as though it were equally trustworthy.

       Membership is decided by similarity alone, never by the sort column: sorting by
       subscribers must not promote a 0.36 match into the trusted block. Each block is then
       sorted independently, so revealing the tail appends rather than reshuffling what was
       already read. */
    let trusted = list, untrusted = [];
    if (fromIndex) {
      trusted = list.filter((c) => (c.similarity || 0) >= WEAK_BELOW);
      untrusted = list.filter((c) => (c.similarity || 0) < WEAK_BELOW);
      /* A niche where nothing clears the bar would otherwise render an empty table under a
         chip claiming matches. Promote the best few so there is always something to read. */
      if (trusted.length < TRUST_MIN_ROWS && untrusted.length) {
        const need = Math.min(TRUST_MIN_ROWS - trusted.length, untrusted.length);
        const best = new Set(untrusted.slice()
          .sort((a, b) => (b.similarity || 0) - (a.similarity || 0)).slice(0, need));
        trusted = trusted.concat(untrusted.filter((c) => best.has(c)));
        untrusted = untrusted.filter((c) => !best.has(c));
      }
    }
    const reveal = Math.max(0, Math.min(simFilter.reveal || 0, untrusted.length));
    const shownCount = trusted.length + reveal;

    const count = !all.length ? '' :
      ' <span class="ytc-t__count">(' + shownCount +
      (shownCount === all.length ? '' : ' of ' + all.length) + ')</span>';

    const chips = !fromIndex ? '' :
      '<div class="ytc-chips">' + SIM_CHIPS.map((x) => {
        // A chip that would empty the table is still shown, but says so rather than lying.
        const n = all.filter(x.test).length;
        /* This one chip cannot count itself without fetching. Showing 0 would grey it out and
           read as "none here", which is a claim we have not checked; a spinner says the honest
           thing, which is that we do not know yet. */
        const waiting = x.key === 'newmon' && unchecked;
        const count = waiting
          ? '<span class="ytc-chip__n"><span class="ytc-spin"></span></span>'
          : (x.key === 'all' ? '' : ' <span class="ytc-chip__n">' + n + '</span>');
        return '<button type="button" class="ytc-chip' +
          (x.key === chip.key ? ' ytc-chip--on' : '') +
          (n || waiting ? '' : ' ytc-chip--empty') +
          '" data-chip="' + x.key + '"' +
          (x.key === 'newmon' ? ' title="' + escapeHtml('Channels past 1,000 subscribers and ' +
            'under six months old, confirmed to be running ads. Selecting this checks each ' +
            'candidate\u2019s recent videos, which takes a moment.') + '"' : '') +
          '>' + escapeHtml(x.label) + count +
        '</button>';
      }).join('') + '</div>';

    const controls =
      '<div class="ytc-t__bar">' +
        '<span class="ytc-t__title">Similar channels' + count + '</span>' +
        '<span class="ytc-t__actions">' +
          (fromIndex
            ? '<button type="button" class="ytc-t__btn ytc-t__small' +
              (simFilter.smallOnly ? ' ytc-t__btn--on' : '') +
              '">Smaller than this</button>'
            : '') +
          '<button type="button" class="ytc-t__btn ytc-t__refresh">Refresh</button>' +
        '</span>' +
      '</div>' + chips;

    if (!all.length) {
      host.innerHTML = controls + '<p class="ytc-t__note">' +
        (res && res.reason ? escapeHtml(res.reason) : 'Nothing found for this channel') + '</p>';
      wireSimilarControls(host, res);
      maybeExpandNiche(res);   // nothing found is the strongest case for going to look
      return;
    }

    /* Filtered to nothing is a different state from found nothing, and saying so keeps the
       chips on screen so there is a way back out. */
    if (!list.length) {
      const searching = chip.key === 'newmon' && (MON_SWEEP.running || unchecked);
      host.innerHTML = controls + '<p class="ytc-t__note">' +
        (searching
          ? '<span class="ytc-spin"></span> Checking recent videos for ads on ' +
            MON_SWEEP.total + ' candidate' + (MON_SWEEP.total === 1 ? '' : 's') +
            (MON_SWEEP.total ? ' \u2014 ' + MON_SWEEP.done + ' of ' + MON_SWEEP.total +
              ' done' : '') + '\u2026'
          : 'No channels here match \u201c' + escapeHtml(chip.label) + '\u201d. ' +
            all.length + ' found in total.') +
      '</p>';
      wireSimilarControls(host, res);
      return;
    }

    let body;
    if (fromIndex) {
      const col = SIM_COLS.find((c) => c.key === simFilter.sort) || SIM_COLS[0];
      const dir = simFilter.desc ? 1 : -1;
      const sorted = list.slice().sort((a, b) => (col.get(b) - col.get(a)) * dir);

      /* An arrow on every column, filled on the active one. Without a direction control the
         table can only answer "who is biggest", never "who is smallest" — and the smallest
         channels in a niche are the ones worth finding. */
      const head = '<div class="ytc-t__row ytc-t__row--head">' +
        '<span class="ytc-t__chan">Channel</span>' +
        SIM_COLS.map((c) => {
          const on = simFilter.sort === c.key;
          /* One glyph family, dimmed when inactive. The up/down-pair character (U+21C5) is
             absent from Roboto and rendered as tofu boxes. */
          const arrow = (on && !simFilter.desc) ? '\u25B2' : '\u25BC';
          return '<button type="button" class="ytc-t__h' + (on ? ' ytc-t__h--on' : '') +
            '" data-col="' + c.key + '">' + c.label +
            '<span class="ytc-t__arrow' + (on ? '' : ' ytc-t__arrow--off') + '">' +
            arrow + '</span></button>';
        }).join('') + '</div>';

      /* Both blocks take the same comparator, so the chosen column still orders what is on
         screen — confidence is simply the outer sort. */
      const cmp = (a, b) => (col.get(b) - col.get(a)) * dir;
      const shownRows = trusted.slice().sort(cmp);
      const hiddenRows = untrusted.slice().sort(cmp);
      const rowFor = (c) => {
        const handle = c.handle || c.title || '';
        const img = c.avatar
          ? '<img class="ytc-t__pic" src="' + escapeHtml(c.avatar) + '" alt="" loading="lazy">'
          : '<span class="ytc-t__pic ytc-t__pic--none">' +
            escapeHtml((c.title || handle || '?').trim().charAt(0).toUpperCase()) + '</span>';
        return '<a class="ytc-t__row" href="https://www.youtube.com/' + encodeURI(handle) +
          '" target="_blank" rel="noopener noreferrer">' +
          '<span class="ytc-t__chan">' + img +
            '<span class="ytc-t__names">' +
              '<span class="ytc-t__nameline">' +
                '<span class="ytc-t__name">' + escapeHtml(c.title || handle) + '</span>' +
                monetizationPill(c) +
                /* On the name line, beside the monetization pill. It was a cell of its own at
                   the end of the row, but the header defines no column for it — so the grid
                   had one more cell in the body than in the head and wrapped the star onto a
                   line of its own. It belongs with the name in any case: it is a fact about
                   the channel, not another measurement of it. */
                (settings.showPockets
                  ? '<button type="button" class="ytc-t__star' +
                    (pocketsHolding(c).length ? ' ytc-t__star--on' : '') +
                    '" data-star="' + escapeHtml(handle) +
                    '" aria-label="Save to a pocket" title="Save to a pocket">' +
                    (pocketsHolding(c).length ? '\u2605' : '\u2606') + '</button>'
                  : '') +
              '</span>' +
              '<span class="ytc-t__handle">' + escapeHtml(handle) + '</span>' +
            '</span>' +
          '</span>' +
          SIM_COLS.map((c2) =>
            '<span class="ytc-t__c' + (c2.cls ? ' ' + c2.cls : '') + '">' +
            c2.cell(c) + '</span>').join('') +
        '</a>';
      };

      /* The row at the boundary is clipped and faded rather than hidden. A row half in view
         reads as "the list continues"; a clean edge reads as "the list ends", which is the
         one thing this must not say. */
      /* Every hidden row is in the DOM from the start, classed rather than omitted, so a drag
         can reveal them one at a time by touching classes instead of re-rendering a hundred
         rows on every pointer move. */
      const rows = shownRows.map(rowFor).join('') +
        hiddenRows.map((c, i) => {
          const cls = i < reveal ? '' : i === reveal ? ' ytc-t__row--peek' : ' ytc-t__row--extra';
          return cls
            ? rowFor(c).replace('class="ytc-t__row"', 'class="ytc-t__row' + cls + '"')
            : rowFor(c);
        }).join('');

      const left = hiddenRows.length - reveal;
      const grab = !hiddenRows.length ? '' :
        '<div class="ytc-t__grab' + (left ? '' : ' open') + '" role="button" tabindex="0"' +
          ' aria-expanded="' + (left ? 'false' : 'true') + '" title="' +
          escapeHtml('Drag down to reveal gradually, or click to show them all. Matches below '
            + Math.round(WEAK_BELOW * 100) + '% similarity are real results, but the score ' +
            'stops separating them from coincidence around here.') + '">' +
          '<span class="ytc-t__grip"></span>' +
          '<span class="ytc-t__grabtext">' +
            (left ? 'Show ' + left + ' lower-confidence match' + (left === 1 ? '' : 'es')
                  : 'Hide lower-confidence matches') + '</span>' +
        '</div>';

      body = '<div class="ytc-t">' + head + rows + '</div>' + grab;
    } else {
      body = '<div class="ytc-t">' + list.map((c) => {
        const handle = c.handle || c.title || '';
        return '<a class="ytc-t__row ytc-t__row--plain" href="https://www.youtube.com/' +
          encodeURI(handle) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="ytc-t__chan"><span class="ytc-t__pic ytc-t__pic--none">' +
          escapeHtml(handle.replace('@', '').charAt(0).toUpperCase()) + '</span>' +
          '<span class="ytc-t__names"><span class="ytc-t__name">' + escapeHtml(handle) +
          '</span></span></span>' +
          '<span class="ytc-t__c">' +
          (c.queries > 1 ? c.queries + ' topics' : 'rank ' + ((c.rank || 0) + 1)) +
          '</span></a>';
      }).join('') + '</div>';
    }

    /* A caveat about the whole list goes above the list, not under it. The descriptive note
       sits at the foot of the table, which is the right place for "here is how this was
       ranked" and the wrong place for "do not trust what you are about to read": at fifty
       rows the reader meets the confident percentages and never reaches the sentence
       explaining them. Same reason the load control was moved to the top of the filter
       modal. */
    let note, warn = '';
    if (fromIndex) {
      /* Say what was searched for, on this path too. The topics are derived from the
         channel's description, name and titles by a chain of heuristics that get it wrong
         often enough to matter, and a reader who can see "culturally rooted african stories"
         can tell at a glance whether the list under it is answering the right question. They
         were previously printed only on the fallback path, where the list is weakest and the
         explanation least useful. */
      const topics = (res.queries || []).length
        ? '. Topics searched: ' +
          (res.queries || []).map((q) => escapeHtml(q)).join('  \u00b7  ')
        : '';
      const agreed = list.filter((c) => (c.searchHits || 0) > 0).length;
      note = 'Ranked by topic similarity against the channel index' +
        (res.indexed ? '' : ' \u2014 this channel is not indexed yet, so its own page text was used') +
        (agreed ? ', with ' + agreed + ' also ranking in YouTube search for those topics' : '') +
        topics;
      const best = list.reduce((m, c) => Math.max(m, c.similarity || 0), 0);
      /* Two different failures used to read as the same "weak matches" warning, and only one
         of them is about the index. When the channel itself covers several unrelated subjects
         its average vector points between all of them, so the list is noise however well the
         index is seeded — and the percentages are the misleading part, because they stay
         confident while meaning nothing. Say which failure this is; it is the actionable
         difference between "seed this niche" and "there is nothing to seed against". */
      if (res.scattered) {
        warn = '<b>This channel covers several unrelated subjects.</b> There is no single ' +
          'topic to rank against, so the matches below are only loosely meaningful \u2014 ' +
          'whatever their percentages say.';
      } else if (best < WEAK_BELOW) {
        warn = '<b>Weak matches (best ' + Math.round(best * 100) + '%).</b> ' +
          'This niche is thinly indexed \u2014 the closest channels found are only loosely ' +
          'related.';
      }
    } else {
      note = 'Channels ranking for this channel\'s own topics: ' +
        (res.queries || []).map((q) => escapeHtml(q)).join('  \u00b7  ') +
        '. Found by searching YouTube, not by a similarity model.';
      if (res.indexProblem) {
        const hint = /40[34]/.test(res.indexProblem)
          ? 'Check the Index API URL includes its /k/&lt;token&gt; path. '
          : /not been seeded/.test(res.indexProblem)
            ? 'Seed this niche to get similarity scores and the Smaller filter. '
            : '';
        note = '<b>Index not used: ' + escapeHtml(res.indexProblem) + '.</b> ' + hint + note;
      }
    }

    /* Progress sits above the table, not in the footnote: rows appear one at a time as
       verdicts land, and a list that is still filling in looks identical to a finished one
       from the top of the page. */
    const progress = (chip.key === 'newmon' && (MON_SWEEP.running || unchecked))
      ? '<p class="ytc-t__note"><span class="ytc-spin"></span> Checking recent videos for ' +
        'ads \u2014 ' + MON_SWEEP.done + ' of ' + MON_SWEEP.total + ' candidates done' +
        '\u2026</p>'
      : '';
    host.innerHTML = controls + progress +
      (warn ? '<p class="ytc-t__warn">' + warn + '</p>' : '') +
      body + '<p class="ytc-t__note">' + note + '</p>';
    wireSimilarControls(host, res);
    maybeExpandNiche(res);
    /* Re-rendering (a chip, a sort) drops the old placeholders, so anything still queued
       against them is stale. */
    moneyQueue = [];
    hydrateRowMoney(host);
  }

  /* Drag to reveal gradually, click to reveal the lot.
     
     The rows are already in the DOM, hidden by class, so a drag retags them instead of
     re-rendering: a hundred-row rebuild per pointermove would stutter and would also destroy
     the element the pointer is captured on. State is only written back on release, which is
     what keeps the drag smooth and the re-render to exactly one.
     
     Pointer events rather than mouse, so a trackpad, a touchscreen and a pen all work from
     one path, and setPointerCapture keeps the gesture alive when the pointer leaves the
     handle — which it immediately does, because the handle moves down as rows appear. */
  function wireGrab(host, grab, res) {
    const table = host.querySelector('.ytc-t');
    if (!table) return;
    const hidden = Array.prototype.slice.call(
      table.querySelectorAll('.ytc-t__row--peek, .ytc-t__row--extra'));
    const already = simFilter.reveal || 0;
    const total = already + hidden.length;
    const label = grab.querySelector('.ytc-t__grabtext');

    // Measure a real row rather than trusting the constant: density differs with zoom.
    const sample = table.querySelector('.ytc-t__row:not(.ytc-t__row--head)');
    const rowH = (sample && sample.getBoundingClientRect().height) || SIM_ROW_H;

    let startY = 0, dragging = false, moved = false, shown = 0;
    let frame = 0, latestY = 0, pulled = 0;

    const apply = (n) => {
      n = Math.max(0, Math.min(n, hidden.length));
      if (n === shown) return;
      /* Nothing here scrolls the page. The handle sits below the table, so rows inserted above
         carry it down by exactly the height they add — which, at one row per row-height of
         travel, is the same distance the finger moved. Left alone it tracks the finger for
         free. An earlier version measured the handle and scrolled to hold it still, which
         pinned it in place and made the drag feel detached from the list it was opening. */
      /* Only the rows between the old and new positions change state. Retagging all of them
         was the stutter: ninety-three elements times three class operations, on an event that
         fires faster than the screen redraws. */
      for (let i = Math.min(n, shown); i <= Math.max(n, shown) && i < hidden.length; i++) {
        const el = hidden[i];
        el.classList.remove('ytc-t__row--extra', 'ytc-t__row--peek');
        if (i > n) el.classList.add('ytc-t__row--extra');
        else if (i === n) el.classList.add('ytc-t__row--peek');
      }
      shown = n;

      if (label) {
        const left = hidden.length - shown;
        label.textContent = left
          ? 'Show ' + left + ' lower-confidence match' + (left === 1 ? '' : 'es')
          : 'Hide lower-confidence matches';
      }
      grab.classList.toggle('open', shown >= hidden.length);
    };

    grab.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      dragging = true; moved = false; startY = e.clientY; latestY = e.clientY; pulled = 0;
      grab.classList.add('ytc-t__grab--drag');
      if (!frame) frame = requestAnimationFrame(tick);
      try { grab.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      e.preventDefault();
    });

    /* Pointermove only records where the finger is. The work happens on a frame loop, for two
       reasons: a trackpad emits moves faster than the screen redraws, so doing layout per
       event means doing it several times per painted frame; and at the bottom of the window
       the finger stops moving entirely while the list must keep opening. */
    grab.addEventListener('pointermove', (e) => {
      if (dragging) latestY = e.clientY;
    });

    /* Ninety-three rows is some four thousand pixels of travel — several screens. So the drag
       does not end at the bottom of the window: hold the finger there and the page scrolls
       under it, faster the closer to the edge, and every pixel scrolled counts as pull. That
       is the allowance that makes a long list openable by dragging at all. */
    const EDGE = 96;          // px from the bottom where the page starts moving
    const EDGE_MAX = 26;      // px per frame at the very edge
    const tick = () => {
      if (!dragging) { frame = 0; return; }
      const dy = latestY - startY;
      // A few pixels of travel is a click with a shaky hand, not a drag.
      if (moved || Math.abs(dy) >= 4) {
        moved = true;
        const room = window.innerHeight - latestY;
        if (room < EDGE) {
          const speed = Math.max(1,
            Math.round((1 - Math.max(room, 0) / EDGE) * EDGE_MAX));
          window.scrollBy(0, speed);
          // Counted whether or not the window could move: revealing rows is what makes the
          // page taller, so at the very bottom the scroll only becomes possible afterwards.
          pulled += speed;
        }
        apply(Math.round((dy + pulled) / rowH));
      }
      frame = requestAnimationFrame(tick);
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      grab.classList.remove('ytc-t__grab--drag');
      // A click reveals everything; a drag keeps exactly what was pulled into view.
      simFilter.reveal = moved ? already + shown
        : (already >= total ? 0 : total);
      renderSimilar(res);
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);

    // Keyboard: the handle is a control, so it has to work without a pointer at all.
    grab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        simFilter.reveal = already >= total ? 0 : total;
        renderSimilar(res);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        simFilter.reveal = Math.max(0, Math.min(total,
          already + (e.key === 'ArrowDown' ? 5 : -5)));
        renderSimilar(res);
      }
    });
  }

  function wireSimilarControls(host, res) {
    /* The star sits inside the row's own <a>, so both the navigation and the click have to be
       stopped before the chooser opens. Wired here rather than in rowFor because the rows are
       rebuilt as one innerHTML write and there is nothing to attach to until they exist. */
    host.querySelectorAll('[data-star]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const handle = b.dataset.star;
        const c = ((res && res.channels) || []).find((x) => (x.handle || x.title) === handle);
        if (c) openPocketDialog(c, b, () => renderSimilar(res), seedFromChip());
      });
    });

    const small = host.querySelector('.ytc-t__small');
    if (small) {
      small.addEventListener('click', () => {
        simFilter.smallOnly = !simFilter.smallOnly;
        askSimilar(true);
      });
    }
    const refresh = host.querySelector('.ytc-t__refresh');
    if (refresh) refresh.addEventListener('click', () => askSimilar(true, true));

    const grab = host.querySelector('.ytc-t__grab');
    if (grab) wireGrab(host, grab, res);

    // Chips re-filter what is already here, so they redraw rather than refetch.
    host.querySelectorAll('.ytc-chip').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        simFilter.chip = b.dataset.chip;
        // The tail belongs to the previous filter; carrying the reveal across would drop the
        // reader into a different list already expanded.
        simFilter.reveal = 0;
        renderSimilar(res);
      });
    });

    // Clicking the active column flips direction; another column takes over, descending.
    host.querySelectorAll('.ytc-t__h').forEach((h) => {
      h.addEventListener('click', (e) => {
        e.preventDefault();
        const key = h.dataset.col;
        if (simFilter.sort === key) simFilter.desc = !simFilter.desc;
        else { simFilter.sort = key; simFilter.desc = true; }
        renderSimilar(res);
      });
    });
  }

  /* Rendered into the channel page rather than floating over it, reached by a tab beside
     YouTube's own. A list of channels with six figures each needs the width, and a tab is
     where a reader already looks for another view of a channel. */
  const TAB_LABEL = 'Similar Channels';


  /* Which element the panels stand in front of.

     This was one querySelector with three comma-separated selectors, which does NOT mean
     "the first selector that matches" — it means the element earliest in DOCUMENT ORDER
     matching any of them. So what came back depended on what YouTube had rendered at that
     instant, and it changed between calls. `#contents` is the dangerous one: it is a bare id
     YouTube reuses all over a channel page, in the header and inside shelves as well as
     around the grid.

     That is what made the panel open onto nothing. The host is inserted as a SIBLING of
     whatever this returned at the time. If a later call returned a different element that
     happened to be an ANCESTOR of the host, `content.style.display = 'none'` hid the panel
     along with the page — tab lit, body blank — and since the host was then found and reused
     by class alone, the bad placement stuck for the rest of the page's life.

     Now: an explicit priority order, and within the winning selector the OUTERMOST match, so
     no other candidate can be nested around the panel.

     And one more thing document order gets wrong, which is what made the tabs look dead when
     the reader arrived from the home feed. The SPA does not throw the previous page away: it
     parks it in the document, hidden, and builds the new one after it. So on a channel opened
     by clicking a video's channel name, the home feed's own
     `ytd-two-column-browse-results-renderer` is still there — matching the first selector,
     and EARLIER in document order than the channel's. The panel was then inserted beside a
     parked page and hidden along with it: the click registered, the tab did not light, and
     nothing was drawn. Loading the same channel URL directly left only one match, so it
     worked, which is what made this look intermittent.

     So: search the live channel browse first, and never accept a candidate that is sitting
     inside a parked page. Every other lookup in this file has learned the same lesson —
     `CHANNEL_SCOPES` filters `[hidden]`, `tabBarCandidates` checks the box — this one had
     not. */
  const CHANNEL_BROWSE = 'ytd-browse[page-subtype="channels"]';

  /* Relative to the channel browse, so `#contents` is no longer the bare id it was. */
  const PAGE_CONTENT_SELECTORS = [
    'ytd-two-column-browse-results-renderer',
    'ytd-section-list-renderer',
    '#contents'
  ];

  /* Which element we actually hid, remembered rather than looked up again on the way out.
     Restoring "whatever pageContent() returns now" is how a channel page gets left
     permanently blank: if the answer moved while the panel was open, the element still
     carrying display:none is not the one that gets cleared.

     Declared up here because parked() reads it. */
  let hiddenContent = null;

  /* Is this element part of a page the SPA has parked?

     Two ways YouTube puts one aside, and both have to count: the `hidden` attribute on the
     page element, and a plain display:none. The second is why this measures the box rather
     than only reading attributes — with one exception, the content WE hid to make room for a
     panel. That one is not stale, it is the very element the open panel stands in front of,
     and treating it as stale would send every re-home to a different element and hide the
     page twice over. */
  function parked(el) {
    if (!el || !el.isConnected) return true;
    if (el.closest('[hidden]')) return true;
    if (el === hiddenContent) return false;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  }

  function outermost(list) {
    return list.find((el) => !list.some((o) => o !== el && o.contains(el))) || list[0] || null;
  }

  function liveChannelBrowse() {
    return Array.from(document.querySelectorAll(CHANNEL_BROWSE)).find((el) => !parked(el)) || null;
  }

  function pageContent() {
    const scope = liveChannelBrowse();
    if (scope) {
      for (const sel of PAGE_CONTENT_SELECTORS) {
        const all = Array.from(scope.querySelectorAll(sel)).filter((el) => !parked(el));
        if (all.length) return outermost(all);
      }
      return null;
    }
    /* No page-subtype to scope by — re-skinned or not yet hydrated markup. Only the first
       selector is safe unscoped; `#contents` on its own is the bare id this all started with. */
    const all = Array.from(document.querySelectorAll(PAGE_CONTENT_SELECTORS[0]))
      .filter((el) => !parked(el));
    return all.length ? outermost(all) : null;
  }

  /* Keep a panel a sibling of the content it replaces.

     YouTube re-renders the channel body on its own tabs and when hydration finishes, which
     can leave a panel inserted next to an element that is no longer the one being hidden.
     Re-homing makes the two siblings again, and siblings are the whole guarantee: an element
     cannot be an ancestor of its own sibling, so hiding one can never hide the other. */
  function homePanel(host, content) {
    if (!host || !content || !content.parentElement) return;
    if (host.parentElement !== content.parentElement) {
      content.parentElement.insertBefore(host, content);
    }
  }

  /* Hide the page for a panel, but never hide the panel with it. The re-home above should
     make this unreachable; it is here because the symptom it prevents is silent — an empty
     panel under a lit tab, with nothing in the console to say why. */
  function hideForPanel(content, host) {
    if (!content) return;
    if (host && content.contains(host)) return;
    if (hiddenContent && hiddenContent !== content) hiddenContent.style.display = '';
    hiddenContent = content;
    content.style.display = 'none';
  }

  function showPageContent() {
    if (hiddenContent) { hiddenContent.style.display = ''; hiddenContent = null; }
    const now = pageContent();
    if (now) now.style.display = '';
  }

  /* Which of our two tabs is which. `.ytc-tab` alone is NOT "the Similar Channels tab": the
     Analytics tab carries both classes, so every place that lit `.ytc-tab` lit the pair, and
     the two underlines met to read as one wide selection across both. */
  const TAB_SIM_SELECTOR = '.ytc-tab:not(.ytc-tab--an)';
  const TAB_AN_SELECTOR = '.ytc-tab--an';

  /* YouTube's own selected tab, across the markups the row has worn. A selector that matches
     nothing costs nothing — YouTube's tab is simply left as it was. */
  const YT_SELECTED_TAB = ['yt-tab-shape[aria-selected="true"]',
                           'yt-tab-shape[tab-selected]',
                           '.yt-tab-shape-wiz--sel',
                           'tp-yt-paper-tab.iron-selected',
                           'tp-yt-paper-tab[aria-selected="true"]'].join(', ');

  /* How YouTube marks the selected tab, rather than how it draws it.

     Overriding the drawing was the wrong lever and it only half worked: the label dimmed,
     because the label's weight and colour sit on the element our selector reached, but the
     underline stayed. The bar is a child element whose look YouTube owns, and guessing which
     property paints it — opacity, background, border, a pseudo-element — is a guess that has
     to be re-made every time the tab row is re-skinned.

     So do not fight the drawing. Take away the marker it keys off and let YouTube draw the
     tab as unselected itself, which is exactly the look we want and is by definition correct
     for whatever markup ships. Both class names are stripped:

       <div class="ytTabShapeTab ytTabShapeTabSelected">Home</div>
       <div class="ytTabShapeTabBar ytTabShapeTabBarSelected"></div>

     Every class removed is recorded with the element it came off, so putting the tab back is
     exact rather than reconstructed. Note the MutationObserver watches childList only, not
     attributes — so our own class edits cannot feed back into a scan and loop. */
  const YT_SELECTED_CLASSES = ['ytTabShapeTabSelected', 'ytTabShapeTabBarSelected',
                               'yt-tab-shape-wiz--sel', 'iron-selected'];
  const YT_TAB_PARTS = '.ytTabShapeTab, .ytTabShapeTabBar, .yt-tab-shape-wiz__tab, .indicator';

  /* And the other half of the marker, which is the half that was still showing.

     Stripping the classes alone did not put the underline out, and neither did overriding the
     paint before that — so the rule that draws it is not keyed on a class we can see. That
     leaves the attribute: `yt-tab-shape[aria-selected="true"] …` styles the tab from the host,
     and no amount of work on the children reaches it.

     Rather than hunt for the one declaration that paints the bar, take away every marker a
     selected-state rule could possibly key on and let YouTube draw an unselected tab. The
     label going quiet while the underline stayed was the tell: that was OUR font-weight
     override landing, not YouTube's selected styling lifting. */
  /* [element, className] pairs, to be added back exactly as they were. */
  let mutedClasses = [];
  /* [element, attribute, previousValue] triples, same idea. */
  let mutedAttrs = [];

  /* And the underline itself, which is not part of the tab at all — the reason three passes
     at quieting <yt-tab-shape> changed the label and never touched the line.

     Read off a live channel page: the tab's own bar measures 0px tall and transparent, and
     the row draws a single shared one instead —

       <div class="tabGroupShapeSlider tabGroupShapeSliderTransition"></div>   48x2, #0f0f0f

     absolutely positioned, a sibling of the tabs, slid under whichever tab is selected. So
     the underline lives outside the element every previous selector was scoped to. Hide the
     slider and the row carries no selection mark at all, which is the truth while our panel
     is the thing on screen — our own tab draws its own.

     Inline and !important, because this is a one-element override against a stylesheet we do
     not control, and the previous inline value is kept so the restore is exact. */
  const YT_SLIDER = '.tabGroupShapeSlider, .yt-tab-group-shape-wiz__slider, #selectionBar';

  /* [element, previousInlineOpacity, previousPriority] triples. */
  let mutedSliders = [];

  function muteYtSlider(bar) {
    for (const el of bar.querySelectorAll(YT_SLIDER)) {
      // Candidate rows nest, so the same slider can be reached twice in one pass.
      if (el.style.getPropertyValue('opacity') === '0') continue;
      mutedSliders.push([el, el.style.getPropertyValue('opacity'),
                         el.style.getPropertyPriority('opacity')]);
      el.style.setProperty('opacity', '0', 'important');
    }
  }

  function unmuteYtTabs() {
    for (const [el, cls] of mutedClasses) el.classList.add(cls);
    mutedClasses = [];
    for (const [el, attr, was] of mutedAttrs) el.setAttribute(attr, was);
    mutedAttrs = [];
    for (const [el, was, pri] of mutedSliders) {
      if (was) el.style.setProperty('opacity', was, pri);
      else el.style.removeProperty('opacity');
    }
    mutedSliders = [];
    document.querySelectorAll('.ytc-yt-tab--muted')
      .forEach((t) => t.classList.remove('ytc-yt-tab--muted'));
  }

  function muteYtTab(tab) {
    tab.classList.add('ytc-yt-tab--muted');
    for (const el of [tab, ...tab.querySelectorAll(YT_TAB_PARTS)]) {
      for (const cls of YT_SELECTED_CLASSES) {
        if (!el.classList.contains(cls)) continue;
        el.classList.remove(cls);
        mutedClasses.push([el, cls]);
      }
    }
    /* aria-selected is a real tri-state string, so it is set rather than removed. This is
       also the more truthful value while a panel is up: YouTube's tab is not the one showing
       its content, and our own tab below says aria-selected="true" in its place. */
    if (tab.getAttribute('aria-selected') === 'true') {
      mutedAttrs.push([tab, 'aria-selected', 'true']);
      tab.setAttribute('aria-selected', 'false');
    }
    /* The rest are boolean attributes, where presence is the whole signal. */
    for (const attr of ['selected', 'tab-selected']) {
      if (!tab.hasAttribute(attr)) continue;
      mutedAttrs.push([tab, attr, tab.getAttribute(attr)]);
      tab.removeAttribute(attr);
    }
  }

  /* One writer for the lit state of the row, derived from the open flags.

     There were five, each toggling a class at its own call site, and they did not agree —
     which is how a single open panel could leave two tabs underlined. Deriving the whole row
     from `simFilter.open` and `analyticsOpen` makes disagreement impossible: whatever the
     flags say is what the row shows, every time it is called. */
  function syncTabState() {
    const simOn = simFilter.open;
    const anOn = analyticsOpen;
    /* Our tabs carry role="tab" inside YouTube's own role="tablist", so aria-selected moves
       with the underline — otherwise muting YouTube's tab would leave the row claiming that
       nothing at all is selected. */
    const light = (sel, on) => document.querySelectorAll(sel).forEach((t) => {
      t.classList.toggle('ytc-tab--on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    light(TAB_SIM_SELECTOR, simOn);
    light(TAB_AN_SELECTOR, anOn);

    /* And YouTube's own tab, which went on claiming to be selected while our panel stood in
       front of the content it names — the third underline in the row. Muted for as long as we
       are the thing on screen; it is still a live tab, with its aria-selected untouched, and
       clicking it still puts the page back. */
    unmuteYtTabs();
    if (!simOn && !anOn) return;
    for (const bar of tabBarCandidates()) {
      bar.querySelectorAll(YT_SELECTED_TAB).forEach(muteYtTab);
      muteYtSlider(bar);
    }
  }

  /* Put the open view back after YouTube has rebuilt the page underneath it.

     The channel body is re-rendered on YouTube's own tabs, when hydration finishes, and on
     navigations that do not change the URL — any of which can restore the content we hid,
     move the container the panel lives in, or rebuild the tab row without our active class.
     Called from every scan; when nothing has moved it is a few property reads. */
  function reassertPanels() {
    if (!settings.showSimilar || !channelKeyFromLocation()) return;
    if (!simFilter.open && !analyticsOpen) return;
    const content = pageContent();
    const host = simFilter.open ? similarHost() : analyticsHost();
    if (!host) return;
    homePanel(host, content);
    hideForPanel(content, host);
    host.style.display = '';
    // The same writer the open functions use, so a rebuilt tab row lights up the same way.
    syncTabState();

    /* A host that was destroyed with the container comes back from similarHost() empty, and
       an empty panel under a lit tab is the very thing this function exists to prevent. Fill
       it once — the skeleton lands synchronously, so the next scan sees children and stops. */
    if (!host.childNodes.length) {
      delete host.dataset.loaded;
      if (simFilter.open) { host.innerHTML = similarSkeleton(); askSimilar(false); }
      else { host.innerHTML = analyticsSkeleton(); askAnalytics(false); }
    }
  }

  /* ------------------------------------------------------- analytics panel */

  const ANALYTICS_LABEL = 'Analytics';

  function analyticsHost() {
    const content = pageContent();
    let host = document.querySelector('.ytc-an');
    if (host) { homePanel(host, content); return host; }
    if (!content || !content.parentElement) return null;
    host = document.createElement('div');
    host.className = 'ytc-an';
    host.style.display = 'none';
    content.parentElement.insertBefore(host, content);
    return host;
  }

  function closeAnalyticsView() {
    analyticsOpen = false;
    showPageContent();
    syncTabState();
    const host = document.querySelector('.ytc-an');
    if (host) host.style.display = 'none';
  }

  let analyticsOpen = false;

  /* A click that cannot place its panel yet must not read as a dead tab.

     Both open functions set their open flag before they look for a host, so reassertPanels()
     finishes the job on the next scan. But scans are driven by mutations, and a channel page
     that has gone quiet may not produce one — so the flag sat there true and the click looked
     ignored. These are the retries that make it mean something, plus a line in the console so
     the next report of this has something to stand on. */
  const OPEN_RETRIES = [150, 400, 1000, 2500];

  function retryOpenPanel(what) {
    console.warn('[YouTube Toolkit] ' + what + ' has nowhere to open yet \u2014 retrying.');
    for (const delay of OPEN_RETRIES) setTimeout(scan, delay);
  }

  function openAnalyticsView() {
    closeSimilarView();
    analyticsOpen = true;
    const host = analyticsHost();
    if (!host) { retryOpenPanel('Analytics'); return; }
    const content = pageContent();
    homePanel(host, content);
    hideForPanel(content, host);
    syncTabState();
    host.style.display = '';
    if (!host.dataset.loaded) host.innerHTML = analyticsSkeleton();
    askAnalytics(false);
  }

  function askAnalytics(force) {
    const key = channelKeyFromLocation();
    if (!key) return;
    sendMessage({ type: 'ytc-analytics', key, force }, (res) => {
      if (chrome.runtime.lastError) {
        renderAnalytics({ ok: false, reason: 'Extension reloaded \u2014 refresh this tab' });
        return;
      }
      if (channelKeyFromLocation() !== key) return;
      renderAnalytics(res);
    });
  }

  /* Shortest first: the panel reports on the first of these that contains any upload. The
     last one has no cut-off, so a channel whose sample is entirely older than a year still
     gets figures instead of a blank card. */
  const ANALYTICS_WINDOWS = [
    { days: 28, label: 'the last 28 days', short: '' },
    { days: 90, label: 'the last 90 days', short: '90 days' },
    { days: 365, label: 'the last 12 months', short: '12 months' },
    { days: Infinity, label: 'the whole sample', short: 'all uploads' }
  ];

  /* Range buttons redraw the whole panel; the tooltip does not. Hovering a point must not
     rebuild the analytics tab underneath the cursor, so the tip is moved and filled in place
     and the SVG is left alone. */
  function wireChart(host, res) {
    const chart = host.querySelector('.ytc-an__chart');
    if (!chart) return;

    chart.querySelectorAll('.ytc-an__range').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const key = b.dataset.range;
        anChart.range = key;
        anChart.error = '';
        const range = CHART_RANGES.find((r) => r.key === key);
        const data = rangeData(res, key);
        /* Already covered by the sample, or already fetched once: draw immediately. Only a
           window the fifty uploads cannot reach costs a request. */
        if (data.enough || !range) { renderAnalytics(res); return; }

        anChart.loading = true;
        renderAnalytics(res);
        sendMessage({ type: 'ytc-channel-videos', key: channelKeyFromLocation(),
                      channelId: (res && res.channelId) || null,
                      days: rangeDays(range) }, (out) => {
          anChart.loading = false;
          if (chrome.runtime.lastError || !out || !out.ok) {
            // Keep the sample on screen rather than blanking the chart; say why it is partial.
            anChart.error = 'Could not load the full ' + range.label.toLowerCase() +
              '. Showing what the panel already had.';
            anChart.byRange[key] = { videos: (res && res.videos) || [], truncated: true };
          } else {
            anChart.byRange[key] = { videos: out.videos || [], truncated: !!out.truncated };
          }
          if (anChart.range === key) renderAnalytics(res);
        });
      });
    });

    const plot = chart.querySelector('.ytc-an__plot');
    const tip = chart.querySelector('.ytc-an__tip');
    if (!plot || !tip) return;
    const rangeKey = anChart.range || autoRange((res && res.videos) || []);
    const range = CHART_RANGES.find((r) => r.key === rangeKey) || CHART_RANGES[3];
    const bins = bucketize(rangeData(res, rangeKey).videos, range);
    const noun = BUCKET_NOUN[range.unit];

    const show = (dot) => {
      const b = bins[Number(dot.dataset.i)];
      if (!b) return;
      tip.innerHTML = '<b>' + escapeHtml(b.label) + '</b>' +
        '<span>' + b.count + ' upload' + (b.count === 1 ? '' : 's') +
          ' this ' + noun + '</span>' +
        '<em>' + F.compact(b.views) + ' views</em>';
      tip.hidden = false;
      /* Positioned from the dot's own box rather than the pointer, so the tip does not
         jitter under a moving cursor, and flipped left near the right edge so it cannot be
         clipped by the panel. */
      const box = plot.getBoundingClientRect();
      const d = dot.getBoundingClientRect();
      const left = d.left - box.left + d.width / 2;
      const flip = left > box.width * 0.6;
      tip.style.left = flip ? 'auto' : left + 12 + 'px';
      tip.style.right = flip ? (box.width - left + 12) + 'px' : 'auto';
      tip.style.top = Math.max(0, d.top - box.top - 8) + 'px';
      dot.classList.add('on');
    };
    const hide = (dot) => { tip.hidden = true; if (dot) dot.classList.remove('on'); };

    chart.querySelectorAll('.ytc-an__pt').forEach((dot) => {
      dot.addEventListener('mouseenter', () => show(dot));
      dot.addEventListener('mouseleave', () => hide(dot));
      // Touch has no hover: a tap shows the tip, and the next tap elsewhere clears it.
      dot.addEventListener('click', (e) => { e.preventDefault(); show(dot); });
    });
    plot.addEventListener('mouseleave', () => hide(null));
  }

  /* Views of recent posts: one point per upload, at the date it went out.
     
     Plotting views against publish date is the one honest chart this data supports. It is not
     a timeline of views received — no public page reports that, and an old video goes on
     earning long after its point on this chart stops moving. It answers a narrower question:
     how did each post do, and is the recent run above or below the channel's usual. */
  /* Each range plots totals per period, not one dot per upload. A channel posting thirteen
     times a day put 388 points on a month and they merged into a smear with no shape in it:
     the question "how is this channel doing lately" is answered by what a day earned, not by
     where each individual video landed. Buckets are calendar-aligned rather than rolling, so
     a day means a day and a month boundary falls where the reader expects it. */
  const CHART_RANGES = [
    { key: 'day', label: 'Day', days: 1, unit: 'hour', buckets: 24 },
    { key: 'week', label: 'Week', days: 7, unit: 'day', buckets: 7 },
    { key: 'month', label: 'Month', days: 30, unit: 'day', buckets: 30 },
    { key: 'year', label: 'Year', days: 365, unit: 'month', buckets: 12 }
  ];

  const BUCKET_NOUN = { hour: 'hour', day: 'day', month: 'month' };

  /* Where the oldest bucket begins. Buckets are calendar-aligned, so this is not the same as
     "now minus range.days": twelve calendar months back from today starts on the first of a
     month, somewhere between 335 and 365 days ago. Fetching by the nominal 365 would pull
     videos that fall before the first bucket and then drop them without a word, which is the
     kind of silent discard that makes a chart quietly wrong. Everything asks this instead. */
  function windowStart(range) {
    const d = new Date();
    const back = range.buckets - 1;
    if (range.unit === 'hour') { d.setMinutes(0, 0, 0); d.setHours(d.getHours() - back); }
    else if (range.unit === 'day') { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back); }
    else { d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() - back); }
    return d.getTime();
  }

  function rangeDays(range) {
    return Math.max(1, Math.ceil((Date.now() - windowStart(range)) / 86400000));
  }

  function bucketKey(d, unit) {
    const p = d.getFullYear() + '-' + d.getMonth();
    if (unit === 'month') return p;
    const day = p + '-' + d.getDate();
    return unit === 'day' ? day : day + '-' + d.getHours();
  }

  function bucketLabel(d, unit) {
    if (unit === 'hour') {
      return d.toLocaleTimeString(undefined, { hour: 'numeric' });
    }
    if (unit === 'day') {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }

  /* Views of everything published in each period, oldest first. Empty periods are kept and
     plotted as zero: a week with no upload earned nothing, and dropping it would draw a line
     straight over the gap as though the channel had been steady. */
  function bucketize(videos, range) {
    const out = [], byKey = new Map();
    const base = new Date();
    for (let i = range.buckets - 1; i >= 0; i--) {
      const d = new Date(base);
      if (range.unit === 'hour') { d.setMinutes(0, 0, 0); d.setHours(d.getHours() - i); }
      else if (range.unit === 'day') { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); }
      else { d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() - i); }
      const b = { t: d.getTime(), label: bucketLabel(d, range.unit), views: 0, count: 0 };
      out.push(b);
      byKey.set(bucketKey(d, range.unit), b);
    }
    for (const v of videos) {
      if (!v.publishedAt || v.views == null) continue;
      const d = new Date(v.publishedAt);
      if (isNaN(d.getTime())) continue;
      const b = byKey.get(bucketKey(d, range.unit));
      if (!b) continue;                 // outside the window
      b.views += v.views;
      b.count++;
    }
    return out;
  }
  /* null means "pick one that has something in it". A channel uploading twice a year opened
     on Day, saw an empty box, and had no reason to think the chart worked at all. */
  /* Keyed by channel. byRange holds uploads fetched for a period, and the period alone is not
     a sufficient key: walking from one channel to the next reused the first one's videos under
     the second one's name, which is a wrong chart rather than a stale one. The range choice
     resets too — it was picked for a channel whose upload rate the next one need not share. */
  /* timeAxis/timeMetric are reader preferences rather than channel data, so resetChart
     leaves them alone: someone who reads every channel by weekday should not have to
     press Weekday again on each one. */
  const anChart = { key: '', range: null, byRange: {}, loading: false, error: '',
                    timeAxis: 'hour', timeMetric: 'avg' };

  function resetChart(key) {
    anChart.key = key;
    anChart.range = null;
    anChart.byRange = {};
    anChart.loading = false;
    anChart.error = '';
  }

  /* The panel's own fifty uploads cover a period this channel actually spans, or they do not.
     UFC posts thirteen times a day, so its most recent fifty are two days — which under a
     button marked Year is simply a false statement. When the sample cannot reach back as far
     as the button claims, the real range has to be fetched. */
  function rangeData(res, key) {
    const range = CHART_RANGES.find((r) => r.key === key);
    if (!range) return { videos: [], enough: true };
    const fetched = anChart.byRange[key];
    if (fetched) return { videos: fetched.videos, enough: true, truncated: fetched.truncated };
    const have = (res && res.videos) || [];
    const oldest = have.reduce((m, v) => {
      const d = daysSince(v.publishedAt);
      return d == null ? m : Math.max(m, d);
    }, 0);
    /* The sample suffices only if it reaches past the window: if its oldest upload is still
       inside the period, there is more out there that it never saw. */
    return { videos: have, enough: oldest >= rangeDays(range) || have.length < 50 };
  }

  function chartPoints(videos, days) {
    return videos
      .filter((v) => v.views != null && v.publishedAt && daysSince(v.publishedAt) != null)
      .filter((v) => daysSince(v.publishedAt) <= days)
      .slice()
      .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  }

  /* The shortest range that holds enough posts to draw a line rather than a dot. */
  function autoRange(videos) {
    for (const r of CHART_RANGES) {
      if (chartPoints(videos, rangeDays(r)).length >= 3) return r.key;
    }
    return 'year';
  }

  function medianOf(nums) {
    if (!nums.length) return null;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function viewsChartHtml(res) {
    const sample = (res && res.videos) || [];
    const rangeKey = anChart.range || autoRange(sample);
    const range = CHART_RANGES.find((r) => r.key === rangeKey) || CHART_RANGES[3];
    const data = rangeData(res, rangeKey);
    const videos = data.videos;
    const pts = chartPoints(videos, rangeDays(range));
    const unitNoun = BUCKET_NOUN[range.unit];

    const tabs = '<div class="ytc-an__ranges">' + CHART_RANGES.map((r) => {
      const d = rangeData(res, r.key);
      const n = chartPoints(d.videos, rangeDays(r)).length;
      /* "At least" whenever the sample cannot see the whole window, because the number is
         then a floor rather than a count and must not be read as the latter. */
      const sure = d.enough;
      return '<button type="button" class="ytc-an__range' +
        (r.key === rangeKey ? ' on' : '') + (sure && !n ? ' empty' : '') +
        '" data-range="' + r.key + '" title="' +
        escapeHtml((sure ? '' : 'At least ') + n + ' upload' + (n === 1 ? '' : 's') +
          ' in the last ' + (r.unit === 'hour' ? '24 hours' : rangeDays(r) + ' days') +
          (sure ? '' : ' \u2014 select to load the full period')) + '">' +
        r.label + '</button>';
    }).join('') + '</div>';

    /* Named for what is plotted. It was "Views of recent posts" when each dot was a post;
       each dot is now a period, and a title describing the old shape would misread the new one. */
    const head = '<div class="ytc-an__charthead">' +
      '<span class="ytc-an__label">Views per ' + unitNoun + '</span>' + tabs + '</div>';

    if (anChart.loading) {
      return '<div class="ytc-an__chart">' + head +
        '<p class="ytc-an__note"><span class="ytc-spin"></span> Loading ' +
        escapeHtml(range.label.toLowerCase()) + ' of uploads\u2026</p></div>';
    }
    if (anChart.error) {
      return '<div class="ytc-an__chart">' + head +
        '<p class="ytc-an__note">' + escapeHtml(anChart.error) + '</p></div>';
    }
    if (!pts.length) {
      return '<div class="ytc-an__chart">' + head +
        '<p class="ytc-an__note">No uploads in this range. Try a longer one.</p></div>';
    }

    const bins = bucketize(videos, range);
    const noun = unitNoun;
    const W = 640, H = 190, padL = 10, padR = 10, padT = 16, padB = 26;
    const maxV = Math.max.apply(null, bins.map((b) => b.views)) || 1;
    const step = bins.length > 1 ? (W - padL - padR) / (bins.length - 1) : 0;
    const x = (i) => padL + i * step;
    /* From zero, not from the smallest bucket. A floor at the minimum turns an ordinary run
       into a mountain range and makes every channel look equally volatile. */
    const y = (n) => padT + (1 - n / maxV) * (H - padT - padB);

    /* Median across periods that actually had an upload. Including the empty ones would put
       the line on the axis for any channel that does not post daily, which describes the
       calendar rather than the channel. */
    const active = bins.filter((b) => b.count);
    const med = medianOf(active.map((b) => b.views));

    const line = '<polyline class="ytc-an__line" points="' +
      bins.map((b, i) => x(i).toFixed(1) + ',' + y(b.views).toFixed(1)).join(' ') +
      '"></polyline>';
    const r = bins.length > 20 ? 3 : 4;
    const dots = bins.map((b, i) =>
      '<circle class="ytc-an__pt" cx="' + x(i).toFixed(1) + '" cy="' +
        y(b.views).toFixed(1) + '" r="' + r + '" data-i="' + i + '"></circle>').join('');

    const total = bins.reduce((a, b) => a + b.views, 0);
    const uploads = bins.reduce((a, b) => a + b.count, 0);

    return '<div class="ytc-an__chart">' + head +
      '<div class="ytc-an__plot">' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
          'class="ytc-an__svg" role="img" aria-label="Views per ' + noun + '">' +
          (med == null ? '' :
            '<line class="ytc-an__median" x1="' + padL + '" x2="' + (W - padR) +
              '" y1="' + y(med).toFixed(1) + '" y2="' + y(med).toFixed(1) + '"></line>') +
          line + dots +
        '</svg>' +
        /* Pinned to the median line's own height rather than to a corner. The SVG is 190
           units tall and rendered at 190px, so a viewBox y is a pixel y and the label can sit
           on the line it names — where it cannot drift into whatever happens to occupy the
           bottom right, which on a falling line is the line itself. */
        (med == null ? '' : '<span class="ytc-an__medlabel" style="top:' +
          y(med).toFixed(1) + 'px">Median ' +
          F.compact(Math.round(med)) + '/' + noun + '</span>') +
        '<div class="ytc-an__tip" hidden></div>' +
      '</div>' +
      '<div class="ytc-an__axis"><span>' + escapeHtml(bins[0].label) +
        '</span><span>' + F.compact(total) + ' views \u00b7 ' + uploads + ' upload' +
        (uploads === 1 ? '' : 's') + (data.truncated ? ' \u00b7 capped' : '') +
        '</span><span>' + escapeHtml(bins[bins.length - 1].label) + '</span></div>' +
      (data.truncated
        ? '<p class="ytc-an__note ytc-an__note--cap">This channel uploads faster than the ' +
          'period can be walked, so the chart covers the most recent part of it rather than ' +
          'the whole ' + escapeHtml(range.label.toLowerCase()) + '.</p>'
        : '') +
    '</div>';
  }

  /* ---------------------------------------------- posting time vs views */

  /* A different question from the chart above. That one is a timeline — how is this channel
     doing lately. This one has no chronology in it at all: every upload ever seen is folded
     onto a single 24-hour clock (or a single week) to ask whether the hour a video goes out
     changes how it does. The two cannot share a plot, because one axis is a date and the
     other is a time of day.

     The two series live in one chart on purpose, rather than behind a toggle. Total views by
     hour is not an answer on its own: a channel that posts most often at 3pm earns most of
     its views at 3pm whatever that hour is worth, so the tall bar is measuring the schedule
     rather than the audience. Average views per upload is the honest measure — and it is only
     readable beside the upload count that produced it, because an average over one video is
     that video, not a pattern. So the count rides in front of every bar, and the buttons are
     there to isolate a series, not to make the reader hold two charts in their head. */

  const TIME_METRICS = [
    { key: 'avg', label: 'Avg views' },
    { key: 'total', label: 'Total views' },
    { key: 'count', label: 'Uploads' }
  ];

  const TIME_AXES = [
    { key: 'hour', label: 'Hour' },
    { key: 'dow', label: 'Weekday' }
  ];

  /* Everything the panel has ever loaded for this channel, not just the selected range. The
     range buttons above narrow on purpose — a timeline of the last week should show the last
     week. This chart wants the opposite: twenty-four slots split between fifty uploads leaves
     two apiece, and two is not a pattern. Whatever a range fetch already paid for is reused
     here for free, so pressing Year above sharpens this chart as a side effect. */
  function allKnownVideos(res) {
    const seen = new Set(), out = [];
    const push = (list) => {
      for (const v of list || []) {
        const id = v.id || (v.publishedAt + '|' + v.views);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(v);
      }
    };
    // Fetched ranges first: they are the larger sets, so the sample only adds what they miss.
    for (const k of Object.keys(anChart.byRange)) push(anChart.byRange[k].videos);
    push((res && res.videos) || []);
    return out;
  }

  /* Monday first. getDay() counts from Sunday, which puts the weekend on both ends of the
     axis and splits the run of working days a posting schedule is actually built around. */
  function slotIndex(d, axis) {
    return axis === 'dow' ? (d.getDay() + 6) % 7 : d.getHours();
  }

  function slotLabels(axis) {
    const out = [];
    if (axis === 'dow') {
      // 2024-01-01 was a Monday, so this walks Mon..Sun in the reader's own locale.
      for (let i = 0; i < 7; i++) {
        out.push(new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));
      }
      return out;
    }
    for (let h = 0; h < 24; h++) {
      out.push(new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }));
    }
    return out;
  }

  /* Every upload folded onto one clock. Empty slots are kept: an hour this channel never
     posts in is a fact about the schedule, and closing the gap would slide the remaining bars
     into hours they do not belong to. */
  function timeSlots(videos, axis) {
    const labels = slotLabels(axis);
    const slots = labels.map((label, i) =>
      ({ i, label, views: 0, count: 0, list: [] }));
    for (const v of videos) {
      if (!v.publishedAt || v.views == null) continue;
      const d = new Date(v.publishedAt);
      if (isNaN(d.getTime())) continue;
      const s = slots[slotIndex(d, axis)];
      if (!s) continue;
      s.views += v.views;
      s.count++;
      s.list.push(v.views);
    }
    for (const s of slots) {
      s.avg = s.count ? s.views / s.count : 0;
      s.med = medianOf(s.list);
    }
    return slots;
  }

  function slotValue(s, metric) {
    return metric === 'count' ? s.count : metric === 'total' ? s.views : s.avg;
  }

  /* The payoff line. Guarded rather than always printed: with two uploads in a slot the top
     of the ranking is whichever one got lucky, and stating that as "best time to post" would
     dress noise up as advice. A floor on the winning slot and a margin over the rest of the
     schedule is the least that makes the sentence true. */
  function bestSlotNote(slots, axis, totalCount) {
    if (totalCount < 8) return '';
    /* Three uploads in a slot before it can win, dropping to two only if nothing reaches
       three — a channel posting twice an hour around the clock has a real pattern in it and
       should not be met with silence for failing an arbitrary floor. */
    let pool = slots.filter((s) => s.count >= 3);
    if (!pool.length) pool = slots.filter((s) => s.count >= 2);
    if (pool.length < 2) return '';

    /* The baseline is the median of those slots' own averages, not the channel's overall
       average. One 900k outlier posted at 3am drags a mean baseline up until the hour that
       genuinely earns six times the rest fails the test — the comparison has to be as robust
       as the claim resting on it. */
    const base = medianOf(pool.map((s) => s.avg));
    if (!base) return '';
    let best = null;
    for (const s of pool) if (!best || s.avg > best.avg) best = s;
    const ratio = best.avg / base;
    const noun = axis === 'dow' ? 'day' : 'hour';

    if (ratio < 1.25) {
      return '<p class="ytc-tm__best ytc-tm__best--flat">No ' + noun +
        ' stands out — across ' + totalCount + ' uploads this channel’s results do not ' +
        'track ' + (axis === 'dow' ? 'the day it posts' : 'the time of day it posts') +
        '.</p>';
    }
    return '<p class="ytc-tm__best"><b>' + (axis === 'dow' ? 'Best day to post: ' : 'Best hour to post: ') +
      escapeHtml(best.label) + '</b> — ' + F.compact(Math.round(best.avg)) +
      ' avg views across ' + best.count + ' upload' + (best.count === 1 ? '' : 's') + ', ' +
      ratio.toFixed(1) + '× the typical ' + noun + ' for this channel.</p>';
  }

  function timeChartHtml(res) {
    const axis = anChart.timeAxis;
    const metric = anChart.timeMetric;
    const videos = allKnownVideos(res);
    const slots = timeSlots(videos, axis);
    const totalCount = slots.reduce((a, s) => a + s.count, 0);

    /* Each group is named and spaced away from the other. Unlabelled and 6px apart they read
       as one five-button control with two buttons lit, which looks like a bug rather than
       like two questions — a reader who sees Weekday and Uploads both highlighted has no way
       to tell that one picks the axis and the other picks what the bars measure. */
    const group = (cls, name, items, current, attr) =>
      '<span class="ytc-tm__grp"><span class="ytc-tm__grplab">' + name + '</span>' +
      '<span class="ytc-an__ranges ' + cls + '" role="group" aria-label="' + name + '">' +
      items.map((it) => {
        const on = it.key === current;
        return '<button type="button" class="ytc-an__range' + (on ? ' on' : '') +
          '" aria-pressed="' + on + '" ' + attr + '="' + it.key + '">' +
          it.label + '</button>';
      }).join('') + '</span></span>';

    const head = '<div class="ytc-an__charthead">' +
      '<span class="ytc-an__label">Posting time vs views</span>' +
      '<span class="ytc-tm__toggles">' +
        group('ytc-tm__axes', 'Group by', TIME_AXES, axis, 'data-tmaxis') +
        group('ytc-tm__metrics', 'Show', TIME_METRICS, metric, 'data-tmmetric') +
      '</span></div>';

    if (totalCount < 3) {
      return '<div class="ytc-tm">' + head +
        '<p class="ytc-an__note">Only ' + totalCount + ' upload' +
        (totalCount === 1 ? '' : 's') + ' carried both a publish time and a view count — ' +
        'not enough to read a pattern. Pick a longer range on the chart above to load more.' +
        '</p></div>';
    }

    /* The scale ignores slots holding a single upload when the metric is an average, because
       an average of one is that video. One 900k fluke posted once at 3am otherwise sets the
       ceiling for all twenty-four bars and presses the hour that genuinely earns 50k into a
       stub two pixels tall — the chart then shows the outlier and hides the pattern. Those
       bars are still drawn, clamped at the top and marked as running past it, so nothing is
       silently dropped. */
    const scaleFrom = metric === 'avg' ? slots.filter((s) => s.count >= 2) : slots;
    const maxMain = Math.max.apply(null,
      (scaleFrom.length ? scaleFrom : slots).map((s) => slotValue(s, metric))) || 1;
    const maxCount = Math.max.apply(null, slots.map((s) => s.count)) || 1;
    const showCount = metric !== 'count';

    let anyThin = false, anyOver = false;
    const col = (inner, s) =>
      '<div class="ytc-tm__col' + (s.count ? '' : ' ytc-tm__col--empty') + '">' + inner + '</div>';

    const bars = slots.map((s) => {
      const raw = (slotValue(s, metric) / maxMain) * 100;
      const over = raw > 100.5;
      const thin = metric === 'avg' && s.count === 1;
      if (thin) anyThin = true;
      if (over) anyOver = true;
      return col(s.count
        ? '<i class="ytc-tm__bar' + (thin ? ' ytc-tm__bar--thin' : '') +
          (over ? ' ytc-tm__bar--over' : '') +
          '" style="height:' + Math.min(100, raw).toFixed(1) + '%"></i>'
        : '', s);
    }).join('');

    /* The upload count gets its own strip under the bars rather than a second bar inside
       them. Sharing one plot means sharing one scale, and these two have nothing in common to
       scale by: twenty uploads drawn against a views axis simply becomes the tallest thing on
       screen and is read as the answer, when its whole job is to qualify the bar above it. */
    const counts = showCount ? slots.map((s) =>
      col(s.count
        ? '<i class="ytc-tm__cbar" style="height:' +
          Math.max(8, (s.count / maxCount) * 100).toFixed(1) + '%"></i>'
        : '', s)).join('') : '';

    /* Hour labels every third slot; twenty-four of them cannot fit, and a crowded axis is
       read as no axis at all. Weekdays are seven and all fit. */
    const xs = slots.map((s) => {
      const show = axis === 'dow' || s.i % 3 === 0;
      const text = axis === 'dow' ? s.label : String(s.i).padStart(2, '0');
      return '<span class="ytc-tm__x">' + (show ? escapeHtml(text) : '') + '</span>';
    }).join('');

    const hits = slots.map((s) =>
      '<div class="ytc-tm__hit" data-i="' + s.i + '"></div>').join('');

    const metricName = metric === 'count' ? 'Uploads'
      : metric === 'total' ? 'Total views' : 'Avg views per upload';
    const peak = metric === 'count' ? String(maxMain) : F.compact(Math.round(maxMain));
    const legend = '<div class="ytc-tm__legend">' +
      '<span class="ytc-tm__key ytc-tm__key--v">' + escapeHtml(metricName) +
        ' · peak ' + peak + '</span>' +
      (showCount ? '<span class="ytc-tm__key ytc-tm__key--c">Uploads · peak ' +
        maxCount + '</span>' : '') +
      (anyThin ? '<span class="ytc-tm__key ytc-tm__key--t">Faint · a single upload</span>'
        : '') +
      (anyOver ? '<span class="ytc-tm__key ytc-tm__key--o">Dashed top · runs past the ' +
        'scale</span>' : '') +
      '</div>';

    return '<div class="ytc-tm">' + head + legend +
      '<div class="ytc-tm__plot">' +
        '<div class="ytc-tm__cols">' + bars + '</div>' +
        (showCount ? '<div class="ytc-tm__crow">' + counts + '</div>' : '') +
        '<div class="ytc-tm__xaxis">' + xs + '</div>' +
        '<div class="ytc-tm__hits">' + hits + '</div>' +
        '<div class="ytc-an__tip" hidden></div>' +
      '</div>' +
      bestSlotNote(slots, axis, totalCount) +
      '<p class="ytc-an__note ytc-tm__foot">' + totalCount + ' upload' +
        (totalCount === 1 ? '' : 's') + ' with a known publish time, folded onto one ' +
        (axis === 'dow' ? 'week' : '24-hour clock') +
        '. Times are your own timezone, not the channel’s.</p>' +
    '</div>';
  }

  function wireTimeChart(host, res) {
    const chart = host.querySelector('.ytc-tm');
    if (!chart) return;

    chart.querySelectorAll('[data-tmaxis]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        anChart.timeAxis = b.dataset.tmaxis;
        renderAnalytics(res);
      });
    });
    chart.querySelectorAll('[data-tmmetric]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        anChart.timeMetric = b.dataset.tmmetric;
        renderAnalytics(res);
      });
    });

    const plot = chart.querySelector('.ytc-tm__plot');
    const tip = chart.querySelector('.ytc-an__tip');
    if (!plot || !tip) return;
    const slots = timeSlots(allKnownVideos(res), anChart.timeAxis);

    /* The whole column is the target, not the bar. An hour with no uploads is exactly the
       thing a reader wants to hover to confirm, and a zero-height bar cannot be hovered. */
    const show = (col) => {
      const s = slots[Number(col.dataset.i)];
      if (!s) return;
      tip.innerHTML = '<b>' + escapeHtml(s.label) + '</b>' +
        '<span>' + s.count + ' upload' + (s.count === 1 ? '' : 's') + '</span>' +
        (s.count
          ? '<span>' + F.compact(s.views) + ' views total' +
            (s.med == null ? '' : ' · median ' + F.compact(Math.round(s.med))) + '</span>' +
            '<em>' + F.compact(Math.round(s.avg)) + ' avg per upload</em>'
          : '<span>Nothing posted in this slot</span>');
      tip.hidden = false;
      const box = plot.getBoundingClientRect();
      const d = col.getBoundingClientRect();
      const left = d.left - box.left + d.width / 2;
      const flip = left > box.width * 0.6;
      tip.style.left = flip ? 'auto' : left + 12 + 'px';
      tip.style.right = flip ? (box.width - left + 12) + 'px' : 'auto';
      tip.style.top = '0px';
      col.classList.add('on');
    };
    const hide = (col) => { tip.hidden = true; if (col) col.classList.remove('on'); };

    chart.querySelectorAll('.ytc-tm__hit').forEach((col) => {
      col.addEventListener('mouseenter', () => show(col));
      col.addEventListener('mouseleave', () => hide(col));
      col.addEventListener('click', (e) => { e.preventDefault(); show(col); });
    });
    plot.addEventListener('mouseleave', () => hide(null));
  }

  /* Derived once, so the cards read from one place and cannot disagree with each other. */
  function analyticsModel(res) {
    const st = (res && res.stats) || {};
    const videos = (res && res.videos) || [];
    const longs = videos.filter((v) => !v.shorts);
    const shorts = videos.filter((v) => v.shorts);

    const withLen = longs.filter((v) => v.seconds > 0);
    const avgLen = withLen.length
      ? Math.round(withLen.reduce((a, v) => a + v.seconds, 0) / withLen.length) : null;

    /* Views on videos put out in a recent window. Not the same thing as views received in
       that window, which no public page reports — an old video keeps earning and is not
       counted here. Labelled for what it is rather than passed off as the other. */
    /* The window widens rather than reporting nothing. 28 days is the right frame for a
       channel that uploads weekly and an empty one for a channel that uploads twice a year:
       a 1.2M-subscriber channel whose last upload was 16 months ago showed a dash and a zero
       beside a confident RPM, which reads as a broken panel rather than as the true answer,
       "nothing in that window". So take the shortest span that actually holds uploads and say
       which one it was — widening silently would be the worse lie. */
    const dated = videos.filter((v) => daysSince(v.publishedAt) != null);
    const inWindow = (days) => dated.filter((v) => daysSince(v.publishedAt) <= days);
    let win = ANALYTICS_WINDOWS[0];
    let recent = inWindow(win.days);
    for (let i = 1; i < ANALYTICS_WINDOWS.length && !recent.length && dated.length; i++) {
      win = ANALYTICS_WINDOWS[i];
      recent = inWindow(win.days);
    }
    const recentViews = recent.reduce((a, v) => a + (v.views || 0), 0);

    const rpm = res && res.niche ? res.niche.rpm : 0;
    const days = st.joinedAt ? daysSince(new Date(st.joinedAt).toISOString()) : null;
    const uploadsPerMo = days && st.videoCount ? (st.videoCount / (days / 30)) : null;

    const longViews = longs.reduce((a, v) => a + (v.views || 0), 0);
    const shortViews = shorts.reduce((a, v) => a + (v.views || 0), 0);

    return {
      subs: res && res.subs, totalViews: st.totalViews || null,
      videoCount: st.videoCount || null, avgViews: st.avgViews || null,
      days, uploadsPerMo, avgLen, rpm,
      niche: res && res.niche ? res.niche.label : '',
      recentViews, recentCount: recent.length, window: win,
      revenue: rpm && recentViews ? (recentViews / 1000) * rpm : null,
      hasShorts: shorts.length > 0,
      longViews, shortViews,
      lastUpload: videos.length ? agoLabel(videos[0].publishedAt) : '',
      sampled: res && res.videosOk ? videos.length : 0
    };
  }

  function anCard(label, value, sub, icon) {
    return '<div class="ytc-an__card">' +
      '<span class="ytc-an__label">' + (icon ? '<i>' + icon + '</i>' : '') +
        escapeHtml(label) + '</span>' +
      '<b class="ytc-an__value">' + value + '</b>' +
      (sub ? '<span class="ytc-an__sub">' + sub + '</span>' : '') +
    '</div>';
  }

  function anFact(label, value) {
    return '<div class="ytc-an__fact">' +
      '<span class="ytc-an__label">' + escapeHtml(label) + '</span>' +
      '<b>' + value + '</b></div>';
  }

  /* Where this channel's rate falls across the reference table, which is what makes $5.25
     mean something: it is the middle of the range, not a number without a scale. */
  function rpmMeter(rpm) {
    if (!rpm) return '';
    const pos = Math.max(0, Math.min(1, (rpm - 2) / (20 - 2)));
    const band = rpm >= 11 ? 'High' : rpm >= 5.5 ? 'Medium' : 'Low';
    return '<span class="ytc-an__sub">' + band + '</span>' +
      '<span class="ytc-an__meter"><i style="width:' + Math.round(pos * 100) + '%"></i></span>';
  }

  /* Laid out exactly like the finished panel — same cards, same rows, same heights — so the
     figures appear in place rather than the page reflowing under the reader. A spinner in an
     empty box gives no sense of what is coming or how much of it. */
  function analyticsSkeleton() {
    const card = (wide) =>
      '<div class="ytc-an__card">' +
        '<span class="ytc-an__skel ytc-an__skel--label"></span>' +
        '<span class="ytc-an__skel ytc-an__skel--value"></span>' +
        '<span class="ytc-an__skel ytc-an__skel--sub"></span>' +
      '</div>';
    const fact = () =>
      '<div class="ytc-an__fact">' +
        '<span class="ytc-an__skel ytc-an__skel--label"></span>' +
        '<span class="ytc-an__skel ytc-an__skel--fact"></span>' +
      '</div>';
    let facts = '';
    for (let i = 0; i < 10; i++) facts += fact();
    return '<div class="ytc-an__head"><b>Channel analytics</b>' +
        '<span class="ytc-an__skel ytc-an__skel--btn"></span></div>' +
      '<div class="ytc-an__top">' + card() + card() + card() + '</div>' +
      '<div class="ytc-an__panel">' +
        '<span class="ytc-an__skel ytc-an__skel--label"></span>' +
        '<span class="ytc-an__skel ytc-an__skel--bar"></span>' +
        '<span class="ytc-an__skel ytc-an__skel--value"></span>' +
      '</div>' +
      '<div class="ytc-an__facts">' + facts + '</div>';
  }

  function renderAnalytics(res) {
    const host = analyticsHost();
    if (!host) return;
    host.dataset.loaded = '1';
    /* Before anything reads it: a render for a different channel than the one the chart state
       was built for must not see that state at all. */
    const key = channelKeyFromLocation();
    if (key && anChart.key !== key) resetChart(key);

    if (!res || !res.ok) {
      host.innerHTML = '<p class="ytc-an__note">' +
        escapeHtml((res && res.reason) || 'Could not read this channel') +
        ' <button type="button" class="ytc-an__retry">Try again</button></p>';
      const again = host.querySelector('.ytc-an__retry');
      if (again) again.addEventListener('click', () => askAnalytics(true));
      return;
    }

    const m = analyticsModel(res);
    const dash = '\u2014';
    const money = (n) => n == null ? dash : '$' + Math.round(n).toLocaleString();
    const num = (n) => n == null ? dash : Math.round(n).toLocaleString();
    const pct = m.longViews + m.shortViews > 0
      ? Math.round((m.longViews / (m.longViews + m.shortViews)) * 100) : null;
    const win = m.window.short ? ' \u00b7 ' + m.window.short : '';

    host.innerHTML =
      '<div class="ytc-an__head">' +
        '<b>Channel analytics</b>' +
        '<button type="button" class="ytc-an__refresh">Refresh</button>' +
      '</div>' +

      '<div class="ytc-an__top">' +
        /* A channel with no videos read is a failure to read them, not a channel that
           published nothing. Reporting 0 there states something false with the same
           confidence as the figures that are real. */
        /* The window is named in the card label, not only in the sub, whenever it is not
           the usual 28 days. A reader who skims the big number and the title has to be able
           to see that the frame moved; burying it in the small print would leave a
           twice-a-year channel's whole-sample revenue looking like a monthly figure. */
        anCard('Estimated revenue' + win, m.sampled ? money(m.revenue) : dash,
          m.sampled
            ? 'From ' + m.recentCount + ' video' + (m.recentCount === 1 ? '' : 's') +
              ' in ' + m.window.label
            : 'Could not read this channel\u2019s video list', '$') +
        anCard('Views' + win, m.sampled ? num(m.recentViews) : dash,
          m.sampled ? 'On videos from ' + m.window.label
                    : 'Could not read this channel\u2019s video list', '\u25B6') +
        anCard('RPM' + (m.niche ? ' \u00b7 ' + escapeHtml(m.niche) : ''),
          m.rpm ? '$' + m.rpm.toFixed(2) : dash, rpmMeter(m.rpm), '\u25CE') +
      '</div>' +

      (m.sampled ? viewsChartHtml(res) : '') +
      (m.sampled ? timeChartHtml(res) : '') +

        '<div class="ytc-an__panel">' +
          '<span class="ytc-an__label">Videos vs Shorts views</span>' +
          (pct == null
            ? '<p class="ytc-an__note">' + (m.sampled
                ? 'The sampled videos carried no view counts.'
                : 'Could not read this channel\u2019s video list. It may be rate limited \u2014 ' +
                  'Refresh in a minute.') + '</p>'
            : '<span class="ytc-an__bar"><i style="width:' + pct + '%"></i></span>' +
              '<b class="ytc-an__value">' + F.compact(m.longViews + m.shortViews) + '</b>' +
              '<span class="ytc-an__sub">' + pct + '% long form, ' + (100 - pct) +
              '% shorts, across ' + m.sampled + ' recent videos</span>') +
        '</div>' +

      '<div class="ytc-an__facts">' +
        anFact('Subscribers', m.subs == null ? dash : F.compact(m.subs)) +
        anFact('Total views', m.totalViews == null ? dash : F.compact(m.totalViews)) +
        anFact('Videos', num(m.videoCount)) +
        anFact('Avg. views per video', m.avgViews == null ? dash : F.compact(m.avgViews)) +
        anFact('Days since start', num(m.days)) +
        anFact('Avg. monthly uploads',
          m.uploadsPerMo == null ? dash : m.uploadsPerMo.toFixed(2)) +
        anFact('Avg. video length', m.avgLen == null ? dash
          : Math.floor(m.avgLen / 60) + ' min ' + (m.avgLen % 60) + ' sec') +
        anFact('Has shorts', m.sampled ? (m.hasShorts ? 'Yes' : 'No') : dash) +
        anFact('Category', m.niche ? escapeHtml(m.niche) : dash) +
        anFact('Last upload', m.lastUpload ? escapeHtml(m.lastUpload) : dash) +
      '</div>' +

      (m.sampled ? '' :
        '<p class="ytc-an__none">The figures above that need the channel\u2019s video list ' +
        'are blank because it could not be read. Everything else comes from the channel page ' +
        'itself and is unaffected.</p>') +
      '<p class="ytc-an__foot">Revenue is views multiplied by the reference rate for this ' +
        'niche, adjusted for nothing else. Audience country moves real RPM further than ' +
        'niche does, so treat it as a scale rather than a figure.</p>';

    wireChart(host, res);
    wireTimeChart(host, res);

    const refresh = host.querySelector('.ytc-an__refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        host.innerHTML = analyticsSkeleton();
        askAnalytics(true);
      });
    }
  }

  /* ---------------------------------------------------------- shorts panel */

  /* Everything this extension shows about a video lives somewhere the Shorts player does not
     have. There is no sidebar to hang the stats card on, no description block, no tab row —
     the whole page is one column with a viewport-tall video in the middle of it. So the
     figures that a watch page gets for free were simply absent on Shorts, which is the format
     the reader is most likely to be researching.

     They go in the gutter instead. At any usable window width the reel is centred in a column
     far wider than itself, leaving a few hundred empty pixels to its left; the panel takes
     that space, and stands down when there is not enough of it. */

  const SH_ICONS = {
    eye: 'M1 8s2.7-4.5 7-4.5S15 8 15 8s-2.7 4.5-7 4.5S1 8 1 8Z M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
    heart: 'M8 13.5S2 10 2 6.2A2.7 2.7 0 0 1 8 4.8a2.7 2.7 0 0 1 6 1.4C14 10 8 13.5 8 13.5Z',
    speed: 'M1.5 11.5 6 7l3 3 5.5-5.5 M10.5 4.5h4v4',
    cal: 'M2.5 3.5h11v11h-11Z M2.5 6.5h11 M5.5 1.5v3 M10.5 1.5v3',
    stack: 'M8 1.5 14.5 5 8 8.5 1.5 5Z M1.5 8 8 11.5 14.5 8 M1.5 11 8 14.5 14.5 11',
    clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M8 4.5V8l2.5 1.5',
    chart: 'M2 14V9 M6 14V4 M10 14v-7 M14 14V2'
  };

  function shIcon(name) {
    const d = SH_ICONS[name];
    if (!d) return '';
    return '<svg class="ytc-sh__ico" viewBox="0 0 16 16" aria-hidden="true"><path d="' +
      d + '"/></svg>';
  }

  const SHORTS_OPEN_KEY = 'ytc:shortsOpen';

  /* Our own mark on the panel, so a card of figures YouTube never drew is attributable to the
     thing that drew it — the same reason the channel tabs carry it. Guarded like theirs: after
     an extension reload getURL throws "Extension context invalidated" in any content script
     still on an open page, and an uncaught throw here would take the whole panel out while
     everything drawn earlier stayed put. */
  function shortsBrandIcon() {
    let url = '';
    try { url = chrome.runtime.getURL('icons/icon32.png'); } catch (e) { return ''; }
    return url
      ? '<img class="ytc-sh__brand" src="' + url + '" alt="" title="YouTube Toolkit">'
      : '';
  }

  /* Two sources, arriving at different times and failing independently: the live player
     answers for this Short in milliseconds, the channel lookup is a network round trip that
     may not answer at all. Each has its own pending flag so a value can fill in as soon as it
     is known instead of the whole panel waiting on the slower half. */
  const shortsState = {
    videoId: '', key: '',
    video: null,          // { views, likes, publishDate } from the live player
    channel: null,        // { subs, videoCount, joinedAt, shortsAvg, shortsSampled }
    who: null,            // { name, avatar } read off the reel
    pending: { video: true, channel: true },
    open: true, openRead: false, giveUp: 0
  };

  /* Long past both retry chains. A placeholder promising a number that is never coming reads
     as a hung panel; a dash reads as "not available", which is the truth. Same reasoning, and
     the same budget, as the watch page's stats card. */
  const SHORTS_GIVE_UP_MS = 30000;

  function shortsIdFromLocation() {
    const m = location.pathname.match(/^\/shorts\/([\w-]{6,})/);
    return m ? m[1] : '';
  }

  /* Which reel is actually on screen. Shorts keeps a stack of renderers mounted — the one
     above and the one below are already built — so "the first one" is regularly the previous
     video, and reading the channel off it names the wrong creator. The one crossing the
     middle of the viewport is the one being watched. */
  function activeReel() {
    const reels = document.querySelectorAll('ytd-reel-video-renderer');
    const mid = window.innerHeight / 2;
    for (const r of reels) {
      const b = r.getBoundingClientRect();
      if (b.height > 0 && b.top <= mid && b.bottom >= mid) return r;
    }
    return reels[0] || null;
  }

  /* Name and avatar for the header, read from the overlay rather than fetched. Neither is
     worth a request: the channel lookup this panel already makes returns counts, not
     identity, and the reader is looking at both on screen. Missing ones degrade to the
     handle and a letter tile. */
  function shortsWho() {
    const reel = activeReel();
    if (!reel) return null;
    let name = '';
    for (const sel of ['.ytReelChannelBarViewModelChannelName',
                       'yt-reel-channel-bar-view-model a',
                       '#channel-info #text-container',
                       'a[href^="/@"] span']) {
      const el = reel.querySelector(sel);
      const t = el && text(el);
      if (t && t.length < 60) { name = t; break; }
    }
    let avatar = '';
    for (const img of reel.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      // The avatar is the only small square image in the overlay that is actually loaded.
      if (/yt\d\.(ggpht|googleusercontent)\.com/.test(src) && img.getBoundingClientRect().width > 0) {
        avatar = src;
        break;
      }
    }
    return { name, avatar };
  }

  function resetShorts(id) {
    shortsState.videoId = id;
    shortsState.key = '';
    shortsState.video = null;
    shortsState.channel = null;
    shortsState.who = null;
    shortsState.pending = { video: true, channel: true };
    clearTimeout(shortsState.giveUp);
    shortsState.giveUp = setTimeout(() => {
      if (shortsState.videoId !== id) return;
      shortsState.pending = { video: false, channel: false };
      renderShortsPanel();
    }, SHORTS_GIVE_UP_MS);
  }

  /* Mean views across the Shorts in the sample.

     The sample is the channel's most recent uploads, capped by the service — so this is not a
     lifetime average and must not be labelled as one. The count it was taken over travels
     with it, and the tooltip says so. */
  function shortsAverage(videos) {
    const shorts = (videos || []).filter((v) => v.shorts && v.views != null);
    if (!shorts.length) return { avg: null, sampled: 0 };
    const total = shorts.reduce((a, v) => a + v.views, 0);
    return { avg: Math.round(total / shorts.length), sampled: shorts.length };
  }

  async function loadShorts(id) {
    /* The player global is not rewritten the instant the URL changes, and on Shorts the URL
       changes on every scroll — so asking too early answers for the Short the reader just
       scrolled past. freshPage waits for the payload to name the video in the address bar,
       which is the same guard the watch page needs for the same reason. */
    const page = await freshPage(id);
    if (shortsState.videoId !== id) return;          // scrolled on while waiting

    const stats = page && page.stats;
    if (stats) {
      shortsState.video = {
        views: stats.views, likes: stats.likes, publishDate: stats.publishDate
      };
      /* The player names the channel outright, so the header does not have to settle for the
         handle the overlay renders. Kept separate from the avatar, which really is only
         readable from the DOM. */
      if (stats.channelName) {
        shortsState.who = Object.assign({}, shortsState.who, { name: stats.channelName });
      }
    }
    shortsState.pending.video = false;
    renderShortsPanel();

    const key = (stats && stats.channelHandle) || '';
    shortsState.key = key;
    if (!key) {
      shortsState.pending.channel = false;
      renderShortsPanel();
      return;
    }

    sendMessage({ type: 'ytc-analytics', key }, (res) => {
      if (chrome.runtime.lastError) { shortsState.pending.channel = false; renderShortsPanel(); return; }
      if (shortsState.videoId !== id) return;
      const st = (res && res.stats) || {};
      const avg = shortsAverage(res && res.videos);
      shortsState.channel = {
        subs: (res && res.subs) || null,
        videoCount: st.videoCount || null,
        joinedAt: st.joinedAt || null,
        shortsAvg: avg.avg,
        shortsSampled: avg.sampled
      };
      shortsState.pending.channel = false;
      renderShortsPanel();
    });
  }

  function shortsHost() {
    const root = document.querySelector('ytd-shorts');
    if (!root) return null;
    let host = document.querySelector('.ytc-sh');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ytc-sh';
    }
    if (host.parentElement !== root) root.appendChild(host);
    return host;
  }

  /* The gutter is not a constant: it grows and shrinks with the window, and with YouTube's
     guide opening and closing. Measured every scan, and the panel stands down rather than
     covering the video it is describing — a stats panel over the Short is worse than none. */
  const SHORTS_MIN_ROOM = 232;
  const SHORTS_MAX_WIDTH = 300;

  function fitShortsPanel(host) {
    const root = document.querySelector('ytd-shorts');
    const reel = activeReel();
    if (!root || !reel) return false;
    const gutter = reel.getBoundingClientRect().left - root.getBoundingClientRect().left;
    const room = gutter - 32;                       // 16px of margin either side
    if (!(room >= SHORTS_MIN_ROOM)) { host.hidden = true; return false; }
    host.hidden = false;
    host.style.width = Math.min(SHORTS_MAX_WIDTH, Math.floor(room)) + 'px';
    return true;
  }

  function shRow(icon, label, value, title) {
    return '<div class="ytc-sh__row"' +
      (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
      '<span class="ytc-sh__label">' + shIcon(icon) + escapeHtml(label) + '</span>' +
      '<b class="ytc-sh__value">' + value + '</b></div>';
  }

  const SH_SKEL = '<span class="ytc-sh__skel"></span>';

  /* A dash once the answer has settled, a skeleton bar while it is still coming. The two say
     different things and the reader can tell them apart at a glance, which is the whole point
     of drawing a skeleton rather than spinning something. */
  function shValue(pending, value) {
    if (pending) return SH_SKEL;
    return value == null || value === '' ? '—' : value;
  }

  function shNum(n) {
    return n == null ? null : Math.round(n).toLocaleString();
  }

  function shortsPanelHtml() {
    const s = shortsState;
    const v = s.video || {};
    const c = s.channel || {};
    const waitV = s.pending.video;
    const waitC = s.pending.channel;

    const who = s.who || {};
    const name = who.name || s.key || '';
    const avatar = who.avatar
      ? '<img class="ytc-sh__av" src="' + escapeHtml(who.avatar) + '" alt="">'
      : (name
          ? '<span class="ytc-sh__av ytc-sh__av--letter">' +
            escapeHtml(name.replace(/^@/, '').charAt(0).toUpperCase()) + '</span>'
          : '<span class="ytc-sh__av ytc-sh__skel"></span>');

    const subs = waitC ? SH_SKEL
      : c.subs ? escapeHtml(F.compact(c.subs)) + ' subscribers'
      : 'Subscribers unavailable';

    const head =
      '<div class="ytc-sh__card ytc-sh__who">' +
        avatar +
        '<span class="ytc-sh__ident">' +
          '<b class="ytc-sh__name">' + (name ? escapeHtml(name) : SH_SKEL) + '</b>' +
          '<span class="ytc-sh__subs">' + subs + '</span>' +
        '</span>' +
        shortsBrandIcon() +
        '<button type="button" class="ytc-sh__toggle" aria-expanded="' + (s.open ? 'true' : 'false') +
          '" title="' + (s.open ? 'Hide stats' : 'Show stats') + '">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 6 4.5 4.5L12.5 6"/></svg>' +
        '</button>' +
      '</div>';

    if (!s.open) return head;

    /* Likes over views. YouTube publishes both on the overlay, so this is the one engagement
       figure on Shorts that is not a guess — and it is the number the format is judged on. */
    const liked = v.likes != null && v.views
      ? (v.likes / v.views * 100).toFixed(1) + '%' : null;
    /* A lifetime rate since publishing, not current velocity. A Short that did 80M in its
       first week still reports the average across every hour since. */
    const hours = v.publishDate
      ? (Date.now() - Date.parse(v.publishDate)) / 3600000 : null;
    const vph = hours && hours > 0 && v.views ? shNum(v.views / hours) : null;
    const published = v.publishDate && !isNaN(Date.parse(v.publishDate))
      ? new Date(v.publishDate).toLocaleDateString(undefined,
          { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
    const days = c.joinedAt ? daysSince(new Date(c.joinedAt).toISOString()) : null;

    const thisShort =
      '<div class="ytc-sh__card">' +
        '<div class="ytc-sh__head">' + shIcon('chart') +
          '<span class="ytc-sh__ident">' +
            '<b>This Short</b>' +
            '<span class="ytc-sh__subs">' +
              (waitV ? SH_SKEL : (shNum(v.views) ? shNum(v.views) + ' views' : 'Views unavailable')) +
            '</span>' +
          '</span>' +
        '</div>' +
        '<div class="ytc-sh__rows">' +
          shRow('heart', 'Viewers Liked', shValue(waitV, liked),
            v.likes != null && v.views
              ? v.likes.toLocaleString() + ' likes on ' + v.views.toLocaleString() +
                ' views. Comments are not counted'
              : 'Likes are hidden on this Short') +
          shRow('speed', 'Views Per Hour', shValue(waitV, vph),
            'Averaged over every hour since publishing — a lifetime rate, not current velocity') +
        '</div>' +
      '</div>';

    const channel =
      '<div class="ytc-sh__card">' +
        '<div class="ytc-sh__rows">' +
          shRow('cal', 'Published On', shValue(waitV, published),
            'When this Short went up') +
          shRow('stack', 'Total Uploads', shValue(waitC, shNum(c.videoCount)),
            'Everything on the channel, Shorts and long form together') +
          shRow('clock', 'Days Since Start', shValue(waitC, shNum(days)),
            'Since the channel was created') +
          shRow('eye', 'Avg. Shorts Views', shValue(waitC, shNum(c.shortsAvg)),
            c.shortsSampled
              ? 'Mean across the ' + c.shortsSampled + ' most recent Shorts we could read, ' +
                'not the channel’s lifetime average'
              : 'No Shorts found in the recent uploads we could read') +
        '</div>' +
      '</div>';

    return head + thisShort + channel;
  }

  function renderShortsPanel() {
    const host = document.querySelector('.ytc-sh');
    if (!host) return;
    const html = shortsPanelHtml();
    if (host.dataset.sig === html) return;      // scan() runs on every mutation
    host.dataset.sig = html;
    host.innerHTML = html;
  }

  /* Remembered across Shorts and across sessions. Collapsing it on one video and finding it
     open again on the next would make the control feel like it had not worked. */
  function readShortsOpen() {
    if (shortsState.openRead) return;
    shortsState.openRead = true;
    try {
      chrome.storage.local.get(SHORTS_OPEN_KEY, (out) => {
        if (chrome.runtime.lastError) return;
        const saved = out && out[SHORTS_OPEN_KEY];
        if (saved === false || saved === true) {
          shortsState.open = saved;
          renderShortsPanel();
        }
      });
    } catch (e) { /* storage unavailable; the session default stands */ }
  }

  function ensureShortsPanel() {
    const id = shortsIdFromLocation();
    if (!settings.showShorts || !id) {
      const stray = document.querySelector('.ytc-sh');
      if (stray) stray.remove();
      if (shortsState.videoId) {
        shortsState.videoId = '';
        clearTimeout(shortsState.giveUp);
      }
      return;
    }

    const host = shortsHost();
    if (!host) return;                      // Shorts container not built yet
    readShortsOpen();
    if (!fitShortsPanel(host)) return;      // no room; nothing to draw into

    if (shortsState.videoId !== id) {
      resetShorts(id);
      loadShorts(id);
    }

    /* The overlay hydrates after the reel is mounted, so the name and avatar are regularly
       absent on the first pass and present a moment later. Re-read until they arrive rather
       than committing to the first, empty answer. */
    const known = shortsState.who || {};
    if (!known.name || !known.avatar) {
      const who = shortsWho() || {};
      // The player's name outranks the overlay's; the overlay is the only source for the avatar.
      const merged = { name: known.name || who.name || '', avatar: known.avatar || who.avatar || '' };
      if (merged.name !== known.name || merged.avatar !== known.avatar) shortsState.who = merged;
    }

    renderShortsPanel();
  }

  /* One listener on the container rather than one per render, so a redraw cannot lose it. */
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest && e.target.closest('.ytc-sh__toggle');
    if (!toggle) return;
    e.preventDefault();
    e.stopPropagation();
    shortsState.open = !shortsState.open;
    try { chrome.storage.local.set({ [SHORTS_OPEN_KEY]: shortsState.open }); } catch (err) { /* fine */ }
    renderShortsPanel();
  }, true);

  function tabIsVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* Every container the tab row has worn, most specific first. YouTube ships more than one
     match for some of these — an overflow copy, a hidden variant — and querySelector takes
     whichever comes first in the document, which is not always the one on screen. */
  function tabBarCandidates() {
    const out = [];
    for (const sel of ['yt-tab-group-shape .yt-tab-group-shape-wiz__tabs',
                       'yt-tab-group-shape',
                       'ytd-c4-tabbed-header-renderer #tabsContent',
                       'tp-yt-paper-tabs']) {
      document.querySelectorAll(sel).forEach((el) => { if (out.indexOf(el) < 0) out.push(el); });
    }
    return out;
  }

  function buildSimilarTab(label, extraClass, onClick) {
    const tab = document.createElement('div');
    tab.className = 'ytc-tab' + (extraClass ? ' ' + extraClass : '');
    tab.setAttribute('role', 'tab');
    /* The extension's own icon, so the tab reads as ours and not as one of YouTube's. It is a
       packaged file, so it needs the extension URL — a bare path resolves against youtube.com.
       Guarded: after the extension is reloaded this throws "Extension context invalidated" in
       any content script still on an open page, and an uncaught throw took the whole tab out
       while everything drawn earlier stayed put — which reads as the feature vanishing rather
       than as a page that needs reloading. */
    let icon = '';
    try { icon = chrome.runtime.getURL('icons/icon32.png'); } catch (e) { icon = ''; }
    tab.innerHTML = (icon ? '<img class="ytc-tab__icon" src="' + icon + '" alt="">' : '') +
      '<span>' + (label || TAB_LABEL) + '</span>';
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      (onClick || openSimilarView)();
    });
    return tab;
  }

  function placeSimilarTab(tab, bar) {
    const tabs = bar.querySelectorAll('yt-tab-shape, tp-yt-paper-tab');
    const last = tabs[tabs.length - 1];
    const search = bar.querySelector(
      '#search-button, yt-icon-button#search, [aria-label*="Search" i], yt-searchbox');
    if (last && last.parentElement) {
      // Straight after the final tab — where "Similar Channels" reads as one of the row.
      last.parentElement.insertBefore(tab, last.nextSibling);
    } else if (search && search.parentElement) {
      // No tab matched, but the search icon sits after them, so just ahead of it is right.
      search.parentElement.insertBefore(tab, search);
    } else {
      bar.appendChild(tab);
    }
  }

  /* Placement is a guess about markup that changes, so this checks its own work: the tab is
     inserted, measured, and kept only if it actually came out visible. A container that is
     present but not on screen no longer swallows the tab silently — the next candidate is
     tried instead. */
  /* When the panel admits the results are weak, go and fix it.

     A thin niche is not a permanent condition, it is a gap in the index — and the person
     staring at the weak list is standing on the one channel that would fill it. Three of its
     videos are handed to the service worker, which reads who YouTube recommends beside them
     and feeds both the channels and the edges back.

     Once per channel per session, and only when the result was actually poor: a niche that
     answered well costs nothing. The viewer who triggers it sees the benefit on Refresh;
     everyone after them sees it straight away. */
  const expandedNiches = new Set();

  function channelVideoIds(limit) {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/watch?v="]').forEach((a) => {
      if (out.length >= limit) return;
      const m = (a.getAttribute('href') || '').match(/[?&]v=([\w-]{11})/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      out.push(m[1]);
    });
    return out;
  }

  function maybeExpandNiche(res) {
    if (!settings.showSimilar) return;
    const key = channelKeyFromLocation();
    if (!key || expandedNiches.has(key)) return;
    if (!res) return;
    /* Two ways a niche shows itself to be thin, and the second is the more urgent one: an
       index that returns nothing falls through to live search, so source reads 'search'
       precisely when the index most needs filling. Only a genuinely absent index is left
       alone — there would be nothing to write to. */
    const answered = res.source === 'index';
    const thin = res.source === 'search' &&
      /not been seeded|no match/i.test(res.indexProblem || '');
    if (!answered && !thin) return;

    const list = res.channels || [];
    const best = list.reduce((m, c) => Math.max(m, c.similarity || 0), 0);
    // The same threshold the note uses to call the matches weak, plus a thin-list case.
    if (answered && best >= WEAK_BELOW && list.length >= 5) return;

    const videos = channelVideoIds(3);
    if (!videos.length) return;
    expandedNiches.add(key);

    const host = similarHost();
    const note = host && host.querySelector('.ytc-t__note');
    if (note) {
      note.innerHTML = '<span class="ytc-spin"></span> Thin results \u2014 looking for more ' +
        'channels in this niche\u2026';
    }

    /* Redraw when it lands. Without this the repair only ever helped the next person: the one
       who hit the empty niche saw the bad list, and had no reason to think a refresh would
       change anything. */
    sendMessage({ type: 'ytc-expand', key, videos }, (out) => {
      if (chrome.runtime.lastError) return;
      if (channelKeyFromLocation() !== key) return;      // navigated away meanwhile
      if (out && out.ok && out.found) {
        askSimilar(true);
      } else if (note && note.isConnected) {
        note.textContent = 'No further channels found for this niche yet.';
      }
    });
  }

  /* Edges, harvested from a page the viewer is already on.

     The crawler spends five page fetches per channel to read the very list that sits in the
     sidebar of any watch page. Reading it here costs nothing at all — no fetch, no rate
     limit, nothing to block — so the graph grows whenever anyone watches anything, rather
     than only when someone remembers to run the crawler.

     Read from the rendered DOM rather than ytInitialData: that blob is the one the page
     loaded with, and after a soft navigation it still describes the previous video. */
  const edgesReported = new Set();

  function reportWatchEdges(sourceHandle, videoId, sourceId) {
    if (!settings.showSimilar) return;   // the same promise the toggle makes elsewhere
    if (!sourceHandle || !videoId || edgesReported.has(videoId)) return;
    const column = document.querySelector('#secondary, #related, ytd-watch-next-secondary-results-renderer');
    if (!column) return;

    /* Two ways of naming the same neighbours, because the sidebar does not always offer the
       first. Some layouts link the channel directly; in others the channel is plain text and
       only the video is a link, so the video id is the only identifier available. Collect
       whichever is there and let the server work out the rest. */
    const targets = [];
    const videos = [];
    const seenH = new Set();
    const seenV = new Set();
    const me = sourceHandle.toLowerCase();

    for (const a of column.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const h = href.match(/^\/(@[\w.-]+)/);
      if (h) {
        const low = h[1].toLowerCase();
        if (low !== me && !seenH.has(low)) { seenH.add(low); targets.push(h[1]); }
        continue;
      }
      const v = href.match(/^\/watch\?v=([\w-]{11})/);
      if (v && v[1] !== videoId && !seenV.has(v[1])) { seenV.add(v[1]); videos.push(v[1]); }
    }

    /* Too few of either means the column has not rendered yet, not that the video has no
       neighbours. Left unrecorded so a later scan picks it up once it fills. */
    if (targets.length < 3 && videos.length < 3) return;
    edgesReported.add(videoId);
    sendMessage({
      type: 'ytc-edges',
      source: sourceHandle,
      sourceId: sourceId || '',
      targets: targets.slice(0, 30),
      videos: videos.slice(0, 30)
    }, () => { /* nothing to do */ });
  }

  /* Tell the index about a channel simply because it was opened. This used to happen only as
     a side effect of asking for similar channels, so a channel visited without opening the
     tab left no trace — and a niche only filled for the channels whose panel someone happened
     to click. Once per channel per page session; the server ignores ids it already holds. */
  const seenChannels = new Set();

  /* The channel id behind a location key, when the key is the id form.

     A channel key is "@handle" or "channel/UC…" depending only on which URL the reader
     happened to arrive by, and several places treated the second as "not a real channel".
     Same channel, same page, different link. */
  function channelIdFromKey(key) {
    const m = /^(?:channel\/)?(UC[\w-]{20,24})$/.exec(key || '');
    return m ? m[1] : '';
  }

  function noteChannelSeen(handle, id) {
    // Switching the feature off has to stop the reporting, not just hide the tab. Anything
    // else makes the toggle a lie: the user believes it is off while their browsing still
    // leaves the machine.
    if (!settings.showSimilar) return;
    /* A watch page's URL names the video, never the channel, so channelKeyFromLocation finds
       nothing there and watching a video used to index nothing at all. The player knows whose
       video it is, so on a watch page that answer is passed in. */
    const key = handle || channelKeyFromLocation();
    /* An id-form key counts. Gating this on "@" meant a channel opened by its /channel/UC…
       link was never reported, so the corpus never learned about it however often it was
       visited — and it then reported itself unindexed forever. */
    if (!key || seenChannels.has(key)) return;
    if (!key.startsWith('@') && !channelIdFromKey(key)) return;
    seenChannels.add(key);
    let channelId = id || channelIdFromKey(key) || '';
    if (!channelId) {
      try { channelId = (channelOwnStats() || {}).channelId || ''; } catch (e) { channelId = ''; }
    }
    sendMessage({ type: 'ytc-seen', key, channelId }, () => { /* fire and forget */ });
  }

  function ensureSimilarTab() {
    try {
      if (!settings.showSimilar || !channelKeyFromLocation()) {
        document.querySelectorAll('.ytc-tab').forEach((n) => n.remove());
        return;
      }

      /* Both or neither. Finding one is not proof the other survived a rebuild, and a pass
         that replaced only the missing one could place it in a different row. */
      const existing = document.querySelector(TAB_SIM_SELECTOR);
      const existingAn = document.querySelector(TAB_AN_SELECTOR);
      if (existing && existingAn && tabIsVisible(existing) && tabIsVisible(existingAn)) return;
      document.querySelectorAll('.ytc-tab').forEach((n) => n.remove());

      for (const bar of tabBarCandidates()) {
        if (!tabIsVisible(bar)) continue;
        const tab = buildSimilarTab();
        placeSimilarTab(tab, bar);
        if (!tabIsVisible(tab)) { tab.remove(); continue; }

        /* Analytics goes in beside it, built by the same function so the pair always look
           alike, and placed relative to it so they cannot end up in different rows. */
        const an = buildSimilarTab(ANALYTICS_LABEL, 'ytc-tab--an', openAnalyticsView);
        tab.parentElement.insertBefore(an, tab.nextSibling);
        if (!tabIsVisible(an)) an.remove();

        /* YouTube's own tabs do not know about this one, so clicking any of them has to put
           the page back. Without this the channel's real content stays hidden behind our
           view. Attached once, alongside the tab it belongs to. */
        if (!bar.dataset.ytcClose) {
          bar.dataset.ytcClose = '1';
          bar.addEventListener('click', (ev) => {
            if (ev.target.closest('.ytc-tab')) return;
            closeSimilarView();
            closeAnalyticsView();
          }, true);
        }
        return;
      }
    } catch (e) {
      // Never let this take the rest of scan() down with it.
      console.warn('[YouTube Toolkit] Similar tab could not be placed:', e);
    }
  }

  function similarHost() {
    const content = pageContent();
    let host = document.querySelector('.ytc-simview');
    if (host) {
      // Existing, but not necessarily still beside the element it is meant to replace.
      homePanel(host, content);
      return host;
    }
    if (!content || !content.parentElement) return null;
    host = document.createElement('div');
    host.className = 'ytc-simview';
    content.parentElement.insertBefore(host, content);
    return host;
  }

  function openSimilarView() {
    closeAnalyticsView();
    simFilter.open = true;
    /* Host first, page second. Hiding the content before the panel exists meant the panel was
       then created — and re-homed — against a container that was already display:none, and
       there was no longer anything to check the panel against. Build it, put it in the right
       place, and only then hide what it stands in front of. */
    const host = similarHost();
    if (!host) { retryOpenPanel('Similar channels'); return; }
    const content = pageContent();
    homePanel(host, content);
    hideForPanel(content, host);
    syncTabState();
    host.style.display = '';
    if (!host.dataset.loaded) host.innerHTML = similarSkeleton();
    askSimilar(false);
  }

  function closeSimilarView() {
    simFilter.open = false;
    showPageContent();
    syncTabState();
    const host = document.querySelector('.ytc-simview');
    if (host) host.style.display = 'none';
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Two different meanings used to share one flag. `force` redraws the table; `rediscover`
     re-scrapes YouTube search. Only Refresh means both. "Smaller than this" changes a
     subscriber bound and nothing else — the channel's topics are the same topics — so making
     it re-run three search fetches spent the user's rate limit on an answer already held. */
  function askSimilar(force, rediscover) {
    const key = channelKeyFromLocation();
    if (!key) return;
    const host = similarHost();
    /* Also on a forced refetch: Refresh and "Smaller than this" replace the whole table, and
       leaving the old rows up makes a slow lookup look like a dead button. */
    if (host && (force || !host.dataset.loaded)) {
      host.innerHTML = similarSkeleton();
    }
    const titles = channelVideoTitles(20);
    const about = channelAboutText();
    const own = channelOwnStats();
    const opts = {
      channelId: own.channelId,
      title: own.title,
      // "Smaller than this" is the question worth asking: an established channel's peers are
      // easy to name, while the ones just below it are what nobody can see.
      maxSubs: simFilter.smallOnly && own.subscribers ? own.subscribers : null
    };
    sendMessage({ type: 'ytc-similar', key, titles, about, force: !!rediscover, opts }, (res) => {
      if (chrome.runtime.lastError) {
        renderSimilar({ channels: [], reason: 'Extension reloaded — refresh this tab' });
        return;
      }
      renderSimilar(res);
    });
  }

  /* ------------------------------------------------------------- monetization */

  /* An estimate, not a verdict. Ad placements do not prove Partner Program membership — a
     demonetized channel emits the same forecasting slots as a monetized one — so this reads
     the proportion of recent videos carrying slots.

     The hedging lives in the tooltip rather than the label. "Likely not monetized" is
     accurate and unreadable at a glance; moneyTitle still states outright that this is
     inferred from ad slots, and carries the sample count so it can be judged rather than
     taken on faith. Not eligible keeps a muted colour instead of red: it is a different
     claim from not monetized, and the only one of the four that is a fact. */
  const MONEY_LABEL = {
    'not-eligible': { text: '$', big: 'Not eligible', cls: 'ytc-money--off',
      lead: 'Not eligible for ad monetization' },
    'likely-monetized': { text: '$', big: 'Monetized', cls: 'ytc-money--yes',
      lead: 'Monetized' },
    'likely-not': { text: '$', big: 'Not monetized', cls: 'ytc-money--no',
      lead: 'Not monetized' },
    unknown: { text: '$', big: 'Unknown', cls: 'ytc-money--unknown',
      lead: 'Not enough samples to judge' }
  };

  /* The breakdown behind the badge.

     The badge answers "is this channel earning". The obvious next question is "how", and the
     evidence for it was already being collected and thrown away. Each row names the stream,
     how many of the sampled videos carried it, and the line that decided it — so the reader
     can judge the call instead of taking it. */
  let revOpenTimer = null;
  let revCloseTimer = null;

  function holdRevenuePanel() {
    clearTimeout(revCloseTimer);
    revCloseTimer = null;
  }

  function scheduleRevenueClose() {
    clearTimeout(revCloseTimer);
    revCloseTimer = setTimeout(closeRevenuePanel, 260);
  }

  function closeRevenuePanel() {
    clearTimeout(revOpenTimer);
    clearTimeout(revCloseTimer);
    // The listeners outlive the element unless they are taken off with it.
    document.querySelectorAll('.ytc-rev').forEach((n) => {
      if (!n._reflow) return;
      window.removeEventListener('scroll', n._reflow);
      window.removeEventListener('resize', n._reflow);
    });
    document.querySelectorAll('.ytc-rev').forEach((n) => n.remove());
  }

  /* Below the badge if it fits, above it if not.

     The watch page's badge sits low in the metadata block, so a panel that always opened
     downward ran off the bottom of the window and could not be read at all. Measured after
     the panel is in the document, because its height depends on how many revenue streams
     were found. */
  const PANEL_GAP = 8;

  function placeRevenuePanel(panel, anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const h = panel.offsetHeight;
    const below = window.innerHeight - r.bottom - PANEL_GAP;
    const above = r.top - PANEL_GAP;
    const flip = h > below && above > below;

    panel.classList.toggle('ytc-rev--above', flip);
    // Clamped so neither edge leaves the window, whichever side it ended up on.
    const top = flip ? Math.max(PANEL_GAP, r.top - h - PANEL_GAP)
                     : Math.min(r.bottom + PANEL_GAP, window.innerHeight - h - PANEL_GAP);
    const left = Math.min(r.left, window.innerWidth - panel.offsetWidth - 12);
    panel.style.top = (Math.max(PANEL_GAP, top) + window.scrollY) + 'px';
    panel.style.left = (Math.max(12, left) + window.scrollX) + 'px';
  }

  function openRevenuePanel(anchorEl, res) {
    closeRevenuePanel();
    const streams = (res && res.streams) || [];
    const label = MONEY_LABEL[res && res.state] || MONEY_LABEL.unknown;
    const note = (anchorEl.dataset && anchorEl.dataset.ytcNote) || '';

    const rows = streams.length
      ? streams.map((st) =>
          '<div class="ytc-rev__row">' +
            '<span class="ytc-rev__tick">\u2713</span>' +
            '<span class="ytc-rev__body">' +
              '<span class="ytc-rev__name">' + escapeHtml(st.label) + '</span>' +
              '<span class="ytc-rev__hint">' + escapeHtml(st.hint) + '</span>' +
              '<span class="ytc-rev__eg">' + escapeHtml(st.example) + '</span>' +
            '</span>' +
            '<span class="ytc-rev__n">' + st.videos +
              (st.videos === 1 ? ' video' : ' videos') + '</span>' +
          '</div>').join('')
      : '<p class="ytc-rev__none">No revenue streams found in the sampled descriptions.</p>';

    const ads = res && res.withAds
      ? '<div class="ytc-rev__row">' +
          '<span class="ytc-rev__tick">\u2713</span>' +
          '<span class="ytc-rev__body">' +
            '<span class="ytc-rev__name">YouTube ads</span>' +
            '<span class="ytc-rev__hint">Ad slots served on the video</span>' +
          '</span>' +
          '<span class="ytc-rev__n">' + res.withAds +
            (res.withAds === 1 ? ' video' : ' videos') + '</span>' +
        '</div>'
      : '';

    const panel = document.createElement('div');
    panel.className = 'ytc-rev';
    panel.innerHTML =
      '<div class="ytc-rev__head"><b>' + escapeHtml(label.big) + '</b></div>' +
      '<p class="ytc-rev__sub">Based on ' + (res && res.checked ? res.checked : 0) +
        ' sampled ' + ((res && res.checked) === 1 ? 'video' : 'videos') +
        (note ? '. ' + escapeHtml(note) : '') + '.</p>' +
      ads + rows +
      /* The ad-slot caveat used to live in the native tooltip, which the panel now replaces.
         It is the one thing here a reader can most easily get wrong, so it moves rather than
         disappearing: a demonetized channel emits the same slots as a monetized one. */
      '<p class="ytc-rev__foot">Read from what the videos disclose \u2014 evidence of a ' +
        'stream, not a measure of income. YouTube also runs ads on channels that are not ' +
        'monetized and keeps that revenue, so ad slots are a signal rather than a status.</p>';

    document.body.appendChild(panel);
    placeRevenuePanel(panel, anchorEl);

    /* Moving the pointer from the pill to the panel crosses a gap, so leaving either one
       only schedules the close; entering the other cancels it. Without that the panel shuts
       on the way to it and can never be read. */
    panel.addEventListener('mouseenter', holdRevenuePanel);
    panel.addEventListener('mouseleave', scheduleRevenueClose);

    /* Scrolling with the panel open moves the badge, and near the edge of the window the
       panel that fitted a moment ago no longer does. Re-placed rather than left behind;
       passive, because this never blocks the scroll itself. */
    const reflow = () => { if (panel.isConnected) placeRevenuePanel(panel, anchorEl); };
    window.addEventListener('scroll', reflow, { passive: true });
    window.addEventListener('resize', reflow);
    panel._reflow = reflow;
  }

  function moneyTitle(res, videoNote) {
    const label = MONEY_LABEL[res.state] || MONEY_LABEL.unknown;
    const parts = [label.lead];

    /* Below the threshold this is a fact, not an estimate, so it gets none of the hedging
       the sampled states carry. */
    if (res.state === 'not-eligible') {
      parts.push('Under ' + (res.subs != null ? F.compact(res.subs) + ' subscribers, below' : 'below') +
        ' the 1,000 the Partner Program requires for ads, so it cannot run its own ads');
      return parts.join('. ');
    }

    if (res.checked) {
      parts.push(res.withAds + ' of ' + res.checked + ' recent videos carried ad slots');
    }
    if (videoNote) parts.push(videoNote);
    parts.push('Estimated from ad placements. YouTube also runs ads on channels that are not ' +
      'monetized and keeps that revenue, so treat this as a signal, not a status');
    return parts.join('. ');
  }

  /* The channel sample fetches several watch pages, so this can sit pending for a few
     seconds — long enough that a static dim badge reads as a broken one. Reuse the spinner
     the subscriber badge already uses, which carries its own reduced-motion fallback. */
  function ensureMoneyBadge(host, big) {
    let el = host.querySelector(':scope > .ytc-money');
    if (!el) {
      el = document.createElement('span');
      host.appendChild(el);
    }
    el.className = 'ytc-money ytc-money--loading' + (big ? ' ytc-money--lg' : '');
    el.title = 'Checking monetization…';
    el.textContent = '';
    const spin = document.createElement('span');
    spin.className = 'ytc-spin';
    el.appendChild(spin);
    if (big) {
      const word = document.createElement('span');
      word.textContent = 'Checking…';
      el.appendChild(word);
    }
    return el;
  }

  function paintMoney(el, res, big, videoNote) {
    const safe = res && res.state ? res : { state: 'unknown', checked: 0, withAds: 0 };
    const label = MONEY_LABEL[safe.state] || MONEY_LABEL.unknown;
    const retryable = safe.state === 'unknown';   // 'not-eligible' is settled, never retried
    el.className = 'ytc-money ' + label.cls + (big ? ' ytc-money--lg' : '') +
      (retryable ? ' ytc-money--retry' : '');
    /* The channel-page pill carries the extension icon, so it reads as ours among YouTube's
       own buttons. The card badge stays a bare glyph — it is 18px, with no room for one.
       Either way this replaces the contents, which is what clears the spinner. */
    if (big) {
      let icon = '';
      try { icon = chrome.runtime.getURL('icons/icon32.png'); } catch (e) { icon = ''; }
      el.innerHTML = (icon ? '<img class="ytc-money__icon" src="' + icon + '" alt="">' : '') +
        '<span>' + escapeHtml(label.big) + '</span>';
    } else {
      el.textContent = label.text;
    }
    /* Only the channel-page pill opens the breakdown. The card badge is 18px and already has
       a click meaning when a verdict needs retrying. */
    /* The channel pill always, and the watch page's badge because it was asked for. Not the
       badges in a feed grid: a panel that opens on hover would fire constantly while the
       pointer crosses a page of thumbnails. */
    const hasPanel = !retryable && (big || el.dataset.ytcPanel === '1');
    /* No native tooltip where the panel exists: the browser draws it over the panel the same
       hover opened, saying the same thing in a greyer box. Everywhere else it is the only
       explanation there is. */
    if (hasPanel) {
      el.removeAttribute('title');
      /* What this particular video shows, which the channel-level rows cannot say. It was in
         the tooltip the panel replaced, so it moves into the panel rather than being lost. */
      if (videoNote) el.dataset.ytcNote = videoNote;
      else delete el.dataset.ytcNote;
    }
    else el.title = moneyTitle(safe, videoNote) + (retryable ? '. Click to try again' : '');

    if (hasPanel) {
      el.classList.add('ytc-money--more');
      /* A short delay so passing over the pill on the way somewhere else does not flash the
         panel open. */
      el.onmouseenter = () => {
        holdRevenuePanel();
        clearTimeout(revOpenTimer);
        revOpenTimer = setTimeout(() => openRevenuePanel(el, safe), 160);
      };
      el.onmouseleave = () => {
        clearTimeout(revOpenTimer);
        scheduleRevenueClose();
      };
      /* Touch has no hover, so the tap has to work too — and a second tap closes it. */
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (document.querySelector('.ytc-rev')) closeRevenuePanel();
        else openRevenuePanel(el, safe);
      };
    }
  }

  /* An "unknown" badge should never be a dead end that only a page reload clears. */
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest && e.target.closest('.ytc-money--retry');
    if (!el || !el.dataset.key) return;
    e.preventDefault();
    e.stopPropagation();
    const key = el.dataset.key;
    const big = el.classList.contains('ytc-money--lg');
    const host = el.parentElement;
    if (!host) return;
    const fresh = ensureMoneyBadge(host, big);
    fresh.dataset.key = key;
    sendMessage({ type: 'ytc-monetization', key, force: true }, (res) => {
      if (!fresh.isConnected) return;
      paintMoney(fresh, chrome.runtime.lastError ? null : res, big);
    });
  }, true);

  /* YouTube navigates between videos without reloading, and page.js reads a global that the
     new page has not necessarily rewritten yet. Asking for the ad slots too early returns the
     PREVIOUS video's answer, which is worse than no answer, so wait until the payload names
     the video actually in the address bar. */
  async function freshPage(videoId, tries) {
    // 5s, not 1.5s. A heavier watch page can take several seconds to rewrite the player
    // global, and giving up early was leaving the metrics card off those videos entirely.
    for (let i = 0; i < (tries || 20); i++) {
      const page = await pageData();
      if (page && page.videoId === videoId) return page;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  /* The watch page can answer this for free: page.js reads the ad slots the live player was
     handed, no network at all. Only when that comes back empty is it worth paying for the
     channel sample, because an empty result on one video says little on its own. */
  /* One read of the live player serves both features, so they share a call rather than
     asking page.js twice. Either can be switched off without disabling the other. */
  async function checkWatchMoney(card, videoId) {
    const wantMoney = settings.showMoney;
    const wantStats = settings.showStats;
    if (!wantMoney && !wantStats) return;

    trackCardVideo(videoId);
    const tools = ensureTools(card);
    const el = wantMoney ? ensureMoneyBadge(tools, false) : null;
    // The badge element survives navigation; clear the previous video's verdict from it.
    if (el) el.removeAttribute('title');

    const page = await freshPage(videoId);
    if (card.dataset.ytcMoneyVid !== videoId) return true;   // navigated away while waiting

    /* A reply is not the same as a usable reply. An extension reload leaves the previous
       page.js running in tabs that were already open, and that older build answers without a
       stats block — which used to be counted as success, so the card sat on placeholders
       forever with no retry. Treat a missing stats block as a failed read. */
    let stats = page && page.stats;
    if (!stats) stats = domStats(card);      // rendered page as a fallback source
    if (wantStats) renderMetrics(card, stats, videoId);

    /* The monetization lookup needs only the channel key, which comes from the DOM — so a
       failed page read must not block it. Letting it do so is what left the badge spinning
       forever on a video whose player data never arrived. */
    if (el) {
      /* This video's own slots come free from the live player, but one video cannot settle a
         channel-level question — a single forecasting slot is precisely the false positive
         being avoided. So the verdict always comes from the channel sample, and the free
         signal only enriches the tooltip with what this particular video shows. */
      const ads = page && page.ads;
      const note = ads
        ? (ads.placements > 0 ? 'This video carries ad slots' : 'This video carries none')
        : '';
      /* Prefer the channel the live player names over the one the DOM shows. They disagree
         for a moment after a soft navigation, and acting on the DOM's answer is what pinned
         the previous video's monetization onto the next one. */
      const st = page && page.stats;
      const key = (st && (st.channelHandle || (st.channelId && 'channel/' + st.channelId))) ||
        findChannelKey(card);
      /* The player's own answer, so it is right immediately after a soft navigation.
         Watching a video is as good a signal as opening the channel, and it is the commoner
         one — most people arrive at a channel through its videos, not its page. */
      if (st && st.channelHandle) {
        noteChannelSeen(st.channelHandle, st.channelId || '');
        reportWatchEdges(st.channelHandle, videoId, st.channelId || '');
      }
      /* Marked on the element rather than passed as an argument, so it survives the repaints
         that go through other call sites — the retry path re-paints without knowing which
         badge it is looking at. */
      el.dataset.ytcPanel = '1';
      if (!key) {
        paintMoney(el, null, false, note);
      } else {
        el.dataset.key = key;
        requestMonetizationOnce(key, (res) => {
          if (card.dataset.ytcMoneyVid !== videoId) return;
          paintMoney(el, res, false, note);
        });
      }
    }

    // Only the metrics half depends on the page read, so only it asks for a retry.
    return !!stats;
  }

  /* Runs on every scan rather than only on a fresh card: YouTube reuses the same
     ytd-watch-metadata element across navigations, so "fresh" is false on the second video
     and the badge would keep showing the first one's verdict. */
  const WATCH_MAX_TRIES = 6;
  const WATCH_RETRY_DELAYS = [600, 1500, 3000, 6000, 10000];

  function syncWatchMoney(card) {
    if (!settings.showMoney && !settings.showStats) return;
    const id = findUrl(card).id;
    if (!id || card.dataset.ytcMoneyVid === id) return;
    /* Once a retry is armed, only its timer may drive the next attempt. Without this the
       scans that keep arriving during navigation each consume a try of their own, and the
       whole budget burns within a few seconds — before a slow page has finished hydrating,
       which is the case the retries exist for. */
    if (card.dataset.ytcMoneyPending === id) return;
    card.dataset.ytcMoneyVid = id;
    if (card.dataset.ytcMoneyFor !== id) {
      card.dataset.ytcMoneyFor = id;
      card.dataset.ytcMoneyTries = '0';
      card.removeAttribute('data-ytc-money-pending');   // belongs to the previous video
    }
    checkWatchMoney(card, id).then((ok) => {
      if (ok || card.dataset.ytcMoneyVid !== id) return;
      const tries = Number(card.dataset.ytcMoneyTries || 0) + 1;
      card.dataset.ytcMoneyTries = String(tries);
      if (tries >= WATCH_MAX_TRIES) {
        card.removeAttribute('data-ytc-money-pending');
        /* Out of retries: the player data is not coming. The cells that need it should say
           so with a dash rather than sweep forever, which would promise a number that no
           longer has anything on its way. */
        if (cardState.videoId === id && cardState.pending.metrics) {
          cardState.pending.metrics = false;
          renderStatsCard();
        }
        return;
      }
      card.removeAttribute('data-ytc-money-vid');
      card.dataset.ytcMoneyPending = id;

      /* Drive the retry from a timer rather than releasing the marker and waiting for the
         next scan. Scans come from the MutationObserver, and a watch page that has finished
         settling produces no more mutations — so an armed retry could sit unfired until the
         user reloaded the page. That was the refresh people were reaching for. */
      const wait = WATCH_RETRY_DELAYS[Math.min(tries - 1, WATCH_RETRY_DELAYS.length - 1)];
      setTimeout(() => {
        card.removeAttribute('data-ytc-money-pending');
        if (card.isConnected && findUrl(card).id === id) syncWatchMoney(card);
      }, wait);
    });
  }

  /* Channel pages have no player to read, so the only route is sampling recent uploads in
     the background. */
  function channelKeyFromLocation() {
    const m = location.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* Anchor on the Subscribe button rather than a header container. Container ids and
     view-model tag names get renamed as YouTube re-skins the channel page, but a Subscribe
     button has to stay findable, and its action row is exactly where this badge belongs. */
  const SUBSCRIBE_SELECTOR = [
    'ytd-subscribe-button-renderer',
    'yt-subscribe-button-view-model',
    'button[aria-label^="Subscribe"]',
    'button-view-model button[aria-label*="Subscribe"]'
  ].join(', ');

  const ACTION_ROW = 'yt-flexible-actions-view-model, .yt-flexible-actions-view-model-wiz, ' +
    '#inner-header-container, #meta, #channel-header-container';

  const CHANNEL_SCOPES = [
    'ytd-browse[page-subtype="channels"]:not([hidden])',
    'ytd-browse[page-subtype="channels"]',
    'yt-page-header-view-model'
  ];

  function visible(el) {
    return !!el && el.offsetParent !== null;
  }

  /* Searching the whole document took the first Subscribe button in document order, which
     after leaving a watch page can be that page's own button, still in the DOM and hidden.
     The badge then attached to something invisible and only a reload — which rebuilds the
     document — appeared to fix it. Search inside the channel browser, and require the
     element to actually be on screen. */
  function channelHeaderHost() {
    let scope = null;
    for (const sel of CHANNEL_SCOPES) {
      const el = document.querySelector(sel);
      if (visible(el)) { scope = el; break; }
    }
    if (!scope) return null;

    const subs = Array.from(scope.querySelectorAll(SUBSCRIBE_SELECTOR)).filter(visible);
    for (const sub of subs) {
      // Sit beside Subscribe, not inside its own wrapper, so YouTube's own re-renders of
      // that button do not take the badge with them.
      const row = sub.closest(ACTION_ROW);
      if (visible(row)) return row;
      if (visible(sub.parentElement)) return sub.parentElement;
    }
    /* An owner looking at their own channel gets Customize / Manage where Subscribe would be,
       so the search above finds nothing and the badge fell through to the whole header — which
       parks it under the avatar instead of in the button row. Match the row by structure, not
       by button label: a label test would be one locale away from breaking. */
    for (const row of Array.from(scope.querySelectorAll(ACTION_ROW)).filter(visible)) {
      if (Array.from(row.querySelectorAll('button, yt-button-shape')).some(visible)) return row;
    }

    const header = scope.querySelector('yt-page-header-view-model') ||
      scope.querySelector('#channel-header');
    return visible(header) ? header : null;
  }

  /* Re-evaluated on every scan rather than latched once, for the same reason the watch-page
     badge is: YouTube rebuilds the channel header during a soft navigation. A latch that only
     remembered "already handled this channel" kept skipping after the rebuild had thrown the
     badge away, so the status appeared only after a hard reload. Verify the badge is still
     attached to the host we would choose now, and re-attach it when it is not. */
  /* The channel header can hydrate long after scan() last ran. Relying on the MutationObserver
     to come back was the bug: once the page settles there are no more mutations, so a scan
     that arrived too early was simply the last one, and the badge never appeared until a
     manual reload. Retry on our own timer, the way card detection already does. */
  const channelDetect = { key: '', tries: 0, timer: null };
  const CHANNEL_DETECT_MAX = 12;   // ~40s of attempts, for slow hydration

  function scheduleChannelRetry(key) {
    if (channelDetect.key !== key) {
      if (channelDetect.timer) clearTimeout(channelDetect.timer);
      channelDetect.key = key;
      channelDetect.tries = 0;
      channelDetect.timer = null;
    }
    if (channelDetect.timer || channelDetect.tries >= CHANNEL_DETECT_MAX) return;
    const delay = DETECT_DELAYS[Math.min(channelDetect.tries, DETECT_DELAYS.length - 1)];
    channelDetect.tries++;
    channelDetect.timer = setTimeout(() => {
      channelDetect.timer = null;
      if (channelKeyFromLocation() === key) decorateChannelHeader();
    }, delay);
  }

  /* The sample runs three sequential page fetches in the service worker, which MV3 may evict
     mid-flight — in which case the callback never fires and the badge spins forever, which
     looks exactly like "no status" from the outside. Bound the wait so it always resolves to
     something clickable. */
  const MONEY_TIMEOUT = 60000;

  /* An "unknown" result is usually transient — the service worker was evicted mid-sample, or
     the channel page fetch lost a race. The badge is click-to-retry, but nobody knows that,
     so retry once automatically before leaving it to the user. Once only: the sample costs
     several page fetches and a loop would be worse than a stale badge. */
  const MONEY_AUTO_RETRY_MS = 8000;
  const autoRetried = new Set();

  function requestMonetizationOnce(key, done) {
    requestMonetization(key, (res) => {
      const settledOk = res && res.state && res.state !== 'unknown';
      if (settledOk || autoRetried.has(key)) { done(res); return; }
      autoRetried.add(key);
      done(res);                       // show what we have meanwhile
      setTimeout(() => requestMonetization(key, done), MONEY_AUTO_RETRY_MS);
    });
  }

  function requestMonetization(key, done) {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      done(null);
    }, MONEY_TIMEOUT);
    try {
      sendMessage({ type: 'ytc-monetization', key }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(chrome.runtime.lastError ? null : res);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(null);
    }
  }

  /* On the title line rather than in the button row beside Subscribe: this describes the
     channel the way the subscriber count does, and the button row already carries the
     monetization pill.

     The average comes from the channel's lifetime totals (views ÷ videos), which is the same
     denominator the index stores for every other channel — so the number here and the numbers
     in the Similar Channels table are the same measure and can be compared. */
  function channelTitleHost() {
    const header = document.querySelector('yt-page-header-view-model, #channel-header');
    const h1 = header && header.querySelector('h1');
    return visible(h1) ? h1 : null;
  }

  /* Every match, not the first: YouTube leaves stale headers in the document after a soft
     navigation, so a badge can survive on an element that is no longer on screen — and a
     forgotten one is exactly what "the badge appears twice" looks like. */
  function clearOutlierBadges(keep) {
    document.querySelectorAll('.ytc-out').forEach((n) => {
      if (n !== keep) n.remove();
    });
  }

  function decorateChannelOutlier(key) {
    if (!key || !settings.showRatio) { clearOutlierBadges(null); return; }

    const host = channelTitleHost();
    if (!host) { clearOutlierBadges(null); return; }

    /* The claim is this flag, set synchronously before the lookup — not the badge, which does
       not exist until the lookup returns. Testing for the badge let a second scan through
       while the first request was still in flight, and both callbacks then appended one.

       A header rebuild takes the flag with the element it was set on, which is what makes the
       badge come back after a soft navigation. */
    if (host.dataset.ytcOut === key) return;
    clearOutlierBadges(null);
    host.dataset.ytcOut = key;

    sendMessage({ type: 'ytc-subs', key }, (res) => {
      if (chrome.runtime.lastError) return;
      if (!host.isConnected || host.dataset.ytcOut !== key) return;
      const avgViews = res && res.stats && res.stats.avgViews > 0 ? res.stats.avgViews : 0;
      // The header count is already on screen and needs no fetch; the lookup is the fallback.
      const subs = channelOwnStats().subscribers || F.viewsToNumber((res && res.text) || '') || 0;
      const html = outlierPill({ avgViews: avgViews, subscribers: subs });
      if (!html) return;
      host.insertAdjacentHTML('beforeend', html);
      // Belt and braces: whatever we just added is the only one that stays. (:last-of-type
      // would match on the span tag, not the class, and the h1 holds other spans.)
      const added = host.querySelectorAll(':scope > .ytc-out');
      clearOutlierBadges(added[added.length - 1] || null);
    });
  }

  /* The channel the on-page panels were last drawn for, so a move between channels can be
     told from a redraw of the same one. */
  let panelKey = '';

  function decorateChannelHeader() {
    const key = channelKeyFromLocation();
    const stray = document.querySelector('.ytc-money--lg');

    // Left a channel page (or the badge was switched off): clean up after ourselves.
    decorateChannelOutlier(key);

    if (!key) {
      if (stray) stray.remove();
      // Restore YouTube's own content before dropping our view, or it stays display:none.
      closeSimilarView();
      closeAnalyticsView();
      document.querySelectorAll('.ytc-sim, .ytc-simview, .ytc-an').forEach((n) => n.remove());
      panelKey = '';
      return;
    }

    /* Moving from one channel to another. The hosts are only torn down on leaving channel
       pages altogether, so channel-to-channel kept dataset.loaded set and the previous
       channel's rendered panel stayed on screen under the new channel's name until a fresh
       response arrived — indistinguishable, while it lasted, from figures about this channel.
       The request already refuses to render a late reply for the wrong channel; this covers
       the render that was already on the page before the request went out. */
    if (panelKey && panelKey !== key) {
      document.querySelectorAll('.ytc-an, .ytc-sim, .ytc-simview').forEach((n) => {
        delete n.dataset.loaded;
        n.innerHTML = '';
      });
      simFilter.chip = 'all';
      simFilter.reveal = 0;
    }
    panelKey = key;
    if (!settings.showMoney) {
      if (stray) stray.remove();
      const host0 = channelHeaderHost();
      return;
    }

    const host = channelHeaderHost();
    if (!host) { scheduleChannelRetry(key); return; }

    const attached = stray && stray.parentElement === host;
    if (attached && host.dataset.ytcMoney === key) return;   // present and current

    // A badge that survived on a stale element would otherwise be duplicated.
    if (stray && !attached) stray.remove();
    host.dataset.ytcMoney = key;

    const el = ensureMoneyBadge(host, true);
    el.dataset.key = key;
    requestMonetizationOnce(key, (res) => {
      // The user may have navigated away, or the header rebuilt, while the sample ran.
      if (!el.isConnected || host.dataset.ytcMoney !== key) return;
      paintMoney(el, res, true);
    });
  }

  /* No channel to look up: still show something, so a blank corner never looks like a bug. */
  function renderEmpty(card, why) {
    if (subsCountRedundant(card)) return;
    const badge = makeBadge(card);
    badge.dataset.key = '';
    badge.classList.remove('ytc-subs--loading', 'ytc-subs--failed');
    badge.classList.add('ytc-subs--none');
    badge.title = why;
    badge.innerHTML = '<span class="ytc-subs__n">— subs</span>';
  }

  function renderLoading(card, retrying) {
    if (subsCountRedundant(card) && !settings.showRatio) return;
    const badge = makeBadge(card);
    badge.dataset.key = findChannelKey(card);
    badge.classList.remove('ytc-subs--failed');
    badge.classList.add('ytc-subs--loading');
    badge.title = retrying ? 'Retrying…' : 'Looking up subscriber count…';
    badge.innerHTML =
      '<span class="ytc-subs__n"><span class="ytc-spin"></span>' +
      (retrying ? 'retrying' : 'subs') + '</span>';
  }

  /* entry is undefined while a lookup is still in flight, {text} once it lands, and
     {text: null, reason} when it failed — a failure gets a dim badge rather than nothing,
     so "unavailable" never looks like "still loading". */
  /* YouTube prints the subscriber count itself on a watch page, and on a channel page every
     card belongs to the same channel, so the number is either duplicated or repeated down the
     grid. Suppress it in both places — but only the number. The lookup still runs, because
     the outlier ratio is computed from the channel's lifetime average views, which comes back
     with it. */
  function subsCountRedundant(card) {
    return isWatchCard(card) || !!channelKeyFromLocation();
  }

  function renderBadge(card, entry) {
    if (!entry) return;
    const badge = makeBadge(card);
    badge.dataset.key = findChannelKey(card);
    badge.classList.remove('ytc-subs--loading');

    if (!entry.text) {
      if (subsCountRedundant(card)) { badge.remove(); return; }
      badge.classList.add('ytc-subs--failed');
      const more = (entry.tries || 0) < RETRY_DELAYS.length &&
        F.isRetryableFailure(entry.reason);
      badge.title = 'Subscriber count unavailable' +
        (entry.reason ? ' — ' + entry.reason : '') +
        (more ? '. Retrying shortly; click to retry now.' : '. Click to retry.');
      badge.innerHTML = '<span class="ytc-subs__n">— subs</span>';
    } else {
      badge.classList.remove('ytc-subs--failed');
      badge.title = entry.text;
      const subsN = F.viewsToNumber(entry.text);
      const hideCount = subsCountRedundant(card);
      const parts = hideCount
        ? []
        : ['<span class="ytc-subs__n">' + (F.compact(subsN) || '—') + ' subs</span>'];
      const viewsN = F.viewsToNumber(findMeta(card).views);
      /* Prefer views ÷ the channel's lifetime average, which is what "outlier" means in
         every other tool (a 1.4M-view video on a channel averaging 1.56M is 0.9x, not the
         0.1x that dividing by 11.1M subscribers would suggest). The subscriber ratio stays
         as the fallback for channels whose /about page did not yield totals. */
      const avgViews = entry.stats && entry.stats.avgViews > 0 ? entry.stats.avgViews : 0;
      const denom = avgViews || subsN;
      /* Stamped on the card so the filter can read these back without re-parsing the badges
         it just drew. Every number here was computed to render the badge anyway. */
      card.dataset.ytcSubsN = subsN || '';
      card.dataset.ytcJoined = (entry.stats && entry.stats.joinedAt) || '';
      card.dataset.ytcViewsN = (viewsN == null ? '' : viewsN);
      card.dataset.ytcDenomN = denom || '';
      // Kept apart so the filter can tell the two ratios from each other; denom above
      // conflates them and is only still written for anything reading it as one number.
      card.dataset.ytcAvgN = avgViews || '';
      /* Two questions, so two pills rather than one that quietly changes meaning. Filled is
         the outlier proper, against what this channel normally gets; outlined is against the
         subscriber count. The single badge showed whichever denominator it could get and
         named it only in the tooltip, so the same pill meant different things on neighbouring
         cards — and a filter built on it could not say which it was filtering. */
      if (settings.showRatio && viewsN != null) {
        if (avgViews > 0) {
          const shown = ratioLabel(viewsN / avgViews);
          parts.push('<span class="ytc-ratio ' + ratioClass(shown.value) + '" title="' +
            ratioTitle(shown.value, avgViews) + '">' + shown.text + '</span>');
        }
        if (subsN > 0) {
          const shown = ratioLabel(viewsN / subsN);
          /* The outlined ladder the channel-header pill already uses — same five hues, same
             thresholds, and already carrying its dark-theme values. Filled means against the
             channel's average, outlined means against its subscribers; a 3x reads as a 3x
             either way, and the shape says which question was asked. */
          parts.push('<span class="ytc-vsub ytc-out--' + ratioTier(shown.value) +
            '" title="' + subRatioTitle(shown.value, subsN) + '">' + shown.text + '</span>');
        }
      }
      /* Views per hour, from the card's own metadata — no extra request. The card only has a
         relative timestamp, so this is coarser than the watch page's figure, which has an
         exact publish time; it is for comparing cards against each other. Hidden below 1/h,
         where the number is noise rather than information. */
      /* Wrapped because this is the last thing added to the badge and the least important
         thing on it. An exception here previously took the whole render with it — the
         subscriber count and the outlier vanished alongside the pill that caused it, which
         made a small bug look like a total failure. */
      if (settings.showStats) {
        try {
          const meta = findMeta(card);
          const vph = meta.date
            ? F.vphFromRelative(meta.views, meta.date, Date.now())
            /* Shorts print no date at all, so there is no relative phrase to parse. When the
               id lookup supplied a real timestamp, use it directly — it is more precise than
               the "3 weeks ago" the other path has to work from, not less. */
            : vphFromStamp(meta.views, card.dataset.ytcPub);
          if (vph != null && vph >= 1) {
            parts.push('<span class="ytc-vph" title="' +
              Math.round(vph).toLocaleString() + ' views per hour on average since it was posted. ' +
              'Estimated from the card\'s relative date, so approximate">' +
              F.formatVph(vph) + ' VPH</span>');
          }
        } catch (e) {
          /* keep the rest of the badge */
        }
      }

      // Only the channel average is a real outlier; the subscriber fallback is a different
      // measure and would be mislabelled in a cell headed "Outlier".
      if (isWatchCard(card) && avgViews > 0 && viewsN != null) {
        setCardOutlier(findUrl(card).id, viewsN / avgViews);
      }
      // With the count hidden and no ratio to show there is nothing left to render.
      if (!parts.length) { badge.remove(); return; }
      badge.innerHTML = parts.join('');
    }

  }

  function askFor(key, force, tries) {
    sendMessage({ type: 'ytc-subs', key, force }, (res) => {
      if (chrome.runtime.lastError) { requested.delete(key); return; }
      const entry = {
        text: (res && res.text) || null,
        reason: (res && res.reason) || '',
        stats: (res && res.stats) || null,   // lifetime totals, for the outlier denominator
        t: Date.now(),
        tries: tries || 0
      };
      subsByKey.set(key, entry);
      for (const c of cardsByKey.get(key) || []) {
        if (c.isConnected) renderBadge(c, entry);
      }
      cardsByKey.delete(key);
      if (!entry.text) scheduleRetry(key, entry);
      // Handles can contain characters that need escaping in a selector; just scan.
      document.querySelectorAll('.ytc-subs').forEach((b) => {
        if (b.dataset.key !== key) return;
        const card = b.closest('.ytc-card');
        if (card) renderBadge(card, entry);
      });
    });
  }

  /* Find cards by channel, not by the badge element: YouTube recycles cards as you scroll,
     so the badge we rendered may be long gone by the time a retry timer fires. */
  function cardsFor(key) {
    return Array.from(document.querySelectorAll('.ytc-card'))
      .filter((c) => c.isConnected && findChannelKey(c) === key);
  }

  function retryNow(key, tries) {
    if (!key) return;
    const cards = cardsFor(key);
    if (!cards.length) return;       // nothing from this channel is on the page any more
    subsByKey.delete(key);
    requested.add(key);
    for (const card of cards) renderLoading(card, true);
    askFor(key, true, tries);
  }

  /* The background retries within a single lookup, but throttling can outlast that. Keep
     trying on a timer so a failed badge recovers on its own instead of waiting for a click. */
  function scheduleRetry(key, entry) {
    const tries = entry.tries || 0;
    if (tries >= RETRY_DELAYS.length) return;
    // Only a hard 404 everywhere is settled; everything else is worth another ask.
    if (!F.isRetryableFailure(entry.reason)) return;
    setTimeout(() => {
      if (!settings.showSubs) return;
      const current = subsByKey.get(key);
      if (current && current.text) return;   // resolved some other way in the meantime
      retryNow(key, tries + 1);
    }, RETRY_DELAYS[tries]);
  }

  /* Retry a failed channel on click — most failures are YouTube throttling us. */
  document.addEventListener('click', (e) => {
    const badge = e.target.closest && e.target.closest('.ytc-subs');
    if (!badge) return;

    if (badge.classList.contains('ytc-subs--none')) {
      e.preventDefault();
      e.stopPropagation();
      const card = badge.closest('.ytc-card');
      badge.remove();
      if (card) { delete card.dataset.ytcDetect; wantSubs(card); }
      return;
    }

    if (!badge.classList.contains('ytc-subs--failed') || !badge.dataset.key) return;
    e.preventDefault();
    e.stopPropagation();
    retryNow(badge.dataset.key, 0);
  }, true);

  /* A search page or feed can hold dozens of distinct channels, and each lookup pulls a
     ~1.6MB /about page. Firing them all the moment the cards are decorated is a burst that
     Google answers with its "unusual traffic" interstitial — the request is redirected to
     google.com/sorry, which is cross-origin, so the fetch dies on CORS and every lookup after
     it fails the same way. Badges then go missing in patches, which is what this looked like.

     So only look up channels whose cards are on screen or nearly so, and let the rest arrive
     as the user scrolls to them. */
  const NEAR_VIEWPORT_PX = 600;

  function nearViewport(card) {
    const r = card.getBoundingClientRect();
    // Height alone decides it: a card can have width while still being collapsed to nothing,
    // and requiring both to be zero let those through as if they were on screen.
    if (!r.height) return false;                      // not laid out yet
    return r.top < window.innerHeight + NEAR_VIEWPORT_PX && r.bottom > -NEAR_VIEWPORT_PX;
  }

  const subsObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          subsObserver.unobserve(e.target);
          e.target.dataset.ytcNear = '1';
          wantSubs(e.target);
        }
      }, { rootMargin: NEAR_VIEWPORT_PX + 'px' })
    : null;

  /* The channel's lifetime totals, which the watch page never prints — the Outlier cell is
     the only thing that needs them. Driven by a timer rather than by the next scan: a
     throttled lookup is cached for two minutes in the background, and scans come from the
     MutationObserver, which falls silent once the page has settled. So one unlucky first ask
     left the cell blank for the rest of the visit with a working answer a few seconds away,
     and reloading was the only way to get it. That is the refresh people were reaching for.

     Bounded, and only while asking again could plausibly change the answer: a channel that
     publishes no totals says so the same way however often it is asked. */
  const STATS_MAX_TRIES = 4;
  const STATS_RETRY_DELAYS = [1500, 4000, 12000];

  /* The key stays in statsRequested for the whole chain, not just the request in flight.
     Releasing it between attempts let each arriving scan start a chain of its own, and the
     whole budget burned in a couple of seconds — before the two-minute backoff the retries
     exist to outlast had even begun. */
  function askWatchStats(card, key, shownText) {
    if (statsRequested.has(key)) return;
    statsRequested.add(key);
    attemptWatchStats(card, key, shownText, 0);
  }

  function attemptWatchStats(card, key, shownText, tries) {
    sendMessage({ type: 'ytc-subs', key }, (res) => {
      const failed = !!chrome.runtime.lastError || !res;
      const stats = (!failed && res.stats) || null;
      const text = (!failed && res.text) || '';
      const reason = (!failed && res.reason) || '';
      if (!failed) {
        // Keep the DOM's count — it is the one we trust for this channel — and take only
        // the totals from the lookup.
        subsByKey.set(key, {
          text: text || shownText, reason, stats, t: Date.now(), tries: 0
        });
      }
      const live = card.isConnected && findChannelKey(card) === key;
      if (stats) {
        statsRequested.delete(key);
        if (live) {
          renderBadge(card, { text: shownText, reason: '', stats, t: Date.now() });
          /* The totals are here. If no outlier came of them — no view count on the page to
             divide by the average — that is the answer rather than something still coming,
             so the cell settles. renderBadge has already cleared this when it did compute
             one, which makes this a no-op in the ordinary case. */
          settleOutlier();
        }
        return;
      }
      /* Reached the channel but found no totals on it: an answer about the channel rather
         than a failure to reach it, so asking again would only replay it. */
      const settled = !failed && (!!text || !F.isRetryableFailure(reason));
      if (!live || settled || tries >= STATS_MAX_TRIES - 1) {
        statsRequested.delete(key);
        // A card that has moved on owns none of this; the new video drives its own state.
        if (live) settleOutlier();
        return;
      }
      const wait = STATS_RETRY_DELAYS[Math.min(tries, STATS_RETRY_DELAYS.length - 1)];
      setTimeout(() => {
        if (card.isConnected && findChannelKey(card) === key) {
          attemptWatchStats(card, key, shownText, tries + 1);
        } else {
          statsRequested.delete(key);
        }
      }, wait);
    });
  }


  /* ------------------------------------------------- channels by video id */

  /* A short's lockup names no channel and gives no date, in the DOM or in ytInitialData —
     measured across fifty lockups on two live results pages, the whole payload is a title, a
     view count and a thumbnail. So every badge the extension draws is unavailable for a
     short: the subscriber count, both ratios (which need the channel) and views per hour
     (which needs an age). Waiting for hydration cannot fix what was never sent.

     The video id is the one identifier a short does carry, and the index service turns fifty
     ids into channels for a single quota unit. Cards are batched rather than asked for one at
     a time, because a results page is thirty shorts arriving within a second of each other
     and thirty requests would be thirty times the cost of one. */
  const OWNER_DEBOUNCE = 250;
  const OWNER_BATCH = 50;

  let ownerQueue = new Map();     // video id -> Set of cards waiting on it
  let ownerTimer = null;
  /* Ids that are settled: the service answered, or it failed enough times to stop asking.
     A transient failure deliberately does NOT land here. The index sleeps when idle and the
     first request after that fails outright, so retiring an id on its first failure meant one
     cold start permanently dashed every Short on the page for the rest of the session. */
  const ownerDone = new Set();
  const ownerTries = new Map();   // id -> failed attempts so far
  const OWNER_MAX_TRIES = 3;

  function isShortCard(card) {
    return !!(card.matches('ytd-reel-item-renderer, ytm-shorts-lockup-view-model') ||
              card.querySelector('a[href*="/shorts/"]'));
  }

  /* True when the card was taken on and the caller should show a spinner rather than a dash. */
  function queueOwnerLookup(card) {
    if (!isShortCard(card)) return false;
    const id = findUrl(card).id;
    if (!id) return false;
    if (card.dataset.ytcChan) return false;
    // Settled ids are not asked again. A miss is a fact about the video; a failure is not.
    if (ownerDone.has(id) && !ownerQueue.has(id)) return false;

    if (!ownerQueue.has(id)) ownerQueue.set(id, new Set());
    ownerQueue.get(id).add(card);
    if (!ownerTimer) ownerTimer = setTimeout(flushOwnerLookups, OWNER_DEBOUNCE);
    return true;
  }

  function flushOwnerLookups() {
    ownerTimer = null;
    if (!ownerQueue.size) return;
    const pending = ownerQueue;
    ownerQueue = new Map();

    const ids = Array.from(pending.keys()).slice(0, OWNER_BATCH);
    // Anything over the batch ceiling goes back for the next pass rather than being dropped.
    for (const [id, cards] of pending) {
      if (ids.indexOf(id) < 0) ownerQueue.set(id, cards);
    }
    if (ownerQueue.size && !ownerTimer) {
      ownerTimer = setTimeout(flushOwnerLookups, OWNER_DEBOUNCE);
    }

    sendMessage({ type: 'ytc-video-owners', videos: ids }, (res) => {
      if (chrome.runtime.lastError) return;
      const found = (res && res.videos) || {};
      /* The service could not be reached at all: nothing here is a fact about any video, so
         hold the ids back for another pass instead of dashing every card. */
      const reachable = !!(res && res.ok);
      for (const id of ids) {
        const rec = found[id];
        if (!reachable && !rec) {
          const tries = (ownerTries.get(id) || 0) + 1;
          ownerTries.set(id, tries);
          if (tries < OWNER_MAX_TRIES) {
            ownerQueue.set(id, pending.get(id) || new Set());
            continue;
          }
        }
        ownerDone.add(id);
        for (const card of pending.get(id) || []) {
          if (!card.isConnected) continue;
          if (!rec || !rec.channel) {
            /* No answer, and none is coming. Say what is actually true rather than leaving a
               spinner running: for a short, "no channel on this card" is the honest state. */
            renderEmpty(card, res && res.ok
              ? 'YouTube does not put a channel on Shorts results, and this one could not be '
                + 'resolved by its video id.'
              : 'Could not resolve this Short’s channel: ' +
                ((res && res.reason) || 'the index service did not answer') + '.');
            continue;
          }
          card.dataset.ytcChan = rec.channel;
          if (rec.channelTitle) card.dataset.ytcChanName = rec.channelTitle;
          if (rec.publishedAt) card.dataset.ytcPub = rec.publishedAt;
          /* Detection is settled now, so clear the retry counter — otherwise the next scan
             sees an exhausted card and renders the dash over the badge we just earned. */
          delete card.dataset.ytcDetect;
          wantSubs(card);
        }
      }
      if (ownerQueue.size && !ownerTimer) {
        // Backed off, not hammered: a sleeping index needs seconds, not another 250ms.
        ownerTimer = setTimeout(flushOwnerLookups, 4000);
      }
    });
  }

  /* Views per hour from an exact timestamp, for cards that carry no relative date. */
  function vphFromStamp(viewsText, iso) {
    if (!iso) return null;
    const views = F.viewsToNumber(viewsText);
    if (!views) return null;
    const at = Date.parse(iso);
    if (isNaN(at)) return null;
    const hours = Math.max(1, (Date.now() - at) / 3600000);
    return views / hours;
  }

  function wantSubs(card) {
    if (!settings.showSubs) return;
    if (isAd(card)) return;
    // Playables, playlists and shelf tiles aren't videos and have no channel to look up.
    if (!findUrl(card).id) return;

    // Far below the fold: wait until it is scrolled towards rather than fetching now.
    if (!card.dataset.ytcNear && !nearViewport(card)) {
      if (subsObserver && card.dataset.ytcObserved !== '1') {
        card.dataset.ytcObserved = '1';
        subsObserver.observe(card);
      }
      return;
    }
    card.dataset.ytcNear = '1';

    // The watch page prints the count next to the channel name — read it instead of
    // fetching, which is both faster and immune to picking the wrong channel's number.
    const shown = card.querySelector('#owner-sub-count');
    const shownText = shown && shown.textContent.trim();
    if (shownText && /subscriber/i.test(shownText)) {
      /* The page gives us the count but never the lifetime totals, and the outlier ratio
         needs those. Paint immediately with what the DOM has, then ask the background for
         the totals and repaint once they land — otherwise this card silently falls back to
         views ÷ subscribers while every other card on the site shows a true outlier. */
      const watchKey = findChannelKey(card);
      const cached = watchKey ? subsByKey.get(watchKey) : null;
      renderBadge(card, {
        text: shownText, reason: '', stats: (cached && cached.stats) || null, t: Date.now()
      });
      if (watchKey && !(cached && cached.stats)) askWatchStats(card, watchKey, shownText);
      return;
    }

    const key = findChannelKey(card);
    if (!key) {
      /* A Short is asked for straight away rather than after the hydration retries. For every
         other card a missing byline means "not painted yet" and waiting is the right move;
         for a Short the byline is never coming, so the retries were ten seconds of waiting
         for something that does not exist before the real lookup even started — long enough
         that a page of Shorts looked simply broken. */
      if (queueOwnerLookup(card)) { renderLoading(card, false); return; }
      // YouTube fills in card metadata after the card enters the viewport, so a missing
      // channel link usually means "not hydrated yet", not "no channel". Look again.
      const attempt = Number(card.dataset.ytcDetect || 0);
      if (attempt < DETECT_DELAYS.length) {
        card.dataset.ytcDetect = String(attempt + 1);
        setTimeout(() => { if (card.isConnected) wantSubs(card); }, DETECT_DELAYS[attempt]);
        return;
      }
      renderEmpty(card, 'No channel link found on this card. Click to check again.');
      return;
    }
    delete card.dataset.ytcDetect;

    const known = subsByKey.get(key);
    if (known && (known.text || Date.now() - known.t < STALE_FAIL_MS)) {
      renderBadge(card, known);
      return;
    }
    if (known) {
      // A failure this old is worth another shot — it was probably throttling.
      subsByKey.delete(key);
      requested.delete(key);
    }
    if (!cardsByKey.has(key)) cardsByKey.set(key, new Set());
    cardsByKey.get(key).add(card);
    renderLoading(card, false);
    if (requested.has(key)) return;

    requested.add(key);
    askFor(key, false);
  }

  /* Only look up channels the user actually scrolls to — a long feed would otherwise
     kick off a hundred channel-page fetches nobody asked for. */
  const seer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          obs.unobserve(entry.target);
          wantSubs(entry.target);
        }
      }, { rootMargin: '200px' })
    : null;

  function watchForSubs(card) {
    if (!settings.showSubs) return;
    if (!seer) { wantSubs(card); return; }
    seer.unobserve(card);   // so a recycled card is reported as intersecting again
    seer.observe(card);
  }

  function refreshBadges() {
    if (!settings.showSubs) {
      document.querySelectorAll('.ytc-subs').forEach((b) => b.remove());
      return;
    }
    document.querySelectorAll('.ytc-card').forEach((card) => {
      if (badgeOf(card)) renderBadge(card, subsByKey.get(findChannelKey(card)));
      else watchForSubs(card);
    });
  }

  /* YouTube recycles card elements as you scroll: the same <ytd-rich-item-renderer> gets
     refilled with a different video. A badge computed for the old occupant would otherwise
     stick around — including a stale "no channel link" on a card that plainly has one.
     Also self-heals a card whose channel link showed up later than detection gave it. */
  function resyncCard(card) {
    if (!settings.showSubs) return;
    const id = findUrl(card).id;

    if (card.dataset.ytcVid !== id) {
      card.dataset.ytcVid = id;
      delete card.dataset.ytcDetect;
      /* Everything resolved by the OLD video's id goes with it. These are the one set of
         card facts not readable from the card, so nothing downstream would notice them being
         wrong — findChannelKey trusts ytcChan over the markup, which is the whole point of
         it, and a recycled tile would have gone on to report a stranger's subscriber count
         with total confidence. Exactly the failure the subscriber parser is built to avoid,
         reintroduced from the other end. */
      delete card.dataset.ytcChan;
      delete card.dataset.ytcChanName;
      delete card.dataset.ytcPub;
      const badge = badgeOf(card);
      if (badge) badge.remove();
      watchForSubs(card);
      return;
    }

    const empty = card.querySelector('.ytc-subs--none');
    if (empty && findChannelKey(card)) {
      empty.remove();
      delete card.dataset.ytcDetect;
      watchForSubs(card);
      return;
    }

    // A card re-render takes the whole tools row with it, badge included. Put it back from
    // what we already know rather than making the channel round-trip again.
    if (!badgeOf(card)) {
      const key = findChannelKey(card);
      if (!key) return;
      const known = subsByKey.get(key);
      if (known) renderBadge(card, known);
      else if (requested.has(key)) renderLoading(card, false);
    }
  }

  /* ------------------------------------------------------------ select bar */

  let bar = null;
  function buildBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'ytc-bar';
    bar.innerHTML =
      '<span class="ytc-bar__count">0 selected</span>' +
      '<button type="button" class="ytc-bar__btn" data-act="all">Select all on page</button>' +
      '<button type="button" class="ytc-bar__btn" data-act="clear">Clear</button>' +
      '<button type="button" class="ytc-bar__btn" data-act="thumbs">Download thumbs</button>' +
      '<button type="button" class="ytc-bar__btn ytc-bar__btn--primary" data-act="copy">Copy selected</button>' +
      '<button type="button" class="ytc-bar__btn ytc-bar__close" data-act="exit" title="Exit select mode">✕</button>';
    bar.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const which = act.dataset.act;
      if (which === 'all') {
        document.querySelectorAll('.ytc-card').forEach((card) => {
          const box = card.querySelector('.ytc-check input');
          if (box && !box.checked && card.offsetParent !== null) {
            box.checked = true;
            box.dispatchEvent(new Event('change'));
          }
        });
      } else if (which === 'clear') {
        clearSelection();
      } else if (which === 'thumbs') {
        const videos = Array.from(selected.values())
          .filter((v) => v.id)
          .map((v) => ({ id: v.id, title: v.title }));
        if (!videos.length) { toast('Select some videos first', true); return; }
        saveThumbs(videos);
      } else if (which === 'copy') {
        const videos = Array.from(selected.values());
        if (!videos.length) { toast('Select some videos first', true); return; }
        await copyVideos(videos);
      } else if (which === 'exit') {
        setSelectMode(false);
      }
    });
    document.body.appendChild(bar);
    return bar;
  }

  function clearSelection() {
    document.querySelectorAll('.ytc-check input:checked').forEach((box) => {
      box.checked = false;
      const card = box.closest('.ytc-card');
      if (card) card.classList.remove('ytc-card--selected');
    });
    selected.clear();
    updateBar();
  }

  function updateBar() {
    if (!selectMode || !bar) return;
    const n = selected.size;
    bar.querySelector('.ytc-bar__count').textContent =
      n + ' selected';
    bar.querySelector('[data-act="copy"]').disabled = n === 0;
    bar.querySelector('[data-act="thumbs"]').disabled = n === 0;
  }

  function setSelectMode(on) {
    selectMode = on;
    document.documentElement.classList.toggle('ytc-selectmode', on);
    if (on) { buildBar(); bar.classList.add('ytc-bar--show'); updateBar(); }
    else {
      clearSelection();
      if (bar) bar.classList.remove('ytc-bar--show');
    }
  }

  /* -------------------------------------------------------------- settings */

  function applySettings() {
    document.documentElement.classList.toggle('ytc-hide-buttons', !settings.showButtons);
    document.documentElement.classList.toggle('ytc-hide-thumbs', !settings.showThumb);
    // Deprecated feature: the stored preference is ignored so returning users who had it
    // enabled are not left with a button that mostly fails. Flip TRANSCRIPT_UI to restore.
    document.documentElement.classList.toggle('ytc-hide-transcript',
      !(TRANSCRIPT_UI && settings.showTranscript));
    refreshBadges();
  }

  chrome.storage.sync.get(null, (saved) => {
    settings = F.merge(saved);
    applySettings();
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[POCKET_STORE]) {
      // Saved in another tab: the stars and the header button must agree across all of them.
      loadPockets(() => {
        refreshPocketMarks();
        if (pocketsModalOpen()) renderPockets();
      });
    }
    if (area === 'local' && (changes[PRESET_STORE] || changes[PRESET_ORDER])) {
      // Saved in another tab. Reload rather than merge: storage is the single copy.
      loadPresets(() => {
        const modal = document.querySelector('.ytc-fm');
        if (modal) renderPresets(modal);
      });
    }
    if (area !== 'sync') return;
    const patch = {};
    for (const k in changes) patch[k] = changes[k].newValue;
    settings = F.merge(Object.assign({}, settings, patch));
    applySettings();
  });

  /* ---------------------------------------------------- scrolled-video filter */

  /* Everything the page has loaded, read back off the cards.

     The point of it is that YouTube's own results cannot be filtered by the numbers that
     matter for research — subscriber count, or views against the channel's size. Scrolling
     loads them; this reads what was loaded and lets it be narrowed. Nothing is fetched: every
     figure here was already on screen. */
  /* Ranges are held as slider positions rather than values. Subscriber counts span eleven
     orders of magnitude, so a linear track spends nine tenths of its length between ten
     million and a hundred million, where almost nothing sits. Position maps through a log
     curve instead, which puts the useful resolution where the channels are. */
  const RANGE_MAX = 1000;
  const RANGE_SPECS = {
    subs:  { top: 100000000, fmt: (v) => F.compact(v) + ' subs' },
    views: { top: 100000000, fmt: (v) => F.compact(v) + ' views' },
    age:   { top: 3650,      fmt: (v) => (v <= 0 ? 'today' : ageLabel(
               new Date(Date.now() - v * 86400000).toISOString())) },
    vph:   { top: 100000,    fmt: (v) => F.formatVph(v) + '/h' },
    /* Multiples, not counts, so the same log curve is doing a different job here: it spends
       the first tenth of the track below 1x, which is where "did not beat the average" lives
       and where a linear track would leave no room at all.

       dp is what makes that stretch usable. Rounding to whole numbers is right for a
       subscriber count and wrong for a multiplier: it collapses 0.5x to 1x and 1.5x to 2x,
       which are three of the handful of thresholds anyone actually wants here. */
    ratio:    { top: 100, dp: 1, fmt: (v) => v + '\u00d7 avg' },
    subratio: { top: 100, dp: 1, fmt: (v) => v + '\u00d7 subs' },
    /* Twenty years, because that is roughly how old the oldest channels on YouTube are and
       the log curve spends its resolution at the young end regardless — which is the end
       anyone filtering on this cares about. Read off the channel's about page, so it lands
       with the subscriber count rather than with the card. */
    chanage:  { top: 7300, fmt: (v) => (v <= 0 ? 'new' : ageLabel(
                 new Date(Date.now() - v * 86400000).toISOString())) }
  };

  function valToPos(val, spec) {
    if (val <= 0) return 0;
    return Math.round(RANGE_MAX * Math.log10(val + 1) / Math.log10(spec.top + 1));
  }

  function posToVal(pos, spec) {
    const p = Math.max(0, Math.min(RANGE_MAX, Number(pos))) / RANGE_MAX;
    const v = Math.pow(10, p * Math.log10(spec.top + 1)) - 1;
    return spec.dp ? Number(v.toFixed(spec.dp)) : Math.round(v);
  }

  const RANGE_KEYS = ['views', 'subs', 'vph', 'ratio', 'subratio', 'age', 'chanage'];

  const FILTER_STATE = {
    kind: 'all',                    // all | shorts | long
    subs: [0, RANGE_MAX],
    views: [0, RANGE_MAX],
    age: [0, RANGE_MAX],
    vph: [0, RANGE_MAX],
    ratio: [0, RANGE_MAX],
    subratio: [0, RANGE_MAX],
    chanage: [0, RANGE_MAX],
    sort: 'ratio',                  // ratio | subratio | vph | subs | views | date
    desc: true,
    preset: 'all',
    custom: false,                  // whether the custom-filter drawer is open
    allPresets: false               // whether the preset list is expanded past the cut
  };

  function resetRanges(f) {
    for (const k of RANGE_KEYS) f[k] = [0, RANGE_MAX];
    f.kind = 'all';
  }

  // Ranges are held as positions, so a preset says what it means in real units.
  const from = (key, v) => [valToPos(v, RANGE_SPECS[key]), RANGE_MAX];
  const upTo = (key, v) => [0, valToPos(v, RANGE_SPECS[key])];

  /* Each preset only moves the sliders and the sort — it never filters by some hidden rule
     of its own. So whatever a preset did stays visible in the custom drawer below and can be
     adjusted from there, and nothing can filter the list in a way the controls cannot show.
     Every one needs a denominator the page may not have supplied yet: a preset resting on
     the outlier or on views-per-hour will look thin until the subscriber lookups land. */
  // The one preset that filters nothing — where clearing any other one lands.
  const NO_FILTER_KEY = 'all';

  const BUILTIN_PRESETS = [
    { key: 'all', label: 'All videos', note: 'No filters applied' },

    { key: 'recent', label: 'Recent uploads', note: 'Newest videos from this week',
      apply: (f) => { f.age = upTo('age', 7); f.sort = 'date'; } },

    { key: 'today', label: "Today's top", note: 'Most-viewed videos from the last 24 hours',
      apply: (f) => { f.age = upTo('age', 1); f.sort = 'views'; } },

    { key: 'underdog', label: 'Underdogs', note: 'High views from small channels',
      apply: (f) => { f.subs = upTo('subs', 25000); f.views = from('views', 50000);
                      f.sort = 'subratio'; } },

    { key: 'velocity', label: 'High velocity', note: 'Videos with the fastest view growth',
      apply: (f) => { f.vph = from('vph', 500); f.sort = 'vph'; } },

    { key: 'trendshorts', label: 'Trending shorts', note: 'Shorts gaining views fastest',
      apply: (f) => { f.kind = 'shorts'; f.age = upTo('age', 7); f.sort = 'vph'; } },

    { key: 'hidden', label: 'Hidden outliers', note: 'High outlier scores from small creators',
      apply: (f) => { f.subs = upTo('subs', 50000); f.ratio = from('ratio', 3);
                      f.sort = 'ratio'; } },

    /* Old and still being watched is the hardest thing to find by scrolling, because the
       feed is ordered against it — which is exactly what makes the preset worth having. */
    { key: 'evergreen', label: 'Evergreens', note: 'Older videos still performing well',
      apply: (f) => { f.age = from('age', 180); f.ratio = from('ratio', 1.5);
                      f.sort = 'ratio'; } },

    { key: 'breakout', label: 'Breakout hits', note: '10x the channel\u2019s own average',
      apply: (f) => { f.ratio = from('ratio', 10); f.sort = 'ratio'; } },

    /* Distinct from the outlier: this one asks whether a video escaped the channel's own
       audience, which a modest channel can do while sitting on its own average. */
    { key: 'beyond', label: 'Beyond its audience',
      note: 'More views than the channel has subscribers',
      apply: (f) => { f.subratio = from('subratio', 1); f.sort = 'subratio'; } },

    { key: 'longwin', label: 'Long-form winners', note: 'Full videos beating their average',
      apply: (f) => { f.kind = 'long'; f.ratio = from('ratio', 2); f.sort = 'ratio'; } }
  ];



  /* ------------------------------------------------------------------ pockets */

  /* Named lists of channels, kept in the browser.

     A pocket stores a SNAPSHOT of each channel's figures — subscribers, average views, the
     outlier ratio — rather than a reference to be resolved later. Two reasons. The numbers are
     already on screen at the moment of saving, so storing them costs nothing, where resolving
     forty channels on opening the list would be forty lookups and a quota bill. And a saved
     list is a record of what you saw: a channel that was doing 3× its subscriber count when
     you pocketed it is the reason it is in there, and silently rewriting that to today's
     figure loses the very thing worth keeping. Where a figure was unknown at save time it
     stays unknown rather than being invented. */
  const POCKET_STORE = 'ytcPockets';
  const POCKET_MAX = 50;
  const POCKET_TITLE_MAX = 60;
  const POCKET_DESC_MAX = 200;
  const POCKET_NOTE_MAX = 120;
  const POCKET_CHANNELS_MAX = 500;

  let pockets = [];

  function loadPockets(cb) {
    try {
      chrome.storage.local.get([POCKET_STORE], (got) => {
        if (chrome.runtime.lastError) { if (cb) cb(); return; }
        const list = (got && got[POCKET_STORE]) || [];
        pockets = Array.isArray(list)
          ? list.filter((p) => p && p.id && p.title)
              .map((p) => Object.assign({ desc: '', channels: [] }, p, {
                // note arrived later; channels saved before it have none.
                channels: (Array.isArray(p.channels) ? p.channels : [])
                  .map((c) => Object.assign({ note: '' }, c))
              }))
          : [];
        if (cb) cb();
      });
    } catch (e) { if (cb) cb(); }
  }

  function savePockets(cb) {
    try {
      chrome.storage.local.set({ [POCKET_STORE]: pockets.slice(0, POCKET_MAX) },
        () => { if (chrome.runtime.lastError) { /* nothing to undo */ } if (cb) cb(); });
    } catch (e) { if (cb) cb(); }
  }

  function newPocket(title, desc) {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 7);
    const p = {
      id,
      title: String(title || '').trim().slice(0, POCKET_TITLE_MAX),
      desc: String(desc || '').trim().slice(0, POCKET_DESC_MAX),
      created: Date.now(),
      channels: []
    };
    pockets.push(p);
    return p;
  }

  /* One channel is one channel however it was reached. The similar list knows channels by
     handle, the page header by whichever URL the reader arrived on, and the two must not
     produce two entries for the same channel — so the id decides when there is one, and the
     lower-cased handle when there is not. */
  function pocketChannelKey(c) {
    return String((c && (c.id || c.channelId)) || '').trim() ||
           String((c && (c.handle || c.key)) || '').trim().toLowerCase();
  }

  function chanHandle(c) {
    return String((c && (c.handle || c.key)) || '').trim().toLowerCase();
  }

  function chanId(c) {
    return String((c && (c.id || c.channelId)) || '').trim();
  }

  /* Do two records name the same channel?

     Collapsing each side to a single "best" key and comparing those was wrong, because the
     two sides do not carry the same identifiers: the similar-channels list has a handle and
     no id, the channel header derives an id by scraping the page. So the comparison silently
     became "this side's id against that side's handle", and every channel reported itself
     already pocketed — the header's id matched a stored record whenever it was stale, and a
     scraped id is stale the moment YouTube navigates without repainting its canonical link.

     Handles decide when both sides have one. The handle is what the address bar says and what
     the index returns; it is the identifier that is actually present on both routes, and it
     cannot be picked up from a leftover page. Ids are the fallback for /channel/UC… pages,
     which carry no handle at all. A mismatch on the deciding identifier is a definite no —
     never a reason to try the other one, which is exactly how a wrong answer got in. */
  function sameChannel(a, b) {
    const ha = chanHandle(a);
    const hb = chanHandle(b);
    if (ha && hb) return ha === hb;
    const ia = chanId(a);
    const ib = chanId(b);
    return !!ia && ia === ib;
  }

  function pocketHas(pocket, c) {
    if (!pocketChannelKey(c)) return false;
    return (pocket.channels || []).some((x) => sameChannel(x, c));
  }

  function pocketAdd(pocket, c) {
    /* No id and no handle is not a channel, and a row with neither can never be matched,
       removed or de-duplicated afterwards — it would sit in the pocket forever. The dialog
       already refuses to open on one; this refuses to store one whatever calls it. */
    if (!pocket || !c || !pocketChannelKey(c)) return false;
    if (pocketHas(pocket, c)) return false;
    if ((pocket.channels || []).length >= POCKET_CHANNELS_MAX) return false;
    pocket.channels.push({
      id: c.id || c.channelId || '',
      handle: c.handle || '',
      title: c.title || c.handle || '',
      avatar: c.avatar || '',
      /* Why this channel was kept, in the reader's words. Seeded from where they were
         standing when they saved it, because that is the answer most of the time and an
         empty box is a question nobody comes back to answer. */
      note: String((c && c.note) || '').slice(0, POCKET_NOTE_MAX),
      subscribers: c.subscribers == null ? null : c.subscribers,
      avgViews: c.avgViews == null ? null : c.avgViews,
      added: Date.now()
    });
    return true;
  }

  function pocketRemove(pocket, key) {
    const before = (pocket.channels || []).length;
    pocket.channels = (pocket.channels || []).filter((x) => pocketChannelKey(x) !== key);
    return pocket.channels.length !== before;
  }

  function pocketEntry(pocket, c) {
    return (pocket.channels || []).find((x) => sameChannel(x, c)) || null;
  }

  function pocketsHolding(c) {
    if (!pocketChannelKey(c)) return [];
    return pockets.filter((p) => (p.channels || []).some((x) => sameChannel(x, c)));
  }




  /* ------------------------------------------------------------ pockets view */

  const POCKET_LABEL = 'Pockets';
  let pkEdit = '';        // id of the pocket whose edit form is open
  let pkConfirm = '';     // id of the pocket awaiting a delete confirmation
  let pkFind = '';        // the search box's text
  let pkNoteEdit = '';    // "<pocketId>|<channelKey>" of the note being edited inline
  let pkOpen = '';        // id of the pocket the detail pane is showing

  /* One box, both levels.

     A pocket matches on its own name or description; a channel matches on its name, handle or
     note. A pocket whose NAME matches keeps all its channels — you searched for the pocket, so
     you want the pocket — while one that matched only because something inside it did shows
     just the channels that did. Anything with nothing left to show is dropped, so the result
     is never a list of empty headings. */
  function pocketSearch(list, q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return list.map((p) => ({ pocket: p, channels: p.channels || [] }));
    const hit = (v) => String(v || '').toLowerCase().indexOf(needle) >= 0;
    const out = [];
    for (const p of list) {
      const self = hit(p.title) || hit(p.desc);
      const kids = (p.channels || []).filter((c) =>
        hit(c.title) || hit(c.handle) || hit(c.note));
      if (self) out.push({ pocket: p, channels: p.channels || [] });
      else if (kids.length) out.push({ pocket: p, channels: kids });
    }
    return out;
  }

  /* A modal, not a channel tab.

     Pockets belong to the reader, not to whatever channel happens to be on screen, and the
     first version put them in the channel tab row beside Similar Channels and Analytics —
     which are both about the channel in front of you. That made a global list reachable only
     from a channel page, and only by way of a page-content swap that has no meaning on a
     watch page or the home feed. It opens over whatever you are looking at instead, the same
     way the filter modal does, and it is reached from the sidebar where the rest of YouTube's
     own global destinations live. */
  function pocketsModalOpen() {
    return !!document.querySelector('.ytc-pkm');
  }

  function closePocketsModal() {
    document.querySelectorAll('.ytc-pkm, .ytc-pkm__veil').forEach((n) => n.remove());
    document.removeEventListener('keydown', pocketsModalEsc, true);
    pkEdit = '';
    pkConfirm = '';
    pkFind = '';
    pkNoteEdit = '';
    pkOpen = '';
  }

  function pocketsModalEsc(e) {
    if (e.key !== 'Escape' || !pocketsModalOpen()) return;
    e.stopPropagation();
    closePocketsModal();
  }

  function openPocketsModal() {
    if (pocketsModalOpen()) { closePocketsModal(); return; }
    const veil = document.createElement('div');
    veil.className = 'ytc-pkm__veil';
    veil.addEventListener('click', closePocketsModal);
    const modal = document.createElement('div');
    modal.className = 'ytc-pkm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Pockets');
    document.body.appendChild(veil);
    document.body.appendChild(modal);
    document.addEventListener('keydown', pocketsModalEsc, true);
    // Painted from what is already held, then repainted if storage had more to say.
    renderPockets();
    loadPockets(() => { if (pocketsModalOpen()) renderPockets(); });
  }

  /* Same figures as the similar-channels table, from the same helpers, so a channel reads
     identically whether it is being considered or has already been kept. */
  const PK_COLS = [
    /* The note first, beside the name it is about. The pencil only appears on hover — a
       column of edit affordances competes with the text it is offering to edit. */
    { label: 'Note', cls: 'ytc-pkv__note',
      cell: (c) => '<span class="ytc-pkv__notetext">' +
        (c.note ? escapeHtml(c.note) : '<i class="ytc-pkv__noteempty">Add a note</i>') +
        '</span><span class="ytc-pkv__pencil" aria-hidden="true">\u270e</span>' },
    { label: 'Subscribers',
      cell: (c) => (c.subscribers ? escapeHtml(F.compact(c.subscribers)) : '—') },
    { label: 'Avg views',
      cell: (c) => (c.avgViews ? escapeHtml(F.compact(c.avgViews)) : '—') },
    { label: 'Outlier', cls: 'ytc-t__out', cell: (c) => outlierCell(c) },
    { label: 'Added', cell: (c) => (c.added ? escapeHtml(agoLabel(new Date(c.added).toISOString()))
                                            : '\u2014') }
  ];

  function pocketChannelRow(p, c) {
    const handle = c.handle || '';
    const href = handle ? 'https://www.youtube.com/' + encodeURI(handle)
      : (c.id ? 'https://www.youtube.com/channel/' + encodeURIComponent(c.id) : '');
    const img = c.avatar
      ? '<img class="ytc-t__pic" src="' + escapeHtml(c.avatar) + '" alt="" loading="lazy">'
      : '<span class="ytc-t__pic ytc-t__pic--none">' +
        escapeHtml((c.title || handle || '?').trim().charAt(0).toUpperCase()) + '</span>';
    return '<div class="ytc-pkv__row">' +
      '<a class="ytc-pkv__chan"' + (href ? ' href="' + escapeHtml(href) + '"' : '') +
        ' target="_blank" rel="noopener noreferrer">' + img +
        '<span class="ytc-t__names">' +
          '<span class="ytc-t__name">' + escapeHtml(c.title || handle) + '</span>' +
          '<span class="ytc-t__handle">' + escapeHtml(handle || '') + '</span>' +
        '</span>' +
      '</a>' +
      PK_COLS.map((col) => {
        if (col.cls !== 'ytc-pkv__note') {
          return '<span class="ytc-t__c' + (col.cls ? ' ' + col.cls : '') + '">' +
            col.cell(c) + '</span>';
        }
        const token = p.id + '|' + pocketChannelKey(c);
        if (pkNoteEdit === token) {
          return '<span class="ytc-t__c ytc-pkv__note">' +
            '<input class="ytc-pkv__noteinput" type="text" maxlength="' + POCKET_NOTE_MAX +
            '" data-noteedit="' + escapeHtml(token) + '" aria-label="Note about this channel"' +
            ' value="' + escapeHtml(c.note || '') + '"></span>';
        }
        return '<button type="button" class="ytc-t__c ytc-pkv__note" data-editnote="' +
          escapeHtml(token) + '" title="Click to edit this note">' + col.cell(c) + '</button>';
      }).join('') +
      '<span class="ytc-t__c">' +
        /* Deliberately NOT data-chan: that attribute is what marks a channel-preview
           trigger, so naming it that turned the remove button into one — hovering the × in a
           pocket opened a preview keyed by a raw channel id, which /videos cannot resolve,
           and answered "unknown channel" over the row you were about to delete. */
        '<button type="button" class="ytc-pkv__drop" data-pocket="' + escapeHtml(p.id) +
        '" data-pkchan="' + escapeHtml(pocketChannelKey(c)) +
        '" title="Remove from this pocket" aria-label="Remove from this pocket">×</button>' +
      '</span>' +
    '</div>';
  }

  /* A folder, drawn twice.

     The rail is a list of folders, and the open one has to be readable at a glance from the
     icon alone rather than only from the highlight behind it — a tinted row is easy to lose
     against YouTube's own dark surface. Filled means open, outlined means closed. */
  function pocketFolderIcon(on) {
    return '<svg class="ytc-pkv__ico" viewBox="0 0 24 24" width="20" height="20" ' +
      'aria-hidden="true" focusable="false">' +
      (on
        ? '<path fill="currentColor" d="M10.2 4H4.5A1.5 1.5 0 0 0 3 5.5v13A1.5 1.5 0 0 0 4.5 20h15a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 19.5 7h-7.1l-2.2-3z"/>'
        : '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M10.2 4.75H4.5a.75.75 0 0 0-.75.75v13c0 .41.34.75.75.75h15a.75.75 0 0 0 .75-.75v-10a.75.75 0 0 0-.75-.75h-7.1l-2.2-3z"/>') +
      '</svg>';
  }

  /* One row of the rail. Under a search the count reads "2/7" — the pocket still holds seven,
     and hiding that would make a filtered view look like channels had gone missing. */
  function pocketSideItem(p, shown, on) {
    const n = (p.channels || []).length;
    const m = (shown || []).length;
    return '<button type="button" class="ytc-pkv__folder' +
        (on ? ' ytc-pkv__folder--on' : '') + '" data-open="' + escapeHtml(p.id) + '"' +
        (on ? ' aria-current="true"' : '') + '>' +
      pocketFolderIcon(on) +
      '<span class="ytc-pkv__foldertext">' +
        '<span class="ytc-pkv__foldername">' + escapeHtml(p.title) + '</span>' +
        (p.desc
          ? '<span class="ytc-pkv__folderdesc">' + escapeHtml(p.desc) + '</span>'
          : '') +
      '</span>' +
      '<span class="ytc-pkv__foldercount">' +
        (pkFind && m !== n ? m + '/' + n : n) +
      '</span>' +
    '</button>';
  }

  /* The pane beside the rail: everything about the one pocket that is open. */
  function pocketDetail(p, shown) {
    const list = shown || p.channels || [];
    const n = (p.channels || []).length;
    const editing = pkEdit === p.id;
    const confirming = pkConfirm === p.id;
    return '<section class="ytc-pkv__pocket">' +
      '<div class="ytc-pkv__head">' +
        (editing
          ? '<div class="ytc-pkv__form">' +
              '<input class="ytc-pkv__title" type="text" maxlength="' + POCKET_TITLE_MAX +
                '" value="' + escapeHtml(p.title) + '" aria-label="Pocket name">' +
              '<textarea class="ytc-pkv__desc" rows="2" maxlength="' + POCKET_DESC_MAX +
                '" placeholder="Description (optional)" aria-label="Pocket description">' +
                escapeHtml(p.desc || '') + '</textarea>' +
              '<div class="ytc-pkv__formrow">' +
                '<button type="button" class="ytc-pkv__savep" data-pocket="' +
                  escapeHtml(p.id) + '">Save changes</button>' +
                '<button type="button" class="ytc-pkv__cancel">Cancel</button>' +
              '</div>' +
            '</div>'
          : '<div class="ytc-pkv__meta">' +
              '<b>' + escapeHtml(p.title) + '</b>' +
              '<span class="ytc-pkv__count">' + n + (n === 1 ? ' channel' : ' channels') +
              '</span>' +
              (p.desc ? '<i>' + escapeHtml(p.desc) + '</i>' : '') +
            '</div>' +
            '<div class="ytc-pkv__acts">' +
              '<button type="button" class="ytc-pkv__edit" data-pocket="' +
                escapeHtml(p.id) + '">Edit</button>' +
              '<button type="button" class="ytc-pkv__del" data-pocket="' +
                escapeHtml(p.id) + '">Delete</button>' +
            '</div>') +
      '</div>' +
      /* A pocket with channels in it is not deleted on one click. The warning names the
         number, because "delete this pocket" and "delete these 23 channels I collected" are
         different sentences and only the second one is true here. */
      (confirming
        ? '<div class="ytc-pkv__warn">' +
            (n
              ? '<b>Delete “' + escapeHtml(p.title) + '” and the ' + n +
                (n === 1 ? ' channel' : ' channels') + ' in it?</b> This cannot be undone.'
              : '<b>Delete “' + escapeHtml(p.title) + '”?</b> It is empty.') +
            '<span class="ytc-pkv__warnacts">' +
              '<button type="button" class="ytc-pkv__delyes" data-pocket="' +
                escapeHtml(p.id) + '">Delete</button>' +
              '<button type="button" class="ytc-pkv__delno">Keep it</button>' +
            '</span>' +
          '</div>'
        : '') +
      (list.length
        /* Header cells take .ytc-t__c exactly like the data cells do. Without it they were
           bare spans, so every heading sat left in its column while the figure under it sat
           right — the columns were correct and looked broken. Only "Channel" stays plain,
           because that column is left-aligned on both rows. */
        ? '<div class="ytc-pkv__table">' +
            '<div class="ytc-pkv__row ytc-pkv__row--head">' +
              '<span>Channel</span>' +
              PK_COLS.map((c) => '<span class="ytc-t__c' + (c.cls ? ' ' + c.cls : '') + '">' +
                c.label + '</span>').join('') +
              '<span class="ytc-t__c"></span>' +
            '</div>' +
            list.map((c) => pocketChannelRow(p, c)).join('') +
          '</div>'
        : '<p class="ytc-pkv__empty">' + (n
            ? 'No channel in here matches that search.'
            : 'Nothing saved here yet. Use the ☆ on a channel page or in Similar ' +
              'channels.') + '</p>') +
    '</section>';
  }

  function renderPockets() {
    const modal = document.querySelector('.ytc-pkm');
    if (!modal) return;
    const found = pocketSearch(pockets, pkFind);
    const total = pockets.reduce((a, p) => a + ((p.channels || []).length), 0);
    /* The rail is the navigation, so something in it is always open. A search that hides the
       pocket you were reading, or a delete that removes it, moves the selection to the first
       row still standing rather than leaving an empty pane beside a list of results. */
    const cur = found.find((f) => f.pocket.id === pkOpen) || found[0] || null;
    pkOpen = cur ? cur.pocket.id : '';
    modal.innerHTML =
      '<div class="ytc-pkm__head">' +
        '<b>Pockets</b>' +
        (pockets.length
          ? '<span class="ytc-pkm__count">' + pockets.length +
            (pockets.length === 1 ? ' pocket' : ' pockets') + ' · ' + total +
            (total === 1 ? ' channel' : ' channels') + '</span>'
          : '') +
        (pockets.length
          ? '<input class="ytc-pkm__find" type="search" placeholder="Search pockets and ' +
            'channels" aria-label="Search pockets and channels" value="' +
            escapeHtml(pkFind) + '">'
          : '') +
        '<button type="button" class="ytc-pkm__x" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="ytc-pkm__body' + (pockets.length ? ' ytc-pkm__body--split' : '') + '">' +
        (!pockets.length
          ? '<p class="ytc-pkv__empty">No pockets yet. Open a channel and press ' +
            '<b>☆ Pocket</b> beside Subscribe, or use the ☆ on a row of the ' +
            'Similar channels table.</p>'
          : '<nav class="ytc-pkv__side" aria-label="Your pockets">' +
              (found.length
                ? found.map((f) =>
                    pocketSideItem(f.pocket, f.channels, f.pocket.id === pkOpen)).join('')
                : '<p class="ytc-pkv__sideempty">Nothing matches “' +
                  escapeHtml(pkFind) + '”.</p>') +
            '</nav>' +
            '<div class="ytc-pkv__main">' +
              (cur
                ? pocketDetail(cur.pocket, cur.channels)
                : '<p class="ytc-pkv__empty">Nothing matches “' + escapeHtml(pkFind) +
                  '” — not a pocket name, a description, a channel or a note.</p>') +
            '</div>') +
      '</div>';
    modal.querySelector('.ytc-pkm__x').addEventListener('click', closePocketsModal);

    const find = modal.querySelector('.ytc-pkm__find');
    if (find) {
      /* Re-rendered on every keystroke, so focus and caret have to be put back. Cheaper than
         a diff, and the list is tens of rows rather than thousands. */
      find.addEventListener('input', () => {
        const at = find.selectionStart;
        pkFind = find.value;
        renderPockets();
        const next = document.querySelector('.ytc-pkm__find');
        if (next) { next.focus(); try { next.setSelectionRange(at, at); } catch (e) { /* ok */ } }
      });
      find.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && find.value) {
          e.preventDefault();
          pkFind = '';
          renderPockets();
          const next = document.querySelector('.ytc-pkm__find');
          if (next) next.focus();
        }
      });
    }
    wirePockets(modal);
  }

  function wirePockets(host) {
    const byId = (el) => pockets.find((p) => p.id === el.dataset.pocket);

    /* Opening another folder abandons whatever was half-done in the one being left — an edit
       form or a delete warning belongs to the pocket it was opened on, and carrying either
       across to the next one would arm it against the wrong pocket. */
    host.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      if (pkOpen === b.dataset.open) return;
      pkOpen = b.dataset.open;
      pkEdit = '';
      pkConfirm = '';
      pkNoteEdit = '';
      renderPockets();
    }));

    host.querySelectorAll('.ytc-pkv__edit').forEach((b) => b.addEventListener('click', () => {
      pkEdit = b.dataset.pocket; pkConfirm = ''; renderPockets();
    }));
    host.querySelectorAll('.ytc-pkv__cancel').forEach((b) =>
      b.addEventListener('click', () => { pkEdit = ''; renderPockets(); }));

    host.querySelectorAll('.ytc-pkv__savep').forEach((b) => b.addEventListener('click', () => {
      const p = byId(b);
      const box = b.closest('.ytc-pkv__form');
      if (!p || !box) return;
      const title = String(box.querySelector('.ytc-pkv__title').value || '').trim();
      // A pocket must keep a name; an empty one cannot be told from another empty one.
      if (!title) {
        const f = box.querySelector('.ytc-pkv__title');
        f.focus();
        f.classList.add('ytc-pk__title--bad');
        setTimeout(() => f.classList.remove('ytc-pk__title--bad'), 900);
        return;
      }
      p.title = title.slice(0, POCKET_TITLE_MAX);
      p.desc = String(box.querySelector('.ytc-pkv__desc').value || '')
        .trim().slice(0, POCKET_DESC_MAX);
      savePockets();
      pkEdit = '';
      renderPockets();
    }));

    host.querySelectorAll('.ytc-pkv__del').forEach((b) => b.addEventListener('click', () => {
      pkConfirm = b.dataset.pocket; pkEdit = ''; renderPockets();
    }));
    host.querySelectorAll('.ytc-pkv__delno').forEach((b) =>
      b.addEventListener('click', () => { pkConfirm = ''; renderPockets(); }));
    host.querySelectorAll('.ytc-pkv__delyes').forEach((b) => b.addEventListener('click', () => {
      pockets = pockets.filter((p) => p.id !== b.dataset.pocket);
      pkConfirm = '';
      savePockets();
      renderPockets();
      refreshPocketMarks();
    }));

    host.querySelectorAll('[data-editnote]').forEach((b) => b.addEventListener('click', () => {
      pkNoteEdit = b.dataset.editnote;
      renderPockets();
      const f = document.querySelector('[data-noteedit]');
      if (f) { f.focus(); f.select(); }
    }));

    host.querySelectorAll('[data-noteedit]').forEach((f) => {
      const parts = String(f.dataset.noteedit || '').split('|');
      const commit = (keepOpen) => {
        const p = pockets.find((x) => x.id === parts[0]);
        const entry = p && (p.channels || []).find((x) => pocketChannelKey(x) === parts[1]);
        if (entry) {
          entry.note = String(f.value || '').slice(0, POCKET_NOTE_MAX);
          savePockets();
        }
        if (!keepOpen) { pkNoteEdit = ''; renderPockets(); }
      };
      f.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(false); }
        // Escape abandons the edit; the stored note is left as it was.
        if (e.key === 'Escape') { e.preventDefault(); pkNoteEdit = ''; renderPockets(); }
      });
      f.addEventListener('blur', () => { if (pkNoteEdit) commit(false); });
    });

    host.querySelectorAll('.ytc-pkv__drop').forEach((b) => b.addEventListener('click', () => {
      const p = byId(b);
      if (!p) return;
      pocketRemove(p, b.dataset.pkchan);
      savePockets();
      renderPockets();
      refreshPocketMarks();
    }));
  }

  /* The star and the header button are the only things saying a channel is kept, so they have
     to follow a change made anywhere else — including in another tab. */
  function refreshPocketMarks() {
    paintPocketNav();
    const btn = document.querySelector('.ytc-pkbtn');
    if (btn) paintPocketButton(btn);
    document.querySelectorAll('[data-star]').forEach((b) => {
      // data-star is built as `handle || title`, so match it the same way — a channel with
      // no handle is identified by its title in both places or in neither.
      const held = pockets.some((p) => (p.channels || []).some((x) =>
        (x.handle || x.title || '').toLowerCase() === (b.dataset.star || '').toLowerCase()));
      b.classList.toggle('ytc-t__star--on', held);
      b.textContent = held ? '★' : '☆';
    });
  }



  /* ---------------------------------------------------------- first-save hint */

  /* Shown once, the first time anything is ever saved.

     The save happens in a dialog anchored to a button on the page, and where the saved thing
     went is nowhere near it. Without this the first pocket is created and then lost: the
     reader has no reason to look down the sidebar for something they have never seen there.
     Once is the whole point — a coach mark that returns is an interruption, so the flag is
     written before the callout is drawn rather than after it is dismissed. */
  const POCKET_HINT_KEY = 'ytcPocketHintSeen';
  const POCKET_HINT_MS = 7000;
  let pocketHintShown = false;

  function maybeShowPocketHint() {
    if (pocketHintShown) return;
    pocketHintShown = true;            // never twice in one page, whatever storage says
    try {
      chrome.storage.local.get([POCKET_HINT_KEY], (got) => {
        if (chrome.runtime.lastError) return;
        if (got && got[POCKET_HINT_KEY]) return;
        chrome.storage.local.set({ [POCKET_HINT_KEY]: Date.now() });
        showPocketHint();
      });
    } catch (e) { /* a hint is never worth an exception */ }
  }

  function showPocketHint() {
    const target = document.querySelector('.ytc-nav--full') ||
                   document.querySelector('.ytc-nav--mini');
    /* The guide can be collapsed away entirely, and pointing at something that is not on
       screen is worse than not pointing. Fall back to the hamburger, which is always there
       and is how the reader would open the guide anyway. */
    const anchor = target || document.querySelector('#guide-button button, #guide-button');
    if (!anchor || !anchor.getBoundingClientRect) return;

    const el = document.createElement('div');
    el.className = 'ytc-hint';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="ytc-hint__star" aria-hidden="true">★</span>' +
      '<span class="ytc-hint__text"><b>Saved.</b> Find your pockets here.</span>' +
      '<button type="button" class="ytc-hint__x" aria-label="Dismiss">×</button>';
    document.body.appendChild(el);

    const place = () => {
      if (!el.isConnected || !anchor.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const h = el.offsetHeight;
      const top = Math.max(8, Math.min(r.top + (r.height / 2) - (h / 2),
                                       window.innerHeight - h - 8));
      el.style.left = Math.round(r.right + 14) + 'px';
      el.style.top = Math.round(top) + 'px';
    };
    place();
    // Two frames: the first paints it so offsetHeight is real, the second slides it in.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      place();
      el.classList.add('ytc-hint--in');
    }));

    const close = () => {
      el.classList.remove('ytc-hint--in');
      setTimeout(() => el.remove(), 220);
      window.removeEventListener('resize', place);
    };
    el.querySelector('.ytc-hint__x').addEventListener('click', close);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ytc-hint__x')) return;
      close();
      openPocketsModal();
    });
    window.addEventListener('resize', place);
    setTimeout(close, POCKET_HINT_MS);
  }

  /* ------------------------------------------------------- sidebar entry */

  /* Pockets live in YouTube's own guide, under Shorts.

     They are the reader's, not the channel's, so they belong beside YouTube's other global
     destinations rather than in a channel's tab row. Anchored to the Shorts entry by its
     HREF and never by its label: the guide is translated, and matching "Shorts" as text is
     one locale away from putting this in the wrong place or nowhere at all.

     Both guides are handled. The full one is what most people see; the mini rail is what is
     left when the window is narrow or the guide is collapsed, and an entry that vanished at
     that width would look like the feature had been removed. */
  const GUIDE_FULL = 'ytd-guide-entry-renderer';
  const GUIDE_MINI = 'ytd-mini-guide-entry-renderer';

  function pocketIconSvg() {
    // A bookmark, drawn inline so it inherits currentColor and matches YouTube's own icons at
    // every theme and zoom without shipping two more PNGs.
    return '<svg viewBox="0 0 24 24" width="24" height="24" focusable="false" ' +
      'aria-hidden="true"><path fill="currentColor" d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 ' +
      '2 0 0 0-2-2zm0 15.1-5-2.14-5 2.14V5h10v13.1z"/></svg>';
  }

  /* Where to put the entry, given YouTube's actual guide markup.

     The Shorts row has NO href. Its anchor is `<a id="endpoint" role="link" title="Shorts">`
     and the navigation is a JS endpoint, so every attempt to find it by link — which is what
     the first two versions did — was looking for something that does not exist. Home is the
     one row in that list whose anchor reliably carries an href, and it is `/`.

     So: find the Home row by its href, then step one row past it. In every build seen that
     row is Shorts, which is where this was asked to go. A guide with no second row leaves the
     entry under Home, which is the honest fallback rather than a guess. Nothing here depends
     on a label, so it survives translation. */
  function guideItemsList() {
    return document.querySelector('ytd-guide-section-renderer #items') ||
           document.querySelector('ytd-guide-renderer #items');
  }

  function rowHref(row) {
    const a = row.querySelector('a[href]');
    if (!a) return null;
    try { return new URL(a.getAttribute('href'), location.origin).pathname; }
    catch (e) { return null; }
  }

  function guideAnchorFor(kind) {
    if (kind === 'mini') {
      const mini = document.querySelector('ytd-mini-guide-renderer');
      if (!mini) return null;
      const rows = Array.from(mini.querySelectorAll(GUIDE_MINI))
        .filter((r) => !r.classList.contains('ytc-nav'));
      return rows[1] || rows[0] || null;
    }
    const items = guideItemsList();
    if (!items) return null;
    const rows = Array.from(items.querySelectorAll(':scope > ' + GUIDE_FULL));
    if (!rows.length) return null;
    const home = rows.find((r) => rowHref(r) === '/') || rows[0];
    /* One past Home. Our own entry is skipped, so a re-scan measures against YouTube's rows
       rather than against where we last put ourselves. */
    let next = home.nextElementSibling;
    while (next && next.classList && next.classList.contains('ytc-nav')) {
      next = next.nextElementSibling;
    }
    return next || home;
  }

  function ensurePocketNav() {
    if (!settings.showPockets) {
      document.querySelectorAll('.ytc-nav').forEach((n) => n.remove());
      return;
    }
    for (const kind of ['full', 'mini']) {
      const anchor = guideAnchorFor(kind);
      if (!anchor || !anchor.parentElement) continue;
      const cls = 'ytc-nav ytc-nav--' + kind;
      /* Scoped to this guide, not the document: the full guide and the mini rail both exist
         at once, and a document-wide check would let whichever was built first satisfy the
         other. */
      const already = anchor.parentElement.querySelector('.ytc-nav--' + kind);
      if (already) {
        /* Present, but not necessarily still in the right place — an earlier build of this
           put it above Home. Move it rather than leaving it wherever it landed. */
        if (already.previousElementSibling !== anchor) {
          anchor.parentElement.insertBefore(already, anchor.nextSibling);
        }
        matchGuideMetrics(already, anchor);
        continue;
      }
      const item = document.createElement('div');
      item.className = cls;
      item.setAttribute('role', 'link');
      item.setAttribute('tabindex', '0');
      item.title = 'Pockets — your saved channels';
      item.innerHTML = '<span class="ytc-nav__icon">' + pocketIconSvg() + '</span>' +
        '<span class="ytc-nav__label">Pockets</span>' +
        '<span class="ytc-nav__n" hidden></span>';
      const go = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPocketsModal();
      };
      item.addEventListener('click', go);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') go(e);
      });
      anchor.parentElement.insertBefore(item, anchor.nextSibling);
      matchGuideMetrics(item, anchor);
    }
    paintPocketNav();
  }

  /* Take the row's geometry from the row above it rather than restating it.

     Hand-matching YouTube's numbers put this 12px narrower than its neighbours and shifted it
     12px right: their entry is `width: calc(100% - 12px)` with no margin, and ours was a
     margin with no width. Guessing again would only survive until the next redesign. So the
     real Shorts row is measured and copied — width, margins, radius, the icon's inset from
     the left edge and the gap between icon and label — which is correct now and stays correct
     when those values change, because it never knew them in the first place.

     Everything is guarded: a collapsed guide measures zero, and writing zeros would collapse
     the row we just built. */
  function matchGuideMetrics(item, anchor) {
    try {
      const row = anchor.getBoundingClientRect();
      if (!row.height || !row.width) return;
      const cs = getComputedStyle(anchor);
      item.style.width = cs.width;
      item.style.marginLeft = cs.marginLeft;
      item.style.marginRight = cs.marginRight;
      item.style.borderRadius = cs.borderRadius;
      item.style.height = Math.round(row.height) + 'px';

      const icon = anchor.querySelector('yt-icon, svg');
      const label = anchor.querySelector('yt-formatted-string, .title');
      if (icon) {
        const ir = icon.getBoundingClientRect();
        if (ir.width) {
          // The icon's own inset is this row's left padding; mirrored on the right so the
          // count lands where YouTube's own entry counts land.
          const inset = Math.max(0, Math.round(ir.left - row.left));
          item.style.paddingLeft = inset + 'px';
          item.style.paddingRight = inset + 'px';
          const ours = item.querySelector('.ytc-nav__icon svg');
          if (ours) {
            ours.setAttribute('width', Math.round(ir.width));
            ours.setAttribute('height', Math.round(ir.height));
          }
          if (label) {
            const lr = label.getBoundingClientRect();
            if (lr.width) item.style.gap = Math.max(0, Math.round(lr.left - ir.right)) + 'px';
          }
        }
      }
    } catch (e) { /* leave the stylesheet's defaults in place */ }
  }

  /* How many channels are kept, across all pockets — the size of the collection rather than
     the number of drawers it is filed into. */
  let pocketNavCount = -1;

  function paintPocketNav() {
    const n = pockets.reduce((a, p) => a + ((p.channels || []).length), 0);
    /* Only a rise pops. Removing a channel lowering the number is not an event to celebrate,
       and the first paint of a page is not a change at all — without the -1 sentinel every
       navigation would animate a count that had been sitting there all along. */
    const grew = pocketNavCount >= 0 && n > pocketNavCount;
    pocketNavCount = n;
    document.querySelectorAll('.ytc-nav__n').forEach((el) => {
      el.textContent = n ? String(n) : '';
      el.hidden = !n;
      if (!grew) return;
      el.classList.remove('ytc-nav__n--pop');
      // Reading offsetWidth restarts the animation; without it re-adding the class in the
      // same frame does nothing, and a second pocket added quickly would not move.
      void el.offsetWidth;
      el.classList.add('ytc-nav__n--pop');
    });
  }

  /* --------------------------------------------------- pocket entry points */

  /* The channel currently being looked at, in the shape the pocket store wants. */
  function currentChannelForPocket() {
    const key = channelKeyFromLocation();
    if (!key) return null;
    const own = channelOwnStats() || {};
    const cached = subsByKey.get(key);
    const avg = (cached && cached.stats && cached.stats.avgViews) || 0;
    const avatar = document.querySelector(
      'yt-page-header-view-model img, #channel-header img, tp-yt-app-header img');
    return {
      id: own.channelId || channelIdFromKey(key) || '',
      handle: key.startsWith('@') ? key : (own.handle || ''),
      title: own.title || key,
      avatar: (avatar && avatar.src) || '',
      subscribers: own.subscribers == null ? null : own.subscribers,
      /* Read from the same cache the header's outlier pill uses: the lifetime totals off the
         channel's about page, already fetched for the subscriber badge. Absent until that
         lands, and then stored as unknown rather than as zero — zero would read as "reaches
         nobody" where the truth is "not measured yet". */
      avgViews: avg > 0 ? avg : null
    };
  }

  function pocketButtonHtml(saved) {
    return '<span class="ytc-pkbtn__icon" aria-hidden="true">' + (saved ? '★' : '☆') +
      '</span><span>' + (saved ? 'Pocketed' : 'Pocket') + '</span>';
  }

  /* Beside Subscribe, in YouTube's own action row — the same host the monetization badge
     uses, so the two sit together and neither has to know about the other's layout. */
  function ensurePocketButton() {
    const key = channelKeyFromLocation();
    if (!settings.showPockets || !key) {
      document.querySelectorAll('.ytc-pkbtn').forEach((n) => n.remove());
      return;
    }
    const host = channelHeaderHost();
    if (!host) return;
    /* Look for it anywhere, not only under the host we just resolved. YouTube rebuilds the
       action row on its own, so the host can be a different element than last time — and
       creating a second button then left the first one in the page, catching clicks that went
       nowhere. Move the one we have instead. */
    let btn = document.querySelector('.ytc-pkbtn');
    if (btn && btn.parentElement !== host) host.appendChild(btn);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytc-pkbtn';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const c = currentChannelForPocket();
        if (!c) return;
        openPocketDialog(c, btn, () => paintPocketButton(btn));
        /* The niche is a round trip, so the dialog opens without it and the seed lands when
           it does. Anything already typed wins — a suggestion must never overwrite a note. */
        seedFromNiche((seed) => {
          if (!seed || !pkDlg || pkTarget !== c) return;
          pkSeed = seed;
          pkDlg.querySelectorAll('[data-note]').forEach((f) => {
            if (f.value) return;
            f.value = seed;
            f.dispatchEvent(new Event('blur'));
          });
        });
      });
      host.appendChild(btn);
    }
    paintPocketButton(btn);
  }

  function paintPocketButton(btn) {
    if (!btn || !btn.isConnected) return;
    const c = currentChannelForPocket();
    const holding = c ? pocketsHolding(c) : [];
    btn.classList.toggle('ytc-pkbtn--on', holding.length > 0);
    /* Rewritten only when it actually changes.

       This ran on every scan, and a scan runs on every mutation — so the button's contents
       were being replaced two or three times a second. A click is only delivered if the
       element the pointer went DOWN on is still there when it comes up, so a scan landing in
       that gap threw the click away and the reader had to press again. That is the "sometimes
       twice" — it was never about the dialog. */
    const html = pocketButtonHtml(holding.length > 0);
    if (btn.dataset.state !== html) {
      btn.dataset.state = html;
      btn.innerHTML = html;
    }
    btn.title = holding.length
      ? 'Saved in ' + holding.map((p) => p.title).join(', ')
      : 'Save this channel to a pocket';
  }

  /* ---------------------------------------------------------- pocket dialog */

  /* One dialog, two callers: the button in the channel header and the one on a row of the
     similar-channels table. Both are answering the same question — which list does this
     channel go in — so they get the same thing rather than two that drift apart.

     Fixed to the viewport and parented to <body>, for the reason the hover preview is: it
     must not be clipped by whatever container it was opened from, and on the channel page
     that container is YouTube's own header. */
  let pkDlg = null;
  let pkTarget = null;      // the channel being saved
  let pkNewOpen = false;    // the "new pocket" form
  let pkDone = null;        // called after any change, so the opener can repaint
  let pkSeed = '';          // the suggested note, from wherever the save was started

  /* What to write in the note before the reader writes anything.

     Where they were standing says most of why they are saving: from the similar table it is
     whichever preset they were reading — "newly monetized channel" — and from a channel's own
     page it is what that channel is about, which the index already classifies. Neither is a
     claim, only a first draft; both are editable and both can be emptied. */
  function seedFromChip() {
    const chip = SIM_CHIPS.find((x) => x.key === simFilter.chip);
    if (!chip || chip.key === 'all') return '';
    return chip.label.toLowerCase() + ' channel';
  }

  function seedFromNiche(cb) {
    const key = channelKeyFromLocation();
    if (!key) { cb(''); return; }
    sendMessage({ type: 'ytc-niche', key, title: (channelOwnStats() || {}).title || '',
                  about: channelAboutText(), videoTitles: channelVideoTitles(10) }, (res) => {
      if (chrome.runtime.lastError) { cb(''); return; }
      const label = res && res.ok && res.niche ? String(res.niche) : '';
      cb(label ? label.toLowerCase() + ' channel' : '');
    });
  }

  function closePocketDialog() {
    if (pkDlg) pkDlg.remove();
    pkDlg = null;
    pkTarget = null;
    pkNewOpen = false;
    document.removeEventListener('keydown', pocketEsc, true);
  }

  function pocketEsc(e) {
    if (e.key !== 'Escape' || !pkDlg) return;
    e.stopPropagation();
    closePocketDialog();
  }

  function pocketRowHtml(p) {
    const has = pocketHas(p, pkTarget);
    const n = (p.channels || []).length;
    const entry = has ? pocketEntry(p, pkTarget) : null;
    return '<button type="button" class="ytc-pk__opt' + (has ? ' ytc-pk__opt--in' : '') +
        '" data-pocket="' + escapeHtml(p.id) + '">' +
      '<span class="ytc-pk__optname">' + escapeHtml(p.title) + '</span>' +
      '<span class="ytc-pk__optn">' + n + (n === 1 ? ' channel' : ' channels') + '</span>' +
      '<span class="ytc-pk__tick">' + (has ? '\u2713 Saved' : 'Save') + '</span>' +
    '</button>' +
    /* Only under the pocket it belongs to. A note is about this channel IN this pocket — the
       same channel can be kept in two lists for two different reasons — so one field at the
       bottom of the dialog would have had to guess which. */
    (has
      /* A <label> wrapping the field, so the text is bound to the input without an id — ids
         in a page we do not own are a collision waiting to happen. Says "optional" outright:
         a lone box under a row that just saved reads like something still owed. */
      ? '<label class="ytc-pk__noterow">' +
          '<span class="ytc-pk__notelbl">Notes about channel (optional)</span>' +
          '<input class="ytc-pk__note" type="text" maxlength="' + POCKET_NOTE_MAX + '"' +
          ' data-note="' + escapeHtml(p.id) + '" placeholder="Why this one?"' +
          ' value="' + escapeHtml((entry && entry.note) || '') + '">' +
        '</label>'
      : '');
  }

  function renderPocketDialog() {
    if (!pkDlg) return;
    const name = pkTarget ? (pkTarget.title || pkTarget.handle || 'this channel') : '';
    pkDlg.innerHTML =
      '<div class="ytc-pk__head">' +
        '<b>Save to pocket</b>' +
        '<button type="button" class="ytc-pk__x" aria-label="Close">×</button>' +
      '</div>' +
      '<p class="ytc-pk__who">' + escapeHtml(name) + '</p>' +
      (pockets.length
        ? '<div class="ytc-pk__list">' + pockets.map(pocketRowHtml).join('') + '</div>'
        : '<p class="ytc-pk__none">No pockets yet. Make one below.</p>') +
      (pkNewOpen
        ? '<div class="ytc-pk__form">' +
            '<input class="ytc-pk__title" type="text" maxlength="' + POCKET_TITLE_MAX + '"' +
              ' placeholder="Pocket name" aria-label="Pocket name">' +
            '<textarea class="ytc-pk__desc" rows="2" maxlength="' + POCKET_DESC_MAX + '"' +
              ' placeholder="Description (optional)" aria-label="Pocket description">' +
            '</textarea>' +
            '<div class="ytc-pk__formrow">' +
              '<button type="button" class="ytc-pk__create">Create and save</button>' +
              '<button type="button" class="ytc-pk__cancel">Cancel</button>' +
            '</div>' +
          '</div>'
        : '<button type="button" class="ytc-pk__new">+ New pocket</button>') +
      (pockets.length >= POCKET_MAX
        ? '<p class="ytc-pk__none">' + POCKET_MAX + ' pockets is the limit.</p>' : '');

    pkDlg.querySelector('.ytc-pk__x').addEventListener('click', closePocketDialog);

    pkDlg.querySelectorAll('[data-pocket]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = pockets.find((x) => x.id === b.dataset.pocket);
        if (!p) return;
        /* The row toggles. It is the only thing on screen saying whether this channel is in
           that pocket, so it has to be the thing that takes it back out — otherwise saving to
           the wrong list means going to find the Pockets tab to undo it. */
        if (pocketHas(p, pkTarget)) pocketRemove(p, pocketChannelKey(pkTarget));
        else if (pocketAdd(p, Object.assign({}, pkTarget, { note: pkSeed }))) {
          maybeShowPocketHint();
        }
        savePockets();
        renderPocketDialog();
        paintPocketNav();
        if (pkDone) pkDone();
      });
    });

    pkDlg.querySelectorAll('[data-note]').forEach((f) => {
      // Saved as it is typed, debounced. A note behind a Save button is a note nobody writes.
      let t = 0;
      const commit = () => {
        const p = pockets.find((x) => x.id === f.dataset.note);
        const entry = p && pocketEntry(p, pkTarget);
        if (!entry) return;
        entry.note = String(f.value || '').slice(0, POCKET_NOTE_MAX);
        savePockets();
        if (pkDone) pkDone();
      };
      f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 400); });
      f.addEventListener('blur', () => { clearTimeout(t); commit(); });
      f.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); commit(); f.blur(); }
      });
    });

    const newBtn = pkDlg.querySelector('.ytc-pk__new');
    if (newBtn) {
      newBtn.addEventListener('click', () => { pkNewOpen = true; renderPocketDialog(); });
    }
    const cancel = pkDlg.querySelector('.ytc-pk__cancel');
    if (cancel) {
      cancel.addEventListener('click', () => { pkNewOpen = false; renderPocketDialog(); });
    }

    const create = pkDlg.querySelector('.ytc-pk__create');
    if (create) {
      const title = pkDlg.querySelector('.ytc-pk__title');
      const desc = pkDlg.querySelector('.ytc-pk__desc');
      const commit = () => {
        const t = String(title.value || '').trim();
        // A pocket with no name cannot be picked out of a list. Ask again rather than guess.
        if (!t) {
          title.focus();
          title.classList.add('ytc-pk__title--bad');
          setTimeout(() => title.classList.remove('ytc-pk__title--bad'), 900);
          return;
        }
        if (pockets.length >= POCKET_MAX) return;
        const p = newPocket(t, desc.value);
        if (pocketAdd(p, Object.assign({}, pkTarget, { note: pkSeed }))) maybeShowPocketHint();
        savePockets();
        pkNewOpen = false;
        renderPocketDialog();
        paintPocketNav();
        if (pkDone) pkDone();
      };
      create.addEventListener('click', commit);
      title.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { pkNewOpen = false; renderPocketDialog(); }
      });
      desc.addEventListener('keydown', (e) => e.stopPropagation());
      setTimeout(() => { title.focus(); }, 0);
    }
    placePocketDialog();
  }

  function placePocketDialog() {
    if (!pkDlg || !pkDlg.dataset.anchorX) return;
    const w = pkDlg.offsetWidth;
    const h = pkDlg.offsetHeight;
    const ax = Number(pkDlg.dataset.anchorX);
    const ay = Number(pkDlg.dataset.anchorY);
    const ab = Number(pkDlg.dataset.anchorBottom);
    const left = Math.max(8, Math.min(ax, window.innerWidth - w - 8));
    let top = ab + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, ay - h - 8);
    pkDlg.style.left = Math.round(left) + 'px';
    pkDlg.style.top = Math.round(top) + 'px';
  }

  function openPocketDialog(channel, anchor, onChange, seed) {
    closePocketDialog();
    if (!channel || !pocketChannelKey(channel)) return;
    pkTarget = channel;
    pkDone = onChange || null;
    pkSeed = String(seed || '');
    pkNewOpen = !pockets.length;      // nothing to choose from: go straight to the form
    pkDlg = document.createElement('div');
    pkDlg.className = 'ytc-pk';
    pkDlg.setAttribute('role', 'dialog');
    pkDlg.setAttribute('aria-label', 'Save channel to a pocket');
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      pkDlg.dataset.anchorX = String(r.left);
      pkDlg.dataset.anchorY = String(r.top);
      pkDlg.dataset.anchorBottom = String(r.bottom);
    }
    document.body.appendChild(pkDlg);
    // Anything outside closes it, but not the click that opened it.
    setTimeout(() => {
      document.addEventListener('click', function away(e) {
        if (!pkDlg) { document.removeEventListener('click', away, true); return; }
        if (pkDlg.contains(e.target)) return;
        document.removeEventListener('click', away, true);
        closePocketDialog();
      }, true);
    }, 0);
    document.addEventListener('keydown', pocketEsc, true);
    renderPocketDialog();
  }

  /* ------------------------------------------------------- saved presets */

  /* A preset the reader made, kept in the browser.

     A built-in preset is a function: it moves sliders and picks a sort. A saved one cannot be,
     because a function does not survive a trip through storage — so what is stored is the
     VALUES the sliders were left at, and its apply is generated from those on the way back
     out. That keeps saved and built-in presets the same shape everywhere else, which is why
     the chip list, the clearing behaviour and the drawer logic needed no special cases.

     Ranges are stored as slider positions rather than real numbers, matching FILTER_STATE.
     Positions are what the sliders read and what a preset restores; converting to views and
     back would introduce rounding that moves a handle every time a preset is loaded. */
  const PRESET_MAX = 40;
  const PRESET_NAME_MAX = 40;
  const PRESET_DESC_MAX = 120;
  const PRESET_STORE = 'ytcPresets';
  const PRESET_ORDER = 'ytcPresetOrder';

  let userPresets = [];      // [{ id, label, state }]
  let presetOrder = [];      // full key order, built-ins included

  function presetKey(id) { return 'u:' + id; }

  /* The line under a saved preset's name.

     The reader's own description wins when there is one — they know why they saved it, and
     "channels I might sponsor" says something the sliders never could. When they leave it
     blank the sliders describe themselves, which is better than an empty line: a list of
     names with nothing under them is the ambiguity the built-in rows already solved. */
  function presetNote(saved) {
    const own = String((saved && saved.desc) || '').trim();
    return own || describeFilters(saved && saved.state);
  }

  function describeFilters(st) {
    if (!st) return '';
    const parts = [];
    if (st.kind === 'shorts') parts.push('Shorts');
    else if (st.kind === 'long') parts.push('Long form');
    for (const k of RANGE_KEYS) {
      const r = st[k];
      if (!r || (r[0] <= 0 && r[1] >= RANGE_MAX)) continue;
      parts.push(rangeText(k, st));
    }
    if (!parts.length) return 'No filters, sorted by ' + sortLabel(st.sort);
    return parts.join(' \u00b7 ');
  }

  function sortLabel(key) {
    const c = FILTER_SORTS.find((x) => x.key === key);
    return c ? c.label.toLowerCase() : key;
  }

  function toPreset(saved) {
    const st = saved.state || {};
    return {
      key: presetKey(saved.id),
      id: saved.id,
      label: saved.label,
      desc: saved.desc || '',
      note: presetNote(saved),
      mine: true,
      apply: (f) => {
        for (const k of RANGE_KEYS) {
          const r = st[k];
          f[k] = Array.isArray(r) ? [r[0], r[1]] : [0, RANGE_MAX];
        }
        f.kind = st.kind || 'all';
        f.sort = st.sort || FM_DEFAULT_SORT;
        f.desc = st.desc !== false;
      }
    };
  }

  /* Built-ins and saved presets in one list, in the order the reader put them.

     A key in the stored order that no longer exists is skipped, and anything the order does
     not mention goes on the end in its natural position — which is what carries a preset
     added by a later version of the extension. Without that, upgrading would silently hide
     every new built-in from anyone who had ever dragged a chip. */
  function filterPresets() {
    const all = BUILTIN_PRESETS.concat(userPresets.map(toPreset));
    const byKey = new Map(all.map((p) => [p.key, p]));
    const out = [];
    for (const k of presetOrder) {
      const p = byKey.get(k);
      if (p) { out.push(p); byKey.delete(k); }
    }
    for (const p of all) if (byKey.has(p.key)) out.push(p);
    return out;
  }

  function loadPresets(cb) {
    try {
      chrome.storage.local.get([PRESET_STORE, PRESET_ORDER], (got) => {
        if (chrome.runtime.lastError) { if (cb) cb(); return; }
        const list = (got && got[PRESET_STORE]) || [];
        userPresets = Array.isArray(list)
          ? list.filter((x) => x && x.id && x.label && x.state)
              // desc arrived in a later version; presets saved before it have none.
              .map((x) => Object.assign({ desc: '' }, x))
          : [];
        const order = (got && got[PRESET_ORDER]) || [];
        presetOrder = Array.isArray(order) ? order.filter((k) => typeof k === 'string') : [];
        if (cb) cb();
      });
    } catch (e) { if (cb) cb(); }
  }

  function savePresets(cb) {
    try {
      chrome.storage.local.set({
        [PRESET_STORE]: userPresets.slice(0, PRESET_MAX),
        [PRESET_ORDER]: presetOrder
      }, () => { if (chrome.runtime.lastError) { /* nothing to undo */ } if (cb) cb(); });
    } catch (e) { if (cb) cb(); }
  }

  /* The slider positions as they stand, frozen. Copied rather than referenced: FILTER_STATE
     is mutated in place by every slider drag, so storing it live would leave every saved
     preset pointing at whatever the reader last touched. */
  function snapshotFilters() {
    const st = { kind: FILTER_STATE.kind, sort: FILTER_STATE.sort, desc: FILTER_STATE.desc };
    for (const k of RANGE_KEYS) st[k] = [FILTER_STATE[k][0], FILTER_STATE[k][1]];
    return st;
  }

  function addPreset(label, desc) {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 7);
    userPresets.push({
      id,
      label: label.slice(0, PRESET_NAME_MAX),
      desc: String(desc || '').slice(0, PRESET_DESC_MAX),
      state: snapshotFilters()
    });
    /* A new preset joins the order explicitly rather than relying on the fall-through above,
       so that the first drag afterwards does not reshuffle everything that was never
       mentioned in a stored order. */
    if (presetOrder.length) presetOrder.push(presetKey(id));
    savePresets();
    return presetKey(id);
  }

  function collectScrolled() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('.ytc-card').forEach((card) => {
      if (card.offsetParent === null) return;
      /* Sponsored slots were being counted as results. They are someone's ad budget,
         not someone competing for the term, and on a commercial search they carry the
         biggest numbers on the page. isAd already existed for the subscriber badge;
         the statistics simply never asked it. */
      if (isAd(card)) return;
      const v = readCard(card);
      if (!v || !v.url || seen.has(v.url)) return;
      seen.add(v.url);
      const num = (k) => {
        const raw = card.dataset[k];
        return raw === '' || raw == null ? null : Number(raw);
      };
      /* The dataset is written by renderBadge, which does not run until the channel's
         subscriber lookup returns — so a card whose channel had not been looked up yet
         carried no view count, and dropped out of every view figure including the
         maximum. A 2.6B-view result sat visible on the page while the panel reported
         26.6M, because the one video that mattered had no number attached to it.
         The card's own text is there from the moment it is painted; the dataset is
         only preferred because it is already parsed. */
      const views = num('ytcViewsN') != null ? num('ytcViewsN')
        : F.viewsToNumber(v.views);
      const avg = num('ytcAvgN');
      const subs = num('ytcSubsN');
      /* A clone of the row the card already carries, rather than a second implementation of
         it. Every badge — subscribers, outlier, views per hour — and both buttons come out
         identical because they are the same markup and the same stylesheet. Ids are stripped
         so the copy cannot collide with the original still on the page. */
      let tools = '';
      const src = card.querySelector('.ytc-tools');
      if (src) {
        const clone = src.cloneNode(true);
        clone.classList.remove('ytc-tools--inline');
        clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        clone.querySelectorAll('input').forEach((n) => n.remove());
        tools = clone.outerHTML;
      }
      out.push({
        card: card,
        tools: tools,
        title: v.title,
        url: v.url,
        id: v.id || '',
        /* The resolved name for a card whose markup carries none. A shorts row with a blank
           channel column reads as "no channel", which is a claim about the video rather than
           about YouTube's markup. */
        channel: v.channel || card.dataset.ytcChanName || '',
        /* Which channel page the name points at. findChannelKey already reads it off the
           card's own anchors for the subscriber lookup, so the channel list gets its link
           for free rather than guessing a URL from the display name — which is not the
           handle, and for "ZOZA & Friends" is not even a path. */
        chanKey: findChannelKey(card),
        views: views,
        subs: subs,
        /* Strictly what each one claims. ratio used to fall back to the subscriber count
           whenever the channel average was unavailable, so a column headed "views vs channel
           average" was quietly showing views vs subscribers for some of its rows. */
        ratio: (views != null && avg) ? views / avg : null,
        subRatio: (views != null && subs) ? views / subs : null,
        /* The same figure the card's own VPH pill shows, from the card's relative date — so
           it can be filtered and sorted on, not only read. */
        /* Both fall back to the timestamp the id lookup supplied, so a short can be sorted
           and filtered on velocity and age like anything else. Without this a Shorts filter
           was a list every range slider silently excluded. */
        vph: v.date ? F.vphFromRelative(v.views, v.date, Date.now())
                    : vphFromStamp(v.views, card.dataset.ytcPub),
        ageDays: v.date ? daysSince(F.relativeToISO(v.date, Date.now()))
                        : daysSince(card.dataset.ytcPub || ''),
        /* How long the channel has existed, from its about page — already fetched for the
           subscriber count, so this costs nothing. Absent when the page did not yield it. */
        chanAge: card.dataset.ytcJoined
          ? ageLabel(new Date(Number(card.dataset.ytcJoined)).toISOString()) : '',
        /* The same fact as chanAge, as a number. That one is a label for reading; a range
           slider and a sort both need something to compare. */
        chanAgeDays: card.dataset.ytcJoined
          ? daysSince(new Date(Number(card.dataset.ytcJoined)).toISOString()) : null,
        /* From the card's own markup. findUrl deliberately rewrites /shorts/ID to
           /watch?v=ID so the two forms of one video compare equal, which meant testing the
           url for "/shorts/" could never match and every short read as long form. */
        shorts: !!(card.matches('ytd-reel-item-renderer, ytm-shorts-lockup-view-model') ||
                   card.querySelector('a[href*="/shorts/"]')),
        /* Built from the video id, not read off the card. YouTube lazy-loads its thumbnails,
           so a card that has never been scrolled into view carries an <img> with no src at
           all — and since loading more appends each batch below the fold, most of a fresh
           batch matched nothing here and drew a grey box. The id is always known and
           i.ytimg.com serves every video under these names, so the row can ask for the
           picture itself instead of waiting for the page to be scrolled through.

           mqdefault (320x180) rather than a larger name, because it is the only one that is
           both always present and already 16:9: hqdefault (480x360) and sddefault (640x480)
           are 4:3 with letterbox bars baked into the pixels, and maxresdefault exists only
           when the upload was 720p or better — besides being four times the size this 168px
           row can use, across a list that can run to hundreds. The card's own src still wins
           when it is there: that one is decoded and in cache already, so it paints without a
           second request. */
        thumb: (card.querySelector('img[src*="i.ytimg.com"]') || {}).src ||
               (v.id ? 'https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg' : ''),
        /* The channel's avatar, from the byline rather than the thumbnail rail — yt3 is the
           avatar host, i.ytimg is the video still, so the host is what tells them apart. */
        avatar: (card.querySelector('img[src*="yt3."], #channel-thumbnail img') || {}).src || '',
        date: v.date || ''
      });
    });
    return out;
  }

  function applyFilter(rows) {
    const f = FILTER_STATE;
    /* A range only filters once it has been moved. Untouched, it must not exclude the cards
       whose number is still unknown — treating those as zero would park every un-looked-up
       card at the bottom of a subscriber filter and read as the filter having eaten them. */
    const band = (key) => {
      const spec = RANGE_SPECS[key];
      const [lo, hi] = f[key];
      return { active: lo > 0 || hi < RANGE_MAX,
               lo: posToVal(lo, spec), hi: posToVal(hi, spec) };
    };
    /* Which row field each range asks about. Kept as one table so a new slider needs a spec,
       a field here, and nothing else. */
    const FIELD = { subs: 'subs', views: 'views', age: 'ageDays', vph: 'vph',
                    ratio: 'ratio', subratio: 'subRatio', chanage: 'chanAgeDays' };

    const bands = RANGE_KEYS.map((k) => [FIELD[k], band(k)]).filter((b) => b[1].active);

    const kept = rows.filter((r) => {
      if (f.kind === 'shorts' && !r.shorts) return false;
      if (f.kind === 'long' && r.shorts) return false;
      for (const [field, b] of bands) {
        const v = r[field];
        if (v == null || v < b.lo || v > b.hi) return false;
      }
      return true;
    });

    const key = { ratio: (r) => r.ratio, subratio: (r) => r.subRatio, vph: (r) => r.vph,
                  subs: (r) => r.subs, views: (r) => r.views,
                  date: (r) => (r.ageDays == null ? null : -r.ageDays),
                  /* Negated like the upload date, so the arrow means the same thing in both:
                     pointing down puts the newest first. Sorting a column called "age" so
                     that the biggest number came first would read as correct and be the
                     opposite of what anyone hunting young channels wants. */
                  chanage: (r) => (r.chanAgeDays == null ? null : -r.chanAgeDays) };
    const get = key[f.sort] || key.ratio;
    const dir = f.desc ? 1 : -1;
    return kept.sort((a, b) => {
      const x = get(a), y = get(b);
      // Rows with no value sink, whichever way the column is pointing.
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (y - x) * dir;
    });
  }

  const FILTER_SORTS = [
    { key: 'date', label: 'Upload date' },
    { key: 'subs', label: 'Channel subscribers' },
    { key: 'views', label: 'Video views' },
    { key: 'vph', label: 'Views per hour' },
    { key: 'ratio', label: 'Views vs channel average' },
    { key: 'subratio', label: 'Views vs subscribers' },
    { key: 'chanage', label: 'Channel age' }
  ];

  const AGE_CHOICES = [
    { v: '', label: 'Any time' }, { v: '1', label: 'Last 24 hours' },
    { v: '7', label: 'This week' }, { v: '30', label: 'This month' },
    { v: '90', label: 'Last 3 months' }, { v: '365', label: 'This year' }
  ];

  /* Everything the open modal needs to keep between repaints: the rows read off the page so
     far, whether a batch is in flight, and the observer that asks for the next one. Held here
     rather than passed around because loading more has to reach the same list the filter
     controls are already redrawing. */
  let FM = null;

  const FM_DEFAULT_SORT = 'ratio';
  /* No deadline. A clock here was always guessing, and on a slow connection it guessed wrong
     — it expired while the response was still in flight and reported the list as finished.
     The page itself already knows the answer: YouTube keeps its continuation element for
     exactly as long as it holds a token for the next page, so that element's presence is the
     wait and its absence is the end. What is left is a poll to read that state, a re-ask for
     when a scroll goes unheard, and — for a connection that has genuinely dropped, where
     YouTube would sit spinning too — an offer to poke it again rather than a cancellation. */
  const FM_REFRESH = 1200;          // how often to look for badges that have since filled in
  const FM_QUIET_TICKS = 8;         // ...and when to stop looking, once nothing is changing
  const FM_RENUDGE = 3000;          // idle sentinel: ask again, one request can go unheard
  const FM_SLOW = 12000;            // still nothing: offer a retry, but keep waiting
  const FM_POLL = 300;
  const FM_SETTLE = 2500;           // subscriber lookups for a fresh batch land after it does

  /* Infinite scrolling is offered only from a standing start. Under a sort or a filter each
     new batch is merged into the middle of the list rather than appended to the end, so rows
     the reader is looking at slide as it lands — which is why the button exists instead. */
  function filterIsDefault() {
    const f = FILTER_STATE;
    return f.kind === 'all' && f.preset === 'all' &&
      f.sort === FM_DEFAULT_SORT && f.desc === true &&
      RANGE_KEYS.every((k) => f[k][0] === 0 && f[k][1] === RANGE_MAX);
  }

  function closeFilterModal() {
    let restoreTo = null;
    if (FM) {
      if (FM.io) FM.io.disconnect();
      if (FM.rowIo) FM.rowIo.disconnect();
      if (FM.sortRail) FM.sortRail.disconnect();
      if (FM.refresh) clearInterval(FM.refresh);
      if (FM.tick) clearInterval(FM.tick);
      if (FM.settle) clearTimeout(FM.settle);
      /* Loading more scrolls the page along underneath the veil, so put it back where the
         reader left it. The videos that loaded stay loaded — only the position is restored. */
      restoreTo = FM.scrollY;
      FM = null;
    }
    document.querySelectorAll('.ytc-fm, .ytc-fm__veil').forEach((n) => n.remove());
    pageLock(false);
    if (restoreTo != null) window.scrollTo(0, restoreTo);
  }

  function filterRow(r, i) {
    return '<a class="ytc-fm__row" data-i="' + i + '" href="' + escapeHtml(r.url) +
      '" target="_blank" rel="noopener noreferrer">' +
      (r.thumb ? '<img class="ytc-fm__thumb" src="' + escapeHtml(r.thumb) + '" alt="" loading="lazy">'
               : '<span class="ytc-fm__thumb ytc-fm__thumb--none"></span>') +
      '<span class="ytc-fm__meta">' +
        '<span class="ytc-fm__title">' + escapeHtml(r.title) + '</span>' +
        '<span class="ytc-fm__nums">' +
          (r.views == null ? '' : F.compact(r.views) + ' views') +
          (r.date ? ' \u00b7 ' + escapeHtml(r.date) : '') +
        '</span>' +
        /* data-chan makes the name a preview trigger. The key was already read off the card
           for the subscriber lookup, so this costs nothing to carry. */
        '<span class="ytc-fm__chan"' +
          (r.chanKey ? ' data-chan="' + escapeHtml(r.chanKey) + '"' : '') + '>' +
          escapeHtml(r.channel || '') +
          (r.chanAge ? '<span class="ytc-fm__age">channel ' + escapeHtml(r.chanAge) +
            ' old</span>' : '') +
        '</span>' +
        /* The card's own badge row: subscribers, outlier and views per hour, exactly as they
           appear on the page, plus Copy and Thumb. */
        r.tools +
      '</span>' +
    '</a>';
  }

  /* The footer under the list, which is both the message and the mechanism: in the default
     view it is the sentinel the observer watches, so reaching it asks for the next batch. */
  const LOAD_MODES = [
    { key: 'all', label: 'All', note: 'until no new results come back' },
    { key: 'few', label: 'One batch', note: 'about 20 more, then stop' }
  ];

  /* Split control: the action, and a caret for choosing how far it goes. */
  function loadButton() {
    const mode = LOAD_MODES.find((m) => m.key === (FM.mode || 'all')) || LOAD_MODES[0];
    return '<div class="ytc-fm__split">' +
      '<button type="button" class="ytc-fm__more-btn">' +
        (mode.key === 'all' ? 'Load all videos' : 'Load more videos') + '</button>' +
      '<button type="button" class="ytc-fm__split-caret" aria-haspopup="true" ' +
        'aria-expanded="' + (FM.menu ? 'true' : 'false') + '" title="How much to load">' +
        '\u25BE</button>' +
      (FM.menu
        ? '<div class="ytc-fm__split-menu">' +
            LOAD_MODES.map((m) =>
              '<button type="button" data-mode="' + m.key + '"' +
                (m.key === mode.key ? ' class="on"' : '') + '>' +
                '<b>' + escapeHtml(m.label) + '</b>' +
                '<i>' + escapeHtml(m.note) + '</i></button>').join('') +
          '</div>'
        : '') +
    '</div>';
  }

  /* The run's own controls, pinned above the results rather than at the end of them. */
  function loadBarHtml() {
    if (!FM || !FM.loading) return '';
    const n = FM.all ? FM.all.length : 0;
    if (FM.paused) {
      const pct = Math.round((FM.left / LOAD_PAUSE_SECS) * 100);
      return '<div class="ytc-fm__prog ytc-fm__prog--paused">' +
          '<div class="ytc-fm__prog-head">' +
            '<b>' + n + '</b>' +
            '<span>results loaded \u2014 stopping in ' +
              '<b class="ytc-fm__left">' + FM.left + 's</b> unless you continue</span>' +
          '</div>' +
          '<span class="ytc-fm__prog-track"><i style="width:' + pct + '%"></i></span>' +
        '</div>' +
        '<button type="button" class="ytc-fm__go">Continue</button>' +
        '<button type="button" class="ytc-fm__stop">Stop</button>';
    }
    const stale = FM.stale || 0;
    /* No percentage of results, because there is no total to be a percentage of — the chain
       does not end at a number and its unique results flatten off wherever they happen to.
       A count is the honest headline. The bar tracks the one thing that genuinely does have
       an end in sight: how close this run is to concluding the page has no more. */
    const done = Math.min(100, Math.round((stale / LOAD_STALE_LIMIT) * 100));
    return '<div class="ytc-fm__prog">' +
        '<div class="ytc-fm__prog-head">' +
          '<b>' + n + '</b>' +
          '<span>' + (stale
            ? 'no new results \u2014 finishing (' + stale + ' of ' + LOAD_STALE_LIMIT + ')'
            : 'results loaded, still finding more') + '</span>' +
        '</div>' +
        '<span class="ytc-fm__prog-track' + (stale ? '' : ' ytc-fm__prog-track--live') + '">' +
          '<i style="width:' + (stale ? done : 100) + '%"></i></span>' +
      '</div>' +
      '<button type="button" class="ytc-fm__stop">Stop</button>';
  }

  function moreBarHtml() {
    if (!FM) return '';
    if (FM.loading) {
      /* Progress and Stop live in the strip above the list now, not here. Down here they sat
         inside the scroller and every batch pushed them further out of reach — the control
         for stopping a run being carried off by the run itself. */
      return '<div class="ytc-fm__more"><span class="ytc-spin"></span>' +
        '<span class="ytc-fm__note">' +
        (FM.slow
          ? 'Still waiting on YouTube. It is holding more results, so this is a slow ' +
            'connection rather than the end of the list.'
          : FM.mode === 'all'
            ? 'Loading every result YouTube will give for this search\u2026'
            : 'Loading more videos\u2026') + '</span>' +
        (FM.slow ? '<button type="button" class="ytc-fm__more-btn">Try again</button>' : '') +
        '</div>';
    }
    if (FM.ended) {
      return '<div class="ytc-fm__more"><span class="ytc-fm__note">' +
        'That is everything \u2014 YouTube has no more results for this search.' +
        '</span></div>';
    }
    if (FM.stopped) {
      return '<div class="ytc-fm__more">' +
        '<span class="ytc-fm__note">Stopped at ' + (FM.all ? FM.all.length : 0) +
        ' results. The rest are still there whenever you want them.</span>' +
        loadButton() + '</div>';
    }
    if (filterIsDefault()) {
      return '<div class="ytc-fm__more" data-auto="1">' +
        '<span class="ytc-fm__note">Scrolling for more\u2026</span></div>';
    }
    return '<div class="ytc-fm__more">' +
      '<span class="ytc-fm__note">Infinite scrolling is only available with the default ' +
      'sorting and filters. Everything else loads on demand, so a sorted list does not ' +
      'reshuffle under you as each batch arrives.</span>' +
      loadButton() + '</div>';
  }

  /* Rooted on the results box rather than the viewport, and re-armed after every repaint
     because the bar is rebuilt with the list. Rooting it here also covers the case a scroll
     handler cannot see: a list too short to scroll at all, where the bar is already in view
     and the next batch should simply load. */
  function paintLoadBar() {
    const bar = document.querySelector('.ytc-fm__loadbar');
    if (!bar) return;
    const html = loadBarHtml();
    bar.hidden = !html;
    /* Keyed on what the bar IS, not on what it says. Keying on the markup meant the countdown
       changed the signature every second and rebuilt the buttons with it. */
    const key = !FM || !FM.loading ? ''
      : [FM.paused ? 'paused' : 'run', FM.mode, FM.stale || 0,
         FM.all ? FM.all.length : 0].join('|');
    if (bar.dataset.key === key) { paintCountdown(); return; }
    bar.dataset.key = key;
    bar.innerHTML = html;
    const stop = bar.querySelector('.ytc-fm__stop');
    // Bound here rather than delegated: this strip is outside the results box, so the
    // handler watching that box never sees it.
    if (stop) {
      stop.addEventListener('click', () => {
        if (!FM) return;
        FM.cancel = true;
        /* A pause has no batch in flight to notice the flag, so it has to be ended here. */
        if (FM.paused) {
          clearPause();
          FM.paused = false;
          FM.loading = false;
          FM.stopped = true;
          FM.cancel = false;
          FM.all = collectScrolled();
          paintFilterResults();
        }
      });
    }
    const go = bar.querySelector('.ytc-fm__go');
    if (go) go.addEventListener('click', resumeRun);
  }

  function watchMoreBar(box) {
    if (!FM) return;
    if (FM.io) { FM.io.disconnect(); FM.io = null; }
    const bar = box.querySelector('.ytc-fm__more');
    if (!bar) return;
    const caret = bar.querySelector('.ytc-fm__split-caret');
    if (caret) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        FM.menu = !FM.menu;
        paintFilterResults();
      });
    }
    bar.querySelectorAll('.ytc-fm__split-menu button').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        FM.mode = b.dataset.mode;
        FM.menu = false;
        paintFilterResults();
      });
    });
    const stop = bar.querySelector('.ytc-fm__stop');
    if (stop) {
      stop.addEventListener('click', () => { if (FM) FM.cancel = true; });
    }
    const btn = bar.querySelector('.ytc-fm__more-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        if (FM) { FM.stopped = false; FM.menu = false; }
        retryMore();
      });
      return;
    }
    if (!bar.dataset.auto || typeof IntersectionObserver !== 'function') return;
    FM.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreVideos();
    }, { root: box, rootMargin: '600px' });
    FM.io.observe(bar);
  }

  /* The modal filters what YouTube has already rendered, so "more videos" means letting the
     page run the same continuation it would have run on its own: bring the sentinel it
     watches into view and its observer fires.

     Which means the page has to genuinely move, and the modal's own scroll lock is what
     stopped it. overflow:hidden on the root element propagates to the viewport, so the
     document is not merely unscrollable by the reader — it is unscrollable full stop, and
     both scrollTo and scrollIntoView are clamped. The spinner ran, nothing scrolled, and no
     batch ever arrived. So the lock comes off for as long as a batch is in flight and goes
     straight back on once it lands. The modal and veil are position:fixed, so they do not
     move while it is off. */
  function pageLock(on) {
    document.documentElement.style.overflow = on ? 'hidden' : '';
  }

  function nudgeYouTube() {
    pageLock(false);
    const sentinel = document.querySelector('ytd-continuation-item-renderer');
    if (sentinel && sentinel.scrollIntoView) {
      sentinel.scrollIntoView({ block: 'end' });
      /* Not every surface renders a sentinel — a channel grid may simply grow. Ask for the
         bottom as well; when the sentinel exists this is where it already is. */
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  /* Decorated cards, not raw YouTube ones: a new batch only becomes readable once scan() has
     been over it, so counting these is what says the rows are actually there to collect. */
  function decoratedCards() {
    return document.querySelectorAll('.ytc-card').length;
  }

  /* YouTube keeps this element in the list for exactly as long as it holds a token for the
     next page. Its presence is the difference between "slow" and "finished". */
  function hasContinuation() {
    return !!document.querySelector('ytd-continuation-item-renderer');
  }

  /* Whether a request is actually out, read off the spinner YouTube puts inside its own
     continuation element. Only ever used to decide whether to ask again, so it is written to
     fail towards "idle": a renamed spinner costs a harmless extra nudge, where a wrong "yes"
     would sit and wait on a request nobody made. */
  function ytFetching() {
    const sentinel = document.querySelector('ytd-continuation-item-renderer');
    return !!sentinel && !!sentinel.querySelector(
      'tp-yt-paper-spinner[active], tp-yt-paper-spinner-lite[active], [aria-busy="true"]');
  }

  /* The check-in. Counts down in the load bar, and stops when it reaches zero. */
  function pauseRun() {
    if (!FM) return;
    pageLock(true);
    FM.paused = true;
    FM.left = LOAD_PAUSE_SECS;
    paintFilterResults();
    if (FM.tick) clearInterval(FM.tick);
    FM.tick = setInterval(() => {
      if (!FM || !document.querySelector('.ytc-fm')) { clearPause(); return; }
      FM.left--;
      if (FM.left <= 0) {
        clearPause();
        FM.paused = false;
        FM.loading = false;
        FM.stopped = true;         // stopped, not ended: there is more, nobody asked for it
        FM.all = collectScrolled();
        paintFilterResults();
        return;
      }
      paintCountdown();
    }, 1000);
  }

  /* Writes only the two things that change. It used to repaint the whole bar each second,
     which replaced the buttons — and a click only fires when the mousedown and the mouseup
     land on the same element, so Continue was being destroyed between the press and the
     release and the click never happened. The button was never broken; it was being rebuilt
     out from under the press. */
  function paintCountdown() {
    const bar = document.querySelector('.ytc-fm__loadbar');
    if (!bar || !FM || !FM.paused) return;
    const left = bar.querySelector('.ytc-fm__left');
    if (left) left.textContent = FM.left + 's';
    const fill = bar.querySelector('.ytc-fm__prog-track i');
    if (fill) fill.style.width = Math.round((FM.left / LOAD_PAUSE_SECS) * 100) + '%';
  }

  function clearPause() {
    if (FM && FM.tick) { clearInterval(FM.tick); FM.tick = 0; }
  }

  function resumeRun() {
    if (!FM || !FM.paused) return;
    clearPause();
    FM.paused = false;
    /* The next check-in is a hundred further on, so each answer buys the same amount of
       running rather than the run getting quieter the longer it goes. */
    FM.nextPause = (FM.all ? FM.all.length : 0) + LOAD_CHECKPOINT;
    paintFilterResults();
    loadBatch();
  }

  function finishBatch() {
    clearPause();
    if (FM && FM.cancel) { FM.stopped = true; FM.cancel = false; }
    pageLock(true);
    FM.all = collectScrolled();
    FM.loading = false;
    FM.slow = false;
    paintFilterResults();
    /* The rows land before their numbers do: a fresh batch is looked up only once it is near
       the viewport, which the scroll above has just made true. Repaint once when those have
       had time to arrive, rather than leaving the new rows showing dashes where every row
       above them has figures. */
    if (FM.settle) clearTimeout(FM.settle);
    FM.settle = setTimeout(() => {
      if (FM && !FM.loading && document.querySelector('.ytc-fm')) {
        FM.all = collectScrolled();
        paintFilterResults();
      }
    }, FM_SETTLE);
    // A fresh batch is entirely unlooked-up, so start watching for its badges again.
    watchBadges();
  }

  /* There is no five-hundred cap. Following YouTube's own continuation chain for "apple" to
     sixty pages, it never stopped: 751 result entries handed back, still offering a token,
     and only 200 distinct videos among them. Unique results flatten early and the chain pads
     on indefinitely — 168 unique by page 32, 200 by page 60.

     Which means a count target is the wrong stopping rule twice over. It is not a limit
     YouTube enforces, and the extension counts distinct cards, so a target of 500 would never
     have been reached on that search — the run would have gone until someone pressed Stop.

     What actually ends a run is the results ceasing to be new. So the rule is stagnation:
     batches that add nothing, a few times over, mean the page has given what it has. */
  const LOAD_STALE_LIMIT = 3;     // consecutive fruitless batches before calling it done
  const LOAD_HARD_MAX = 1500;     // runaway guard only, not a target

  /* A run that only ends when the results do can go a long way — sixty pages of chain on the
     search I measured, and no natural stopping point in sight. So it checks in: every
     hundred results it pauses and waits, and if nobody says carry on it stops.
     The default is to stop rather than to continue, because an unattended run is exactly the
     one that should not keep going. */
  const LOAD_FIRST_PAUSE = 500;   // let it get properly underway before the first check-in
  const LOAD_CHECKPOINT = 100;    // and every hundred after that
  const LOAD_PAUSE_SECS = 10;     // how long it waits for an answer before stopping

  function loadMoreVideos() {
    if (!FM || FM.loading || FM.ended) return;
    /* Asked before anything spins: if the page is holding no token there is nothing to wait
       for, and saying so straight away beats a spinner that has already lost. */
    if (!hasContinuation()) { FM.ended = true; paintFilterResults(); return; }
    FM.loading = true;
    FM.slow = false;
    FM.cancel = false;
    FM.stale = 0;
    FM.paused = false;
    clearPause();
    FM.startedAt = decoratedCards();
    FM.nextPause = decoratedCards() + LOAD_FIRST_PAUSE;
    if (FM.io) { FM.io.disconnect(); FM.io = null; }   // one batch in flight at a time
    paintFilterResults();
    loadBatch();
  }

  /* One batch, then another if the reader asked for all of them.
   *
   * A single batch is often too few to satisfy a narrow filter — twenty more results against
   * a preset that keeps one in fifty just leaves the same empty list and another button. So
   * "All" keeps going by itself, which is only bearable because it reports where it has got
   * to and can be stopped mid-run. */
  function loadBatch() {
    if (!FM) return;
    FM.since = Date.now();
    const before = decoratedCards();
    nudgeYouTube();
    let nudgedAt = Date.now();
    const tick = () => {
      if (!FM || !document.querySelector('.ytc-fm')) return;   // closed while waiting
      if (FM.cancel) { finishBatch(); return; }
      if (decoratedCards() > before) {
        /* Keep going only while there is somewhere to go: the reader asked for everything,
           the page still holds a token, and the ceiling is not reached. Any of those failing
           ends the run rather than spinning against a wall. */
        if (FM.mode === 'all' && !FM.cancel &&
            decoratedCards() < LOAD_HARD_MAX && hasContinuation()) {
          FM.all = collectScrolled();
          FM.slow = false;
          FM.stale = 0;              // this batch produced, so the count starts over
          if (FM.all.length >= FM.nextPause) { pauseRun(); return; }
          paintFilterResults();      // the count moves, so the progress does too
          loadBatch();
          return;
        }
        finishBatch();
        return;
      }
      /* The page's own answer, not a clock's: the continuation element is gone, so YouTube
         is holding nothing more for this query and the list has genuinely ended. */
      if (!hasContinuation()) {
        pageLock(true);
        FM.loading = false;
        FM.ended = true;
        paintFilterResults();
        return;
      }
      const now = Date.now();
      /* A token still held but nothing being fetched means the scroll went unheard — the page
         grew under it, or the observer had already fired for this position. Ask again, and
         count the attempt: the chain keeps offering tokens long after it has stopped offering
         anything new, so "asked again and got nothing" is what exhaustion actually looks
         like here. */
      if (!ytFetching() && now - nudgedAt >= FM_RENUDGE) {
        nudgedAt = now;
        FM.stale = (FM.stale || 0) + 1;
        if (FM.mode === 'all' && FM.stale >= LOAD_STALE_LIMIT) {
          pageLock(true);
          FM.loading = false;
          FM.ended = true;
          FM.all = collectScrolled();
          paintFilterResults();
          return;
        }
        paintFilterResults();
        nudgeYouTube();
      }
      /* Still waiting, and still legitimately waiting — so this offers a retry rather than
         taking the decision away. A dropped connection leaves YouTube spinning too; the
         reader can see that and poke it, or close the modal. */
      if (!FM.slow && now - FM.since > FM_SLOW) {
        FM.slow = true;
        paintFilterResults();
      }
      setTimeout(tick, FM_POLL);
    };
    setTimeout(tick, FM_POLL);
  }

  /* One button, three jobs: start a batch, poke one that is taking too long, or re-check a
     list the page said had ended. */
  function retryMore() {
    if (!FM) return;
    if (FM.loading) { nudgeYouTube(); return; }
    FM.ended = false;
    loadMoreVideos();
  }

  /* The modal covers the page and locks its scroll, so a card the reader never happened to
     scroll past is never brought near the viewport and its subscriber lookup never fires —
     which is why a row here can show no subs, no outlier and no VPH while the very same card
     on the page behind has all three. Loading more makes it worse: the nudge jumps straight
     to the bottom, so every card it skipped over is passed without ever intersecting.

     So the list asks for its own data, the same way the page would, driven by what is
     actually on screen in the modal rather than by all of it at once — a few hundred channel
     lookups fired together would trip the background's rate-limit breaker and come back with
     nothing at all. */
  function primeVisibleRows(box, rows) {
    if (!FM) return;
    if (FM.rowIo) { FM.rowIo.disconnect(); FM.rowIo = null; }
    if (typeof IntersectionObserver !== 'function') return;
    FM.rowIo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (FM && FM.rowIo) FM.rowIo.unobserve(e.target);       // asked once is enough
        const rec = rows[Number(e.target.dataset.i)];
        const card = rec && rec.card;
        if (!card || !card.isConnected) continue;
        // The modal is looking at it even though the page is not.
        card.dataset.ytcNear = '1';
        try { wantSubs(card); } catch (err) { /* one row must not stop the rest */ }
      }
    }, { root: box, rootMargin: '300px' });
    box.querySelectorAll('.ytc-fm__row').forEach((n) => FM.rowIo.observe(n));
  }

  /* Cheap enough to run on a timer: three counts, no cloning. Every badge the page finishes
     drawing moves one of them, which is the signal that the rows are worth reading again. */
  function badgeSignature() {
    return document.querySelectorAll('.ytc-card .ytc-ratio').length + '/' +
      document.querySelectorAll('.ytc-card .ytc-vph').length + '/' +
      document.querySelectorAll('.ytc-card .ytc-subs:not(.ytc-subs--loading)').length;
  }

  /* A lookup queued behind others takes far longer than the one settle repaint after a batch
     allowed for, so the rows it belongs to kept the empty clone they were built with for as
     long as the modal stayed open. Watch until the badges stop changing, then stop watching:
     an interval that runs for the life of the modal would still be running long after the
     last answer had landed. */
  function watchBadges() {
    if (!FM) return;
    if (FM.refresh) clearInterval(FM.refresh);
    FM.sig = badgeSignature();
    FM.quiet = 0;
    FM.refresh = setInterval(() => {
      if (!FM || !document.querySelector('.ytc-fm')) return;
      if (FM.loading) { FM.quiet = 0; return; }   // a batch lands with its own repaint
      const sig = badgeSignature();
      if (sig === FM.sig) {
        if (++FM.quiet >= FM_QUIET_TICKS) { clearInterval(FM.refresh); FM.refresh = 0; }
        return;
      }
      FM.sig = sig;
      FM.quiet = 0;
      FM.all = collectScrolled();
      paintFilterResults();
    }, FM_REFRESH);
  }


  /* ------------------------------------------- channel-age resolution progress */

  /* Channel age is the one range whose value does not come off the card.

     Views, subscribers and the ratios are all painted onto the card by the time it is on
     screen; a channel's join date is read from its about page, which is fetched per channel
     and queued two at a time. So the moment the Channel age slider is moved, most rows have
     no value yet and are excluded — and the reader sees a list that has been cut down with no
     indication that it is still filling in. Left alone it looks like the filter found five
     channels, when it has really only asked about five so far.

     The same problem the "newly monetized" chip has in the similar-channels panel, and the
     same answer: say how many are resolved out of how many there are, and keep saying it
     until the number stops moving. */
  function chanAgeProgress(all) {
    let known = 0;
    let pending = 0;
    const waiting = [];
    for (const r of all || []) {
      if (r.chanAgeDays != null) { known++; continue; }
      const card = r.card;
      if (!card || !card.isConnected) continue;
      const key = findChannelKey(card);
      if (!key) continue;                       // no channel: never going to have an age
      const entry = subsByKey.get(key);
      /* Answered already. A channel whose about page carried no join date is not pending —
         it is unavailable, and counting it would leave the total one short forever. */
      if (entry && entry.stats) continue;
      pending++;
      if (!requested.has(key)) waiting.push(card);
    }
    return { known, pending, total: known + pending, waiting };
  }

  /* Nudge a few of the unasked ones along.

     Without this the indicator would be honest and useless: rows excluded by the filter are
     not in the list, so the row observer never sees them and never asks, and the count would
     sit still at whatever happened to be resolved when the slider moved. Capped per repaint
     rather than fired all at once, because the lookup queue runs two at a time behind a
     breaker that trips on four consecutive failures — dumping two hundred channels into it is
     how a filter turns into a rate-limit. The repaint timer drains the rest. */
  const CHANAGE_PRIME = 8;

  function primeChanAge(waiting) {
    for (const card of waiting.slice(0, CHANAGE_PRIME)) {
      card.dataset.ytcNear = '1';
      try { wantSubs(card); } catch (e) { /* one card must not stop the rest */ }
    }
  }

  function chanAgeNoteHtml(all) {
    // Only while that slider is actually doing something.
    const [lo, hi] = FILTER_STATE.chanage;
    if (lo <= 0 && hi >= RANGE_MAX) return '';
    const p = chanAgeProgress(all);
    if (!p.pending) return '';
    primeChanAge(p.waiting);
    /* Keep the repaint loop alive while there is anything left to resolve.

       watchBadges stops itself after eight ticks with no badge changing, which is right when
       the page has settled and wrong here: priming happens during a repaint, so a loop that
       stopped would take the priming with it and freeze the count mid-way with cards still
       unasked. Restarting it costs nothing — it clears its own interval first, and it will
       stop again on its own once these land and nothing more is moving. */
    if (FM && !FM.refresh) watchBadges();
    return '<p class="ytc-fm__progress"><span class="ytc-spin"></span> ' +
      'Resolving channel ages — ' + p.known + ' of ' + p.total + ' done. ' +
      'Rows whose channel has not answered yet are not in this list.</p>';
  }

  function paintFilterResults() {
    const box = document.querySelector('.ytc-fm__results');
    const count = document.querySelector('.ytc-fm__count');
    if (!box || !FM) return;
    const all = FM.all;
    const rows = applyFilter(all);
    if (count) {
      count.textContent = rows.length + ' of ' + all.length +
        (all.length === 1 ? ' video' : ' videos');
    }
    // Held so a click on a cloned button can find the card the clone came from.
    box._rows = rows;
    /* Kept across the repaint. An appending list is only usable if the reader stays where
       they were — a redraw that jumps back to the top loses their place every time a batch
       lands, which is precisely when it must not. */
    const keepTop = box.scrollTop;
    box.innerHTML = chanAgeNoteHtml(all) + (rows.length
      ? rows.map(filterRow).join('')
      : '<p class="ytc-fm__none">Nothing on this page matches. Widen a range, or load more ' +
        'below \u2014 only what has loaded can be filtered.</p>') + moreBarHtml();
    box.scrollTop = keepTop;
    pvReanchor();
    paintLoadBar();
    watchMoreBar(box);
    primeVisibleRows(box, rows);
  }

  /* Two range inputs on one track. A native <input type=range> gives one handle; the pair is
     overlaid, and pointer events are routed to whichever handle is nearer the cursor so the
     lower one is still grabbable when both sit at the same end. */
  function rangeControl(key, label) {
    const spec = RANGE_SPECS[key];
    const [lo, hi] = FILTER_STATE[key];
    return '<label class="ytc-fm__lbl">' + label +
        '<span class="ytc-fm__val" data-val="' + key + '">' +
          rangeText(key) + '</span>' +
      '</label>' +
      '<div class="ytc-fm__range" data-range="' + key + '">' +
        '<span class="ytc-fm__track"></span>' +
        '<span class="ytc-fm__fill"></span>' +
        '<input type="range" min="0" max="' + RANGE_MAX + '" value="' + lo + '" data-end="lo">' +
        '<input type="range" min="0" max="' + RANGE_MAX + '" value="' + hi + '" data-end="hi">' +
      '</div>';
  }

  /* Reads the live filter state by default, but a saved preset needs the same sentence built
     from values that are not on the sliders right now — that is what the note under a saved
     preset's name is. */
  function rangeText(key, state) {
    const spec = RANGE_SPECS[key];
    const [lo, hi] = (state || FILTER_STATE)[key];
    if (lo === 0 && hi === RANGE_MAX) return 'any';
    const loV = spec.fmt(posToVal(lo, spec));
    const hiV = hi >= RANGE_MAX ? 'any' : spec.fmt(posToVal(hi, spec));
    return (lo === 0 ? 'up to ' + hiV : loV + ' \u2013 ' + hiV);
  }

  /* Every control redrawn from the state in one pass: sliders, the video-type segment and
     the sort row. A preset changes several at once, and anything it moved has to be visible
     in the drawer below or the list is filtered by something the reader cannot see. */
  function syncFilterControls(modal) {
    modal.querySelectorAll('.ytc-fm__range').forEach((box) => {
      const [lo, hi] = FILTER_STATE[box.dataset.range];
      box.querySelector('[data-end="lo"]').value = lo;
      box.querySelector('[data-end="hi"]').value = hi;
      paintRange(box);
    });
    modal.querySelectorAll('.ytc-fm__seg button').forEach((o) =>
      o.classList.toggle('on', o.dataset.kind === FILTER_STATE.kind));
    modal.querySelectorAll('.ytc-fm__sort').forEach((o) => {
      const on = o.dataset.sort === FILTER_STATE.sort;
      o.classList.toggle('on', on);
      o.querySelector('span').textContent = on ? (FILTER_STATE.desc ? '\u25BC' : '\u25B2') : '\u25BC';
    });
  }

  /* Eleven presets filled the sidebar top to bottom, which pushed the custom-filter drawer
     and the Reset button below the fold — and a control nobody can see may as well not
     exist. So the list is cut to roughly two thirds, with the next one clipped and faded
     rather than removed: an item half in view says "there is more here" in a way a hard edge
     never does, and it leaves the two things underneath on screen. */
  /* Forced open when the active preset is one of the hidden ones, since a selection the
     reader cannot see is worse than a long list. */
  function presetsOpen() {
    if (FILTER_STATE.allPresets) return true;
    /* >= not >: the chip at the cut is the clipped one, and it is click-through, so leaving
       a selection sitting in it would show the active preset half-faded and unclickable. */
    const i = filterPresets().findIndex((pz) => pz.key === FILTER_STATE.preset);
    return i >= presetShown();
  }

  function setPresetList(modal, open) {
    FILTER_STATE.allPresets = !!open;
    const box = modal.querySelector('.ytc-fm__chips');
    const btn = modal.querySelector('.ytc-fm__more-presets');
    if (box) box.classList.toggle('ytc-fm__chips--all', presetsOpen());
    if (btn) {
      btn.classList.toggle('open', presetsOpen());
      btn.firstChild.nodeValue = presetsOpen()
        ? 'Show fewer' : 'Show all ' + filterPresets().length + ' presets';
    }
  }

  function setDrawer(modal, open) {
    FILTER_STATE.custom = !!open;
    const drawer = modal.querySelector('.ytc-fm__drawer');
    const btn = modal.querySelector('.ytc-fm__sec--btn');
    if (drawer) drawer.hidden = !open;
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('open', !!open);
    }
  }

  function paintRange(box) {
    const key = box.dataset.range;
    const [lo, hi] = FILTER_STATE[key];
    const fill = box.querySelector('.ytc-fm__fill');
    fill.style.left = (lo / RANGE_MAX * 100) + '%';
    fill.style.right = (100 - hi / RANGE_MAX * 100) + '%';
    const out = document.querySelector('[data-val="' + key + '"]');
    if (out) out.textContent = rangeText(key);
  }


  /* ------------------------------------------------- preset list rendering */

  /* The chip list is rebuilt rather than patched. Saving, renaming, deleting and dropping a
     dragged chip all change which chips exist and in what order, and four separate patch
     paths against a list that also carries the collapse cut and the active selection is how
     a list ends up disagreeing with the state behind it. */

  let pmForm = null;      // { mode: 'new' | 'rename', id } while the name field is open
  let pmMenu = '';        // key of the preset whose ⋮ menu is open

  function presetShown() {
    return Math.max(4, Math.round(filterPresets().length * 0.65));
  }

  function presetChipHtml(pz, i, cut) {
    const cls = (FILTER_STATE.preset === pz.key ? ' on' : '') +
      /* Marks the rows that carry a ⋮, so the chip can reserve room for it without every
         built-in row reserving room for a button it does not have. */
      (pz.mine ? ' ytc-fm__chipwrap--mine' : '') +
      (pmMenu === pz.key ? ' ytc-fm__chipwrap--menu' : '') +
      (pmForm && pmForm.mode === 'edit' && pmForm.id === pz.id ? ' ytc-fm__chipwrap--editing' : '') +
      (i === cut ? ' ytc-fm__chipwrap--peek' : i > cut ? ' ytc-fm__chipwrap--extra' : '');

    /* The row is a div, not a button, because a button cannot legally contain the ⋮ button
       the saved ones need. The click target inside it keeps the button semantics. */
    return '<div class="ytc-fm__chipwrap' + cls + '" data-key="' + escapeHtml(pz.key) + '"' +
        ' draggable="true">' +
      /* Says the row can be dragged, at the moment the pointer is on it and not before.
         Shown always it is eleven pieces of furniture nobody asked about; shown never, the
         only way to discover reordering is to try it by accident. The space it occupies is
         reserved on every row regardless, so arriving on one does not shunt its text. */
      '<span class="ytc-fm__grip" aria-hidden="true">\u22ee\u22ee</span>' +
      '<button type="button" class="ytc-fm__chip" data-preset="' +
        escapeHtml(pz.key) + '">' +
        '<b>' + escapeHtml(pz.label) + '</b>' +
        (pz.note ? '<i>' + escapeHtml(pz.note) + '</i>' : '') +
      '</button>' +
      (pz.mine
        ? '<button type="button" class="ytc-fm__dots" draggable="false" data-dots="' +
            escapeHtml(pz.key) + '" aria-label="Options for ' + escapeHtml(pz.label) +
            '" aria-haspopup="menu">\u22ee</button>' +
          (pmMenu === pz.key
            ? '<div class="ytc-fm__menu" role="menu">' +
                '<button type="button" role="menuitem" data-act="edit">Edit\u2026</button>' +
                '<button type="button" role="menuitem" class="danger" data-act="delete">' +
                  'Delete</button>' +
              '</div>'
            : '')
        : '') +
    '</div>';
  }

  function presetListHtml() {
    const list = filterPresets();
    const cut = presetShown();
    return list.map((pz, i) => presetChipHtml(pz, i, cut)).join('');
  }

  /* Rebuild the chips, the show-more button and the save row, then rewire them. Called for
     every change to the list; nothing else is allowed to touch a chip's markup. */
  function renderPresets(modal) {
    const box = modal.querySelector('.ytc-fm__chips');
    if (!box) return;
    box.innerHTML = presetListHtml();
    box.classList.toggle('ytc-fm__chips--all', presetsOpen());

    const list = filterPresets();
    const btn = modal.querySelector('.ytc-fm__more-presets');
    if (btn) {
      btn.hidden = list.length <= presetShown() + 1;
      btn.classList.toggle('open', presetsOpen());
      btn.firstChild.nodeValue = presetsOpen()
        ? 'Show fewer' : 'Show all ' + list.length + ' presets';
    }
    wirePresets(modal);
  }

  /* The form, and the button that opens it — one control in two states.

     Closed, it is a single button offering to save what the sliders are set to. Open, the
     name and description sit directly above it and the button becomes the one that commits
     them. It lives at the foot of the drawer rather than in the chip list because editing a
     preset means adjusting its filters, and a field inside the list would be torn out and
     rebuilt every time a slider moved a chip's highlight. */
  function renderPresetForm(modal) {
    const wrap = modal.querySelector('.ytc-fm__pform');
    const save = modal.querySelector('.ytc-fm__savepreset');
    const cancel = modal.querySelector('.ytc-fm__pcancel');
    if (!wrap || !save) return;

    const editing = pmForm && pmForm.mode === 'edit';
    const row = editing ? userPresets.find((x) => x.id === pmForm.id) : null;
    // The preset went away underneath the form — another tab deleted it. Fall back to closed.
    if (editing && !row) pmForm = null;

    const open = !!pmForm;
    wrap.hidden = !open;
    if (cancel) cancel.hidden = !open;

    if (open) {
      const name = wrap.querySelector('.ytc-fm__pname');
      const desc = wrap.querySelector('.ytc-fm__pdesc');
      /* Filled only as the form opens. Rewriting the fields on every render would undo what
         is being typed, since a slider moved while the form is open re-renders. */
      if (!wrap.dataset.for || wrap.dataset.for !== (pmForm.id || 'new')) {
        wrap.dataset.for = pmForm.id || 'new';
        name.value = row ? row.label : '';
        desc.value = row ? (row.desc || '') : '';
        setTimeout(() => { name.focus(); name.select(); }, 0);
      }
      save.textContent = editing ? 'Update preset' : 'Add preset';
      save.classList.add('ytc-fm__savepreset--commit');
      save.disabled = false;
      save.title = editing
        ? 'Save the name, description and the filters as they are set now'
        : 'Save this name, description and the filters as they are set now';
    } else {
      delete wrap.dataset.for;
      const full = userPresets.length >= PRESET_MAX;
      save.textContent = 'Save these filters as a preset';
      save.classList.remove('ytc-fm__savepreset--commit');
      save.disabled = full;
      save.title = full
        ? 'You have reached ' + PRESET_MAX + ' saved presets. Delete one to save another.'
        : 'Save the filters currently set as a preset you can come back to';
    }
  }

  function closePresetForm(modal) {
    pmForm = null;
    renderPresetForm(modal);
    renderPresets(modal);
  }

  function commitPresetForm(modal) {
    const wrap = modal.querySelector('.ytc-fm__pform');
    if (!wrap || !pmForm) return;
    const name = String(wrap.querySelector('.ytc-fm__pname').value || '')
      .trim().slice(0, PRESET_NAME_MAX);
    const desc = String(wrap.querySelector('.ytc-fm__pdesc').value || '')
      .trim().slice(0, PRESET_DESC_MAX);
    // A preset with no name cannot be picked out of a list. Ask again rather than inventing one.
    if (!name) {
      const field = wrap.querySelector('.ytc-fm__pname');
      field.focus();
      field.classList.add('ytc-fm__pname--bad');
      setTimeout(() => field.classList.remove('ytc-fm__pname--bad'), 900);
      return;
    }
    if (pmForm.mode === 'edit') {
      const row = userPresets.find((x) => x.id === pmForm.id);
      if (row) {
        row.label = name;
        row.desc = desc;
        // Editing captures the sliders as they stand, which is what opening the form loaded
        // them with — so leaving them alone updates only the words, and moving one updates
        // the filter too. Both are what the reader just did.
        row.state = snapshotFilters();
        savePresets();
        FILTER_STATE.preset = presetKey(row.id);
      }
    } else {
      FILTER_STATE.preset = addPreset(name, desc);
    }
    closePresetForm(modal);
  }

  /* Moving a slider by hand drops whatever preset was on, so the chips have to say so.
     Cheaper than a full rebuild, which is what a slider drag would otherwise trigger on every
     input event — and the list itself has not changed, only which row is lit. */
  function markActivePreset(modal) {
    modal.querySelectorAll('.ytc-fm__chipwrap').forEach((w) =>
      w.classList.toggle('on', w.dataset.key === FILTER_STATE.preset));
  }

  /* `force` loads the preset without the clear-on-reclick behaviour. Edit has to land on the
     preset's own filters whether or not it was already the active one; the toggle is a
     property of clicking a chip, not of loading a preset. */
  function applyPreset(modal, pz, force) {
    /* Clicking the preset that is already on clears it instead of reapplying it — see the
       long note this replaced; the behaviour is unchanged, it just lives here now that the
       chips are rebuilt rather than toggled in place. */
    const clearing = !force && FILTER_STATE.preset === pz.key && pz.key !== NO_FILTER_KEY;
    const use = clearing
      ? filterPresets().find((x) => x.key === NO_FILTER_KEY) || pz : pz;
    resetRanges(FILTER_STATE);
    FILTER_STATE.sort = FM_DEFAULT_SORT;
    FILTER_STATE.desc = true;
    FILTER_STATE.preset = use.key;
    if (use.apply) use.apply(FILTER_STATE);
    if (use.apply) setDrawer(modal, true);
    renderPresets(modal);
    syncFilterControls(modal);
    /* paintFilterResults, not the `redraw` alias — that one is a closure inside
       openFilterModal, and this function is not. Calling it from out here threw a
       ReferenceError inside the click handler, which a listener swallows silently: every
       preset chip looked dead, with the state already half-applied behind it. */
    paintFilterResults();
  }

  function wirePresets(modal) {
    const box = modal.querySelector('.ytc-fm__chips');
    if (!box) return;

    box.querySelectorAll('.ytc-fm__chip').forEach((b) => {
      b.addEventListener('click', () => {
        const pz = filterPresets().find((x) => x.key === b.dataset.preset);
        if (pz) applyPreset(modal, pz);
      });
    });

    box.querySelectorAll('[data-dots]').forEach((b) => {
      // A menu button inside a draggable row: neither the drag nor the chip click is meant.
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pmMenu = pmMenu === b.dataset.dots ? '' : b.dataset.dots;
        renderPresets(modal);
      });
    });

    box.querySelectorAll('.ytc-fm__menu [data-act]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const pz = filterPresets().find((x) => x.key === pmMenu);
        pmMenu = '';
        if (!pz || !pz.mine) { renderPresets(modal); return; }

        if (b.dataset.act === 'edit') {
          /* Editing loads the preset before it opens the form. Its name and description are
             only half of what a preset is — the other half is on the sliders, and a form that
             asked you to rename something while the drawer showed somebody else's filters
             would be editing two different presets at once. */
          applyPreset(modal, pz, true);
          pmForm = { mode: 'edit', id: pz.id };
          setDrawer(modal, true);
          renderPresetForm(modal);
          renderPresets(modal);
          return;
        }

        if (b.dataset.act === 'delete') {
          userPresets = userPresets.filter((x) => x.id !== pz.id);
          presetOrder = presetOrder.filter((k) => k !== pz.key);
          savePresets();
          // Deleting the one being edited must close the form it is behind.
          if (pmForm && pmForm.mode === 'edit' && pmForm.id === pz.id) pmForm = null;
          renderPresetForm(modal);
          /* Deleting the preset that is currently filtering the list would otherwise leave
             the list narrowed by a rule with nothing on screen claiming it. */
          if (FILTER_STATE.preset === pz.key) {
            const none = filterPresets().find((x) => x.key === NO_FILTER_KEY);
            if (none) { applyPreset(modal, none); return; }
          }
        }
        renderPresets(modal);
      });
    });

    wirePresetDrag(modal, box);
  }

  /* Drag to reorder, built-ins included.

     Only saved presets carry the ⋮ menu, but the ORDER is the reader's either way — a
     built-in they never use has no claim on the top of the list. What is stored is a flat
     list of keys covering both kinds; filterPresets() reconciles it with whatever presets
     actually exist, so a preset removed by an update disappears cleanly and one added by an
     update still shows up. */
  let pmDragKey = '';

  function wirePresetDrag(modal, box) {
    box.querySelectorAll('.ytc-fm__chipwrap[draggable="true"]').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        pmDragKey = row.dataset.key;
        row.classList.add('ytc-fm__chipwrap--drag');
        try {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without data set; the value is never read.
          e.dataTransfer.setData('text/plain', pmDragKey);
        } catch (err) { /* the drag still works */ }
        /* Expanded for the duration. Half the list is clipped when collapsed, and a chip
           cannot be dropped onto a target that is not on screen — without this, reordering
           silently only worked across the visible two thirds. */
        if (!presetsOpen()) setPresetList(modal, true);
      });

      row.addEventListener('dragend', () => {
        pmDragKey = '';
        box.querySelectorAll('.ytc-fm__chipwrap').forEach((r) =>
          r.classList.remove('ytc-fm__chipwrap--drag', 'ytc-fm__chipwrap--over'));
      });

      row.addEventListener('dragover', (e) => {
        if (!pmDragKey || row.dataset.key === pmDragKey) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
        row.classList.add('ytc-fm__chipwrap--over');
      });

      row.addEventListener('dragleave', () => row.classList.remove('ytc-fm__chipwrap--over'));

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const from = pmDragKey;
        const to = row.dataset.key;
        pmDragKey = '';
        if (!from || from === to) { renderPresets(modal); return; }
        movePreset(modal, from, to);
      });
    });

    /* The list itself takes a drop, meaning "put it last".

       Rows insert BEFORE themselves, which is what the top-edge marker promises — and which
       on its own leaves the final position unreachable, since there is no row after the last
       one to drop in front of. */
    box.addEventListener('dragover', (e) => {
      if (!pmDragKey) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
    });
    box.addEventListener('drop', (e) => {
      if (!pmDragKey) return;
      e.preventDefault();
      const from = pmDragKey;
      pmDragKey = '';
      movePreset(modal, from, '');
    });
  }

  /* Insert `from` before `to`, or at the end when `to` is empty.

     The index of the target is read AFTER the dragged key is removed. Splicing at an index
     measured before the removal inserts before the target when dragging upward and after it
     when dragging downward — the same gesture landing in two different places depending on
     which way the reader happened to come at it. */
  function movePreset(modal, from, to) {
    const keys = filterPresets().map((p) => p.key);
    const i = keys.indexOf(from);
    if (i < 0 || from === to) { renderPresets(modal); return; }
    keys.splice(i, 1);
    const at = to ? keys.indexOf(to) : -1;
    keys.splice(at < 0 ? keys.length : at, 0, from);
    presetOrder = keys;
    savePresets();
    renderPresets(modal);
  }

  /* The two ends of the sort rail. Hidden until the chips actually overflow, and each one
     disappears again at the end it points to, so the arrows are never a control that does
     nothing when pressed. */
  function railButton(dir) {
    const d = dir === 'prev' ? 'M10.5 3.5 6 8l4.5 4.5' : 'M5.5 3.5 10 8l-4.5 4.5';
    return '<button type="button" class="ytc-fm__srail ytc-fm__srail--' + dir + '" hidden ' +
      'aria-label="' + (dir === 'prev' ? 'Scroll sorts left' : 'Scroll sorts right') + '">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + d + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round"/></svg></button>';
  }

  /* Which arrows apply, measured rather than assumed. A one-pixel slack absorbs the
     fractional scrollLeft a zoomed page produces, which otherwise leaves the "next" arrow lit
     at a rail that has already reached its end. */
  function paintSortRail(modal) {
    const box = modal.querySelector('.ytc-fm__sorts');
    const bar = modal.querySelector('.ytc-fm__sortbar');
    if (!box || !bar) return;
    const max = box.scrollWidth - box.clientWidth;
    const prev = box.scrollLeft > 1;
    const next = box.scrollLeft < max - 1;
    bar.querySelector('.ytc-fm__srail--prev').hidden = !prev;
    bar.querySelector('.ytc-fm__srail--next').hidden = !next;
    // The fades are on the rail, so they can sit over the chips without scrolling with them.
    bar.classList.toggle('ytc-fm__sortbar--prev', prev);
    bar.classList.toggle('ytc-fm__sortbar--next', next);
  }

  function wireSortRail(modal) {
    const box = modal.querySelector('.ytc-fm__sorts');
    if (!box) return;
    modal.querySelectorAll('.ytc-fm__srail').forEach((b) => {
      b.addEventListener('click', () => {
        /* A page at a time, less a chip's worth of overlap — the chip that was at the edge
           stays on screen, so there is always something in common between the two views to
           read the movement against. */
        const step = Math.max(120, Math.round(box.clientWidth * 0.8));
        box.scrollBy({ left: b.classList.contains('ytc-fm__srail--prev') ? -step : step,
                       behavior: 'smooth' });
      });
    });
    box.addEventListener('scroll', () => paintSortRail(modal));
    /* The modal is sized against the viewport, so the same chips overflow at one window width
       and not at another. Observing the rail catches both that and a font that lands late. */
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => paintSortRail(modal));
      ro.observe(box);
      if (FM) FM.sortRail = ro;
    }
    /* Open on the sort that is actually in force. It defaults to the fifth chip, which is off
       the end of the rail at most widths — leaving the reader looking at a bar whose lit chip
       is out of sight. Set directly rather than scrolled to: this is the starting position,
       not a movement, and animating it on open would read as the bar drifting by itself. */
    const on = box.querySelector('.ytc-fm__sort.on');
    if (on) {
      const overshoot = on.offsetLeft + on.offsetWidth - box.clientWidth;
      if (overshoot > 0) box.scrollLeft = overshoot + 20;
    }
    paintSortRail(modal);
  }

  function openFilterModal() {
    closeFilterModal();
    // Transient chrome, not state: a menu or a half-typed name must not survive a reopen.
    pmForm = null;
    pmMenu = '';
    FM = { all: collectScrolled(), loading: false, ended: false, slow: false, since: 0,
           io: null, rowIo: null, refresh: 0, sig: '', quiet: 0, settle: 0,
           mode: 'all', menu: false, cancel: false, stopped: false, startedAt: 0,
           paused: false, left: 0, tick: 0, nextPause: 0, stale: 0,
           scrollY: window.scrollY };

    const veil = document.createElement('div');
    veil.className = 'ytc-fm__veil';

    const modal = document.createElement('div');
    modal.className = 'ytc-fm';
    modal.innerHTML =
      '<div class="ytc-fm__head">' +
        '<b>Filter videos</b>' +
        '<span class="ytc-fm__count"></span>' +
        '<button type="button" class="ytc-fm__x" aria-label="Close">\u00d7</button>' +
      '</div>' +
      '<div class="ytc-fm__body">' +
        '<div class="ytc-fm__side">' +
          /* Above the presets, not inside Custom filters. Shorts and long form are a
             different kind of question from the sliders: it is the first cut most people
             make, it applies whatever preset is chosen, and burying it behind a collapsed
             drawer meant reaching for it through two clicks every time. */
          '<div class="ytc-fm__sec">Video type</div>' +
          '<div class="ytc-fm__seg ytc-fm__seg--top">' +
            ['all', 'shorts', 'long'].map((k) =>
              '<button type="button" data-kind="' + k + '"' +
              (FILTER_STATE.kind === k ? ' class="on"' : '') + '>' +
              (k === 'all' ? 'All' : k === 'shorts' ? 'Shorts' : 'Long form') +
              '</button>').join('') +
          '</div>' +
          '<div class="ytc-fm__sec">Presets</div>' +
          '<div class="ytc-fm__chips"></div>' +
          '<button type="button" class="ytc-fm__more-presets">Show all presets' +
            '<span class="ytc-fm__caret">\u25BE</span></button>' +
          /* Collapsed by default: eleven presets answer most of what anyone opens this for,
             and six sliders under them turns a list you scan into a form you fill in. Opened
             the moment a preset moves something, so a filtered list always says why. */
          '<button type="button" class="ytc-fm__sec ytc-fm__sec--btn" aria-expanded="' +
            (FILTER_STATE.custom ? 'true' : 'false') + '">Custom filters' +
            '<span class="ytc-fm__caret">\u25BE</span></button>' +
          '<div class="ytc-fm__drawer"' + (FILTER_STATE.custom ? '' : ' hidden') + '>' +
            rangeControl('views', 'Views') +
            rangeControl('subs', 'Subscribers') +
            rangeControl('vph', 'Views per hour') +
            rangeControl('ratio', 'Views vs channel average') +
            rangeControl('subratio', 'Views vs subscribers') +
            rangeControl('age', 'Uploaded') +
            rangeControl('chanage', 'Channel age') +
            /* Inside the drawer, under the sliders it saves. A preset is these values, so the
               control that captures them belongs at the end of them rather than beside Reset,
               where it would read as another way to clear things. */
            '<div class="ytc-fm__pform" hidden>' +
              '<input class="ytc-fm__pname" type="text" maxlength="' + PRESET_NAME_MAX + '"' +
                ' placeholder="Preset name" aria-label="Preset name">' +
              '<textarea class="ytc-fm__pdesc" rows="2" maxlength="' + PRESET_DESC_MAX + '"' +
                ' placeholder="Description (optional)" aria-label="Preset description">' +
              '</textarea>' +
            '</div>' +
            '<button type="button" class="ytc-fm__savepreset">' +
              'Save these filters as a preset</button>' +
            '<button type="button" class="ytc-fm__pcancel" hidden>Cancel</button>' +
          '</div>' +
          '<button type="button" class="ytc-fm__reset">Reset</button>' +
        '</div>' +
        '<div class="ytc-fm__main">' +
          /* One line that scrolls, not a block that grows. Seven sorts wrapped to a second
             row at the widths this modal actually opens at, and that row pushed the results
             down by its full height — a permanent cost paid so that the last two chips,
             which most readers never touch, could be visible without a gesture. YouTube's
             own filter bar answers this the same way, so the gesture is already familiar. */
          '<div class="ytc-fm__sortbar">' +
            railButton('prev') +
            '<div class="ytc-fm__sorts" role="group" aria-label="Sort results">' +
              FILTER_SORTS.map((c) =>
                '<button type="button" class="ytc-fm__sort' +
                (FILTER_STATE.sort === c.key ? ' on' : '') + '" data-sort="' + c.key + '">' +
                c.label + '<span>' +
                (FILTER_STATE.sort === c.key ? (FILTER_STATE.desc ? '\u25BC' : '\u25B2') : '\u25BC') +
                '</span></button>').join('') +
            '</div>' +
            railButton('next') +
          '</div>' +
          '<div class="ytc-fm__loadbar" hidden></div>' +
          '<div class="ytc-fm__results"></div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(veil);
    document.body.appendChild(modal);
    pageLock(true);

    /* The badge row in each result is a clone, so its buttons carry no handlers — those were
       bound to the card they were built for. Rather than reimplement copying and thumbnail
       downloading here, a click is forwarded to the real button on the source card, which
       already knows how to do both. */
    modal.querySelector('.ytc-fm__results').addEventListener('click', (e) => {
      /* The channel name goes to the channel, not to the video.

         The whole row is one <a> pointing at the watch page, and a real link to the channel
         cannot be nested inside it — an anchor inside an anchor is invalid and the browser
         unnests it. So the name is a plain element that carries the channel key, and this
         turns a click on it into the navigation it obviously means. Opened in a new tab like
         the row itself, so a click never costs the reader the list they are working through. */
      const chan = e.target.closest && e.target.closest('[data-chan]');
      if (chan && chan.dataset.chan) {
        e.preventDefault();
        e.stopPropagation();
        window.open('https://www.youtube.com/' + encodeURI(chan.dataset.chan),
                    '_blank', 'noopener');
        return;
      }
      const btn = e.target.closest && e.target.closest('.ytc-btn, .ytc-thumb');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const row = btn.closest('.ytc-fm__row');
      const box = modal.querySelector('.ytc-fm__results');
      const rec = row && box._rows && box._rows[Number(row.dataset.i)];
      if (!rec || !rec.card || !rec.card.isConnected) return;
      const cls = btn.classList.contains('ytc-thumb') ? '.ytc-thumb' : '.ytc-btn';
      const real = rec.card.querySelector('.ytc-tools ' + cls);
      if (real) real.click();
    });
    modal.querySelectorAll('.ytc-fm__range').forEach(paintRange);
    wireSortRail(modal);
    paintFilterResults();
    watchBadges();

    const redraw = () => paintFilterResults();
    veil.addEventListener('click', closeFilterModal);
    modal.querySelector('.ytc-fm__x').addEventListener('click', closeFilterModal);

    modal.querySelectorAll('.ytc-fm__range input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const box = inp.closest('.ytc-fm__range');
        const key = box.dataset.range;
        const which = inp.dataset.end === 'lo' ? 0 : 1;
        const other = which === 0 ? 1 : 0;
        let v = Number(inp.value);
        // Handles may meet but never cross, or the range would read inverted.
        if (which === 0) v = Math.min(v, FILTER_STATE[key][other]);
        else v = Math.max(v, FILTER_STATE[key][other]);
        inp.value = v;
        FILTER_STATE[key][which] = v;
        FILTER_STATE.preset = 'all';
        markActivePreset(modal);
        paintRange(box);
        redraw();
      });
    });

    renderPresets(modal);
    renderPresetForm(modal);
    /* Storage is asynchronous and the modal is built synchronously, so a filter opened in the
       first moments of a page load would show the built-ins alone. Re-read and repaint. */
    loadPresets(() => { if (modal.isConnected) renderPresets(modal); });

    /* Anywhere else closes an open ⋮ menu. The menu items stop their own clicks, and the dots
       toggle theirs, so reaching here means the reader clicked past it. */
    modal.addEventListener('click', () => {
      if (!pmMenu) return;
      pmMenu = '';
      renderPresets(modal);
    });

    /* Reset clears the filters, so a form standing on them has nothing left to describe.
       It reopens the modal, which rebuilds everything — this only makes sure the form state
       does not survive into the new one. */
    modal.querySelector('.ytc-fm__reset').addEventListener('click', () => { pmForm = null; });

    const savePreset = modal.querySelector('.ytc-fm__savepreset');
    if (savePreset) {
      savePreset.addEventListener('click', () => {
        // One button, two jobs: it opens the form, and once open it is the one that commits.
        if (pmForm) { commitPresetForm(modal); return; }
        pmForm = { mode: 'new' };
        renderPresetForm(modal);
        renderPresets(modal);
      });
    }

    const cancelPreset = modal.querySelector('.ytc-fm__pcancel');
    if (cancelPreset) cancelPreset.addEventListener('click', () => closePresetForm(modal));

    modal.querySelectorAll('.ytc-fm__pname, .ytc-fm__pdesc').forEach((f) => {
      f.addEventListener('keydown', (e) => {
        // Escape belongs to the form while a field has focus; the modal's own handler would
        // otherwise close the whole thing and lose what was typed.
        e.stopPropagation();
        if (e.key === 'Escape') { closePresetForm(modal); return; }
        // Enter commits from the name field. The description is a textarea, where Enter is
        // a newline and taking it would be surprising.
        if (e.key === 'Enter' && f.classList.contains('ytc-fm__pname')) {
          e.preventDefault();
          commitPresetForm(modal);
        }
      });
    });

    const moreP = modal.querySelector('.ytc-fm__more-presets');
    if (moreP) {
      moreP.addEventListener('click', () => setPresetList(modal, !FILTER_STATE.allPresets));
    }

    const secBtn = modal.querySelector('.ytc-fm__sec--btn');
    if (secBtn) {
      secBtn.addEventListener('click', () => setDrawer(modal, !FILTER_STATE.custom));
    }

    modal.querySelectorAll('.ytc-fm__seg button').forEach((b) => {
      b.addEventListener('click', () => {
        FILTER_STATE.kind = b.dataset.kind;
        FILTER_STATE.preset = 'all';
        markActivePreset(modal);
        syncFilterControls(modal);
        redraw();
      });
    });

    modal.querySelectorAll('.ytc-fm__sort').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.sort;
        if (FILTER_STATE.sort === k) FILTER_STATE.desc = !FILTER_STATE.desc;
        else { FILTER_STATE.sort = k; FILTER_STATE.desc = true; }
        syncFilterControls(modal);
        redraw();
      });
    });

    modal.querySelector('.ytc-fm__reset').addEventListener('click', () => {
      resetRanges(FILTER_STATE);
      Object.assign(FILTER_STATE, { sort: FM_DEFAULT_SORT, desc: true, preset: 'all' });
      closeFilterModal();
      openFilterModal();
    });

    document.addEventListener('keydown', function esc(e) {
      if (e.key !== 'Escape') return;
      closeFilterModal();
      document.removeEventListener('keydown', esc);
    });
  }

  /* The trigger, in YouTube's own masthead beside the search box.

     It was floating at the bottom-right, which is where a chat widget lives — not where
     anyone looks for a control that acts on the results they are reading. The masthead is
     rebuilt on navigation, so placement is checked rather than assumed: if the button does
     not come out visible it is removed and tried again on the next scan, and the floating
     position remains as the last resort so the feature is never simply unreachable. */
  function filterHosts() {
    const out = [];
    for (const sel of ['ytd-masthead #center', 'ytd-masthead #end', '#masthead #center']) {
      document.querySelectorAll(sel).forEach((el) => { if (out.indexOf(el) < 0) out.push(el); });
    }
    return out;
  }

  /* ------------------------------------------------------- search companion */

  /* What a search page can be asked about itself, using only the results it has already
     drawn. Every figure here is measured from those cards — nothing is fetched, and nothing
     is estimated from data the page does not have.

     Which is why there is no "search volume" panel. How many people type a phrase into
     YouTube is not published anywhere, by any endpoint; a tool that shows it is modelling it
     from its own users' behaviour. Inventing a number here and colouring it green would be
     the same failure as pricing a boxing channel as basketball: confident, legible, and made
     up. What the results genuinely do say is how much attention the topic is getting right
     now and how contested it is, so those are the two the panel shows. */
  function searchTerm() {
    if (!/^\/results/.test(location.pathname)) return '';
    try { return (new URL(location.href).searchParams.get('search_query') || '').trim(); }
    catch (e) { return ''; }
  }

  const SNIPPET_SELECTORS = [
    '.metadata-snippet-text',
    '.metadata-snippet-container yt-formatted-string',
    'yt-formatted-string.metadata-snippet-text-navigation',
    '#description-text'
  ].join(', ');

  function cardSnippet(card) {
    const el = card.querySelector(SNIPPET_SELECTORS);
    return el ? (text(el) || '') : '';
  }

  /* Words rather than the raw phrase: "nolan wells case" should count as targeting "nolan
     wells", and a title that happens to contain the letters inside a longer word should not.
     Short filler words are dropped so a two-word term is not matched by "the" alone. */
  function termWords(term) {
    return String(term).toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2);
  }

  /* Whole words, not substrings. A plain indexOf counts "nolanwellsy" as targeting "nolan
     wells", which would inflate the in-title figure with results that are not aimed at the
     term at all — and that figure feeds the competition reading. Punctuation is flattened to
     spaces first, so "Wells' case" and "Wells, Nolan:" both still count. */
  function hasTerm(haystack, words) {
    if (!words.length) return false;
    const hay = ' ' + String(haystack || '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
    return words.every((w) => hay.indexOf(' ' + w + ' ') >= 0);
  }

  /* How much of the query a title actually covers, 0 to 1. hasTerm above is all-or-nothing
     and stays that way for the In-title count, which reports exact matches. This is the
     graded version, and it is what decides whether a result is receiving attention for the
     term or merely sitting on the same page as it. */
  function titleOverlap(haystack, words) {
    if (!words.length) return 0;
    const hay = ' ' + String(haystack || '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
    let hit = 0;
    for (const w of words) if (hay.indexOf(' ' + w + ' ') >= 0) hit++;
    return hit / words.length;
  }

  const median = (list) => {
    if (!list.length) return null;
    const a = list.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const mean = (list) => (list.length
    ? list.reduce((a, b) => a + b, 0) / list.length : null);

  /* The sample is pinned to the first results the page showed, not to whatever is loaded at
     the moment of asking. Recomputing over a growing list meant the panel described "the cards
     currently in the DOM" while claiming to describe "the results for this term" — and every
     figure shifted underfoot as you scrolled, which makes two terms impossible to compare and
     one term impossible to trust.

     Pinned by video id rather than by taking the first twenty rows each time: identity is what
     keeps the membership fixed, and it still lets the numbers improve, because a row whose
     subscriber lookup lands later is the same row and simply arrives with more filled in. */
  const SC_SAMPLE = 20;
  const SAMPLE = { keyword: '', ids: null };

  /* The results the page itself knows about, whether or not it has drawn them yet. Asked for
     once per search term and merged over the painted cards below.

     Validated by overlap before it is trusted: ytInitialData is assigned when the document
     loads and is not reliably rewritten when YouTube navigates between searches, exactly as
     this codebase already documents for ytInitialPlayerResponse. If the payload describes a
     different search than the one on screen, its ids will not match the cards that are
     painted, and it is dropped rather than merged. */
  const PAGE_RESULTS = { keyword: '', rows: null, asked: false };

  function loadPageResults(term) {
    if (PAGE_RESULTS.keyword === term) return;
    PAGE_RESULTS.keyword = term;
    PAGE_RESULTS.rows = null;
    PAGE_RESULTS.asked = true;
    pageData().then((page) => {
      if (PAGE_RESULTS.keyword !== term) return;
      const list = page && Array.isArray(page.search) ? page.search : null;
      PAGE_RESULTS.rows = list && list.length ? list : null;
      ensureCompanion();
    }).catch(() => { /* the painted cards still work on their own */ });
  }

  /* One row per result the page lists, carrying whatever the painted card knows on top. The
     card is the better source where it exists — its badges hold the subscriber lookup — but
     the payload is the only source for a result that has not been drawn. */
  function mergePageResults(dom) {
    const list = PAGE_RESULTS.rows;
    if (!list) return null;
    const byId = new Map();
    for (const r of dom) if (r.id) byId.set(r.id, r);
    // Anything the payload lists that is also painted proves the two describe one page.
    const overlap = list.filter((p) => byId.has(p.id)).length;
    if (overlap < Math.min(3, list.length)) return null;
    const now = Date.now();
    const fromList = list.map((p) => {
      const card = byId.get(p.id);
      if (card) {
        /* Exact counts beat the card's abbreviated text: "1.7M" parses back as 1,700,000 and
           averaging rounded numbers is how the figures drifted between reads. */
        const patch = {};
        if (p.views != null) patch.views = p.views;
        /* Search cards paint an avatar for some results and not others, so a drawn card is
           no guarantee of one. The payload carries it for every result, so fill the gap
           rather than leaving the channel list on its placeholder icon. */
        if (!card.avatar && p.avatar) patch.avatar = p.avatar;
        if (!card.chanKey && p.chanKey) patch.chanKey = p.chanKey;
        return Object.keys(patch).length ? Object.assign({}, card, patch) : card;
      }
      const ageDays = daysSince(F.relativeToISO(p.published, now));
      return {
        card: null, tools: '', title: p.title, url: '', id: p.id,
        channel: p.channel, chanKey: p.chanKey || '', avatar: p.avatar || '',
        views: p.views, subs: null,
        ratio: null, subRatio: null,
        vph: p.views != null && ageDays ? p.views / (ageDays * 24) : null,
        ageDays: ageDays, chanAge: '', shorts: p.shorts, thumb: '', date: p.published
      };
    });

    /* Union, not replacement. Returning only what the payload listed threw away every painted
       card it did not mention — and the payload is read once per search and cached, so a
       shallow one (three entries where the page went on to draw thirty) capped the panel at
       three and froze it there however far anyone scrolled. The payload's job is to supply
       results the page has not drawn yet, not to decide which ones count. */
    const listed = new Set(list.map((p) => p.id));
    for (const r of dom) if (r.id && !listed.has(r.id)) fromList.push(r);
    return fromList;
  }

  /* The first twenty, pinned — the score's sample, not the panel's.

     These are two different jobs and they were sharing one answer. The statistics describe
     what is on the page and should grow as more of it loads: the reference tool's denominators
     climb from 33 to 84 as the reader scrolls, and capping mine at 20 was answering a
     different question than the one the block claims to. The score must not move, because a
     number that drifts while you scroll cannot be compared between terms — and that is why it
     was capped in the first place.

     So the cap stays, on the score alone. Deeper results are genuinely weaker, so letting them
     into the score would drift it downward the further anyone scrolled, which says more about
     the reader than the keyword. */
  function pinnedRows(all, term) {
    /* Shorts stay in. Taking them out looked right — their views and velocity follow a
       different distribution, and it explained the reference tool's 14s and 18s where mine
       were a flat 20. "rtyui" showed what it cost: the only results genuinely matching that
       term are Shorts, and removing them left nothing but the popular videos YouTube padded
       the page with, so the panel described competition having nothing to do with the term.
       Whatever ranks for a term is what a creator is up against, whichever format it is.

       The 14s and 18s were something else anyway — sponsored slots, which the ad filter in
       collectScrolled now removes. */
    const rows = all;
    if (SAMPLE.keyword !== term) { SAMPLE.keyword = term; SAMPLE.ids = null; }
    // Not enough on the page yet: report on what there is and pin once the page has caught up.
    if (!SAMPLE.ids) {
      if (rows.length < SC_SAMPLE) return rows;
      SAMPLE.ids = rows.slice(0, SC_SAMPLE).map((r) => r.id).filter(Boolean);
    }
    const byId = new Map();
    for (const r of rows) if (r.id && !byId.has(r.id)) byId.set(r.id, r);
    const picked = SAMPLE.ids.map((id) => byId.get(id)).filter(Boolean);
    /* A soft navigation can replace the results under the same query string. If the pinned
       videos are no longer on the page, the pin is stale and worth nothing. */
    return picked.length >= Math.min(SC_SAMPLE, SAMPLE.ids.length) / 2
      ? picked : rows.slice(0, SC_SAMPLE);
  }

  /* Caption results for the current term, once the reader has asked for them.
     Keyed by term: the answer is about a phrase, not about the videos. */
  const CAPS = { keyword: '', state: 'idle', hits: null, checked: 0, withCaptions: 0 };
  /* The sample the button would act on. The panel's markup is replaced on every repaint, so
     the handler is delegated and cannot close over the rows it was drawn with. */
  const PANEL_ROWS = { term: '', rows: [] };

  function capsFor(term) {
    if (CAPS.keyword !== term) {
      CAPS.keyword = term;
      CAPS.state = 'idle';
      CAPS.hits = null;
      CAPS.checked = 0;
      CAPS.withCaptions = 0;
    }
    return CAPS;
  }

  function runCaptionCheck(term, rows) {
    const c = capsFor(term);
    if (c.state === 'running') return;
    c.state = 'running';
    ensureCompanion();
    const ids = rows.map((r) => r.id).filter(Boolean);
    sendMessage({ type: 'ytc-captions', videos: ids, words: termWords(term) }, (res) => {
      if (CAPS.keyword !== term) return;
      if (chrome.runtime.lastError || !res || !res.ok) {
        CAPS.state = 'failed';
      } else {
        CAPS.state = 'done';
        CAPS.hits = new Set(res.hits || []);
        CAPS.checked = res.checked || 0;
        CAPS.withCaptions = res.withCaptions || 0;
      }
      ensureCompanion();
    });
  }

  function searchStats(rows, term) {
    const words = termWords(term);
    const views = rows.map((r) => r.views).filter((v) => v != null);
    const subs = rows.map((r) => r.subs).filter((v) => v != null);
    const ages = rows.map((r) => r.ageDays).filter((v) => v != null);
    const vphs = rows.map((r) => r.vph).filter((v) => v != null);

    const inTitle = rows.filter((r) => hasTerm(r.title, words)).length;
    const inDesc = rows.filter((r) => hasTerm(cardSnippet(r.card), words)).length;
    const fresh = rows.filter((r) => r.ageDays != null && r.ageDays <= 7).length;

    /* Attention, from the videos actually being watched FOR this term.

       It used to average every result on the page, which meant it averaged the padding —
       and padding is exactly what YouTube supplies when a query has no real matches. Type
       "gjfgfkjdfdfd" and the page fills with popular unrelated videos whose velocity is
       genuinely high, so the panel reported high attention for a string no video contains.
       That is the same error already corrected for competition, where these results are
       described as "videos YouTube reached for rather than competitors" — they are no more
       evidence of demand than they are of contest.

       So a result contributes in proportion to how much of the query its title carries, and
       does not contribute at all below half. Nothing matching means no attention measured,
       which is the honest reading of a page that has nothing to do with the term. */
    const RELEVANT_ENOUGH = 0.5;
    /* A checked caption hit is relevance at full weight — stronger evidence than a title,
       not weaker: the video spends real time on the term rather than merely naming it. Until
       the check has been run this contributes nothing, so the panel behaves exactly as it did
       and the reader pays for the fetches only when they ask. */
    const caps = CAPS.keyword === term && CAPS.hits ? CAPS.hits : null;
    const scored = rows
      .map((r) => ({
        row: r,
        w: Math.max(titleOverlap(r.title, words), caps && caps.has(r.id) ? 1 : 0)
      }))
      .filter((x) => x.w >= RELEVANT_ENOUGH);
    const attentive = scored
      .map((x) => ({ w: x.w, vph: x.row.vph }))
      .filter((x) => x.vph != null);
    const weight = attentive.reduce((a, x) => a + x.w, 0);
    const attention = weight ? attentive.reduce((a, x) => a + x.w * x.vph, 0) : null;
    const attentiveCount = attentive.length;

    /* How hard this term is to take: how big the channels on page one are, and how many
       views they already command.

       The in-title share has been tried as an addend and then as a multiplier on this figure,
       and it was wrong both times, for the same underlying reason — hasTerm requires every
       significant word of the query in the title, which a multi-word search almost never
       satisfies. "tech review" came back 3/20 and, as a multiplier, that scored one of the
       most contested terms on YouTube at 29/100 "Low" while its page showed a 16.6M median
       subscriber count. A signal that collapses on ordinary queries cannot be allowed to
       scale the whole measure.

       It is now reported (In title) and used as a caveat, but it does not move this number.
       What moves it is what is actually on the page. */
    const raw = rows.length ? inTitle / rows.length : 0;
    /* Measured over the results that carry the term, not everything on the page — the same
       correction attention just had, and for the same reason. A page of videos that have
       nothing to do with the query describes no competition for it, however large those
       videos are: "gfggdjfskfhsd" read 51/100 "Moderate" off six unrelated results. Nothing
       carrying the term means there is no contest to measure, not a middling one. */
    const medSubs = median(scored.map((x) => x.row.subs).filter((v) => v != null));
    const medViews = median(scored.map((x) => x.row.views).filter((v) => v != null));
    const logScale = (v, top) => Math.min(1, Math.log10(v + 1) / Math.log10(top));
    const subsPressure = medSubs == null ? null : logScale(medSubs, 1e7);    // 10M saturates
    const viewPressure = medViews == null ? null : logScale(medViews, 1e7);
    const competition = subsPressure == null ? null
      : Math.round((subsPressure * 0.55 +
                    (viewPressure == null ? subsPressure : viewPressure) * 0.45) * 100);

    /* Whether the page is answering the phrase or reaching past it. This used to withhold the
       score outright, and it fired far too readily: hasTerm needs every significant word of
       the query in the title, which a three-word search almost never satisfies, so ordinary
       terms like "tech review usa" came back 2/20 and were treated as unanswerable. Two of
       five sampled terms were withheld that way.

       It is a caveat now rather than a veto. The reader gets the number and the reason it may
       not mean what it appears to — which is the honest shape of the problem, because without
       search volume a term nobody targets is indistinguishable from an opening and a dead
       end, and refusing to score it did not tell them which either. */
    const relevant = raw >= 0.15;

    return {
      term, n: rows.length,
      counted: views.length,
      topViews: views.length ? Math.max.apply(null, views) : null,
      avgViews: mean(views),
      avgSubs: mean(subs),
      subsKnown: subs.length,
      avgAge: mean(ages),
      inTitle, inDesc, fresh,
      rows,
      capState: CAPS.keyword === term ? CAPS.state : 'idle',
      capHits: caps ? rows.filter((r) => caps.has(r.id)).length : null,
      capChecked: CAPS.keyword === term ? CAPS.checked : 0,
      attention, competition, medSubs, medViews, relevant, targeting: raw,
      attentiveCount,
      // Weighted mean, so a title carrying half the query counts half.
      attentionPerVideo: weight ? attention / weight : null
    };
  }

  /* Thresholds set against the reference tool rather than picked, so the same magnitude gets
     the same word in both. Read off its bars: a competition bar filled to ~85 is labelled
     "High" there and was "Very high" here, and a score of 68 is "High" there and would have
     been "Moderate" here. The measurements already agreed; only the vocabulary did not. */
  const BANDS = [
    { at: 90, label: 'Very high', tier: 'great' },
    { at: 60, label: 'High', tier: 'good' },
    { at: 38, label: 'Moderate', tier: 'ok' },
    { at: 15, label: 'Low', tier: 'low' },
    { at: 0,  label: 'Very low', tier: 'poor' }
  ];
  const bandFor = (pct) => BANDS.find((b) => pct >= b.at) || BANDS[BANDS.length - 1];

  /* Attention is scored per video, not as a page total.

     A total is a sum over however many results happen to have loaded, so it climbs as you
     scroll and the score climbs with it — the number then partly measures how far down the
     page you are, which is no property of the keyword. Competition never had this problem
     because it is built from a ratio and a median; that is exactly why it sat at 89-93 across
     the same scrolls that moved attention threefold.

     A mean is invariant to how many results are in hand, so loading more refines the estimate
     rather than inflating it, and two terms compare even when one has 8 results read and the
     other 37.

     No natural ceiling either way, so it goes on a log scale against a fixed top rather than
     against the other results on screen — scaling to the page would make the busiest term on
     any page 100% of itself, every time. */
  /* 20,000 was set from what a runaway video can do, and that is the wrong end to calibrate
     from: it is the ceiling of the whole platform, not of a search page. It squeezed the band
     real results actually occupy — roughly 10 to 500 views/hour for a typical result — into
     24-63% of the bar, so a breaking-news term at 1.2K/h still read 72% and nothing was ever
     "very high". 2,000 puts the working range across the bar, where it discriminates. */
  const ATTENTION_TOP = 2000;     // views/hour for a typical result on a hot search
  function attentionPct(vph) {
    if (vph == null) return null;
    return Math.max(0, Math.min(100,
      Math.round(Math.log10(vph + 1) / Math.log10(ATTENTION_TOP + 1) * 100)));
  }

  /* A semicircular gauge, drawn as one arc with a dash offset. 157.08 is the length of a
     radius-50 half circle, so the visible fraction is just that length scaled by the score. */
  const GAUGE_ARC = 157.08;

  /* Competition is a median of the subscriber counts that have actually come back, and it is
     half of what moves the score. On a page where few lookups have landed, that median is
     taken over a handful of channels — the number is still the best available, but presenting
     it at the same confidence as a full sample is the thing this panel keeps being wrong
     about. So the gauge says what it is standing on until the sample fills in. */
  const SC_THIN = 0.6;             // below this share of the sample, say so

  function gauge(score, band, note) {
    const none = score == null;
    const shown = none ? 0 : Math.max(0, Math.min(100, score));
    /* The caveats live in the tooltip, not under the number. They are three sentences on a
       good day and five on a bad one, and printed out they pushed the score into a wall of
       small grey text — the one thing the reader came to see, buried under the reasons it
       might be wrong. The marker beside the label is what makes them findable. */
    return '<div class="ytc-sc__gauge"' +
      (note ? ' title="' + escapeHtml(note) + '"' : '') + '>' +
      '<svg viewBox="0 0 120 68" class="ytc-sc__gsvg" aria-hidden="true">' +
        '<path class="ytc-sc__gtrack" d="M10,60 A50,50 0 0 1 110,60"/>' +
        '<path class="ytc-sc__garc ytc-sc__garc--' + (band ? band.tier : 'poor') + '" ' +
          'd="M10,60 A50,50 0 0 1 110,60" ' +
          'stroke-dasharray="' + (GAUGE_ARC * shown / 100).toFixed(2) + ' ' + GAUGE_ARC + '"/>' +
      '</svg>' +
      '<div class="ytc-sc__gnum">' + (none ? '\u2014' : Math.round(shown)) + '</div>' +
      '<div class="ytc-sc__glabel">Overall score' +
        (note ? '<span class="ytc-sc__ginfo" aria-hidden="true">?</span>' : '') + '</div>' +
      '<div class="ytc-sc__gband' + (band ? ' ytc-onum--' + band.tier : '') + '">' +
        escapeHtml(band ? band.label.toUpperCase() : '\u2014') + '</div>' +
    '</div>';
  }

  /* A collapsible section, so a panel this tall can be cut down to the part being used. */
  function scSection(key, title, body, note) {
    const open = !SC_SHUT.has(key);
    return '<section class="ytc-sc__sec' + (open ? '' : ' shut') + '" data-sec="' + key + '">' +
      '<button type="button" class="ytc-sc__sechead"' +
        (note ? ' title="' + escapeHtml(note) + '"' : '') + '>' +
        '<b>' + escapeHtml(title) + '</b>' +
        '<span class="ytc-sc__chev">\u25BE</span></button>' +
      '<div class="ytc-sc__secbody">' + body + '</div>' +
    '</section>';
  }

  const SC_SHUT = new Set();   // sections collapsed by hand, for this page view

  /* Small line icons, drawn rather than taken from a font so they sit on the text baseline at
     any zoom and inherit currentColor in both themes. */
  const SC_ICONS = {
    eye: 'M1 8s2.7-4.5 7-4.5S15 8 15 8s-2.7 4.5-7 4.5S1 8 1 8Z M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
    trend: 'M1.5 11.5 6 7l3 3 5.5-5.5 M10.5 4.5h4v4',
    people: 'M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M1.5 13.5c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5 M11 4.2a2.2 2.2 0 0 1 0 4.3 M12.5 13.5c0-1.6-.6-2.6-1.6-3.2',
    clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M8 4.5V8l2.5 1.5',
    title: 'M2 4h12 M2 8h9 M2 12h6',
    doc: 'M4 1.5h5l3 3v10H4Z M9 1.5v3h3',
    cal: 'M2.5 3.5h11v11h-11Z M2.5 6.5h11 M5.5 1.5v3 M10.5 1.5v3',
    cc: 'M1.5 3h13v10h-13Z M6 6.5a2 2 0 1 0 0 3 M11.5 6.5a2 2 0 1 0 0 3'
  };

  function scIcon(name) {
    const d = SC_ICONS[name];
    if (!d) return '';
    return '<svg class="ytc-sc__ico" viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="' + d + '"/></svg>';
  }

  /* tier is passed separately because the colour does not always follow the number.
     Competition runs the other way from everything else here — a high one is a worse prospect,
     not a better one — so it keeps its "Very high" label while taking the danger colour.
     Colouring it by magnitude painted a wall of green over the single worst thing the panel
     can tell you. */
  function meterRow(label, pct, valueText, title, tier) {
    const band = pct == null ? null : (tier ? { tier: tier } : bandFor(pct));
    return '<div class="ytc-sc__meter" title="' + escapeHtml(title || '') + '">' +
      '<span class="ytc-sc__mhead"><b>' + escapeHtml(label) + '</b>' +
        '<i class="ytc-sc__mval' + (band ? ' ytc-onum--' + band.tier : '') + '">' +
        escapeHtml(valueText) + '</i></span>' +
      '<span class="ytc-sc__track"><i class="ytc-sc__fill' +
        (band ? ' ytc-sc__fill--' + band.tier : '') +
        '" style="width:' + (pct == null ? 0 : pct) + '%"></i></span>' +
    '</div>';
  }

  function statCell(icon, label, value, title, note) {
    return '<div class="ytc-sc__stat" title="' + escapeHtml(title || '') + '">' +
      '<span class="ytc-sc__badge">' + scIcon(icon) + '</span>' +
      '<span class="ytc-sc__statmeta"><span>' + escapeHtml(label) + '</span>' +
      '<b>' + escapeHtml(value) + '</b>' +
      (note ? '<em class="ytc-sc__partial">' + escapeHtml(note) + '</em>' : '') +
      '</span></div>';
  }

  function miniStat(icon, label, value, title) {
    return '<div class="ytc-sc__minirow" title="' + escapeHtml(title || '') + '">' +
      scIcon(icon) + '<span>' + escapeHtml(label) + '</span>' +
      '<b>' + escapeHtml(value) + '</b></div>';
  }

  /* The series, held per keyword for as long as the panel is open. Kept out of the render so
     an arriving series repaints once, rather than every scan asking for it again. */
  const SERIES = { keyword: '', asked: false, data: null };

  /* An inline sparkline rather than a chart library: one path, two labels, no dependency, and
     it has to sit inside a 292px panel. */
  function sparkline(points) {
    const vals = points.map((p) => p.vph);
    const hi = Math.max.apply(null, vals);
    const lo = Math.min.apply(null, vals);
    const span = hi - lo || 1;
    const W = 100, H = 34;
    const xy = points.map((p, i) => {
      const x = points.length === 1 ? W / 2 : (i / (points.length - 1)) * W;
      const y = H - ((p.vph - lo) / span) * (H - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const line = 'M' + xy.join('L');
    const area = line + 'L' + W + ',' + H + 'L0,' + H + 'Z';
    return '<svg class="ytc-sc__spark" viewBox="0 0 ' + W + ' ' + H +
        '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="ytc-sc__sparkfill" d="' + area + '"/>' +
      '<path class="ytc-sc__sparkline" d="' + line + '" fill="none" vector-effect="non-scaling-stroke"/>' +
    '</svg>';
  }

  function seriesHtml(term) {
    const s = SERIES;
    if (s.keyword !== term) {
      return '<p class="ytc-sc__note">Reading\u2026</p>';
    }
    const d = s.data;
    if (!d || !d.ok) {
      /* One message on screen, the specifics in the tooltip.
         It said "No index configured" for every failure, which named a cause it had not
         checked and sent the reader to fix a setting that was already correct. Reporting the
         real reason fixed that and introduced the opposite fault: "running a build without
         the sampling routes" is a note to whoever runs the service, printed at someone
         looking for a chart. Neither audience is served by choosing one — so the panel says
         the one thing that is true for every case, and the diagnosis is a hover away. */
      const why = (d && d.reason) || '';
      const detail =
        !d ? 'The index service did not answer.'
        : /no index|not configured/i.test(why)
          ? 'No index is configured, so nothing is being sampled.'
        : /\b404\b/.test(why)
          ? 'The index service is running a build without the sampling routes. Restarting it ' +
            'picks them up.'
        : /unreachable|fetch failed/i.test(why)
          ? 'The index service could not be reached.'
        : why
          ? 'The index service answered: ' + why
          : 'Nothing is being sampled for this term yet.';
      return '<p class="ytc-sc__note" title="' + escapeHtml(detail) + '">' +
        'Not enough data to display yet.</p>';
    }
    const pts = d.points || [];
    if (pts.length < 2) {
      /* Deliberately explicit rather than an empty chart. This is the one number on the panel
         that cannot be measured from the page, and saying "come back" is the honest state —
         a flat line drawn from one sample would be a shape with no meaning. */
      return '<p class="ytc-sc__note" title="' + escapeHtml('Tracking ' + (d.videos || 0) +
        ' videos for this term. A rate is the change between two readings, so the first ' +
        'point appears once a second one has been taken.') + '">' +
        'Not enough data to display yet.</p>';
    }
    const last = pts[pts.length - 1];
    const first = pts[0];
    const change = first.vph > 0
      ? Math.round(((last.vph - first.vph) / first.vph) * 100) : null;
    const dir = change == null ? '' : change > 0 ? '+' : '';
    return '<div class="ytc-sc__chart" title="Views per hour across the ' + (d.videos || 0) +
        ' videos tracked for this term, measured as the change between samples \u2014 not ' +
        'views divided by age, which falls with age whatever the audience does.">' +
        '<div class="ytc-sc__chead"><b>' + F.formatVph(last.vph) + '/h</b>' +
          (change == null ? '' : '<i class="' +
            (change >= 0 ? 'ytc-onum--great' : 'ytc-onum--poor') + '">' +
            dir + change + '%</i>') +
        '</div>' +
        sparkline(pts) +
        '<div class="ytc-sc__cfoot"><span>' + pts.length + ' samples</span>' +
          '<span>now</span></div>' +
      '</div>';
  }

  /* Which channels own this search, from the sample already in hand.

     The statistics say what a typical result looks like; this says who keeps producing them.
     One channel holding six of twenty results is a different proposition from twenty channels
     holding one each, and no average shows the difference. */
  const CHAN_SORT = { by: 'views' };          // views | results

  function topChannels(rows) {
    const by = new Map();
    for (const r of rows) {
      const name = (r.channel || '').trim();
      if (!name) continue;
      let c = by.get(name);
      if (!c) {
        c = { name, results: 0, views: 0, subs: null, avatar: '', key: '' };
        by.set(name, c);
      }
      c.results++;
      if (r.views != null) c.views += r.views;
      // Subscriber counts arrive per card; whichever lands first stands for the channel.
      if (c.subs == null && r.subs != null) c.subs = r.subs;
      if (!c.avatar && r.avatar) c.avatar = r.avatar;
      /* Whichever result names it first. A handle beats an id when both turn up, so the row
         links to the address the channel publishes rather than the internal one. */
      if (r.chanKey && (!c.key || (c.key[0] !== '@' && r.chanKey[0] === '@'))) {
        c.key = r.chanKey;
      }
    }
    const list = Array.from(by.values());
    list.sort((a, b) => (CHAN_SORT.by === 'results'
      ? b.results - a.results || b.views - a.views
      : b.views - a.views || b.results - a.results));
    return list;
  }

  function channelsBody(rows) {
    const list = topChannels(rows);
    if (!list.length) {
      return '<p class="ytc-sc__note">No channel names read from these results yet.</p>';
    }
    const top = list.slice(0, 8);
    const most = Math.max.apply(null, top.map((c) => (CHAN_SORT.by === 'results'
      ? c.results : c.views))) || 1;
    return '<div class="ytc-sc__chead">' +
        '<span>' + list.length + ' channels</span>' +
        '<button type="button" class="ytc-sc__csort" title="' +
          escapeHtml('Sort by total views across this page, or by how many of the results ' +
            'the channel holds.') + '">\u21c5 ' +
          (CHAN_SORT.by === 'results' ? 'results' : 'views') + '</button>' +
      '</div>' +
      top.map((c) => {
        const share = Math.max(4, Math.round(
          ((CHAN_SORT.by === 'results' ? c.results : c.views) / most) * 100));
        const sub = [
          c.subs == null ? '' : F.compact(c.subs) + ' subs',
          c.results + (c.results === 1 ? ' result' : ' results')
        ].filter(Boolean).join(' \u00b7 ');
        /* A link where the channel was identified, plain text where it was not. Every name
           here came off a card that links to its channel, so the link is normally there —
           but a result the payload described without a byline endpoint has no address to
           offer, and a dead anchor that looks live is worse than a name. */
        const href = c.key ? 'https://www.youtube.com/' + encodeURI(c.key) : '';
        const tip = c.name + ' \u2014 ' + sub + ', ' +
          (c.views ? F.compact(c.views) + ' views' : 'views unread') + ' across this page' +
          (href ? '. Opens the channel in a new tab.' : '');
        return (href
            ? '<a class="ytc-sc__chan" href="' + escapeHtml(href) + '" target="_blank" ' +
              'rel="noopener noreferrer" title="' + escapeHtml(tip) + '">'
            : '<div class="ytc-sc__chan" title="' + escapeHtml(tip) + '">') +
          (c.avatar
            ? '<img class="ytc-sc__cav" src="' + escapeHtml(c.avatar) + '" alt="" ' +
              'loading="lazy">'
            : '<span class="ytc-sc__cav ytc-sc__cav--none">' + scIcon('people') + '</span>') +
          '<span class="ytc-sc__cmeta">' +
            '<span class="ytc-sc__cname">' + escapeHtml(c.name) + '</span>' +
            '<span class="ytc-sc__csub">' + escapeHtml(sub) + '</span>' +
            '<span class="ytc-sc__cbar"><i style="width:' + share + '%"></i></span>' +
          '</span>' +
          '<b class="ytc-sc__cnum">' +
            (CHAN_SORT.by === 'results'
              ? c.results + '\u00d7'
              : (c.views ? F.compact(c.views) : '\u2014')) + '</b>' +
          (href ? '</a>' : '</div>');
      }).join('');
  }

  function companionHtml(st, stScore) {
    const dash = '—';
    const num = (v) => (v == null ? dash : F.compact(Math.round(v)) || String(Math.round(v)));
    const aPct = attentionPct(stScore.attentionPerVideo);
    const aBand = aPct == null ? null : bandFor(aPct);
    const cBand = stScore.competition == null ? null : bandFor(stScore.competition);
    const outOf = ' / ' + st.n;

    /* Worth targeting = plenty of attention, and not already crowded with strong videos aimed
       at the same phrase. So the score rewards one and penalises the other in equal measure.
       It is a composite of two things measured on this page, not a figure from a search
       dataset — which is why both halves sit directly underneath it, where anyone can see
       exactly what moved the number. */
    /* Withheld rather than guessed when the page has nothing to do with the phrase. A term
       nothing targets would otherwise score highest of all — zero competition reads as a wide
       open field — when what it actually means is that these results were padding and the
       page cannot speak to the term either way. Saying so is the useful answer; 75/HIGH would
       have been a confident one and wrong. */
    /* Weighted 65/35 toward demand, matched to the reference tool: solving its published
       score against its own two bars lands on 65/35, where an even split would have given 55
       for a term it calls 68. Competition therefore costs about half what it used to.

       Worth knowing what that trades away: at this weighting a term held by million-
       subscriber incumbents scores close to one held by nobody, so the score leans towards
       "is anyone watching" and away from "could I win it". The competition bar underneath is
       where that question still gets answered honestly. */
    const DEMAND_W = 0.65;
    const score = (aPct == null || stScore.competition == null)
      ? null : Math.round(aPct * DEMAND_W + (100 - stScore.competition) * (1 - DEMAND_W));
    const sBand = score == null ? null : bandFor(score);

    const keywordBody =
      gauge(score, sBand,
        /* Always shown, not only in edge cases, because it is always true: this score has no
           demand term in it. Two of the sampled searches proved the omission cannot be
           patched over from the page — "nolan wells update today" and "nolan wells gym" have
           the same 0/20 targeting and the same padded results, and one is searched constantly
           while the other is searched by nobody. A reader comparing two terms needs to know
           the number cannot tell them apart. */
        'Scores the results on this page. Search demand is not in it \u2014 YouTube ' +
        'publishes none, so a term nobody looks up can still score well here.' +
        /* These qualify the score, so they read the score's own slice — not the statistics
           block's, which keeps growing underneath and would report a different denominator
           than the number it is standing next to. */
        (!stScore.relevant
          // The threshold is a share, not zero, so the copy has to be too — it read
          // "No result ... (2 / 20)", contradicting itself on the same line.
          ? ' ' + (stScore.inTitle
              ? 'Only ' + stScore.inTitle + ' / ' + stScore.n + ' results target it'
              : 'Nothing in the scored results targets it') +
            ', so these are mostly videos YouTube reached for rather than competitors.'
          : '') +
        (stScore.n && stScore.subsKnown < stScore.n * SC_THIN
          ? ' Provisional \u2014 ' + stScore.subsKnown + ' of ' + stScore.n +
            ' channels looked up so far.' : '')) +
      meterRow('Attention', aPct,
        stScore.attentionPerVideo == null ? 'no matching videos'
          : F.formatVph(stScore.attentionPerVideo) + '/h ' + (aBand ? '· ' + aBand.label : ''),
        (stScore.attentionPerVideo == null
          ? 'No result whose title carries this term, so there is nothing being watched for ' +
            'it here to measure. The page is padding — videos YouTube reached for when the ' +
            'query matched nothing.'
          : 'Views per hour for a video that actually uses this term \u2014 across the ' +
            stScore.attentiveCount + ' of ' + stScore.n + ' results whose titles carry it, ' +
            'weighted by how much of the term each one carries. Per video rather than ' +
            'totalled, so it does not climb as more results load. Not search volume: ' +
            'YouTube publishes none, so nothing here models it.')) +
      meterRow('Competition', stScore.competition,
        stScore.competition == null ? 'no matching videos'
          : (cBand ? cBand.label : '') + ' · ' + stScore.competition + '/100',
        (stScore.competition == null
          ? 'No result whose title carries this term, so there is no contest here to measure. '
            + 'The page is padding, and the size of videos that are not competing for the '
            + 'term says nothing about how hard it is to take.'
          : 'How contested the term looks, from what the ' + stScore.attentiveCount +
        ' results carrying it already have: median ' +
        (stScore.medSubs == null ? 'unknown' : F.compact(stScore.medSubs)) +
        ' subscribers and median ' +
        (stScore.medViews == null ? 'unknown' : F.compact(stScore.medViews)) + ' views. ' +
        'Exact-title matches (' + stScore.inTitle + ' / ' + stScore.n + ') count for little, ' +
        'because a search returns titles matching the query whether or not it is contested.'),
        stScore.competition == null ? null : bandFor(100 - stScore.competition).tier);

    const statsBody =
      '<div class="ytc-sc__card">' +
        '<div class="ytc-sc__termrow"><span>Search term</span>' +
          '<b>\u201c' + escapeHtml(st.term) + '\u201d</b></div>' +
        '<div class="ytc-sc__stats">' +
          statCell('eye', 'Highest views', num(st.topViews),
            'The most-viewed of the ' + st.counted + ' results whose view count was read.') +
          statCell('trend', 'Avg views', num(st.avgViews),
            'Mean across ' + st.counted + ' results.') +
          statCell('people', 'Avg subscribers', st.avgSubs == null ? dash : num(st.avgSubs),
            st.subsKnown + outOf + ' channels looked up so far. Scroll the list to fill in ' +
            'the rest \u2014 lookups run only for cards near the viewport.',
            st.subsKnown < st.n ? 'from ' + st.subsKnown + ' of ' + st.n : '') +
          statCell('clock', 'Avg age', st.avgAge == null ? dash
            : (st.avgAge < 1 ? 'today' : Math.round(st.avgAge) + ' days'),
            'Mean age of the results, from the dates on the cards.') +
        '</div>' +
        '<div class="ytc-sc__mini">' +
          miniStat('title', 'In title', st.inTitle + outOf,
            'Results whose title contains every significant word of the term.') +
          miniStat('doc', 'In description', st.inDesc + outOf,
            'Results whose description snippet contains them. YouTube renders a snippet for ' +
            'only some results, so this reads low when it is absent rather than missing.') +
          miniStat('cal', 'Last 7 days', st.fresh + outOf,
            'How much of this page is recent \u2014 a term the feed is actively refreshing.') +
          /* Costs a megabyte-plus page per video, so it is a button until it is a number. */
          (st.capState === 'done'
            ? miniStat('cc', 'Captions', st.capHits + ' / ' + st.capChecked,
                'Results whose transcript says the term. Titles miss this: a video can spend ' +
                'minutes on a subject without naming it in the title, and those are real ' +
                'competitors the other counts here cannot see. Now counted as relevant, so ' +
                'the score above reads them too.')
            : st.capState === 'running'
              ? miniStat('cc', 'Captions', 'reading\u2026',
                  'Fetching each result\u2019s transcript. Roughly a megabyte per video and ' +
                  'one at a time, so it does not trip the rate limit the other lookups share.')
              : st.capState === 'failed'
                ? miniStat('cc', 'Captions', 'unavailable',
                    'The transcripts could not be read. Videos with captions turned off, or ' +
                    'YouTube rate limiting the run.')
                : '<button type="button" class="ytc-sc__capbtn" title="' +
                  escapeHtml('Reads each result\u2019s transcript to find the term where the ' +
                    'title does not say it. Costs roughly a megabyte per video, so it runs ' +
                    'only when asked \u2014 results are cached for a week.') +
                  '">' + scIcon('cc') + '<span>Check captions</span></button>') +
        '</div>' +
      '</div>';

    return '<div class="ytc-sc__head">' +
        '<img class="ytc-sc__logo" src="' +
          escapeHtml(chrome.runtime.getURL('icons/icon32.png')) + '" alt="">' +
        '<b>Search companion</b>' +
        '<button type="button" class="ytc-sc__fold" aria-label="Collapse">' +
          '<span class="ytc-sc__chev">▾</span></button>' +
      '</div>' +
      '<div class="ytc-sc__body">' +
        scSection('score', 'Keyword score', keywordBody) +
        scSection('vph', 'Velocity over time', seriesHtml(st.term)) +
        scSection('stats', 'Search term statistics', statsBody) +
        scSection('channels', 'Top channels for this search', channelsBody(st.rows || [])) +
        '<p class="ytc-sc__foot">Statistics cover all ' + st.n + ' results loaded so far and ' +
          'grow as you scroll. The score above reads a fixed first ' + stScore.n + ', so it ' +
          'holds still and stays comparable between searches. Everything here is counted, ' +
          'not modelled.</p>' +
      '</div>';
  }

  /* YouTube's search page is a two-column renderer, but the second column arrives empty — no
     secondaryContents in the payload — and an empty one is not merely zero-width: it may be
     hidden outright, and its parent is not necessarily laid out as a row at all. Waiting for
     that column to cooperate is what left the panel floating over the results.

     So the column is built rather than borrowed. The renderer is made a flex row, #primary is
     told it may shrink, and our own column goes in beside it. Every property is set inline so
     it can be recognised and taken back off when the feature is switched off, and the whole
     thing is checked by measurement afterwards: if the column still has no width, the panel
     floats rather than disappearing. */
  const SC_COL_W = 330;

  function searchRenderer() {
    return document.querySelector('ytd-two-column-search-results-renderer') ||
      document.querySelector('ytd-search #container');
  }

  function buildColumn() {
    const wrap = searchRenderer();
    if (!wrap) return null;
    const primary = wrap.querySelector('#primary') || wrap.firstElementChild;
    if (!primary || primary.classList.contains('ytc-sc__col')) return null;

    let col = wrap.querySelector(':scope > .ytc-sc__col');
    if (!col) {
      col = document.createElement('div');
      col.className = 'ytc-sc__col';
      primary.insertAdjacentElement('afterend', col);
    }
    if (wrap.dataset.ytcCol !== '1') {
      wrap.dataset.ytcCol = '1';
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'flex-start';
      /* The quietest way to break position:sticky is an ancestor that clips its overflow —
         the element simply scrolls away with no error and no clue. This is the one ancestor
         we own, so it is made explicitly visible rather than left to whatever YouTube's
         stylesheet says today. */
      wrap.style.overflow = 'visible';
      /* Without min-width:0 a flex item refuses to shrink below its content, so the results
         column would keep its full width and push ours off the edge instead of sharing. */
      primary.style.minWidth = '0';
      primary.style.flex = '1 1 auto';
      primary.dataset.ytcPrimary = '1';
    }
    return col;
  }

  function closeColumn() {
    document.querySelectorAll('[data-ytc-col="1"]').forEach((wrap) => {
      wrap.removeAttribute('data-ytc-col');
      wrap.style.display = '';
      wrap.style.alignItems = '';
      wrap.style.overflow = '';
    });
    document.querySelectorAll('[data-ytc-primary="1"]').forEach((el) => {
      el.removeAttribute('data-ytc-primary');
      el.style.minWidth = '';
      el.style.flex = '';
    });
    document.querySelectorAll('.ytc-sc__col').forEach((n) => n.remove());
  }

  /* Collapsing replaced closing, and it fixes the trap rather than papering over it. A closed
     panel left nothing on screen, so the state could not be undone from the page — reloading,
     the one thing anyone tries, changed nothing because the flag outlived it. Collapsed keeps
     its own header and chevron in view, so the way back is always the thing you are looking
     at. That is what makes it safe to remember: a preference is only safe to persist when the
     control that reverses it stays visible. Permanently off is the popup's job. */
  const SC_FOLD = 'ytcCompanionFold';

  function scFolded() {
    try { return sessionStorage.getItem(SC_FOLD) === '1'; } catch (e) { return false; }
  }
  function scFold(v) {
    try { sessionStorage.setItem(SC_FOLD, v ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  // Left behind by the version that hid the whole panel; clear it so it cannot resurrect.
  try { sessionStorage.removeItem('ytcCompanion'); } catch (e) { /* private mode */ }

  /* Sticky by hand.

     position:sticky is the right tool and this used it twice — once on the panel, once on the
     column. Both failed, and the reason it is worth abandoning rather than debugging further
     is the failure mode: any ancestor that clips its overflow disables sticky silently. No
     error, no warning, the element simply scrolls away. On a page whose ancestor chain is
     rewritten by someone else on their schedule, a mechanism that can be switched off from
     six levels up without telling anyone is the wrong mechanism, however correct it is when
     it works.

     Measuring the column and pinning the panel to the viewport does not care what any
     ancestor does. The column keeps its place in the flow and its width; only the panel is
     lifted out, and only while it would otherwise have scrolled past the top. */
  const STICK_TOP = 60;      // just clears YouTube's 56px masthead
  let stickRaf = 0;

  function positionPanel() {
    stickRaf = 0;
    const panel = document.querySelector('.ytc-sc');
    const col = panel && panel.closest('.ytc-sc__col');
    if (!panel || !col) return;                  // floating fallback pins itself
    const r = col.getBoundingClientRect();
    /* Read off the column, never the panel: once the panel is pinned it leaves the flow and
       the column collapses, so measuring the panel would feed its own position back in and
       flip between the two states on every frame. The column's own top depends on nothing but
       the page scroll. */
    if (r.top <= STICK_TOP) {
      panel.style.position = 'fixed';
      panel.style.top = STICK_TOP + 'px';
      panel.style.left = Math.round(r.left) + 'px';
      panel.style.width = Math.round(r.width) + 'px';
    } else if (panel.style.position) {
      panel.style.position = '';
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
    }
  }

  function queueStick() {
    if (stickRaf) return;
    stickRaf = requestAnimationFrame(positionPanel);
  }

  // Passive: this only reads geometry, so it must never hold up the page's own scrolling.
  window.addEventListener('scroll', queueStick, { passive: true });
  window.addEventListener('resize', queueStick, { passive: true });

  function ensureCompanion() {
    const term = searchTerm();
    const wanted = settings.showCompanion !== false && !!term;
    let panel = document.querySelector('.ytc-sc');
    if (!wanted) {
      if (panel) panel.remove();
      closeColumn();
      return;
    }

    const all = collectScrolled();
    if (!all.length) return;                // nothing read yet; try again next scan
    loadPageResults(term);
    /* Everything the page has, including results it lists but has not drawn. */
    const rows = mergePageResults(all) || all;
    const st = searchStats(rows, term);
    /* The score reads a fixed slice of the same rows, so it holds still while the statistics
       above it keep filling in. */
    const pinned = pinnedRows(rows, term);
    PANEL_ROWS.term = term;
    PANEL_ROWS.rows = pinned;
    const stScore = pinned.length === rows.length ? st : searchStats(pinned, term);

    /* Registering the term and asking for its series, once per keyword per page. The ids are
       the ones already on screen, so this costs nothing to gather — and pinning the set here
       rather than letting the server re-search is what stops ranking churn being read as a
       change in velocity. */
    if (SERIES.keyword !== term) {
      SERIES.keyword = term;
      SERIES.asked = false;
      SERIES.data = null;
    }
    if (!SERIES.asked && rows.length >= 5) {
      SERIES.asked = true;
      const ids = rows.map((r) => r.id).filter(Boolean).slice(0, 50);
      sendMessage({ type: 'ytc-keyword-seen', keyword: term, videos: ids }, () => {
        if (chrome.runtime.lastError || SERIES.keyword !== term) return;
        sendMessage({ type: 'ytc-keyword-series', keyword: term }, (res) => {
          if (chrome.runtime.lastError || SERIES.keyword !== term) return;
          SERIES.data = res || { ok: false };
          ensureCompanion();
        });
      });
    }
    const html = companionHtml(st, stScore);

    if (!panel) {
      panel = document.createElement('aside');
      panel.className = 'ytc-sc';
      /* Capture, because scroll does not bubble — but it is still dispatched down the
         ancestor chain in the capture phase, so one listener on the panel survives every
         repaint that replaces the body. Binding to the body itself would need re-binding on
         each render, which is the kind of thing that quietly stops happening. */
      let scrollIdle = 0;
      panel.addEventListener('scroll', (e) => {
        const box = e.target;
        if (!box.classList || !box.classList.contains('ytc-sc__body')) return;
        box.classList.add('is-scrolling');
        clearTimeout(scrollIdle);
        scrollIdle = setTimeout(() => box.classList.remove('is-scrolling'), 900);
      }, true);

      panel.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.ytc-sc__csort')) {
          CHAN_SORT.by = CHAN_SORT.by === 'views' ? 'results' : 'views';
          ensureCompanion();
          return;
        }
        if (e.target.closest && e.target.closest('.ytc-sc__capbtn')) {
          const term = searchTerm();
          if (term && PANEL_ROWS.term === term) runCaptionCheck(term, PANEL_ROWS.rows);
          return;
        }
        const sec = e.target.closest && e.target.closest('.ytc-sc__sechead');
        if (sec) {
          const box = sec.closest('.ytc-sc__sec');
          const key = box && box.dataset.sec;
          if (key) {
            if (SC_SHUT.has(key)) SC_SHUT.delete(key); else SC_SHUT.add(key);
            box.classList.toggle('shut', SC_SHUT.has(key));
          }
          return;
        }
        if (!e.target.closest('.ytc-sc__fold')) return;
        const folded = !panel.classList.contains('ytc-sc--folded');
        panel.classList.toggle('ytc-sc--folded', folded);
        scFold(folded);
        paintFold(panel);
        positionPanel();
      });
    }

    /* Checked by measurement, not by the selector matching: an element that is present but
       lays out to nothing would take the panel down with it, and the fallback exists so the
       feature degrades to awkward rather than to invisible. */
    const col = buildColumn();
    if (col) {
      if (panel.parentElement !== col) col.appendChild(panel);
      if (!col.offsetWidth) {           // the row did not take — go back to floating
        closeColumn();
        document.body.appendChild(panel);
      }
    } else if (panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
    panel.classList.toggle('ytc-sc--float', panel.parentElement === document.body);

    // Same guard the stats card uses: only touch the DOM when something actually changed.
    if (panel.dataset.sig !== html) {
      panel.dataset.sig = html;
      panel.innerHTML = html;
    }
    panel.classList.toggle('ytc-sc--folded', scFolded());
    paintFold(panel);
    positionPanel();
  }

  // The chevron points the way it will move: down to open, up to close.
  function paintFold(panel) {
    const btn = panel.querySelector('.ytc-sc__fold');
    if (!btn) return;
    const folded = panel.classList.contains('ytc-sc--folded');
    btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    btn.title = folded ? 'Expand' : 'Collapse';
  }

  function ensureFilterButton() {
    /* Search results and the feeds only. A channel page is already one channel's videos, so
       filtering by subscriber count there compares a channel against itself, and the Similar
       Channels tab answers the question that page actually raises. */
    const wanted = settings.showFilter !== false &&
      /^\/$|^\/results|^\/feed\//.test(location.pathname);
    const existing = document.querySelector('.ytc-fmbtn');
    if (!wanted) { if (existing) existing.remove(); return; }
    if (existing && tabIsVisible(existing)) return;
    if (existing) existing.remove();

    const build = () => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytc-fmbtn';
      let icon = '';
      try { icon = chrome.runtime.getURL('icons/icon32.png'); } catch (e) { icon = ''; }
      btn.innerHTML = (icon ? '<img src="' + icon + '" alt="">' : '') + '<span>Filter</span>';
      btn.title = 'Filter the videos this page has loaded';
      btn.addEventListener('click', openFilterModal);
      return btn;
    };

    for (const host of filterHosts()) {
      if (!tabIsVisible(host)) continue;
      const btn = build();
      // Ahead of the search box, which is the first thing in #center.
      host.insertBefore(btn, host.firstChild);
      if (tabIsVisible(btn)) return;
      btn.remove();
    }
    const floating = build();
    floating.classList.add('ytc-fmbtn--float');
    document.body.appendChild(floating);
  }

  function pageVideos() {
    scan();
    const videos = [];
    document.querySelectorAll('.ytc-card').forEach((card) => {
      if (card.offsetParent === null) return;
      const v = readCard(card);
      if (v) videos.push(v);
    });
    return videos;
  }

  /* When the popup asks, it copies the text itself: this page is unfocused while the
     popup is open, and navigator.clipboard rejects writes from an unfocused document. */
  function respondWith(videos, msg, sendResponse) {
    if (msg.returnText) {
      sendResponse({ count: videos.length, text: F.formatList(videos, settings) });
    } else {
      copyVideos(videos);
      sendResponse({ count: videos.length });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    switch (msg.type) {
      case 'ytc-ping':
        sendResponse({ ok: true, selectMode });
        break;
      case 'ytc-toggle-select':
        setSelectMode(!selectMode);
        sendResponse({ selectMode });
        break;
      case 'ytc-copy-selection':
        respondWith(Array.from(selected.values()), msg, sendResponse);
        break;
      case 'ytc-copy-page':
        respondWith(pageVideos(), msg, sendResponse);
        break;
      case 'ytc-toast':
        toast(msg.text, msg.isError);
        sendResponse({ ok: true });
        break;
    }
    return true;
  });


  /* ------------------------------------------------------- channel preview */

  /* What else does this channel make? — answered without leaving the page.

     The question comes up constantly while scanning a feed, and answering it costs a tab, a
     channel page load and the loss of your scroll position. This puts the channel's recent
     uploads under the cursor instead.

     Bound to the channel LINK, not to the card. Hovering a card is something you do by
     accident on the way somewhere else, and every accidental hover would be a request; moving
     onto the channel's name is a deliberate act that already means "tell me about this
     channel". It also keeps the popover away from the thumbnail, where YouTube runs its own
     hover-preview player.

     Nothing is drawn inside the card. The popover is a fixed-position element on <body>, so
     it sits outside every stacking context the card creates — which is the failure the Copy
     button hit when it was overlaid on thumbnails, where a raised z-index worked on the home
     grid and not on search results. */
  const PV_OPEN_MS = 350;      // hover intent: long enough that passing over is not a request
  const PV_CLOSE_MS = 220;     // grace to cross the gap from the link into the popover
  const PV_ROWS = 6;

  let pvEl = null;
  let pvOpenTimer = null;
  let pvCloseTimer = null;
  let pvKey = '';
  let pvAnchor = null;
  let pvTab = 'latest';
  let pvState = null;          // { loading } | { videos } | { error }
  /* Page-lifetime, on top of the service worker's own 30-minute cache. Re-hovering a channel
     you looked at a second ago must not go anywhere near the network — the worker dedupes,
     but a round trip through it still repaints the popover through a loading state.

     Capped, because this holds fifty videos per channel and a long session down an infinite
     feed passes over hundreds of them. Oldest out first: the channels worth keeping are the
     ones still on screen. */
  const PV_CACHE_MAX = 60;
  const pvCache = new Map();

  function pvRemember(key, state) {
    if (pvCache.size >= PV_CACHE_MAX) pvCache.delete(pvCache.keys().next().value);
    pvCache.set(key, state);
  }

  /* Two shapes of trigger, one answer: { el, key }.

     On the page the trigger is a real channel link inside a card, and the key comes out of
     its href. In the filter modal there is no link to hover — the whole row is one anchor
     pointing at the video, and a channel link nested inside it would be invalid markup and
     would fight the row's own click — so the channel name carries the key in a data
     attribute instead. Both end up here so the popover never learns there was a difference. */
  function pvTarget(el) {
    if (!el || !el.closest) return null;
    const named = el.closest('[data-chan]');
    if (named && named.dataset.chan) return { el: named, key: named.dataset.chan };
    const a = el.closest('a[href]');
    if (!a || !a.closest('.ytc-card')) return null;
    const href = a.getAttribute('href');
    if (!href || href[0] === '#') return null;
    let path;
    try { path = new URL(href, location.origin).pathname; } catch (e) { return null; }
    const key = keyFromPath(path);
    return key ? { el: a, key } : null;
  }

  function pvHost() {
    if (pvEl && pvEl.isConnected) return pvEl;
    pvEl = document.createElement('div');
    pvEl.className = 'ytc-pv';
    pvEl.setAttribute('role', 'dialog');
    pvEl.setAttribute('aria-label', 'Channel preview');
    document.body.appendChild(pvEl);
    return pvEl;
  }

  function pvClose() {
    clearTimeout(pvOpenTimer); pvOpenTimer = null;
    clearTimeout(pvCloseTimer); pvCloseTimer = null;
    if (pvEl) pvEl.remove();
    pvEl = null; pvKey = ''; pvAnchor = null; pvState = null;
  }

  function pvScheduleClose() {
    clearTimeout(pvCloseTimer);
    pvCloseTimer = setTimeout(pvClose, PV_CLOSE_MS);
  }

  function pvDuration(seconds) {
    return seconds ? F.stampMs(seconds * 1000) : '';
  }

  function pvRow(v) {
    const id = String(v.id || '');
    const dur = pvDuration(v.seconds);
    return '<a class="ytc-pv__row" href="https://www.youtube.com/watch?v=' +
        encodeURIComponent(id) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="ytc-pv__thumb">' +
        '<img src="https://i.ytimg.com/vi/' + encodeURIComponent(id) +
          '/mqdefault.jpg" alt="" loading="lazy">' +
        (dur ? '<span class="ytc-pv__dur">' + escapeHtml(dur) + '</span>' : '') +
      '</span>' +
      '<span class="ytc-pv__meta">' +
        '<span class="ytc-pv__title">' + escapeHtml(v.title || '') + '</span>' +
        '<span class="ytc-pv__sub">' +
          (v.views == null ? '—' : escapeHtml(F.compact(v.views)) + ' views') +
          ' · ' + escapeHtml(agoLabel(v.publishedAt)) +
        '</span>' +
      '</span>' +
    '</a>';
  }

  function pvRender() {
    const host = pvHost();
    const st = pvState || {};

    /* "Most viewed", not "Most popular". The window is whatever the uploads playlist
       returned — the fifty most recent — so this is the best of a channel's recent work, not
       its best ever. Naming it "popular" would claim the second while showing the first, and
       a channel whose breakout was two years ago would be misrepresented by its own preview.
       The tooltip carries the qualification; the label stays true without it. */
    const tabs = '<div class="ytc-pv__tabs">' +
      ['latest', 'viewed'].map((k) => {
        const label = k === 'latest' ? 'Latest' : 'Most viewed';
        const hint = k === 'latest' ? 'Newest uploads first'
          : 'The most viewed of the uploads loaded here — recent work, not all time';
        return '<button type="button" class="ytc-pv__tab' +
          (pvTab === k ? ' ytc-pv__tab--on' : '') + '" data-pvtab="' + k +
          '" title="' + escapeHtml(hint) + '">' + label + '</button>';
      }).join('') +
      '<span class="ytc-pv__who">' + escapeHtml(pvKey) + '</span>' +
    '</div>';

    let body;
    if (st.loading) {
      body = '<p class="ytc-pv__note"><span class="ytc-spin"></span> Loading uploads…</p>';
    } else if (st.error) {
      body = '<p class="ytc-pv__note" title="' + escapeHtml(st.detail || '') + '">' +
        escapeHtml(st.error) + '</p>';
    } else {
      const all = st.videos || [];
      const list = pvTab === 'viewed'
        ? all.slice().sort((a, b) => (b.views || 0) - (a.views || 0))
        : all;
      body = list.length
        ? list.slice(0, PV_ROWS).map(pvRow).join('')
        : '<p class="ytc-pv__note">No uploads found for this channel.</p>';
    }

    host.innerHTML = tabs + '<div class="ytc-pv__list">' + body + '</div>';
    host.querySelectorAll('[data-pvtab]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pvTab = b.dataset.pvtab;
        pvRender();
      });
    });
    pvPlace();
  }

  /* Below the link, flipped above when there is no room, clamped to the viewport.
     Measured after rendering rather than guessed: the popover's height depends on how many
     rows came back, and a guess puts a short list halfway up the screen. */
  function pvPlace() {
    if (!pvEl || !pvAnchor || !pvAnchor.isConnected) return;
    const r = pvAnchor.getBoundingClientRect();
    const w = pvEl.offsetWidth;
    const h = pvEl.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    pvEl.style.left = Math.round(left) + 'px';
    pvEl.style.top = Math.round(top) + 'px';
  }

  /* The filter modal replaces its whole result list on a timer, so the element the popover is
     pinned to stops existing while the reader is still reading it. Point at the equivalent
     node in the new list instead of closing: a popover that vanished every few seconds
     because something reloaded underneath it would be unusable exactly where it is most
     useful. Only when the channel is genuinely gone from the list does it close. */
  function pvReanchor() {
    if (!pvEl || !pvAnchor || pvAnchor.isConnected) return;
    let next = null;
    try {
      next = document.querySelector('.ytc-fm__results [data-chan="' + CSS.escape(pvKey) + '"]');
    } catch (e) { next = null; }
    if (next) { pvAnchor = next; pvPlace(); return; }
    pvClose();
  }

  function pvOpen(anchor, key) {
    pvAnchor = anchor;
    pvKey = key;
    pvTab = 'latest';

    const hit = pvCache.get(key);
    if (hit) { pvState = hit; pvRender(); return; }

    pvState = { loading: true };
    pvRender();
    sendMessage({ type: 'ytc-channel-videos', key }, (out) => {
      if (chrome.runtime.lastError) return;
      if (pvKey !== key) return;            // moved on before it landed
      let state;
      if (out && out.ok) {
        state = { videos: out.videos || [] };
      } else {
        /* Same split the velocity panel makes: one sentence on screen, the diagnosis on
           hover. Without an index there is no route to ask, and saying "no uploads found"
           would blame the channel for a missing endpoint. */
        const why = (out && out.reason) || '';
        state = {
          error: 'Could not load this channel’s uploads.',
          detail: /no index|not configured/i.test(why)
            ? 'No index is configured, so there is nowhere to ask for a channel’s uploads.'
            : why ? 'The index service answered: ' + why
                  : 'The index service did not answer.'
        };
      }
      // Only a real answer is worth keeping; a failure should be retried on the next hover.
      if (state.videos) pvRemember(key, state);
      pvState = state;
      pvRender();
    });
  }

  document.addEventListener('mouseover', (e) => {
    if (!settings.showPreview) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    if (pvEl && pvEl.contains(el)) { clearTimeout(pvCloseTimer); pvCloseTimer = null; return; }
    /* Its trigger was removed from the page and no mouseout will ever come from a node that
       no longer exists, so the popover would sit there until something else closed it. */
    if (pvEl && pvAnchor && !pvAnchor.isConnected) { pvClose(); return; }
    const hit = pvTarget(el);
    if (!hit) return;
    clearTimeout(pvCloseTimer); pvCloseTimer = null;
    // Already showing this channel: re-anchor to whatever is under the cursor, fetch nothing.
    if (pvKey === hit.key && pvEl) { pvAnchor = hit.el; return; }
    clearTimeout(pvOpenTimer);
    pvOpenTimer = setTimeout(() => pvOpen(hit.el, hit.key), PV_OPEN_MS);
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (!pvOpenTimer && !pvEl) return;
    const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    if (to && pvEl && pvEl.contains(to)) return;
    if (to && pvTarget(to)) return;
    clearTimeout(pvOpenTimer); pvOpenTimer = null;
    if (pvEl) pvScheduleClose();
  }, true);

  /* Scrolling moves the link out from under a popover pinned to the viewport, so the two
     part company. Close rather than chase it: this is a glance, not a panel.

     Except when the scroll came from inside the popover. A capture listener on window sees
     scrolls targeted at descendants too, and the list of uploads is itself scrollable — so
     without this guard, reaching for the fifth row dismissed the thing you were reading. */
  window.addEventListener('scroll', (e) => {
    if (!pvEl) return;
    const t = e.target;
    if (t instanceof Node && pvEl.contains(t)) return;
    pvClose();
  }, true);
  window.addEventListener('yt-navigate-finish', pvClose);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pvEl) pvClose(); });

  /* -------------------------------------------------------------- observers */

  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; scan(); }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* A single scan 300ms after navigation assumes everything has hydrated by then, which is
     the assumption that kept failing. Stagger several: they are cheap, they stop early via
     the per-card markers, and they cover the window where YouTube is still building the
     watch metadata, the sidebar and the channel header. */
  const NAV_SCANS = [300, 900, 2000, 4000, 8000];
  window.addEventListener('yt-navigate-finish', () => {
    for (const delay of NAV_SCANS) setTimeout(scan, delay);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectMode) setSelectMode(false);
  });

  /* Last, deliberately. Both of these read module state declared further up the file, and
     placing the call above those declarations does not merely delay them — it throws.
     loadPockets swallows its own failure and runs the callback regardless, so a temporal-dead-
     zone error on the storage key became an uncaught one in the callback, and that killed the
     whole content script at evaluation: no badges, no tabs, no buttons, nothing after the
     call site. Startup work goes here, next to the first scan, where everything exists. */
  loadPresets();
  loadPockets(() => refreshPocketMarks());

  scan();
})();
