/* Sentence embeddings for comments: all-MiniLM-L6-v2 on ONNX Runtime's WebAssembly backend.

   Each comment becomes a 384-number vector; two comments that mean the same thing ("is that
   cop still employed?", "was the officer ever fired") land close together even when they
   share no words. That closeness is all the grouping needs.

   The tokenizer (wordpiece.mjs) is shared with the feedback model. */
import * as ort from './ort.wasm.min.mjs';
import { makeTokenizer } from './wordpiece.mjs';

const HERE = new URL('./', import.meta.url).href;
ort.env.wasm.wasmPaths = HERE;
// One thread: extension pages aren't cross-origin isolated, so SharedArrayBuffer (and with
// it ONNX Runtime's thread pool) isn't available.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const MAX_TOKENS = 128;     // comments past this are rare; the opening carries the meaning
const BATCH = 16;

let session = null;
let tok = null;

/* ---- loading ---- */

export async function load(files) {
  if (session) return;
  tok = makeTokenizer(files.vocab);
  session = await ort.InferenceSession.create(new Uint8Array(files.model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
}

export function loaded() {
  return !!session;
}

/* ---- embedding ---- */

/* Mean of the token vectors (padding excluded), scaled to length 1, as sentence-transformers
   does for this model. Unit length makes cosine similarity a plain dot product. */
export async function embed(texts) {
  // Shortest first, in batches of similar length, for the reason given in sentiment.mjs.
  const enc = texts.map((t) => tok.encode(t, MAX_TOKENS));
  const order = enc.map((_, i) => i).sort((a, b) => enc[a].length - enc[b].length);
  const out = new Array(texts.length);
  for (let b = 0; b < order.length; b += BATCH) {
    const idx = order.slice(b, b + BATCH);
    const L = Math.max(...idx.map((i) => enc[i].length));
    const n = idx.length;
    const ids = new BigInt64Array(n * L);
    const mask = new BigInt64Array(n * L);
    idx.forEach((i, r) => enc[i].forEach((id, j) => { ids[r * L + j] = BigInt(id); mask[r * L + j] = 1n; }));
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [n, L]),
      attention_mask: new ort.Tensor('int64', mask, [n, L]),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(n * L), [n, L])
    };
    const result = await session.run(feeds);
    const hidden = (result.last_hidden_state || result[session.outputNames[0]]);
    const D = hidden.dims[2];
    const data = hidden.data;
    idx.forEach((i, r) => {
      const v = new Float32Array(D);
      let count = 0;
      for (let j = 0; j < L; j++) {
        if (!mask[r * L + j]) continue;
        count++;
        const off = (r * L + j) * D;
        for (let k = 0; k < D; k++) v[k] += data[off + k];
      }
      let norm = 0;
      for (let k = 0; k < D; k++) { v[k] /= count; norm += v[k] * v[k]; }
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < D; k++) v[k] /= norm;
      out[i] = v;
    });
  }
  return out;
}
