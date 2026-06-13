# CLAUDE.md

Halo 3 (MCC) custom-games tracker: watches the local `mpcarnagereport*.xml` files,
records matches, computes ELO, and posts a leaderboard + per-match results to Discord.

## Two implementations, kept at parity

- **`src/`** — TypeScript (run with `tsx`, e.g. `npm run watch`). Easiest to iterate.
- **`cpp/`** — native C++ port. **This is the sole distribution artifact** (the `.exe`
  shipped to users). The retired Node `dist` path is gone.

**Every behavioural change must land in BOTH `src/` and `cpp/` and stay equivalent.**
Mirror the logic, the SQL schema/migrations, and the Discord command set in both.

Type-check / build before shipping:
- TS: `npm run typecheck`
- C++: `cpp\build.bat` (MSVC + vcpkg static → `cpp\build\bin\h3-tracker.exe`)

## MANDATORY: publish a release after every update

After any change that ships (a new feature or fix), you MUST do BOTH of these so the
README download link and the friends' Discord channel stay in sync — do not consider
the work done until both are updated:

1. **GitHub release** (repo `Hysterically/MCC-Halo-3-Custom-Games-Tracker`).
   - Build the zip: `cpp\bundle.bat` → `cpp\dist\h3-tracker-windows.zip`.
   - Bump the version tag `vX.Y.Z` (the git tag IS the version — no in-source string).
     Latest is on the GitHub `releases/latest` endpoint.
   - Create the release and upload the asset named EXACTLY `h3-tracker-windows.zip`
     (the README's `releases/latest/download/h3-tracker-windows.zip` link depends on it).
   - `gh` is not installed; use the REST API with the token from `git credential fill`
     (via the **Bash** tool — never print the token). GitHub release publishing is
     durably authorized.

2. **Discord `#tracker-download`** (the "ready" zip for friends, no GitHub needed).
   - Assemble `h3-tracker-ready.zip` = the release zip contents + `friends.env` renamed
     to `.env` (so it runs on extract).
   - Update the single pinned bot message **in place** (edit, don't post new): multipart
     `PATCH /channels/<ch>/messages/<msg>` with `Authorization: Bot <DISCORD_BOT_TOKEN>`.
   - **Preview the full post text and get the user's approval BEFORE sending.**

See the project memory (`release-publish-workflow`, `preview-outward-posts`) for the
exact channel/message ids and curl/credential gotchas.
