// ── Runtime constants ────────────────────────
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
// True when the server is a Windows PC (localhost OR WiFi LAN) — set after /api/version fetch
let isPCServer = isLocal;

// ── Auth ──────────────────────────────────────
const TOKEN_KEY = 'sns-dl-token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function apiFetch(url, opts = {}) {
  opts.headers = opts.headers || {};
  const t = getToken();
  if (t) opts.headers['x-token'] = t;
  return fetch(url, opts);
}

async function initAuth() {
  if (isLocal) return; // no auth on localhost

  const stored = getToken();
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: stored }),
  });
  const data = await res.json();

  if (!data.authRequired) return; // server has no token set
  if (data.ok) return;            // stored token is valid

  // Show auth screen
  await showAuthScreen();
}

function showAuthScreen() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.id = 'authOverlay';
    overlay.innerHTML = `
      <div style="
        position:fixed;inset:0;background:var(--bg);z-index:9999;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
        padding:32px;
      ">
        <div style="font-size:2rem;font-weight:900;color:var(--text)">SNS</div>
        <div style="font-size:1rem;color:var(--text-sub)">Downloader</div>
        <p style="color:var(--text-sub);font-size:.9rem;margin-top:8px">비밀번호를 입력하세요</p>
        <div style="display:flex;gap:8px;width:100%;max-width:280px">
          <input id="authInput" type="password" placeholder="비밀번호"
            style="flex:1;padding:10px 14px;border-radius:var(--radius-sm);
                   border:1px solid var(--border);background:var(--surface);
                   color:var(--text);font-size:1rem;outline:none"/>
          <button id="authBtn"
            style="padding:10px 18px;border-radius:var(--radius-sm);border:none;
                   background:var(--accent);color:#fff;font-size:.95rem;cursor:pointer;
                   white-space:nowrap;flex-shrink:0">
            확인
          </button>
        </div>
        <p id="authErr" style="color:var(--danger);font-size:.82rem;min-height:1.2em"></p>
      </div>`;
    document.body.appendChild(overlay);

    const input = document.getElementById('authInput');
    const btn   = document.getElementById('authBtn');
    const err   = document.getElementById('authErr');
    input.focus();

    const tryAuth = async () => {
      const token = input.value.trim();
      if (!token) return;
      btn.disabled = true;
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const d = await r.json();
      if (d.ok) {
        localStorage.setItem(TOKEN_KEY, token);
        overlay.remove();
        resolve();
      } else {
        err.textContent = d.error || '비밀번호가 올바르지 않습니다.';
        input.value = '';
        input.focus();
        btn.disabled = false;
      }
    };

    btn.addEventListener('click', tryAuth);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryAuth(); });
  });
}

// ── Platform detection ──────────────────────
const PLATFORMS = {
  youtube:   { regex: /youtube\.com|youtu\.be/,     label: 'YouTube',     icon: '▶' },
  instagram: { regex: /instagram\.com/,             label: 'Instagram',   icon: '◈' },
  tiktok:    { regex: /tiktok\.com/,                label: 'TikTok',      icon: '♪' },
  twitter:   { regex: /twitter\.com|x\.com/,        label: 'X (Twitter)', icon: '✕' },
  facebook:  { regex: /facebook\.com|fb\.watch/,    label: 'Facebook',    icon: 'f' },
  pinterest:   { regex: /pinterest\.com|pin\.it/,        label: 'Pinterest',   icon: '📌' },
  vimeo:       { regex: /vimeo\.com/,                    label: 'Vimeo',       icon: 'V' },
  dailymotion: { regex: /dailymotion\.com|dai\.ly/,      label: 'Dailymotion', icon: 'D' },
  ted:         { regex: /ted\.com/,                      label: 'TED',         icon: 'T' },
  imgur:       { regex: /imgur\.com/,                    label: 'Imgur',       icon: 'i' },
  tumblr:      { regex: /tumblr\.com/,                   label: 'Tumblr',      icon: 't' },
  reddit:      { regex: /reddit\.com/,                   label: 'Reddit',      icon: '●' },
  twitch:      { regex: /twitch\.tv/,                    label: 'Twitch',      icon: '◉' },
  naver:       { regex: /tv\.naver\.com/,                label: 'Naver TV',    icon: 'N' },
  kakao:       { regex: /tv\.kakao\.com/,                label: 'Kakao TV',    icon: 'K' },
  bilibili:    { regex: /bilibili\.com|b23\.tv/,         label: 'Bilibili',    icon: 'B' },
  niconico:    { regex: /nicovideo\.jp|nico\.ms/,        label: 'Niconico',    icon: 'N' },
  kick:        { regex: /kick\.com/,                     label: 'Kick',        icon: 'K' },
  rumble:      { regex: /rumble\.com/,                   label: 'Rumble',      icon: 'R' },
  soundcloud:  { regex: /soundcloud\.com/,               label: 'SoundCloud',  icon: '♫' },
  bandcamp:    { regex: /bandcamp\.com/,                 label: 'Bandcamp',    icon: '♩' },
  bitchute:    { regex: /bitchute\.com/,                 label: 'BitChute',    icon: 'b' },
};

function detectPlatform(url) {
  for (const [, p] of Object.entries(PLATFORMS)) {
    if (p.regex.test(url)) return p;
  }
  return null;
}

