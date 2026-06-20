# Trouble Shooting

## Render mode에서 서버에는 받았는데 폰에 저장되지 않음

### 증상

- 앱 이력에는 다운로드가 성공으로 기록됨.
- Render 서버 `/api/files`에는 준비 파일이 있거나 있었다.
- S26 `/sdcard/Download`에는 완성 파일이 없고 `.pending-...mp4`만 생기거나 아무 파일도 없음.
- 성공 화면에 `폰으로 저장` 버튼이 안 뜨는 경우가 있었음.

### 원인

Render는 프록시 뒤에서 Express가 요청을 받을 수 있다. 이때 `req.ip`가 localhost처럼 보일 수 있는데, 기존 서버 코드가 이를 PC Local 요청으로 오판했다.

그 결과 Render 서버인데도 `/api/download`가 `downloadUrl` 없이 "PC에 저장됨" JSON만 반환했고, 클라이언트는 `serverDownloads`를 만들지 못했다.

### 해결

PC Local 판정은 Windows 서버에서만 허용한다.

```js
const isLocalhostReq = process.platform === 'win32' &&
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp);
```

Render/Linux에서는 항상 remote/mobile 흐름으로 처리한다.

## Android Chrome에서 자동 저장이 불안정함

### 증상

- `<a download>`를 JS에서 자동 클릭해도 파일이 저장되지 않음.
- 직접 다운로드 URL로 이동하면 저장됨.

### 해결

서버 준비 파일 URL로 직접 이동한다.

```js
function triggerServerDownload(downloadUrl) {
  window.location.href = withAuthToken(downloadUrl);
}
```

성공 화면과 파일 탭 모두 이 방식을 사용한다.

## Render 준비 파일이 저장 실패 후 사라짐

### 증상

- 폰 저장이 실패했는데 Render 서버 파일 목록도 비어 있어 재시도할 수 없음.

### 원인

모바일 세션 파일을 정리하는 `deleteSessionFiles()`가 다음 다운로드 또는 reset 시 서버 파일을 삭제했다.

### 해결

Render/Phone via PC 준비 파일은 자동 삭제하지 않는다. 파일 탭에서 `폰으로 저장` 재시도를 제공하고, 필요 시 사용자가 삭제한다.

## 서버 다운로드 방식 변경 후 미리보기가 사라짐

### 증상

- 이전 blob 방식에서는 성공 화면에 미리보기가 떴다.
- 서버 URL 직접 저장 방식으로 바꾼 뒤 `lastVideoBlob`이 없어 미리보기가 표시되지 않았다.

### 해결

서버 준비 파일 URL을 preview source로 사용한다.

클라이언트:

```js
const previewUrl = withServerParams(first.url, { preview: '1' });
previewVideo.src = previewUrl;
```

서버:

```js
const disposition = req.query.preview === '1' ? 'inline' : 'attachment';
res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
res.setHeader('Accept-Ranges', 'bytes');
```

Range 요청도 `206 Partial Content`로 응답해야 모바일 비디오 미리보기가 안정적이다.

## Android 저장 위치 오해

### 증상

- 앱 설정에는 `/storage/emulated/0/Documents/SNS-Downloader`가 보이지만 실제 파일은 안 보임.

### 원인

Android Chrome 웹앱은 임의 경로에 직접 파일을 저장할 수 없다. 브라우저 기본 다운로드 위치는 보통 `/sdcard/Download`다.

### 확인

```bash
adb shell "ls -lt /sdcard/Download | head"
adb shell "ls -la /sdcard/Documents/SNS-Downloader"
```

S26 테스트 결과 실제 저장 위치는 `/sdcard/Download`였다.

## Chrome App-Bound Encryption으로 cookies-from-browser 실패

### 증상

- Instagram/YouTube 일부 영상에서 로그인 필요 또는 연령 제한 오류.
- yt-dlp가 Chrome 쿠키를 자동으로 읽지 못함.

### 원인

Chrome App-Bound Encryption 때문에 외부 프로세스가 Chrome 쿠키를 직접 복호화하기 어렵다.

### 해결

1. Chrome 확장 `Get cookies.txt LOCALLY` 설치
2. 대상 사이트 로그인
3. `cookies.txt` export
4. 앱 쿠키 설정에 등록

Render 서버도 동일한 인증이 필요하면 Render 쪽에 별도 cookies.txt가 필요하다.
