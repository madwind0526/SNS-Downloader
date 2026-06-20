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
// Strategy:
//   1. Try --cookies-from-browser directly (works if browser is closed)
//   2. If SQLite is locked (browser running), use robocopy /B backup mode
//      to copy Cookies + Local State into a temp dir with proper structure,
//      then pass that dir to yt-dlp which handles DPAPI decryption itself.
//   3. If all fail, surface a clear error.

const localAppData = process.env.LOCALAPPDATA
  || path.join(os.homedir(), 'AppData', 'Local');

const CHROMIUM_BROWSERS = [
  { name: 'chrome', userDataDir: path.join(localAppData, 'Google',    'Chrome',  'User Data') },
  { name: 'edge',   userDataDir: path.join(localAppData, 'Microsoft', 'Edge',    'User Data') },
];
const OTHER_BROWSERS = ['firefox', 'chromium', 'brave'];

// Find the last-used profile name from Chrome/Edge Local State JSON
function findLastProfile(userDataDir) {
  try {
    const raw  = fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8');
    const last = JSON.parse(raw)?.profile?.last_used;
    if (last && fs.existsSync(path.join(userDataDir, last))) return last;
  } catch {}
  return 'Default';
}

// Try yt-dlp direct browser access (works when browser is closed)
function tryBrowserDirect(browser) {
  return new Promise((resolve, reject) => {
    execFile(YT_DLP,
      ['--cookies-from-browser', browser, '--skip-download',
       '--quiet', '--no-warnings', 'https://www.instagram.com/'],
      { timeout: 20000 },
      (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve()
    );
  });
}

// Robocopy /B copies locked SQLite files + Local State → proper temp structure
// yt-dlp's profile arg: <name>:<profilePath> → looks for Local State one level up
async function tryBrowserWithCopy({ name, userDataDir }) {
  if (!fs.existsSync(userDataDir)) {
    console.log(`[cookies] ${name}: userDataDir not found: ${userDataDir}`);
    return false;
  }

  const profileName = findLastProfile(userDataDir);
  const profileSrc  = path.join(userDataDir, profileName);
  const localState  = path.join(userDataDir, 'Local State');

  if (!fs.existsSync(profileSrc)) {
    console.log(`[cookies] ${name}: profile dir not found: ${profileSrc}`);
    return false;
  }

  const tmpDir     = path.join(getDownloadsDir(), `_ck_${Date.now()}`);
  const tmpProfile = path.join(tmpDir, profileName);
  fs.mkdirSync(tmpProfile, { recursive: true });

  try {
    // Local State is not SQLite-locked — copy normally
    if (fs.existsSync(localState)) {
      fs.copyFileSync(localState, path.join(tmpDir, 'Local State'));
    }

    // Cookies SQLite is locked while browser runs — robocopy /B bypasses the lock
    execSync(
      `robocopy "${profileSrc}" "${tmpProfile}" Cookies Cookies-wal Cookies-shm /B /r:0 /w:0 /NFL /NDL /NJH /NJS /NC /NS`,
      { timeout: 10000 }
    );

    if (!fs.existsSync(path.join(tmpProfile, 'Cookies'))) {
      console.log(`[cookies] ${name}: robocopy produced no Cookies file`);
      return false;
    }

    console.log(`[cookies] ${name}: copied ${profileName}/Cookies + Local State → ${tmpDir}`);

    // yt-dlp reads profile dir, finds Local State one level up, does DPAPI itself
    await new Promise((resolve, reject) => {
      execFile(YT_DLP,
        ['--cookies-from-browser', `${name}:${tmpProfile}`,
         '--skip-download', '--quiet', '--no-warnings',
         'https://www.instagram.com/'],
        { timeout: 25000, env: { ...process.env } },
        (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve()
      );
    });

    const c = loadConfig();
    c.cookiesBrowser = name;
    delete c.cookiesPath;
    saveConfig(c);
    console.log(`[cookies] ${name}: robocopy+copy strategy succeeded`);
    return true;
  } catch (e) {
    console.log(`[cookies] ${name} copy strategy failed: ${String(e).split('\n')[0]}`);
    return false;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function extractCookiesViaBrowser() {
  // Phase 1: direct access for each Chromium browser (succeeds if browser is closed)
  for (const b of CHROMIUM_BROWSERS) {
    try {
      await tryBrowserDirect(b.name);
      const c = loadConfig();
      c.cookiesBrowser = b.name;
      delete c.cookiesPath;
      saveConfig(c);
      console.log(`[cookies] direct: ${b.name}`);
      return b.name;
    } catch (e) {
      console.log(`[cookies] direct ${b.name}: ${String(e).split('\n')[0]}`);
    }
  }

  // Phase 2: robocopy bypass for Chromium browsers (works while browser is running)
  for (const b of CHROMIUM_BROWSERS) {
    if (await tryBrowserWithCopy(b)) return b.name;
  }

  // Phase 3: other browsers (Firefox, Brave, Chromium) — usually not locked
  for (const browser of OTHER_BROWSERS) {
    try {
      await tryBrowserDirect(browser);
      const c = loadConfig();
      c.cookiesBrowser = browser;
      delete c.cookiesPath;
      saveConfig(c);
      console.log(`[cookies] direct: ${browser}`);
      return browser;
    } catch (e) {
      console.log(`[cookies] ${browser}: ${String(e).split('\n')[0]}`);
    }
  }

  // All browsers failed — check if ABE (App-Bound Encryption) is the cause
  throw Object.assign(
    new Error(
      'Instagram 로그인이 필요합니다.\n' +
      'Chrome 보안 정책(App-Bound Encryption)으로 인해 자동 로그인이 불가합니다.\n' +
      '설정에서 쿠키 파일을 등록해주세요.'
    ),
    { needSetup: true }
  );
}

function getDownloadsDir() {
  const c = loadConfig();
  const d = c.downloadsDir || path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
getDownloadsDir(); // ensure default dir exists on startup

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

// ── GET /api/version ─────────────────────────
const { version } = require('../package.json');
app.get('/api/version', (req, res) => res.json({ version }));

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
            needSetup: retryErr.needSetup || false,
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
// PC/Windows: saves permanently to downloads folder, returns JSON (no browser download)
// Render/Linux: saves temp, streams to browser, deletes after
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
  const outTemplate = path.join(getDownloadsDir(), `${sessionId}.%(ext)s`);

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
      files = fs.readdirSync(getDownloadsDir())
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
    while (fs.existsSync(path.join(getDownloadsDir(), finalName))) {
      finalName = `${baseName} (${counter++}).${ext}`;
    }
    const srcPath  = path.join(getDownloadsDir(), files[0]);
    const dstPath  = path.join(getDownloadsDir(), finalName);
    try { fs.renameSync(srcPath, dstPath); } catch { /* keep original name */ }
    const finalPath = fs.existsSync(dstPath) ? dstPath : srcPath;
    const finalFile = path.basename(finalPath);
    const fileSize  = fs.statSync(finalPath).size;
    const mimeType  = getMimeType(ext);

    if (process.platform === 'win32') {
      // PC local: file is permanently saved — return metadata only, no browser download
      console.log(`[download] saved ${finalFile} (${fileSize} bytes) → ${finalPath}`);
      return res.json({ ok: true, filename: finalFile, path: finalPath, size: fileSize });
    }

    // Render/remote: stream to browser then delete
    console.log(`[download] streaming ${finalFile} (${fileSize} bytes)`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(finalFile)}`);
    res.setHeader('X-Filename', encodeURIComponent(finalFile));
    res.setHeader('X-Filesize', fileSize);

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    stream.on('end', () => {
      try { fs.unlinkSync(finalPath); } catch {}
      console.log('[download] stream complete, temp deleted');
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
    const files = fs.readdirSync(getDownloadsDir())
      .filter(f => !f.endsWith('.part') && !f.startsWith('.'))
      .map(f => {
        const fp   = path.join(getDownloadsDir(), f);
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
  const tmpPs1 = path.join(getDownloadsDir(), '_picker_tmp.ps1');
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

// ── GET /api/settings/pick-cookies-file ──────
// Opens Windows file picker starting in user's Downloads folder
app.get('/api/settings/pick-cookies-file', (req, res) => {
  if (process.platform !== 'win32') return res.json({ content: null });
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.InitialDirectory = "${downloadsDir.replace(/\\/g, '\\\\')}"`,
    '$d.Title = "쿠키 파일 선택 (cookies.txt)"',
    '$d.Filter = "cookies.txt|cookies.txt|텍스트 파일 (*.txt)|*.txt|모든 파일 (*.*)|*.*"',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Get-Content $d.FileName -Raw }',
  ].join('\n');
  const tmpPs1 = path.join(getDownloadsDir(), `_picker_${Date.now()}.ps1`);
  try { fs.writeFileSync(tmpPs1, script, 'utf8'); } catch { return res.json({ content: null }); }
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    try { fs.unlinkSync(tmpPs1); } catch {}
    const content = (stdout || '').trim();
    res.json({ content: content || null });
  });
});

