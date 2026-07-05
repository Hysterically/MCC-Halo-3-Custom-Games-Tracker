# CLAUDE.md

Halo 3 (MCC) custom-games tracker: watches the local `mpcarnagereport*.xml` files,
records matches, computes ELO + TrueSkill 2 CSR, and posts a leaderboard +
per-match results to Discord.

## Two pieces, one flow

- **`src/`** — the tracker (bot host + local watch), run with `tsx` (`npm run watch`).
  Two ingest sources feed one shared pipeline: this PC's MCC carnage folder (chokidar)
  and, if configured, the `#carnage-inbox` channel that friends' watchers upload to.
  See `src/pipeline.ts` (shared record → rate → post → leaderboard) and `src/inbox.ts`
  (Discord listener + backlog scan). With `H3_INBOX_CHANNEL_ID` unset it's a plain
  local-folder watcher.
- **`watcher/`** — the friends' install (repo-root folder, promoted from `next/watcher`
  2026-07-05). A zero-dependency Node 18+ script (`watcher.mjs`, no `npm install`, no TS)
  that watches MCC's carnage folder and uploads each finished-custom XML to
  `#carnage-inbox` via a write-only webhook, with an `h3meta` line carrying matchId,
  played-at mtime, and map breadcrumbs. `Run-Watcher.bat` launches it; `watcher.env`
  holds the webhook URL.
- The former native C++ port (`cpp/`) was removed 2026-07-02.

Type-check before shipping: `npm run typecheck`.

### One-time Discord setup for the inbox (still TODO on the server)

- Create private `#carnage-inbox`; friends must NOT have read access.
- Add a webhook in that channel → the URL goes in friends' `watcher.env` as `WEBHOOK_URL`.
- Discord dev portal → bot application → **Message Content Intent: ON**.
- Bot needs View Channel + Read Message History + Add Reactions in that channel.
- Host `.env`: `H3_INBOX_CHANNEL_ID=<channel id>` (optional: `H3_INBOX_BACKLOG_MESSAGES`,
  default 300).

## Distribution

`bundle.bat vX.Y.Z` (repo root) stages `src/` + `assets/` + `package.json` +
`package-lock.json` + `tsconfig.json` + `packaging/` (Install.bat /
Run-Tracker.bat / Setup.bat / README.txt / neutral aliases.json) +
`version.txt` into `dist\h3-tracker-windows.zip`. Zip layout: root has ONLY
the three bats + README.txt; everything else (source, assets, configs,
version.txt, later node_modules/data/.env) lives in `app\` so the extracted
folder looks simple. Split launchers (v2.1.0, user's consent concern):
`Install.bat` = one-time, explicit-consent setup (winget Node if missing +
`npm install`); `Run-Tracker.bat` NEVER installs anything — it refuses with
"run Install.bat first" if Node/node_modules are missing, else runs
`npx tsx src/watch.ts`. `version.txt` feeds `H3_VERSION` for the
outdated-build check (`src/updateCheck.ts`). ALL .bat files must be CRLF
(cmd can't find `call :label` targets in LF files; .gitattributes pins it,
bundle.bat re-normalizes staged bats) and must contain NO parentheses inside
echo text (a `)` inside an if-block aborts the script).

## MANDATORY: publish a release after every update

After any change that ships (a new feature or fix), you MUST do BOTH of these so the
README download link and the friends' Discord channel stay in sync — do not consider
the work done until both are updated:

1. **GitHub release** (repo `Hysterically/MCC-Halo-3-Custom-Games-Tracker`).
   - Build the zip: `bundle.bat vX.Y.Z` → `dist\h3-tracker-windows.zip`.
   - Bump the version tag `vX.Y.Z` (the git tag IS the version — no in-source string).
     Latest is on the GitHub `releases/latest` endpoint.
   - Create the release and upload the asset named EXACTLY `h3-tracker-windows.zip`
     (the README's `releases/latest/download/h3-tracker-windows.zip` link depends on it).
   - ALSO upload `watcher/watcher.mjs` as a second asset named EXACTLY `watcher.mjs` —
     friends' watchers self-update from `releases/latest/download/watcher.mjs`. If the
     watcher changed, bump `WATCHER_VERSION` inside it (that constant, not the git tag,
     is what watchers and the bot compare).
   - `gh` is not installed; use the REST API with the token from `git credential fill`
     (via the **Bash** tool — never print the token). GitHub release publishing is
     durably authorized.

2. **Discord `#tracker-download`** (the "ready" zip for friends, no GitHub needed).
   - Assemble `h3-tracker-ready.zip` = the release zip contents + `friends.env` renamed
     to `.env` (dropped at the zip root — Run-Tracker.bat moves it into `app\` on first
     run), **minus Setup.bat** (friends don't need it).
   - Update the single pinned bot message **in place** (edit, don't post new): multipart
     `PATCH /channels/<ch>/messages/<msg>` with `Authorization: Bot <DISCORD_BOT_TOKEN>`.
   - **Preview the full post text and get the user's approval BEFORE sending.**

See the project memory (`release-publish-workflow`, `preview-outward-posts`) for the
exact channel/message ids and curl/credential gotchas.
