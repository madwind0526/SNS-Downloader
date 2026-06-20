const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { execFile, spawn, exec, execSync } = require('child_process');
const fs       = require('fs');
const crypto   = require('crypto');
const https    = require('https');
const http     = require('http');
const os       = require('os');
const QRCode   = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3001;

// yt-dlp binary path — Windows local uses .exe, Linux (Render) uses system-installed binary
const YT_DLP = process.platform === 'win32'
  ? path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
  : 'yt-dlp';

// Simple server-side config (cookies path, etc.)
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// Returns cookies args for yt-dlp — file mode or browser mode
function cookiesArgs() {
  const c = loadConfig();
  if (c.cookiesPath && fs.existsSync(c.cookiesPath)) return ['--cookies', c.cookiesPath];
  if (c.cookiesBrowser) return ['--cookies-from-browser', c.cookiesBrowser];
  return [];
}

// ── Browser cookie extraction via yt-dlp ─────────────────────────
// yt-dlp handles its own DPAPI decryption. We try each browser in order.
// If the browser is currently running, its SQLite DB is locked and yt-dlp fails.
// In that case we surface a clear "close browser and retry" message.
const BROWSERS = ['chrome', 'edge', 'firefox', 'chromium', 'brave'];

async function extractCookiesViaBrowser() {
  let lockedBrowser = null;

  for (const browser of BROWSERS) {
    try {
      await new Promise((resolve, reject) => {
        execFile(YT_DLP,
          ['--cookies-from-browser', browser, '--skip-download',
           '--quiet', '--no-warnings', 'https://www.instagram.com/'],
          { timeout: 20000 },
          (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve()
        );
      });
      console.log(`[cookies] using browser: ${browser}`);
      const c = loadConfig();
      c.cookiesBrowser = browser;
      delete c.cookiesPath;
      saveConfig(c);
      return browser;
    } catch (e) {
      const msg = String(e);
      if (msg.includes('Could not copy') && !lockedBrowser) lockedBrowser = browser;
      console.log(`[cookies] ${browser}: ${msg.split('\n')[0]}`);
    }
  }

  if (lockedBrowser) {
    // Browser is running but SQLite is locked — ask user to close it briefly
    throw Object.assign(
      new Error(`${lockedBrowser} 쿠키를 읽으려면 브라우저를 잠시 닫아야 합니다.\n${lockedBrowser}을 닫은 후 [재시도]를 눌러주세요.`),
      { needClose: true, browser: lockedBrowser }
    );
  }

  throw new Error('브라우저에서 Instagram 로그인을 찾을 수 없습니다.\n브라우저에서 instagram.com에 로그인 후 다시 시도해주세요.');
}

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Keep server alive — log unhandled errors instead of crashing
process.on('uncaughtException', err => {
  console.error('[UNCAUGHT]', err.message, err.stack);
  try { fs.appendFileSync(path.join(__dirname, '..', 'crash.log'), `[${new Date().toISOString()}] ${err.stack}\n`); } catch {}
});
process.on('unhandledRejection', reason => {
  console.error('[UNHANDLED REJECTION]', reason);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── GET /health ──────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── GET /api/localip ─────────────────────────
// Returns the PC's LAN IP so Android (same Wi-Fi) can connect directly
app.get('/api/localip', (req, res) => {
  const ifaces = os.networkInterfaces();
  let ip = null;
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
    }
    if (ip) break;
  }
  res.json({ ip: ip || 'localhost', port: PORT });
});

// ── GET /api/qr ──────────────────────────────
// Returns an SVG QR code for the given URL
app.get('/api/qr', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg', margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) {
    res.status(500).send('QR 생성 실패');
  }
});

