# VideoDownloader

> **Working directory: `C:\Claude\VideoDownloader`**

## Project Overview

SNS(YouTube, Instagram, TikTok, Twitter/X, Facebook 등)의 영상·이미지를 다운로드할 수 있는 웹 기반 도구.

- URL 붙여넣기 → 플랫폼 자동 감지 → 화질/포맷 선택 → 다운로드
- 엔진: `yt-dlp` (1000+ 사이트 지원, 오픈소스)
- 우선 로컬 웹앱(Windows)으로 시작 → 나중에 서버 배포 → Android 지원

## Tech Stack

- **백엔드**: Node.js + Express
- **프론트엔드**: Vanilla HTML / CSS / JS (빌드 도구 없음)
- **다운로드 엔진**: `yt-dlp` (바이너리 번들)
- **기타**: child_process로 yt-dlp 실행, Server-Sent Events로 진행률 스트리밍

## Project Structure

```
VideoDownloader/
├── server/
│   └── index.js          # Express 서버 (yt-dlp 실행 + API)
├── public/
│   ├── index.html        # 메인 UI
│   └── css/style.css
├── bin/
│   └── yt-dlp.exe        # 번들 바이너리 (Windows)
├── downloads/            # 임시 저장 폴더 (gitignore)
├── package.json
└── CLAUDE.md
```

## Commands

```bash
# 의존성 설치
npm install

# 개발 실행
npm run dev

# 프로덕션 실행
npm start
```

## Supported Platforms (URL 자동 감지)

| 플랫폼 | URL 패턴 |
|--------|----------|
| YouTube | `youtube.com`, `youtu.be` |
| Instagram | `instagram.com` |
| TikTok | `tiktok.com` |
| Twitter/X | `twitter.com`, `x.com` |
| Facebook | `facebook.com`, `fb.watch` |
| Pinterest | `pinterest.com`, `pin.it` (동영상 핀만 지원) |
| Vimeo | `vimeo.com` |
| Dailymotion | `dailymotion.com`, `dai.ly` |
| TED | `ted.com` |
| Imgur | `imgur.com` |
| Tumblr | `tumblr.com` (동영상 포스트만 지원) |
| Reddit | `reddit.com` |
| Twitch | `twitch.tv` |
| Naver TV | `tv.naver.com` |
| Kakao TV | `tv.kakao.com` |
| Bilibili | `bilibili.com`, `b23.tv` |
| Niconico | `nicovideo.jp`, `nico.ms` |
| Kick | `kick.com` (VOD·클립) |
| Rumble | `rumble.com` |
| SoundCloud | `soundcloud.com` (오디오) |
| Bandcamp | `bandcamp.com` (오디오) |
| BitChute | `bitchute.com` |

## API Endpoints

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/info` | URL에서 영상 정보 조회 (제목, 썸네일, 포맷 목록) |
| `POST` | `/api/download` | 선택한 포맷으로 다운로드 시작 |
| `GET` | `/api/progress/:id` | SSE로 다운로드 진행률 스트리밍 |

## Code Comment Language (MANDATORY)

**All code comments must be written in English.** Korean characters in source files cause encoding issues.

This applies to:
- `//` inline comments
- `/* */` block comments

UI strings (user-visible text in HTML) remain in Korean as-is.

## PowerShell Encoding

- This project may be used from Windows PowerShell 5.1.
- When reading or writing Korean Markdown documents in Windows PowerShell 5.1, explicitly use UTF-8:
  - Read: `Get-Content README.md -Encoding UTF8`
  - Write: `Set-Content README.md -Value $text -Encoding UTF8`
- PowerShell 7+ handles UTF-8 defaults better, but commands should remain compatible with Windows PowerShell 5.1 unless the project explicitly changes that requirement.

## Key Conventions

- UI 텍스트는 한국어
- yt-dlp 바이너리 경로: `bin/yt-dlp.exe` (상대 경로)
- 다운로드 임시 폴더: `downloads/` (세션 후 정리)
- CORS는 로컬 개발 시에만 허용 (`localhost:3001`)

## Memory Bank

| 파일 | 용도 |
|------|------|
| `memory-bank/active-context.md` | 현재 작업 포커스 |
| `memory-bank/STATE.md` | Wave 진행 상태 |
| `memory-bank/CACHE.md` | 세션 중 임시 발견사항 |
| `memory-bank/knowledge/PATTERNS.md` | 재사용 코드 패턴 |
| `memory-bank/knowledge/RULES.md` | 프로젝트 규칙 |
| `memory-bank/knowledge/trouble-shooting.md` | 버그 해결 기록 |

**세션 시작 시**: `active-context.md` → `STATE.md` 순으로 읽고 현재 상태를 파악할 것.
