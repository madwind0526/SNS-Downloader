# State

## Current Wave

- **Wave:** 13
- **Status:** Completed
- **Cache Status:** CLEAN
- **Last Checkpoint:** v1.19 Render storage diagnostics added (2026-06-25)

## Version

- Current app version: `1.19`
- Local server: `http://localhost:3001`
- Render server: `https://sns-downloader.onrender.com`

## Wave History

| Wave | Work | Status | Date |
| --- | --- | --- | --- |
| 1 | Project design and initial scaffold | Completed | 2026-06-20 |
| 2 | UI redesign, TDZ bug fix, folder setting | Completed | 2026-06-20 |
| 3 | PC/Mobile download split, light mode, mobile file UI, start/stop scripts, README | Completed | 2026-06-20 |
| 4 | Render/Phone via PC download stabilization, phone save retry, preview restore, documentation refresh | Completed | 2026-06-21 |
| 5 | Render cookie UI, auth guard, environment cookie restore | Completed | 2026-06-25 |
| 6 | Chrome app window size and high-DPI scale fix | Completed | 2026-06-25 |
| 7 | PC/Render Chrome app window size sync with MoveWindow fallback | Completed | 2026-06-25 |
| 8 | Render username/password login, admin UI, encrypted per-user cookies | Completed | 2026-06-25 |
| 9 | Retry yt-dlp with registered cookies on Tumblr no-video errors | Completed | 2026-06-25 |
| 10 | Render cookie status diagnostics and reset documentation | Completed | 2026-06-25 |
| 11 | Tumblr 429 user guidance and throttled yt-dlp requests | Completed | 2026-06-25 |
| 12 | Postgres-backed Render user and encrypted cookie persistence | Completed | 2026-06-25 |
| 13 | Safe Render storage diagnostics endpoint | Completed | 2026-06-25 |

## Session Notes

- 2026-06-20: Fixed local IP selection to avoid virtual adapters; PC LAN IP resolves correctly for phone access.
- 2026-06-20: Fixed `start.bat` quoting/echo issues and Chrome app window sizing.
- 2026-06-20: Added auth/rate limit related server behavior and cookie upload support.
- 2026-06-21: Render mode confirmed to deploy through GitHub `main`.
- 2026-06-21: Fixed Render mobile download mode. Render/Linux no longer treats proxy localhost IP as PC Local.
- 2026-06-21: Replaced mobile blob re-download flow with direct server download URL navigation.
- 2026-06-21: Kept Render prepared files retryable from the Files tab.
- 2026-06-21: Restored preview for server-prepared downloads using inline `preview=1` and HTTP Range.
- 2026-06-21: S26 ADB testing confirmed files save under `/sdcard/Download`.
- 2026-06-25: Render cookie support improved. Protected Render sessions can upload cookies, cookie settings API requires `ACCESS_TOKEN` remotely, and `COOKIES_BASE64`/`COOKIES_TEXT` can restore cookies after restart.
- 2026-06-25: Increased Chrome app window size to `560,920` and removed `--force-device-scale-factor=1` to avoid tiny UI on high-DPI Windows displays.
- 2026-06-25: Added Windows `MoveWindow` correction after Chrome app-mode launch so PC and Render app windows use the same outer size even when Chrome remembers per-URL bounds.
- 2026-06-25: Added Render user login. `ACCESS_TOKEN` is now an invite code, `admin` is the only admin username, and Render cookies are encrypted per user with a 1MB upload limit.
- 2026-06-25: Fixed Tumblr cookie retry. Registered cookies are now retried for no-video yt-dlp errors, not only explicit login errors.
- 2026-06-25: Confirmed Render `/api/users/bootstrap` can return `needsAdmin:true` after deploy because runtime `server/data/` is ephemeral. Added cookie decrypt/count diagnostics without exposing cookie values.
- 2026-06-25: Added Tumblr-specific yt-dlp sleep options and Korean 429 guidance for Render IP rate limiting.
- 2026-06-25: Added optional `DATABASE_URL` Postgres storage for Render users and encrypted per-user cookies, with file fallback and one-time file-to-DB migration when DB is empty.
- 2026-06-25: Added `/api/storage/status` to distinguish file fallback from Postgres storage without exposing secrets.
