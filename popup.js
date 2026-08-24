/* Popup: settings, live preview, and page-level actions. */
(function () {
  'use strict';

  const F = window.YTCopyFormat;
  const $ = (id) => document.getElementById(id);
  let settings = F.merge(null);

  const TOGGLES = ['csvHeader', 'numericViews', 'absoluteDate', 'quoteTitle', 'showButtons',
    'toast', 'showSubs', 'showRatio', 'showMoney', 'showThumb', 'showTranscript',
    'transcriptTimestamps', 'transcriptSave'];

  function buildFieldChecks() {
    $('fields').innerHTML = F.FIELD_ORDER.map(
      (key) =>
        `<label class="check"><input type="checkbox" data-field="${key}" />` +
        `<span>${F.FIELD_LABELS[key]}</span></label>`
    ).join('');
  }

  function buildSelects() {
    $('layout').innerHTML = F.LAYOUTS.map(
      (o) => `<option value="${o.value}">${o.label}</option>`
    ).join('');
    $('separator').innerHTML = F.SEPARATORS.map(
      (o) => `<option value="${encodeURIComponent(o.value)}">${o.label}</option>`
    ).join('');
  }

  function render() {
    for (const key of F.FIELD_ORDER) {
      const box = document.querySelector(`[data-field="${key}"]`);
      if (box) box.checked = !!settings.fields[key];
    }
    $('layout').value = settings.layout;
    $('separator').value = encodeURIComponent(settings.separator);
    $('customTemplate').value = settings.customTemplate;
    $('helperUrl').value = settings.helperUrl;
    for (const id of TOGGLES) $(id).checked = !!settings[id];

    const isCustom = settings.layout === 'custom';
    const isCsv = settings.layout === 'csv';
    const usesSeparator = ['plain', 'bullet', 'numbered'].includes(settings.layout);
    $('tpl-row').classList.toggle('hidden', !isCustom);
    $('tpl-hint').classList.toggle('hidden', !isCustom);
    $('csv-row').classList.toggle('hidden', !isCsv);
    $('sep-row').classList.toggle('hidden', !usesSeparator);

    $('preview').textContent = F.formatList(F.SAMPLE, settings) || '(nothing selected)';
  }

  function save() {
    chrome.storage.sync.set(settings);
    render();
  }

  function readForm() {
    for (const key of F.FIELD_ORDER) {
      const box = document.querySelector(`[data-field="${key}"]`);
      if (box) settings.fields[key] = box.checked;
    }
    settings.layout = $('layout').value;
    settings.separator = decodeURIComponent($('separator').value);
    settings.customTemplate = $('customTemplate').value;
    settings.helperUrl = $('helperUrl').value.trim();
    for (const id of TOGGLES) settings[id] = $(id).checked;
  }

  document.addEventListener('input', (e) => {
    if (e.target.closest('.group')) { readForm(); save(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.closest('.group')) { readForm(); save(); }
  });

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

  $('testHelper').addEventListener('click', async () => {
    const base = ($('helperUrl').value || '').trim().replace(/\/$/, '');
    if (!base) { status('Set a helper URL first'); return; }
    status('Checking…');
    try {
      const res = await fetch(base + '/health');
      const data = await res.json();
      status(data.ok ? `Helper running (yt-dlp ${data.ytdlp || '?'})` : 'Helper up, yt-dlp missing');
    } catch (e) {
      status('Helper not running');
    }
  });

  $('clearSubs').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ytc-clear-subs' }, (res) => {
      status(res ? `Cleared ${res.cleared} cached channel${res.cleared === 1 ? '' : 's'}` : 'Cache cleared');
    });
  });

  buildFieldChecks();
  buildSelects();
  chrome.storage.sync.get(null, (saved) => {
    settings = F.merge(saved);
    render();
  });
})();