// ── DOM refs ────────────────────────────────
const $ = id => document.getElementById(id);
const urlInput            = $('urlInput');
const pasteBtn            = $('pasteBtn');
const clearBtn            = $('clearBtn');
const platformBadge       = $('platformBadge');
const platformIcon        = $('platformIcon');
const platformName        = $('platformName');
const fetchBtn            = $('fetchBtn');
const loading             = $('loading');
const itemsContainer      = $('itemsContainer');
const downloadSelectedBtn = $('downloadSelectedBtn');
const selCount            = $('selCount');
const progressWrap        = $('progressWrap');
const progressFill        = $('progressFill');
const progressPercent     = $('progressPercent');
const progressFilename    = $('progressFilename');
const progressSpeed       = $('progressSpeed');
const progressEta         = $('progressEta');
const successCard         = $('successCard');
const successSub          = $('successSub');
const previewVideo        = $('previewVideo');
const resetBtn            = $('resetBtn');
const errorBox            = $('errorBox');
const errorMsg            = $('errorMsg');
const wifiStatus          = $('wifiStatus');
const cellStatus          = $('cellStatus');
const cellType            = $('cellType');
const settingsBtn         = $('settingsBtn');
const settingsClose       = $('settingsClose');
const settingsOverlay     = $('settingsOverlay');

// ── Bottom nav ──────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.page).classList.add('active');
    if (btn.dataset.page === 'pageFiles')   renderFiles();
    if (btn.dataset.page === 'pageHistory') renderHistory();
  });
});

// ── Power button — open / close popup window ─
const powerBtn = $('powerBtn');
const isPopup  = !!(window.opener && !window.opener.closed);
powerBtn.title = isPopup ? '창 닫기' : '앱 창으로 열기';

let _appPopup = null;
powerBtn.addEventListener('click', () => {
  if (isPopup) {
    window.close();
    return;
  }
  if (_appPopup && !_appPopup.closed) {
    _appPopup.close();
    _appPopup = null;
    return;
  }
  _appPopup = window.open(
    location.href, 'snsdownloader',
    'width=560,height=900,toolbar=no,location=no,menubar=no,status=no,resizable=yes'
  );
  if (!_appPopup || _appPopup.closed) alert('팝업이 차단되었습니다. 브라우저 팝업 허용 후 다시 시도하세요.');
});

// ── Settings panel ──────────────────────────
const RENDER_URL = 'https://sns-downloader.onrender.com';

let androidQrTab = 'wifi'; // 'wifi' | 'render'

async function loadAndroidQR() {
  const img    = $('androidQrImg');
  const urlEl  = $('androidQrUrl');
  if (!img) return;

  let qrTarget = RENDER_URL;

  if (androidQrTab === 'wifi' && isLocal) {
    try {
      const d = await (await apiFetch('/api/localip')).json();
      qrTarget = `http://${d.ip}:${d.port}`;
    } catch { qrTarget = 'http://localhost:3001'; }
  }

  img.src = `/api/qr?url=${encodeURIComponent(qrTarget)}`;
  urlEl.textContent = qrTarget;
}

document.querySelectorAll('.android-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.android-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    androidQrTab = btn.dataset.tab;
    const fwHint = $('androidQrFirewallHint');
    if (fwHint) fwHint.style.display = androidQrTab === 'wifi' ? '' : 'none';
    loadAndroidQR();
  });
});

// Hide Wi-Fi tab when not running locally (no local server to connect to)
settingsBtn.addEventListener('click', () => {
  settingsOverlay.classList.add('open');
  const wifiTab = document.querySelector('.android-tab[data-tab="wifi"]');
  if (wifiTab) {
    wifiTab.style.display = isLocal ? '' : 'none';
    if (!isLocal) {
      androidQrTab = 'render';
      document.querySelectorAll('.android-tab').forEach(b => b.classList.remove('active'));
      document.querySelector('.android-tab[data-tab="render"]')?.classList.add('active');
    }
  }
  const fwHint = $('androidQrFirewallHint');
  if (fwHint) fwHint.style.display = (isLocal && androidQrTab === 'wifi') ? '' : 'none';
  loadAndroidQR();
});

settingsClose.addEventListener('click',() => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
});

// ── Theme (persist to localStorage) ──────────
const savedTheme = localStorage.getItem('sns-dl-theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  if (btn.dataset.themeBtn === savedTheme) btn.classList.add('active');
  else btn.classList.remove('active');
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const theme = btn.dataset.themeBtn;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sns-dl-theme', theme);
  });
});

// ── App init ─────────────────────────────────
initAuth().catch(() => {}); // show auth screen before anything else (no-op on localhost)

// ── Version ───────────────────────────────────
fetch('/api/version').then(r => r.json()).then(d => {
  const v  = `v${d.version}`;
  const el = $('appVersion');
  const pl = $('plVersion');
  if (el) el.textContent = v;
  if (pl) pl.textContent = v;
  if (d.platform === 'win32') {
    isPCServer = true;
    if (!isLocal) setupPCServerUI(); // WiFi: enable PC folder UI
  }
}).catch(() => {});

// ── Connection mode badge ─────────────────────
const connectionBadge = $('connectionBadge');
if (connectionBadge) {
  connectionBadge.setAttribute('data-label', isLocal ? 'PC Local' : 'Render Server');
}

// ── Platform Landing ──────────────────────────
const isAppMode = new URLSearchParams(location.search).has('mode');

