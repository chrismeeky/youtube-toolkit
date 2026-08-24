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
    showThumb: true,              // thumbnail download button
    /* Deprecated. YouTube gates caption URLs behind proof-of-origin tokens an extension
       cannot mint, so this needed a local yt-dlp helper to be running — and hosting that
       helper does not work either, because YouTube blocks datacenter IPs (measured: 1 of 4
       videos succeeded from Render). Rather than leave a button that fails for most people,
       the UI is withdrawn. Everything behind it still works: transcript-helper.py, the
       transcript_service deployment, and F.loadTranscript are all untouched, so setting
       TRANSCRIPT_UI back to true restores the feature as it was. */
    showTranscript: false,        // deprecated: see TRANSCRIPT_UI
    transcriptTimestamps: false,  // prefix each line with its timestamp
    transcriptSave: false,        // save as .txt instead of copying
    helperUrl: 'http://127.0.0.1:8731'   // local yt-dlp transcript helper
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
    return /HTTP (429|5\d\d)|fetch failed|no count in/i.test(reason || '');
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

  function videoMetrics(stats, now) {
    if (!stats || !stats.views) return null;
    const views = stats.views;
    const at = stats.publishDate ? new Date(stats.publishDate).getTime() : NaN;
    const hours = isNaN(at) ? null : Math.max(1, ((now || Date.now()) - at) / 3600000);
    const len = lengthBand(stats);
    const per = (rpm) => (views / 1000) * rpm * len.factor;
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
      rpm: len.factor === 0 ? null : RPM_MID * len.factor,
      earnings: len.factor === 0 ? null : { low: per(RPM_LOW), mid: per(RPM_MID), high: per(RPM_HIGH) }
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
    return { totalViews: views, videoCount: videos, avgViews: Math.round(views / videos) };
  }

  /* An anchored match with no header block around it: good enough to fall back on if the
     page never yields a header we recognise, but never preferred over one that does. */
  function parseAnchored(html) {
    return html ? firstMatch(html, SUB_PATTERNS) : null;
  }

  /* "23 hours ago" -> "2026-08-22" (best effort; returns original on failure) */
  function relativeToISO(text, now) {
    if (!text) return '';
    const m = String(text).match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
    if (!m) return text;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = {
      second: 1e3, minute: 6e4, hour: 36e5, day: 864e5,
      week: 6048e5, month: 2592e6, year: 31536e6
    }[unit];
    const d = new Date((now ? now.getTime() : Date.now()) - n * ms);
    return d.toISOString().slice(0, 10);
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
    parseChannelStats, adSignalFromHtml, monetizationVerdict,
    videoMetrics, formatVph, formatMoney, RPM_LOW, RPM_MID, RPM_HIGH,
    safeFilename, formatTranscript, stampMs, decodeEntities, parseJson3, parseTimedTextXml,
    innertubeConfig, captionTracksFrom, pickCaptionTrack, transcriptSegmentsFrom, loadTranscript,
    playerResponseFrom
  };
})(typeof window !== 'undefined' ? window : globalThis);
