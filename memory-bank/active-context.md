# Active Context

## Current Focus

- SNS Downloader v1.19 Render storage diagnostics added.
- `/api/storage/status` reports whether Render is using file fallback or Postgres without exposing secrets.
- `DATABASE_URL` enables Postgres storage for Render users and encrypted per-user cookies.
- Supabase/Neon Postgres should work with default SSL; local non-SSL Postgres can set `DATABASE_SSL=0`.
- Without `DATABASE_URL`, the app keeps the existing `server/data/` file fallback.
- Existing file-backed users/cookies are migrated once if DB is empty on first initialization.
- Render still needs `ACCESS_TOKEN` as the invite code for user registration.
- First user must be exact username `admin`; other usernames cannot include `admin`.
- Next deploy should verify `https://sns-downloader.onrender.com/api/version` returns `1.19`.

## Current Behavior

- PC Local and Phone via PC keep using the Windows-local file/config behavior.
- Render/Linux requires username/password login before server mode APIs.
- Render cookie upload stores only encrypted cookie blobs and safe metadata.
- Downloads decrypt cookies only for the active request, pass a temporary cookies file to yt-dlp, then clean it up.

## Next Notes

- Render Free filesystem resets are no longer a blocker once `DATABASE_URL` is configured.
- Tumblr `HTTP Error 429` can still happen because it is server IP/rate-limit related, not cookie persistence.
- Turso is not covered by the Postgres adapter and would need a separate SQLite/libSQL storage driver.
