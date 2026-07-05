# CLAUDE.md

> **⚠️ PENDING OWNER TASKS:** if `docs/WHEN-BACK-AT-PC.md` exists in this repo,
> read it FIRST and walk the owner through it before starting other work.
> (Once that checklist is completed it gets deleted, and this notice is moot.)

Halo 3 (MCC) custom-games tracker: watches the local `mpcarnagereport*.xml`
files, records matches, computes ELO + TrueSkill 2 CSR, and posts a
leaderboard + per-match results to Discord.

## One implementation: TypeScript

- **`src/`** — the tracker, run with `tsx` (e.g. `npm run watch`). This is both
  the live install (runs from source at the repo root) AND what ships to users.
- Type-check before shipping: `npm run typecheck`.

## Private files — never commit these

`.env`, `watcher/watcher.env`, `aliases.json`, `data/`, `CLAUDE.local.md` are
gitignored on purpose: they hold the owner's tokens, the group's real display
names, match history, and private maintainer notes. The public repo and the
owner's live install are the SAME repo — the separation exists only because
these files stay untracked. Never `git add -f` them, and never hardcode their
contents into `src/`.

Owner-only operational notes (release publishing, Discord specifics) live in
`CLAUDE.local.md` on the owner's machines — Claude Code auto-reads it when
present.

## Distribution

`bundle.bat vX.Y.Z` (repo root) stages `src/` + `assets/` + `package.json` +
`package-lock.json` + `tsconfig.json` + `packaging/` + `version.txt` into
`dist\h3-tracker-windows.zip`. Zip layout: root has ONLY the launcher bats +
README.txt; everything else lives in `app\` so the extracted folder looks
simple. Split launchers: `Install.bat` = one-time, explicit-consent setup
(winget Node if missing + `npm install`); `Run-Tracker.bat` NEVER installs
anything — it refuses with "run Install.bat first" if Node/node_modules are
missing, else runs `npx tsx src/watch.ts`. `version.txt` feeds `H3_VERSION`
for the outdated-build check (`src/updateCheck.ts`).

Release asset must be named EXACTLY `h3-tracker-windows.zip` — the README's
`releases/latest/download/h3-tracker-windows.zip` link depends on it.

### .bat gotchas

ALL `.bat` files must be CRLF (cmd can't find `call :label` targets in LF
files; `.gitattributes` pins it, `bundle.bat` re-normalizes staged bats) and
must contain NO parentheses inside echo text (a `)` inside an if-block aborts
the script).
