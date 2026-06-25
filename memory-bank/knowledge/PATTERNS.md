# Patterns

## Runtime Mode Detection

Client:

```js
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
let isPCServer = isLocal;
```

Server platform is checked by `/api/version`.

```js
fetch('/api/version').then(r => r.json()).then(d => {
  if (d.platform === 'win32') isPCServer = true;
});
```

Mode labels:

- `PC Local`: browser is localhost.
- `Phone via PC`: server is Windows but browser is not localhost.
- `Render Server`: server is Linux/Render.

## PC Local Download

Windows localhost requests save permanently to the PC download folder and return JSON metadata.

```js
const isLocalhostReq = process.platform === 'win32' &&
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp);

if (isLocalhostReq) {
  return res.json({ ok: true, filename, path: finalPath, size: fileSize });
}
```

Do not use localhost IP checks on Render/Linux because Render proxy requests may look local.

## Render / Phone via PC Download

Remote phone flows use a two-step model:

1. `/api/download` prepares the file on the server.
2. It returns `downloadUrl`.
3. The phone browser navigates to that URL.

```js
if (prepareOnly) {
  return res.json({
    ok: true,
    filename: finalFile,
    size: fileSize,
    downloadUrl: `/api/files/download/${encodeURIComponent(finalFile)}`,
  });
}
```

Client:

```js
function triggerServerDownload(downloadUrl) {
  window.location.href = withAuthToken(downloadUrl);
}
```

This is more reliable on Android Chrome than `fetch().blob()` followed by synthetic `<a download>.click()`.

## Server Prepared File Retry

Prepared files should remain retryable.

- Do not auto-delete Render prepared files after a failed phone save.
- Files tab should show server prepared files first.
- `폰으로 저장` reuses `/api/files/download/:filename`.

```js
triggerServerDownload(`/api/files/download/${encodeURIComponent(filename)}`, filename);
```

## Preview For Server Downloads

Server-prepared downloads do not have a client blob. Use the server file URL as preview source.

Client:

```js
const previewUrl = withServerParams(downloadUrl, { preview: '1' });
previewVideo.src = previewUrl;
```

Server:

```js
const disposition = req.query.preview === '1' ? 'inline' : 'attachment';
res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
res.setHeader('Accept-Ranges', 'bytes');
```

Support Range requests for video tags:

```js
if (range) {
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', end - start + 1);
  return fs.createReadStream(fp, { start, end }).pipe(res);
}
```

## Auth Token In Download URLs

Render may require `ACCESS_TOKEN`. Download URLs opened by navigation cannot send custom headers, so append token as query string.

```js
function withAuthToken(url) {
  const token = getToken();
  if (!token) return url;
  const u = new URL(url, window.location.origin);
  u.searchParams.set('token', token);
  return u.pathname + u.search + u.hash;
}
```

## Android Storage Reality

The UI may display a preferred mobile path, but Android Chrome decides the actual download location.

Observed on S26:

```text
/sdcard/Download
```

Do not promise direct writes to `/storage/emulated/0/Documents/SNS-Downloader` unless File System Access API permission is actually granted.

## Render Deployment Check

After pushing GitHub `main`, verify deployment:

```text
https://sns-downloader.onrender.com/api/version
```

Expected JSON:

```json
{"version":"1.14","platform":"linux"}
```

## Render Cookies From Environment

Render runtime files can disappear after restart or redeploy. For persistent server-side yt-dlp cookies, load cookies from an environment variable at runtime and pass the materialized file to yt-dlp.

Supported environment variables:

- `COOKIES_BASE64` or `COOKIES_TXT_BASE64`: base64 encoded `cookies.txt`
- `COOKIES_TEXT` or `COOKIES_TXT`: raw or escaped-newline `cookies.txt`
- `COOKIES_PATH`: path to an existing cookies file

Pattern:

```js
const RUNTIME_COOKIES_FILE = path.join(os.tmpdir(), 'sns-downloader-cookies.txt');
const content = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf8');
fs.writeFileSync(RUNTIME_COOKIES_FILE, content, 'utf8');
ytDlpArgs.push('--cookies', RUNTIME_COOKIES_FILE);
```

## User-Scoped Encrypted Render Cookies

Render/Linux uses user sessions and per-user encrypted cookies instead of one shared server cookie.

Storage:

```text
server/data/users.json
server/data/cookies/{username}.enc
```

Runtime pattern:

```js
const key = deriveCookieKey(password, user.cookieKeySalt);
const encrypted = encryptUserCookies(cookiesText, key);
fs.writeFileSync(userCookiePath(username), JSON.stringify(encrypted, null, 2), 'utf8');
```

For yt-dlp, decrypt only for the current request, write a temporary `cookies.txt`, pass `--cookies`, then delete the temporary file when the process exits.

Cookie status APIs should report only safe metadata:

```json
{"exists":true,"size":612345,"decryptOk":true,"cookieCount":120}
```

Never return cookie values or full decrypted cookie text in logs or API responses.

## Postgres-Backed Render User Storage

Use `DATABASE_URL` as an optional storage switch. When it is set, store Render users and encrypted cookie blobs in Postgres; when it is missing, keep the local file fallback.

Tables:

```text
sns_users
sns_user_cookies
```

This works with Supabase and Neon Postgres connection strings. Default to SSL for hosted Postgres, and allow `DATABASE_SSL=0` only for local Postgres.

Pattern:

```js
const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
    })
  : null;
```

Keep the storage API async even for file fallback so routes do not care which backend is active.
