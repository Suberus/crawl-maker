/*
 * Share links: the whole crawl is packed into the URL hash, so no server is
 * needed. Format: #c=<prefix><base64url>
 *   prefix "z" = deflate-raw compressed JSON (CompressionStream)
 *   prefix "u" = plain UTF-8 JSON (fallback for browsers without compression)
 */
(function () {
  'use strict';

  // The default theme track. Links that use it store just `a: 1` to stay short.
  const DEFAULT_AUDIO = 'https://archive.org/download/tvtunes_4617/Star%20Wars.mp3';
  const KEYS = { intro: 'i', logo: 'l', episode: 'e', title: 't', body: 'b', yt: 'y', audio: 'a', musicStart: 's' };
  const LIMITS = { intro: 200, logo: 60, episode: 20, title: 80, body: 3000 };

  function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function pipe(bytes, stream) {
    const out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  function pack(data) {
    const o = {};
    for (const [k, short] of Object.entries(KEYS)) {
      const v = data[k];
      if (v === undefined || v === null || v === '' || (k === 'musicStart' && !v)) continue;
      o[short] = k === 'audio' && v === DEFAULT_AUDIO ? 1 : v;
    }
    return o;
  }

  function unpack(o) {
    if (!o || typeof o !== 'object') throw new Error('bad data');
    const data = {};
    for (const [k, short] of Object.entries(KEYS)) {
      const v = o[short];
      if (k === 'musicStart') {
        const n = Number(v);
        data.musicStart = Number.isFinite(n) && n >= 0 && n < 36000 ? n : 0;
      } else if (k === 'yt') {
        data.yt = typeof v === 'string' && /^[\w-]{11}$/.test(v) ? v : '';
      } else if (k === 'audio') {
        data.audio = v === 1 ? DEFAULT_AUDIO
          : typeof v === 'string' && v.length <= 600 && /^https?:\/\//i.test(v) ? v : '';
      } else {
        data[k] = typeof v === 'string' ? v.slice(0, LIMITS[k]) : '';
      }
    }
    return data;
  }

  async function encode(data) {
    const json = new TextEncoder().encode(JSON.stringify(pack(data)));
    if (canCompress) {
      try {
        return 'z' + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
      } catch (_) { /* fall through */ }
    }
    return 'u' + toBase64Url(json);
  }

  async function decode(token) {
    const kind = token[0];
    let bytes = fromBase64Url(token.slice(1));
    if (kind === 'z') {
      if (!canCompress) throw new Error('This browser is too old to open compressed links.');
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'u') {
      throw new Error('Unknown link format');
    }
    return unpack(JSON.parse(new TextDecoder().decode(bytes)));
  }

  function tokenFromHash(hash) {
    const m = /^#c=([A-Za-z0-9_-]+)$/.exec(hash || '');
    return m ? m[1] : null;
  }

  function urlFor(token) {
    const u = new URL(location.href);
    u.hash = 'c=' + token;
    return u.toString();
  }

  /*
   * Optional shortener via is.gd's JSONP API (it doesn't send CORS headers,
   * so a <script> callback is the only way to call it from a static site).
   * is.gd refuses localhost / private URLs, so this only works once hosted.
   */
  function shorten(longUrl) {
    return new Promise((resolve, reject) => {
      const cb = '__isgd_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timer = setTimeout(() => done(new Error('The shortener did not respond.')), 10000);
      let settled = false;
      function done(err, val) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        err ? reject(err) : resolve(val);
      }
      window[cb] = (res) => {
        if (res && res.shorturl) done(null, res.shorturl);
        else done(new Error((res && res.errormessage) || 'The shortener rejected this link.'));
      };
      script.onerror = () => done(new Error('Could not reach the shortener.'));
      // A JSONP reply runs before onload fires. If onload comes first, is.gd sent
      // plain text instead (e.g. "Error, database insert failed" during outages).
      script.onload = () => done(new Error('The shortener (is.gd) is having problems right now. Try again later, or share the full link. It works the same.'));
      script.src = 'https://is.gd/create.php?format=json&callback=' + cb + '&url=' + encodeURIComponent(longUrl);
      document.head.appendChild(script);
    });
  }

  window.CrawlShare = { encode, decode, tokenFromHash, urlFor, shorten, DEFAULT_AUDIO };
})();
