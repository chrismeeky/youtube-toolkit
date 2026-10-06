/* YouTube Toolkit — Studio: a Preview button on a video's details page.

   It shows the video as a home-page card among real videos, at the widths people actually
   watch on, using whatever is in the form right now — an edited title or a freshly uploaded
   thumbnail shows up before it is saved. The neighbours are this account's own home feed,
   fetched by the service worker; nothing here writes back to Studio. */
(function () {
  'use strict';

  const PREFS_KEY = 'studioPreview';

  /* Columns follow YouTube's grid at that width; the guide is full from 1312px, a 72px rail
     from 792px. Heights are the common viewport for each class of screen. */
  const DEVICES = [
    { id: 'phone', label: 'Phone', w: 390, h: 844, mobile: true },
    { id: 'tablet', label: 'Tablet', w: 820, h: 1180 },
    { id: 'laptop', label: 'Laptop', w: 1366, h: 768 },
    { id: 'desktop', label: 'Desktop', w: 1920, h: 1080 },
    { id: 'wide', label: '1440p', w: 2560, h: 1440 },
    /* The TV app is not the website: no grid, no avatars, dark only, horizontal shelves of
       large cards. It lays out at 1920×1080 whatever the panel's resolution, so that is the
       size it is drawn at. */
    { id: 'tv', label: 'TV', w: 1920, h: 1080, tv: true }
  ];

  /* Cards per TV shelf, and how many of them fit on screen before the shelf scrolls. */
  const TV_SHELF = 8;
  const TV_VISIBLE = 4;

  /* Custom sizes stop where the layouts stop meaning anything: below 320px nothing renders
     a home page, and past 4K the grid just adds columns. Below 600px the website hands over
     to the phone layout. */
  const CUSTOM_MIN_W = 320, CUSTOM_MAX_W = 3840, CUSTOM_MIN_H = 400, CUSTOM_MAX_H = 2400;
  const PHONE_BELOW = 600;

  const prefs = { device: 'desktop', theme: 'light', highlight: false, zoom: 'fit',
    customW: 1280, customH: 800, surface: 'home' };   // surface: home | suggested

  /* The watch page goes two-column (player left, suggestions right) from about 1000px; the
     sidebar is 402px at its widest and gives way to 300px before the layout collapses. */
  const WATCH_TWO_COLUMN = 1000;
  const SUGGESTED_COUNT = { desktop: 12, mobile: 8, tv: 8 };

  function clampSize(w, h) {
    return {
      w: Math.round(Math.min(CUSTOM_MAX_W, Math.max(CUSTOM_MIN_W, w || 0))),
      h: Math.round(Math.min(CUSTOM_MAX_H, Math.max(CUSTOM_MIN_H, h || 0)))
    };
  }

  function setCustom(w, h) {
    const c = clampSize(w, h);
    prefs.device = 'custom';
    prefs.customW = c.w;
    prefs.customH = c.h;
  }

  function columnsFor(w) {
    return w >= 2200 ? 5 : w >= 1600 ? 4 : w >= 1000 ? 3 : 2;
  }

  function guideFor(w) {
    return w >= 1312 ? 'full' : w >= 792 ? 'mini' : 'none';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function text(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function visible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  function videoId() {
    const m = location.pathname.match(/^\/video\/([\w-]{11})\/edit/);
    return m ? m[1] : null;
  }

  /* Where a preview reads its video from. Two places offer the button: a video's details page,
     and the upload dialog. The dialog can open on top of another video's details page, and
     both hold the same title and thumbnail widgets. So each preview is scoped to one root,
     and the details page never reads anything inside the dialog. */
  const UPLOAD_DIALOG = 'ytcp-uploads-dialog';

  function dialogOf(el) {
    return el.closest(UPLOAD_DIALOG) || el.closest('tp-yt-paper-dialog, [role="dialog"]');
  }

  function editContext() {
    const id = videoId();
    return id ? { kind: 'edit', id, root: document } : null;
  }

  /* The dialog's own "Video link" (youtu.be/…) is the only place the new video's id
     shows; the page URL stays on whatever was open underneath. */
  function uploadId(root) {
    for (const a of root.querySelectorAll('a[href*="youtu.be/"], a[href*="watch?v="]')) {
      const m = (a.href + ' ' + text(a)).match(/(?:youtu\.be\/|[?&]v=)([\w-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  function inScope(ctx, el) {
    if (ctx.kind === 'upload') return ctx.root.contains(el);
    return !el.closest(UPLOAD_DIALOG);   // the details page underneath an upload
  }

  /* ------------------------------------------------------------ reading Studio */

  function readTitle(ctx) {
    const el = [...ctx.root.querySelectorAll(
      '#title-textarea #textbox, ytcp-video-title #textbox, #title-textarea [contenteditable]')]
      .find((e) => inScope(ctx, e));
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  }

  function marked(el) {
    return el.hasAttribute('selected') || el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-checked') === 'true' || el.classList.contains('selected') ||
      el.classList.contains('iron-selected');
  }

  /* The thumbnail chosen in the form. Studio's markup for this has changed more than once,
     so rather than one selector: every image inside a thumbnail or still element, outside
     the left drawer (which shows the saved one, not the edited one). A marked-as-selected
     image wins, then a fresh upload (blob: or data:), then the first real one. */
  function thumbCandidates(ctx) {
    const out = [];
    const add = (u) => { if (u && !/^data:,?$/.test(u) && !out.includes(u)) out.push(u); };
    const imgs = [...ctx.root.querySelectorAll('img')].filter((img) => {
      if (!img.src || !inScope(ctx, img)) return false;
      if (img.closest('.ytcs-overlay, ytcp-navigation-drawer, #avatar-btn')) return false;
      for (let p = img.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/THUMBNAIL|STILL/.test(p.tagName)) return true;
      }
      return false;
    });
    const selected = imgs.find((img) => {
      for (let p = img; p && !/^YTCP-(VIDEO-)?THUMBNAIL/.test(p.tagName) && p !== document.body; p = p.parentElement) {
        if (marked(p)) return true;
      }
      return false;
    });
    if (selected) add(selected.src);
    imgs.filter((i) => /^(blob|data):/.test(i.src)).forEach((i) => add(i.src));

    /* Studio's default thumbnail: before anything is chosen, the video's first frame shows
       behind "Select from video" and on the player. Studio doesn't mark it as selected, so it
       is recognised by URL, as any image of this video (/vi/<id>/ or /vi_webp/<id>/), whether
       it is an <img> or an inline background. */
    if (ctx.id) {
      const mine = new RegExp('/vi(?:_webp)?/' + ctx.id + '/');
      for (const img of ctx.root.querySelectorAll('img')) {
        if (inScope(ctx, img) && !img.closest('.ytcs-overlay') && mine.test(img.src)) add(img.src);
      }
      for (const el of ctx.root.querySelectorAll('[style*="url("]')) {
        if (!inScope(ctx, el) || el.closest('.ytcs-overlay')) continue;
        const m = el.getAttribute('style').match(/url\((['"]?)([^'")]+)\1\)/);
        if (m && mine.test(m[2])) add(m[2]);
      }
    }
    imgs.forEach((i) => add(i.src));
    return out;
  }

  /* The saved thumbnail, from the left drawer — used when the form's own can't be found. */
  function drawerThumbnail() {
    const img = document.querySelector('ytcp-navigation-drawer img[src*="ytimg"], ytcp-navigation-drawer img');
    return img ? img.src : '';
  }

  function readDuration() {
    const scope = document.querySelector('ytcp-navigation-drawer') || document;
    for (const el of scope.querySelectorAll('span, div')) {
      if (el.children.length) continue;
      const t = text(el);
      if (/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return t;
    }
    return '';
  }

  /* The channel's name from Studio's left drawer, where Content and Dashboard show it. A
     video mid-upload has no watch page yet to take it from. */
  function readChannelName() {
    const el = [...document.querySelectorAll('ytcp-navigation-drawer #entity-name, ytcp-navigation-drawer .entity-name')]
      .find((e) => text(e));
    return el ? text(el) : '';
  }

  function readAvatar() {
    const img = document.querySelector('#avatar-btn img, ytcp-topbar-menu-button-renderer img');
    return img ? img.src : '';
  }

  /* ------------------------------------------------------------ formatting */

  function compactViews(n) {
    if (n == null || isNaN(n)) return '';
    if (n === 0) return 'No views';
    if (n === 1) return '1 view';
    const fmt = (v, unit) => (v < 10 ? (Math.floor(v * 10) / 10).toString() : Math.floor(v).toString()) + unit;
    const s = n < 1e3 ? String(n) : n < 1e6 ? fmt(n / 1e3, 'K') : n < 1e9 ? fmt(n / 1e6, 'M') : fmt(n / 1e9, 'B');
    return s + ' views';
  }

  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(1, Math.round((Date.now() - t) / 1000));
    const steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600],
      [604800, 'day', 86400], [2592000, 'week', 604800], [31536000, 'month', 2592000]];
    for (const [lim, unit, div] of steps) {
      if (s < lim) { const n = Math.floor(s / div); return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago'; }
    }
    const n = Math.floor(s / 31536000);
    return n + ' year' + (n === 1 ? '' : 's') + ' ago';
  }

  function clock(sec) {
    if (sec == null || isNaN(sec) || sec <= 0) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /* ------------------------------------------------------------ icons */

  const ICON = {
    menu: 'M21 6H3V5h18v1zm0 5H3v1h18v-1zm0 6H3v1h18v-1z',
    search: 'M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z',
    mic: 'M12 3C10.34 3 9 4.37 9 6.07v5.86C9 13.63 10.34 15 12 15s3-1.37 3-3.07V6.07C15 4.37 13.66 3 12 3zm6.5 9h-1c0 3.03-2.47 5.5-5.5 5.5S6.5 15.03 6.5 12h-1c0 3.24 2.39 5.93 5.5 6.43V21h2v-2.57c3.11-.5 5.5-3.19 5.5-6.43z',
    bell: 'M10 20h4c0 1.1-.9 2-2 2s-2-.9-2-2zm10-2.65V19H4v-1.65l2-1.88v-5.15C6 7.4 7.56 5.1 10 4.34v-.38c0-1.42 1.49-2.5 2.99-1.76.65.32 1.01 1.03 1.01 1.76v.39c2.44.75 4 3.06 4 5.98v5.15l2 1.87z',
    more: 'M12 16.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zM10.5 12c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5-1.5.67-1.5 1.5zm0-6c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5-1.5.67-1.5 1.5z',
    home: 'M4 21V10.08l8-6.96 8 6.96V21h-6v-6h-4v6H4z',
    shorts: 'M17.77 10.32c-.77-.32-1.2-.5-1.2-.5L18 9.06c1.84-.96 2.53-3.23 1.56-5.06s-3.24-2.53-5.07-1.56L6 6.94c-1.29.68-2.07 2.04-2 3.49.07 1.42.93 2.67 2.22 3.25.03.01 1.2.5 1.2.5L6 14.93c-1.83.97-2.53 3.24-1.56 5.07.97 1.83 3.24 2.53 5.07 1.56l8.5-4.5c1.29-.68 2.06-2.04 1.99-3.49-.07-1.42-.94-2.68-2.23-3.25zM10 14.65v-5.3L15 12l-5 2.65z',
    subs: 'M20 7H4V6h16v1zm2 2v12H2V9h20zm-7 6-5-3v6l5-3zm2-12H7v1h10V3z',
    you: 'M12 3c2.21 0 4 1.79 4 4s-1.79 4-4 4-4-1.79-4-4 1.79-4 4-4zm0 10c3.31 0 8 1.63 8 5v3H4v-3c0-3.37 4.69-5 8-5z',
    history: 'M14.97 16.95 10 13.87V7h2v5.76l4.03 2.49-1.06 1.7zM12 3c-4.96 0-9 4.04-9 9s4.04 9 9 9 9-4.04 9-9-4.04-9-9-9m0-1c5.52 0 10 4.48 10 10s-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z',
    plus: 'M20 12h-8v8h-1v-8H3v-1h8V3h1v8h8v1z',
    eye: 'M12 6.5c3.6 0 6.8 2 8.5 5.5-1.7 3.5-4.9 5.5-8.5 5.5S5.2 15.5 3.5 12C5.2 8.5 8.4 6.5 12 6.5M12 5C7.5 5 3.7 7.9 2 12c1.7 4.1 5.5 7 10 7s8.3-2.9 10-7c-1.7-4.1-5.5-7-10-7zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'
  };

  function svg(name, size) {
    const s = size || 24;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><path d="' + ICON[name] + '"/></svg>';
  }

  const LOGO = '<span class="ytcs-logo"><svg viewBox="0 0 28 20" width="29" height="20" aria-hidden="true">' +
    '<rect width="28" height="20" rx="5" fill="#ff0033"/><path d="M11.3 14.3V5.7L18.7 10z" fill="#fff"/></svg>' +
    '<b>YouTube</b></span>';

  /* Our own mark on the dialog (the button names us in its tooltip), so nobody mistakes either for a Studio
     feature. Guarded like content.js's: after an extension reload getURL throws in any
     content script still on an open page. */
  const BRAND = 'YouTube Toolkit';

  function brandIcon(cls) {
    let url = '';
    try { url = chrome.runtime.getURL('icons/icon32.png'); } catch (e) { return ''; }
    return '<img class="' + cls + '" src="' + esc(url) + '" alt="">';
  }

  /* ------------------------------------------------------------ the preview */

  let overlay = null;
  let state = null; // { own, videos, order, ownAt, loading, source, titleOverride, thumbOverride }

  function ownCard() {
    const own = state.own || {};
    const ctx = state.ctx;
    const editing = ctx.kind === 'edit';
    const title = state.titleOverride != null ? state.titleOverride : (readTitle(ctx) || own.title || 'Untitled video');
    /* In order of preference, the first that loads wins: what the form shows, then the
       thumbnail the watch page serves. The drawer and the plain i.ytimg.com URL only apply
       on the details page: the drawer behind an upload dialog belongs to another video. */
    const tries = [state.thumbOverride].concat(thumbCandidates(ctx), [own.thumb],
      editing ? [drawerThumbnail(), 'https://i.ytimg.com/vi/' + ctx.id + '/hqdefault.jpg'] : []);
    const thumb = tries.find((u) => u && !state.badThumbs.has(u)) || '';
    /* A new upload is previewed as it will look the moment it goes live. Its watch page
       describes a private draft, whose count and date (one view, the recording date) are
       not what viewers will see. */
    return {
      own: true,
      title,
      thumb,
      duration: clock(own.lengthSeconds) || (editing ? readDuration() : ''),
      channel: own.channel || readChannelName() || 'Your channel',
      avatar: own.avatar || readAvatar(),
      views: editing && own.viewCount != null ? compactViews(own.viewCount) : 'No views',
      age: (editing && ago(own.published)) || '1 minute ago'
    };
  }

  /* Other channels' thumbnails and avatars load without a referrer, as they would anywhere
     else. Ours keeps Studio's: thumbnails of private and processing videos are signed for
     Studio and come back broken without it. */
  function thumbHtml(v) {
    return '<div class="ytcs-thumb">' + (v.thumb
      ? '<img src="' + esc(v.thumb) + '" alt=""' + (v.own ? ' data-own="1"' : ' referrerpolicy="no-referrer"') + '>'
      : '<span class="ytcs-nothumb">No thumbnail yet</span>') +
      (v.duration ? '<span class="ytcs-dur">' + esc(v.duration) + '</span>' : '') + '</div>';
  }

  function cardHtml(v, mobile) {
    if (!v) {
      return '<div class="ytcs-card ytcs-card--skeleton"><div class="ytcs-thumb"></div>' +
        '<div class="ytcs-details"><span class="ytcs-avatar"></span><div class="ytcs-lines">' +
        '<i></i><i></i></div></div></div>';
    }
    const avatar = v.avatar
      ? '<img class="ytcs-avatar" src="' + esc(v.avatar) + '" alt="" referrerpolicy="no-referrer">'
      : '<span class="ytcs-avatar"></span>';
    const meta = mobile
      ? '<div class="ytcs-meta">' + [v.channel, v.views, v.age].filter(Boolean).map(esc).join(' · ') + '</div>'
      : (v.channel ? '<div class="ytcs-meta">' + esc(v.channel) + '</div>' : '') +
        '<div class="ytcs-meta">' + [v.views, v.age].filter(Boolean).map(esc).join(' • ') + '</div>';
    return '<div class="ytcs-card' + (v.own ? ' ytcs-card--own' : '') + '">' +
      thumbHtml(v) +
      '<div class="ytcs-details">' + avatar +
      '<div class="ytcs-lines"><div class="ytcs-title">' + esc(v.title) + '</div>' + meta + '</div>' +
      '<span class="ytcs-kebab">' + svg('more') + '</span></div></div>';
  }

  function chipsHtml() {
    return '<div class="ytcs-chips">' +
      ['All', 'Music', 'Gaming', 'News', 'Live', 'Podcasts', 'Mixes', 'Recently uploaded', 'Watched', 'New to you']
        .map((c, i) => '<span class="ytcs-chip' + (i ? '' : ' ytcs-chip--on') + '">' + c + '</span>').join('') +
      '</div>';
  }

  /* What sits around your video on the current surface. Home: the home feed. Suggested: the
     up-next list of the video being watched (the "host"), once it has arrived. Until then,
     or if it never does, the home feed stands in, with its first video as the host. */
  function pool() {
    if (prefs.surface === 'suggested') {
      if (state.related && state.related.length) {
        return { videos: state.related, order: state.orderRel, loading: false, host: state.host };
      }
      if (state.relatedLoading) return { videos: [], order: [], loading: true, host: null };
      const order = state.order.slice(1);
      return { videos: state.videos, order, loading: state.loading,
        host: state.videos[state.order[0]] || null };
    }
    return { videos: state.videos, order: state.order, loading: state.loading, host: null };
  }

  function cardList(count) {
    const list = [];
    const p = pool();
    const others = p.order.map((i) => p.videos[i]).filter(Boolean);
    let k = 0;
    // A slot picked on a wider layout can be past the end of a shorter one.
    const ownAt = Math.min(state.ownAt, count - 1);
    for (let i = 0; i < count; i++) {
      if (i === ownAt) list.push(ownCard());
      else if (p.loading) list.push(null);
      else if (k < others.length) list.push(others[k++]);
      else if (!p.videos.length) list.push(null);
    }
    return list;
  }

  function cards(count, mobile) {
    return cardList(count).map((v) => cardHtml(v, mobile)).join('');
  }

  function tvCardHtml(v) {
    if (!v) {
      return '<div class="ytcs-tvcard ytcs-card--skeleton"><div class="ytcs-thumb"></div>' +
        '<div class="ytcs-lines"><i></i><i></i></div></div>';
    }
    return '<div class="ytcs-tvcard' + (v.own ? ' ytcs-card--own' : '') + '">' +
      thumbHtml(v) +
      '<div class="ytcs-title">' + esc(v.title) + '</div>' +
      (v.channel ? '<div class="ytcs-meta">' + esc(v.channel) + '</div>' : '') +
      '<div class="ytcs-meta">' + [v.views, v.age].filter(Boolean).map(esc).join(' • ') + '</div></div>';
  }

  function tvHtml() {
    const list = cardList(TV_SHELF * 3);
    const shelves = ['', 'Recently uploaded', 'New to you'];
    const rail = ['search', 'home', 'shorts', 'subs', 'you'];
    return '<div class="ytcs-yt ytcs-yt--tv">' +
      '<nav class="ytcs-rail">' + rail.map((icon) =>
        '<span class="ytcs-rail-item' + (icon === 'home' ? ' ytcs-rail-item--on' : '') + '">' + svg(icon, 36) + '</span>').join('') +
      '</nav>' +
      '<main class="ytcs-scroll">' +
        '<div class="ytcs-tvchips">' + ['Home', 'Music', 'Gaming', 'News', 'Live', 'Podcasts']
          .map((c, i) => '<span class="ytcs-chip' + (i ? '' : ' ytcs-chip--on') + '">' + c + '</span>').join('') + '</div>' +
        shelves.map((name, r) => '<section class="ytcs-shelf">' +
          (name ? '<h3>' + name + '</h3>' : '') +
          '<div class="ytcs-shelf-row">' + list.slice(r * TV_SHELF, (r + 1) * TV_SHELF).map(tvCardHtml).join('') +
          '</div></section>').join('') +
      '</main></div>';
  }

  function guideHtml(kind) {
    if (kind === 'none') return '';
    const items = [['home', 'Home'], ['shorts', 'Shorts'], ['subs', 'Subscriptions'], ['you', 'You']];
    if (kind === 'full') items.push(['history', 'History']);
    return '<nav class="ytcs-guide ytcs-guide--' + kind + '">' + items.map(([icon, label], i) =>
      '<div class="ytcs-guide-item' + (i ? '' : ' ytcs-guide-item--on') + '">' + svg(icon) +
      '<span>' + label + '</span></div>').join('') + '</nav>';
  }

  function desktopHtml(d) {
    const cols = columnsFor(d.w);
    const guide = guideFor(d.w);
    return '<div class="ytcs-yt ytcs-yt--desktop">' +
      '<header class="ytcs-mast">' +
        '<div class="ytcs-mast-start"><span class="ytcs-icon">' + svg('menu') + '</span>' + LOGO + '</div>' +
        '<div class="ytcs-mast-center"><div class="ytcs-search"><span>Search</span><b>' + svg('search') + '</b></div>' +
          '<span class="ytcs-icon ytcs-icon--filled">' + svg('mic') + '</span></div>' +
        '<div class="ytcs-mast-end"><span class="ytcs-create">' + svg('plus') + 'Create</span>' +
          '<span class="ytcs-icon">' + svg('bell') + '</span>' +
          '<span class="ytcs-me" style="background-image:url(\'' + esc(readAvatar()) + '\')"></span></div>' +
      '</header>' +
      '<div class="ytcs-body">' + guideHtml(guide) +
        '<main class="ytcs-scroll">' + chipsHtml() +
          '<div class="ytcs-grid" style="--cols:' + cols + '">' + cards(cols * 4) + '</div>' +
        '</main>' +
      '</div></div>';
  }

  function mobileHtml() {
    const nav = [['home', 'Home'], ['shorts', 'Shorts'], ['plus', ''], ['subs', 'Subscriptions'], ['you', 'You']];
    return '<div class="ytcs-yt ytcs-yt--mobile">' +
      '<header class="ytcs-mast">' + LOGO +
        '<div class="ytcs-mast-end"><span class="ytcs-icon">' + svg('bell') + '</span>' +
        '<span class="ytcs-icon">' + svg('search') + '</span></div></header>' +
      '<main class="ytcs-scroll">' + chipsHtml() + '<div class="ytcs-list">' + cards(10, true) + '</div></main>' +
      '<footer class="ytcs-tabbar">' + nav.map(([icon, label], i) =>
        '<div class="ytcs-tab' + (i ? '' : ' ytcs-tab--on') + (label ? '' : ' ytcs-tab--create') + '">' +
        svg(icon) + (label ? '<span>' + label + '</span>' : '') + '</div>').join('') + '</footer></div>';
  }

  /* ------------------------------------------------------------ the watch page */

  /* A sidebar suggestion: small thumbnail on the left, text on the right. */
  function compactCardHtml(v) {
    if (!v) {
      return '<div class="ytcs-ccard ytcs-card--skeleton"><div class="ytcs-thumb"></div>' +
        '<div class="ytcs-lines"><i></i><i></i></div></div>';
    }
    return '<div class="ytcs-ccard' + (v.own ? ' ytcs-card--own' : '') + '">' + thumbHtml(v) +
      '<div class="ytcs-lines"><div class="ytcs-title">' + esc(v.title) + '</div>' +
        (v.channel ? '<div class="ytcs-meta">' + esc(v.channel) + '</div>' : '') +
        '<div class="ytcs-meta">' + [v.views, v.age].filter(Boolean).map(esc).join(' • ') + '</div></div>' +
      '<span class="ytcs-kebab">' + svg('more') + '</span></div>';
  }

  /* The video being watched. Its frame is the thumbnail, dimmed a little and paused a third
     of the way through, which is all a player looks like in a still. */
  function playerHtml(host) {
    return '<div class="ytcs-player">' +
      (host && host.thumb ? '<img src="' + esc(host.thumb) + '" alt="" referrerpolicy="no-referrer">' : '') +
      '<div class="ytcs-player-bar"><i></i></div></div>';
  }

  function watchInfoHtml(host, mobile) {
    if (!host) {
      return '<div class="ytcs-watch-info ytcs-card--skeleton"><div class="ytcs-lines"><i></i><i></i></div></div>';
    }
    const avatar = host.avatar
      ? '<img class="ytcs-avatar" src="' + esc(host.avatar) + '" alt="" referrerpolicy="no-referrer">'
      : '<span class="ytcs-avatar"></span>';
    return '<div class="ytcs-watch-info">' +
      '<h1 class="ytcs-watch-title">' + esc(host.title) + '</h1>' +
      (mobile ? '<div class="ytcs-meta">' + [host.views, host.age].filter(Boolean).map(esc).join(' · ') + '</div>' : '') +
      '<div class="ytcs-owner">' + avatar + '<b>' + esc(host.channel) + '</b>' +
        '<span class="ytcs-subscribe">Subscribe</span>' +
        (mobile ? '' : '<span class="ytcs-actions"><span class="ytcs-pill">Like</span>' +
          '<span class="ytcs-pill">Share</span><span class="ytcs-pill">Save</span></span>') +
      '</div>' +
      (mobile ? '' : '<div class="ytcs-desc"><b>' + [host.views, host.age].filter(Boolean).map(esc).join('  ') +
        '</b><i></i><i></i></div>') +
    '</div>';
  }

  function sideChipsHtml(host) {
    const chips = ['All', host && host.channel ? 'From ' + host.channel : 'From this channel', 'Related', 'Recently uploaded'];
    return '<div class="ytcs-chips ytcs-chips--side">' + chips.map((c, i) =>
      '<span class="ytcs-chip' + (i ? '' : ' ytcs-chip--on') + '">' + esc(c) + '</span>').join('') + '</div>';
  }

  function desktopWatchHtml(d) {
    const host = pool().host;
    const two = d.w >= WATCH_TWO_COLUMN;
    const side = d.w >= 1328 ? 402 : Math.max(300, Math.round(d.w * 0.3));
    /* YouTube's player stops at 1280px wide, and at whatever leaves the title on screen below
       it (the viewport less the masthead and ~136px). The pair is then centred, which is why a
       wide screen shows margins either side rather than a giant player. */
    const playerMax = Math.round(Math.min(1280, (d.h - 56 - 136) * 16 / 9));
    const list = cardList(SUGGESTED_COUNT.desktop).map(compactCardHtml).join('');
    return '<div class="ytcs-yt ytcs-yt--desktop">' +
      '<header class="ytcs-mast">' +
        '<div class="ytcs-mast-start"><span class="ytcs-icon">' + svg('menu') + '</span>' + LOGO + '</div>' +
        '<div class="ytcs-mast-center"><div class="ytcs-search"><span>Search</span><b>' + svg('search') + '</b></div>' +
          '<span class="ytcs-icon ytcs-icon--filled">' + svg('mic') + '</span></div>' +
        '<div class="ytcs-mast-end"><span class="ytcs-create">' + svg('plus') + 'Create</span>' +
          '<span class="ytcs-icon">' + svg('bell') + '</span>' +
          '<span class="ytcs-me" style="background-image:url(\'' + esc(readAvatar()) + '\')"></span></div>' +
      '</header>' +
      '<main class="ytcs-scroll"><div class="ytcs-watch' + (two ? '' : ' ytcs-watch--stacked') + '">' +
        '<div class="ytcs-primary"' + (two ? ' style="max-width:' + playerMax + 'px"' : '') + '>' +
          playerHtml(host) + watchInfoHtml(host, false) + '</div>' +
        '<aside class="ytcs-secondary"' + (two ? ' style="width:' + side + 'px"' : '') + '>' +
          sideChipsHtml(host) + '<div class="ytcs-clist">' + list + '</div></aside>' +
      '</div></main></div>';
  }

  function mobileWatchHtml() {
    const host = pool().host;
    return '<div class="ytcs-yt ytcs-yt--mobile ytcs-yt--watch">' + playerHtml(host) +
      '<main class="ytcs-scroll">' + watchInfoHtml(host, true) +
        '<div class="ytcs-list">' + cards(SUGGESTED_COUNT.mobile, true) + '</div></main></div>';
  }

  function tvWatchHtml() {
    const host = pool().host;
    const list = cardList(SUGGESTED_COUNT.tv).map(tvCardHtml).join('');
    return '<div class="ytcs-yt ytcs-yt--tv ytcs-yt--tvwatch">' +
      (host && host.thumb ? '<img class="ytcs-tvwatch-bg" src="' + esc(host.thumb) + '" alt="" referrerpolicy="no-referrer">' : '') +
      '<div class="ytcs-tvwatch-shade"></div>' +
      '<div class="ytcs-tvwatch-top">' + (host ? '<h2>' + esc(host.title) + '</h2><span>' + esc(host.channel) + '</span>' : '') + '</div>' +
      '<div class="ytcs-tvwatch-bottom"><div class="ytcs-player-bar"><i></i></div>' +
        '<h3>Up next</h3><div class="ytcs-shelf-row">' + list + '</div></div></div>';
  }

  /* Suggested videos are asked for the first time the Suggested view is shown, not on open:
     it costs a search and a watch page, and most previews never leave Home. */
  function ensureRelated() {
    if (!state || prefs.surface !== 'suggested' || state.related || state.relatedLoading) return;
    state.relatedLoading = true;
    const mine = state;
    const query = state.titleOverride != null ? state.titleOverride : (readTitle(state.ctx) || '');
    try {
      chrome.runtime.sendMessage({ type: 'ytc-studio-related', id: state.ctx.id, query }, (res) => {
        if (state !== mine) return;
        void chrome.runtime.lastError;
        state.relatedLoading = false;
        state.related = (res && res.related) || [];
        state.host = (res && res.host) || null;
        state.orderRel = shuffled(state.related.length);
        render();
      });
    } catch (e) {
      state.relatedLoading = false;
      state.related = [];
    }
  }

  function device() {
    if (prefs.device === 'custom') {
      const c = clampSize(prefs.customW, prefs.customH);
      return { id: 'custom', label: 'Custom', w: c.w, h: c.h, mobile: c.w < PHONE_BELOW };
    }
    return DEVICES.find((d) => d.id === prefs.device) || DEVICES[3];
  }

  function render() {
    if (!overlay) return;
    const d = device();
    const theme = d.tv ? 'dark' : prefs.theme;      // the TV app has no light theme
    overlay.dataset.theme = theme;
    overlay.classList.toggle('ytcs-overlay--highlight', prefs.highlight);
    overlay.querySelectorAll('[data-device]').forEach((b) =>
      b.classList.toggle('ytcs-seg--on', b.dataset.device === d.id));
    overlay.querySelectorAll('[data-theme-pick]').forEach((b) => {
      b.classList.toggle('ytcs-seg--on', b.dataset.themePick === theme);
      b.disabled = !!d.tv;
      b.title = d.tv ? 'The TV app is dark only' : '';
    });
    overlay.querySelector('[data-act="zoom"]').textContent = prefs.zoom === 'fit' ? 'Actual size' : 'Fit to window';
    overlay.querySelector('[data-act="highlight"]').classList.toggle('ytcs-seg--on', prefs.highlight);

    overlay.querySelector('[data-device="custom"] small').textContent =
      prefs.device === 'custom' ? d.w + '×' + d.h : '';
    overlay.querySelectorAll('[data-dim]').forEach((inp) => {
      inp.disabled = !!d.tv;
      inp.title = d.tv ? 'The TV app is always 1920 × 1080' : '';
      if (document.activeElement !== inp) inp.value = inp.dataset.dim === 'w' ? d.w : d.h;
    });
    overlay.querySelector('.ytcs-device').classList.toggle('ytcs-device--fixed', !!d.tv);

    const stage = overlay.querySelector('.ytcs-stage');
    const frame = overlay.querySelector('.ytcs-frame');
    const screen = overlay.querySelector('.ytcs-screen');
    const scroll = screen.querySelector('.ytcs-scroll');
    const view = d.id + ':' + prefs.surface;
    const keep = scroll && screen.dataset.device === view ? scroll.scrollTop : 0;
    screen.dataset.device = view;
    screen.innerHTML = prefs.surface === 'suggested'
      ? (d.tv ? tvWatchHtml() : d.mobile ? mobileWatchHtml() : desktopWatchHtml(d))
      : (d.tv ? tvHtml() : d.mobile ? mobileHtml() : desktopHtml(d));
    const after = screen.querySelector('.ytcs-scroll');
    if (after) after.scrollTop = keep;

    const room = stage.getBoundingClientRect();
    const fit = Math.min(1, (room.width - 72) / d.w, (room.height - 96) / d.h);
    // Held still while a handle is being dragged, so the edge stays under the pointer.
    const scale = drag ? drag.scale : prefs.zoom === 'fit' ? Math.max(0.1, fit) : 1;
    screen.style.width = d.w + 'px';
    screen.style.height = d.h + 'px';
    screen.style.transform = 'scale(' + scale + ')';
    frame.style.width = d.w * scale + 'px';
    frame.style.height = d.h * scale + 'px';
    stage.classList.toggle('ytcs-stage--actual', prefs.zoom !== 'fit');

    overlay.querySelectorAll('[data-surface]').forEach((b) =>
      b.classList.toggle('ytcs-seg--on', b.dataset.surface === prefs.surface));
    let layout, note;
    if (prefs.surface === 'suggested') {
      const host = pool().host;
      layout = d.tv ? 'Up next under the player' : d.mobile || d.w < WATCH_TWO_COLUMN
        ? 'suggestions under the video' : 'suggestions in the sidebar';
      note = state.relatedLoading ? 'Finding what YouTube suggests beside a video like yours…'
        : state.related && state.related.length && host
          ? 'Suggested beside \u201c' + host.title + '\u201d, the top search result for your title.'
          : 'Couldn\u2019t load suggestions for your title, so your home feed stands in.';
    } else {
      const cols = d.tv ? TV_VISIBLE : d.mobile ? 1 : columnsFor(d.w);
      layout = cols + (d.tv ? ' per shelf on screen' : ' per row');
      note = state.loading ? 'Loading your home feed…'
        : !state.videos.length ? 'Couldn\u2019t load other videos — grey cards stand in for them.'
        : state.source === 'search' ? 'Your home feed came back empty, so these are search results for the title.'
        : 'Beside videos from your own home feed.';
    }
    overlay.querySelector('.ytcs-caption').textContent =
      d.w + ' × ' + d.h + (d.tv ? ' TV app' : '') + ' · ' + layout + ' · shown at ' + Math.round(scale * 100) + '% · ' + note;

    const input = overlay.querySelector('.ytcs-title-input');
    const title = ownCard().title;
    if (document.activeElement !== input) input.value = title;
    const count = overlay.querySelector('.ytcs-count');
    count.textContent = title.length + '/100';
    count.classList.toggle('ytcs-count--over', title.length > 100);
    overlay.querySelector('[data-act="reset"]').hidden =
      state.titleOverride == null && !state.thumbOverride;
  }

  function shuffled(n) {
    const order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  function shuffle(keepOwn) {
    state.order = shuffled(state.videos.length);
    if (state.related) state.orderRel = shuffled(state.related.length);
    if (!keepOwn) {
      const d = device();
      if (prefs.surface === 'suggested') {
        // Near the top of the list: the first few suggestions are the ones that get seen.
        state.ownAt = Math.floor(Math.random() * (d.tv ? TV_VISIBLE : 5));
      } else if (d.tv) {
        // Somewhere on screen in the first two shelves, not scrolled off to the right.
        const slot = Math.floor(Math.random() * TV_VISIBLE * 2);
        state.ownAt = Math.floor(slot / TV_VISIBLE) * TV_SHELF + (slot % TV_VISIBLE);
      } else {
        const firstRows = d.mobile ? 4 : columnsFor(d.w) * 2;
        state.ownAt = Math.floor(Math.random() * firstRows);
      }
    }
  }

  /* ------------------------------------------------------------ resizing */

  let drag = null; // { edge, x, y, w, h, scale, factor }
  let dragFrame = 0;

  function startDrag(e) {
    const handle = e.target.closest('[data-edge]');
    if (!handle || e.button !== 0) return;
    const d = device();
    if (d.tv) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    const scale = parseFloat((overlay.querySelector('.ytcs-screen').style.transform.match(/[\d.]+/) || [1])[0]);
    /* The frame is centred when fitted, so an edge moves half as far as the frame grows:
       doubling the pointer's travel keeps the edge under it. At actual size the frame is
       pinned top-left and the edge moves one for one. */
    drag = { edge: handle.dataset.edge, x: e.clientX, y: e.clientY, w: d.w, h: d.h, scale,
      factor: prefs.zoom === 'fit' ? 2 : 1 };
    overlay.classList.add('ytcs-overlay--dragging');
  }

  function moveDrag(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * drag.factor / drag.scale;
    const dy = (e.clientY - drag.y) * drag.factor / drag.scale;
    setCustom(drag.w + (drag.edge !== 's' ? dx : 0), drag.h + (drag.edge !== 'e' ? dy : 0));
    if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; render(); });
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    overlay.classList.remove('ytcs-overlay--dragging');
    savePrefs();
    render();
  }

  function onDim(e) {
    const inp = e.target.closest('[data-dim]');
    if (!inp) return;
    const d = device();
    const v = parseInt(inp.value, 10);
    if (!v) { inp.value = inp.dataset.dim === 'w' ? d.w : d.h; return; }
    setCustom(inp.dataset.dim === 'w' ? v : d.w, inp.dataset.dim === 'h' ? v : d.h);
    savePrefs();
    render();
  }

  function savePrefs() {
    try { chrome.storage.local.set({ [PREFS_KEY]: Object.assign({}, prefs) }); } catch (e) { /* context gone */ }
  }

  function close() {
    if (!overlay) return;
    if (state && state.thumbOverride) URL.revokeObjectURL(state.thumbOverride);
    drag = null;
    overlay.remove();
    overlay = null;
    state = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('focus', keepFocus, true);
    window.removeEventListener('focusin', keepFocus, true);
    window.removeEventListener('resize', render);
    document.documentElement.classList.remove('ytcs-lock');
  }

  /* Both on window, in the capture phase, so they run before Studio's dialog. The upload
     dialog keeps focus inside itself and closes on Escape, and it listens on document in
     the capture phase. Left alone, it would pull focus out of the preview's inputs, and
     Escape would close the upload along with the preview. Typing still works: stopping a
     key event doesn't cancel its default action, and input/change are separate events. */
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (!overlay || !overlay.contains(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Enter' && e.target.closest('[data-dim]')) e.target.blur();
  }

  function keepFocus(e) {
    if (overlay && overlay.contains(e.target)) e.stopPropagation();
  }

  function open(ctx) {
    if (!ctx || overlay) return;
    const id = ctx.id;
    state = { ctx, own: null, videos: [], order: [], ownAt: 1, loading: true, source: 'home',
      titleOverride: null, thumbOverride: null, badThumbs: new Set(),
      related: null, relatedLoading: false, host: null, orderRel: [] };

    overlay = document.createElement('div');
    overlay.className = 'ytcs-overlay';
    overlay.innerHTML =
      '<div class="ytcs-dialog" role="dialog" aria-label="Home page preview">' +
        '<div class="ytcs-bar">' +
          '<div class="ytcs-brand">' + brandIcon('ytcs-brand-icon') +
            '<div><strong class="ytcs-heading">Home page preview</strong>' +
            '<small class="ytcs-brand-name">by ' + BRAND + '</small></div></div>' +
          '<div class="ytcs-seg" title="Where on YouTube to show the video">' +
            '<button type="button" data-surface="home">Home</button>' +
            '<button type="button" data-surface="suggested">Suggested</button></div>' +
          '<div class="ytcs-seg">' + DEVICES.map((d) =>
            '<button type="button" data-device="' + d.id + '">' + d.label + '<small>' + (d.tv ? '1080p' : d.w) + '</small></button>').join('') +
            '<button type="button" data-device="custom">Custom<small></small></button>' +
          '</div>' +
          '<span class="ytcs-dims" title="Type a size, or drag the preview\u2019s edges">' +
            '<input type="number" data-dim="w" min="' + CUSTOM_MIN_W + '" max="' + CUSTOM_MAX_W + '" aria-label="Width">' +
            '<span>×</span>' +
            '<input type="number" data-dim="h" min="' + CUSTOM_MIN_H + '" max="' + CUSTOM_MAX_H + '" aria-label="Height">' +
          '</span>' +
          '<div class="ytcs-seg"><button type="button" data-theme-pick="light">Light</button>' +
            '<button type="button" data-theme-pick="dark">Dark</button></div>' +
          '<div class="ytcs-bar-end">' +
            '<button type="button" class="ytcs-plain" data-act="highlight" title="Outline your video">Highlight mine</button>' +
            '<button type="button" class="ytcs-plain" data-act="shuffle" title="Move your video and reorder the others">Shuffle</button>' +
            '<button type="button" class="ytcs-plain" data-act="zoom"></button>' +
            '<button type="button" class="ytcs-close" data-act="close" aria-label="Close preview">×</button>' +
          '</div>' +
        '</div>' +
        '<div class="ytcs-bar ytcs-bar--try">' +
          '<label class="ytcs-try"><span>Title</span><input class="ytcs-title-input" type="text" spellcheck="true">' +
            '<span class="ytcs-count"></span></label>' +
          '<button type="button" class="ytcs-plain" data-act="thumb">Try another thumbnail…</button>' +
          '<button type="button" class="ytcs-plain" data-act="reset" hidden>Back to Studio’s</button>' +
          '<input type="file" accept="image/*" hidden>' +
          '<span class="ytcs-hint">Changes here are only for the preview — nothing is saved to Studio.</span>' +
        '</div>' +
        '<div class="ytcs-stage"><div class="ytcs-device">' +
          '<div class="ytcs-frame"><div class="ytcs-screen"></div></div>' +
          '<span class="ytcs-handle ytcs-handle--e" data-edge="e" title="Drag to resize"></span>' +
          '<span class="ytcs-handle ytcs-handle--s" data-edge="s" title="Drag to resize"></span>' +
          '<span class="ytcs-handle ytcs-handle--se" data-edge="se" title="Drag to resize"></span>' +
          '</div>' +
          '<div class="ytcs-caption"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.documentElement.classList.add('ytcs-lock');

    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.device) {
        // Custom picks up from whatever size is showing, so it never jumps somewhere unrelated.
        if (b.dataset.device === 'custom' && prefs.device !== 'custom' && !device().tv) {
          setCustom(device().w, device().h);
        } else prefs.device = b.dataset.device;
        savePrefs();
        render();
        return;
      }
      if (b.dataset.themePick) { prefs.theme = b.dataset.themePick; savePrefs(); render(); return; }
      if (b.dataset.surface) {
        prefs.surface = b.dataset.surface;
        savePrefs();
        ensureRelated();
        render();
        return;
      }
      const act = b.dataset.act;
      if (act === 'close') close();
      else if (act === 'shuffle') { shuffle(false); render(); }
      else if (act === 'highlight') { prefs.highlight = !prefs.highlight; savePrefs(); render(); }
      else if (act === 'zoom') { prefs.zoom = prefs.zoom === 'fit' ? 'actual' : 'fit'; savePrefs(); render(); }
      else if (act === 'thumb') overlay.querySelector('input[type="file"]').click();
      else if (act === 'reset') {
        if (state.thumbOverride) URL.revokeObjectURL(state.thumbOverride);
        state.titleOverride = null;
        state.thumbOverride = null;
        render();
      }
    });
    /* A thumbnail of ours that fails is struck off, and the next candidate is tried. Failing
       includes loading: for a thumbnail that doesn't exist, i.ytimg.com answers 200 with
       its grey 120×90 placeholder rather than an error. Only default.jpg is really that size. */
    const strike = (e) => {
      const img = e.target;
      if (!state || !img.dataset || !img.dataset.own) return;
      const placeholder = e.type === 'load' && img.naturalWidth === 120 && img.naturalHeight === 90 &&
        /ytimg\.com/.test(img.src) && !/\/default\.jpg/.test(img.src);
      if (e.type === 'load' && !placeholder) return;
      state.badThumbs.add(img.getAttribute('src'));
      render();
    };
    overlay.addEventListener('error', strike, true);
    overlay.addEventListener('load', strike, true);
    overlay.addEventListener('pointerdown', startDrag);
    overlay.addEventListener('pointermove', moveDrag);
    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);
    overlay.addEventListener('change', onDim);
    overlay.querySelector('.ytcs-title-input').addEventListener('input', (e) => {
      state.titleOverride = e.target.value;
      render();
    });
    overlay.querySelector('input[type="file"]').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (state.thumbOverride) URL.revokeObjectURL(state.thumbOverride);
      state.thumbOverride = URL.createObjectURL(file);
      e.target.value = '';
      render();
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('focus', keepFocus, true);
    window.addEventListener('focusin', keepFocus, true);
    window.addEventListener('resize', render);
    ensureRelated();                         // reopened on Suggested last time
    render();

    const mine = state;
    try {
      chrome.runtime.sendMessage({ type: 'ytc-studio-preview', id, query: readTitle(ctx) }, (res) => {
        if (state !== mine) return;           // closed, or reopened, while this was in flight
        void chrome.runtime.lastError;
        state.loading = false;
        state.own = (res && res.own) || null;
        state.videos = (res && res.videos) || [];
        state.source = (res && res.source) || 'home';
        shuffle(true);
        render();
      });
    } catch (e) {
      // Extension reloaded under an open Studio tab: the preview still works with grey cards.
      state.loading = false;
      render();
    }
  }

  /* ------------------------------------------------------------ the button */

  function findUndo() {
    const pick = (list) => [...list].find(visible);
    const byId = pick(document.querySelectorAll('ytcp-button#discard, #discard'));
    if (byId) return byId;
    const byText = pick([...document.querySelectorAll('ytcp-button, button')]
      .filter((b) => /^undo changes$/i.test(text(b))));
    if (byText) return byText.closest('ytcp-button') || byText;
    // Another language: Undo sits immediately before Save.
    const save = pick(document.querySelectorAll('ytcp-button#save, #save'));
    return save && save.previousElementSibling;
  }

  /* "Reuse details" heads the Details step of the upload dialog. Found by an id containing
     "reuse" first, since that holds in any language, then by its English label. */
  function findReuse(root) {
    const pick = (list) => [...list].find(visible);
    const byId = pick(root.querySelectorAll('ytcp-button[id*="reuse" i], button[id*="reuse" i]'));
    if (byId) return byId;
    const byText = pick([...root.querySelectorAll('ytcp-button, button')]
      .filter((b) => /^reuse details$/i.test(text(b))));
    return byText ? byText.closest('ytcp-button') || byText : null;
  }

  function makeButton(extra, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ytcs-btn' + (extra ? ' ' + extra : '');
    b.title = BRAND + ': see this video on the home page at different screen sizes';
    b.innerHTML = svg('eye', 20) + '<span>Preview</span>';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  const editButton = makeButton('', () => open(editContext()));
  const uploadButton = makeButton('ytcs-btn--upload', () => {
    const dialog = dialogOf(uploadButton);
    if (dialog) open({ kind: 'upload', id: uploadId(dialog), root: dialog });
  });

  /* Put a button just before its anchor, or take it away when the anchor is gone. Studio
     hides the upload dialog's steps rather than removing them, so "not visible" counts as
     gone, or the button would linger on Video elements and Visibility. */
  function place(button, anchor) {
    if (!anchor || !anchor.parentNode || !visible(anchor)) { button.remove(); return; }
    if (button.isConnected && button.nextElementSibling === anchor) return;
    anchor.parentNode.insertBefore(button, anchor);
  }

  /* Reuse details is positioned on its own (pinned to the header's right edge) rather than
     laid out in the row, so a button set before it lands on top of it. Measured rather than
     assumed: if the two overlap, ours moves left by exactly the overlap plus a gap. Starting
     from the current margin keeps this stable, since a button already clear is left alone. */
  const GAP = 8;

  function clear(button, anchor) {
    if (!button.isConnected) return;
    const a = anchor.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const overlaps = b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top;
    if (!overlaps) return;
    const now = parseFloat(getComputedStyle(button).marginRight) || 0;
    button.style.marginRight = now + (b.right - a.left) + GAP + 'px';
  }

  /* The Toolkit settings' "Home page preview" switch (Settings → Studio on youtube.com). Read
     straight from sync storage, where those settings live; Studio doesn't load format.js. On
     until it has been read as off, so a slow read never hides the button. */
  let enabled = true;

  function ensureButton() {
    if (!enabled) {
      editButton.remove();
      uploadButton.remove();
      if (overlay) close();
      return;
    }
    place(editButton, videoId() ? findUndo() : null);
    /* Found from the button inward rather than the dialog outward: the dialog element is a
       wrapper whose own box can be empty while its contents show. */
    const reuse = findReuse(document);
    place(uploadButton, reuse && dialogOf(reuse) ? reuse : null);
    if (uploadButton.isConnected) clear(uploadButton, reuse);

    // The page the preview was opened from has gone (navigated away, dialog closed).
    if (overlay && state) {
      const ctx = state.ctx;
      const gone = ctx.kind === 'edit' ? videoId() !== ctx.id : !ctx.root.isConnected;
      if (gone) close();
    }
  }

  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; ensureButton(); }, 250);
  });

  try {
    chrome.storage.local.get(PREFS_KEY, (got) => {
      Object.assign(prefs, (got && got[PREFS_KEY]) || {});
    });
    chrome.storage.sync.get('showStudioPreview', (got) => {
      enabled = !got || got.showStudioPreview !== false;
      ensureButton();
    });
    // Flipped in the settings on another tab: takes effect here without a reload.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.showStudioPreview) return;
      enabled = changes.showStudioPreview.newValue !== false;
      ensureButton();
    });
  } catch (e) { /* defaults stand */ }
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
