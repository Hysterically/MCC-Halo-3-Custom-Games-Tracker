# next/ — the new architecture (staging)

The coding half of `ARCHITECTURE-CHANGE.md`: friends run a tiny watcher,
Discord carries the files, the bot does everything. This folder is TEMPORARY —
it holds only the NEW code and imports the live modules from `src/`, so the
current tracker keeps working untouched while this is proven. When it's ready,
this becomes the main architecture.

## Layout

```
next/
  watcher/                 the whole friend install
    watcher.mjs            zero-dependency Node script (no npm install, no TS)
    watcher.env.example    copy to watcher.env, paste the group webhook URL
    Run-Watcher.bat        double-click launcher (checks Node 18+, restarts on exit)
  bot/                     host side — will replace `npm run watch`
    watch.ts               entry point: everything src/watch.ts does + the inbox
    inbox.ts               #carnage-inbox listener (backlog scan + live uploads)
    pipeline.ts            the ONE ingest path both local files and uploads take
    config.ts              src config + the inbox env vars
```

Run the bot side with `npm run watch:next`. With no inbox configured it
behaves exactly like `npm run watch`.

## How a game flows

1. MCC writes `mpcarnagereport*.xml`; the friend's `watcher.mjs` sees it,
   waits for the write to finish, and screens it with the same three checks
   the real parser uses (Halo 3, custom, completed).
2. The watcher looks up the map breadcrumbs (theater film + .mvar — they only
   exist on the friend's PC) and uploads the XML to #carnage-inbox via
   webhook, with a metadata line the bot parses:
   `` `h3meta {"v":1,"matchId":…,"playedAtMs":…,"mapName":…,"mapVariant":…}` ``
   (`playedAtMs` is the file mtime — the XML has no timestamp).
3. The bot downloads the attachment and runs the shared pipeline — identical
   to a local game: record (deduped on GameUniqueId) → CSR (TrueSkill 2) →
   post to #game-results → update #leaderboard.
4. The bot reacts on the upload: ✅ recorded · 🔁 duplicate · ⚠️ unusable.
   Unmarked messages are retried by the startup backlog scan, so the channel
   itself is the queue — nothing is lost while the bot is offline.

The watcher is live-only by choice: it does not scan old files on startup
(the MCC folder holds years of XMLs). Bot-side dedupe makes re-uploads
harmless either way.

## One-time setup still to do (needs Discord/server access)

- [ ] Create the private `#carnage-inbox` channel; friends must NOT have read
      access (uploads carry no secrets, but keep the queue clean).
- [ ] Create a webhook in that channel → that URL is the friends'
      `WEBHOOK_URL` in `watcher.env`.
- [ ] Discord dev portal → the bot's application → **Message Content Intent: ON**
      (the listener can't see attachments/content without it).
- [ ] Give the bot View Channel + Read Message History + Add Reactions in
      #carnage-inbox.
- [ ] Host `.env`: add `H3_INBOX_CHANNEL_ID=<channel id>`
      (optional: `H3_INBOX_BACKLOG_MESSAGES`, default 300).
- [ ] Test: run `npm run watch:next`, drop a sample XML into the channel by
      hand — it should get a ✅ and post results.

Not done here on purpose: the Python/rewritten TrueSkill (still
`src/trueskill2.ts`), the new `h3-watcher-windows.zip`, and any release —
per the plan, those come later.

## Promotion checklist (later)

- Move `next/bot/*` into `src/` (replace `src/watch.ts`), keep `watcher/` as
  the friends' distribution source.
- Fold the inbox client into `startBot`'s client (one gateway connection —
  it's two while src stays untouched).
- New tiny `h3-watcher-windows.zip` (watcher.mjs + Run-Watcher.bat +
  pre-filled watcher.env); retire the big tracker zip and Install.bat flow.
- Update CLAUDE.md + README, then release per the usual workflow.
