# SNS Downloader v1.2

YouTube, Instagram, TikTok, Twitter/X 등 1000개 이상의 사이트에서 동영상·이미지를 다운로드하는 웹 앱입니다.  
PC(Windows)에서는 로컬 서버로 실행하고, 모바일에서는 Render 클라우드 서버에 접속합니다.

---

## 파일 구조

```
VideoDownloader/
├── start.bat              ← PC 실행 (서버 시작 + Chrome 앱 창 열기)
├── stop.bat               ← 서버 종료
├── server/
│   ├── index.js           ← Express 서버 (yt-dlp 실행, API, SSE 진행률)
│   └── config.json        ← 설정 저장 (다운로드 폴더 경로, 쿠키 경로 등)
├── public/
│   ├── index.html         ← 메인 UI (단일 페이지 앱)
│   ├── js/app.js          ← 프론트엔드 로직
│   └── css/style.css      ← 스타일 (다크/라이트 테마)
├── bin/
│   └── yt-dlp.exe         ← 다운로드 엔진 (Windows 바이너리)
├── downloads/             ← PC 다운로드 폴더 (기본값, 설정에서 변경 가능)
├── render.yaml            ← Render 배포 설정
└── package.json
```

---

## PC 설치 방법

### 필수 조건

- **Node.js** 18 이상 — https://nodejs.org
- **Google Chrome**
- **Windows 10/11**

### 설치 절차

```bash
# 1. 저장소 클론
git clone https://github.com/madwi/sns-downloader.git
cd sns-downloader

# 2. 의존성 설치
npm install
```

> `start.bat`을 처음 실행하면 `node_modules`가 없을 경우 자동으로 `npm install`을 실행합니다.

---

## PC 사용 방법

### 1. 서버 시작

`start.bat` 더블클릭

- 서버 콘솔 창이 열림 (닫으면 서버 종료)
- Chrome이 자동으로 앱 창(420×820)을 열어줌

### 2. 서버 종료

- 서버 콘솔 창의 **X** 버튼 클릭
- 또는 `stop.bat` 더블클릭

### 3. 다운로드

1. SNS URL을 입력란에 붙여넣기
2. 분석 버튼 클릭 → 화질/포맷 선택
3. 다운로드 버튼 클릭
4. `파일` 탭에서 다운로드된 파일 확인·열기

### 4. 다운로드 폴더 변경

설정(⚙) → 다운로드 폴더 → **변경** 버튼

---

## 모바일 사용 방법

### 방법 A: Render 클라우드 서버 (공개 콘텐츠만)

브라우저에서 Render URL 직접 접속  
쿠키 없이 로그인 불필요한 공개 영상만 다운로드 가능

### 방법 B: 같은 WiFi에서 PC 서버 사용 (권장)

PC와 폰이 같은 WiFi에 연결된 경우 PC의 로컬 서버를 직접 사용할 수 있습니다.  
쿠키를 통한 로그인 콘텐츠 다운로드도 가능합니다.

1. PC에서 `start.bat` 실행 (서버 시작)
2. 앱 설정(⚙) → **Android 연결** 탭 → **Wi-Fi** QR코드 스캔
3. 폰 브라우저에서 PC 서버로 직접 접속

---

## Instagram 등 로그인 필요 사이트

쿠키 파일을 사용하면 로그인이 필요한 콘텐츠를 다운로드할 수 있습니다. **(1회만 설정)**

1. Chrome에서 **Get cookies.txt LOCALLY** 확장 설치
2. `instagram.com` 접속 (로그인 상태)
3. 확장 아이콘 클릭 → **Export As** → `cookies.txt` 저장
4. 앱 헤더의 **쿠키** 버튼 클릭 → 파일 드롭 또는 파일 선택

> Render(모바일 클라우드) 서버에서는 쿠키 기능을 사용할 수 없습니다.

---

## 지원 플랫폼

| 플랫폼 | 비고 |
|--------|------|
| YouTube | 화질 선택 가능 |
| Instagram | 쿠키 필요 (비공개 계정) |
| TikTok | |
| Twitter / X | |
| Facebook | |
| Naver TV / Kakao TV | |
| Bilibili / Niconico | |
| Twitch | VOD·클립 |
| Vimeo / Dailymotion | |
| Reddit / Rumble | |
| SoundCloud / Bandcamp | 오디오 |
| 기타 1000+ 사이트 | yt-dlp 지원 사이트 전체 |

---

## API 엔드포인트 (개발자용)

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/info` | URL 분석 (제목·썸네일·포맷 목록) |
| `POST` | `/api/download` | 다운로드 실행 |
| `GET` | `/api/progress/:id` | SSE 진행률 스트리밍 |
| `GET` | `/api/files` | 다운로드 폴더 파일 목록 |
| `GET` | `/api/version` | 앱 버전 반환 |
| `GET` | `/api/settings/download-folder` | 현재 다운로드 폴더 경로 |
| `GET` | `/api/settings/pick-download-folder` | Windows 폴더 선택 대화상자 |
| `GET` | `/api/settings/open-downloads-folder` | 탐색기로 다운로드 폴더 열기 |

---

## 기술 스택

- **백엔드**: Node.js + Express
- **프론트엔드**: Vanilla HTML / CSS / JS (빌드 도구 없음)
- **다운로드 엔진**: yt-dlp (오픈소스, 1000+ 사이트 지원)
- **클라우드 배포**: Render (모바일 접속용)
- **진행률 스트리밍**: Server-Sent Events (SSE)
