# SNS Downloader v1.28

SNS Downloader는 YouTube, Instagram, TikTok, X/Twitter, Tumblr 등 여러 SNS 링크에서 영상, 이미지, 오디오를 내려받기 위한 개인용 웹앱입니다.

PC에서 실행해서 내 컴퓨터에 저장할 수도 있고, 핸드폰에서 접속해서 폰으로 저장할 수도 있습니다. 로그인 쿠키가 필요한 영상은 쿠키 파일을 등록해서 시도할 수 있습니다.

## 화면 미리보기

| 모드 선택 | PC Local | 항목 선택 |
| --- | --- | --- |
| <img src="screenshots/화면%20캡처%202026-06-26%20190009.png" width="260" alt="모드 선택 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190031.png" width="260" alt="PC Local 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190117.png" width="260" alt="다운로드 항목 선택 화면"> |

| 완료/미리보기 | 파일 | 이력 |
| --- | --- | --- |
| <img src="screenshots/화면%20캡처%202026-06-26%20190146.png" width="260" alt="다운로드 완료 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190204.png" width="260" alt="파일 목록 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190222.png" width="260" alt="다운로드 이력 화면"> |

| 쿠키 등록 | 설정 | Render 로그인 |
| --- | --- | --- |
| <img src="screenshots/화면%20캡처%202026-06-26%20190256.png" width="260" alt="쿠키 등록 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190325.png" width="260" alt="설정 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190419.png" width="260" alt="Render 로그인 화면"> |

| Render 대기 | Render Server | Android 연결 |
| --- | --- | --- |
| <img src="screenshots/화면%20캡처%202026-06-26%20190358.png" width="260" alt="Render 대기 화면"> | <img src="screenshots/화면%20캡처%202026-06-26%20190447.png" width="260" alt="Render Server 화면"> | <img src="screenshots/IP%20수정.png" width="260" alt="Android 연결 설정 화면"> |

## 어떤 모드를 쓰면 좋을까?

| 모드 | 추천 상황 | 저장 위치 |
| --- | --- | --- |
| PC Local | PC에서 바로 받을 때, 로그인 쿠키가 필요한 영상을 받을 때 | PC 다운로드 폴더 |
| Phone via PC | 핸드폰으로 저장하고 싶지만 PC의 쿠키와 네트워크를 쓰고 싶을 때 | 핸드폰 기본 다운로드 폴더 |
| Render Server | 밖에서 핸드폰만으로 접속하고 싶을 때 | 핸드폰 기본 다운로드 폴더 |

가장 안정적인 방식은 **PC Local** 또는 **Phone via PC**입니다. Render Server는 외부에서 편하게 접속할 수 있지만, YouTube/Tumblr 같은 일부 사이트가 Render의 공유 서버 IP를 제한할 수 있습니다.

## 빠른 시작

### PC에서 사용하기

1. Node.js 18 이상을 설치합니다.
2. 이 저장소를 받은 뒤 의존성을 설치합니다.

```bash
npm install
```

3. `start.bat`을 실행합니다.
4. 열린 창에서 `PC`를 선택합니다.
5. URL을 붙여넣고 `정보 가져오기`를 누른 뒤 원하는 항목을 다운로드합니다.

서버를 종료하려면 `stop.bat`을 실행합니다. 종료 창에서 아무 키나 누르면 창이 닫힙니다.

### 핸드폰에서 PC를 통해 사용하기

1. PC와 핸드폰을 같은 Wi-Fi에 연결합니다.
2. PC에서 `start.bat`을 실행합니다.
3. 앱의 설정에서 Android 연결 QR을 확인합니다.
4. 핸드폰 카메라 또는 Chrome으로 QR을 열어 접속합니다.
5. 다운로드 후 `폰으로 저장`을 누릅니다.

이 방식은 다운로드 처리를 PC가 담당하고, 최종 파일만 핸드폰으로 저장합니다. 로그인 쿠키가 필요한 영상은 Render보다 이 방식이 유리합니다.

### Render Server에서 사용하기

1. Render 주소로 접속합니다.
2. 계정이 없다면 초대 코드로 사용자 등록을 합니다.
3. 로그인 후 URL을 붙여넣고 다운로드합니다.
4. 로그인이 필요한 영상이면 쿠키 파일을 먼저 등록합니다.

