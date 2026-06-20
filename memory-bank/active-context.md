# Active Context

## Current Focus

- SNS Downloader v1.10 안정화 완료.
- Render mode와 Phone via PC mode의 폰 저장 흐름을 서버 준비 파일 + 브라우저 네이티브 다운로드 URL 방식으로 정리.
- 성공 화면 미리보기는 서버 파일 URL `?preview=1`과 Range 요청으로 복구.
- README와 memory-bank 최신화 진행.

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
