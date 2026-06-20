# State

## Current Wave

- **Wave:** 4
- **Status:** Completed
- **Cache Status:** CLEAN
- **Last Checkpoint:** v1.10 Render/Phone download stabilization completed (2026-06-21)

## Version

- Current app version: `1.10`
- Local server: `http://localhost:3001`
- Render server: `https://sns-downloader.onrender.com`

## Wave History

| Wave | Work | Status | Date |
| --- | --- | --- | --- |
| 1 | Project design and initial scaffold | Completed | 2026-06-20 |
| 2 | UI redesign, TDZ bug fix, folder setting | Completed | 2026-06-20 |
| 3 | PC/Mobile download split, light mode, mobile file UI, start/stop scripts, README | Completed | 2026-06-20 |
| 4 | Render/Phone via PC download stabilization, phone save retry, preview restore, documentation refresh | Completed | 2026-06-21 |

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