// ── POST /api/info ───────────────────────────
// Returns all media items from URL. Auto-retries with Chrome cookies on login errors.
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  const BASE_ARGS = [
    '--dump-json', '--no-warnings',
    '--retries', '3', '--fragment-retries', '3',
    '--socket-timeout', '30',
    '--playlist-items', '1-10',
  ];

  const runYtDlp = () => new Promise((resolve, reject) => {
    execFile(YT_DLP, [...BASE_ARGS, ...cookiesArgs(), url], { timeout: 90000 },
      (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve(stdout)
    );
  });

  const parseStdout = (stdout) => {
    const hasVideo = f =>
      (f.vcodec && f.vcodec !== 'none') ||
      (f.video_ext && f.video_ext !== 'none' && f.video_ext !== 'images');

    const mapFormat = f => ({
      id: f.format_id, ext: f.ext, height: f.height || null, width: f.width || null,
      fps: f.fps || null, vcodec: f.vcodec || 'none', acodec: f.acodec || 'none',
      video_ext: f.video_ext || 'none', audio_ext: f.audio_ext || 'none', filesize: f.filesize || null,
    });

    const VIDEO_EXTS = new Set(['mp4','webm','mkv','avi','mov','m4v','flv','ts']);

    const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
    return lines.map(l => {
      const info = JSON.parse(l);
      let fmts = info.formats || [];
      // Instagram-style: direct url instead of formats array — synthesize one entry
      if (!fmts.length && info.url) {
        const isVid = VIDEO_EXTS.has(info.ext || '');
        fmts = [{ format_id: 'direct', ext: info.ext || 'mp4',
          height: info.height || null, width: info.width || null, fps: info.fps || null,
          vcodec: isVid ? 'h264' : 'none', acodec: isVid ? 'aac' : 'none',
          video_ext: isVid ? (info.ext || 'mp4') : 'none', audio_ext: 'none', filesize: info.filesize || null }];
      }
      const isImage = ['jpg','jpeg','png','gif','webp'].includes(info.ext) || !fmts.some(hasVideo);
      return {
        itemUrl:   info.url || info.webpage_url || info.original_url || url,
        title:     info.title,
        uploader:  info.uploader || info.channel || '',
        thumbnail: info.thumbnail,
        duration:  info.duration,
        mediaType: isImage ? 'image' : 'video',
        formats:   fmts.map(mapFormat),
      };
    });
  };

  const isLoginError = t =>
    t.includes('login_required') || t.includes('empty media') ||
    t.includes('Login required') || t.includes('로그인');

  try {
    // First attempt
    let stdout;
    try {
      stdout = await runYtDlp();
    } catch (errText) {
      // Auto-retry: let yt-dlp extract browser cookies and try again
      if (isLoginError(errText)) {
        console.log('[info] login required — trying browser cookies...');
        try {
          await extractCookiesViaBrowser();
          stdout = await runYtDlp(); // second attempt with browser cookies
        } catch (retryErr) {
          const msg = typeof retryErr === 'string' ? retryErr : retryErr.message;
          return res.status(400).json({
            error: msg,
            needClose: retryErr.needClose || false,
            browser: retryErr.browser || null,
          });
        }
      } else if (errText.includes('No video could be found') || errText.includes('no video') ||
                 errText.includes('No video formats found')) {
        const images = await extractImagesFromPage(url);
        if (images.length) return res.json({ items: images });
        if (errText.includes('[Tumblr]'))   return res.status(400).json({ error: 'Tumblr 이미지 포스트는 지원되지 않습니다.' });
        if (errText.includes('[Pinterest]')) return res.status(400).json({ error: 'Pinterest 이미지 핀은 지원되지 않습니다.' });
        return res.status(400).json({ error: '이 포스트에서 미디어를 찾을 수 없습니다.' });
      } else {
        return res.status(400).json({ error: parseYtDlpError(errText) });
      }
    }

    const items = parseStdout(stdout);
    if (!items.length) return res.status(500).json({ error: '응답 파싱 실패' });
    res.json({ items });
  } catch (e) {
    console.error('[info] unexpected error:', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── POST /api/download ───────────────────────
// Runs yt-dlp, saves to downloads/, streams to client, keeps file for Files tab
app.post('/api/download', (req, res) => {
  const { url, format, title, itemUrl } = req.body;
  const downloadUrl = itemUrl || url;  // use specific item URL for playlist/carousel items
  if (!downloadUrl) return res.status(400).json({ error: 'URL이 필요합니다.' });

  console.log(`[download] start — format=${format} mediaType=${req.body.mediaType} title=${title}`);

  // Direct download for: image CDN URLs, or synthesized 'direct' format (e.g. Instagram carousel)
  if ((req.body.mediaType === 'image' || format === 'direct') && /^https?:\/\//.test(downloadUrl)) {
    return downloadDirectUrl(downloadUrl, title, res);
  }

  const sessionId = crypto.randomBytes(8).toString('hex');
  const outTemplate = path.join(DOWNLOADS_DIR, `${sessionId}.%(ext)s`);

  const isAudioOnly = (format || '').startsWith('bestaudio');
  const isImage     = req.body.mediaType === 'image';
  const args = [
    '--no-playlist', '--no-warnings',
    '--retries', '3', '--fragment-retries', '5',
    '--socket-timeout', '30',
    ...cookiesArgs(),
    '-f', format || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '-o', outTemplate,
    downloadUrl,
  ];
  if (!isAudioOnly && !isImage) args.push('--merge-output-format', 'mp4');
  if (isAudioOnly)              args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');

  const proc = spawn(YT_DLP, args);
  let stderr   = '';
  let responded = false;

  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('error', err => {
    console.error('[download] spawn error:', err.message);
    if (responded) return;
    responded = true;
    res.status(500).json({ error: `yt-dlp 실행 실패: ${err.message}` });
  });

  proc.on('close', code => {
    console.log(`[download] yt-dlp exited code=${code}`);
    if (responded) return;
    responded = true;

    if (code !== 0) {
      console.error('[download] failed:\n', stderr.slice(-500));
      cleanup(sessionId);
      return res.status(400).json({ error: parseYtDlpError(stderr) });
    }

    // Find the output file — exclude .part files (yt-dlp temp)
    let files;
    try {
      files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(sessionId) && !f.endsWith('.part'));
    } catch (e) {
      console.error('[download] readdirSync failed:', e.message);
      return res.status(500).json({ error: '파일 목록 읽기 실패' });
    }

    if (!files.length) {
      console.error('[download] no output file found for session', sessionId);
      return res.status(500).json({ error: '파일을 찾을 수 없습니다.' });
    }

    // Rename from sessionId.ext to title.ext for Files tab readability
    const ext      = path.extname(files[0]).slice(1);
    const baseName = sanitizeFilename(title || 'video');
    // Ensure unique filename
    let finalName  = `${baseName}.${ext}`;
    let counter    = 1;
    while (fs.existsSync(path.join(DOWNLOADS_DIR, finalName))) {
      finalName = `${baseName} (${counter++}).${ext}`;
    }
    const srcPath  = path.join(DOWNLOADS_DIR, files[0]);
    const dstPath  = path.join(DOWNLOADS_DIR, finalName);
    try { fs.renameSync(srcPath, dstPath); } catch { /* keep original name */ }
    const finalPath = fs.existsSync(dstPath) ? dstPath : srcPath;
    const finalFile = path.basename(finalPath);
    const fileSize  = fs.statSync(finalPath).size;
    const mimeType  = getMimeType(ext);

    console.log(`[download] streaming ${finalFile} (${fileSize} bytes)`);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(finalFile)}`);
    res.setHeader('X-Filename', encodeURIComponent(finalFile));
    res.setHeader('X-Filesize', fileSize);

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    stream.on('end', () => {
      console.log('[download] stream complete — file kept in downloads/');
    });
    stream.on('error', err => {
      console.error('[download] stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: '파일 전송 실패' });
      else res.destroy();
    });
    res.on('error', err => {
      console.error('[download] response error (client disconnected):', err.message);
      stream.destroy();
    });
  });
});

// ── GET /api/files/download/:filename ────────
// Re-download a file from server to browser
app.get('/api/files/download/:filename', (req, res) => {
  const fp = safeFilePath(decodeURIComponent(req.params.filename));
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: '파일 없음' });
  const ext      = path.extname(fp).slice(1);
  const fileSize = fs.statSync(fp).size;
  res.setHeader('Content-Type', getMimeType(ext));
  res.setHeader('Content-Length', fileSize);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(fp))}`);
  fs.createReadStream(fp).pipe(res);
});

// ── GET /api/files ────────────────────────────
// List files in downloads/ sorted by newest first
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => !f.endsWith('.part') && !f.startsWith('.'))
      .map(f => {
        const fp   = path.join(DOWNLOADS_DIR, f);
        const stat = fs.statSync(fp);
        return { filename: f, size: stat.size, mtime: stat.mtime.toISOString(), ext: path.extname(f).slice(1) };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch (e) {
    console.error('/api/files error:', e.message);
    res.json([]);
  }
});

// ── GET /api/settings/pick-app ───────────────
// Opens Windows file picker and returns selected .exe path
app.get('/api/settings/pick-app', (req, res) => {
  if (process.platform !== 'win32') return res.json({ path: null });
  const type  = req.query.type === 'image' ? 'image' : 'video';
  const title = type === 'image' ? '이미지 뷰어 선택' : '동영상 플레이어 선택';
  const tmpPs1 = path.join(DOWNLOADS_DIR, '_picker_tmp.ps1');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Title = "${title}"`,
    '$d.Filter = "실행 파일 (*.exe)|*.exe"',
    '$d.InitialDirectory = $env:ProgramFiles',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
  ].join('\n');
  try { fs.writeFileSync(tmpPs1, script, 'utf8'); } catch (e) {
    return res.json({ path: null });
  }
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { timeout: 60000 }, (err, stdout) => {
    try { fs.unlinkSync(tmpPs1); } catch {}
    const picked = (stdout || '').trim().replace(/\r?\n.*$/s, '');
    res.json({ path: picked || null });
  });
});

// ── GET /api/settings/cookies ────────────────
app.get('/api/settings/cookies', (req, res) => {
  const c = loadConfig();
  res.json({ path: c.cookiesPath || null });
});

// ── POST /api/settings/auto-cookies ──────────
// Manually trigger browser cookie extraction via yt-dlp
app.post('/api/settings/auto-cookies', async (req, res) => {
  try {
    const browser = await extractCookiesViaBrowser();
    res.json({ ok: true, browser, count: '설정됨' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/settings/cookies ─────────────
app.delete('/api/settings/cookies', (req, res) => {
  const c = loadConfig();
  delete c.cookiesPath;
  saveConfig(c);
  res.json({ ok: true });
});

// ── GET /api/settings/pick-cookies ───────────
// Opens Windows file picker for cookies.txt and saves the path
app.get('/api/settings/pick-cookies', (req, res) => {
  if (process.platform !== 'win32') return res.json({ path: null });
  const tmpPs1 = path.join(DOWNLOADS_DIR, '_picker_cookies.ps1');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Title = "쿠키 파일 선택 (cookies.txt)"',
    '$d.Filter = "텍스트 파일 (*.txt)|*.txt|모든 파일 (*.*)|*.*"',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
  ].join('\n');
  try { fs.writeFileSync(tmpPs1, script, 'utf8'); } catch { return res.json({ path: null }); }
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { timeout: 60000 }, (err, stdout) => {
    try { fs.unlinkSync(tmpPs1); } catch {}
    const picked = (stdout || '').trim().replace(/\r?\n.*$/s, '');
    if (picked) {
      const c = loadConfig();
      c.cookiesPath = picked;
      saveConfig(c);
    }
    res.json({ path: picked || null });
  });
});

// ── POST /api/files/open ─────────────────────
// Open file with default app or specified app
app.post('/api/files/open', (req, res) => {
  const fp      = safeFilePath(req.body.filename);
  const appPath = req.body.appPath || '';
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: '파일 없음' });

  if (process.platform === 'win32') {
    if (appPath && fs.existsSync(appPath)) {
      exec(`"${appPath.replace(/"/g, '\\"')}" "${fp.replace(/"/g, '\\"')}"`);
    } else {
      exec(`start "" "${fp.replace(/"/g, '\\"')}"`);
    }
  } else {
    exec(`xdg-open "${fp.replace(/"/g, '\\"')}"`);
  }
  res.json({ ok: true });
});

