/* YT Copy — injects per-video copy buttons and a multi-select bar into YouTube. */
(function () {
  'use strict';

  const F = window.YTCopyFormat;
  let settings = F.merge(null);
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
      card.querySelector('a#video-title-link');
    if (!el) return '';
    // The `title` attribute is the untruncated version when YouTube clamps the text.
    const attr = el.getAttribute('title') || (el.querySelector('[title]') || {}).title;
    return (attr && attr.trim()) || text(el);
  }

  function findUrl(card) {
    const a =
      card.querySelector('a#video-title, a#video-title-link, a#thumbnail[href]') ||
      card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (!a) return { url: '', id: '' };
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
  const DATE_RE = new RegExp(
    '^((streamed|premiered)\\s+)?\\d+\\s+(second|minute|hour|day|week|month|year)s?\\s+ago$' +
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

  function findMeta(card) {
    let views = '';
    let date = '';
    const seen = new Set();

    function scan(nodes) {
      for (const n of nodes) {
        const t = text(n);
        if (!t || t.length > 60 || seen.has(t)) continue;
        seen.add(t);
        if (!views && VIEWS_RE.test(t)) views = t;
        else if (!date && DATE_RE.test(t)) date = t;
        if (views && date) return true;
      }
      return false;
    }

    if (scan(card.querySelectorAll(KNOWN_META))) return { views, date };

    // Unknown build: check every leaf element in the card.
    scan(Array.from(card.querySelectorAll('span, div')).filter((el) => !el.children.length));
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

  /* The button must be a SIBLING of the thumbnail, not a child of it: YouTube's
     hover-preview player paints above anything inside ytd-thumbnail. */
  function findAnchorHost(card) {
    return card;
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
    btn.title = 'Copy this video (YT Copy)';
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

  function decorate(card) {
    if (card.dataset.ytcReady === '1' && card.querySelector(':scope > .ytc-btn')) return;
    const host = findAnchorHost(card);
    if (!host) return;
    card.dataset.ytcReady = '1';
    card.classList.add('ytc-card', 'ytc-host');
    host.appendChild(makeButton(card));
    host.appendChild(makeCheckbox(card));
    watchForSubs(card);
  }

  let lastCount = -1;
  function scan() {
    const cards = document.querySelectorAll(CARD_SELECTOR);
    let n = 0;
    for (const card of cards) {
      if (!isOutermost(card)) continue;
      decorate(card);
      resyncCard(card);
      n++;
    }
    if (n !== lastCount) {
      lastCount = n;
      console.debug('[YT Copy] %d video card(s) ready — hover a thumbnail for the Copy button', n);
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
  const DETECT_DELAYS = [400, 1200, 3000];  // waiting for YouTube to hydrate the card

  const subsByKey = new Map();      // channel key -> { text, reason, t, tries }
  const cardsByKey = new Map();     // channel key -> Set of cards awaiting a badge
  const requested = new Set();

  function badgeOf(card) {
    return card.querySelector('.ytc-subs');
  }

  /* Badges live with the text, under the views/date line — no measuring, no overlap with
     YouTube's own thumbnail overlays, and readable on every layout. */
  function attachBadge(card, badge) {
    const rows = card.querySelectorAll('#metadata-line, [class*="metadata-row"]');
    const anchor = rows.length ? rows[rows.length - 1]
      : card.querySelector('#video-title, h3');
    if (anchor && anchor.parentElement) {
      if (badge.previousElementSibling !== anchor || badge.parentElement !== anchor.parentElement) {
        anchor.parentElement.insertBefore(badge, anchor.nextSibling);
      }
      markFlow(badge);
      return;
    }
    if (badge.parentElement !== card) card.appendChild(badge);
    markFlow(badge);
  }

  /* Search results lay their metadata out as a row flex, so the badge lands beside the
     views/date text and needs a left gap and vertical centring. Grid cards stack in a
     column, where the badge gets its own line and neither applies. */
  function markFlow(badge) {
    const parent = badge.parentElement;
    if (!parent || typeof getComputedStyle !== 'function') return;
    const style = getComputedStyle(parent);
    const inRow = /flex|box/.test(style.display || '') &&
      !/column/.test(style.flexDirection || '');
    badge.classList.toggle('ytc-subs--inline', inRow);
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

  /* Green = the video outperformed the channel, red = it underperformed. The scale runs
     good → bad, so a 224× breakout reads as a win at a glance. */
  function ratioClass(r) {
    if (r >= 10) return 'ytc-ratio--great';   // breakout
    if (r >= 3) return 'ytc-ratio--good';     // strong
    if (r >= 1) return 'ytc-ratio--ok';       // beat the sub count
    if (r >= 0.5) return 'ytc-ratio--low';    // soft
    return 'ytc-ratio--poor';                 // flopped
  }

  function ratioTitle(r) {
    const label = r >= 10 ? 'breakout' : r >= 3 ? 'strong' : r >= 1 ? 'above subscriber count'
      : r >= 0.5 ? 'below subscriber count' : 'well below subscriber count';
    return 'views ÷ subscribers — ' + label;
  }

  /* No channel to look up: still show something, so a blank corner never looks like a bug. */
  function renderEmpty(card, why) {
    const badge = makeBadge(card);
    badge.dataset.key = '';
    badge.classList.remove('ytc-subs--loading', 'ytc-subs--failed');
    badge.classList.add('ytc-subs--none');
    badge.title = why;
    badge.innerHTML = '<span class="ytc-subs__n">— subs</span>';
  }

  function renderLoading(card, retrying) {
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
  function renderBadge(card, entry) {
    if (!entry) return;
    const badge = makeBadge(card);
    badge.dataset.key = findChannelKey(card);
    badge.classList.remove('ytc-subs--loading');

    if (!entry.text) {
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
      const parts = ['<span class="ytc-subs__n">' + (F.compact(subsN) || '—') + ' subs</span>'];
      const viewsN = F.viewsToNumber(findMeta(card).views);
      if (settings.showRatio && subsN > 0 && viewsN != null) {
        const shown = ratioLabel(viewsN / subsN);
        parts.push('<span class="ytc-ratio ' + ratioClass(shown.value) + '" title="' +
          ratioTitle(shown.value) + '">' + shown.text + '</span>');
      }
      badge.innerHTML = parts.join('');
    }

  }

  function askFor(key, force, tries) {
    chrome.runtime.sendMessage({ type: 'ytc-subs', key, force }, (res) => {
      if (chrome.runtime.lastError) { requested.delete(key); return; }
      const entry = {
        text: (res && res.text) || null,
        reason: (res && res.reason) || '',
        t: Date.now(),
        tries: tries || 0
      };
      console.debug('[YT Copy] subs %s -> %s', key, entry.text || 'not found (' + entry.reason + ')');
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

  function wantSubs(card) {
    if (!settings.showSubs) return;
    if (isAd(card)) return;
    // Playables, playlists and shelf tiles aren't videos and have no channel to look up.
    if (!findUrl(card).id) return;

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

  window.addEventListener('yt-navigate-finish', () => setTimeout(scan, 300));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectMode) setSelectMode(false);
  });

  scan();
})();