// ── POST /api/settings/upload-cookies ────────
// Receive cookies.txt content (text/plain or JSON {content}) and save to disk
app.post('/api/settings/upload-cookies', express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
  let content = typeof req.body === 'string' ? req.body : (req.body?.content || '');
  if (!content.includes('# Netscape HTTP Cookie File') && !content.includes('\t')) {
    return res.status(400).json({ error: '유효한 cookies.txt 파일이 아닙니다.\n"Get cookies.txt LOCALLY" 확장 프로그램으로 내보낸 파일을 사용하세요.' });
  }
  const savePath = path.join(__dirname, 'cookies.txt');
  try {
    fs.writeFileSync(savePath, content, 'utf8');
    const c = loadConfig();
    c.cookiesPath = savePath;
    delete c.cookiesBrowser;
    saveConfig(c);
    const lineCount = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    res.json({ ok: true, path: savePath, cookieCount: lineCount });
  } catch (e) {
    res.status(500).json({ error: '파일 저장 실패: ' + e.message });
  }
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
  const tmpPs1 = path.join(getDownloadsDir(), '_picker_cookies.ps1');
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

// ── GET /api/settings/download-folder ────────
app.get('/api/settings/download-folder', (req, res) => {
  res.json({ path: getDownloadsDir() });
});

// ── GET /api/settings/pick-download-folder ───
// Opens Windows FolderBrowserDialog starting at current downloads folder
app.get('/api/settings/pick-download-folder', (req, res) => {
  if (process.platform !== 'win32') return res.json({ path: null });
  // Single backslashes — PowerShell double-quoted strings don't need escaping
  const currentDir = getDownloadsDir();
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "Download folder"',
    `$d.SelectedPath = "${currentDir}"`,
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
  ].join('\r\n');
  const tmpPs1 = path.join(getDownloadsDir(), `_fpick_${Date.now()}.ps1`);
  // Write UTF-16 LE with BOM — PowerShell reads this correctly on all Windows locales
  try { fs.writeFileSync(tmpPs1, Buffer.from('﻿' + script, 'utf16le')); } catch { return res.json({ path: null }); }
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { timeout: 60000 }, (err, stdout) => {
    try { fs.unlinkSync(tmpPs1); } catch {}
    const picked = (stdout || '').trim().replace(/\r?\n.*$/s, '');
    if (picked) {
      if (!fs.existsSync(picked)) try { fs.mkdirSync(picked, { recursive: true }); } catch {}
      const c = loadConfig();
      c.downloadsDir = picked;
      saveConfig(c);
    }
    res.json({ path: picked || null });
  });
});

