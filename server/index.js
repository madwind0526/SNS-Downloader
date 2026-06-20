const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { execFile, spawn, exec } = require('child_process');
const fs       = require('fs');
const crypto   = require('crypto');
const https    = require('https');
const http     = require('http');

const app  = express();
const PORT = process.env.PORT || 3001;

// yt-dlp binary path — Windows local uses .exe, Linux (Render) uses system-installed binary
const YT_DLP = process.platform === 'win32'
  ? path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
  : 'yt-dlp';

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

// ── POST /api/info ───────────────────────────
// Returns all media items from URL (video, images in carousels/photosets)
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  // No --no-playlist: fetch all items (carousel, photoset, etc.), limit to 10
  const args = [
    '--dump-json', '--no-warnings',
    '--retries', '3', '--fragment-retries', '3',
    '--socket-timeout', '30',
    '--playlist-items', '1-10',
    url,
  ];

  execFile(YT_DLP, args, { timeout: 90000 }, async (err, stdout, stderr) => {
    if (err) {
      const errText = stderr || err.message;
      // Fallback: yt-dlp cannot handle image-only pages — scrape og:image from HTML
      if (errText.includes('No video could be found') || errText.includes('no video') ||
          errText.includes('No video formats found')) {
        const images = await extractImagesFromPage(url);
        if (images.length) return res.json({ items: images });
        // Platform-specific message when HTML fallback also fails
        if (errText.includes('[Tumblr]')) {
          return res.status(400).json({ error: 'Tumblr 이미지 포스트는 지원되지 않습니다. 동영상 포스트 URL을 사용해 주세요.' });
        }
        if (errText.includes('[Pinterest]')) {
          return res.status(400).json({ error: 'Pinterest 이미지 핀은 지원되지 않습니다. 동영상이 포함된 핀 URL을 사용해 주세요.' });
        }
        return res.status(400).json({ error: '이 포스트에서 미디어를 찾을 수 없습니다.' });
      }
      return res.status(400).json({ error: parseYtDlpError(errText) });
    }

    try {
      const hasVideo = f =>
        (f.vcodec && f.vcodec !== 'none') ||
        (f.video_ext && f.video_ext !== 'none' && f.video_ext !== 'images');

      const mapFormat = f => ({
        id:        f.format_id,
        ext:       f.ext,
        height:    f.height    || null,
        width:     f.width     || null,
        fps:       f.fps       || null,
        vcodec:    f.vcodec    || 'none',
        acodec:    f.acodec    || 'none',
        video_ext: f.video_ext || 'none',
        audio_ext: f.audio_ext || 'none',
        filesize:  f.filesize  || null,
      });

      // yt-dlp outputs one JSON object per line for playlists
      const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
      const items = lines.map(l => {
        const info = JSON.parse(l);
        const fmts = info.formats || [];
        const isImage = ['jpg','jpeg','png','gif','webp'].includes(info.ext) || !fmts.some(hasVideo);
        return {
          itemUrl:   info.webpage_url || info.original_url || url,
          title:     info.title,
          uploader:  info.uploader || info.channel || '',
          thumbnail: info.thumbnail,
          duration:  info.duration,
          mediaType: isImage ? 'image' : 'video',
          formats:   fmts.map(mapFormat),
        };
      });

      if (!items.length) throw new Error('no items');
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: '응답 파싱 실패' });
    }
  });
});

// ── POST /api/download ───────────────────────
// Runs yt-dlp, saves to downloads/, streams to client, keeps file for Files tab
app.post('/api/download', (req, res) => {
  const { url, format, title, itemUrl } = req.body;
  const downloadUrl = itemUrl || url;  // use specific item URL for playlist/carousel items
  if (!downloadUrl) return res.status(400).json({ error: 'URL이 필요합니다.' });

  console.log(`[download] start — format=${format} mediaType=${req.body.mediaType} title=${title}`);

  // Direct download for image CDN URLs (yt-dlp can't handle them)
  if (req.body.mediaType === 'image' && /^https?:\/\//.test(downloadUrl)) {
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
