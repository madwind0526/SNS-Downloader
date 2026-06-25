# SNS Downloader v1.17

SNS 영상/이미지를 다운로드하는 Node.js + yt-dlp 기반 웹앱입니다.

- PC에서는 Windows 로컬 서버를 실행하고 `localhost:3001`로 접속합니다.
- 핸드폰에서는 Render 서버 또는 같은 Wi-Fi의 PC 서버로 접속합니다.
- Render mode와 Phone via PC mode 모두 서버가 먼저 파일을 준비한 뒤, 폰 브라우저가 다운로드 URL로 저장합니다.

## 실행 모드

| 모드 | 접속 위치 | 서버 위치 | 저장 동작 |
| --- | --- | --- | --- |
| PC Local | `http://localhost:3001` | 내 PC | PC 다운로드 폴더에 저장 |
| Phone via PC | `http://<PC-IP>:3001` | 내 PC | PC에 준비 후 폰의 기본 Download 폴더로 저장 |
| Render | `https://sns-downloader.onrender.com` | Render | Render에 준비 후 폰의 기본 Download 폴더로 저장 |

Android Chrome은 웹앱이 임의로 `/storage/emulated/0/Documents/SNS-Downloader`에 직접 저장하는 것을 보장하지 않습니다. 실제 저장 위치는 보통 `/sdcard/Download`입니다.

## 주요 기능

- YouTube, Instagram, TikTok, X/Twitter 등 yt-dlp 지원 사이트 다운로드
- 영상/이미지/오디오 다운로드
- PC 다운로드 폴더 변경
- Phone via PC용 QR 접속
- Render/Phone via PC에서 `폰으로 저장` 재시도
- 서버 준비 파일 미리보기
- Instagram/YouTube/X 등 로그인 필요 영상용 `cookies.txt` 등록

## 설치

필수:

- Windows 10/11
- Node.js 18 이상
- Chrome
- `bin/yt-dlp.exe`

설치:

```bash
npm install
```

## PC에서 실행

```bat
start.bat
```

동작:

- 기존 3001 포트 서버를 종료합니다.
- `node server/index.js`를 실행합니다.
- Chrome 앱 창을 `http://localhost:3001/?mode=app`으로 엽니다.

서버 종료:

```bat
stop.bat
```

또는 서버 콘솔 창을 닫습니다.

## 핸드폰에서 사용

### Render mode

1. 핸드폰 Chrome에서 `https://sns-downloader.onrender.com` 접속
2. URL 입력 후 다운로드
3. 성공 화면의 미리보기 확인
4. 저장이 자동으로 안 되면 `폰으로 저장` 버튼 클릭
5. 파일은 보통 `/sdcard/Download`에 저장됨

Render는 무료 플랜 특성상 처음 접속 시 로딩이 걸릴 수 있습니다.

### Phone via PC mode

1. PC에서 `start.bat` 실행
2. 설정의 Android 연결 또는 QR로 `http://<PC-IP>:3001` 접속
3. 다운로드
4. PC 서버에 파일이 준비되고, 폰에서 `폰으로 저장`으로 저장 가능

Phone via PC는 PC의 쿠키/다운로드 환경을 사용할 수 있어 로그인 필요 영상에 더 유리합니다.

## 쿠키 설정

Instagram, YouTube, X 등에서 로그인이 필요한 영상은 `cookies.txt`가 필요할 수 있습니다.

1. Chrome에서 `Get cookies.txt LOCALLY` 확장 설치
2. 대상 사이트에 로그인
3. 확장에서 `cookies.txt` export
4. 앱의 쿠키 설정 영역에 드래그 또는 파일 선택

주의:

- PC Local/Phone via PC는 PC 서버의 쿠키를 사용합니다.
- Render mode는 사용자 로그인 후 사용자별 쿠키 파일을 등록해야 동일하게 동작합니다.
- Render 사용자 등록에는 Render 환경변수 `ACCESS_TOKEN` 초대 코드가 필요합니다.
- Render 쿠키 파일은 로그인 비밀번호 기반 key로 암호화되어 `server/data/cookies/`에 사용자별로 저장됩니다.
- 쿠키 파일은 1MB 이하만 등록할 수 있습니다.
- Chrome App-Bound Encryption 때문에 Chrome 쿠키 자동 추출은 제한될 수 있습니다.

### Render 사용자와 쿠키

1. Render Dashboard에서 `ACCESS_TOKEN` 환경변수 설정
2. 배포 후 `https://sns-downloader.onrender.com` 접속
3. 첫 사용자는 username `admin`으로 등록
4. 추가 사용자는 초대 코드로 등록
5. 로그인 후 상단 쿠키 버튼에서 본인 `cookies.txt` 업로드

`admin` 사용자는 설정 화면에서 사용자 목록, 비밀번호 초기화, 쿠키 삭제, 사용자 삭제를 관리할 수 있습니다.

Free Render의 기본 파일시스템은 deploy/restart 때 보존되지 않습니다. `server/data/`에 저장한 사용자와 쿠키가 사라지면 사용자 등록과 쿠키 업로드를 다시 진행해야 합니다. 장기 보존이 필요하면 Render persistent disk 또는 외부 DB가 필요합니다.

## Render 배포

Render 설정은 `render.yaml`을 사용합니다.

```yaml
services:
  - type: web
    name: sns-downloader
    env: node
    plan: free
    buildCommand: apt-get install -y ffmpeg && npm install && pip install yt-dlp
    startCommand: node server/index.js
```

GitHub `main`에 push하면 Render가 자동 배포합니다. 배포 확인:

```text
https://sns-downloader.onrender.com/api/version
```

## 주요 API

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/version` | 앱 버전/플랫폼 확인 |
| `POST` | `/api/info` | URL 분석 |
| `POST` | `/api/download` | 서버 다운로드 실행 |
| `GET` | `/api/files` | 서버 준비 파일 목록 |
| `GET` | `/api/files/download/:filename` | 서버 파일 다운로드 또는 미리보기 |
| `POST` | `/api/files/delete` | 서버 파일 삭제 |
| `GET` | `/api/settings/download-folder` | PC 다운로드 폴더 조회 |
| `GET` | `/api/settings/pick-download-folder` | PC 다운로드 폴더 선택 |

## 현재 주의사항

- Android Chrome의 실제 저장 위치는 앱이 강제할 수 없습니다.
- Render free 플랜은 첫 요청이 느릴 수 있습니다.
- Render 서버는 프록시 뒤에 있으므로 Linux/Render에서는 localhost 요청으로 판정하지 않도록 처리되어 있습니다.
- 서버 다운로드 미리보기는 `/api/files/download/:filename?preview=1`과 Range 요청을 사용합니다.
