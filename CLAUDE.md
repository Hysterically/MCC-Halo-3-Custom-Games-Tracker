# CLAUDE.md

Halo 3 (MCC) custom-games tracker: watches the local `mpcarnagereport*.xml` files,
records matches, computes ELO + TrueSkill 2 CSR, and posts a leaderboard +
per-match results to Discord.

## One implementation: TypeScript

- **`src/`** — the tracker, run with `tsx` (e.g. `npm run watch`). This is both
  the live install (runs from source at the repo root) AND what ships to users.
- The former native C++ port (`cpp/`) was removed 2026-07-02; the TS source zip
  is now the sole distribution artifact. There is no parity requirement anymore.

Type-check before shipping: `npm run typecheck`.

## Distribution

`bundle.bat vX.Y.Z` (repo root) stages `src/` + `package.json` +
`package-lock.json` + `tsconfig.json` + `packaging/` (Run-Tracker.bat /
Setup.bat / README.txt / neutral aliases.json) + `version.txt` into
`dist\h3-tracker-windows.zip`. Zip layout: root has ONLY Run-Tracker.bat /
Setup.bat / README.txt; everything else (source, configs, version.txt, later
node_modules/data/.env) lives in `app\` so the extracted folder looks simple.
The zip is self-bootstrapping: `Run-Tracker.bat` installs Node.js via winget
and runs `npm install` on first run, then `npx tsx src/watch.ts`.
`version.txt` feeds `H3_VERSION` for the outdated-build check
(`src/updateCheck.ts`).

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
