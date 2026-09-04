/* Shared settings + formatting engine (used by content script and popup). */
(function (root) {
  'use strict';

  const DEFAULTS = {
    fields: { title: true, views: true, date: true, channel: false, url: false },
    layout: 'plain',              // plain | bullet | numbered | markdown | csv | json | custom
    separator: ' — ',
    customTemplate: '{title} | {views} | {date}',
    csvHeader: true,
    numericViews: false,          // 271K -> 271000
    absoluteDate: false,          // "23 hours ago" -> 2026-08-22
    showButtons: true,
    quoteTitle: false,
    toast: true,
    showSubs: true,               // subscriber badge on each card
    showRatio: true,              // views ÷ channel average pill
    showMoney: true,              // monetization badge (inferred from ad placements)
    showStats: true,              // views/hour, engagement and an earnings estimate
    showSimilar: true,            // "Similar channels" button on channel pages
    /* Shorts have no sidebar and no description, so the figures every other page shows have
       nowhere to go. This puts them in the empty gutter beside the player. */
    showShorts: true,             // stats panel beside the Shorts player
    /* Hovering a card's channel link lists that channel's recent uploads. Costs a
       request per channel, so it is gated behind hover intent rather than proximity. */
    showPreview: true,            // channel preview popover on hover
    /* Pockets: named lists of channels, kept in the browser. The button is injected
       into YouTube's own header, so it has to be switchable off like every other one. */
    showPockets: true,            // "Pocket" save button and the Pockets tab
    showFilter: true,             // "Filter" button over search results, home and channel grids
    showCompanion: true,          // search-term panel beside search results
    showThumb: true,              // thumbnail download button
    /* Reads YouTube's own transcript panel in the page — no helper, no server, nothing to
       block. The InnerTube and yt-dlp routes it replaced are dead; see transcriptViaPanel. */
    showTranscript: true,         // transcript button on watch pages
    transcriptTimestamps: false,  // prefix each line with its timestamp
    transcriptSave: false         // save as .txt instead of copying
  };

  const SEPARATORS = [
    { value: ' — ', label: 'Em dash  ( — )' },
    { value: ' | ', label: 'Pipe  ( | )' },
    { value: ' · ', label: 'Middle dot  ( · )' },
    { value: ', ', label: 'Comma  ( , )' },
    { value: ' - ', label: 'Hyphen  ( - )' },
    { value: '\t', label: 'Tab  (spreadsheet)' },
    { value: '\n', label: 'New line' }
  ];

  const LAYOUTS = [
    { value: 'plain', label: 'Plain lines' },
    { value: 'bullet', label: 'Bulleted list' },
    { value: 'numbered', label: 'Numbered list' },
    { value: 'markdown', label: 'Markdown' },
    { value: 'csv', label: 'CSV / spreadsheet' },
    { value: 'json', label: 'JSON' },
    { value: 'custom', label: 'Custom template' }
  ];

  const FIELD_ORDER = ['title', 'views', 'date', 'channel', 'url'];
  const FIELD_LABELS = {
    title: 'Title',
    views: 'View count',
    date: 'Time posted',
    channel: 'Channel',
    url: 'Video URL'
  };

  function merge(saved) {
    const s = Object.assign({}, DEFAULTS, saved || {});
    s.fields = Object.assign({}, DEFAULTS.fields, (saved && saved.fields) || {});
    return s;
  }

  /* "1.2M views" -> 1200000 ; "1,234 views" -> 1234 ; "No views" -> 0 */
  function viewsToNumber(text) {
    if (!text) return null;
    const m = String(text).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return /no views/i.test(text) ? 0 : null;
    const n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(n * mult);
  }

  /* ------------------------------------------------------------ transcript parsing */

  function stampMs(ms) {
    const total = Math.floor((ms || 0) / 1000);
    const s = String(total % 60).padStart(2, '0');
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }

  /* timedtext XML is double-encoded — an apostrophe arrives as "&amp;#39;" — so decode
     until it stops changing. */
  function decodeEntities(text) {
    const once = (t) => t
      .replace(/&#(\d+);/g, (all, code) => String.fromCharCode(code))
      .replace(/&#x([\da-f]+);/gi, (all, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    let out = String(text);
    for (let i = 0; i < 3; i++) {
      const next = once(out);
      if (next === out) break;
      out = next;
    }
    return out;
  }

  function parseJson3(body) {
    let data;
    try { data = JSON.parse(body); } catch (e) { return []; }
    return (data.events || [])
      .map((ev) => ({
        time: stampMs(ev.tStartMs),
        text: (ev.segs || []).map((sg) => sg.utf8 || '').join('').replace(/\s+/g, ' ').trim()
      }))
      .filter((seg) => seg.text);
  }

  function parseTimedTextXml(body) {
    const out = [];
    const re = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(body))) {
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (text) out.push({ time: stampMs(parseFloat(m[1]) * 1000), text });
    }
    return out;
  }

  function jsonValue(html, key) {
    const m = html.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"'));
    if (!m) return '';
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }

  /* API key, client version and the transcript params, all of which the watch page carries. */
  function innertubeConfig(html) {
    const paramsMatch = html.match(/"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/);
    let params = '';
    if (paramsMatch) {
      try { params = JSON.parse('"' + paramsMatch[1] + '"'); } catch (e) { params = paramsMatch[1]; }
    }
    return {
      key: jsonValue(html, 'INNERTUBE_API_KEY'),
      version: jsonValue(html, 'INNERTUBE_CLIENT_VERSION') ||
        jsonValue(html, 'INNERTUBE_CONTEXT_CLIENT_VERSION') || '2.20240101.00.00',
      params
    };
  }

  /* The documented path, via the whole player response. Falls back to scanning for the
     captionTracks array when the object can't be isolated. */
  function playerResponseFrom(html) {
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*(?:var|const|let)\s|\s*<\/script>)/s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function captionTracksFrom(html) {
    const player = playerResponseFrom(html);
    const listed = player && player.captions &&
      player.captions.playerCaptionsTracklistRenderer &&
      player.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (listed && listed.length) return listed;

    const at = html.indexOf('"captionTracks":');
    if (at < 0) return [];
    const start = html.indexOf('[', at);
    let depth = 0;
    let end = start;
    for (; end < html.length; end++) {
      const c = html[end];
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end++; break; }
    }
    try {
      return JSON.parse(html.slice(start, end));
    } catch (e) {
      // A bracket inside a track name breaks the match; fall back to the URL itself.
      const m = html.slice(at).match(/"baseUrl":"(https:[^"]+timedtext[^"]*)"/);
      return m ? [{ baseUrl: JSON.parse('"' + m[1] + '"') }] : [];
    }
  }

  /* Prefer human-written captions over auto-generated, English over whatever is first. */
  function pickCaptionTrack(tracks) {
    const score = (t) => {
      const lang = (t.languageCode || '').toLowerCase();
      return (t.kind === 'asr' ? 0 : 2) + (lang.startsWith('en') ? 1 : 0);
    };
    return (tracks || []).slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  /* Walk for segments rather than following a fixed path — the nesting around them is
     seven levels deep and changes between builds. */
  function transcriptSegmentsFrom(node, out) {
    out = out || [];
    if (!node || typeof node !== 'object') return out;
    const seg = node.transcriptSegmentRenderer;
    if (seg) {
      const runs = (seg.snippet && seg.snippet.runs) || [];
      const text = runs.map((r) => r.text || '').join('').replace(/\s+/g, ' ').trim();
      if (text) out.push({ time: stampMs(Number(seg.startMs) || 0), text });
    }
    for (const key of Object.keys(node)) transcriptSegmentsFrom(node[key], out);
    return out;
  }

  /* One orchestration, run from either context by passing in that context's fetch.
     A page-context request carries youtube.com as its origin and behaves like the site's
     own; an extension service worker sends chrome-extension:// and gets 403s. */

  async function tryInnertube(doFetch, id, cfg, auth, label, notes) {
    if (!cfg.key || !cfg.params) return null;
    const body = JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: cfg.version || '2.20240101.00.00',
          hl: 'en',
          gl: cfg.gl || 'US',
          visitorData: cfg.visitorData || undefined,
          originalUrl: 'https://www.youtube.com/watch?v=' + id
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true }
      },
      params: cfg.params
    });

    const base = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': cfg.version || '2.20240101.00.00'
    };
    if (cfg.visitorData) base['X-Goog-Visitor-Id'] = cfg.visitorData;

    const attempts = [{ tag: 'session', credentials: 'include', headers: base }];
    if (auth) {
      attempts.push({
        tag: 'signed',
        credentials: 'include',
        headers: Object.assign({}, base, { Authorization: auth, 'X-Origin': 'https://www.youtube.com' })
      });
    }
    attempts.push({ tag: 'anon', credentials: 'omit', headers: base });

    for (const attempt of attempts) {
      try {
        const res = await doFetch(
          'https://www.youtube.com/youtubei/v1/get_transcript?key=' + encodeURIComponent(cfg.key) +
          '&prettyPrint=false',
          { method: 'POST', credentials: attempt.credentials, headers: attempt.headers, body }
        );
        if (!res.ok) { notes.push('api ' + res.status + ' [' + label + '/' + attempt.tag + ']'); continue; }
        const segments = transcriptSegmentsFrom(await res.json());
        if (segments.length) return segments;
        notes.push('api empty [' + label + '/' + attempt.tag + ']');
      } catch (e) {
        notes.push('api ' + e.message + ' [' + label + ']');
      }
    }
    return null;
  }

  async function tryCaptionTracks(doFetch, tracks, label, notes) {
    const track = pickCaptionTrack(tracks);
    if (!track || !track.baseUrl) return null;
    for (const attempt of [
      { fmt: '&fmt=json3', credentials: 'include' },
      { fmt: '&fmt=json3', credentials: 'omit' },
      { fmt: '', credentials: 'include' }
    ]) {
      try {
        const res = await doFetch(track.baseUrl + attempt.fmt, { credentials: attempt.credentials });
        if (!res.ok) { notes.push('timedtext ' + res.status + ' [' + label + ']'); continue; }
        const body = await res.text();
        const segments = attempt.fmt ? parseJson3(body) : parseTimedTextXml(body);
        if (segments.length) return segments;
        notes.push('timedtext empty ' + body.length + 'b [' + label + ']');
      } catch (e) {
        notes.push('timedtext ' + e.message + ' [' + label + ']');
      }
    }
    return null;
  }

  async function loadTranscript(id, doFetch, opts) {
    const extras = opts || {};
    const notes = [];
    if (!id) return { ok: false, reason: 'no video id' };

    /* The live page first. Its InnerTube params belong to this session and this video;
       params scraped from a re-fetched copy of the page get rejected with a 400, and its
       caption URLs are the ones the player itself is entitled to use. */
    const page = extras.page;
    if (page) {
      const live = await tryInnertube(doFetch, id, {
        key: page.apiKey, version: page.clientVersion, visitorData: page.visitorData, params: page.params
      }, extras.auth, 'live', notes);
      if (live) return { ok: true, segments: live };

      const tracks = await tryCaptionTracks(doFetch, page.captionTracks || [], 'live', notes);
      if (tracks) return { ok: true, segments: tracks };
    }

    let html = '';
    for (const credentials of ['include', 'omit']) {
      try {
        const res = await doFetch('https://www.youtube.com/watch?v=' + id + '&hl=en', { credentials });
        if (!res.ok) { notes.push('watch page ' + res.status); continue; }
        html = await res.text();
        if (html.indexOf('"getTranscriptEndpoint"') >= 0 || html.indexOf('"captionTracks":') >= 0) break;
      } catch (e) {
        notes.push('watch page ' + e.message);
      }
    }
    if (!html) return { ok: false, reason: notes.join('; ') || 'could not load the video page' };

    const cfg = innertubeConfig(html);
    const fetched = await tryInnertube(doFetch, id, {
      key: cfg.key, version: cfg.version, params: cfg.params,
      visitorData: jsonValue(html, 'VISITOR_DATA'), gl: jsonValue(html, 'GL')
    }, extras.auth, 'fetched', notes);
    if (fetched) return { ok: true, segments: fetched };

    const tracks = await tryCaptionTracks(doFetch, captionTracksFrom(html), 'fetched', notes);
    if (tracks) return { ok: true, segments: tracks };

    return { ok: false, reason: notes.join('; ') };
  }

  /* Transcript segments -> text. Timestamps are optional because the usual reason to grab a
     transcript is to paste it somewhere that only wants the words. */
  function formatTranscript(segments, opts) {
    const s = opts || {};
    const lines = (segments || [])
      .map((seg) => {
        const body = String(seg.text || '').replace(/\s+/g, ' ').trim();
        if (!body) return '';
        return s.timestamps && seg.time ? seg.time + '  ' + body : body;
      })
      .filter(Boolean);

    const header = s.title
      ? s.title + (s.url ? '\n' + s.url : '') + '\n\n'
      : '';
    return header + lines.join('\n');
  }

  /* A filename that every OS will accept, without losing the title. */
  function safeFilename(title, id, ext) {
    const base = String(title || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')   // illegal on Windows or in paths
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110)
      .replace(/[. ]+$/, '');                        // trailing dots/spaces break Windows
    const stem = base ? base + ' [' + id + ']' : id;
    return stem + '.' + ext;
  }

  /* 183000 -> "183K" (YouTube-style compact form) */
  function compact(n) {
    if (n == null || isNaN(n)) return '';
    const abs = Math.abs(n);
    const unit = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([min]) => abs >= min);
    if (!unit) return String(n);
    const v = n / unit[0];
    return (v >= 100 ? Math.round(v) : parseFloat(v.toFixed(1))) + unit[1];
  }

  /* Two different questions.

     isTransientFailure, isRetryableFailure, headerIndex, parseAnchored, identityToken,
    safeFilename, formatTranscript, stampMs, decodeEntities, parseJson3, parseTimedTextXml,
    innertubeConfig, captionTracksFrom, pickCaptionTrack, transcriptSegmentsFrom, loadTranscript,
    playerResponseFrom: how long to cache a failure. Throttled/blocked/truncated recovers
     quickly; anything else waits longer.

     isRetryableFailure: whether asking again could plausibly change the answer. Only a hard
     404 on every attempt is truly settled — "no count found" is regularly a consent page, a
     truncated response, or a throttled one dressed up as a normal reply, and those do come
     good on a second ask. Being strict here is what made auto-retry look dead while a manual
     click on the same badge worked. */
  function isTransientFailure(reason) {
    // "rate limited" is our own backoff, not an answer about the channel — always retry it.
    return /HTTP (429|5\d\d)|fetch failed|no count in|rate limited/i.test(reason || '');
  }

  function isRetryableFailure(reason) {
    const r = String(reason || '');
    if (!r) return true;
    const parts = r.split('|');
    return !parts.every((p) => /HTTP 404/i.test(p));
  }

  /* Pull "183K subscribers" out of a channel page's HTML. YouTube ships this in several
     shapes depending on build and surface, so try the structured ones before the loose one. */
  function normalizeSubs(text) {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/(\d[\d.,]*)\s*(thousand|million|billion)/i,
        (all, n, word) => n + { thousand: 'K', million: 'M', billion: 'B' }[word.toLowerCase()])
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* The channel's own count lives in its page header — but a channel page contains several
     header-shaped blocks (featured channels, collab lockups, shelves), and picking by
     position alone keeps landing on a stranger's number. So verify identity: the count is
     only accepted if the handle or id we actually asked for appears alongside it. */
  /* Sources, not RegExp objects: every scan builds its own instance. Sharing a /g regex
     across nested loops means one loop resetting lastIndex spins the other forever. */
  const ANCHOR_SOURCES = [
    '"aboutChannelViewModel"',
    '"c4TabbedHeaderRenderer"',
    '"pageHeaderViewModel"',
    '"channelHeaderViewModel"'
  ];

  function anchorRegex(source) {
    return new RegExp(source, 'g');
  }
  const HEADER_WINDOW = 40000;

  const SUB_PATTERNS = [
    /"subscriberCountText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/,
    /"subscriberCountText"\s*:\s*\{[^{}]*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/,
    /"subscriberCountText"\s*:\s*"([^"]*subscribers?[^"]*)"/i,
    /"subscriberCountText"[\s\S]{0,300}?"(?:label|content|simpleText|text)"\s*:\s*"([^"]*subscribers?[^"]*)"/i,
    /"content"\s*:\s*"((?:[\d.,]+\s*[KMB]?|No)\s+subscribers?)"/i,
    /"(?:label|title)"\s*:\s*"([\d.,]+\s*(?:[KMB]|thousand|million|billion)?\s*subscribers?)"/i
  ];

  const LOOSE_PATTERN = /((?:[\d.,]+\s*(?:[KMB]|thousand|million|billion)?|No)\s+subscribers?)\b/i;

  function normalizeSubs(text) {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/(\d[\d.,]*)\s*(thousand|million|billion)/i,
        (all, n, word) => n + { thousand: 'K', million: 'M', billion: 'B' }[word.toLowerCase()])
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Take the match closest to the start of the text, not the first pattern that happens to
     hit: different builds store the count in different shapes, and a pattern-ordered search
     will skip past a new-style header to an old-style shelf below it. */
  function firstMatch(text, patterns) {
    let best = null;
    for (const re of patterns) {
      const m = re.exec(text);
      if (!m || !m[1]) continue;
      if (!best || m.index < best.index) best = { index: m.index, value: m[1] };
    }
    if (!best) return null;
    return normalizeSubs(/subscriber/i.test(best.value) ? best.value : best.value + ' subscribers');
  }

  /* "@WillieDLive", "channel/UCxxx", "c/Name" -> the token that identifies the channel in
     the page's own links ("canonicalBaseUrl":"/@WillieDLive", "channelId":"UCxxx"). */
  function identityToken(key) {
    if (!key) return '';
    const bare = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
    return bare.toLowerCase();
  }

  function identityNear(window, token) {
    return !token || window.toLowerCase().includes(token);
  }

  /* Where the next header-shaped block starts, so one block's window can't reach into the
     next one — otherwise a stranger's block "contains" our identity simply by being close. */
  function nextAnchor(html, from) {
    let next = Infinity;
    for (const source of ANCHOR_SOURCES) {
      const re = anchorRegex(source);
      re.lastIndex = from;
      const m = re.exec(html);
      if (m && m.index < next) next = m.index;
    }
    return next;
  }

  function headerIndex(html) {
    let first = -1;
    for (const source of ANCHOR_SOURCES) {
      const m = anchorRegex(source).exec(html);
      if (m && (first < 0 || m.index < first)) first = m.index;
    }
    return first;
  }

  /* strict: only a count we can tie to the requested channel. Used while streaming, where a
     wrong answer gets locked in by the early abort. Non-strict adds page-wide fallbacks and
     is only used on a completed read. */
  function parseSubscribers(html, strict, key) {
    if (!html) return null;
    const token = identityToken(key);
    let unverified = null;

    for (const source of ANCHOR_SOURCES) {
      const re = anchorRegex(source);
      let m;
      while ((m = re.exec(html))) {
        const end = Math.min(nextAnchor(html, m.index + 1), m.index + HEADER_WINDOW);
        const window = html.slice(m.index, end);
        const hit = firstMatch(window, SUB_PATTERNS);
        if (!hit) continue;
        if (identityNear(window, token)) return hit;
        if (!unverified) unverified = hit;
      }
    }

    if (strict) return null;

    // Identity is all over a real channel page. If we saw it but never beside a count, the
    // counts on this page belong to other channels — better nothing than the wrong number.
    if (token && html.toLowerCase().includes(token)) return null;
    return unverified || firstMatch(html, SUB_PATTERNS) || firstMatch(html, [LOOSE_PATTERN]);
  }

  /* Views per hour, engagement and an earnings estimate.

     VPH and engagement are exact: both reproduce NextLev's panel to the displayed digit
     (10,626,093 views over 13,296 hours = 799/hr against their 799; 193,289 likes over
     those views = 1.82% against their 1.8%). VPH is a LIFETIME rate, not current velocity —
     a video averaging 799/hr across eighteen months is almost certainly not doing that now —
     so the label says per hour and the tooltip says since publishing.

     Earnings are not exact and cannot be. RPM is private to a channel's own YouTube Studio
     and appears in no public page, so the figure here is views x an assumed rate. The rates
     are the ones this project's research app already uses ($2/$5/$12 per 1,000), reused so
     the two products agree rather than inventing a second set. */
  const RPM_LOW = 2, RPM_MID = 5, RPM_HIGH = 12;

  /* Length is the largest single lever on ad revenue, so a flat rate is wrong in both
     directions — it overstates a three-minute upload and understates a long one.

       8 minutes  mid-roll ads unlock. This is the step change; below it a video carries a
                  pre-roll only, so the same views earn markedly less.
       Shorts     a separate revenue pool entirely, paid per-view from an ad-share fund at
                  roughly cents per 1,000 rather than dollars. Applying a long-form RPM to
                  Shorts views is not an approximation, it is the wrong unit — so no figure
                  is offered rather than a misleading one.

     The 0.55 factor below is a judgement, not a measurement, in the same spirit as the
     underlying $2/$5/$12 band. */
  const MIDROLL_SECONDS = 480;         // 8 minutes
  const SHORTS_MAX_SECONDS = 180;      // Shorts run up to 3 minutes
  const NO_MIDROLL_FACTOR = 0.55;

  function lengthBand(stats) {
    const len = stats.lengthSeconds;
    const isShort = stats.shortsPath === true ||
      (stats.shortsEligible === true && len != null && len <= SHORTS_MAX_SECONDS);
    if (isShort) return { band: 'shorts', factor: 0, label: 'Short' };
    if (len == null) return { band: 'unknown', factor: 1, label: 'length unknown' };
    if (len < MIDROLL_SECONDS) return { band: 'no-midroll', factor: NO_MIDROLL_FACTOR, label: 'under 8 min, no mid-rolls' };
    return { band: 'midroll', factor: 1, label: '8 min or longer, mid-rolls' };
  }

  /* nicheRpm, when the index has classified the channel, replaces the flat mid rate. The
     band around it is kept proportional to the default one — the uncertainty does not shrink
     because the niche is known, since audience geography moves RPM further than niche does.
     Without it the old flat rate applies and nothing changes. */
  /* Advertising rates swing hard across the year: budgets are spent by December and
     replenished slowly, so January is the cheapest month to be shown an ad in and December
     the dearest. The spread between them is wider than the gap between many of the niches
     above, and unlike geography it is something we can actually see, because the publish
     date is on the page.

     Normalised so the twelve months average one. The reference rates are annual figures, so
     a curve averaging anything else would quietly rescale every estimate. */
  const SEASON = [0.74, 0.79, 0.84, 0.89, 0.95, 1.00,
                  0.95, 0.95, 1.00, 1.11, 1.32, 1.47];

  /* Faded out as the video ages. A video published last week earns nearly all of it at this
     month's rates; one published two years ago has collected its views across every month
     there has been, so the month it happened to go up says nothing. Six months is roughly
     where the tail stops being dominated by the launch window. */
  const SEASON_FADE_DAYS = 180;

  function seasonFactor(publishedMs, nowMs) {
    if (!publishedMs || isNaN(publishedMs)) return 1;
    const ageDays = Math.max(0, (nowMs - publishedMs) / 86400000);
    const weight = Math.max(0, Math.min(1, 1 - ageDays / SEASON_FADE_DAYS));
    if (weight <= 0) return 1;
    const month = new Date(publishedMs).getMonth();
    return 1 + (SEASON[month] - 1) * weight;
  }

  function videoMetrics(stats, now, nicheRpm) {
    if (!stats || !stats.views) return null;
    const views = stats.views;
    const at = stats.publishDate ? new Date(stats.publishDate).getTime() : NaN;
    const hours = isNaN(at) ? null : Math.max(1, (asMillis(now) - at) / 3600000);
    const len = lengthBand(stats);
    const season = seasonFactor(at, asMillis(now));
    const per = (rpm) => (views / 1000) * rpm * len.factor * season;
    const mid = nicheRpm > 0 ? nicheRpm : RPM_MID;
    const low = mid * (RPM_LOW / RPM_MID);
    const high = mid * (RPM_HIGH / RPM_MID);
    return {
      views,
      approx: stats.approx === true,
      likes: stats.likes,
      category: stats.category || '',
      lengthSeconds: stats.lengthSeconds != null ? stats.lengthSeconds : null,
      length: len,
      // Below 1/hr the number is noise, and NextLev blanks it too.
      vph: hours ? views / hours : null,
      engagement: stats.likes != null && views > 0 ? (stats.likes / views) * 100 : null,
      rpm: len.factor === 0 ? null : mid * len.factor * season,
      rpmSource: nicheRpm > 0 ? 'niche' : 'default',
      season: season,
      earnings: len.factor === 0 ? null : { low: per(low), mid: per(mid), high: per(high) }
    };
  }

  function formatVph(vph) {
    if (vph == null || vph < 1) return '-';
    if (vph >= 1000) return compact(Math.round(vph));
    return String(Math.round(vph));
  }

  function formatMoney(n) {
    if (n == null) return '-';
    if (n >= 1000) return '$' + compact(Math.round(n));
    if (n >= 10) return '$' + Math.round(n);
    return '$' + n.toFixed(n < 1 ? 2 : 1);
  }

  /* Ad placements read out of a watch page's HTML, for the channel-page sampler which has
     no live player to ask. Mirrors page.js adSignal() so both paths agree. */
  /* Where a channel's money comes from, read out of pages already fetched.

     The ad-slot check downloads three watch pages and keeps only a count of placements. The
     description sits in the same HTML and was being thrown away, so every stream below costs
     nothing extra to detect — no request, no quota, no extra wait.

     Each is evidence of a revenue stream, not proof of income: an Amazon link may carry no
     affiliate tag, and a merch link may sell nothing. The panel says how many of the sampled
     videos carried each, so a single stray link reads as what it is.  */
  const REVENUE_RULES = [
    { key: 'sponsor', label: 'Sponsorships', hint: 'Paid promotions & brand deals',
      // "Thanks to X for sponsoring" is the near-universal phrasing, and YouTube's own
      // disclosure is checked separately in revenueSignals — it is the authoritative one.
      re: /\b(sponsored by|thanks to [^.\n]{1,40} for sponsoring|in partnership with|paid promotion|use code\s+\w+|promo code)\b/i },
    { key: 'affiliate', label: 'Affiliate links', hint: 'Commissioned product links',
      // Matched on known affiliate hosts and Amazon's own short forms rather than on the word
      // "affiliate", which appears in disclaimers on channels that carry none.
      re: /(amzn\.to|a\.co\/|amazon\.[a-z.]+\/[^\s]*tag=|shareasale|impact\.com|geni\.us|ltk\.app|rstyle\.me|\bref=[a-z0-9_-]{4,})/i },
    { key: 'product', label: 'Products', hint: 'Merch, books, downloads, store',
      re: /\b(new merch|merch(andise)?\s*[:\-]|my (new )?(book|course|ebook|preset|app)\b|shop(ify)?\.|teespring|fourthwall|\.store\b|\bstore\.[a-z0-9-]+\.[a-z]{2,})/i },
    { key: 'donation', label: 'Donations', hint: 'Tips & viewer contributions',
      re: /\b(patreon\.com|ko-?fi\.com|buymeacoffee|gofundme|paypal\.me|cash\.app|donate\b|donation)\b/i }
  ];

  /* The description as YouTube stores it, out of the player payload. Read from the JSON
     rather than the rendered page because a soft navigation leaves the old description in
     the DOM long after the video has changed. */
  function descriptionFromHtml(html) {
    const m = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html || '');
    if (!m) return '';
    try {
      return JSON.parse('"' + m[1] + '"');
    } catch (e) {
      return '';
    }
  }

  function revenueSignals(html) {
    if (!html) return null;
    const desc = descriptionFromHtml(html);
    const out = {
      ads: adSignalFromHtml(html),
      // YouTube's own "includes paid promotion" disclosure: a declaration by the creator
      // rather than a guess from wording, so it outranks the phrasing rule.
      declaredPaid: html.indexOf('paidContentOverlay') >= 0,
      streams: {}
    };
    for (const rule of REVENUE_RULES) {
      const hit = rule.re.exec(desc);
      if (hit) {
        // The line it appeared on, so the panel can show why it decided this.
        const line = desc.split('\n').find((l) => rule.re.test(l)) || hit[0];
        out.streams[rule.key] = line.trim().slice(0, 160);
      }
    }
    if (out.declaredPaid && !out.streams.sponsor) {
      out.streams.sponsor = 'YouTube paid-promotion disclosure on this video';
    }
    return out;
  }

  /* Across the sampled videos: which streams appeared, on how many, and one example each. */
  function revenueSummary(samples) {
    const seen = (samples || []).filter(Boolean);
    const out = [];
    for (const rule of REVENUE_RULES) {
      const hits = seen.filter((s) => s.streams && s.streams[rule.key]);
      if (!hits.length) continue;
      out.push({ key: rule.key, label: rule.label, hint: rule.hint,
                 videos: hits.length, example: hits[0].streams[rule.key] });
    }
    return out;
  }

  function adSignalFromHtml(html) {
    if (!html) return null;
    if (html.indexOf('"adPlacements"') < 0) {
      return { placements: 0, forecasting: 0, instream: 0 };
    }
    const count = (re) => (html.match(re) || []).length;
    return {
      placements: count(/adPlacementRenderer/g),
      forecasting: count(/clientForecastingAdRenderer/g),
      instream: count(/instreamVideoAdRenderer/g)
    };
  }

  /* What the ad signal can and cannot tell you.

     The original rule here was "any video with ad placements proves the channel is in the
     Partner Program". That is wrong, and testing against a demonetized channel showed why:
     its videos carry exactly the same payload as carwow's and MrBeast's — one placement,
     AD_PLACEMENT_KIND_START, clientForecastingAdRenderer, no instream renderer. A
     forecasting renderer is inventory measurement, not a served ad, and YouTube emits it for
     demonetized channels too. Ten other candidate fields were identical across both groups.

     The only thing that differed was the PROPORTION of recent videos carrying a placement:
     3/3 and 3/3 for the monetized channels against 1/3 for the demonetized one. So a
     majority is the most this data supports, and even that is an estimate calibrated on a
     small sample — hence "likely" in the labels rather than a verdict. One sample is never
     enough, because a lone forecasting slot is exactly the false positive being avoided. */
  function monetizationVerdict(samples) {
    const seen = (samples || []).filter(Boolean);
    const withAds = seen.filter((s) => s.placements > 0).length;
    if (seen.length < 2) return { state: 'unknown', checked: seen.length, withAds };
    const state = withAds * 2 > seen.length ? 'likely-monetized' : 'likely-not';
    return { state, checked: seen.length, withAds };
  }

  /* ---------------------------------------------------------- similar channels */

  /* Queries are drawn from the channel's own video titles, because YouTube's search results
     are topical by construction — it is answering a query, not guessing what you would enjoy.

     The obvious alternative, the watch page's recommendation sidebar, was measured and
     rejected: for a car channel it returned @LiverpoolFC, @chelseafc and @redbull among the
     top five, because every sidebar carries generic and personalised filler that no ranking
     over it can separate out. The same channel searched by topic returned @DougDeMuro,
     @ThrottleHouse and @TheStraightPipes — thirteen channels, all of them cars. */

  const STOPWORDS = new Set(('the a an and or but is are was were be been being of to in for ' +
    'on at by with from as it its this that these those i you he she we they my your our his ' +
    'her their new best top vs versus how why what when where who which do does did can will ' +
    'just get got go goes going make makes made see saw look looks now then than so very more ' +
    'most much many about after before over under out up down off again ever never all any ' +
    'each every some no not only own same too also here there full official video shorts ' +
    'episode part trailer leading platform network covers welcome subscribe content ' +
    /* The same category as "leading platform network covers welcome" above: verbs and
       flattery a channel writes ABOUT itself, which describe no subject. "Our stories immerse
       you in the beauty" produced the query "stories immerse beauty", which is a sentence
       fragment wearing a topic's clothes. Deliberately excluded from this list: "relax" and
       "dive", which really are subjects (lofi and ASMR channels, diving channels). */
    'immerse brought join community celebrate expect lovers entertain educate memorable ' +
    'channel channels everything weekly daily official home page site com www').split(' '));

  /* What KIND of video the channel makes. Measured: "toyota corolla" returns dealerships and
     listings, while "toyota corolla review" returns the people making the same videos. And an
     unqualified genre word is worse than useless — "drag race" alone returns RuPaul's Drag
     Race. So a query is a topic phrase AND a genre word, never either alone. */
  const GENRE_WORDS = ['review', 'reviews', 'tutorial', 'guide', 'explained', 'reaction',
    'gameplay', 'unboxing', 'vlog', 'podcast', 'documentary', 'breakdown', 'highlights',
    'analysis', 'comparison', 'tips', 'story', 'interview', 'recap', 'walkthrough',
    'recipe', 'recipes', 'tour', 'build', 'challenge', 'ranking', 'essay', 'workout'];

  function titleTokens(title) {
    return String(title || '')
      .toLowerCase()
      // & and + split too: "Law&Crime" must tokenise as law, crime, or the channel's own
      // name is not recognised in phrases built from it.
      /* Anything that is not a letter, a digit or a space, rather than a hand-kept list of
         punctuation. The list left emoji standing, and a description bulleted with them glues
         each one to the word it precedes: measured on @talesby_chizi, "💕Dramatic twists" and
         "💕Engaging storytelling" tokenised with the emoji attached, so the phrase carried a
         pictograph into the search query and "dramatic twists" never existed as a phrase at
         all. The same fix drops "#shorts", which survived the old class intact and was never
         a topic. */
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      // Two-character tokens matter — "gr", "m2", "f1" are the subject, not noise.
      .filter((w) => w && w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }

  /* Crude, and deliberately so. Counting how often a channel uses a word only works if
     "stories", "story" and "storytelling" count as the same word, and if "Africa" and
     "African" do — but a real stemmer is a dictionary, and this runs in a content script.
     Strip the plural, then keep six characters: enough to fuse africa/african,
     cultural/culturally and tale/tales, short enough not to fuse anything that matters. */
  function stemWord(word) {
    let w = String(word || '');
    if (w.length > 4 && w.slice(-3) === 'ies') w = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.slice(-1) === 's' && w.slice(-2) !== 'ss') w = w.slice(0, -1);
    return w.slice(0, 6);
  }

  /* Phrases beat single words: "corolla" alone pulls in dealerships and music, while
     "gr corolla review" pulls in the people making the same videos. Bigrams are counted
     across the sampled titles and the most repeated ones win, since a phrase the channel
     uses repeatedly is what the channel is actually about. */
  /* A channel's description states its niche; its titles often do not.

     Measured on Law&Crime: the titles are case names — "Tupac Murder", "Hayden Panettiere" —
     so title-derived queries searched for those stories and returned every outlet that
     covered them (@BBCNews, @ABCNews, @WatchMojo, @NDTVProfitIndia). The description says
     "live court video, high-profile criminal trials, true crime and legal analysis", which
     is the actual niche.

     Descriptions are prose, so phrases appear once rather than repeating, and bigrams are
     taken within punctuation-delimited segments — spanning a comma joins two unrelated
     clauses into nonsense like "trials true". */
  function phrasesFromAbout(about) {
    /* Whole clauses first, sliding windows only as a fallback.

       A description is written in phrases, and its punctuation already marks them out:
       "...covers live court video, high-profile criminal trials, true crime and legal
       analysis" is three ready-made queries. Sliding a window across it instead produced
       "multi live court" and "law crime multi", which read as news queries and returned
       @KSATnews, @GBHNews, @7news and @WIRED. The intact clause "high profile criminal
       trials" returned @CourtTV, @48hours, @CRConfidential and @NateTheLawyer. */
    /* Plenty of descriptions are not descriptions. "Business inquiries:
       aircrashinvestigation@intheblackmedia.com" is the whole visible description of a channel
       about air crashes, and it produced the query "business inquiries story", which returned
       @BusinessStoriesOfficial and @SapphicStories2026. Contact details, links and
       social-media plugs are dropped before anything is built from them. */
    const JUNK = /business inquir|inquiries|contact|sponsor|collab|patreon|instagram|twitter|tiktok|discord|merch|subscribe|@|https?:|www\.|\.com|\.net|\.org/i;

    const clauses = [];
    const tails = [];
    const windows = [];
    /* Em and en dashes end a clause the way a comma does — "the beauty, drama, and wisdom of
       Africa—one tale at a time" is two thoughts, and without the dash the second half rode
       along into "wisdom africa one tale time". The plain hyphen is deliberately NOT here: it
       joins words rather than separating clauses, and splitting on it would turn
       "high-profile criminal trials" into "high" and "profile criminal trials". */
    for (const segment of String(about || '').split(/[,.;:|/!?()\n—–]+/)) {
      if (JUNK.test(segment)) continue;
      const words = titleTokens(segment).filter((w) => GENRE_WORDS.indexOf(w) < 0);
      if (words.length >= 2 && words.length <= 5) {
        clauses.push(words.join(' '));
        continue;                       // already a usable phrase
      }
      // Long clause: its tail carries the specifics, its opening carries boilerplate
      // ("X is the leading multi-platform network that covers ...").
      if (words.length > 5) tails.push(words.slice(-3).join(' '));
      for (let i = 0; i < words.length - 2; i++) {
        windows.push(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
      }
    }
    /* Ordered by how much each is trusted, which the failures established:
         intact clause  — the description said this, in one piece. Best.
         tail           — the end of a long clause. Its opening was boilerplate, and these
                          produced "law crime multi live court" and "history documentaries
                          covering". Usable, not trusted.
         window         — a sliding fragment. Last resort. */
    return { clauses: clauses, tails: tails.concat(windows) };
  }

  function topicQueries(titles, channelName, limit, about) {
    /* The channel name is deliberately NOT excluded from the subject phrase. Names usually
       describe the niche — "Pasta Kitchen", "History Marche" — so banning their words removed
       the very topic being searched for: "Pasta Kitchen" lost "pasta recipe" and fell back to
       "easy" and "beginners". The channel itself is filtered out of the results instead,
       which is where that belongs. */
    const list = titles || [];

    // The genre the channel works in, if its titles name one consistently.
    const genreCount = new Map();
    for (const t of list) {
      for (const w of titleTokens(t)) {
        if (GENRE_WORDS.indexOf(w) >= 0) genreCount.set(w, (genreCount.get(w) || 0) + 1);
      }
    }
    let genre = '';
    let best = 0;
    genreCount.forEach((n, w) => { if (n > best) { best = n; genre = w; } });

    // Repeated subject phrases, ignoring the genre words themselves.
    const counts = new Map();
    for (const t of list) {
      const words = titleTokens(t)
        .filter((w) => GENRE_WORDS.indexOf(w) < 0);
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = words[i] + ' ' + words[i + 1];
        counts.set(bigram, (counts.get(bigram) || 0) + 1);
      }
    }

    let ranked = Array.from(counts.entries())
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([phrase]) => phrase);

    /* The description leads. A phrase repeated across titles is often a running story rather
       than the niche, and on a news or case-driven channel that is always true. */
    const fromAbout = phrasesFromAbout(about);

    /* The name, as a last resort. Channels routinely name their niche — "Air Crash
       Investigation", "HistoryMarche" — and when the description is a contact address and the
       titles are clickbait ("The Dubai Inferno That No One Survived"), the name is the only
       thing on the page that says what the channel is about. */
    const nameParts = titleTokens(channelName).filter((w) => GENRE_WORDS.indexOf(w) < 0);
    const namePhrase = nameParts.length >= 2 ? nameParts.join(' ') : '';
    /* A multi-word channel name beats a single-word fallback. "air story" and "flight story"
       are what is left when nothing repeats and there is no usable description, and they
       return whatever is vaguely about air; "air crash investigation" returns
       @MaydayAirDisaster. The name goes above single words but stays below real phrases. */
    /* Final order. An intact clause from the description is the strongest statement of what a
       channel is; the channel's own name is next, since channels routinely name their niche;
       then title phrases, then the untrusted fragments, then bare words. */
    const titlePhrases = ranked.filter((r) => r.indexOf(' ') >= 0);
    const singles = ranked.filter((r) => r.indexOf(' ') < 0);
    /* Within the description's own clauses, the ones free of the channel's name come first.
       The opening clause is almost always "<Channel> is the leading ... that covers", which
       survives as a phrase but describes the company rather than the subject. */
    /* Then, among clauses the name does not own, the one built from the words this channel
       actually keeps using.

       Document order was the tiebreak, and document order is not a quality signal: a
       description opens with a greeting and a hook and states its niche further down. On
       @talesby_chizi the first three clauses were "family secrets cultural mysteries",
       "stories immerse beauty" and "wisdom africa one tale time" — one plot detail and two
       pieces of grammatical debris — while "culturally rooted african stories" and "dramatic
       twists" sat in slots five and six and never reached the three query slots.

       So score a clause by how dense it is in the channel's own recurring vocabulary,
       counted over the description AND the video titles together. That cross-check is the
       whole point: prose filler like "immerse" or "wisdom" appears once in the description
       and never in a title, while "african" and "stories" appear in both, repeatedly. Words
       are counted once per clause, so repetition inside one clause cannot inflate it, and
       the mean is used rather than the sum so a long clause does not win on length. */
    const nameSet = new Set(titleTokens(channelName));
    const freq = new Map();
    const countInto = (text) => {
      for (const w of titleTokens(text)) {
        const s = stemWord(w);
        freq.set(s, (freq.get(s) || 0) + 1);
      }
    };
    countInto(about);
    for (const t of list) countInto(t);
    /* Breadth first, density second. Ranking on density alone put "stories immerse beauty"
       and "stories entertain" at the top of this same channel: one hub word the channel uses
       eleven times drags the average up however much prose is bolted to it. Counting how many
       of a clause's words recur at all separates them — "culturally rooted african stories"
       has three recurring words, a prose fragment carrying one hub word has exactly one. */
    const weigh = (phrase) => {
      const stems = Array.from(new Set(phrase.split(' ').map(stemWord)));
      if (!stems.length) return { recurring: 0, density: 0 };
      const counts = stems.map((s) => freq.get(s) || 0);
      return {
        recurring: counts.filter((n) => n > 1).length,
        density: counts.reduce((n, x) => n + x, 0) / stems.length
      };
    };
    const orderedClauses = fromAbout.clauses
      .map((c, i) => ({ c: c, i: i, w: weigh(c),
                        owned: c.split(' ').filter((w) => nameSet.has(w)).length }))
      .sort((a, b) => a.owned - b.owned || b.w.recurring - a.w.recurring ||
                      b.w.density - a.w.density || a.i - b.i)
      .map((x) => x.c);

    ranked = orderedClauses
      .concat(namePhrase ? [namePhrase] : [])
      .concat(titlePhrases)
      .concat(fromAbout.tails)
      .concat(singles);

    if (!ranked.length) {
      const words = new Map();
      for (const t of list) {
        for (const w of titleTokens(t)) {
          if (GENRE_WORDS.indexOf(w) >= 0) continue;
          words.set(w, (words.get(w) || 0) + 1);
        }
      }
      ranked = Array.from(words.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => w);
    }

    /* A phrase made entirely of the channel's own name searches for the channel, not its
       niche: "law crime" returned only Law&Crime's second channel. Individual name words are
       still allowed, because names describe niches — banning them outright cost "Pasta
       Kitchen" the phrase "pasta recipe". Only an all-name phrase is rejected. */
    const nameWords = new Set(titleTokens(channelName));

    /* Phrases free of the channel's name describe the niche; phrases carrying it tend to be
       branding that drifted into the sentence — "law crime multi", "carwow uk biggest". Both
       are kept, but the clean ones are offered first so they take the query slots.

       The name phrase itself is exempt. It is a deliberate fallback, not drift, and this
       partition was silently demoting it behind fragments like "first officer take" — which
       is why the ordering above appeared to have no effect. */
    /* Demote only phrases MOSTLY made of the name. Demoting on any shared word punished the
       description's own clauses on channels named after their niche: "true crime legal" was
       pushed behind "tupac murder" because Law&Crime contains the word "crime", which is the
       subject, not the branding. */
    const demoted = (p2) => {
      if (p2 === namePhrase) return false;
      const parts2 = p2.split(' ');
      const owned = parts2.filter((w) => nameWords.has(w)).length;
      return owned * 2 > parts2.length;   // strict majority: 2 of 4 is still a real phrase
    };
    const clean = ranked.filter((p2) => !demoted(p2));
    const rest = ranked.filter(demoted);
    ranked = clean.concat(rest);

    const picked = [];
    for (const phrase of ranked) {
      const parts = phrase.split(' ');
      if (parts.every((w) => nameWords.has(w)) && (picked.length || phrase !== namePhrase)) continue;
      /* Reject only a phrase that adds nothing — every word already used. Rejecting on any
         shared word was too strict: it threw away "criminal trials" and "true crime" for
         overlapping with "high profile criminal", then fell through to title-derived phrases
         and put "tupac murder" back in the third slot, which is the story-chasing query the
         description was brought in to replace. */
      /* Require real novelty. Rejecting only exact repeats let a sliding window over one
         sentence produce "high profile criminal" and "profile criminal trials", which are the
         same query twice; rejecting any overlap was too strict and fell through to titles.
         A phrase must contribute at least two words nobody has used, or one if it is short. */
      const used = new Set();
      picked.forEach((p2) => p2.split(' ').forEach((w) => used.add(w)));
      const fresh = parts.filter((w) => !used.has(w)).length;
      if (picked.length && fresh < Math.min(2, parts.length)) continue;
      picked.push(phrase);
      if (picked.length >= (limit || 3)) break;
    }
    // Attach the genre so the query finds makers of this kind of video, not sellers or
    // an unrelated franchise that happens to share the words.
    /* Do not append a genre the phrase already carries in another form — "military history
       documentaries" must not become "military history documentaries documentary". */
    /* Compared through the stemmer rather than a fixed five-character prefix, which was one
       character short of the case it existed for: "story".slice(0,5) is "story" but
       "stories".slice(0,5) is "stori", so "culturally rooted african stories" was handed a
       genre it already carried and searched for "... stories story". */
    const genreStem = stemWord(genre);
    return picked.map((p) => {
      if (!genre) return p;
      if (p.split(' ').some((w) => stemWord(w) === genreStem)) return p;
      return p + ' ' + genre;
    });
  }

  /* Channel handles from a search results page, in rank order and de-duplicated. */
  /* Only the top of each result page. A channel ranking third for a topic is about that
     topic; one appearing fortieth is usually a general-interest or local-news channel that
     ranks a little for everything. Measured on Law&Crime, the tail is where @WatchMojo,
     @WIRED, @KSATnews and @GBHNews came from. */
  const SEARCH_DEPTH = 12;

  /* The same scrape, but keeping the channel ids alongside the handles.

     Search result pages pair browseId with canonicalBaseUrl, so a scrape the extension is
     already performing yields exactly what the index needs to enrich a channel: the id the
     YouTube API takes. Discovery has to happen here rather than on the server, because a
     server scraping YouTube search gets the bot interstitial — the extension is on a
     residential connection, which is the only reason this works at all. */
  function channelPairsFromSearch(html, depth) {
    if (!html) return [];
    const cut = depth || SEARCH_DEPTH;
    const seen = new Set();
    const out = [];
    const re = /"browseId":"(UC[\w-]{20,24})","canonicalBaseUrl":"\/(@[\w.-]+)"/g;
    let m;
    while ((m = re.exec(html)) && out.length < cut) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], handle: m[2] });
    }
    return out;
  }

  function channelsFromSearch(html, exclude, depth) {
    if (!html) return [];
    const skip = String(exclude || '').toLowerCase();
    const cut = depth || SEARCH_DEPTH;
    const seen = new Set();
    const out = [];
    const re = /"canonicalBaseUrl":"\/(@[\w.-]+)"|"\/(@[\w.-]+)"/g;
    let m;
    while ((m = re.exec(html)) && out.length < cut) {
      const handle = m[1] || m[2];
      if (!handle) continue;
      const low = handle.toLowerCase();
      if (low === skip || seen.has(low)) continue;
      seen.add(low);
      out.push(handle);
    }
    return out;
  }

  /* Rank by how many separate queries a channel turned up in: appearing for two different
     topical phrases is much stronger evidence than ranking once. */
  function rankSimilar(perQuery, limit) {
    const hits = new Map();
    const bestRank = new Map();
    for (const list of perQuery || []) {
      list.forEach((handle, i) => {
        const low = handle.toLowerCase();
        hits.set(low, (hits.get(low) || 0) + 1);
        if (!bestRank.has(low) || i < bestRank.get(low)) bestRank.set(low, i);
        if (!hits.has(handle)) hits.set(handle, hits.get(handle) || 0);
      });
    }
    const names = new Map();
    for (const list of perQuery || []) for (const h of list) names.set(h.toLowerCase(), h);

    /* Appearing for two different topics is far stronger evidence than ranking well for one,
       so that dominates the sort and search position only breaks ties. Without enough
       queries to produce any overlap this degrades to plain concatenation, which is what it
       was doing when every row read "rank N" and none read "both topics". */
    return Array.from(hits.keys())
      .filter((k) => names.has(k))
      .map((k) => ({ handle: names.get(k), queries: hits.get(k), rank: bestRank.get(k) }))
      .sort((a, b) => b.queries - a.queries || a.rank - b.rank)
      .slice(0, limit || 25);
  }

  /* The channel /about page carries lifetime totals that no other tab does:

       "subscriberCountText":"11.1M subscribers","viewCountText":"5,562,325,195 views"
       ... "videoCountText":"3,562 videos"

     Those two totals give the average views per video, which is the denominator every other
     tool means by "outlier" (a video's views against its channel's normal). The three keys
     sit in one metadata block describing the requested channel, so unlike the subscriber
     scrape there is no sibling-channel ambiguity to defend against here. */
  function parseChannelStats(html) {
    if (!html) return null;
    const grab = (key) => {
      // Tolerate the escaped forms YouTube emits inside nested JSON payloads.
      const re = new RegExp('\\\\?"' + key + '\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)', 'i');
      const m = re.exec(html);
      return m ? m[1] : null;
    };
    const views = viewsToNumber(grab('viewCountText'));
    const videos = viewsToNumber(grab('videoCountText'));
    if (!views || !videos) return null;
    /* When the channel opened. YouTube has moved this between shapes over the years, so
       several are tried and a miss simply means the age is not shown — an omitted figure is
       honest, a guessed one is not. */
    const joinedRaw = grab('joinedDateText') ||
      (/Joined\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/.exec(html) || [])[1] || '';
    const joinedAt = Date.parse(String(joinedRaw).replace(/^Joined\s+/i, ''));
    return {
      totalViews: views,
      videoCount: videos,
      avgViews: Math.round(views / videos),
      joinedAt: isNaN(joinedAt) ? null : joinedAt
    };
  }

  /* An anchored match with no header block around it: good enough to fall back on if the
     page never yields a header we recognise, but never preferred over one that does. */
  function parseAnchored(html) {
    return html ? firstMatch(html, SUB_PATTERNS) : null;
  }

  /* "23 hours ago" -> "2026-08-22" (best effort; returns original on failure) */
  const RELATIVE_MS = {
    second: 1e3, minute: 6e4, hour: 36e5, day: 864e5,
    week: 6048e5, month: 2592e6, year: 31536e6
  };
  /* YouTube writes "2mo ago" in search results and "2 months ago" elsewhere. "mo" is listed
     before "m" so it is not read as minutes, which would date a two-month-old video to today. */
  const SHORT_UNITS = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' };

  /* Shared by relativeToISO and by the cards' views-per-hour pill, which needs the elapsed
     time rather than a date string. Returns null when the text is not a relative time. */
  /* "now" is accepted as a Date, a timestamp, or omitted. The module was inconsistent —
     videoMetrics took a number while this took a Date — and a caller passing the wrong one
     threw, which aborted the whole badge render rather than just losing this value. Normalise
     instead of relying on every call site to remember. */
  function asMillis(now) {
    if (now == null) return Date.now();
    if (typeof now === 'number') return now;
    if (typeof now.getTime === 'function') return now.getTime();
    return Date.now();
  }

  function relativeToDate(text, now) {
    if (!text) return null;
    const src = String(text);
    let n = null;
    let unit = null;

    const long = src.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
    if (long) {
      n = parseInt(long[1], 10);
      unit = long[2].toLowerCase();
    } else {
      const short = src.match(/(\d+)\s*(mo|s|m|h|d|w|y)\s*ago/i);
      if (short) {
        n = parseInt(short[1], 10);
        unit = SHORT_UNITS[short[2].toLowerCase()];
      }
    }
    if (n == null || !unit) return null;
    return new Date(asMillis(now) - n * RELATIVE_MS[unit]);
  }

  function relativeToISO(text, now) {
    if (!text) return '';
    const src = String(text);
    const d = relativeToDate(src, now);
    return d ? d.toISOString().slice(0, 10) : text;
  }

  /* Views per hour from a card's relative timestamp. Coarser than the watch page's, which
     has an exact publish time — "2mo ago" is only accurate to the month — so it is a
     comparison aid between cards, not a precise rate. Clamped to an hour so a video posted
     seconds ago does not report an absurd number. */
  function vphFromRelative(viewsText, dateText, now) {
    const views = viewsToNumber(viewsText);
    if (!views) return null;
    const at = relativeToDate(dateText, now);
    if (!at) return null;
    const hours = Math.max(1, (asMillis(now) - at.getTime()) / 3600000);
    return views / hours;
  }

  function cleanViews(text, s) {
    if (!text) return '';
    if (s.numericViews) {
      const n = viewsToNumber(text);
      return n === null ? text : n.toLocaleString('en-US');
    }
    return text;
  }

  function cleanDate(text, s) {
    if (!text) return '';
    return s.absoluteDate ? relativeToISO(text) : text;
  }

  /* Ordered [key, value] pairs for the fields the user turned on. */
  function activeParts(video, s) {
    const out = [];
    for (const key of FIELD_ORDER) {
      if (!s.fields[key]) continue;
      let val = video[key] || '';
      if (key === 'views') val = cleanViews(val, s);
      if (key === 'date') val = cleanDate(val, s);
      if (key === 'title' && val && s.quoteTitle) val = '"' + val + '"';
      if (val) out.push([key, val]);
    }
    return out;
  }

  function csvCell(v) {
    const t = String(v == null ? '' : v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  function applyTemplate(tpl, video, s, index) {
    const map = {
      title: video.title || '',
      views: cleanViews(video.views, s),
      viewsRaw: video.views || '',
      viewsNum: video.views ? String(viewsToNumber(video.views) ?? '') : '',
      date: cleanDate(video.date, s),
      dateRaw: video.date || '',
      dateISO: relativeToISO(video.date),
      channel: video.channel || '',
      url: video.url || '',
      id: video.id || '',
      index: String(index + 1),
      n: String(index + 1)
    };
    return String(tpl).replace(/\{(\w+)\}/g, (full, key) =>
      Object.prototype.hasOwnProperty.call(map, key) ? map[key] : full
    );
  }

  function formatOne(video, s, index) {
    const sep = s.separator === '\\n' ? '\n' : s.separator;
    const parts = activeParts(video, s);

    switch (s.layout) {
      case 'custom':
        return applyTemplate(s.customTemplate, video, s, index);

      case 'markdown': {
        const title = video.title || '';
        const head = s.fields.title
          ? (s.fields.url && video.url ? `[${title}](${video.url})` : `**${title}**`)
          : '';
        const rest = parts
          .filter(([k]) => k !== 'title' && !(k === 'url' && s.fields.title))
          .map(([, v]) => v);
        const line = [head, rest.join(' · ')].filter(Boolean).join(' — ');
        return '- ' + line;
      }

      case 'csv':
        return parts.map(([, v]) => csvCell(v)).join(',');

      case 'bullet':
        return '• ' + parts.map(([, v]) => v).join(sep);

      case 'numbered':
        return (index + 1) + '. ' + parts.map(([, v]) => v).join(sep);

      case 'plain':
      default:
        return parts.map(([, v]) => v).join(sep);
    }
  }

  function formatList(videos, settings) {
    const s = merge(settings);
    const list = Array.isArray(videos) ? videos : [videos];
    if (!list.length) return '';

    if (s.layout === 'json') {
      return JSON.stringify(
        list.map((v) => {
          const o = {};
          for (const [k, val] of activeParts(v, s)) o[k] = val;
          if (s.fields.views && v.views) o.viewsNumber = viewsToNumber(v.views);
          return o;
        }),
        null,
        2
      );
    }

    const lines = list.map((v, i) => formatOne(v, s, i));

    if (s.layout === 'csv' && s.csvHeader) {
      const header = FIELD_ORDER.filter((k) => s.fields[k]).map((k) => FIELD_LABELS[k]);
      lines.unshift(header.join(','));
    }

    // Multi-field, newline-separated output reads better with a blank line between videos.
    const blockish = (s.separator === '\n' || s.separator === '\\n') && s.layout !== 'csv';
    return lines.join(blockish && list.length > 1 ? '\n\n' : '\n');
  }

  const SAMPLE = [
    {
      title: 'TokTok Users Just Got PAYBACK! RIP NOLAN WELLS',
      views: '271K views',
      date: '23 hours ago',
      channel: 'BIGGKISH',
      url: 'https://www.youtube.com/watch?v=6KCPs3Umu5w',
      id: '6KCPs3Umu5w'
    },
    {
      title: 'TikTok Users Reveal More Nolan Wells Footage!',
      views: '120K views',
      date: '6 hours ago',
      channel: 'BIGGKISH',
      url: 'https://www.youtube.com/watch?v=aB12cD34eF5',
      id: 'aB12cD34eF5'
    }
  ];

  root.YTCopyFormat = {
    DEFAULTS, SEPARATORS, LAYOUTS, FIELD_ORDER, FIELD_LABELS, SAMPLE,
    merge, formatOne, formatList, viewsToNumber, relativeToISO, compact, parseSubscribers,
    isTransientFailure, isRetryableFailure, headerIndex, parseAnchored, identityToken,
    parseChannelStats, adSignalFromHtml, monetizationVerdict, channelPairsFromSearch,
    revenueSignals, revenueSummary, descriptionFromHtml,
    videoMetrics, formatVph, formatMoney, RPM_LOW, RPM_MID, RPM_HIGH,
    relativeToDate, vphFromRelative,
    topicQueries, channelsFromSearch, rankSimilar,
    safeFilename, formatTranscript, stampMs, decodeEntities, parseJson3, parseTimedTextXml,
    innertubeConfig, captionTracksFrom, pickCaptionTrack, transcriptSegmentsFrom, loadTranscript,
    playerResponseFrom
  };
})(typeof window !== 'undefined' ? window : globalThis);
