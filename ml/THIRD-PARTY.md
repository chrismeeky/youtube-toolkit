# Third-party code and data in ml/

## ONNX Runtime Web 1.30.0 — MIT License

Copyright (c) Microsoft Corporation.

`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm` are copied
unmodified from the npm package `onnxruntime-web@1.30.0`, `dist/` folder:
https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz
Source: https://github.com/microsoft/onnxruntime (tag v1.30.0)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Downloaded on request (not bundled)

Neither model is in the package. Each is downloaded only when the user asks, from Hugging Face,
pinned to one commit, and checked against these SHA-256 hashes before use. The full list,
with sizes and hashes, is in `model.js`.

### all-MiniLM-L6-v2 — Apache License 2.0

- Repository: https://huggingface.co/Xenova/all-MiniLM-L6-v2 (ONNX export of
  sentence-transformers/all-MiniLM-L6-v2)
- Commit: 751bff37182d3f1213fa05d7196b954e230abad9
- `onnx/model_quantized.onnx` — 22,972,370 bytes —
  `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
- `vocab.txt` — 231,508 bytes —
  `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3`

### twitter-roberta-base-sentiment-latest — Creative Commons Attribution 4.0

By Cardiff NLP (Loureiro, Barbieri, Neves, Espinosa Anke, Camacho-Collados, "TimeLMs:
Diachronic Language Models from Twitter", ACL 2022). Credited in the Feedback panel.

- Repository: https://huggingface.co/Xenova/twitter-roberta-base-sentiment-latest (ONNX export
  of cardiffnlp/twitter-roberta-base-sentiment-latest)
- Commit: f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445
- `onnx/model_quantized.onnx` — 125,905,426 bytes —
  `046f7e4cc46b399558fa9b2de966f6b0d42c69e4b01f582bfb4099b01a0bb5d7`
- `vocab.json` — 798,293 bytes —
  `ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e`
- `merges.txt` — 456,318 bytes —
  `1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5`

## target.json (bundled data, ours)

Weights of a three-way linear classifier (about the video / about its story / other) over
all-MiniLM-L6-v2 vectors: 3 × 385 numbers, no code. Trained on 528 comments: written
examples across niches plus 280 hand-labelled real comments from eight videos.
