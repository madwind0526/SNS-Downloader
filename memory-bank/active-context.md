# Active Context

## Current Focus

- SNS Downloader v1.13 PC/Render Chrome app window 크기 동기화 완료.
- PC/Mobile 선택으로 열리는 app window는 `560,920` 크기로 열리고, Windows `MoveWindow`로 한 번 더 보정된다.
- Chrome 실행 인자에서 `--force-device-scale-factor=1`을 제거했다.
- Render에서 쿠키 UI는 `ACCESS_TOKEN`이 설정된 보호 서버일 때만 표시된다.
- Render 재시작/재배포 후 쿠키 복원은 `COOKIES_BASE64` 또는 `COOKIES_TEXT` 환경변수를 사용한다.
- 다음 배포 후 `https://sns-downloader.onrender.com/api/version`이 `1.13`인지 확인한다.

## Current Behavior

- PC Local:
  - `localhost` 또는 `127.0.0.1`에서 Windows 서버로 접속.
  - 서버가 PC 다운로드 폴더에 파일을 저장하고 JSON metadata를 반환.
  - 미리보기는 `/api/files/download/:filename` URL 사용.

- Phone via PC:
  - 핸드폰이 PC IP의 3001 포트로 접속.
  - PC 서버가 파일을 준비.
  - 핸드폰은 `/api/files/download/:filename`로 저장.
  - PC 서버 파일은 유지.

- Render:
  - Render 서버가 파일을 준비.
  - 핸드폰은 `/api/files/download/:filename`로 저장.
  - Android Chrome의 실제 저장 위치는 보통 `/sdcard/Download`.
  - 서버 준비 파일은 자동 삭제하지 않고 파일 탭에서 `폰으로 저장` 재시도 가능.

## Recent Fixes

- Render 프록시 환경에서 `req.ip`가 localhost처럼 보이는 문제를 수정.
  - Linux/Render에서는 localhost 요청으로 취급하지 않음.
  - Windows 로컬 서버에서만 `127.0.0.1`을 PC Local로 판정.
- 모바일 저장을 blob 방식에서 다운로드 URL 이동 방식으로 변경.
- `deleteSessionFiles()`가 Render 준비 파일을 지워 재시도를 막던 문제 제거.
- 파일 탭에서 서버 준비 파일 목록과 `폰으로 저장` 재시도 제공.
- 서버 파일 미리보기 복구:
  - `preview=1`이면 `Content-Disposition: inline`
  - `Accept-Ranges: bytes` 및 Range 응답 지원.
- 헤더와 플랫폼 화면의 version 텍스트 대비 개선.

## Next Notes

- Render free 플랜은 cold start가 있으므로 모바일 테스트 전 `/api/version` 응답 확인이 유용.
- Android Chrome은 `/storage/emulated/0/Documents/SNS-Downloader` 강제 저장을 보장하지 않음.
- 쿠키가 필요한 Instagram/YouTube/X 콘텐츠는 서버별 cookies.txt 등록 상태를 확인해야 함.