Render 무료 플랜은 한동안 접속이 없으면 서버가 잠들 수 있습니다. 처음 접속할 때 50초 이상 걸릴 수 있습니다.

## 쿠키가 필요한 경우

Instagram, YouTube, X/Twitter, Tumblr 등은 영상에 따라 로그인이 필요하거나 성인/비공개/봇 확인 제한이 걸릴 수 있습니다. 이때는 브라우저에서 export한 `cookies.txt`를 등록해야 합니다.

쿠키 등록 방법:

1. Chrome에서 `Get cookies.txt LOCALLY` 확장을 설치합니다.
2. 다운로드하려는 사이트에 Chrome으로 로그인합니다.
3. 확장에서 `Export As` 또는 `cookies.txt` 저장을 선택합니다.
4. SNS Downloader의 쿠키 설정 화면에 파일을 드래그하거나 파일 선택으로 등록합니다.

주의할 점:

- PC Local과 Phone via PC는 PC 서버에 등록된 쿠키를 사용합니다.
- Render Server는 로그인한 사용자별로 쿠키를 따로 저장합니다.
- 쿠키 파일은 1MB 이하만 등록할 수 있습니다.
- 쿠키는 로그인 정보와 비슷하게 민감합니다. 본인만 사용하는 환경에서만 등록하세요.

## 지원 사이트

yt-dlp가 지원하는 1000개 이상의 사이트를 기반으로 동작합니다. 앱에서 자주 쓰는 사이트는 자동 감지됩니다.

| 종류 | 사이트 |
| --- | --- |
| 영상/SNS | YouTube, Instagram, TikTok, X/Twitter, Facebook, Tumblr, Reddit |
| 동영상 플랫폼 | Vimeo, Dailymotion, TED, Twitch, Naver TV, Kakao TV |
| 커뮤니티/기타 | Pinterest, Imgur, Bilibili, Niconico, Kick, Rumble |
| 오디오 | SoundCloud, Bandcamp |

사이트 정책, 로그인 상태, 지역 제한, 서버 IP 제한에 따라 같은 링크라도 PC에서는 되고 Render에서는 안 될 수 있습니다.

## 파일과 이력

앱 하단 탭에서 다운로드 결과를 확인할 수 있습니다.

- `다운로드`: URL 입력, 정보 조회, 다운로드 실행
- `파일`: 서버에 준비된 파일 열기, 폴더에서 보기, 삭제
- `이력`: 최근 다운로드 기록 확인
- `정보`: 지원 사이트와 앱 정보 확인

Android Chrome은 웹앱이 원하는 폴더에 직접 저장하도록 강제할 수 없습니다. 실제 저장 위치는 보통 `/sdcard/Download`입니다.

## 운영자 참고

### Render 환경변수

| Key | 설명 |
| --- | --- |
| `ACCESS_TOKEN` | 사용자 등록용 초대 코드 |
| `DATABASE_URL` | 선택 사항. Supabase 또는 Neon Postgres 연결 문자열 |
| `DATABASE_SSL` | 선택 사항. SSL 없는 로컬 Postgres만 `0` |

`DATABASE_URL`을 설정하면 사용자와 쿠키 정보가 Postgres에 저장되어 Render 재시작 후에도 유지됩니다. 설정하지 않으면 파일 저장 방식으로 동작하며, Render Free에서는 재시작이나 재배포 때 데이터가 사라질 수 있습니다.

### Render 배포 설정

```yaml
services:
  - type: web
    name: sns-downloader
    env: node
    plan: free
    buildCommand: npm install && pip install -U yt-dlp
    startCommand: node server/index.js
```

배포 확인:

```text
https://sns-downloader.onrender.com/api/version
https://sns-downloader.onrender.com/api/storage/status
```

### 로컬 개발 명령

```bash
npm install
npm start
```

기본 주소는 `http://localhost:3001`입니다.

## 알아두면 좋은 제한

- Render Free는 서버가 잠들면 첫 요청이 느립니다.
- Render의 공유 IP가 YouTube/Tumblr에서 제한될 수 있습니다.
- 로그인 쿠키를 등록해도 사이트가 서버 요청 자체를 차단하면 다운로드가 실패할 수 있습니다.
- 신뢰하지 않는 네트워크에서 PC Local/Phone via PC를 열어두지 마세요.
- 다운로드한 콘텐츠는 각 서비스의 약관과 저작권 범위 안에서만 사용하세요.
