# Active Context

## Current Focus

- SNS Downloader v1.16 Render 쿠키 상태 진단 추가 완료.
- `/api/users/bootstrap`이 `needsAdmin:true`이면 Render 런타임 `server/data/`가 reset되어 admin/user 재등록이 필요한 상태다.
- 쿠키 상태 API는 `decryptOk`, `cookieCount`, `size`, `updatedAt`을 반환하되 쿠키 값은 노출하지 않는다.
- 쿠키가 등록된 요청은 `No video could be found` 계열 오류에서도 yt-dlp를 쿠키로 한 번 더 재시도한다.
- Render/Linux는 username/password 로그인 세션이 필요하며 `ACCESS_TOKEN`은 사용자 등록 초대 코드로만 사용한다.
- username이 정확히 `admin`인 사용자만 관리자이며, 일반 사용자 이름에는 `admin` 포함 금지.
- Render 쿠키는 사용자별 AES-GCM 암호화 파일 `server/data/cookies/{username}.enc`로 저장되고 1MB 초과 업로드는 거부된다.
- 다음 배포 후 `https://sns-downloader.onrender.com/api/version`이 `1.16`인지 확인한다.

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
