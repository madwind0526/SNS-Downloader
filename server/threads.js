const https = require('https');
const http  = require('http');
const fs    = require('fs');
const dns   = require('dns').promises;
const net   = require('net');

// Match Threads post URLs: threads.com/@user/post/CODE
function isThreadsUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === 'threads.com' || host === 'www.threads.com') &&
      /^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

// Extract the @username from URL for display
function extractUploader(url) {
  try {
    const m = new URL(url).pathname.match(/^\/@([^/]+)\/post\//);
    return m ? `@${m[1]}` : '';
  } catch {
    return '';
  }
}

// Parse Netscape cookies.txt → Cookie header string for threads.com
function buildCookieHeader(cookiePath) {
  if (!cookiePath || !fs.existsSync(cookiePath)) return '';
  try {
    const lines = fs.readFileSync(cookiePath, 'utf8').split('\n');
    const pairs = [];
    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const cookieDomain = parts[0];
      const name  = parts[5];
      const value = parts[6].trim();
      // Include cookies scoped to threads.com or .threads.com
      const bare = cookieDomain.replace(/^\./, '');
      if (bare === 'threads.com' || bare === 'www.threads.com') {
        pairs.push(`${name}=${value}`);
      }
    }
    return pairs.join('; ');
  } catch {
    return '';
  }
}

const ALLOWED_REDIRECT_BASES = ['threads.com', 'threads.net', 'cdninstagram.com', 'fbcdn.net'];

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB cap — Threads pages are ~850 KB

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_REDIRECT_BASES.some(base => host === base || host.endsWith(`.${base}`));
}

function normalizeIpHost(hostname) {
  return String(hostname || '').replace(/^\[(.*)\]$/, '$1');
}

function ipv4FromMappedIpv6(address) {
  const normalized = normalizeIpHost(address).toLowerCase();
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;
  return [
    (high >> 8) & 255,
    high & 255,
    (low >> 8) & 255,
    low & 255,
  ].join('.');
}

function isPrivateIpAddress(address) {
  if (!address) return true;
  const ipAddress = normalizeIpHost(address);
  const mappedIpv4 = ipv4FromMappedIpv6(ipAddress);
  if (mappedIpv4) return isPrivateIpAddress(mappedIpv4);
  if (net.isIP(ipAddress) === 4) {
    return /^127\./.test(ipAddress) ||
      /^10\./.test(ipAddress) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ipAddress) ||
      /^192\.168\./.test(ipAddress) ||
      /^169\.254\./.test(ipAddress) ||
      /^0\./.test(ipAddress);
  }
  const normalized = ipAddress.toLowerCase();
  return normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:');
}

