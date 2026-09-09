/* Popup: what is left once the settings moved onto the page.
 *
 * The settings form used to live here, which meant it could only be reached by pinning the
 * extension — and most people never pin anything. It is now a modal opened from a button in
 * YouTube's own masthead, reading and writing the same sync keys, so nothing was migrated and
 * both surfaces would still agree if the old popup came back.
 *
 * What stays is what a popup is genuinely better at: acting on the tab you are looking at,
 * and showing the pocket watch, which answers "has anything I follow gone off while I was
 * elsewhere" — a question you ask precisely when you are not on YouTube.
 */
(function () {
  'use strict';

  const F = window.YTCopyFormat;
  const $ = (id) => document.getElementById(id);

  /* ---- pocket watch ---- */

  /* The one panel worth having here rather than on the page: it answers "has anything I am
     watching gone off while I was elsewhere", which is a question you ask precisely when you
     are not on YouTube. Everything else the popup used to hold has moved to the on-page
     modal, where it can be reached without pinning anything. */
  const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);

  const esc = (t) => String(t).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ago(stamp) {
    const ms = Date.now() - (Date.parse(stamp) || 0);
    if (!stamp || ms < 0) return '';
    const h = Math.floor(ms / 3600000);
    if (h < 1) return Math.max(1, Math.floor(ms / 60000)) + 'm ago';
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function renderWatch(hits, meta) {
    const box = $('watchList');
    const note = $('watchMeta');
    if (!box || !note) return;

    if (!hits.length) {
      box.innerHTML = '';
      /* Three silences worth telling apart, and only the last is about the channels. */
      note.textContent = !meta.ran
        ? 'Not checked yet. Pocket a few channels, then press Check now.'
        : (meta.total === 0
          ? 'No pocketed channels yet — save some with the Pocket button on a channel page.'
          : 'Nothing beating its channel average in the last week, across ' +
            (meta.total || 0) + ' pocketed channel' + (meta.total === 1 ? '' : 's') + '.');
      return;
    }

    const unseen = hits.filter((h) => !h.seen).length;
    note.textContent = unseen + ' new of ' + hits.length + ' · last checked ' +
      (meta.ran ? ago(new Date(meta.ran).toISOString()) : 'never');

    box.innerHTML = '<div class="watch">' + hits.slice(0, 25).map((h) =>
      '<a class="watch__row' + (h.seen ? ' seen' : '') +
        '" href="https://www.youtube.com/watch?v=' + esc(h.videoId) + '" target="_blank" ' +
        'rel="noopener noreferrer" data-vid="' + esc(h.videoId) + '">' +
        '<span class="watch__t">' + esc(h.title) + '</span>' +
        '<span class="watch__m">' +
          '<span class="watch__x">' + h.ratio + '\u00d7</span>' +
          esc(h.channelTitle) + ' · ' + compact(h.views) + ' views · ' + ago(h.publishedAt) +
        '</span>' +
      '</a>').join('') + '</div>';
  }

  function loadWatch() {
    chrome.runtime.sendMessage({ type: 'ytc-watch-list' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      /* Through the same filter the page and the badge use, so all three agree about what
         counts as new — the thresholds live in format.js for exactly this reason. */
      const visible = F.watchVisible(res.hits || [], res.prefs || {});
      renderWatch(visible, res.meta || {});
    });
  }

  if ($('watchRun')) {
    $('watchRun').addEventListener('click', () => {
      const btn = $('watchRun');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      chrome.runtime.sendMessage({ type: 'ytc-watch-run' }, (res) => {
        btn.disabled = false;
        btn.textContent = 'Check now';
        if (chrome.runtime.lastError) { status('Could not reach the extension'); return; }
        if (res && res.ok) {
          status(res.checked
            ? 'Checked ' + res.checked + ' channel' + (res.checked === 1 ? '' : 's') +
              ', ' + res.found + ' new'
            : 'No pocketed channels to check');
        } else {
          status((res && res.reason) || 'Check failed');
        }
        loadWatch();
      });
    });
  }

  /* Opening a hit is what marks it read, so the toolbar badge always counts exactly what is
     still unopened in this list. */
  if ($('watchList')) {
    $('watchList').addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('[data-vid]');
      if (!row) return;
      chrome.runtime.sendMessage({ type: 'ytc-watch-seen', videoId: row.dataset.vid },
        () => { if (!chrome.runtime.lastError) loadWatch(); });
    });
  }

  loadWatch();

  function status(msg) {
    $('status').textContent = msg;
    setTimeout(() => { $('status').textContent = ''; }, 2500);
  }

  async function sendToTab(payload) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { status('No active tab'); return null; }
    // tab.url is only populated when we hold host permission for it; if it is missing,
    // don't guess — let sendMessage decide whether the content script is there.
    if (tab.url && !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url)) {
      status('Open a YouTube page first');
      return null;
    }
    try {
      const res = await chrome.tabs.sendMessage(tab.id, payload);
      if (res) res.tabId = tab.id;
      return res;
    } catch (e) {
      status(/youtube\.com/.test(tab.url || '') || !tab.url
        ? 'Reload the YouTube tab, then retry'
        : 'Open a YouTube page first');
      return null;
    }
  }

  $('selectMode').addEventListener('click', async () => {
    const res = await sendToTab({ type: 'ytc-toggle-select' });
    if (res) { status(res.selectMode ? 'Select mode on' : 'Select mode off'); window.close(); }
  });

  $('copyPage').addEventListener('click', async () => {
    const res = await sendToTab({ type: 'ytc-copy-page', returnText: true });
    if (!res) return;
    if (!res.count) { status('No videos found on that page'); return; }
    try {
      await navigator.clipboard.writeText(res.text);
      status(`Copied ${res.count} video${res.count === 1 ? '' : 's'}`);
      chrome.tabs.sendMessage(res.tabId, {
        type: 'ytc-toast',
        text: `Copied ${res.count} video${res.count === 1 ? '' : 's'}`
      }).catch(() => {});
    } catch (e) {
      status('Clipboard blocked — try again');
    }
  });

  $('clearSubs').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ytc-clear-subs' }, (res) => {
      status(res ? `Cleared ${res.cleared} cached channel${res.cleared === 1 ? '' : 's'}` : 'Cache cleared');
    });
  });

  /* No settings form here any more — it lives in the on-page Toolkit modal, where it can be
     reached without pinning the extension. Storage is untouched by that move: both surfaces
     read and write the same sync keys, so nothing had to be migrated and an older popup would
     still work against it. */
})();
