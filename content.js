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
    ensureSimilarTab();
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
    if (avgViews) {
      const label = r >= 10 ? 'breakout' : r >= 3 ? 'strong' : r >= 1 ? 'above channel average'
        : r >= 0.5 ? 'below channel average' : 'well below channel average';
      return 'views ÷ channel average (' + (F.compact(avgViews) || avgViews) + ') — ' + label;
    }
    const label = r >= 10 ? 'breakout' : r >= 3 ? 'strong' : r >= 1 ? 'above subscriber count'
      : r >= 0.5 ? 'below subscriber count' : 'well below subscriber count';
    return 'views ÷ subscribers (channel average unavailable) — ' + label;
  }

  /* ------------------------------------------------------------- video metrics */

  /* A card in the watch sidebar rather than pills in the button row: these are five numbers
     that want labels, and the row has no space for labelled values.

     The sidebar is built by the SPA after navigation, so the mount point is resolved from a
     fallback chain and re-checked on every scan — the same lesson as the channel header,
     which stopped appearing because it latched onto a "handled" flag instead of verifying
     the element was still there. */
  const SIDEBAR_HOSTS = ['#secondary-inner', '#secondary', 'ytd-watch-flexy #secondary'];

  const cardState = { videoId: '', metrics: null, outlier: null };

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

    const rows =
      '<div class="ytc-cs__row">' +
        cell('Outlier', ol == null ? dash : (ol >= 10 ? Math.round(ol) : Number(ol.toFixed(1))) + '×',
          ol == null ? 'Waiting for the channel average'
            : 'Views against this channel\'s lifetime average views per video') +
        cell('VPH', m ? F.formatVph(m.vph) : dash,
          !m ? 'Reading video data' : m.vph == null ? 'Publish date unavailable'
            : Math.round(m.vph).toLocaleString() + ' views/hour averaged since publishing — a lifetime rate, not current velocity') +
        cell('Engagement', m && m.engagement != null ? m.engagement.toFixed(1) + '%' : dash,
          !m ? 'Reading video data' : m.engagement == null ? 'Likes hidden on this video'
            : (m.likes || 0).toLocaleString() + ' likes on ' + m.views.toLocaleString() + ' views. Comments are not counted') +
      '</div>' +
      '<div class="ytc-cs__row">' +
        cell('RPM (assumed)', !m ? dash : m.rpm == null ? 'n/a' : '$' + (Math.round(m.rpm * 100) / 100),
          !m ? 'Reading video data'
            : m.rpm == null
              ? 'Shorts are paid from a separate ad-share pool, not a long-form RPM'
              : 'Assumed rate for a video ' + m.length.label + '. Base band $' + F.RPM_LOW +
                '-$' + F.RPM_HIGH + ', scaled for length. Real RPM is private to the channel' +
                (m.category ? '. Category: ' + m.category : '')) +
        cell('Est. earnings',
          !m ? dash : m.earnings == null ? dash : F.formatMoney(m.earnings.mid),
          !m ? 'Reading video data'
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
    cardState.outlier = null;          // both belong to the previous video
    cardState.metrics = null;
  }

  function renderMetrics(card, stats, videoId) {
    trackCardVideo(videoId);
    const m = F.videoMetrics(stats, Date.now());
    // Only overwrite on success: a read that came back empty should leave a card that is
    // already showing this video's numbers alone rather than removing it.
    if (m) cardState.metrics = m;
    renderStatsCard();
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

  const simFilter = { smallOnly: false, sort: 'similarity', desc: true, open: false, chip: 'all' };

  /* Below this, the list is treated as a failure: the note says so, and the extension goes
     looking for more channels in the niche.

     0.65 rather than 0.55, which was set before there was anything to calibrate against.
     Measured on a filled index, a niche that is genuinely covered lands well above it —
     aviation 0.91, tech 0.81, MMA 0.77, horror 0.73, YouTube-growth 0.69 — while a niche
     with nothing in it sits below: aviation before it was walked returned true-crime
     channels at 0.59, and the old threshold called that a good answer and stayed quiet. */
  const WEAK_BELOW = 0.65;

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
    { key: 'new', label: 'New channels',
      test: (c) => (daysSince(c.publishedAt) || 1e9) <= 180 },
    { key: 'active', label: 'Active this month',
      test: (c) => (daysSince(c.lastUpload) === null ? 1e9 : daysSince(c.lastUpload)) <= 31 }
  ];

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
      cell: (c) => Math.round((c.similarity || 0) * 100) + '%' },
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
    const list = fromIndex ? all.filter(chip.test) : all;

    const count = !all.length ? '' :
      ' <span class="ytc-t__count">(' + list.length +
      (list.length === all.length ? '' : ' of ' + all.length) + ')</span>';

    const chips = !fromIndex ? '' :
      '<div class="ytc-chips">' + SIM_CHIPS.map((x) => {
        // A chip that would empty the table is still shown, but says so rather than lying.
        const n = all.filter(x.test).length;
        return '<button type="button" class="ytc-chip' +
          (x.key === chip.key ? ' ytc-chip--on' : '') + (n ? '' : ' ytc-chip--empty') +
          '" data-chip="' + x.key + '">' + escapeHtml(x.label) +
          (x.key === 'all' ? '' : ' <span class="ytc-chip__n">' + n + '</span>') +
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
      host.innerHTML = controls + '<p class="ytc-t__note">No channels here match \u201c' +
        escapeHtml(chip.label) + '\u201d. ' + all.length + ' found in total.</p>';
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

      const rows = sorted.map((c) => {
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
              '</span>' +
              '<span class="ytc-t__handle">' + escapeHtml(handle) + '</span>' +
            '</span>' +
          '</span>' +
          SIM_COLS.map((c2) =>
            '<span class="ytc-t__c' + (c2.cls ? ' ' + c2.cls : '') + '">' +
            c2.cell(c) + '</span>').join('') +
        '</a>';
      }).join('');
      body = '<div class="ytc-t">' + head + rows + '</div>';
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

    let note;
    if (fromIndex) {
      note = 'Ranked by topic similarity against the channel index' +
        (res.indexed ? '' : ' \u2014 this channel is not indexed yet, so its own page text was used');
      const best = list.reduce((m, c) => Math.max(m, c.similarity || 0), 0);
      if (best < WEAK_BELOW) {
        note = '<b>Weak matches (best ' + Math.round(best * 100) + '%).</b> ' +
          'This niche is thinly indexed \u2014 the closest channels found are only loosely ' +
          'related. ' + note;
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

    host.innerHTML = controls + body + '<p class="ytc-t__note">' + note + '</p>';
    wireSimilarControls(host, res);
    maybeExpandNiche(res);
    /* Re-rendering (a chip, a sort) drops the old placeholders, so anything still queued
       against them is stale. */
    moneyQueue = [];
    hydrateRowMoney(host);
  }

  function wireSimilarControls(host, res) {
    const small = host.querySelector('.ytc-t__small');
    if (small) {
      small.addEventListener('click', () => {
        simFilter.smallOnly = !simFilter.smallOnly;
        askSimilar(true);
      });
    }
    const refresh = host.querySelector('.ytc-t__refresh');
    if (refresh) refresh.addEventListener('click', () => askSimilar(true));

    // Chips re-filter what is already here, so they redraw rather than refetch.
    host.querySelectorAll('.ytc-chip').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        simFilter.chip = b.dataset.chip;
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


  function pageContent() {
    return document.querySelector(
      'ytd-browse[page-subtype="channels"] #contents, ' +
      'ytd-browse[page-subtype="channels"] ytd-section-list-renderer, ' +
      'ytd-two-column-browse-results-renderer');
  }

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

  function buildSimilarTab() {
    const tab = document.createElement('div');
    tab.className = 'ytc-tab';
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
      '<span>' + TAB_LABEL + '</span>';
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSimilarView();
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

  function noteChannelSeen(handle, id) {
    // Switching the feature off has to stop the reporting, not just hide the tab. Anything
    // else makes the toggle a lie: the user believes it is off while their browsing still
    // leaves the machine.
    if (!settings.showSimilar) return;
    /* A watch page's URL names the video, never the channel, so channelKeyFromLocation finds
       nothing there and watching a video used to index nothing at all. The player knows whose
       video it is, so on a watch page that answer is passed in. */
    const key = handle || channelKeyFromLocation();
    if (!key || !key.startsWith('@') || seenChannels.has(key)) return;
    seenChannels.add(key);
    let channelId = id || '';
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

      const existing = document.querySelector('.ytc-tab');
      if (existing && tabIsVisible(existing)) return;
      if (existing) existing.remove();   // in a container that never rendered: try again

      for (const bar of tabBarCandidates()) {
        if (!tabIsVisible(bar)) continue;
        const tab = buildSimilarTab();
        placeSimilarTab(tab, bar);
        if (!tabIsVisible(tab)) { tab.remove(); continue; }

        /* YouTube's own tabs do not know about this one, so clicking any of them has to put
           the page back. Without this the channel's real content stays hidden behind our
           view. Attached once, alongside the tab it belongs to. */
        if (!bar.dataset.ytcClose) {
          bar.dataset.ytcClose = '1';
          bar.addEventListener('click', (ev) => {
            if (ev.target.closest('.ytc-tab')) return;
            closeSimilarView();
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
    let host = document.querySelector('.ytc-simview');
    if (host) return host;
    const content = pageContent();
    if (!content || !content.parentElement) return null;
    host = document.createElement('div');
    host.className = 'ytc-simview';
    content.parentElement.insertBefore(host, content);
    return host;
  }

  function openSimilarView() {
    simFilter.open = true;
    const content = pageContent();
    if (content) content.style.display = 'none';
    document.querySelectorAll('.ytc-tab').forEach((t) => t.classList.add('ytc-tab--on'));
    const host = similarHost();
    if (host) {
      host.style.display = '';
      if (!host.dataset.loaded) {
        host.innerHTML = similarSkeleton();
      }
    }
    askSimilar(false);
  }

  function closeSimilarView() {
    simFilter.open = false;
    const content = pageContent();
    if (content) content.style.display = '';
    document.querySelectorAll('.ytc-tab').forEach((t) => t.classList.remove('ytc-tab--on'));
    const host = document.querySelector('.ytc-simview');
    if (host) host.style.display = 'none';
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function askSimilar(force) {
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
    sendMessage({ type: 'ytc-similar', key, titles, about, force, opts }, (res) => {
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
    document.querySelectorAll('.ytc-rev').forEach((n) => n.remove());
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
    const r = anchorEl.getBoundingClientRect();
    // Kept inside the viewport: the badge sits near the right edge on a channel header.
    const left = Math.min(r.left, window.innerWidth - panel.offsetWidth - 12);
    panel.style.top = (r.bottom + window.scrollY + 8) + 'px';
    panel.style.left = (Math.max(12, left) + window.scrollX) + 'px';

    /* Moving the pointer from the pill to the panel crosses a gap, so leaving either one
       only schedules the close; entering the other cancels it. Without that the panel shuts
       on the way to it and can never be read. */
    panel.addEventListener('mouseenter', holdRevenuePanel);
    panel.addEventListener('mouseleave', scheduleRevenueClose);
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
      if (tries >= WATCH_MAX_TRIES) { card.removeAttribute('data-ytc-money-pending'); return; }
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

  function decorateChannelHeader() {
    const key = channelKeyFromLocation();
    const stray = document.querySelector('.ytc-money--lg');

    // Left a channel page (or the badge was switched off): clean up after ourselves.
    decorateChannelOutlier(key);

    if (!key) {
      if (stray) stray.remove();
      // Restore YouTube's own content before dropping our view, or it stays display:none.
      closeSimilarView();
      document.querySelectorAll('.ytc-sim, .ytc-simview').forEach((n) => n.remove());
      return;
    }
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
      if (settings.showRatio && denom > 0 && viewsN != null) {
        const shown = ratioLabel(viewsN / denom);
        parts.push('<span class="ytc-ratio ' + ratioClass(shown.value) + '" title="' +
          ratioTitle(shown.value, avgViews) + '">' + shown.text + '</span>');
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
          const vph = F.vphFromRelative(meta.views, meta.date, Date.now());
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
      if (watchKey && !(cached && cached.stats) && !statsRequested.has(watchKey)) {
        statsRequested.add(watchKey);
        sendMessage({ type: 'ytc-subs', key: watchKey }, (res) => {
          statsRequested.delete(watchKey);
          if (chrome.runtime.lastError) return;
          const stats = (res && res.stats) || null;
          // Keep the DOM's count — it is the one we trust for this channel — and take only
          // the totals from the lookup.
          subsByKey.set(watchKey, {
            text: (res && res.text) || shownText,
            reason: (res && res.reason) || '',
            stats,
            t: Date.now(),
            tries: 0
          });
          if (stats && card.isConnected) {
            renderBadge(card, { text: shownText, reason: '', stats, t: Date.now() });
          }
        });
      }
      return;
    }

    const key = findChannelKey(card);
    if (!key) {
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
    if (area !== 'sync') return;
    const patch = {};
    for (const k in changes) patch[k] = changes[k].newValue;
    settings = F.merge(Object.assign({}, settings, patch));
    applySettings();
  });

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

  scan();
})();