function showPlatformLanding() {
  $('platformLanding').style.display = 'flex';
}
function hidePlatformLanding() {
  $('platformLanding').style.display = 'none';
}

$('platformPC')?.addEventListener('click', () => {
  const w = 420, h = 820;
  const left = Math.round((screen.availWidth  - w) / 2);
  const top  = Math.round((screen.availHeight - h) / 2);
  const popup = window.open(
    'http://localhost:3001/?mode=app',
    'snsdownloader-pc',
    `width=${w},height=${h},left=${left},top=${top},toolbar=no,location=no,menubar=no,status=no,resizable=yes`
  );
  if (!popup || popup.closed) alert('팝업이 차단되었습니다. 브라우저 팝업 허용 후 다시 시도하세요.');
});

$('platformAndroid')?.addEventListener('click', () => {
  const w = 420, h = 820;
  const left = Math.round((screen.availWidth  - w) / 2);
  const top  = Math.round((screen.availHeight - h) / 2);
  const popup = window.open(
    RENDER_URL,
    'snsdownloader-mobile',
    `width=${w},height=${h},left=${left},top=${top},toolbar=no,location=no,menubar=no,status=no,resizable=yes`
  );
  if (!popup || popup.closed) alert('팝업이 차단되었습니다. 브라우저 팝업 허용 후 다시 시도하세요.');
});

// Show landing when on local server and not in app mode
if (isLocal && !isAppMode) {
  showPlatformLanding();
}

$('resetPlatformBtn')?.addEventListener('click', () => {
  settingsOverlay.classList.remove('open');
  showPlatformLanding();
});
document.querySelectorAll('[data-quality]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-quality]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});
document.querySelectorAll('[data-server]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-server]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Network status ──────────────────────────
function updateNetworkStatus() {
  if (!navigator.onLine) {
    wifiStatus.className = 'net-badge';
    cellStatus.className = 'net-badge';
    cellType.textContent = '';
    return;
  }
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) {
    wifiStatus.className = 'net-badge active';
    cellStatus.className = 'net-badge';
    cellType.textContent = '';
    return;
  }
  const type = conn.type;
  const eff  = conn.effectiveType;
  if (type === 'wifi') {
    wifiStatus.className = 'net-badge active-wifi';
    cellStatus.className = 'net-badge';
    cellType.textContent = '';
  } else if (type === 'cellular') {
    wifiStatus.className = 'net-badge';
    cellStatus.className = 'net-badge active-cell';
    cellType.textContent = eff === '4g' ? 'LTE' : eff === '3g' ? '3G' : eff === '2g' ? '2G' : '';
  } else {
    wifiStatus.className = 'net-badge active';
    cellStatus.className = 'net-badge';
    cellType.textContent = '';
  }
}
updateNetworkStatus();
window.addEventListener('online',  updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
if (navigator.connection) navigator.connection.addEventListener('change', updateNetworkStatus);

// ── URL input ───────────────────────────────
function resetResults() {
  loading.style.display             = 'none';
  itemsContainer.style.display      = 'none';
  downloadSelectedBtn.style.display = 'none';
  progressWrap.style.display        = 'none';
  successCard.style.display         = 'none';
  errorBox.style.display            = 'none';
}

function clearAll() {
  urlInput.value              = '';
  platformBadge.style.display = 'none';
  fetchBtn.style.display      = 'none';
  resetResults();
}

urlInput.addEventListener('input', () => {
  const url = urlInput.value.trim();
  resetResults();
  if (!url) {
    platformBadge.style.display = 'none';
    fetchBtn.style.display      = 'none';
    return;
  }
  const platform = detectPlatform(url);
  if (platform) {
    platformIcon.textContent    = platform.icon;
    platformName.textContent    = platform.label;
    platformBadge.style.display = 'flex';
  } else {
    platformBadge.style.display = 'none';
  }
  fetchBtn.style.display = url.startsWith('http') ? 'block' : 'none';
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
    urlInput.dispatchEvent(new Event('input'));
  } catch { urlInput.focus(); }
});

clearBtn.addEventListener('click', clearAll);

// ── Fetch info ──────────────────────────────
fetchBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;

  resetResults();
  fetchBtn.style.display = 'none';
  loading.style.display  = 'flex';

  try {
    const res  = await apiFetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      loading.style.display = 'none';
      fetchBtn.style.display = 'block';
      // Special case: browser is running and SQLite is locked
      if (data.needSetup) {
        showErrorWithSetup(data.error);
      } else if (data.needClose) {
        showErrorWithRetry(data.error);
      } else {
        showError(data.error || '알 수 없는 오류');
      }
      return;
    }

    loading.style.display = 'none';
    renderItems(data.items);
  } catch (err) {
    loading.style.display = 'none';
    showError(err.message || '영상 정보를 가져올 수 없습니다.');
    fetchBtn.style.display = 'block';
  }
});