async function resolveTrustedPublicUrl(targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { throw new Error(`Invalid URL: ${targetUrl}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Invalid protocol: ${parsed.protocol}`);
  if (!isAllowedHost(parsed.hostname)) throw new Error(`Disallowed redirect host: ${parsed.hostname}`);

  const hostname = normalizeIpHost(parsed.hostname);
  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) throw new Error('Blocked private host');
    return { parsed, address: hostname, family: net.isIP(hostname) };
  }

  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(entry => isPrivateIpAddress(entry.address))) {
    throw new Error('Blocked private host');
  }
  return { parsed, address: addresses[0].address, family: addresses[0].family };
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Meta serves fully server-side-rendered post content (including
// video_versions JSON) to search engine crawlers.
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// GET a URL with cookies; follows up to 5 redirects; returns { status, body }
async function fetchUrl(targetUrl, cookieHeader, redirectCount, userAgent) {
  if (redirectCount === undefined) redirectCount = 0;
  if (redirectCount > 5) throw new Error('Too many redirects');
  const checked = await resolveTrustedPublicUrl(targetUrl);
  const parsed = checked.parsed;
  return new Promise((resolve, reject) => {
    const lib  = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      timeout:  20000,
      // Node >= 20 autoSelectFamily calls lookup with options.all=true and
      // expects an array callback; a bare string there fails with
      // "Invalid IP address: undefined".
      lookup:   (hostname, options, callback) => {
        if (options && options.all) {
          return callback(null, [{ address: checked.address, family: checked.family }]);
        }
        return callback(null, checked.address, checked.family);
      },
      headers: {
        'User-Agent':      userAgent || BROWSER_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',  // avoid gzip — Node built-in https doesn't auto-decompress
        'Cookie':          cookieHeader,
        'Sec-Fetch-Dest':  'document',
        'Sec-Fetch-Mode':  'navigate',
        'Sec-Fetch-Site':  'none',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    const req = lib.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, targetUrl).toString(); }
        catch { return reject(new Error(`Bad redirect location: ${res.headers.location}`)); }
        res.resume();
        // Strip session cookie when redirecting to a different hostname
        const nextHostname = new URL(next).hostname;
        const nextCookie = nextHostname === parsed.hostname ? cookieHeader : '';
        return fetchUrl(next, nextCookie, redirectCount + 1, userAgent).then(resolve, reject);
      }

      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        size += Buffer.byteLength(chunk, 'utf8');
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('Response too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// Unescape JSON-encoded URL characters embedded in HTML
function unescapeUrl(raw) {
  return raw
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003F/gi, '?')
    .replace(/\\u003D/gi, '=')
    .replace(/\\\//g,     '/');
}

// Extract the best video URL from Threads page HTML.
// Threads SSR embeds data as JSON inside <script> tags — video URLs appear as
// "video_url":"https://..." in JSON blobs within those tags. In the crawler
// (SSR) view the post JSON is nested inside another JSON string, so keys and
// URLs arrive escaped (\"video_versions\", https:\/\/...) — scan a
// backslash-normalized copy as well.
function extractVideoUrlOnce(html) {
  // Strategy 1: explicit "video_url" JSON key (most reliable)
  const jsonKeyRe = /"video_url"\s*:\s*"(https:\/\/[^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m = jsonKeyRe.exec(html);
  if (m) return unescapeUrl(m[1]);

  // Strategy 2: "video_versions" array — take the first entry's url (highest quality)
  const versionsRe = /"video_versions"\s*:\s*\[.*?"url"\s*:\s*"(https:\/\/[^"\\]*(?:\\.[^"\\]*)*)"/s;
  m = versionsRe.exec(html);
  if (m) return unescapeUrl(m[1]);

  // Strategy 3: any MP4 URL on Instagram/Threads CDN
  const cdnRe = /https:\/\/(?:scontent|video)[^\s"'<>]*\.cdninstagram\.com\/[^\s"'<>]*\.mp4[^\s"'<>]*/;
  m = cdnRe.exec(html);
  if (m) return unescapeUrl(m[0]);

  return null;
}

function extractVideoUrl(html) {
  const direct = extractVideoUrlOnce(html);
  if (direct) return direct;
  const normalized = html.replace(/\\+"/g, '"').replace(/\\+\//g, '/');
  return extractVideoUrlOnce(normalized);
}

// Extract thumbnail from og:image meta tag
function extractThumbnail(html) {
  const m = html.match(/<meta\s[^>]*property="og:image"\s[^>]*content="([^"]+)"/i)
         || html.match(/<meta\s[^>]*content="([^"]+)"\s[^>]*property="og:image"/i);
  return m ? m[1] : null;
}

// Extract title from og:title meta tag
function extractTitle(html) {
  const m = html.match(/<meta\s[^>]*property="og:title"\s[^>]*content="([^"]+)"/i)
         || html.match(/<meta\s[^>]*content="([^"]+)"\s[^>]*property="og:title"/i);
  if (m) return m[1];
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? t[1].trim() : 'Threads Video';
}

// ── Main export ────────────────────────────────────────────────────────────────
// cookiePath: path to a Netscape cookies.txt containing threads.com cookies
// Returns { items } in the same shape as /api/info so the caller can res.json() it.
async function fetchThreadsInfo(postUrl, cookiePath) {
  const cookieHeader = buildCookieHeader(cookiePath);
  console.log(`[threads] fetching post url=${postUrl.slice(0, 80)} cookie_bytes=${cookieHeader.length}`);

  const { status, body } = await fetchUrl(postUrl, cookieHeader);
  console.log(`[threads] page status=${status} body_len=${body.length}`);

  if (status === 404) throw new Error('Threads 포스트를 찾을 수 없습니다 (404).');
  if (status === 401 || status === 403) throw new Error('Threads 포스트에 접근할 수 없습니다. 쿠키가 만료되었을 수 있습니다.');
  if (status !== 200) throw new Error(`Threads 페이지 응답 오류 (HTTP ${status}).`);

  if (body.length < 500) {
    throw new Error('Threads 페이지 응답이 비어 있습니다. 쿠키가 유효한지 확인해 주세요.');
  }

  let videoUrl = extractVideoUrl(body);
  let pageHtml = body;

  // The browser view is a JS shell without post data; the crawler view is
  // fully server-side rendered. Retry anonymously with a crawler UA
  // (no cookies — never present a logged-in session as a bot).
  if (!videoUrl) {
    console.log('[threads] no video in browser view — retrying with crawler UA');
    const crawler = await fetchUrl(postUrl, '', 0, CRAWLER_UA);
    console.log(`[threads] crawler view status=${crawler.status} body_len=${crawler.body.length}`);
    if (crawler.status === 200 && crawler.body.length > 500) {
      videoUrl = extractVideoUrl(crawler.body);
      if (videoUrl) pageHtml = crawler.body;
    }
  }

  if (!videoUrl) {
    throw new Error('이 포스트에서 영상 URL을 찾을 수 없습니다. 이미지 전용 포스트이거나 페이지 구조가 변경되었을 수 있습니다.');
  }

  const thumbnail = extractThumbnail(pageHtml);
  const title     = extractTitle(pageHtml);
  const uploader  = extractUploader(postUrl);

  console.log(`[threads] ok title="${title}" uploader="${uploader}" video=${videoUrl.slice(0, 60)}...`);

  return {
    items: [{
      itemUrl:   videoUrl,
      title,
      uploader,
      thumbnail,
      duration:  null,
      mediaType: 'video',
      formats: [{
        id:        'direct',
        ext:       'mp4',
        height:    null,
        width:     null,
        fps:       null,
        vcodec:    'h264',
        acodec:    'aac',
        video_ext: 'mp4',
        audio_ext: 'none',
        filesize:  null,
      }],
    }],
  };
}

module.exports = { isThreadsUrl, fetchThreadsInfo };
