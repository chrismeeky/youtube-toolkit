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

  function collect() {
    const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    const player = window.ytInitialPlayerResponse || {};
    const tracklist = (player.captions || {}).playerCaptionsTracklistRenderer || {};
    return {
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
