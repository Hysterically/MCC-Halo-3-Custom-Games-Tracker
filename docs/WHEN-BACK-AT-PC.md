# TODO when back at a real PC

Reminder file written from phone. Work through it top to bottom, then delete it
(last step). Context: the branch `claude/github-sync-multiple-versions-gvbkc9`
makes the public repo safe to push to from the live install — it stops tracking
the owner-local files (`CLAUDE.md`, `aliases.json`) and gitignores them, so the
private Oracle/Discord version and the public GitHub version are the same repo,
just with private files that never get committed.

## 1. Merge the branch into main

On GitHub: open a pull request from `claude/github-sync-multiple-versions-gvbkc9`
into `main` and merge it. (Or locally: `git checkout main && git merge
claude/github-sync-multiple-versions-gvbkc9 && git push origin main`.)

## 2. Update the live install (Oracle server) — back up first!

The merge *deletes* `CLAUDE.md` and `aliases.json` from git tracking. When the
server pulls it, git will remove/complain about the local copies. So:

```bash
cd <tracker repo on the server>
cp aliases.json ../aliases.json.bak
cp CLAUDE.md ../CLAUDE.md.bak        # if it exists here
git pull origin main
cp ../aliases.json.bak aliases.json
cp ../CLAUDE.md.bak CLAUDE.md
```

After this, both files are gitignored — git will never touch or commit them
again. Restart the tracker if it was running.

## 3. Sanity-check the separation

```bash
git status          # should say clean — no aliases.json, no CLAUDE.md, no .env, no data/
git check-ignore -v aliases.json CLAUDE.md .env data
```

If `git status` shows any of the private files as changes, stop and fix
`.gitignore` before committing anything.

## 4. Rebuild + repost the Discord zip (if the group needs the new build)

The branch also changed packaging (`bundle-watcher.bat`, `packaging/`,
`watcher/`). From the Windows PC:

```
bundle.bat vX.Y.Z
```

then post `dist\h3-tracker-windows.zip` to Discord as usual. The zip ships a
neutral `aliases.json` and no `.env`, so it stays clean automatically.

## 5. Going forward — the routine

- Edit code in the server clone (or PC clone), commit, `git push origin main`.
  That's it — one codebase, no version juggling.
- Anything private goes in `.env`, `watcher/watcher.env`, `aliases.json`, or
  `data/` — never hardcoded in `src/`. Those files never leave the machine.
- The Discord zip is a build output of the same code, not a separate version.

## 6. Optional: scrub old history

The old `CLAUDE.md` / `aliases.json` are still visible in git history on
GitHub (removing a file doesn't rewrite old commits). Today's contents are
harmless, so this is optional — but if you ever want them gone completely,
that's a `git filter-repo` + force push job.

## 7. Delete this file

```bash
git rm docs/WHEN-BACK-AT-PC.md && git commit -m "Done with the PC checklist" && git push
```