// ── GET /api/settings/open-downloads-folder ──
// Opens the downloads folder in Windows Explorer
app.get('/api/settings/open-downloads-folder', (req, res) => {
  const dir = getDownloadsDir();
  if (process.platform === 'win32') {
    exec(`explorer "${dir.replace(/"/g, '\\"')}"`);
  } else {
    exec(`xdg-open "${dir.replace(/"/g, '\\"')}"`);
  }
  res.json({ ok: true });
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
    fs.readdirSync(getDownloadsDir())
      .filter(f => !f.startsWith('.'))
      .forEach(f => { try { fs.unlinkSync(path.join(getDownloadsDir(), f)); } catch {} });
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
    while (fs.existsSync(path.join(getDownloadsDir(), finalName))) {
      finalName = `${baseName} (${counter++}).${ext}`;
    }
    const finalPath  = path.join(getDownloadsDir(), finalName);
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

    if (process.platform === 'win32') {
      // PC local: file saved permanently — return metadata only
      return res.json({ ok: true, filename: finalName, path: finalPath, size: fileSize });
    }

    // Render/remote: stream then delete
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(finalName)}`);
    res.setHeader('X-Filename', encodeURIComponent(finalName));
    res.setHeader('X-Filesize', fileSize);

    const readStream = fs.createReadStream(finalPath);
    readStream.pipe(res);
    readStream.on('end', () => { try { fs.unlinkSync(finalPath); } catch {} });
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
  return path.join(getDownloadsDir(), base);
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
    fs.readdirSync(getDownloadsDir())
      .filter(f => f.startsWith(sessionId))
      .forEach(f => fs.unlinkSync(path.join(getDownloadsDir(), f)));
  } catch {}
}

// ── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`yt-dlp: ${YT_DLP}`);
  const c = loadConfig();
  console.log(`downloads: ${c.downloadsDir || path.join(__dirname, '..', 'downloads')}`);
});
