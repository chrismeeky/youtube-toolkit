/* Chrome only: relays "run this model on these comments" from the service worker to the model worker.
   Floats go back as a plain array, since extension messages are JSON. */
(function () {
  'use strict';

  const worker = new Worker('worker.mjs', { type: 'module' });
  const pending = new Map();

  worker.onmessage = (e) => {
    const done = pending.get(e.data && e.data.id);
    if (!done) return;
    pending.delete(e.data.id);
    done(e.data.ok
      ? { ok: true, dims: e.data.dims, vecs: Array.from(e.data.flat) }
      : { ok: false, reason: e.data.reason });
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'ytc-ml-host') return;
    const id = Math.random().toString(36).slice(2);
    pending.set(id, sendResponse);
    worker.postMessage({ id, task: msg.task || 'embed', texts: msg.texts || [] });
    return true;
  });
})();