// ── POST /api/files/reveal ────────────────────
// Reveal file in OS file explorer
app.post('/api/files/reveal', (req, res) => {
  const fp = safeFilePath(req.body.filename);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: '파일 없음' });

  if (process.platform === 'win32') {
    exec(`explorer /select,"${fp.replace(/"/g, '\\"')}"`);
  } else {
    exec(`xdg-open "${path.dirname(fp).replace(/"/g, '\\"')}"`);
  }
  res.json({ ok: true });
});

// ── POST /api/files/delete ────────────────────
// Delete a specific file from downloads/
app.post('/api/files/delete', (req, res) => {
  const fp = safeFilePath(req.body.filename);
  if (!fp) return res.status(400).json({ error: '잘못된 파일명' });
  try {
    fs.unlinkSync(fp);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: '파일 삭제 실패' });
  }
});

// ── POST /api/files/clear ─────────────────────
// Delete all files in downloads/
app.post('/api/files/clear', (req, res) => {
  try {
    fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => !f.startsWith('.'))
      .forEach(f => { try { fs.unlinkSync(path.join(DOWNLOADS_DIR, f)); } catch {} });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HTTP helper (follows redirects) ──────────
function httpGetFollowRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return httpGetFollowRedirects(next, maxRedirects - 1).then(resolve).catch(reject);
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── HTML image extraction fallback ───────────
// Used when yt-dlp reports "No video could be found" (image-only pages)
async function extractImagesFromPage(url) {
  try {
    const res = await httpGetFollowRedirects(url);
    if (res.statusCode !== 200) return [];

    const chunks = [];
    res.setEncoding('utf8');
    await new Promise(r => { res.on('data', d => chunks.push(d)); res.on('end', r); });
    const html = chunks.join('').slice(0, 400000);

    const seen    = new Set();
    const imgUrls = [];

    // Match og:image / twitter:image in any attribute order
    const patterns = [
      /property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
      /content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/gi,
      /name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
      /content=["']([^"']+)["'][^>]+name=["']twitter:image["']/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const u = m[1].trim();
        if (u.startsWith('http') && !seen.has(u)) { seen.add(u); imgUrls.push(u); }
      }
    }

    const titleMatch = html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/) ||
                       html.match(/content=["']([^"']+)["'][^>]+property=["']og:title["']/);
    const pageTitle  = titleMatch ? titleMatch[1].trim() : '이미지';

    return imgUrls.map((imgUrl, i) => ({
      itemUrl:   imgUrl,
      title:     imgUrls.length > 1 ? `${pageTitle} (${i + 1})` : pageTitle,
      uploader:  '',
      thumbnail: imgUrl,
      duration:  null,
      mediaType: 'image',
      formats:   [],
    }));
  } catch (e) {
    console.error('[extractImages] error:', e.message);
    return [];
  }
}

// ── Direct URL download (images from CDN) ─────
async function downloadDirectUrl(url, title, res) {
  let responded = false;
  try {
    const imgRes = await httpGetFollowRedirects(url);
    if (imgRes.statusCode !== 200) throw new Error(`HTTP ${imgRes.statusCode}`);

    const contentType = imgRes.headers['content-type'] || 'image/jpeg';
    const extFromType = contentType.split('/')[1]?.split(';')[0]?.trim().replace('jpeg', 'jpg') || 'jpg';
    const extFromUrl  = url.split('?')[0].split('.').pop().toLowerCase();
    const ext = /^(jpg|jpeg|png|gif|webp|bmp)$/.test(extFromUrl) ? extFromUrl : extFromType;

    const baseName = sanitizeFilename(title || 'image');
    let finalName  = `${baseName}.${ext}`;
    let counter    = 1;
    while (fs.existsSync(path.join(DOWNLOADS_DIR, finalName))) {
      finalName = `${baseName} (${counter++}).${ext}`;
    }
    const finalPath  = path.join(DOWNLOADS_DIR, finalName);
    const fileStream = fs.createWriteStream(finalPath);

    await new Promise((resolve, reject) => {
      imgRes.pipe(fileStream);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      imgRes.on('error', reject);
    });

    const fileSize = fs.statSync(finalPath).size;
    const mimeType = getMimeType(ext);
    console.log(`[download-direct] saved ${finalName} (${fileSize} bytes)`);
    responded = true;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(finalName)}`);
    res.setHeader('X-Filename', encodeURIComponent(finalName));
    res.setHeader('X-Filesize', fileSize);

    const readStream = fs.createReadStream(finalPath);
    readStream.pipe(res);
    readStream.on('error', err => {
      console.error('[download-direct] stream error:', err.message);
    });
  } catch (err) {
    console.error('[download-direct] error:', err.message);
    if (!responded && !res.headersSent) {
      res.status(500).json({ error: `이미지 다운로드 실패: ${err.message}` });
    }
  }
}

// ── Helpers ──────────────────────────────────
function safeFilePath(filename) {
  if (!filename) return null;
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') return null;
  return path.join(DOWNLOADS_DIR, base);
}

function parseYtDlpError(stderr) {
  if (!stderr) return '알 수 없는 오류';
  if (stderr.includes('Private video'))                  return '비공개 영상입니다.';
  if (stderr.includes('This video is not available'))    return '이 지역에서 재생할 수 없는 영상입니다.';
  if (stderr.includes('Unsupported URL'))                return '지원하지 않는 URL입니다.';
  if (stderr.includes('HTTP Error 404'))                 return '영상을 찾을 수 없습니다.';
  if (stderr.includes('Sign in'))                        return '로그인이 필요한 영상입니다.';
  if (stderr.includes('age'))                            return '연령 제한 영상입니다.';
  if (stderr.includes('ffmpeg') || stderr.includes('ffprobe')) return 'ffmpeg가 필요합니다.';
  return '영상을 가져올 수 없습니다. URL을 확인해주세요.';
}

function getMimeType(ext) {
  const map = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
}

function cleanup(sessionId) {
  try {
    fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.startsWith(sessionId))
      .forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
  } catch {}
}

// ── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`yt-dlp: ${YT_DLP}`);
  console.log(`downloads: ${DOWNLOADS_DIR}`);
});