// ── Render media items ───────────────────────
function renderItems(items) {
  if (!items || !items.length) {
    showError('미디어를 찾을 수 없습니다.');
    fetchBtn.style.display = 'block';
    return;
  }

  itemsContainer.innerHTML = '';

  items.forEach((item, idx) => {
    const formats   = buildFormatList(item.formats || [], item.mediaType);
    const typeLabel = item.mediaType === 'image' ? '이미지' : '동영상';

    const formatPills = formats.map((fmt, fi) => {
      const id = `fmt-${idx}-${fi}`;
      return `<input type="radio" name="fmt-${idx}" id="${id}" class="format-option" value="${escHtml(fmt.id)}"${fi === 0 ? ' checked' : ''}><label for="${id}" class="format-label">${escHtml(fmt.label)}</label>`;
    }).join('');

    const thumbHtml = item.thumbnail
      ? `<img src="${escHtml(item.thumbnail)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=item-thumb-placeholder>▶</div>'">`
      : `<div class="item-thumb-placeholder">▶</div>`;

    const durationHtml = item.duration
      ? `<span class="item-duration">${escHtml(formatDuration(item.duration))}</span>`
      : '';

    const uploaderHtml = item.uploader
      ? `<div class="item-uploader">${escHtml(item.uploader)}</div>`
      : '';

    const div = document.createElement('div');
    div.className       = 'media-item item-selected';
    div.dataset.index     = idx;
    div.dataset.itemUrl   = item.itemUrl || urlInput.value.trim();
    div.dataset.title     = item.title   || '';
    div.dataset.thumb     = item.thumbnail || '';
    div.dataset.mediaType = item.mediaType || 'video';
    div.innerHTML = `
      <label class="item-chk-wrap" title="선택/해제">
        <input type="checkbox" class="item-chk" checked>
      </label>
      <div class="item-thumb">${thumbHtml}${durationHtml}</div>
      <div class="item-body">
        <span class="item-type-badge">${typeLabel}</span>
        <div class="item-title">${escHtml(item.title || '제목 없음')}</div>
        ${uploaderHtml}
        <div class="format-group">${formatPills}</div>
      </div>
    `;

    div.querySelector('.item-chk').addEventListener('change', e => {
      div.classList.toggle('item-selected', e.target.checked);
      updateSelCount();
    });

    itemsContainer.appendChild(div);
  });

  itemsContainer.style.display      = 'flex';
  downloadSelectedBtn.style.display = 'block';
  updateSelCount();
}

function updateSelCount() {
  const n = itemsContainer.querySelectorAll('.item-chk:checked').length;
  selCount.textContent = n ? `(${n})` : '';
}

// ── Format list builder ──────────────────────
function buildFormatList(formats, mediaType) {
  // Image-only post: just offer the original image
  if (mediaType === 'image') {
    return [{ id: 'best', label: '원본 이미지' }];
  }

  const seen  = new Set();
  const video = [];

  const hasVideo = f =>
    (f.vcodec && f.vcodec !== 'none') ||
    (f.video_ext && f.video_ext !== 'none' && f.video_ext !== 'images');

  formats
    .filter(f => f.height && hasVideo(f))
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .forEach(f => {
      const key = `${f.height}p`;
      if (!seen.has(key) && video.length < 4) {
        seen.add(key);
        video.push({ id: `bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]/best`, label: key });
      }
    });

  if (!video.length && formats.some(f => hasVideo(f))) {
    video.push({ id: 'bestvideo+bestaudio/best', label: '최고화질' });
  }
  if (!video.length) {
    video.push({ id: 'best[ext=mp4]/best', label: '최고화질' });
  }
  video.push({ id: 'bestaudio/best', label: '오디오 (MP3)' });
  return video;
}

// ── Download selected items ──────────────────
// Mobile only: track Render server temp files for cleanup after session
let sessionFiles = [];

function deleteSessionFiles() {
  if (isLocal) return; // PC files are permanent, never delete
  sessionFiles.forEach(fn => postFileAction('/api/files/delete', fn));
  sessionFiles = [];
}

downloadSelectedBtn.addEventListener('click', async () => {
  const checkedItems = [...itemsContainer.querySelectorAll('.media-item')]
    .filter(el => el.querySelector('.item-chk')?.checked);
  if (!checkedItems.length) return;

  if (!isLocal) deleteSessionFiles(); // Mobile: clean up previous session temp files

  itemsContainer.style.display      = 'none';
  downloadSelectedBtn.style.display = 'none';
  progressWrap.style.display        = 'block';

  const url = urlInput.value.trim();
  let successCount  = 0;
  let lastVideoBlob = null;
  let lastPCFile    = null; // { filename, mediaType } for PC preview

  for (let i = 0; i < checkedItems.length; i++) {
    const el        = checkedItems[i];
    const itemUrl   = el.dataset.itemUrl   || url;
    const title     = el.dataset.title     || '';
    const thumb     = el.dataset.thumb     || '';
    const mediaType = el.dataset.mediaType || 'video';
    const selFmt    = el.querySelector('.format-option:checked');
    const format    = selFmt?.value || 'bestvideo+bestaudio/best';

    progressFilename.textContent = checkedItems.length > 1
      ? `(${i + 1}/${checkedItems.length}) ${title}`
      : title;
    setProgress(0);

    try {
      const res = await apiFetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, itemUrl, format, title, mediaType }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '다운로드 실패');
      }

      let filename;

      // Detect PC vs mobile mode from Content-Type header (not hostname),
      // so WiFi LAN access (e.g. 192.168.x.x) behaves correctly as PC mode.
      const isPCResponse = (res.headers.get('Content-Type') || '').includes('application/json');

      if (isPCResponse) {
        // PC: server saved file permanently — response is JSON metadata
        const data = await res.json();
        filename = data.filename;
        lastPCFile = { filename: data.filename, mediaType };
        addToHistory({
          title, url, filename,
          platform: detectPlatform(url)?.label || '',
          thumb, size: data.size || 0,
          downloadedAt: new Date().toISOString(),
        });
      } else {
        // Mobile/Render: response is a file blob — trigger browser download
        const blob = await res.blob();
        const rawFn = res.headers.get('X-Filename');
        filename = rawFn ? decodeURIComponent(rawFn) : 'video.mp4';
        triggerDownload(blob, filename);
        sessionFiles.push(filename);
        if (blob.type.startsWith('video/') || blob.type.startsWith('audio/') || blob.type.startsWith('image/')) {
          lastVideoBlob = blob;
        }
        addToHistory({
          title, url, filename,
          platform: detectPlatform(url)?.label || '',
          thumb, size: blob.size,
          downloadedAt: new Date().toISOString(),
        });
      }

      setProgress(100, '완료!', '');
      successCount++;
    } catch (err) {
      console.error(`[download] item ${i} failed:`, err.message);
    }

    if (i < checkedItems.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  progressWrap.style.display = 'none';

  if (successCount > 0) {
    showSuccess(successCount, lastVideoBlob, lastPCFile);
  } else {
    showError('다운로드에 실패했습니다.');
    itemsContainer.style.display      = 'flex';
    downloadSelectedBtn.style.display = 'block';
  }
});

