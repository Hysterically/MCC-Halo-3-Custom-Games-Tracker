# Architecture Change — TLDR

**The plan: friends run a tiny watcher, Discord carries the files, the bot does everything.**

## Now

Every friend installs the whole tracker — Node, npm packages, ~6,700 lines of code, and the
shared database keys. Every update means everyone re-downloads a zip.

## Changing to

Friends run ONE small script (~200 lines, nothing to npm-install). It just watches the MCC
carnage folder and uploads each new game XML to a private Discord channel (#carnage-inbox)
through a webhook. The bot reads that channel and does all the real work: parse the XML,
record the match, compute CSR (TrueSkill 2), post to #game-results, update #leaderboard.

## Why

- No EXE, so no Windows Defender flags — it's a plain text script run by Node.
- Friends' zip contains no database credentials — only a write-only webhook URL.
- All future updates happen on the bot side only. Friends never download anything again.
- Discord is the queue: if the bot/PC is off, uploads wait in the channel and get processed
  when it's back. Nothing is ever lost, results just post later.
- On a friend's PC only MCC + the watcher need to run — and the watcher even catches up on
  games played while it was closed (recent-files window + dedupe by match id).

## How a game flows

MCC writes the XML → watcher uploads it (with played-time and map breadcrumbs) → bot
downloads, dedupes, rates, posts.

## Build steps (when we implement)

1. `watcher/watcher.js` — zero-dependency Node script friends run.
2. `src/inbox.ts` — bot listens to #carnage-inbox (needs Message Content intent toggle).
3. Shared pipeline so local files and inbox files are processed identically.
4. New tiny `h3-watcher-windows.zip` for friends.
5. One-time setup: create the channel + webhook, flip the intent in the dev portal.

## What doesn't change

The current tracker keeps working, the Turso DB stays, friends migrate whenever.
Later (optional): move the bot to an always-on server; retire old zips.
