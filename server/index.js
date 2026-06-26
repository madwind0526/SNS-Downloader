require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

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
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const { isThreadsUrl, fetchThreadsInfo } = require('./threads');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Invite code and user sessions ────────────
// ACCESS_TOKEN is an invite code for user registration on Render.
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();
const SESSION_COOKIE = 'snsdl_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_UPLOAD_LIMIT_BYTES = 1024 * 1024;
const sessions = new Map();
const lastCookieUseByUser = new Map();
const recentYtDlpDiagnostics = [];

function isLocalhostRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return process.platform === 'win32' &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

function requiresUserAuth(req) {
  return process.platform !== 'win32' && !isLocalhostRequest(req);
}

function safeUrlSummary(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return {
      host: u.hostname,
      pathname: u.pathname.slice(0, 120),
    };
  } catch {
    return { host: null, pathname: null };
  }
}

function rememberYtDlpDiagnostic(entry) {
  recentYtDlpDiagnostics.unshift({
    at: new Date().toISOString(),
    ...entry,
  });
  recentYtDlpDiagnostics.splice(20);
}

function tailText(text, limit = 1500) {
  return String(text || '').slice(-limit);
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function sessionCookieHeader(sessionId, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = process.platform === 'win32' ? '' : '; Secure';
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookieHeader() {
  const secure = process.platform === 'win32' ? '' : '; Secure';
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  session.lastSeenAt = Date.now();
  return { id: sid, ...session };
}

function attachUserSession(req, res, next) {
  const session = getSession(req);
  if (session) {
    req.session = session;
    req.user = { username: session.username, role: session.role };
  }
  next();
}

function userAuthMiddleware(req, res, next) {
  if (!requiresUserAuth(req)) return next();
  if (req.user) return next();
  res.status(401).json({ error: '로그인이 필요합니다.', needLogin: true });
}

// ── Rate limiting (Render only — no token = local, skip) ─
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ACCESS_TOKEN ? 30 : 0, // 0 = disabled
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  skip: () => !ACCESS_TOKEN,
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ACCESS_TOKEN ? 10 : 0,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '다운로드 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  skip: () => !ACCESS_TOKEN,
});

// ── Concurrent download counter ───────────────
let activeDownloads = 0;
const MAX_CONCURRENT = 3;

// yt-dlp binary path — Windows local uses .exe, Linux (Render) uses system-installed binary
const YT_DLP = process.platform === 'win32'
  ? path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
  : 'yt-dlp';

function isTumblrUrl(url) {
  try { return /(^|\.)tumblr\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

function isYouTubeUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com';
  } catch { return false; }
}

// Returns extra yt-dlp args for sites that need special handling on Render (Linux datacenter IP).
// YouTube: ios/android clients bypass BotGuard PO-Token requirement that blocks datacenter IPs.
// Tumblr:  sleep flags reduce 429 rate-limit errors; mobile UA avoids some IP-reputation blocks.
function throttledSiteArgs(url) {
  const args = [];
  if (isYouTubeUrl(url) && process.platform !== 'win32') {
    args.push('--extractor-args', 'youtube:player_client=ios,android');
  }
  if (isTumblrUrl(url)) {
    args.push('--sleep-requests', '2', '--sleep-interval', '2', '--max-sleep-interval', '6');
    if (process.platform !== 'win32') {
      args.push('--user-agent',
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36');
    }
  }
  return args;
}

// Simple server-side config (cookies path, etc.)
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USER_COOKIES_DIR = path.join(DATA_DIR, 'cookies');
const RUNTIME_COOKIES_FILE = path.join(os.tmpdir(), 'sns-downloader-cookies.txt');
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
    })
  : null;
let dbReady = false;
let envCookiesChecked = false;
let envCookiesPath = null;

function ensureDataDirs() {
  fs.mkdirSync(USER_COOKIES_DIR, { recursive: true });
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// Returns the active cookies.txt file path, or null if none is configured.
function getActiveCookiesFilePath() {
  ensureEnvCookies();
  if (envCookiesPath && fs.existsSync(envCookiesPath)) return envCookiesPath;
  const cfg = loadConfig();
  if (cfg.cookiesPath && fs.existsSync(cfg.cookiesPath)) return cfg.cookiesPath;
  return null;
}
function saveConfig(data) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

function loadUsers() {
  ensureDataDirs();
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(data.users) ? data : { users: [] };
  } catch {
    return { users: [] };
  }
}

function saveUsers(data) {
  ensureDataDirs();
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: data.users || [] }, null, 2), 'utf8');
}

async function ensureDb() {
  if (!dbPool || dbReady) return;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS sns_users (
      username TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      cookie_key_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      cookie_size INTEGER NOT NULL DEFAULT 0,
      cookie_updated_at TEXT
    )
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS sns_user_cookies (
      username TEXT PRIMARY KEY REFERENCES sns_users(username) ON DELETE CASCADE,
      encrypted_json TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const countResult = await dbPool.query('SELECT COUNT(*)::int AS count FROM sns_users');
  if (Number(countResult.rows[0]?.count || 0) === 0 && fs.existsSync(USERS_FILE)) {
    const local = loadUsers();
    for (const user of local.users) {
      await dbPool.query(`
        INSERT INTO sns_users (
          username, role, password_salt, password_hash, cookie_key_salt,
          created_at, last_login_at, cookie_size, cookie_updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (username) DO NOTHING
      `, [
        user.username, user.role, user.passwordSalt, user.passwordHash, user.cookieKeySalt,
        user.createdAt, user.lastLoginAt || null, user.cookieSize || 0, user.cookieUpdatedAt || null,
      ]);
      const cookiePath = userCookiePath(user.username);
      if (fs.existsSync(cookiePath)) {
        await dbPool.query(`
          INSERT INTO sns_user_cookies (username, encrypted_json, size, updated_at)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (username) DO NOTHING
        `, [
          user.username,
          fs.readFileSync(cookiePath, 'utf8'),
          user.cookieSize || 0,
          user.cookieUpdatedAt || new Date().toISOString(),
        ]);
      }
    }
  }
  dbReady = true;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    role: row.role,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    cookieKeySalt: row.cookie_key_salt,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    cookieSize: Number(row.cookie_size || 0),
    cookieUpdatedAt: row.cookie_updated_at,
  };
}

