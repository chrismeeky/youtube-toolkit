/* Comment tone: cardiffnlp/twitter-roberta-base-sentiment-latest (negative / neutral /
   positive), trained on ~124M tweets. Picked over general sentiment models because comments
   are written like tweets: "Video B was insane", "Tim killed it", "that tiger scene is crazy"
   are praise, and a model trained on reviews or news reads them as complaints.

   RoBERTa uses GPT-2's byte-level BPE, not WordPiece, so it has its own tokenizer below:
   text is split GPT-2's way, each byte mapped to a printable character, then pairs merged in
   the order merges.txt ranks them. */
import * as ort from './ort.wasm.min.mjs';

const HERE = new URL('./', import.meta.url).href;
ort.env.wasm.wasmPaths = HERE;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const MAX_TOKENS = 96;      // tone is set early in a comment; the tail rarely changes it
const BATCH = 16;
const BOS = 0, PAD = 1, EOS = 2;

let session = null;
let encoder = null;           // token string -> id
let ranks = null;             // "a b" -> merge rank
const cache = new Map();

/* ---- byte-level BPE (GPT-2) ---- */

const BYTE_TO_CHAR = (() => {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const map = new Array(256);
  bs.forEach((b, i) => { map[b] = String.fromCharCode(cs[i]); });
  return map;
})();

const SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
const UTF8 = new TextEncoder();

function bpe(token) {
  if (cache.has(token)) return cache.get(token);
  let word = Array.from(token);
  while (word.length > 1) {
    let best = null, bestRank = Infinity;
    for (let i = 0; i < word.length - 1; i++) {
      const r = ranks.get(word[i] + ' ' + word[i + 1]);
      if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
    }
    if (best === null) break;
    const a = word[best], b = word[best + 1];
    const next = [];
    for (let i = 0; i < word.length;) {
      if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { next.push(a + b); i += 2; } else { next.push(word[i]); i++; }
    }
    word = next;
  }
  cache.set(token, word);
  return word;
}

function encode(text) {
  const ids = [BOS];
  for (const piece of String(text).match(SPLIT) || []) {
    const mapped = Array.from(UTF8.encode(piece), (b) => BYTE_TO_CHAR[b]).join('');
    for (const t of bpe(mapped)) {
      const id = encoder[t];
      if (id !== undefined) ids.push(id);
      if (ids.length >= MAX_TOKENS - 1) break;
    }
    if (ids.length >= MAX_TOKENS - 1) break;
  }
  ids.push(EOS);
  return ids;
}

// The model's own preprocessing: usernames and links were masked in its training data.
function prepare(text) {
  return String(text || '').split(/\s+/).map((w) =>
    (w.startsWith('@') && w.length > 1 ? '@user' : w.startsWith('http') ? 'http' : w)).join(' ');
}

/* ---- loading ---- */

export async function load(files) {
  if (session) return;
  encoder = JSON.parse(files.vocab);
  ranks = new Map();
  files.merges.split('\n').forEach((line, i) => {
    if (i === 0 && line.startsWith('#')) return;
    const t = line.trim();
    if (t) ranks.set(t, ranks.size);
  });
  session = await ort.InferenceSession.create(new Uint8Array(files.model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
}

export function loaded() {
  return !!session;
}

/* [negative, neutral, positive] probabilities for each text, in the order given.

   Run shortest first, in batches of similar length: a batch is padded to its longest
   comment, so mixing a ten-word comment with a hundred-word one makes the short one cost as
   much as the long. Sorting cut 300 comments from minutes to seconds. */
export async function tone(texts) {
  const enc = texts.map((t) => encode(prepare(t)));
  const order = enc.map((_, i) => i).sort((a, b) => enc[a].length - enc[b].length);
  const out = new Array(texts.length);
  for (let b = 0; b < order.length; b += BATCH) {
    const idx = order.slice(b, b + BATCH);
    const L = Math.max(...idx.map((i) => enc[i].length));
    const n = idx.length;
    const ids = new BigInt64Array(n * L).fill(BigInt(PAD));
    const mask = new BigInt64Array(n * L);
    idx.forEach((i, r) => enc[i].forEach((id, j) => { ids[r * L + j] = BigInt(id); mask[r * L + j] = 1n; }));
    const res = await session.run({
      input_ids: new ort.Tensor('int64', ids, [n, L]),
      attention_mask: new ort.Tensor('int64', mask, [n, L])
    });
    const logits = res.logits || res[session.outputNames[0]];
    idx.forEach((i, r) => {
      const z = Array.from(logits.data.slice(r * 3, r * 3 + 3));
      const m = Math.max(...z);
      const e = z.map((x) => Math.exp(x - m));
      const sum = e[0] + e[1] + e[2];
      out[i] = e.map((x) => x / sum);
    });
  }
  return out;
}
