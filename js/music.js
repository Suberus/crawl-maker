/*
 * Music sources behind one interface:
 *   - YouTube (IFrame Player API) — the video ID travels in share links
 *   - a local audio file — this device only
 *   - none
 * The crawl timeline drives it with start/pause/resume/seek/stop.
 */
(function () {
  'use strict';

  let ytApiPromise = null;
  function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApiPromise = null; reject(new Error('Could not load YouTube.')); };
      document.head.appendChild(s);
    });
    return ytApiPromise;
  }

  /* Accepts a full YouTube URL (watch, youtu.be, shorts, embed, music) or a bare ID. */
  function parseYouTubeId(input) {
    const s = (input || '').trim();
    if (!s) return '';
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s.includes('://') ? s : 'https://' + s);
      const host = u.hostname.replace(/^(www|m|music)\./, '');
      if (host === 'youtu.be') {
        const id = u.pathname.split('/')[1];
        return /^[\w-]{11}$/.test(id) ? id : '';
      }
      if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        const v = u.searchParams.get('v');
        if (v && /^[\w-]{11}$/.test(v)) return v;
        const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
        if (m) return m[1];
      }
    } catch (_) { /* not a URL */ }
    return '';
  }

  /* Pulls ?t=90 / ?t=1m30s / &start=90 out of a pasted link, if present. */
  function parseYouTubeStart(input) {
    try {
      const u = new URL((input || '').includes('://') ? input : 'https://' + input);
      const t = u.searchParams.get('t') || u.searchParams.get('start');
      if (!t) return null;
      if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
      const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
      if (m) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    } catch (_) { /* ignore */ }
    return null;
  }

  class Music {
    constructor({ audioEl, ytMount, ytDock }) {
      this.audio = audioEl;
      this.ytMount = ytMount;
      this.ytDock = ytDock;
      this.type = 'none';
      this.offset = 0;      // seconds into the track where the crawl's music begins
      this.rate = 1;
      this.muted = false;
      this.yt = null;
      this.ytReady = null;
      this.ytId = '';
      this.onBlocked = null; // called if the browser refuses to play sound
      this.onError = null;   // called with a YouTube error code
      this.objectUrl = null;
    }

    async setSource(src) {
      this.stop();
      // 'file' (picked from the device) and 'url' (a link) both play through <audio>.
      const kind = (src && src.type) || 'none';
      this.type = kind === 'url' ? 'file' : kind;
      this.offset = (src && src.start) || 0;
      this.ytDock.hidden = this.type !== 'youtube';

      if (this.type === 'file') {
        if (kind === 'file') {
          if (this.objectUrl && this.objectUrl !== src.url) URL.revokeObjectURL(this.objectUrl);
          this.objectUrl = src.url;
        }
        if (this.audio.src !== src.url) {
          this.audio.onerror = () => { if (this.onError) this.onError('audio'); };
          this.audio.src = src.url;
          this.audio.load();
        }
      } else if (this.type === 'youtube') {
        await this._ensureYouTube(src.id);
      }
    }

    _ensureYouTube(id) {
      if (this.yt && this.ytId === id) return this.ytReady;
      this.ytId = id;
      if (this.yt) {
        this.yt.cueVideoById({ videoId: id, startSeconds: this.offset });
        return this.ytReady;
      }
      this.ytReady = loadYouTubeApi().then((YT) => new Promise((resolve) => {
        this.yt = new YT.Player(this.ytMount, {
          videoId: id,
          width: '200',
          height: '200',
          playerVars: { playsinline: 1, rel: 0, controls: 1, start: Math.floor(this.offset), origin: location.origin },
          events: {
            onReady: () => resolve(this.yt),
            onError: (e) => {
              console.warn('[music] YouTube error', e.data);
              if (this.onError) this.onError(e.data);
            },
          },
        });
      }));
      return this.ytReady;
    }

    /*
     * Must be called synchronously inside the Play tap/click. Mobile browsers
     * only allow sound that was started from a user gesture, so we start and
     * immediately pause the track here to "unlock" it for later.
     */
    prime() {
      if (this.type === 'file') {
        const a = this.audio;
        a.muted = true;
        const p = a.play();
        if (p) p.then(() => { a.pause(); a.currentTime = this.offset; a.muted = this.muted; })
          .catch(() => { a.muted = this.muted; });
      } else if (this.type === 'youtube' && this.yt && this.yt.playVideo) {
        const yt = this.yt;
        // Silent so the unlock doesn't blast the first note early.
        const vol = yt.getVolume();
        yt.setVolume(0);
        yt.seekTo(this.offset, true);
        yt.playVideo();
        let tries = 0;
        const check = setInterval(() => {
          const st = yt.getPlayerState();
          if (st === 1 && !this._playing) {           // PLAYING: unlocked, now hold
            yt.pauseVideo();
            yt.seekTo(this.offset, true);
            yt.setVolume(vol);
            clearInterval(check);
          } else if (st === 1 || ++tries > 30) {
            clearInterval(check);
            yt.setVolume(vol);
            if (st !== 1 && this.onBlocked) this.onBlocked();
          }
        }, 100);
      }
    }

    /* Play from `pos` seconds after the crawl's music cue. */
    playAt(pos) {
      const t = this.offset + Math.max(0, pos);
      this._playing = true;
      if (this.type === 'file') {
        const a = this.audio;
        if (a.duration && t >= a.duration) return;
        a.currentTime = t;
        a.playbackRate = this.rate;
        a.muted = this.muted;
        a.play().catch(() => this.onBlocked && this.onBlocked());
      } else if (this.type === 'youtube' && this.yt && this.yt.playVideo) {
        this.yt.seekTo(t, true);
        this.yt.setPlaybackRate(this.rate);
        this.muted ? this.yt.mute() : this.yt.unMute();
        this.yt.playVideo();
      }
    }

    pause() {
      this._playing = false;
      if (this.type === 'file') this.audio.pause();
      else if (this.type === 'youtube' && this.yt && this.yt.pauseVideo) this.yt.pauseVideo();
    }

    stop() {
      this.pause();
      if (this.type === 'file' && this.audio.src) {
        try { this.audio.currentTime = this.offset; } catch (_) { /* not loaded yet */ }
      } else if (this.type === 'youtube' && this.yt && this.yt.seekTo) {
        this.yt.seekTo(this.offset, true);
        this.yt.pauseVideo();
      }
    }

    /* Fades the volume out over `ms` and then pauses. */
    fadeOut(ms) {
      const steps = 20;
      let i = 0;
      const getVol = () => (this.type === 'file' ? this.audio.volume : (this.yt && this.yt.getVolume ? this.yt.getVolume() / 100 : 1));
      const setVol = (v) => {
        if (this.type === 'file') this.audio.volume = v;
        else if (this.yt && this.yt.setVolume) this.yt.setVolume(Math.round(v * 100));
      };
      const start = getVol();
      clearInterval(this._fade);
      this._fade = setInterval(() => {
        i++;
        setVol(start * (1 - i / steps));
        if (i >= steps) {
          clearInterval(this._fade);
          this.pause();
          setVol(start);
        }
      }, ms / steps);
    }

    cancelFade() { clearInterval(this._fade); }

    setRate(r) {
      this.rate = r;
      if (this.type === 'file') this.audio.playbackRate = r;
      else if (this.type === 'youtube' && this.yt && this.yt.setPlaybackRate) this.yt.setPlaybackRate(r);
    }

    setMuted(m) {
      this.muted = m;
      if (this.type === 'file') this.audio.muted = m;
      else if (this.type === 'youtube' && this.yt && this.yt.mute) (m ? this.yt.mute() : this.yt.unMute());
    }
  }

  window.CrawlMusic = { Music, parseYouTubeId, parseYouTubeStart };
})();