async function loadUsersStore() {
  if (!dbPool) return loadUsers();
  await ensureDb();
  const result = await dbPool.query('SELECT * FROM sns_users ORDER BY created_at ASC');
  return { users: result.rows.map(rowToUser) };
}

async function getStorageStatus() {
  const status = {
    backend: dbPool ? 'postgres' : 'file',
    databaseUrlConfigured: !!DATABASE_URL,
  };
  if (!dbPool) {
    const users = loadUsers().users;
    let cookieFileCount = 0;
    try {
      cookieFileCount = fs.readdirSync(USER_COOKIES_DIR).filter(f => f.endsWith('.enc')).length;
    } catch {}
    return {
      ...status,
      ok: true,
      userCount: users.length,
      cookieRecordCount: cookieFileCount,
      usersFileExists: fs.existsSync(USERS_FILE),
    };
  }
  try {
    await ensureDb();
    const users = await dbPool.query('SELECT COUNT(*)::int AS count FROM sns_users');
    const cookies = await dbPool.query('SELECT COUNT(*)::int AS count FROM sns_user_cookies');
    return {
      ...status,
      ok: true,
      userCount: Number(users.rows[0]?.count || 0),
      cookieRecordCount: Number(cookies.rows[0]?.count || 0),
    };
  } catch (e) {
    return {
      ...status,
      ok: false,
      errorCode: e.code || e.name || 'DB_ERROR',
    };
  }
}

async function findUser(username) {
  const normalized = normalizeUsername(username);
  if (!dbPool) return loadUsers().users.find(u => u.username === normalized) || null;
  await ensureDb();
  const result = await dbPool.query('SELECT * FROM sns_users WHERE username = $1', [normalized]);
  return rowToUser(result.rows[0]);
}

