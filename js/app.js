/*
 * App shell: switches between the editor and the player based on the URL
 * hash, wires up the controls, and builds share links.
 */
(function () {
  'use strict';

  const { encode, decode, tokenFromHash, urlFor, shorten, DEFAULT_AUDIO } = window.CrawlShare;
  const { Music, parseYouTubeId, parseYouTubeStart } = window.CrawlMusic;
  const { Crawl, Starfield } = window.CrawlEngine;

  const SAMPLE = {
    intro: 'A long time ago, up your butt and around the corner....',
    logo: 'BULL\nSHIT',
    episode: 'I',
    title: 'TESTING THE BULLSHIT',
    body: [
      'This is an idea that I had, so I had AI create it.  Have you ever wanted to chronicle epic bullshit, but the only way to properly document it would be with a Star Wars text crawl?',
      'Stories of STUPID PEOPLE from work hit harder this way.  Want to deliver a message?  This works better as well.  Regular email seems boring and not as epic after this.',
      'Fire someone this way.  Hell, I wouldn\'t even be mad about it, if I were notified like this.  Deliver bad medical news this way.  Imagine seeing, "ITS HERPES" at the top.  Lots of practical applications here.......',
    ].join('\n\n'),
    musicType: 'url',
    audio: DEFAULT_AUDIO,
    yt: '',
    musicStart: 0.5, // skips the half-second of silence before the first note
  };

  const $ = (sel) => document.querySelector(sel);
  const editor = $('#editor');
  const player = $('#player');
  const form = $('#crawl-form');
  const formError = $('#form-error');
  const playOverlay = $('#play-overlay');
  const endOverlay = $('#end-overlay');
  const speedBtn = player.querySelector('[data-action="speed"]');
  const ytDock = $('#yt-dock');

  const stars = new Starfield($('#stars'));
  const music = new Music({ audioEl: $('#local-audio'), ytMount: $('#yt-player'), ytDock });
  const crawl = new Crawl({
    viewport: $('#crawl-viewport'),
    plane: $('#crawl-plane'),
    text: $('#crawl-text'),
    intro: $('#intro-text'),
    logo: $('#logo-text'),
    episode: $('#crawl-episode'),
    title: $('#crawl-title'),
    body: $('#crawl-body'),
  }, music, stars);

  let current = null;     // the crawl data currently loaded
  let currentToken = '';  // its encoded share token
  let localAudioUrl = ''; // object URL for a picked audio file (not shareable)
  let ignoreHash = false;

  /* ------------------------------- Editor ------------------------------- */

  // Shared links don't carry musicType; infer it from what they do carry.
  function musicTypeOf(d) {
    if (d.musicType) return d.musicType;
    if (d.yt) return 'youtube';
    if (d.audio) return 'url';
    return localAudioUrl ? 'file' : 'none';
  }

  function fillForm(d) {
    form.intro.value = d.intro || '';
    form.logo.value = d.logo || '';
    form.episode.value = d.episode || '';
    form.title.value = d.title || '';
    form.body.value = d.body || '';
    form.yt.value = d.yt ? 'https://www.youtube.com/watch?v=' + d.yt : '';
    form.audioUrl.value = d.audio || DEFAULT_AUDIO;
    form.musicStart.value = d.musicStart || 0;
    const type = musicTypeOf(d);
    form.querySelector(`input[name="musicType"][value="${type}"]`).checked = true;
    syncMusicPanels();
  }

  function readForm() {
    const musicType = form.musicType.value;
    const ytId = parseYouTubeId(form.yt.value);
    return {
      intro: form.intro.value.trim(),
      logo: form.logo.value.replace(/^\s+|\s+$/g, ''),
      episode: form.episode.value.trim(),
      title: form.title.value.trim(),
      body: form.body.value.trim(),
      musicType,
      yt: musicType === 'youtube' ? ytId : '',
      audio: musicType === 'url' ? form.audioUrl.value.trim() : '',
      musicStart: musicType === 'none' ? 0 : Math.max(0, Number(form.musicStart.value) || 0),
    };
  }

  function syncMusicPanels() {
    const type = form.musicType.value;
    form.querySelectorAll('.music-panel').forEach((p) => { p.hidden = p.dataset.music !== type; });
    form.querySelectorAll('.music-start').forEach((el) => { el.hidden = type === 'none'; });
  }

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = !msg;
    if (msg) formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  form.addEventListener('change', (e) => {
    if (e.target.name === 'musicType') syncMusicPanels();
    if (e.target.name === 'audioFile') {
      const f = e.target.files && e.target.files[0];
      if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
      localAudioUrl = f ? URL.createObjectURL(f) : '';
    }
  });

  // Pasting a link with ?t=… fills in the start time.
  form.yt.addEventListener('input', () => {
    const start = parseYouTubeStart(form.yt.value);
    if (start !== null) form.musicStart.value = start;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = readForm();
    if (!d.body) return showError('Write some crawl text first.');
    if (d.musicType === 'youtube' && form.yt.value.trim() && !d.yt) {
      return showError("That doesn't look like a YouTube link. Paste the full video URL, or switch music to “No music”.");
    }
    if (d.musicType === 'url' && !/^https?:\/\/\S+$/i.test(d.audio)) {
      return showError('Paste a link to an audio file (it should start with https://), or pick a different music option.');
    }
    if (d.musicType === 'file' && !localAudioUrl) {
      return showError('Choose an audio file, or pick a different music option.');
    }
    showError('');
    const token = await encode(d);
    await openPlayer(d, token, true);
  });

  $('#reset-sample').addEventListener('click', () => { fillForm(SAMPLE); showError(''); });

  function showEditor() {
    crawl.reset();
    $('#share-sheet').hidden = true;
    exitFullscreen();
    player.hidden = true;
    editor.hidden = false;
    stars.setPan(0);
    fillForm(current ? { ...current, musicType: musicTypeOf(current) } : SAMPLE);
    document.title = 'Galactic Crawl Maker';
    window.scrollTo(0, 0);
  }

  /* ------------------------------- Player ------------------------------- */

  async function openPlayer(d, token, pushHash) {
    current = d;
    currentToken = token;
    if (pushHash) {
      ignoreHash = true;
      location.hash = 'c=' + token;
      setTimeout(() => { ignoreHash = false; }, 0);
    }
    editor.hidden = true;
    player.hidden = false;
    endOverlay.hidden = true;
    playOverlay.hidden = false;
    $('#overlay-title').textContent = [d.episode && 'Episode ' + d.episode, d.title].filter(Boolean).join('\n') || d.logo;
    document.title = (d.title || d.logo || 'Crawl').replace(/\n/g, ' ') + ' · Galactic Crawl Maker';

    crawl.setContent(d);
    setSpeed(1);

    const musicType = musicTypeOf(d);
    try {
      if (musicType === 'youtube' && d.yt) await music.setSource({ type: 'youtube', id: d.yt, start: d.musicStart });
      else if (musicType === 'url' && d.audio) await music.setSource({ type: 'url', url: d.audio, start: d.musicStart });
      else if (musicType === 'file' && localAudioUrl) await music.setSource({ type: 'file', url: localAudioUrl, start: d.musicStart });
      else await music.setSource(null);
    } catch (err) {
      console.warn('[music]', err);
      await music.setSource(null);
      toast('Music could not be loaded. Playing without it.');
    }
    ytDock.classList.remove('collapsed');
    $('#yt-toggle').setAttribute('aria-expanded', 'true');
    $('#play-big').focus({ preventScroll: true });
  }

  crawl.onStateChange = (s) => {
    player.classList.toggle('paused', s !== 'playing');
    endOverlay.hidden = s !== 'ended';
    if (s === 'playing') {
      playOverlay.hidden = true;
      bumpIdle();
      // Tuck the music player away once the show starts.
      if (!ytDock.hidden) setYtCollapsed(true);
    } else {
      player.classList.remove('idle');
      clearTimeout(idleTimer);
    }
  };

  $('#play-big').addEventListener('click', () => {
    music.prime();  // must happen inside the tap for mobile audio
    crawl.restart();
  });

  music.onBlocked = () => {
    setYtCollapsed(false);
    toast('Your browser blocked the music. Tap the music player once to allow sound.');
  };

  music.onError = (code) => {
    if (code === 'audio') {
      toast('The music couldn’t be loaded. The audio link may be broken or offline.');
      return;
    }
    const why = code === 101 || code === 150 ? "the video's owner doesn't allow it to play on other sites"
      : code === 100 ? 'the video was removed or is private'
      : code === 2 ? 'the video link is invalid'
      : 'YouTube reported an error (' + code + ')';
    setYtCollapsed(false);
    toast('This music video can’t play here: ' + why + '. Try a different video.');
  };

  const SPEEDS = [1, 1.5, 2, 0.5];
  function setSpeed(s) {
    crawl.setSpeed(s);
    speedBtn.textContent = s + '×';
  }

  function setMuted(m) {
    music.setMuted(m);
    player.classList.toggle('muted', m);
  }

  function setYtCollapsed(c) {
    ytDock.classList.toggle('collapsed', c);
    $('#yt-toggle').textContent = c ? 'Music ▸' : 'Music ▾';
    $('#yt-toggle').setAttribute('aria-expanded', String(!c));
  }
  $('#yt-toggle').addEventListener('click', () => setYtCollapsed(!ytDock.classList.contains('collapsed')));

  /* ---- fullscreen (Fullscreen API, with a CSS fallback for iPhone) ---- */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement) || player.classList.contains('pseudo-fullscreen');
  }
  function enterFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      const p = req.call(el);
      if (p && p.catch) p.catch(() => player.classList.add('pseudo-fullscreen'));
    } else {
      player.classList.add('pseudo-fullscreen');
      window.scrollTo(0, 1);
    }
  }
  function exitFullscreen() {
    player.classList.remove('pseudo-fullscreen');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  function goEdit() {
    ignoreHash = true;
    history.pushState(null, '', location.pathname + location.search);
    setTimeout(() => { ignoreHash = false; }, 0);
    showEditor();
  }

  const actions = {
    toggle: () => { if (crawl.state === 'idle') { music.prime(); crawl.restart(); } else crawl.toggle(); },
    restart: () => { music.prime(); crawl.restart(); },
    speed: () => setSpeed(SPEEDS[(SPEEDS.indexOf(crawl.speed) + 1) % SPEEDS.length]),
    mute: () => setMuted(!music.muted),
    fullscreen: () => (isFullscreen() ? exitFullscreen() : enterFullscreen()),
    share: () => openShare(),
    edit: goEdit,
  };

  player.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      actions[btn.dataset.action]();
      bumpIdle();
      return;
    }
    // Tapping the picture shows the controls (or pauses on desktop if they're already visible).
    if (e.target.closest('.yt-dock, .overlay')) return;
    if (player.classList.contains('idle')) bumpIdle();
    else if (crawl.state === 'playing' && matchMedia('(hover: hover)').matches) crawl.pause();
    else if (crawl.state === 'paused') crawl.play();
  });

  /* Auto-hide controls while playing */
  let idleTimer = 0;
  function bumpIdle() {
    player.classList.remove('idle');
    clearTimeout(idleTimer);
    if (crawl.state === 'playing') idleTimer = setTimeout(() => player.classList.add('idle'), 2800);
  }
  player.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') bumpIdle(); });

  document.addEventListener('keydown', (e) => {
    if (player.hidden || !$('#share-sheet').hidden || e.target.closest('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); actions.toggle(); }
    else if (k === 'r') actions.restart();
    else if (k === 'm') actions.mute();
    else if (k === 'f') actions.fullscreen();
    else return;
    bumpIdle();
  });

  // Pause if the tab is hidden so the music and picture don't drift apart.
  document.addEventListener('visibilitychange', () => { if (document.hidden) crawl.pause(); });

  /* ------------------------------- Sharing ------------------------------ */

  const sheet = $('#share-sheet');
  const shareUrl = $('#share-url');
  const shareStatus = $('#share-status');
  const shareMeta = $('#share-meta');
  const shortenBtn = $('#share-shorten');
  const nativeBtn = $('#share-native');
  let shareLong = '';

  function setShareUrl(url, note) {
    shareUrl.value = url;
    shareMeta.textContent = url.length + ' characters' + (note ? ' · ' + note : '');
  }

  function openShare() {
    crawl.pause();
    shareLong = urlFor(currentToken);
    setShareUrl(shareLong, current && current.musicType === 'file' ? 'your audio file is not included' : '');
    shareStatus.textContent = '';
    shortenBtn.hidden = false;
    shortenBtn.disabled = false;
    nativeBtn.hidden = !navigator.share;
    sheet.hidden = false;
    shareUrl.focus();
    shareUrl.select();
  }

  function closeShare() { sheet.hidden = true; }

  $('#share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl.value);
      shareStatus.textContent = 'Link copied!';
    } catch (_) {
      shareUrl.select();
      shareStatus.textContent = 'Press Ctrl+C (or long-press) to copy.';
    }
  });

  shortenBtn.addEventListener('click', async () => {
    shortenBtn.disabled = true;
    shareStatus.textContent = 'Shortening…';
    try {
      const short = await shorten(shareLong);
      setShareUrl(short, 'shortened with is.gd');
      shortenBtn.hidden = true;
      shareStatus.textContent = 'Short link ready.';
    } catch (err) {
      const local = /^(localhost|127\.|192\.168\.|10\.)|^\[?::1\]?$/.test(location.hostname) || location.protocol === 'file:';
      shareStatus.textContent = local
        ? 'Short links only work once the site is online. Localhost links can’t be shortened.'
        : err.message;
      shortenBtn.disabled = false;
    }
  });

  nativeBtn.addEventListener('click', () => {
    navigator.share({ title: document.title, text: 'Watch my opening crawl!', url: shareUrl.value }).catch(() => {});
  });

  $('#share-close').addEventListener('click', closeShare);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeShare(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeShare(); });

  /* ------------------------------- Toasts ------------------------------- */

  function toast(msg) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;top:max(1rem,env(safe-area-inset-top));transform:translateX(-50%);z-index:200;background:rgba(10,12,20,.95);color:#fff;border:1px solid rgba(255,232,31,.4);padding:.6rem 1rem;border-radius:10px;max-width:min(92vw,30rem);font-size:.92rem;text-align:center;transition:opacity .3s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 5000);
  }

  /* ------------------------------- Routing ------------------------------ */

  async function route() {
    if (ignoreHash) return;
    const token = tokenFromHash(location.hash);
    if (!token) {
      if (!player.hidden || editor.hidden) showEditor();
      return;
    }
    if (token === currentToken && !player.hidden) return;
    try {
      const d = await decode(token);
      if (!d.body && !d.title && !d.logo) throw new Error('empty');
      // Keep the local file choice when re-opening your own crawl.
      if (!d.yt && !d.audio && localAudioUrl && current && current.musicType === 'file') d.musicType = 'file';
      await openPlayer(d, token, false);
    } catch (err) {
      console.warn('[share] could not decode link', err);
      current = null;
      showEditor();
      showError('That crawl link looks broken or incomplete. Here’s the editor so you can make a new one.');
    }
  }

  window.addEventListener('hashchange', route);
  document.fonts && document.fonts.ready.then(() => { if (!player.hidden) crawl.layout(); });
  route();
})();
