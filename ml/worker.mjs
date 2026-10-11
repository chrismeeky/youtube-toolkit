/* Runs the comment models off the page's thread. Hosted by ml/host.html in Chrome (whose
   service worker can't load the runtime: no dynamic import there) and by the background page
   in Firefox. The files come from the extension's own cache, where the service worker put
   them after checking their hashes; this never touches the network.

   task 'embed': a 384-number vector per comment (all-MiniLM-L6-v2).
   task 'tone':  [negative, neutral, positive] per comment (twitter-roberta). */
import './model.js';
import * as E from './embed.mjs';
import * as T from './sentiment.mjs';

async function files(key) {
  const spec = self.YTCModels[key];
  const cache = await caches.open(spec.CACHE);
  const out = {};
  for (const f of spec.FILES) {
    const res = await cache.match(f.url);
    if (!res) throw new Error(spec.label + ' not downloaded');
    out[f.key] = f.key === 'model' ? await res.arrayBuffer() : await res.text();
  }
  return out;
}

self.onmessage = async (e) => {
  const { id, texts } = e.data || {};
  const task = (e.data && e.data.task) || 'embed';
  try {
    let vecs;
    if (task === 'tone') {
      if (!T.loaded()) await T.load(await files('tone'));
      vecs = await T.tone(texts || []);
    } else {
      if (!E.loaded()) await E.load(await files('embed'));
      vecs = await E.embed(texts || []);
    }
    const dims = vecs.length ? vecs[0].length : 0;
    const flat = new Float32Array(vecs.length * dims);
    vecs.forEach((v, i) => flat.set(v, i * dims));
    self.postMessage({ id, ok: true, dims, flat }, [flat.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, reason: String((err && err.message) || err) });
  }
};
