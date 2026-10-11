/* BERT's uncased WordPiece tokenizer, shared by both comment models (they use the same
   30,522-token vocabulary). Written out rather than pulled in from a library: it is a few
   dozen lines, and the library that ships it is ten times the size of everything else here. */

function isPunct(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
  return /\p{P}/u.test(ch);
}

function isCjk(c) {
  return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x20000 && c <= 0x2A6DF) ||
    (c >= 0x2A700 && c <= 0x2B73F) || (c >= 0x2B740 && c <= 0x2B81F) || (c >= 0x2B820 && c <= 0x2CEAF) ||
    (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x2F800 && c <= 0x2FA1F);
}

function basicTokens(text) {
  // Clean, lower-case, strip accents, then split on whitespace and around punctuation and CJK.
  let t = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0 || c === 0xFFFD || (/\p{Cc}/u.test(ch) && !/\s/.test(ch))) continue;
    t += isCjk(c) ? ' ' + ch + ' ' : /\s/.test(ch) ? ' ' : ch;
  }
  t = t.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  const out = [];
  for (const word of t.split(' ')) {
    if (!word) continue;
    let cur = '';
    for (const ch of word) {
      if (isPunct(ch)) { if (cur) out.push(cur); out.push(ch); cur = ''; } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function wordPiece(vocab, word) {
  if (word.length > 100) return [vocab.get('[UNK]')];
  const ids = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found = null;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + word.slice(start, end);
      if (vocab.has(piece)) { found = vocab.get(piece); break; }
      end--;
    }
    if (found == null) return [vocab.get('[UNK]')];
    ids.push(found);
    start = end;
  }
  return ids;
}

function encodeWith(vocab, text, max) {
  const ids = [vocab.get('[CLS]')];
  for (const w of basicTokens(String(text || ''))) {
    for (const id of wordPiece(vocab, w)) {
      if (ids.length >= max - 1) break;
      ids.push(id);
    }
    if (ids.length >= max - 1) break;
  }
  ids.push(vocab.get('[SEP]'));
  return ids;
}


export function makeTokenizer(vocabText) {
  const vocab = new Map();
  vocabText.split('\n').forEach((tok, i) => { const t = tok.replace(/\r$/, ''); if (t) vocab.set(t, i); });
  const pieces = (text) => {
    const out = [];
    for (const w of basicTokens(String(text || ''))) out.push(...wordPiece(vocab, w));
    return out;
  };
  return {
    // [CLS] text [SEP]
    encode: (text, max) => encodeWith(vocab, text, max),
    /* [CLS] a [SEP] b [SEP], with segment ids 0 then 1. The first text is cut to fit, never
       the second: here the second is the short hypothesis the whole question rests on. */
    encodePair(a, b, max) {
      const B = pieces(b);
      const A = pieces(a).slice(0, Math.max(1, max - B.length - 3));
      const ids = [vocab.get('[CLS]'), ...A, vocab.get('[SEP]'), ...B, vocab.get('[SEP]')];
      const types = ids.map((_, i) => (i <= A.length + 1 ? 0 : 1));
      return { ids, types };
    }
  };
}