async function insertUser(user) {
  if (!dbPool) {
    const data = loadUsers();
    data.users.push(user);
    saveUsers(data);
    return;
  }
  await ensureDb();
  await dbPool.query(`
    INSERT INTO sns_users (
      username, role, password_salt, password_hash, cookie_key_salt,
      created_at, last_login_at, cookie_size, cookie_updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [
    user.username, user.role, user.passwordSalt, user.passwordHash, user.cookieKeySalt,
    user.createdAt, user.lastLoginAt || null, user.cookieSize || 0, user.cookieUpdatedAt || null,
  ]);
}

async function updateUser(username, patch) {
  const normalized = normalizeUsername(username);
  if (!dbPool) {
    const data = loadUsers();
    const user = data.users.find(u => u.username === normalized);
    if (!user) return null;
    Object.assign(user, patch);
    saveUsers(data);
    return user;
  }
  await ensureDb();
  const current = await findUser(normalized);
  if (!current) return null;
  const next = { ...current, ...patch };
  await dbPool.query(`
    UPDATE sns_users
    SET role=$2, password_salt=$3, password_hash=$4, cookie_key_salt=$5,
        created_at=$6, last_login_at=$7, cookie_size=$8, cookie_updated_at=$9
    WHERE username=$1
  `, [
    next.username, next.role, next.passwordSalt, next.passwordHash, next.cookieKeySalt,
    next.createdAt, next.lastLoginAt || null, next.cookieSize || 0, next.cookieUpdatedAt || null,
  ]);
  return next;
}

async function deleteUserStore(username) {
  const normalized = normalizeUsername(username);
  if (!dbPool) {
    const data = loadUsers();
    const before = data.users.length;
    data.users = data.users.filter(u => u.username !== normalized);
    saveUsers(data);
    return data.users.length !== before;
  }
  await ensureDb();
  const result = await dbPool.query('DELETE FROM sns_users WHERE username = $1', [normalized]);
  return result.rowCount > 0;
}

async function getEncryptedCookieRecord(username) {
  const normalized = normalizeUsername(username);
  if (!dbPool) {
    const filePath = userCookiePath(normalized);
    if (!fs.existsSync(filePath)) return null;
    const user = loadUsers().users.find(u => u.username === normalized);
    return {
      encryptedJson: fs.readFileSync(filePath, 'utf8'),
      size: user?.cookieSize || 0,
      updatedAt: user?.cookieUpdatedAt || null,
    };
  }
  await ensureDb();
  const result = await dbPool.query('SELECT * FROM sns_user_cookies WHERE username = $1', [normalized]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    encryptedJson: row.encrypted_json,
    size: Number(row.size || 0),
    updatedAt: row.updated_at,
  };
}

async function saveEncryptedCookieRecord(username, encryptedJson, size, updatedAt) {
  const normalized = normalizeUsername(username);
  if (!dbPool) {
    ensureDataDirs();
    fs.writeFileSync(userCookiePath(normalized), encryptedJson, 'utf8');
    await updateUser(normalized, { cookieSize: size, cookieUpdatedAt: updatedAt });
    return;
  }
  await ensureDb();
  await dbPool.query(`
    INSERT INTO sns_user_cookies (username, encrypted_json, size, updated_at)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (username)
    DO UPDATE SET encrypted_json = EXCLUDED.encrypted_json,
                  size = EXCLUDED.size,
                  updated_at = EXCLUDED.updated_at
  `, [normalized, encryptedJson, size, updatedAt]);
  await updateUser(normalized, { cookieSize: size, cookieUpdatedAt: updatedAt });
}

async function deleteEncryptedCookieRecord(username) {
  const normalized = normalizeUsername(username);
  if (!dbPool) {
    try { fs.unlinkSync(userCookiePath(normalized)); } catch {}
    await updateUser(normalized, { cookieSize: 0, cookieUpdatedAt: null });
    return;
  }
  await ensureDb();
  await dbPool.query('DELETE FROM sns_user_cookies WHERE username = $1', [normalized]);
  await updateUser(normalized, { cookieSize: 0, cookieUpdatedAt: null });
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function isAdminUsername(username) {
  return normalizeUsername(username) === 'admin';
}

function validateUsername(username) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9_-]{3,24}$/.test(normalized)) {
    return '사용자 이름은 영문 소문자, 숫자, _,- 조합 3~24자로 입력해주세요.';
  }
  if (!isAdminUsername(normalized) && normalized.includes('admin')) {
    return '일반 사용자 이름에는 admin을 포함할 수 없습니다.';
  }
  return null;
}

function validatePassword(password) {
  if (String(password || '').length < 8) return '비밀번호는 8자 이상 입력해주세요.';
  if (String(password || '').length > 128) return '비밀번호는 128자 이하로 입력해주세요.';
  return null;
}

function scryptBase64(secret, salt, len = 64) {
  return crypto.scryptSync(String(secret), Buffer.from(salt, 'base64'), len).toString('base64');
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { passwordSalt: salt, passwordHash: scryptBase64(password, salt, 64) };
}

function verifyPassword(password, user) {
  const candidate = Buffer.from(scryptBase64(password, user.passwordSalt, 64), 'base64');
  const expected = Buffer.from(user.passwordHash, 'base64');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function deriveCookieKey(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), 32);
}

function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    cookieSize: user.cookieSize || 0,
    cookieUpdatedAt: user.cookieUpdatedAt || null,
  };
}

function userCookiePath(username) {
  return path.join(USER_COOKIES_DIR, `${normalizeUsername(username)}.enc`);
}

async function hasUserCookie(username) {
  return !!(username && await getEncryptedCookieRecord(username));
}

function removeUserSessions(username) {
  const normalized = normalizeUsername(username);
  for (const [sid, session] of sessions.entries()) {
    if (session.username === normalized) sessions.delete(sid);
  }
}

function createUserSession(res, user, password) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, {
    username: user.username,
    role: user.role,
    cookieKey: deriveCookieKey(password, user.cookieKeySalt),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  res.setHeader('Set-Cookie', sessionCookieHeader(sid));
}

function normalizeCookiesText(content) {
  const text = String(content || '');
  if (text.includes('\\n') && !text.includes('\n')) return text.replace(/\\n/g, '\n');
  return text;
}

function isValidCookiesText(content) {
  return content.includes('# Netscape HTTP Cookie File') || content.split(/\r?\n/).some(line => line.includes('\t'));
}

function saveCookiesText(content, savePath) {
  const normalized = normalizeCookiesText(content);
  if (!isValidCookiesText(normalized)) {
    const err = new Error('유효한 cookies.txt 파일이 아닙니다.\n"Get cookies.txt LOCALLY" 확장 프로그램으로 내보낸 파일을 사용하세요.');
    err.statusCode = 400;
    throw err;
  }
  fs.writeFileSync(savePath, normalized, 'utf8');
  const c = loadConfig();
  c.cookiesPath = savePath;
  delete c.cookiesBrowser;
  saveConfig(c);
  return {
    path: savePath,
    cookieCount: normalized.split('\n').filter(l => l.trim() && !l.startsWith('#')).length,
  };
}

function validateCookieContent(content) {
  const normalized = normalizeCookiesText(content);
  const size = Buffer.byteLength(normalized, 'utf8');
  if (size > COOKIE_UPLOAD_LIMIT_BYTES) {
    const err = new Error('쿠키 파일은 1MB 이하만 등록할 수 있습니다.');
    err.statusCode = 413;
    throw err;
  }
  if (!isValidCookiesText(normalized)) {
    const err = new Error('유효한 cookies.txt 파일이 아닙니다.\n"Get cookies.txt LOCALLY" 확장 프로그램으로 내보낸 파일을 사용하세요.');
    err.statusCode = 400;
    throw err;
  }
  return { normalized, size };
}

function encryptUserCookies(content, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const diagnostics = cookieTextDiagnostics(content);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    plaintextSha256: diagnostics.sha256,
    plaintextSize: diagnostics.size,
    cookieCount: diagnostics.cookieCount,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

async function decryptUserCookiesFile(username, key) {
  const record = await getEncryptedCookieRecord(username);
  if (!record) throw new Error('Cookie record not found');
  const raw = JSON.parse(record.encryptedJson);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(raw.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function countCookieLines(content) {
  return String(content || '').split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
}

function cookieTextDiagnostics(content) {
  const text = String(content || '');
  return {
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    size: Buffer.byteLength(text, 'utf8'),
    cookieCount: countCookieLines(text),
  };
}

async function userCookieStatus(req) {
  const username = req.user?.username;
  const user = await findUser(username);
  const record = username ? await getEncryptedCookieRecord(username) : null;
  const exists = !!record;
  const status = {
    exists,
    size: record?.size || user?.cookieSize || 0,
    updatedAt: record?.updatedAt || user?.cookieUpdatedAt || null,
    decryptOk: false,
    cookieCount: 0,
  };
  if (!exists || !req.session?.cookieKey) return status;
  try {
    const raw = JSON.parse(record.encryptedJson);
    const content = await decryptUserCookiesFile(username, req.session.cookieKey);
    const decrypted = cookieTextDiagnostics(content);
    status.decryptOk = true;
    status.cookieCount = decrypted.cookieCount;
    status.savedSha256 = raw.plaintextSha256 || null;
    status.decryptedSha256 = decrypted.sha256;
    status.hashMatch = raw.plaintextSha256 ? raw.plaintextSha256 === decrypted.sha256 : null;
  } catch (e) {
    status.error = '쿠키 복호화 실패';
  }
  status.lastUse = lastCookieUseByUser.get(username) || null;
  return status;
}

async function saveEncryptedUserCookies(req, content) {
  if (!req.session?.cookieKey || !req.user?.username) {
    const err = new Error('로그인이 필요합니다.');
    err.statusCode = 401;
    throw err;
  }
  const { normalized, size } = validateCookieContent(content);
  const encrypted = encryptUserCookies(normalized, req.session.cookieKey);
  const updatedAt = new Date().toISOString();
  const diagnostics = cookieTextDiagnostics(normalized);
  await saveEncryptedCookieRecord(req.user.username, JSON.stringify(encrypted, null, 2), size, updatedAt);
  return {
    path: userCookiePath(req.user.username),
    cookieCount: diagnostics.cookieCount,
    size,
    sha256: diagnostics.sha256,
  };
}

async function removeEncryptedUserCookies(username) {
  await deleteEncryptedCookieRecord(username);
}

async function requestCookiesArgs(req) {
  if (!requiresUserAuth(req)) return { args: cookiesArgs(), cleanup: () => {} };
  if (!req.session?.cookieKey || !req.user?.username || !(await hasUserCookie(req.user.username))) {
    return { args: [], cleanup: () => {} };
  }

  const tempPath = path.join(os.tmpdir(), `sns-dl-cookies-${req.user.username}-${crypto.randomBytes(8).toString('hex')}.txt`);
  const content = await decryptUserCookiesFile(req.user.username, req.session.cookieKey);
  const decoded = cookieTextDiagnostics(content);
  fs.writeFileSync(tempPath, content, 'utf8');
  const fileDiagnostics = cookieTextDiagnostics(fs.readFileSync(tempPath, 'utf8'));
  lastCookieUseByUser.set(req.user.username, {
    usedAt: new Date().toISOString(),
    path: tempPath,
    pathExistsAtUse: fs.existsSync(tempPath),
    decodedSha256: decoded.sha256,
    fileSha256: fileDiagnostics.sha256,
    hashMatch: decoded.sha256 === fileDiagnostics.sha256,
    size: fileDiagnostics.size,
    cookieCount: fileDiagnostics.cookieCount,
    cleanupAt: null,
    pathExistsAfterCleanup: null,
  });
  console.log(`[cookies] using user cookies username=${req.user.username} count=${fileDiagnostics.cookieCount} sha256=${fileDiagnostics.sha256.slice(0, 12)}`);
  return {
    args: ['--cookies', tempPath],
    cleanup: () => {
      try { fs.unlinkSync(tempPath); } catch {}
      const previous = lastCookieUseByUser.get(req.user.username);
      if (previous?.path === tempPath) {
        lastCookieUseByUser.set(req.user.username, {
          ...previous,
          cleanupAt: new Date().toISOString(),
          pathExistsAfterCleanup: fs.existsSync(tempPath),
        });
      }
    },
  };
}

async function requestHasCookies(req) {
  if (!requiresUserAuth(req)) return cookiesArgs().length > 0;
  return !!(req.user?.username && await hasUserCookie(req.user.username));
}

function ensureEnvCookies() {
  if (envCookiesChecked) return;
  envCookiesChecked = true;

  const configuredPath = (process.env.COOKIES_PATH || '').trim();
  if (configuredPath && fs.existsSync(configuredPath)) {
    envCookiesPath = configuredPath;
    const c = loadConfig();
    c.cookiesPath = configuredPath;
    delete c.cookiesBrowser;
    saveConfig(c);
    return;
  }

  const base64 = (process.env.COOKIES_BASE64 || process.env.COOKIES_TXT_BASE64 || '').trim();
  const rawText = process.env.COOKIES_TEXT || process.env.COOKIES_TXT || '';
  if (!base64 && !rawText) return;

  try {
    const content = base64 ? Buffer.from(base64, 'base64').toString('utf8') : rawText;
    const saved = saveCookiesText(content, RUNTIME_COOKIES_FILE);
    envCookiesPath = saved.path;
    console.log('[cookies] loaded from environment');
  } catch (e) {
    console.error('[cookies] environment cookie load failed:', e.message);
  }
}

// Returns cookies args for yt-dlp — file mode or browser mode
function cookiesArgs() {
  ensureEnvCookies();
  if (envCookiesPath && fs.existsSync(envCookiesPath)) return ['--cookies', envCookiesPath];
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
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(attachUserSession);

// User login is required on Render APIs. Windows PC mode stays local-first.
app.use('/api', (req, res, next) => {
  const publicPaths = ['/version', '/storage/status', '/auth', '/users/bootstrap', '/users/register', '/users/login', '/users/logout', '/users/me'];
  if (publicPaths.includes(req.path)) return next();
  userAuthMiddleware(req, res, next);
});
app.use('/api/info',     apiLimiter);
app.use('/api/download', downloadLimiter);

// ── GET /health ──────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── GET /api/version ─────────────────────────
const { version } = require('../package.json');
app.get('/api/version', (req, res) => res.json({ version, platform: process.platform }));

// ── GET /api/storage/status ──────────────────
// Reports safe storage diagnostics without exposing secrets.
app.get('/api/storage/status', async (req, res) => {
  const status = await getStorageStatus();
  res.status(status.ok ? 200 : 500).json(status);
});

// ── User auth APIs ───────────────────────────
app.get('/api/users/bootstrap', async (req, res) => {
  const users = (await loadUsersStore()).users;
  res.json({
    needsAdmin: !users.some(u => u.username === 'admin'),
    inviteRequired: true,
    authRequired: requiresUserAuth(req),
  });
});

app.get('/api/users/me', async (req, res) => {
  const session = getSession(req);
  if (!requiresUserAuth(req)) {
    return res.json({ ok: true, authRequired: false, user: null });
  }
  if (!session) return res.json({ ok: false, authRequired: true, user: null });
  try {
    const user = await findUser(session.username);
    res.json({ ok: !!user, authRequired: true, user: publicUser(user) });
  } catch (err) {
    console.error('[users/me]', err);
    res.status(500).json({ error: '사용자 정보를 불러올 수 없습니다.' });
  }
});

app.post('/api/users/register', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const inviteCode = String(req.body.inviteCode || '').trim();
  const usernameError = validateUsername(username);
  const passwordError = validatePassword(password);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (!ACCESS_TOKEN || inviteCode !== ACCESS_TOKEN) {
    return res.status(403).json({ error: '초대 코드가 올바르지 않습니다.' });
  }

  const data = await loadUsersStore();
  const hasAdmin = data.users.some(u => u.username === 'admin');
  if (!hasAdmin && username !== 'admin') {
    return res.status(400).json({ error: '첫 번째 사용자는 admin으로 등록해야 합니다.' });
  }
  if (data.users.some(u => u.username === username)) {
    return res.status(409).json({ error: '이미 등록된 사용자 이름입니다.' });
  }

  const now = new Date().toISOString();
  const passwordRecord = createPasswordRecord(password);
  const user = {
    username,
    role: isAdminUsername(username) ? 'admin' : 'user',
    ...passwordRecord,
    cookieKeySalt: crypto.randomBytes(16).toString('base64'),
    createdAt: now,
    lastLoginAt: now,
    cookieSize: 0,
    cookieUpdatedAt: null,
  };
  await insertUser(user);
  createUserSession(res, user, password);
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/users/login', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = await findUser(username);
  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: '사용자 이름 또는 비밀번호가 올바르지 않습니다.' });
  }
  user.lastLoginAt = new Date().toISOString();
  await updateUser(username, { lastLoginAt: user.lastLoginAt });
  createUserSession(res, user, password);
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/users/logout', (req, res) => {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', clearSessionCookieHeader());
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (req.user?.username === 'admin') return next();
  res.status(403).json({ error: '관리자 권한이 필요합니다.' });
}

app.get('/api/admin/users', userAuthMiddleware, requireAdmin, async (req, res) => {
  const users = (await loadUsersStore()).users.map(user => ({
    ...publicUser(user),
  }));
  for (const user of users) user.cookieExists = await hasUserCookie(user.username);
  res.json({ users });
});

app.delete('/api/admin/users/:username', userAuthMiddleware, requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (username === 'admin') return res.status(400).json({ error: 'admin 사용자는 삭제할 수 없습니다.' });
  const deleted = await deleteUserStore(username);
  if (!deleted) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  await removeEncryptedUserCookies(username);
  removeUserSessions(username);
  res.json({ ok: true });
});

app.post('/api/admin/users/:username/reset-password', userAuthMiddleware, requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.params.username);
  const password = String(req.body.password || '');
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const user = await findUser(username);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  await updateUser(username, {
    ...createPasswordRecord(password),
    cookieKeySalt: crypto.randomBytes(16).toString('base64'),
    cookieSize: 0,
    cookieUpdatedAt: null,
  });
  await removeEncryptedUserCookies(username);
  removeUserSessions(username);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username/cookies', userAuthMiddleware, requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.params.username);
  await removeEncryptedUserCookies(username);
  res.json({ ok: true });
});

app.get('/api/admin/diagnostics/yt-dlp', userAuthMiddleware, requireAdmin, (req, res) => {
  res.json({ items: recentYtDlpDiagnostics });
});

// ── POST /api/auth ───────────────────────────
// Legacy endpoint retained so old clients receive a clear migration signal.
app.post('/api/auth', (req, res) => {
  res.json({ ok: false, authRequired: requiresUserAuth(req), userLoginRequired: true });
});

// ── GET /api/localip ─────────────────────────
// Returns the PC's LAN IP so Android (same Wi-Fi) can connect directly
app.get('/api/localip', (req, res) => {
  const ifaces = os.networkInterfaces();
  const virtualName = /(vethernet|hyper-v|virtualbox|vmware|wsl|docker|loopback|tailscale|zerotier)/i;
  const candidates = [];

  for (const [name, list] of Object.entries(ifaces)) {
    if (virtualName.test(name)) continue;
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      candidates.push({ name, address: iface.address });
    }
  }

  candidates.sort((a, b) => {
    const score = c => {
      const n = c.name.toLowerCase();
      if (n.includes('wi-fi') || n.includes('wifi') || n.includes('wlan')) return 0;
      if (n.includes('ethernet') || n.includes('이더넷')) return 1;
      return 2;
    };
    const privateScore = c => {
      if (c.address.startsWith('192.168.')) return 0;
      if (c.address.startsWith('10.')) return 1;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(c.address)) return 2;
      return 3;
    };
    return score(a) - score(b) || privateScore(a) - privateScore(b);
  });

  const ip = candidates[0]?.address || 'localhost';
  res.json({ ip, port: PORT, candidates });
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

  // ── Threads custom handler (yt-dlp has no extractor for threads.com) ──────
  if (isThreadsUrl(url)) {
    try {
      const result = await fetchThreadsInfo(url, getActiveCookiesFilePath());
      return res.json(result);
    } catch (e) {
      console.error('[threads] error:', e.message);
      return res.status(400).json({ error: e.message || 'Threads 영상을 가져오지 못했습니다.' });
    }
  }

  const BASE_ARGS = [
    '--dump-json', '--no-warnings',
    '--retries', '3', '--fragment-retries', '3',
    '--socket-timeout', '30',
    ...throttledSiteArgs(url),
    '--playlist-items', '1-10',
  ];

  const runYtDlp = async (withCookies = false) => {
    const cookieBundle = withCookies ? await requestCookiesArgs(req) : { args: [], cleanup: () => {} };
    return new Promise((resolve, reject) => {
      const args = [...BASE_ARGS, ...cookieBundle.args, url];
      execFile(YT_DLP, args,
        { timeout: 90000, maxBuffer: 50 * 1024 * 1024 }, // 50MB — YouTube has many formats
        (err, stdout, stderr) => {
          cookieBundle.cleanup();
          if (err) {
            console.error('[info] yt-dlp error:', err.message, '| stderr:', (stderr || '').slice(0, 300));
            return reject(stderr || err.message);
          }
          resolve(stdout);
        }
      );
    });
  };

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

  const isLoginError = t => {
    const s = String(t || '').toLowerCase();
    return s.includes('login_required') ||
      s.includes('empty media') ||
      s.includes('login required') ||
      s.includes('sign in') ||
      s.includes('cookies') ||
      s.includes('age-restricted') ||
      s.includes('confirm your age') ||
      s.includes('inappropriate') ||
      String(t || '').includes('로그인');
  };

  const isNoVideoError = t => {
    const s = String(t || '').toLowerCase();
    return s.includes('no video could be found') ||
      s.includes('no video') ||
      s.includes('no video formats found');
  };

  const isRateLimitedError = t => {
    const s = String(t || '').toLowerCase();
    return s.includes('http error 429') ||
      s.includes('too many requests');
  };

  const errorKind = t => {
    if (isRateLimitedError(t)) return 'rate_limited';
    if (isLoginError(t)) return 'login_required';
    if (isNoVideoError(t)) return 'no_video';
    return 'unknown';
  };

  try {
    const initialHasCookies = await requestHasCookies(req);
    let stdout;
    try {
      stdout = await runYtDlp(initialHasCookies);
    } catch (errText) {
      const hasCookies = initialHasCookies || await requestHasCookies(req);
      const firstErrorKind = errorKind(errText);
      const firstCookieStatus = requiresUserAuth(req) ? await userCookieStatus(req) : null;
      rememberYtDlpDiagnostic({
        endpoint: 'info',
        stage: 'initial',
        url: safeUrlSummary(url),
        withCookies: initialHasCookies,
        errorKind: firstErrorKind,
        stderrTail: tailText(errText),
        cookie: firstCookieStatus ? {
          exists: firstCookieStatus.exists,
          decryptOk: firstCookieStatus.decryptOk,
          cookieCount: firstCookieStatus.cookieCount,
          hashMatch: firstCookieStatus.hashMatch,
          decryptedSha256: firstCookieStatus.decryptedSha256,
          lastUse: firstCookieStatus.lastUse,
        } : null,
      });
      const shouldRetryWithCookies = !initialHasCookies && (
        isLoginError(errText) ||
        ((isNoVideoError(errText) || isRateLimitedError(errText)) && hasCookies)
      );
      if (shouldRetryWithCookies) {
        console.log('[info] retrying with cookies...');
        try {
          // If cookies.txt or browser cookies already configured, use them directly
          // without trying to extract from browser (extraction only needed for first-time setup)
          if (!hasCookies) {
            if (requiresUserAuth(req)) {
              return res.status(400).json({
                error: '이 계정에 쿠키가 등록되어 있지 않습니다.',
                needSetup: true,
              });
            }
            await extractCookiesViaBrowser();
          } else {
            console.log('[info] using configured cookies');
          }
          stdout = await runYtDlp(true); // second attempt with cookies
        } catch (retryErr) {
          const msg = typeof retryErr === 'string' ? retryErr : retryErr.message;
          const retryErrorKind = errorKind(msg);
          const userCookie = requiresUserAuth(req) ? await userCookieStatus(req) : null;
          rememberYtDlpDiagnostic({
            endpoint: 'info',
            stage: 'retry',
            url: safeUrlSummary(url),
            withCookies: true,
            errorKind: retryErrorKind,
            stderrTail: tailText(msg),
            cookie: userCookie ? {
              exists: userCookie.exists,
              decryptOk: userCookie.decryptOk,
              cookieCount: userCookie.cookieCount,
              hashMatch: userCookie.hashMatch,
              decryptedSha256: userCookie.decryptedSha256,
              lastUse: userCookie.lastUse,
            } : null,
          });
          if (retryErrorKind === 'no_video' && isTumblrUrl(url)) {
            return res.status(400).json({
              error: '쿠키로 재시도했지만 Tumblr가 이 포스트의 동영상을 반환하지 않았습니다. Tumblr에 로그인된 cookies.txt인지 확인하거나 PC mode / Phone via PC로 시도하세요.',
              diagnostics: {
                firstErrorKind,
                retryErrorKind,
                retriedWithCookies: true,
                cookieExists: !!userCookie?.exists,
                cookieDecryptOk: userCookie ? userCookie.decryptOk : null,
                cookieCount: userCookie?.cookieCount || 0,
                savedSha256: userCookie?.savedSha256 || null,
                decryptedSha256: userCookie?.decryptedSha256 || null,
                hashMatch: userCookie?.hashMatch ?? null,
                lastUse: userCookie?.lastUse || null,
              },
            });
          }
          return res.status(400).json({
            error: parseYtDlpError(msg),
            diagnostics: {
              firstErrorKind,
              retryErrorKind,
              retriedWithCookies: true,
              cookieExists: !!userCookie?.exists,
              cookieDecryptOk: userCookie ? userCookie.decryptOk : null,
              cookieCount: userCookie?.cookieCount || 0,
              savedSha256: userCookie?.savedSha256 || null,
              decryptedSha256: userCookie?.decryptedSha256 || null,
              hashMatch: userCookie?.hashMatch ?? null,
              lastUse: userCookie?.lastUse || null,
            },
            needClose: retryErr.needClose || false,
            needSetup: retryErr.needSetup || false,
            browser: retryErr.browser || null,
          });
        }
      } else if (isNoVideoError(errText)) {
        const images = await extractImagesFromPage(url);
        if (images.length) return res.json({ items: images });
        if (initialHasCookies && isTumblrUrl(url)) {
          const userCookie = requiresUserAuth(req) ? await userCookieStatus(req) : null;
          return res.status(400).json({
            error: '쿠키를 사용했지만 Tumblr가 이 포스트의 동영상을 반환하지 않았습니다. Tumblr에 로그인된 cookies.txt인지 확인하거나 PC mode / Phone via PC로 시도하세요.',
            diagnostics: {
              firstErrorKind,
              retriedWithCookies: false,
              initialWithCookies: true,
              cookieExists: !!userCookie?.exists,
              cookieDecryptOk: userCookie ? userCookie.decryptOk : null,
              cookieCount: userCookie?.cookieCount || 0,
              savedSha256: userCookie?.savedSha256 || null,
              decryptedSha256: userCookie?.decryptedSha256 || null,
              hashMatch: userCookie?.hashMatch ?? null,
              lastUse: userCookie?.lastUse || null,
            },
          });
        }
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
// localhost:  saves permanently to downloads folder, returns JSON (no browser download)
// WiFi phone: saves permanently to downloads folder, streams to phone browser (keep file)
// Render:     saves temp, streams to browser, deletes after
app.post('/api/download', async (req, res) => {
  const { url, format, title, itemUrl } = req.body;
  const prepareOnly = req.body.prepareOnly === true || req.body.prepareOnly === 'true';
  const downloadUrl = itemUrl || url;  // use specific item URL for playlist/carousel items
  if (!downloadUrl) return res.status(400).json({ error: 'URL이 필요합니다.' });

  if (activeDownloads >= MAX_CONCURRENT) {
    return res.status(429).json({ error: `지금 다운로드가 많습니다(${MAX_CONCURRENT}개 한도). 잠시 후 다시 시도해주세요.` });
  }

  console.log(`[download] start — format=${format} mediaType=${req.body.mediaType} title=${title} active=${activeDownloads + 1}`);

  // Detect if request came from the local PC browser (vs WiFi phone or Render)
  const isLocalhostReq = isLocalhostRequest(req);

  // Direct download for: image CDN URLs, or synthesized 'direct' format (e.g. Instagram carousel)
  if ((req.body.mediaType === 'image' || format === 'direct') && /^https?:\/\//.test(downloadUrl)) {
    return downloadDirectUrl(downloadUrl, title, res, isLocalhostReq, prepareOnly);
  }

  const sessionId = crypto.randomBytes(8).toString('hex');
  const outTemplate = path.join(getDownloadsDir(), `${sessionId}.%(ext)s`);

  const isAudioOnly = (format || '').startsWith('bestaudio');
  const isImage     = req.body.mediaType === 'image';
  const cookieBundle = await requestCookiesArgs(req);
  const args = [
    '--no-playlist', '--no-warnings',
    '--retries', '3', '--fragment-retries', '5',
    '--socket-timeout', '30',
    ...throttledSiteArgs(downloadUrl),
    ...cookieBundle.args,
    '-f', format || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '-o', outTemplate,
    downloadUrl,
  ];
  if (!isAudioOnly && !isImage) args.push('--merge-output-format', 'mp4');
  if (isAudioOnly)              args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');

  activeDownloads++;
  const proc = spawn(YT_DLP, args);
  let stderr   = '';
  let responded = false;
  let cookieCleaned = false;

  const releaseSlot = () => { activeDownloads = Math.max(0, activeDownloads - 1); };
  const cleanupCookieBundle = () => {
    if (cookieCleaned) return;
    cookieCleaned = true;
    cookieBundle.cleanup();
  };
  proc.on('close', () => { releaseSlot(); cleanupCookieBundle(); });
  proc.on('error', () => { releaseSlot(); cleanupCookieBundle(); });
  res.on('close', () => { if (!responded) proc.kill(); });

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
      rememberYtDlpDiagnostic({
        endpoint: 'download',
        stage: 'download',
        url: safeUrlSummary(downloadUrl),
        withCookies: cookieBundle.args.length > 0,
        errorKind: stderr.includes('HTTP Error 429') || stderr.includes('Too Many Requests') ? 'rate_limited' :
          stderr.toLowerCase().includes('no video') ? 'no_video' : 'unknown',
        stderrTail: tailText(stderr),
        cookie: req.user?.username ? {
          username: req.user.username,
          lastUse: lastCookieUseByUser.get(req.user.username) || null,
        } : null,
      });
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

    if (isLocalhostReq) {
      // Local PC browser: file saved permanently, return metadata only
      console.log(`[download] saved ${finalFile} (${fileSize} bytes) → ${finalPath}`);
      return res.json({ ok: true, filename: finalFile, path: finalPath, size: fileSize });
    }

    if (prepareOnly) {
      return res.json({
        ok: true,
        filename: finalFile,
        size: fileSize,
        downloadUrl: `/api/files/download/${encodeURIComponent(finalFile)}`,
      });
    }

    // WiFi phone or Render: stream file to browser
    // Windows (WiFi): keep file on PC after streaming
    // Linux (Render): delete temp file after streaming
    const keepFile = process.platform === 'win32';
    console.log(`[download] streaming ${finalFile} (${fileSize} bytes) keepFile=${keepFile}`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(finalFile)}`);
    res.setHeader('X-Filename', encodeURIComponent(finalFile));
    res.setHeader('X-Filesize', fileSize);

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    stream.on('end', () => {
      if (!keepFile) { try { fs.unlinkSync(finalPath); } catch {} }
      console.log(`[download] stream complete${keepFile ? ', file kept on PC' : ', temp deleted'}`);
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
  const deleteAfter = req.query.delete === '1' && process.platform !== 'win32';
  const filename = path.basename(fp);
  const disposition = req.query.preview === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', getMimeType(ext));
  res.setHeader('Content-Length', fileSize);
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('X-Filename', encodeURIComponent(filename));
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  const match = range?.match(/bytes=(\d*)-(\d*)/);
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (start <= end && end < fileSize) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
  }
  const stream = fs.createReadStream(fp);
  stream.pipe(res);
  stream.on('end', () => {
    if (deleteAfter) { try { fs.unlinkSync(fp); } catch {} }
  });
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
app.get('/api/settings/cookies', async (req, res) => {
  if (requiresUserAuth(req)) {
    const cookieExists = req.user?.username ? await hasUserCookie(req.user.username) : false;
    return res.json({
      path: cookieExists ? userCookiePath(req.user.username) : null,
      ...(await userCookieStatus(req)),
    });
  }
  ensureEnvCookies();
  if (envCookiesPath && fs.existsSync(envCookiesPath)) return res.json({ path: envCookiesPath });
  const c = loadConfig();
  const hasFile = !!(c.cookiesPath && fs.existsSync(c.cookiesPath));
  res.json({ path: hasFile ? c.cookiesPath : null });
});

app.get('/api/settings/cookies/diagnostics', async (req, res) => {
  if (requiresUserAuth(req)) {
    return res.json({
      username: req.user?.username || null,
      storageBackend: dbPool ? 'postgres' : 'file',
      ...(await userCookieStatus(req)),
    });
  }
  ensureEnvCookies();
  const c = loadConfig();
  res.json({
    storageBackend: 'local',
    args: cookiesArgs(),
    envCookiesPath,
    configCookiesPath: c.cookiesPath || null,
    configCookiesBrowser: c.cookiesBrowser || null,
  });
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
app.post('/api/settings/upload-cookies', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let content = typeof req.body === 'string' ? req.body : (req.body?.content || '');
  try {
    if (requiresUserAuth(req)) {
      const saved = await saveEncryptedUserCookies(req, content);
      console.log(`[cookies] uploaded username=${req.user.username} size=${saved.size} count=${saved.cookieCount}`);
      return res.json({ ok: true, path: saved.path, cookieCount: saved.cookieCount, size: saved.size });
    }
    const savePath = path.join(__dirname, 'cookies.txt');
    const saved = saveCookiesText(content, savePath);
    res.json({ ok: true, path: saved.path, cookieCount: saved.cookieCount });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '파일 저장 실패: ' + e.message });
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
app.delete('/api/settings/cookies', async (req, res) => {
  if (requiresUserAuth(req)) {
    await removeEncryptedUserCookies(req.user.username);
    return res.json({ ok: true });
  }
  const c = loadConfig();
  delete c.cookiesPath;
  delete c.cookiesBrowser;
  saveConfig(c);
  if (envCookiesPath === RUNTIME_COOKIES_FILE) {
    try { fs.unlinkSync(RUNTIME_COOKIES_FILE); } catch {}
  }
  envCookiesPath = null;
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
    execFile('explorer.exe', [dir]);
  } else {
    execFile('xdg-open', [dir]);
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
    execFile('explorer.exe', [`/select,${fp}`]);
  } else {
    execFile('xdg-open', [path.dirname(fp)]);
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

// ── SSRF guard — block private/loopback/link-local IPs ──
function isPrivateHost(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    if (/^(localhost|.*\.local)$/i.test(host)) return true;
    const private4 = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^0\./,
    ];
    if (private4.some(r => r.test(host))) return true;
    if (/^(::1|fc00:|fd|fe80:)/i.test(host)) return true; // IPv6 private
    return false;
  } catch { return true; }
}

// ── Direct URL download (images from CDN) ─────
async function downloadDirectUrl(url, title, res, isLocalhostReq = false, prepareOnly = false) {
  if (isPrivateHost(url)) {
    return res.status(400).json({ error: '허용되지 않는 URL입니다.' });
  }
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

    if (isLocalhostReq) {
      // Local PC browser: file saved permanently — return metadata only
      return res.json({ ok: true, filename: finalName, path: finalPath, size: fileSize });
    }

    if (prepareOnly) {
      return res.json({
        ok: true,
        filename: finalName,
        size: fileSize,
        downloadUrl: `/api/files/download/${encodeURIComponent(finalName)}`,
      });
    }

    // WiFi phone or Render: stream to browser
    const keepFile = process.platform === 'win32';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(finalName)}`);
    res.setHeader('X-Filename', encodeURIComponent(finalName));
    res.setHeader('X-Filesize', fileSize);

    const readStream = fs.createReadStream(finalPath);
    readStream.pipe(res);
    readStream.on('end', () => { if (!keepFile) { try { fs.unlinkSync(finalPath); } catch {} } });
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
  if (stderr.includes('HTTP Error 429') || stderr.includes('Too Many Requests')) {
    return 'Tumblr가 Render 서버 요청을 잠시 제한했습니다. 잠시 후 다시 시도하거나 PC mode / Phone via PC를 사용하세요.';
  }
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

const CHROME_APP_WINDOW = { width: 560, height: 920 };

function resizeLatestChromeAppWindow() {
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Milliseconds 900
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@
$p = Get-Process chrome | Where-Object { $_.MainWindowTitle -like '*SNS Downloader*' } | Sort-Object StartTime -Descending | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne 0) {
  $r = New-Object Win32+RECT
  [Win32]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  [Win32]::MoveWindow($p.MainWindowHandle, $r.Left, $r.Top, ${CHROME_APP_WINDOW.width}, ${CHROME_APP_WINDOW.height}, $true) | Out-Null
}
`;
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 5000,
    windowsHide: true,
  }, () => {});
}

// ── GET /api/open-chrome ─────────────────────
// Spawn a new Chrome app-mode window for the PC platform button.
app.get('/api/open-chrome', (req, res) => {
  if (process.platform !== 'win32') return res.json({ ok: false, reason: 'windows-only' });
  const localData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const chromePaths = [
    path.join(localData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const chromePath = chromePaths.find(p => fs.existsSync(p));
  if (!chromePath) return res.json({ ok: false, reason: 'chrome-not-found' });
  const target = req.query.target === 'render'
    ? 'https://sns-downloader.onrender.com'
    : `http://localhost:${PORT}/?mode=app`;
  const child = spawn(chromePath, [
    `--app=${target}`,
    `--window-size=${CHROME_APP_WINDOW.width},${CHROME_APP_WINDOW.height}`,
    '--new-window',
  ], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  resizeLatestChromeAppWindow();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '쿠키 파일은 1MB 이하만 등록할 수 있습니다.' });
  }
  console.error('[express]', err);
  res.status(500).json({ error: '서버 오류' });
});

// ── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`yt-dlp: ${YT_DLP}`);
  const c = loadConfig();
  console.log(`downloads: ${c.downloadsDir || path.join(__dirname, '..', 'downloads')}`);
});
