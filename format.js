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
    showRatio: true               // views ÷ subscribers pill
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

     isTransientFailure, isRetryableFailure, headerIndex, parseAnchored, identityToken: how long to cache a failure. Throttled/blocked/truncated recovers
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
    isTransientFailure, isRetryableFailure, headerIndex, parseAnchored, identityToken
  };
})(typeof window !== 'undefined' ? window : globalThis);
