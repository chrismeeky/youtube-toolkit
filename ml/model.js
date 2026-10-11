/* The downloadable comment models: where each comes from and how it is checked.

   Shared by the service worker (which downloads them) and the worker (which runs them), so the
   two can never disagree about which files are valid. A classic script that sets one global,
   because the service worker loads scripts with importScripts and the worker imports it too.

   Each is pinned to one Hugging Face commit and checked byte for byte: a changed file is
   refused, never run. */
(function (root) {
  'use strict';

  const HF = 'https://huggingface.co/';

  function files(repo, commit, list) {
    return list.map(([key, path, size, sha256]) => ({ key, url: HF + repo + '/resolve/' + commit + '/' + path, size, sha256 }));
  }

  const MODELS = {
    /* all-MiniLM-L6-v2: a vector per comment, for grouping themes and for telling comments
       about the video from comments about its story. */
    embed: {
      label: 'comment model',
      CACHE: 'ytc-model-minilm-751bff3',
      FILES: files('Xenova/all-MiniLM-L6-v2', '751bff37182d3f1213fa05d7196b954e230abad9', [
        ['model', 'onnx/model_quantized.onnx', 22972370, 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'],
        ['vocab', 'vocab.txt', 231508, '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3']
      ])
    },
    /* twitter-roberta-base-sentiment-latest: negative / neutral / positive, trained on tweets,
       which is how comments are written. */
    tone: {
      label: 'tone model',
      CACHE: 'ytc-model-tone-f3ec4d0',
      FILES: files('Xenova/twitter-roberta-base-sentiment-latest', 'f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445', [
        ['model', 'onnx/model_quantized.onnx', 125905426, '046f7e4cc46b399558fa9b2de966f6b0d42c69e4b01f582bfb4099b01a0bb5d7'],
        ['vocab', 'vocab.json', 798293, 'ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e'],
        ['merges', 'merges.txt', 456318, '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5']
      ])
    }
  };

  root.YTCModels = MODELS;
  // The original single-model name, kept for anything still reading it.
  root.YTCModel = MODELS.embed;
})(typeof self !== 'undefined' ? self : globalThis);
