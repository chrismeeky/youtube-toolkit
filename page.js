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
      channelId: vd.channelId || mf.externalChannelId || '',
      // Real Shorts report isShortsEligible true (checked against 36s and 74s Shorts, and
      // against long videos which report false). The URL is definitive when it is present.
      shortsEligible: mf.isShortsEligible === true,
      shortsPath: /^\/shorts\//.test(location.pathname)
    };
  }

  /* ytInitialPlayerResponse is assigned when the document loads and is NOT reliably rewritten
     when YouTube navigates between videos without a reload — so on a soft navigation it can
     still describe the previous video, or a video the caller is no longer looking at. The
     player element answers for whatever is actually loaded right now, so ask it first and
     keep the global only as a fallback for the moments before the player exists. */
  function currentPlayerResponse() {
    const el = document.getElementById('movie_player');
    if (el && typeof el.getPlayerResponse === 'function') {
      try {
        const live = el.getPlayerResponse();
        if (live && live.videoDetails && live.videoDetails.videoId) return live;
      } catch (e) {
        /* player not ready yet — fall through to the global */
      }
    }
    return window.ytInitialPlayerResponse || {};
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

  function searchResults() {
    const data = window.ytInitialData;
    if (!data || !/^\/results/.test(location.pathname)) return null;
    const out = [];
    const seen = Object.create(null);
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 14 || out.length >= 60) return;
      const v = node.videoRenderer;
      if (v && v.videoId && !seen[v.videoId]) {
        seen[v.videoId] = 1;
        out.push({
          id: v.videoId,
          title: runs(v.title),
          views: exactViews(v),
          published: runs(v.publishedTimeText),
          channel: runs(v.ownerText) || runs(v.longBylineText),
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
          published: '', channel: '', shorts: true
        });
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    };
    try { walk(data, 0); } catch (e) { return null; }
    return out.length ? out : null;
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
      v: 3,
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
    if (!data || data.type !== 'YTC_PAGE_REQUEST') return;
    let payload = null;
    try { payload = collect(); } catch (e) { payload = null; }
    window.postMessage({ type: 'YTC_PAGE_DATA', id: data.id, payload }, '*');
  });
})();