// ── Success state ─────────────────────────────
const previewImage = $('previewImage');

function showSuccess(count, blob, pcFile) {
  successSub.textContent = pcFile
    ? `${count}개 파일이 다운로드 폴더에 저장됨`
    : `${count}개 파일 저장됨`;
  errorBox.style.display = 'none';

  // Revoke previous blob URLs
  if (previewVideo.src?.startsWith('blob:')) URL.revokeObjectURL(previewVideo.src);
  if (previewImage.src?.startsWith('blob:')) URL.revokeObjectURL(previewImage.src);
  previewVideo.src = '';
  previewImage.src = '';
  previewVideo.style.display = 'none';
  previewImage.style.display = 'none';

  if (blob?.type.startsWith('image/')) {
    previewImage.src           = URL.createObjectURL(blob);
    previewImage.style.display = 'block';
  } else if (blob?.type.startsWith('video/') || blob?.type.startsWith('audio/')) {
    previewVideo.src           = URL.createObjectURL(blob);
    previewVideo.style.display = 'block';
  } else if (pcFile) {
    // PC: preview from server endpoint
    const previewUrl = `/api/files/download/${encodeURIComponent(pcFile.filename)}`;
    if (pcFile.mediaType === 'image') {
      previewImage.src           = previewUrl;
      previewImage.style.display = 'block';
    } else {
      previewVideo.src           = previewUrl;
      previewVideo.style.display = 'block';
    }
  }

  successCard.style.display = 'flex';
  successCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

resetBtn.addEventListener('click', () => {
  deleteSessionFiles(); // remove downloaded files from server
  if (previewVideo.src?.startsWith('blob:')) URL.revokeObjectURL(previewVideo.src);
  if (previewImage.src?.startsWith('blob:')) URL.revokeObjectURL(previewImage.src);
  previewVideo.src = '';
  previewImage.src = '';
  previewVideo.style.display = 'none';
  previewImage.style.display = 'none';
  clearAll();
});

// ── Shared helpers ───────────────────────────
function setProgress(pct, label, speed, eta) {
  progressFill.style.width    = pct + '%';
  progressPercent.textContent = label || pct + '%';
  progressSpeed.textContent   = speed || '';
  progressEta.textContent     = eta   || '';
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showError(msg) {
  resetResults();
  errorMsg.textContent   = msg;
  errorBox.style.display = 'flex';
}

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface2);color:var(--text);padding:10px 18px;border-radius:20px;font-size:0.85rem;z-index:9999;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function showErrorWithRetry(msg) {
  resetResults();
  errorMsg.innerHTML = `${escHtml(msg)}<br><br>
    <button id="retryAfterClose" style="margin-top:8px;padding:8px 18px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem">
      브라우저 닫은 후 재시도
    </button>`;
  errorBox.style.display = 'flex';
  $('retryAfterClose')?.addEventListener('click', () => {
    errorBox.style.display = 'none';
    fetchBtn.click();
  });
}

function showErrorWithSetup(msg) {
  resetResults();
  errorMsg.innerHTML = `${escHtml(msg)}<br><br>
    <button id="goToSettings" style="margin-top:8px;padding:8px 18px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem">
      쿠키 설정하기
    </button>`;
  errorBox.style.display = 'flex';
  $('goToSettings')?.addEventListener('click', () => {
    errorBox.style.display = 'none';
    openCookieModal();
  });
}

function formatDuration(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
const pad = n => String(n).padStart(2, '0');

// ── History ──────────────────────────────────
const HISTORY_KEY = 'downloadHistory';

function addToHistory(entry) {
  const list = getHistory();
  list.unshift(entry);
  if (list.length > 100) list.length = 100;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function renderHistory() {
  const container = $('historyList');
  const list = getHistory();
  if (!list.length) {
    container.innerHTML = `
      <div class="placeholder">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".3">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <p>다운로드 이력이 없습니다</p>
      </div>`;
    return;
  }
  container.innerHTML = list.map(h => `
    <div class="history-item" data-url="${escHtml(h.url || '')}" title="클릭하면 다운로드 준비">
      ${h.thumb
        ? `<img class="history-thumb" src="${h.thumb}" alt="" onerror="this.outerHTML='<div class=history-thumb-placeholder>▶</div>'">`
        : `<div class="history-thumb-placeholder">▶</div>`
      }
      <div class="history-info">
        <div class="history-title">${escHtml(h.title || '')}</div>
        <div class="history-meta">
          <span class="history-badge">${escHtml(h.platform || '')}</span>
          ${formatSize(h.size)} · ${formatDate(h.downloadedAt)}
        </div>
        <div class="history-meta" style="margin-top:2px;font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(h.filename || '')}
        </div>
      </div>
      <div class="history-refetch-icon">↓</div>
    </div>
  `).join('');

  container.addEventListener('click', e => {
    const item = e.target.closest('.history-item');
    if (!item || e.target.closest('.history-badge')) return;
    const pageUrl = item.dataset.url;
    if (!pageUrl) return;
    document.querySelector('.nav-btn[data-page="pageDownload"]').click();
    urlInput.value = pageUrl;
    urlInput.dispatchEvent(new Event('input'));
  }, { once: false });
}

// ── Mobile: browse device Downloads folder via File System Access API ────────
function showMobileFilesUI(container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;gap:16px">
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".35">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <p style="color:var(--text-sub);font-size:.9rem;text-align:center;line-height:1.6">
        다운로드 폴더를 선택하면<br>파일 목록을 확인할 수 있습니다
      </p>
      <button id="openDlFolderBtn" style="
        padding:10px 24px;border-radius:var(--radius-sm);border:none;
        background:var(--accent);color:#fff;font-size:.95rem;cursor:pointer">
        📂 다운로드 폴더 열기
      </button>
      <p style="color:var(--text-sub);font-size:.73rem;opacity:.55">/storage/emulated/0/Download</p>
    </div>`;

  document.getElementById('openDlFolderBtn')?.addEventListener('click', async () => {
    if (!window.showDirectoryPicker) {
      showToast('이 브라우저에서는 지원되지 않습니다');
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ startIn: 'downloads', mode: 'read' });
      await listMobileDir(container, dirHandle);
    } catch (e) {
      if (e.name !== 'AbortError') showToast('폴더를 열 수 없습니다');
    }
  });
}

async function listMobileDir(container, dirHandle) {
  container.innerHTML = `<div class="loading"><div class="spinner"></div><span>읽는 중...</span></div>`;
  const files = [];
  try {
    for await (const [name, handle] of dirHandle) {
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        files.push({ name, size: file.size, mtime: file.lastModified });
      }
    }
  } catch {
    container.innerHTML = `<div class="placeholder"><p>폴더를 읽을 수 없습니다</p></div>`;
    return;
  }

  if (!files.length) {
    container.innerHTML = `<div class="placeholder"><p>폴더가 비어 있습니다</p></div>`;
    return;
  }

  files.sort((a, b) => b.mtime - a.mtime); // newest first

  container.innerHTML = `
    <div>
      <div style="padding:10px 16px;font-size:.78rem;color:var(--text-sub);display:flex;justify-content:space-between;align-items:center">
        <span>${escHtml(dirHandle.name)}</span>
        <span>${files.length}개 파일</span>
      </div>
      ${files.map(f => `
        <div class="file-item">
          <div class="file-info">
            <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
            <div class="file-meta">${formatSize(f.size)} · ${formatDate(f.mtime)}</div>
          </div>
        </div>
      `).join('')}
    </div>`;
}

// ── Files tab ────────────────────────────────
async function renderFiles() {
  const container = $('filesList');

  // Render server: files live on device — open folder picker via File System Access API
  if (!isPCServer) {
    showMobileFilesUI(container);
    return;
  }

  container.innerHTML = `<div class="loading"><div class="spinner"></div><span>불러오는 중...</span></div>`;

  let files;
  try {
    const r = await apiFetch('/api/files');
    files = await r.json();
  } catch {
    container.innerHTML = `<div class="placeholder"><p>서버에 연결할 수 없습니다</p></div>`;
    return;
  }

  if (!files.length) {
    container.innerHTML = `
      <div class="placeholder">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".3">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <p>다운로드한 파일이 없습니다</p>
      </div>`;
    return;
  }

  const localBtns = `
    <button class="file-action-btn" data-action="open">열기</button>
    <button class="file-action-btn" data-action="reveal">탐색기</button>
    <button class="file-action-btn danger" data-action="delete">삭제</button>`;
  const remoteBtns = `
    <button class="file-action-btn" data-action="redownload">재다운로드</button>
    <button class="file-action-btn danger" data-action="delete">삭제</button>`;

  container.innerHTML = files.map(f => `
    <div class="file-item" data-filename="${escHtml(f.filename)}">
      <div class="file-ext-badge">${escHtml(f.ext || '?')}</div>
      <div class="file-info">
        <div class="file-name" title="${escHtml(f.filename)}">${escHtml(f.filename)}</div>
        <div class="file-meta">${formatSize(f.size)} · ${formatDate(f.mtime)}</div>
      </div>
      <div class="file-actions">${isLocal ? localBtns : remoteBtns}</div>
    </div>
  `).join('');
}

$('filesList').addEventListener('click', async e => {
  const btn = e.target.closest('.file-action-btn');
  if (!btn) return;
  const item     = btn.closest('.file-item');
  const filename = item?.dataset.filename;
  if (!filename) return;
  const action = btn.dataset.action;
  if (action === 'open') {
    const ext     = filename.split('.').pop().toLowerCase();
    const isVideo = ['mp4','webm','mkv','avi','mov','m4v','flv'].includes(ext);
    const isAudio = ['mp3','m4a','aac','wav','ogg','flac'].includes(ext);
    const isImage = ['jpg','jpeg','png','gif','webp','bmp'].includes(ext);
    let appPath = null;
    if (isVideo || isAudio) appPath = localStorage.getItem('videoPlayerPath') || null;
    if (isImage)            appPath = localStorage.getItem('imageViewerPath') || null;
    await postFileAction('/api/files/open', filename, appPath ? { appPath } : {});
  } else if (action === 'reveal') {
    await postFileAction('/api/files/reveal', filename);
  } else if (action === 'redownload') {
    const r = await apiFetch(`/api/files/download/${encodeURIComponent(filename)}`);
    if (!r.ok) { alert('재다운로드 실패'); return; }
    const blob = await r.blob();
    triggerDownload(blob, filename);
  } else if (action === 'delete') {
    if (!confirm(`"${filename}"\n삭제할까요?`)) return;
    const ok = await postFileAction('/api/files/delete', filename);
    if (ok) renderFiles();
  }
});

async function postFileAction(endpoint, filename, extra = {}) {
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, ...extra }),
    });
    return r.ok;
  } catch { return false; }
}

// ── App picker settings ──────────────────────
function getAppBasename(fullPath) {
  if (!fullPath) return '시스템 기본 앱';
  return fullPath.split(/[/\\]/).pop().replace(/\.exe$/i, '');
}

function refreshAppPickerUI() {
  const vPath = localStorage.getItem('videoPlayerPath');
  const iPath = localStorage.getItem('imageViewerPath');

  $('videoPlayerDisplay').textContent = getAppBasename(vPath);
  $('imageViewerDisplay').textContent = getAppBasename(iPath);

  $('resetVideoPlayerBtn').disabled = !vPath;
  $('resetImageViewerBtn').disabled = !iPath;
}

async function pickApp(type) {
  try {
    const r    = await apiFetch(`/api/settings/pick-app?type=${type}`);
    const data = await r.json();
    if (data.path) {
      localStorage.setItem(type === 'video' ? 'videoPlayerPath' : 'imageViewerPath', data.path);
      refreshAppPickerUI();
    }
  } catch {}
}

$('pickVideoPlayerBtn').addEventListener('click', () => pickApp('video'));
$('pickImageViewerBtn').addEventListener('click', () => pickApp('image'));

$('resetVideoPlayerBtn').addEventListener('click', () => {
  localStorage.removeItem('videoPlayerPath');
  refreshAppPickerUI();
});
$('resetImageViewerBtn').addEventListener('click', () => {
  localStorage.removeItem('imageViewerPath');
  refreshAppPickerUI();
});

refreshAppPickerUI();

// ── Download folder settings ──────────────────
async function refreshFolderUI() {
  try {
    const d = await (await apiFetch('/api/settings/download-folder')).json();
    const el = $('folderPath');
    if (el && d.path) el.textContent = d.path;
  } catch {}
}

function setupPCServerUI() {
  const sec = $('folderSection');
  if (sec) sec.style.display = '';
  refreshFolderUI();

  // Avoid duplicate listeners (WiFi: called after version fetch, localhost: called immediately)
  const fp  = $('folderPath');
  const cfb = $('changeFolderBtn');
  if (fp && !fp._pcSetup) {
    fp._pcSetup = true;
    fp.addEventListener('click', async () => {
      try { await apiFetch('/api/settings/open-downloads-folder'); } catch {}
    });
  }
  if (cfb && !cfb._pcSetup) {
    cfb._pcSetup = true;
    cfb.addEventListener('click', async () => {
      try {
        showToast('폴더 선택 창 열리는 중...');
        const d = await (await apiFetch('/api/settings/pick-download-folder')).json();
        if (d.path) {
          const el = $('folderPath');
          if (el) el.textContent = d.path;
          showToast('다운로드 폴더 변경됨');
        }
      } catch (e) {
        alert('폴더 선택 실패: ' + e.message);
      }
    });
  }
}

if (isLocal) {
  setupPCServerUI();
} else {
  // Hide folder section initially; shown again if server turns out to be a Windows PC
  const sec = $('folderSection');
  if (sec) sec.style.display = 'none';
}

// ── Cookies ───────────────────────────────────
async function refreshCookiesUI() {
  try {
    const d = await (await apiFetch('/api/settings/cookies')).json();
    const active = !!d.path;

    // Header dot
    const hDot = $('cookieHeaderDot');
    if (hDot) hDot.className = 'cookie-dot ' + (active ? 'active' : 'inactive');

    // Modal status
    const mDot  = $('cookieModalDot');
    const mText = $('cookieModalStatusText');
    const mClr  = $('cookieModalClearBtn');
    const mDrop = $('cookieModalDrop');
    if (mDot)  mDot.className = 'cookies-dot ' + (active ? 'active' : 'inactive');
    if (mText) mText.textContent = active ? '쿠키 등록됨 — 로그인 필요 사이트 자동 인증' : '미등록';
    if (mClr)  mClr.style.display = active ? '' : 'none';
    if (mDrop) mDrop.style.display = active ? 'none' : '';

    // Settings section status
    const sDot  = $('cookiesStatusDot');
    const sText = $('cookiesStatusText');
    const sClr  = $('cookiesClearBtn');
    const sDrop = $('cookiesDropZone');
    if (sDot)  sDot.className = 'cookies-dot ' + (active ? 'active' : 'inactive');
    if (sText) sText.textContent = active ? '쿠키 등록됨' : '미등록';
    if (sClr)  sClr.style.display = active ? '' : 'none';
    if (sDrop) sDrop.style.display = active ? 'none' : '';
  } catch {}
}

async function uploadCookiesText(text) {
  const r = await apiFetch('/api/settings/upload-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  await refreshCookiesUI();
  showToast(`쿠키 ${d.cookieCount}개 등록 완료`);
  closeCookieModal();
}

async function uploadCookiesFile(file) {
  try {
    await uploadCookiesText(await file.text());
  } catch (e) {
    alert('쿠키 파일 등록 실패: ' + e.message);
  }
}

// Windows native file picker (opens in user Downloads folder)
async function pickCookiesNative() {
  try {
    showToast('파일 선택 창 열리는 중...');
    const r = await apiFetch('/api/settings/pick-cookies-file');
    const d = await r.json();
    if (!d.content) return;
    await uploadCookiesText(d.content);
  } catch (e) {
    alert('파일 선택 실패: ' + e.message);
  }
}

function openCookieModal()  {
  $('cookieModalOverlay').style.display = 'flex';
}
function closeCookieModal() {
  $('cookieModalOverlay').style.display = 'none';
}

// On Windows local: replace label file pickers with native picker
if (isLocal && navigator.platform.includes('Win')) {
  document.querySelectorAll('.cookies-file-link').forEach(label => {
    label.removeAttribute('for');
    label.addEventListener('click', e => {
      e.stopPropagation();
      pickCookiesNative();
    });
  });
  $('cookieModalFileInput').style.display = 'none';
  $('cookiesFileInput') && ($('cookiesFileInput').style.display = 'none');
}

// Header cookie button
$('cookieHeaderBtn')?.addEventListener('click', openCookieModal);

// Close modal on overlay click
$('cookieModalOverlay')?.addEventListener('click', e => {
  if (e.target === $('cookieModalOverlay')) closeCookieModal();
});

// Modal drop zone
const modalDrop = $('cookieModalDrop');
if (modalDrop) {
  modalDrop.addEventListener('dragover', e => { e.preventDefault(); modalDrop.classList.add('drag-over'); });
  modalDrop.addEventListener('dragleave', () => modalDrop.classList.remove('drag-over'));
  modalDrop.addEventListener('drop', e => {
    e.preventDefault();
    modalDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadCookiesFile(file);
  });
  modalDrop.addEventListener('click', e => {
    if (e.target.closest('label')) return; // label already handles file input natively
    $('cookieModalFileInput')?.click();
  });
}
$('cookieModalFileInput')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) uploadCookiesFile(file);
});
$('cookieModalClearBtn')?.addEventListener('click', async () => {
  await fetch('/api/settings/cookies', { method: 'DELETE' });
  refreshCookiesUI();
});

// Settings section drop zone (kept for fallback)
const settingsDrop = $('cookiesDropZone');
if (settingsDrop) {
  settingsDrop.addEventListener('dragover', e => { e.preventDefault(); settingsDrop.classList.add('drag-over'); });
  settingsDrop.addEventListener('dragleave', () => settingsDrop.classList.remove('drag-over'));
  settingsDrop.addEventListener('drop', e => {
    e.preventDefault();
    settingsDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadCookiesFile(file);
  });
  settingsDrop.addEventListener('click', e => {
    if (e.target.closest('label')) return;
    $('cookiesFileInput')?.click();
  });
}
$('cookiesFileInput')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) uploadCookiesFile(file);
});
$('cookiesClearBtn')?.addEventListener('click', async () => {
  await fetch('/api/settings/cookies', { method: 'DELETE' });
  refreshCookiesUI();
});

// Hide cookies UI when not local
if (!isLocal) {
  const cookiesSec = $('cookiesSection');
  if (cookiesSec) cookiesSec.style.display = 'none';
  const cookieBtn = $('cookieHeaderBtn');
  if (cookieBtn) cookieBtn.style.display = 'none';
}

// Open cookie modal from error button
window.openCookieModal = openCookieModal;

refreshCookiesUI();

// ── Platform table links — force new window ──
document.querySelector('.platform-table-wrap')?.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  window.open(a.href, '_blank', 'noopener,noreferrer');
});

$('clearHistoryBtn').addEventListener('click', () => {
  if (!confirm('다운로드 이력을 모두 지울까요?')) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

$('clearFilesBtn').addEventListener('click', async () => {
  if (!confirm('downloads 폴더의 파일을 모두 삭제할까요?')) return;
  await apiFetch('/api/files/clear', { method: 'POST' });
  renderFiles();
});

// ── Helpers ──────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d   = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000)        return '방금';
  if (diff < 3600000)      return `${Math.floor(diff / 60000)}분 전`;
  if (diff < 86400000)     return `${Math.floor(diff / 3600000)}시간 전`;
  if (diff < 86400000 * 7) return `${Math.floor(diff / 86400000)}일 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
