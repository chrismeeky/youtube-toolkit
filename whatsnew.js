/* YouTube Toolkit — feature introductions.

   A short slideshow with screenshots, shown once, to people who already had the extension
   when the feature arrived. The service worker marks a feature pending on update (see
   onInstalled in background.js); a fresh install meets the features in the store listing
   instead, and greeting it with one feature out of thirty would be odd.

   Loaded on youtube.com and on Studio, so whichever someone opens first after updating
   shows it. "Seen" is written before the overlay draws, so two tabs loading together can't
   both show it. It never draws on top of another of our dialogs; the next page load simply
   tries again. Settings → Studio can show it again on request. */
(function () {
  'use strict';

  const KEY = 'ytcWhatsNew';               // chrome.storage.local: { pending: [], seen: [] }
  const DELAY_MS = 2500;                   // let the page settle before asking for attention

  const FEATURES = {
    'studio-preview': {
      kicker: 'New in YouTube Toolkit',
      name: 'Home page preview for Studio',
      setting: 'showStudioPreview',
      slides: [
        {
          img: 'whatsnew/studio-preview-1.jpg',
          alt: 'The Preview button beside Undo changes on a video’s details page in Studio',
          title: 'A Preview button in Studio',
          body: 'It sits beside Undo changes on every video’s details page, and beside Reuse ' +
            'details when you upload.'
        },
        {
          img: 'whatsnew/studio-preview-2.jpg',
          alt: 'A video previewed in a desktop home feed among other videos',
          title: 'See it on the home page before you publish',
          body: 'Your title and thumbnail come straight from the form, even unsaved. They ' +
            'appear in the grid beside videos from your own home feed.'
        },
        {
          img: 'whatsnew/studio-preview-3.jpg',
          alt: 'The same video previewed on a phone in dark mode',
          title: 'On every screen',
          body: 'Phone, tablet, laptop, desktop, 1440p and TV, in light or dark, or drag the ' +
            'edges to any size. Try other titles and thumbnails without changing anything in ' +
            'Studio.'
        }
      ]
    }
  };

  const ON_STUDIO = location.hostname === 'studio.youtube.com';
  let el = null;
  let feature = null;
  let at = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function url(path) {
    try { return chrome.runtime.getURL(path); } catch (e) { return ''; }
  }

  /* Every slide is drawn once, side by side in a track, and the track slides. Only the
     footer (dots, buttons, note) is redrawn per step. Redrawing the whole card, as before,
     left nothing to animate between. */
  function build() {
    const f = feature;
    el.innerHTML =
      '<div class="ytc-wn__card" role="dialog" aria-modal="true" aria-label="' + esc(f.name) + '">' +
        '<div class="ytc-wn__head">' +
          '<img class="ytc-wn__logo" src="' + esc(url('icons/icon32.png')) + '" alt="">' +
          '<div class="ytc-wn__title"><span>' + esc(f.kicker) + '</span><b>' + esc(f.name) + '</b></div>' +
          '<button type="button" class="ytc-wn__x" data-act="done" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="ytc-wn__viewport"><div class="ytc-wn__track">' + f.slides.map((s) =>
          '<div class="ytc-wn__slide">' +
            '<div class="ytc-wn__shot"><img src="' + esc(url(s.img)) + '" alt="' + esc(s.alt) + '" draggable="false"></div>' +
            '<div class="ytc-wn__text"><h3>' + esc(s.title) + '</h3><p>' + esc(s.body) + '</p></div>' +
          '</div>').join('') +
        '</div></div>' +
        '<div class="ytc-wn__foot"></div>' +
      '</div>';
  }

  function render() {
    const f = feature;
    const last = at === f.slides.length - 1;
    el.querySelector('.ytc-wn__track').style.transform = 'translateX(' + (-100 * at) + '%)';
    el.querySelectorAll('.ytc-wn__slide').forEach((s, i) => {
      s.setAttribute('aria-hidden', String(i !== at));
      s.inert = i !== at;                   // off-screen slides out of the tab order
    });
    /* On youtube.com the last slide offers a way to Studio; in Studio the reader is already
       where the feature lives. */
    const cta = last
      ? (ON_STUDIO ? '' : '<a class="ytc-wn__btn" href="https://studio.youtube.com/" target="_blank" ' +
          'rel="noopener" data-act="done">Open Studio</a>') +
        '<button type="button" class="ytc-wn__btn ytc-wn__btn--primary" data-act="done">Got it</button>'
      : '<button type="button" class="ytc-wn__btn ytc-wn__btn--primary" data-act="next">Next</button>';
    el.querySelector('.ytc-wn__foot').innerHTML =
      '<div class="ytc-wn__dots">' + f.slides.map((_, i) =>
        '<button type="button" class="ytc-wn__dot' + (i === at ? ' on' : '') + '" data-go="' + i +
        '" aria-label="Slide ' + (i + 1) + '"></button>').join('') + '</div>' +
      '<span class="ytc-wn__note">' + (last ? 'Turn it off any time: Toolkit settings → Studio.' : '') + '</span>' +
      (at ? '<button type="button" class="ytc-wn__btn" data-act="back">Back</button>' : '') +
      cta;
  }

  function go(i) {
    const n = Math.max(0, Math.min(feature.slides.length - 1, i));
    if (n === at) return;
    at = n;
    render();
  }

  function close() {
    if (!el) return;
    el.remove();
    el = null;
    window.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!el) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
  }

  /* A swipe or a mouse drag across the screenshot: the track follows the pointer, then
     settles on the next slide if it moved far enough, or springs back if not. */
  function wireSwipe() {
    const vp = el.querySelector('.ytc-wn__viewport');
    const track = el.querySelector('.ytc-wn__track');
    let x0 = null;
    let dx = 0;
    vp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      x0 = e.clientX;
      dx = 0;
      try { vp.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      track.classList.add('ytc-wn__track--drag');
    });
    vp.addEventListener('pointermove', (e) => {
      if (x0 == null) return;
      dx = e.clientX - x0;
      // Resisted past the first and last slide, so the edge is felt rather than hit.
      const edge = (at === 0 && dx > 0) || (at === feature.slides.length - 1 && dx < 0);
      track.style.transform = 'translateX(calc(' + (-100 * at) + '% + ' + (edge ? dx / 3 : dx) + 'px))';
    });
    const end = () => {
      if (x0 == null) return;
      x0 = null;
      track.classList.remove('ytc-wn__track--drag');
      const step = Math.abs(dx) > Math.min(80, vp.clientWidth / 5) ? (dx < 0 ? 1 : -1) : 0;
      if (step && at + step >= 0 && at + step < feature.slides.length) go(at + step);
      else render();                        // spring back
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
  }

  function show(id) {
    const f = FEATURES[id];
    if (!f || el) return;
    feature = f;
    at = 0;
    el = document.createElement('div');
    el.className = 'ytc-wn';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target === el) { close(); return; }
      const dot = e.target.closest('[data-go]');
      if (dot) { go(+dot.dataset.go); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'next') go(at + 1);
      else if (act.dataset.act === 'back') go(at - 1);
      else close();                         // done; the Studio link still opens its tab
    });
    window.addEventListener('keydown', onKey, true);
    build();
    wireSwipe();
    render();
  }

  function busy() {
    return !!document.querySelector('.ytc-st, .ytc-fm, .ytc-ai, .ytc-pk, .ytc-rv, .ytcs-overlay');
  }

  function maybeShow() {
    if (window.top !== window) return;
    setTimeout(() => {
      try {
        chrome.storage.local.get(KEY, (got) => {
          if (chrome.runtime.lastError) return;
          const st = Object.assign({ pending: [], seen: [] }, got && got[KEY]);
          const id = st.pending.find((p) => FEATURES[p] && st.seen.indexOf(p) < 0);
          if (!id || document.hidden || busy()) return;
          chrome.storage.sync.get(FEATURES[id].setting, (s) => {
            // Someone who has already switched the feature off doesn't need it introduced.
            if (s && s[FEATURES[id].setting] === false) return;
            st.seen.push(id);
            st.pending = st.pending.filter((p) => p !== id);
            chrome.storage.local.set({ [KEY]: st });
            show(id);
          });
        });
      } catch (e) { /* an introduction is never worth an exception */ }
    }, DELAY_MS);
  }

  window.addEventListener('ytc-whatsnew', (e) => show(e.detail));
  maybeShow();
})();
