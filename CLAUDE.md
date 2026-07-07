# CLAUDE.md

> **⚠️ PENDING OWNER TASKS:** if `docs/WHEN-BACK-AT-PC.md` exists in this repo,
> read it FIRST and walk the owner through it before starting other work.
> (Once that checklist is completed it gets deleted, and this notice is moot.)

Halo 3 (MCC) custom-games tracker: watches `mpcarnagereport*.xml` files,
records matches, computes ELO + TrueSkill 2 CSR, and posts a leaderboard +
per-match results to Discord.

## Two pieces, one codebase

- **`src/`** — the tracker host, run with `tsx` (e.g. `npm run watch`). Runs
  from source at the repo root on the 24/7 host; the `deploy/` systemd units
  auto-pull `main` every 5 minutes, so pushing to GitHub is deploying.
- **`watcher/watcher.mjs`** — the friend install: a zero-dependency one-file
  watcher that uploads carnage reports to the group's `#carnage-inbox`
  webhook, which the tracker host reads.
- Type-check before shipping: `npm run typecheck`.

## Private files — never commit these

`.env`, `watcher/watcher.env`, `aliases.json`, `data/`, `CLAUDE.local.md` are
gitignored on purpose: they hold the owner's tokens, the group's real display
names, match history, and private maintainer notes. The public repo and the
owner's live install are the SAME repo — the separation exists only because
these files stay untracked. Never `git add -f` them, and never hardcode their
contents into `src/`.

`python/` is also gitignored, for a different reason: it's a from-scratch,
pure-stdlib Python implementation of the full TrueSkill 2 paper (a research
companion, not the live ladder — that runs on `src/trueskill2.ts`). It's held
local-only until its paper-accuracy audit is complete, then it will be
published. Don't `git add` it until then.

Owner-only operational notes (release publishing, Discord specifics) live in
`CLAUDE.local.md` on the owner's machines — Claude Code auto-reads it when
present.

## Distribution (v3: friends install the watcher, not the tracker)

`bundle-watcher.bat` (repo root) reads the group's webhook out of the
gitignored `watcher\watcher.env`, then runs `packaging/build-watcher.ps1` to
assemble single-file launchers from `packaging/Run-Tracker.template.bat` +
`watcher/watcher.mjs`:

- `dist\watcher-public\` — `Run-Tracker.bat` + `Install-Node.bat` with NO
  settings baked in: these are the GitHub release assets.
- `dist\watcher-ready\` — the same two with the webhook baked in, plus
  `H3-Tracker.zip` for pinning in the group's own Discord. Never publish
  these publicly — the webhook is a secret.

`Install-Node.bat` is the one-time, explicit-consent Node.js LTS setup;
`Run-Tracker.bat` never installs anything — it points at Install-Node.bat
when Node is missing or too old.

Release assets must be named EXACTLY `Run-Tracker.bat`, `Install-Node.bat`,
and `watcher.mjs` (the raw `watcher/watcher.mjs`). The README's
`releases/latest/download/...` links depend on the first two, and installed
watchers self-update by fetching `releases/latest/download/watcher.mjs` and
comparing versions (`UPDATE_URL` in `watcher.mjs`). Bump `WATCHER_VERSION`
in `watcher/watcher.mjs` when shipping watcher changes — without the bump,
installed watchers ignore the new file.

### .bat gotchas

ALL `.bat` files must be CRLF (cmd can't find `call :label` targets in LF
files; `.gitattributes` pins it) and must contain NO parentheses inside echo
text (a `)` inside an if-block aborts the script).
