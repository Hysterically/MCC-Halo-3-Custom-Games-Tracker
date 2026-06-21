# Halo 3 Customs Tracker

Plays Halo 3 custom games with us in MCC? This  program watches your
games and posts the results to **our shared Discord leaderboard**
automatically. 

- **After every match** — a picture of the post-game carnage screen (scores,
  kills, deaths) in the results channel.
- **The live leaderboard** — one always-up-to-date standings post with separate
  **2v2 / 4v4 / FFA** rankings, updated after every game.
- Type `/leaderboard` or `/stats` in Discord to check standings on demand —
  with name autocomplete, and answers shown as clean rich embeds.
- **A weekly recap** posts on Sunday evenings: games played, most active player,
  MVP, and the current category leaders.

It works by reading the match report files MCC saves on your PC after each game.
No logins, no passwords, nothing to sign up for — it never touches your
Microsoft or Xbox account.

## How to use it (no technical skills needed)

1. **[⬇ Download the tracker (zip)](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases/latest/download/h3-tracker-windows.zip)**
2. Right-click the zip → **Extract All** → put the folder anywhere you like.
3. **Ask Hysterically for the group settings file (`.env`)** and drop it into
   that folder. This is what connects you to *our* shared leaderboard and
   Discord channels — it's sent privately, never posted publicly.
4. Double-click **`Start.bat`**.
5. That's it. Leave the window open while you play customs; results appear in
   Discord on their own. Don't worry about doubling up — even if several of us
   run the tracker during the same game, each match is counted exactly once.

**Requirements:** Windows 10/11 and Halo: MCC. Nothing to install — the zip is
a single small program (~1 MB).

**Important:** the tracker only sees games that *your* PC played in. One person
in the lobby running it is enough (the match report lists everyone), so
whoever hosts the customs should have it running.

## Common questions

**Does everyone need to run it?**
No — one PC in the lobby is enough, and it doesn't hurt if several people run
it. The shared database makes sure every match is recorded exactly once, on one
combined leaderboard.


- **Several hosts, one leaderboard:** create a free database at
  [turso.tech](https://turso.tech) and set `DB_URL=libsql://…` and
  `DB_AUTH_TOKEN=…` on every host's PC.
- **`/leaderboard` and `/stats` commands:** set `DISCORD_BOT_TOKEN=…` and
  `DISCORD_GUILD_ID=…` (the guild id makes the commands show up instantly). The
  bot also adds **Void / Exclude buttons** under each result post (admins only)
  and posts the weekly recap — no extra setup beyond the token.

---

