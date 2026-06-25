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

## Render 접속에서 쿠키 설정 UI가 보이지 않음

### 증상

- Render mode로 접속하면 Instagram/YouTube/X 등 로그인 필요 콘텐츠가 자주 실패한다.
- 서버에는 쿠키 업로드 API가 있지만 외부 접속 화면에서는 쿠키 버튼과 설정 영역이 보이지 않는다.

### 원인

프론트가 `!isLocal`일 때 쿠키 UI를 숨기고 있었다. 또한 삭제 요청은 `apiFetch()`가 아니라 일반 `fetch()`를 사용해서 Render 인증 헤더가 빠질 수 있었다.

### 해결

1. `ACCESS_TOKEN`이 설정된 Render 서버에서는 쿠키 UI를 표시한다.
2. 쿠키 업로드/삭제 요청은 `apiFetch()`로 인증 헤더를 포함한다.
3. `ACCESS_TOKEN`이 없는 원격 서버에서는 쿠키 설정 API를 거부해 공개 서버에 쿠키가 노출되지 않게 한다.
4. 재시작/재배포 후 복원을 위해 `COOKIES_BASE64` 또는 `COOKIES_TEXT` 환경변수에서 cookies.txt를 materialize한다.

## Chrome app window가 지나치게 작게 열림

### 증상

- PC/Mobile 선택 후 열리는 Chrome app window가 매우 작게 보인다.
- 창 제목줄과 앱 글씨까지 작아져 읽기 어렵다.

### 원인

Chrome 실행 인자에 `--force-device-scale-factor=1`이 있으면 Windows 고해상도/배율 환경에서 Chrome UI와 페이지가 강제로 100% 배율로 표시될 수 있다. 또한 기존 `--window-size=420,820`은 실제 모니터에서는 너무 작은 앱 창이 된다.

### 해결

1. `--force-device-scale-factor=1` 제거
2. `start.bat`과 `/api/open-chrome`의 기본 앱 창 크기를 `560,920`으로 변경
3. `window.open()` fallback 크기도 `560,920`으로 통일

### 추가 보정

Chrome app-mode는 URL별 이전 창 크기를 기억할 수 있다. 같은 `--window-size`를 전달해도 PC/Render 창 크기가 다르면, Chrome 실행 직후 Windows API `MoveWindow`로 최신 `SNS Downloader` 창을 공통 크기에 맞춘다.

## Render 공용 쿠키가 사용자 간에 덮어써짐

### 증상

- A가 Render에 쿠키를 등록한 뒤 사용 중인데 B가 새 쿠키를 등록하면 이후 A도 B 쿠키로 다운로드한다.

### 원인

기존 Render 쿠키 저장소가 서버 전체 공용 `cookies.txt` 1개였기 때문이다.

### 해결

1. Render/Linux API는 username/password 로그인 세션을 요구한다.
2. 쿠키는 `server/data/cookies/{username}.enc`에 사용자별로 저장한다.
3. 쿠키 파일은 로그인 password에서 파생한 key로 AES-256-GCM 암호화한다.
4. 다운로드 직전에만 복호화해 임시 `cookies.txt`를 만들고 yt-dlp 종료 후 삭제한다.
5. 쿠키 업로드는 1MB 초과 시 거부한다.

## Tumblr 쿠키 필요 영상이 no-video 오류로 실패

### 증상

- PC Local에서는 Tumblr 영상이 보이지만 Render에서는 쿠키 등록 후에도 `Tumblr 이미지 포스트는 지원되지 않습니다.` 또는 no-video 계열 오류가 난다.

### 원인

Tumblr/yt-dlp가 쿠키 필요 상황을 `login required`가 아니라 `No video could be found` 또는 `No video formats found`로 반환할 수 있다. 기존 서버는 로그인 오류에서만 쿠키 재시도를 해서 등록된 쿠키를 쓰기 전에 fallback 오류로 빠졌다.

### 해결

쿠키가 등록된 요청이면 no-video 계열 오류에서도 yt-dlp를 쿠키로 한 번 더 재시도한다.

## Render 사용자와 쿠키가 배포 후 초기화됨

### 증상

- Render Server mode 접속 시 이전에 만든 admin/user가 없어지고 다시 사용자 등록 화면이 나온다.
- `/api/users/bootstrap`이 `needsAdmin:true`를 반환한다.

### 원인

Render 기본 파일시스템은 ephemeral이다. `server/data/users.json`과 `server/data/cookies/*.enc`에 저장한 런타임 데이터는 deploy/restart 후 사라질 수 있다.

### 해결

Free 테스트에서는 deploy 후 admin 등록과 쿠키 업로드를 다시 진행한다. 장기 보존이 필요하면 Render persistent disk 또는 외부 DB를 사용한다.
