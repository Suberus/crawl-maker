/*
 * The crawl: starfield + a single master clock that drives every element.
 * All motion is computed from `t` (timeline seconds), so pause, restart and
 * speed changes are trivial and the music can always be resynced to it.
 *
 * Timeline (at 1x):
 *   0.0 – 6.0   blue intro line fades in, holds, fades out
 *   7.0         music cue + logo appears, oversized, and recedes for ~9s
 *   8.6 – …     crawl text scrolls up the tilted plane into the distance
 *   end – 2s    camera pans down the starfield; music fades out
 */
(function () {
  'use strict';

  const T = {
    introIn: 1, introHold: 5, introOut: 6,
    music: 7,
    logoLen: 9.5,
    crawl: 8.6,
    panLen: 7,
  };
  const TILT_DEG = 55;

  /* ------------------------------ Starfield ----------------------------- */

  class Starfield {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.seed = 1977;
      this.resize = this.resize.bind(this);
      window.addEventListener('resize', this.resize);
      this.resize();
    }

    rand() {
      // Deterministic so stars don't jump around on resize.
      this.seed = (this.seed * 16807) % 2147483647;
      return (this.seed - 1) / 2147483646;
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight * 1.6;
      if (this._w === w && this._h === h) return;
      this._w = w; this._h = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.height = h + 'px';
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      this.seed = 1977;
      const count = Math.round((w * h) / 2600);
      for (let i = 0; i < count; i++) {
        const x = this.rand() * w;
        const y = this.rand() * h;
        const r = this.rand();
        const size = r > 0.985 ? 1.5 : r > 0.9 ? 1.1 : 0.7;
        const a = 0.35 + this.rand() * 0.65;
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // A planet rim rising at the bottom, revealed by the final pan.
      const vh = window.innerHeight;
      const R = Math.max(w, vh) * 1.6;
      const cx = w * 0.5;
      const cy = h + R - vh * 0.22;
      const rim = ctx.createRadialGradient(cx, cy, R * 0.985, cx, cy, R * 1.03);
      rim.addColorStop(0, 'rgba(120,170,255,0.55)');
      rim.addColorStop(0.45, 'rgba(70,120,220,0.18)');
      rim.addColorStop(1, 'rgba(40,80,180,0)');
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.03, 0, Math.PI * 2);
      ctx.fill();
      const body = ctx.createLinearGradient(0, cy - R, 0, cy - R + vh * 0.25);
      body.addColorStop(0, '#0b1a33');
      body.addColorStop(1, '#010309');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
    }

    setPan(p) {
      // p: 0 = top of the sky, 1 = looking down at the planet
      const shift = window.innerHeight * 0.6 * p;
      this.canvas.style.transform = shift ? `translate3d(0, ${-shift}px, 0)` : '';
    }
  }

  /* -------------------------------- Crawl ------------------------------- */

  const ease = (x) => x * x * (3 - 2 * x);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  class Crawl {
    constructor(els, music, starfield) {
      this.els = els;
      this.music = music;
      this.stars = starfield;
      this.t = 0;
      this.speed = 1;
      this.state = 'idle'; // idle | playing | paused | ended
      this.musicStarted = false;
      this.fadeStarted = false;
      this.onStateChange = null;
      this._tick = this._tick.bind(this);
      this._raf = 0;
      this.layout = this.layout.bind(this);
      window.addEventListener('resize', this.layout);
    }

    setContent(data) {
      const { intro, logo, episode, title, body } = this.els;
      intro.textContent = data.intro;
      logo.textContent = (data.logo || '').toUpperCase();
      episode.textContent = data.episode ? 'Episode ' + data.episode : '';
      episode.hidden = !data.episode;
      title.textContent = data.title || '';
      title.hidden = !data.title;
      body.replaceChildren();
      (data.body || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).forEach((para) => {
        const p = document.createElement('p');
        p.textContent = para.replace(/\s*\n\s*/g, ' ');
        body.appendChild(p);
      });
      this.layout();
      this.reset();
    }

    /* Sizes everything from the viewport so phones and desktops look alike. */
    layout() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const { viewport, plane, text, logo } = this.els;

      // Crawl column width & font: the film fits ~30 characters per line.
      const colW = Math.min(W * 0.94, H * 1.35, 1100);
      const font = colW / 15.5;
      // Vanishing line sits ~10% from the top: perspective = dist * tan(tilt).
      const vanishAbove = H * 0.40;
      const persp = vanishAbove * Math.tan((TILT_DEG * Math.PI) / 180);

      viewport.style.perspective = persp + 'px';
      text.style.fontSize = font + 'px';
      plane.style.width = colW + 'px';
      plane.style.marginLeft = -colW / 2 + 'px';
      plane.style.transform = `rotateX(${TILT_DEG}deg)`;

      this.contentH = text.offsetHeight;
      // Distance the text must travel so its last line is deep in the fade.
      this.travel = this.contentH + persp * 3.2 / Math.sin((TILT_DEG * Math.PI) / 180);
      plane.style.height = this.travel + 'px';
      // Plane-units per second: roughly one line every ~2.2s at the bottom, like the film.
      this.pxPerSec = font * 0.62;
      this.crawlLen = this.travel / this.pxPerSec;
      this.panStart = T.crawl + this.crawlLen - 3;
      this.total = this.panStart + T.panLen;

      // Logo: fit its natural size to ~85% of the screen width.
      logo.style.transform = 'none';
      logo.style.fontSize = '100px';
      const lw = logo.scrollWidth || 1;
      const lh = logo.scrollHeight || 1;
      const fit = Math.min((W * 0.86) / lw, (H * 0.6) / lh);
      logo.style.fontSize = 100 * fit + 'px';

      if (this.state !== 'playing') this._render();
    }

    reset() {
      cancelAnimationFrame(this._raf);
      this.t = 0;
      this.musicStarted = false;
      this.fadeStarted = false;
      this.music.cancelFade();
      this.music.stop();
      this._setState('idle');
      this._render();
    }

    play() {
      if (this.state === 'playing') return;
      if (this.state === 'ended') this.reset();
      this._setState('playing');
      // Resume music in sync with where the picture is.
      if (this.t >= T.music && !this.fadeStarted) {
        this.musicStarted = true;
        this.music.playAt(this.t - T.music);
      }
      this._last = performance.now();
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(this._tick);
    }

    pause() {
      if (this.state !== 'playing') return;
      cancelAnimationFrame(this._raf);
      this.music.pause();
      this._setState('paused');
    }

    toggle() { this.state === 'playing' ? this.pause() : this.play(); }

    restart() {
      this.reset();
      this.play();
    }

    setSpeed(s) {
      this.speed = s;
      this.music.setRate(s);
    }

    _setState(s) {
      this.state = s;
      if (this.onStateChange) this.onStateChange(s);
    }

    _tick(now) {
      if (this.state !== 'playing') return; // a stale frame after pause/reset
      const dt = Math.min(0.1, (now - this._last) / 1000);
      this._last = now;
      this.t += dt * this.speed;

      if (!this.musicStarted && this.t >= T.music) {
        this.musicStarted = true;
        this.music.playAt(this.t - T.music);
      }
      if (!this.fadeStarted && this.t >= this.total - 4) {
        this.fadeStarted = true;
        this.music.fadeOut(4000 / this.speed);
      }

      this._render();

      if (this.t >= this.total) {
        this._setState('ended');
        return;
      }
      this._raf = requestAnimationFrame(this._tick);
    }

    _render() {
      const t = this.t;
      const { intro, logo, text } = this.els;

      // Intro line
      let io = 0;
      if (t < T.introIn) io = t / T.introIn;
      else if (t < T.introHold) io = 1;
      else if (t < T.introOut) io = 1 - (t - T.introHold) / (T.introOut - T.introHold);
      intro.style.opacity = this.state === 'idle' ? 0 : clamp01(io).toFixed(3);

      // Logo: starts larger than the screen, shrinks exponentially.
      const lt = t - T.music;
      if (lt >= 0 && lt < T.logoLen) {
        const scale = 1.55 * Math.exp(-0.5 * lt);
        const op = lt > T.logoLen - 2 ? (T.logoLen - lt) / 2 : 1;
        logo.style.opacity = clamp01(op).toFixed(3);
        logo.style.transform = `scale(${scale.toFixed(4)})`;
      } else {
        logo.style.opacity = 0;
      }

      // Crawl text: slides up the tilted plane.
      const ct = Math.max(0, t - T.crawl);
      const y = Math.min(this.travel, ct * this.pxPerSec);
      text.style.transform = `translate3d(0, ${(-y).toFixed(2)}px, 0)`;

      // Final pan: the camera tilts down, so stars and crawl both slide up.
      const pan = ease(clamp01((t - this.panStart) / T.panLen));
      this.stars.setPan(pan);
      const shift = window.innerHeight * 0.6 * pan;
      this.els.viewport.style.transform = shift ? `translate3d(0, ${-shift}px, 0)` : '';
    }
  }

  window.CrawlEngine = { Crawl, Starfield, TIMELINE: T };
})();
