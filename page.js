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

  function collect() {
    const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    const player = window.ytInitialPlayerResponse || {};
    const tracklist = (player.captions || {}).playerCaptionsTracklistRenderer || {};
    return {
      ads: adSignal(player),
      apiKey: cfg ? cfg.get('INNERTUBE_API_KEY') || '' : '',
      clientVersion: cfg ? cfg.get('INNERTUBE_CLIENT_VERSION') || '' : '',
      visitorData: cfg ? cfg.get('VISITOR_DATA') || '' : '',
      params: findTranscriptParams(window.ytInitialData, { n: 40000 }),
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
