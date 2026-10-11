/* Fills the composer on ChatGPT, Claude and Gemini with a prompt the toolkit just built.
 *
 * Why a content script at all. A prompt can reach those pages three ways, and the other two
 * are worse: a ?q= URL parameter is capped by what a URL can carry and, on Claude, raises a
 * security banner that is right to be there — a URL-supplied prompt really could have been
 * planted by whoever wrote the link. The clipboard has neither problem but ends in "now press
 * paste", which is a step the reader did not ask for. Typing it in locally is the same thing
 * the reader would do by hand, so it carries no length limit and no banner.
 *
 * The prompt is handed over through chrome.storage rather than through the URL, so nothing
 * about it is ever visible in the address bar, in history, or to the site before this runs.
 */
(function () {
  'use strict';

  const KEY = 'ytcPendingPrompt';
  /* A handover older than this is stale: the tab it was meant for never opened, or opened and
     was closed. Without an expiry, a prompt generated on Monday would drop itself into the
     next Claude tab opened on Friday. */
  const MAX_AGE = 2 * 60 * 1000;
  /* These pages build their composer after the shell paints, and a cold load behind a slow
     connection can take a while. Long enough to cover that, short enough that a failed find
     does not leave an observer running for the life of the tab. */
  const WAIT_MS = 20000;

  function viewportH() {
    return window.innerHeight || document.documentElement.clientHeight || 800;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    // On screen, and big enough to be a composer rather than a search box or a rename field.
    return r.width > 120 && r.height > 20 && r.bottom > 0 && r.top < viewportH();
  }

  /* Found by shape, not by selector, for the reason the rest of this extension keeps
     repeating: all three products rename and restructure their DOM without notice, and a
     pinned id — #prompt-textarea, .ql-editor, div.ProseMirror — turns into a silent no-op the
     week it changes. What a composer IS: the largest editable thing on the page, sitting low
     in the window. That has been true across every redesign of all three. */
  /* Two keys, compared in order, rather than one blended score. The first attempt added area
     to a position term and the area swamped it — on a page with any transcript above the
     composer, a 700x300 block of conversation outscored the 760x56 box at the foot every
     time. Nearness to the bottom decides it; size only breaks ties between things sitting at
     the same height. */
  const SAME_ROW = 8;   // px, within which two elements count as equally low

  function findComposer() {
    const nodes = document.querySelectorAll(
      'textarea:not([readonly]):not([disabled]), [contenteditable="true"]');
    const vh = viewportH();
    let best = null;
    let bestGap = Infinity;
    let bestArea = 0;
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      const gap = Math.abs(vh - r.bottom);
      const area = r.width * r.height;
      const lower = gap < bestGap - SAME_ROW;
      const tied = Math.abs(gap - bestGap) <= SAME_ROW && area > bestArea;
      if (lower || tied) { best = el; bestGap = gap; bestArea = area; }
    }
    return best;
  }

  function waitForComposer() {
    return new Promise((resolve) => {
      const first = findComposer();
      if (first) { resolve(first); return; }
      let done = false;
      const finish = (el) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(el);
      };
      const obs = new MutationObserver(() => {
        const el = findComposer();
        if (el) finish(el);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(null), WAIT_MS);
    });
  }

  /* React and ProseMirror both ignore a value assigned straight onto the element: React tracks
     the last value it set and skips the change as a no-op, and ProseMirror keeps its own
     document that innerHTML never touches. So each kind of field is filled the way a keyboard
     would fill it, and the editor's own machinery does the rest. */
  function fillTextarea(el, text) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillEditable(el, text) {
    el.focus();
    // Replace whatever is there rather than appending to a draft the reader left behind.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    /* Deprecated, and still the only call that inserts text into a contenteditable through
       the same path a keypress takes — which is what makes ProseMirror and Quill register it
       as real input rather than as foreign DOM they will discard on the next transaction. */
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      /* Last resort. Paragraph per line, because a bare textContent write collapses the
         prompt into one block on editors that key their line breaks off block elements. */
      el.textContent = '';
      const frag = document.createDocumentFragment();
      text.split('\n').forEach((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        frag.appendChild(p);
      });
      el.appendChild(frag);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text,
                                                 inputType: 'insertText' }));
    }
  }

  function fill(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') fillTextarea(el, text);
    else fillEditable(el, text);
    el.focus();
    /* Deliberately not submitted. The reader asked for the prompt to be put in the box, and
       sending it is a decision they may want to make after reading it — an auto-send that
       fires on a half-built composer is unrecoverable, where an unsent prompt costs one key. */
  }

  /* An image handed over with the prompt ("Why did this work?" sends its thumbnails), attached
     the ways a person would: pasted into the composer, then the page's own file input, then
     dropped on the composer. Each is tried only if the one before wasn't taken: a site that
     handles a paste cancels the event, which is how its acceptance is read. */
  function dataUrlToFile(url, name) {
    const comma = url.indexOf(',');
    const type = (url.slice(0, comma).match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'image', { type: type });
  }

  function attachImage(el, url, name) {
    let file;
    try { file = dataUrlToFile(url, name); } catch (e) { return false; }
    const transfer = () => { const dt = new DataTransfer(); dt.items.add(file); return dt; };

    try {
      const ev = new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true });
      if (ev.clipboardData && ev.clipboardData.files.length) {
        el.focus();
        el.dispatchEvent(ev);
        if (ev.defaultPrevented) return true;
      }
    } catch (e) { /* no constructible ClipboardEvent here */ }

    const input = Array.from(document.querySelectorAll('input[type="file"]'))
      .find((i) => !i.disabled && (!i.accept || /image|\*/.test(i.accept)));
    if (input) {
      try {
        input.files = transfer().files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (e) { /* read-only files in this browser */ }
    }

    try {
      const opts = () => ({ dataTransfer: transfer(), bubbles: true, cancelable: true });
      el.dispatchEvent(new DragEvent('dragenter', opts()));
      el.dispatchEvent(new DragEvent('dragover', opts()));
      const drop = new DragEvent('drop', opts());
      el.dispatchEvent(drop);
      return drop.defaultPrevented;
    } catch (e) {
      return false;
    }
  }

  function run() {
    let store;
    try { store = chrome.storage && chrome.storage.local; } catch (e) { return; }
    if (!store) return;
    store.get(KEY, (got) => {
      if (chrome.runtime.lastError) return;
      const pending = got && got[KEY];
      if (!pending || !pending.text) return;
      if (!pending.t || Date.now() - pending.t > MAX_AGE) {
        store.remove(KEY);
        return;
      }
      /* Cleared before the composer is even found, not after filling it. A tab that is closed
         mid-wait, or a page that never builds a composer, must not leave the prompt sitting
         there to be dropped into the next one opened. */
      store.remove(KEY);
      waitForComposer().then((el) => {
        if (!el) return;
        fill(el, pending.text);
        // A moment for the editor to settle on the new text before the attachment arrives.
        if (pending.image) setTimeout(() => attachImage(el, pending.image, pending.imageName), 400);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
