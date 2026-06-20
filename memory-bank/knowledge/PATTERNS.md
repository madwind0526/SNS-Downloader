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
{"version":"1.10","platform":"linux"}
```
