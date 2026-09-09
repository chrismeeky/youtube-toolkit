/* Runs in the page's own JavaScript world (not the isolated content-script world) purely to
   read values only the live page has: the InnerTube config, the transcript params inside
   ytInitialData, and the caption URLs from the active player response. A re-fetched copy of
   the watch page carries different params, which YouTube rejects with a 400. */
(function () {
  'use strict';

  function findTranscriptParams(node, budget) {
    if (!node || typeof node !== 'object' || budget.n <= 0) return '';
    budget.n--;
    const endpoint = node.getTranscriptEndpoint;
    if (endpoint && endpoint.params) return endpoint.params;
    for (const key of Object.keys(node)) {
      const found = findTranscriptParams(node[key], budget);
      if (found) return found;
    }
    return '';
  }

  /* Ad slots the player was handed for this video. Their presence means YouTube served ad
     placements here, which only happens for a channel in the Partner Program — so it is
     evidence of monetization. The reverse does not hold: a monetized channel's individual
     video can be demonetized by a copyright claim or an advertiser-unfriendly flag, and
     live/ended streams behave differently again. Report the raw counts and let the caller
     decide; this is an inference, not a status YouTube publishes. */
  function adSignal(player) {
    const placements = Array.isArray(player.adPlacements) ? player.adPlacements : [];
    let forecasting = 0;
    let instream = 0;
    for (const p of placements) {
      const renderer = (p && p.adPlacementRenderer && p.adPlacementRenderer.renderer) || {};
      if (renderer.clientForecastingAdRenderer) forecasting++;
      if (renderer.instreamVideoAdRenderer) instream++;
    }
    return {
      placements: placements.length,
      forecasting,
      instream,
      isLive: !!(player.videoDetails && player.videoDetails.isLiveContent)
    };
  }

  /* playerMicroformatRenderer carries views, likes, publish time and category together, and
     it is already in the page — so views/hour and engagement cost nothing to compute. The
     like count is the one that matters here: it is not in videoDetails, and reading it from
     the DOM would mean parsing a localised, abbreviated button label. */
  function videoStats(player) {
    const mf = (player.microformat || {}).playerMicroformatRenderer || {};
    const n = (v) => {
      const parsed = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
      return isNaN(parsed) ? null : parsed;
    };
    const vd = player.videoDetails || {};
    return {
      views: n(mf.viewCount != null ? mf.viewCount : vd.viewCount),
      likes: n(mf.likeCount),
      publishDate: mf.publishDate || mf.uploadDate || '',
      category: mf.category || '',
      lengthSeconds: n(mf.lengthSeconds != null ? mf.lengthSeconds : vd.lengthSeconds),
      /* Which channel this video actually belongs to, taken from the live player response
         rather than the DOM. On a soft navigation the watch metadata element is reused and
         its channel link can still name the previous video's channel, which is how a
         monetization verdict carried over from one video to the next. */
      channelHandle: (String(mf.ownerProfileUrl || '').match(/@[\w.-]+/) || [''])[0],
      /* The channel's display name, which the page does not reliably render anywhere the
         content script can reach on Shorts — the overlay there labels the channel with its
         handle. Free, exact, and already in the response being read. */
      channelName: mf.ownerChannelName || vd.author || '',
      channelId: vd.channelId || mf.externalChannelId || '',
      // Real Shorts report isShortsEligible true (checked against 36s and 74s Shorts, and
      // against long videos which report false). The URL is definitive when it is present.
      shortsEligible: mf.isShortsEligible === true,
      shortsPath: /^\/shorts\//.test(location.pathname)
    };
  }

  /* Which video the caller is looking at, according to the address bar. Both URL shapes,
     because Shorts names the video in the path and watch pages in the query. */
  function currentVideoId() {
    const short = location.pathname.match(/\/shorts\/([\w-]{6,})/);
    if (short) return short[1];
    try { return new URL(location.href).searchParams.get('v') || ''; } catch (e) { return ''; }
  }

  function responseFrom(id) {
    const el = document.getElementById(id);
    if (!el || typeof el.getPlayerResponse !== 'function') return null;
    try {
      const live = el.getPlayerResponse();
      if (live && live.videoDetails && live.videoDetails.videoId) return live;
    } catch (e) {
      /* player not ready yet, or not the one driving this page */
    }
    return null;
  }

  /* ytInitialPlayerResponse is assigned when the document loads and is NOT reliably rewritten
     when YouTube navigates between videos without a reload — so on a soft navigation it can
     still describe the previous video, or a video the caller is no longer looking at. The
     player element answers for whatever is actually loaded right now, so ask it first and
     keep the global only as a fallback for the moments before the player exists.

     Shorts is served by a DIFFERENT player element, and this is why nothing here worked on
     it. `#movie_player` exists on a Shorts page — it is the long-form player, mounted and
     idle — and calling getPlayerResponse() on it THROWS rather than returning nothing, so the
     catch swallowed it and fell through to the global. On Shorts that global is null. Between
     them, every field this file reads came back empty on the format the reader is most likely
     to be researching. `#shorts-player` is the one actually playing, and it answers with the
     current Short even after scrolling to the next one.

     Both are asked, and an answer naming the video in the address bar wins outright — with
     two players mounted, "the first one that replies" is a coin toss. */
  const PLAYER_IDS = ['shorts-player', 'movie_player'];

  function currentPlayerResponse() {
    const wanted = currentVideoId();
    const answered = [];
    for (const id of PLAYER_IDS) {
      const live = responseFrom(id);
      if (!live) continue;
      if (wanted && live.videoDetails.videoId === wanted) return live;
      answered.push(live);
    }
    return answered[0] || window.ytInitialPlayerResponse || {};
  }

  /* The search page's own result list, straight from ytInitialData.

     The DOM only holds what YouTube has painted, and it paints as the reader scrolls — so a
     result sitting at position fifteen of twenty is simply absent until scrolled to, and any
     figure computed over "the first twenty results" was really over the first however-many it
     had drawn. Scrolling to a video with Ctrl-F and watching the highest-views figure jump is
     that gap showing.

     The payload has all of them before anything is painted, and carries exact view counts
     rather than the abbreviated "1.7M" the cards show. */
  function runs(node) {
    if (!node) return '';
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
    return '';
  }

  function exactViews(v) {
    // viewCountText is "1,701,369 views" on search; shortViewCountText is the rounded "1.7M".
    const raw = runs(v.viewCountText);
    const digits = raw.replace(/[^\d]/g, '');
    if (digits) return parseInt(digits, 10);
    return null;
  }

  /* The channel avatar, straight off the renderer. Search cards paint an avatar only for
     some results, so reading it from the DOM leaves every channel the page has not drawn
     yet with a placeholder — which is what the companion's channel list was showing. This
     costs nothing: the payload is already being walked. */
  function channelAvatar(v) {
    const link = (v.channelThumbnailSupportedRenderers || {}).channelThumbnailWithLinkRenderer;
    const thumbs = ((link || {}).thumbnail || {}).thumbnails;
    return (Array.isArray(thumbs) && thumbs.length && thumbs[0].url) || '';
  }

  /* Where the channel behind a result actually lives. The byline run carries the endpoint
     YouTube itself navigates to: canonicalBaseUrl is the "/@handle" form and browseId the
     "UC…" one, and a channel always has the second even when it has never claimed a handle.
     Written without the leading slash so it matches the keys read off the DOM, and the two
     sources can fill in for each other. */
  function channelKey(v) {
    const bylines = [v.ownerText, v.longBylineText, v.shortBylineText];
    for (const node of bylines) {
      for (const r of (node && node.runs) || []) {
        const b = ((r.navigationEndpoint || {}).browseEndpoint) || {};
        const base = (b.canonicalBaseUrl || '').replace(/^https?:\/\/[^/]+/, '');
        if (base) return base.replace(/^\//, '');
        if (/^UC/.test(b.browseId || '')) return 'channel/' + b.browseId;
      }
    }
    return '';
  }

  /* One walker, two callers: the initial payload below and each continuation batch further
     down. They carry the same renderers — a continuation response is literally the next slice
     of the list ytInitialData opened with — so parsing them twice would be two copies of the
     same code drifting apart the first time YouTube renames a field. */
  function collectVideos(node, out, seen, depth, cap) {
    if (!node || typeof node !== 'object' || depth > 14 || out.length >= cap) return;
    const v = node.videoRenderer;
    if (v && v.videoId && !seen[v.videoId]) {
      seen[v.videoId] = 1;
      out.push({
        id: v.videoId,
        title: runs(v.title),
        views: exactViews(v),
        published: runs(v.publishedTimeText),
        channel: runs(v.ownerText) || runs(v.longBylineText),
        chanKey: channelKey(v),
        avatar: channelAvatar(v),
        shorts: false
      });
    }
    /* Shorts arrive under their own renderers and are results like any other — whatever
       ranks for a term is what a creator is up against. */
    const r = node.reelItemRenderer;
    if (r && r.videoId && !seen[r.videoId]) {
      seen[r.videoId] = 1;
      out.push({
        id: r.videoId, title: runs(r.headline),
        views: exactViews({ viewCountText: r.viewCountText }),
        published: '', channel: '', chanKey: '', avatar: '', shorts: true
      });
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) collectVideos(node[i], out, seen, depth + 1, cap);
      return;
    }
    for (const key of Object.keys(node)) collectVideos(node[key], out, seen, depth + 1, cap);
  }

  /* Whether ytInitialData still describes what is on screen.
   *
   * window.ytInitialData is the payload the DOCUMENT loaded with. Typing a new search on a
   * results page that is already open does not reload the document — YouTube fetches the new
   * results over innertube and re-renders — so the global keeps describing the previous
   * query until something forces a reload. That is why everything sourced from it works after
   * a refresh and not after an in-page search.
   *
   * The content script already refuses a payload whose videos are not painted, which is why
   * the panel itself survives on the DOM alone. The continuation token had no such guard, and
   * a token belongs to the search that issued it — deep-reading with a stale one walks the
   * previous query's result pages while the panel reports them under the new term.
   *
   * The same overlap test settles both. This script runs in the page's world, so it can ask
   * the DOM directly: if none of the payload's videos are on screen, the payload is describing
   * a search the reader has moved on from.
   */
  function payloadMatchesPage(ids) {
    if (!ids || !ids.length) return false;
    let painted = 0;
    for (let i = 0; i < ids.length && painted < 3; i++) {
      if (document.querySelector('a[href*="' + ids[i] + '"]')) painted++;
    }
    // Three is the same floor the content script uses, and for the same reason: one shared
    // video can be a coincidence between two searches on a related subject.
    return painted >= Math.min(3, ids.length);
  }

  function searchPayloadIsCurrent() {
    const data = window.ytInitialData;
    if (!data || !/^\/results/.test(location.pathname)) return false;
    const out = [];
    try { collectVideos(data, out, Object.create(null), 0, 12); } catch (e) { return false; }
    return payloadMatchesPage(out.map((v) => v.id));
  }

  function searchResults() {
    const data = window.ytInitialData;
    if (!data || !/^\/results/.test(location.pathname)) return null;
    const out = [];
    try { collectVideos(data, out, Object.create(null), 0, 60); } catch (e) { return null; }
    if (!out.length) return null;
    // Withheld outright when it belongs to an earlier search, rather than handed over for the
    // content script to reject a moment later — the answer is the same and this one is honest
    // about why nothing came back.
    return payloadMatchesPage(out.map((v) => v.id)) ? out : null;
  }

  /* ------------------------------------------------- deep read (continuation chain)

     Scrolling a search page does not re-run the search. YouTube hands the page a bookmark —
     an opaque continuation token — and parks it in an invisible element at the foot of the
     list; when that element scrolls into view the page POSTs the token to /youtubei/v1/search
     and gets back the next slice plus a fresh token. The content script already fakes that
     scroll in the filter modal. This makes the request directly instead, which is the same
     call without moving the reader's page, repainting the results, or costing a Data API unit.

     Deliberately one batch per message rather than a chain run in here: the decision about
     when the results have stopped being about the search term needs termWords/titleOverlap,
     which live in the content script. This is the fetch; the policy is over there. */
  function continuationToken(node, depth) {
    if (!node || typeof node !== 'object' || depth > 16) return '';
    const cir = node.continuationItemRenderer;
    if (cir) {
      const cmd = (cir.continuationEndpoint || {}).continuationCommand || {};
      if (cmd.token) return cmd.token;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const t = continuationToken(node[i], depth + 1);
        if (t) return t;
      }
      return '';
    }
    for (const key of Object.keys(node)) {
      const t = continuationToken(node[key], depth + 1);
      if (t) return t;
    }
    return '';
  }

  /* The current query, as the address bar has it. The payload cannot be trusted for this —
     that is the whole problem — and the search box may hold something the reader typed but
     has not submitted. */
  function currentQuery() {
    try { return new URL(location.href).searchParams.get('search_query') || ''; }
    catch (e) { return ''; }
  }

  function innertube(cfg, key, ver, body) {
    return fetch('/youtubei/v1/search?prettyPrint=false' +
        (key ? '&key=' + encodeURIComponent(key) : ''), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': ver
      },
      body: JSON.stringify(body)
    }).then((res) => (res.ok
      ? res.json()
      : Promise.reject(new Error('HTTP ' + res.status))));
  }

  function ytContext(cfg, ver) {
    return { client: { clientName: 'WEB', clientVersion: ver,
                       hl: (cfg && cfg.get('HL')) || 'en',
                       gl: (cfg && cfg.get('GL')) || 'US' } };
  }

  function freshSearch(cfg, key, ver) {
    const q = currentQuery();
    if (!q) return Promise.resolve({ ok: false, reason: 'no query in the address bar' });
    if (!ver) return Promise.resolve({ ok: false, reason: 'no client version' });
    return innertube(cfg, key, ver, { context: ytContext(cfg, ver), query: q })
      .then((json) => {
        const out = [];
        collectVideos(json, out, Object.create(null), 0, 120);
        return { ok: true, rows: out, token: continuationToken(json, 0), refetched: true };
      })
      .catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
  }

  function deepStep(token) {
    if (!/^\/results/.test(location.pathname)) {
      return Promise.resolve({ ok: false, reason: 'not a search page' });
    }
    const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    const key = cfg ? cfg.get('INNERTUBE_API_KEY') || '' : '';
    const ver = cfg ? cfg.get('INNERTUBE_CLIENT_VERSION') || '' : '';
    // No token yet means "start where the painted page ends", which is the token sitting in
    // the payload the page loaded with.
    let next = token;
    if (!next) {
      /* Only from a payload that still describes this page. A token from the previous search
         is not the continuation of what the reader is looking at, and following it would
         return that search's later pages under this search's name. */
      if (searchPayloadIsCurrent()) {
        try { next = continuationToken(window.ytInitialData, 0); } catch (e) { next = ''; }
      }
      /* Nothing usable in the page's own payload, because the reader searched again without
         reloading and it still describes the previous query. Ask for this one instead: the
         same endpoint takes a query where it takes a continuation, and answers with the first
         page plus a token that genuinely continues it. One request, and it is the only way to
         start a deep read on a search the document never loaded. */
      if (!next) return freshSearch(cfg, key, ver);
    }
    if (!next) return Promise.resolve({ ok: false, reason: 'no continuation token' });
    if (!ver) return Promise.resolve({ ok: false, reason: 'no client version' });

    /* hl/gl from the page's own config rather than hardcoded: a reader on youtube.com in
       Germany is being shown German results, and asking for US ones would return a deeper
       list that is not the continuation of what is on their screen. */
    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: ver,
          hl: (cfg && cfg.get('HL')) || 'en',
          gl: (cfg && cfg.get('GL')) || 'US'
        }
      },
      continuation: next
    };
    return fetch('/youtubei/v1/search?prettyPrint=false' +
        (key ? '&key=' + encodeURIComponent(key) : ''), {
      method: 'POST',
      // Same origin, so this carries the reader's own session — which is the point. A
      // signed-out request from anywhere else ranks differently and would describe a page
      // nobody is looking at.
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': ver
      },
      body: JSON.stringify(body)
    }).then((res) => (res.ok
      ? res.json()
      : Promise.reject(new Error('HTTP ' + res.status)))
    ).then((json) => {
      const out = [];
      collectVideos(json, out, Object.create(null), 0, 120);
      return { ok: true, rows: out, token: continuationToken(json, 0) };
    }).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
  }

  function collect() {
    const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    const player = currentPlayerResponse();
    const tracklist = (player.captions || {}).playerCaptionsTracklistRenderer || {};
    return {
      ads: adSignal(player),
      stats: videoStats(player),
      // Bumped when the payload shape changes, so the content script can tell a stale
      // MAIN-world injection (which survives an extension reload in an open tab) from a
      // genuine read failure.
      v: 7,
      apiKey: cfg ? cfg.get('INNERTUBE_API_KEY') || '' : '',
      clientVersion: cfg ? cfg.get('INNERTUBE_CLIENT_VERSION') || '' : '',
      visitorData: cfg ? cfg.get('VISITOR_DATA') || '' : '',
      params: findTranscriptParams(window.ytInitialData, { n: 40000 }),
      search: searchResults(),
      videoId: (player.videoDetails || {}).videoId || '',
      captionTracks: (tracklist.captionTracks || []).map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind
      }))
    };
  }

  window.addEventListener('message', (event) => {
    // Reject a mismatched source (an iframe), but tolerate environments that leave it unset.
    if (event.source && event.source !== window) return;
    const data = event.data;
    if (!data) return;
    if (data.type === 'YTC_PAGE_REQUEST') {
      let payload = null;
      try { payload = collect(); } catch (e) { payload = null; }
      window.postMessage({ type: 'YTC_PAGE_DATA', id: data.id, payload }, '*');
      return;
    }
    if (data.type === 'YTC_DEEP_REQUEST') {
      // Answers on its own timing rather than same-tick: this one is a network round trip.
      deepStep(String(data.token || '')).then((payload) => {
        window.postMessage({ type: 'YTC_DEEP_DATA', id: data.id, payload }, '*');
      }).catch((e) => {
        window.postMessage({ type: 'YTC_DEEP_DATA', id: data.id,
          payload: { ok: false, reason: String((e && e.message) || e) } }, '*');
      });
    }
  });
})();
