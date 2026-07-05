# Halo 3 Customs Tracker

Plays Halo 3 custom games with us in MCC? This tracker watches your games and
posts the results to **our shared Discord leaderboard** automatically.

- **After every match** — a picture of the post-game carnage screen (scores,
  kills, deaths) in the results channel.
- **The live leaderboard** — one always-up-to-date standings post with separate
  **2v2 / 4v4 / FFA** rankings, updated after every game.
- Type `/leaderboard` or `/stats` in Discord to check standings on demand —
  with name autocomplete, and answers shown as clean rich embeds.
- **A weekly recap** posts on Sunday evenings: games played, most active player,
  MVP, and the current category leaders.

The tracker itself runs **24/7 in the cloud** — the leaderboard stays online no
matter whose PC is on. The only thing you run is the **watcher**: one small
script that notices when a custom ends and sends the match report in. It works
by reading the report files MCC saves on your PC after each game. No logins,
no passwords, nothing to sign up for — it never touches your Microsoft or
Xbox account.

## How to use it (no technical skills needed)

1. **Install Node.js** if you don't have it (free, official, one time):
   [nodejs.org](https://nodejs.org) → the green **LTS** button → next, next,
   finish. The watcher is plain source code rather than an .exe — Node.js is
   the program that runs it, and you can open the file to read every line.
2. **[⬇ Download Run-Watcher.bat](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases/latest/download/Run-Watcher.bat)**
   and put it in its own folder anywhere. That single file is the whole
   install — no zip, nothing to extract.
3. **Ask Hysterically for the group settings** — one line that connects your
   watcher to *our* leaderboard. (Playing with us on Discord? The copy pinned
   in the download channel has it baked in already — grab that one and skip
   this step.)
4. Double-click **`Run-Watcher.bat`** whenever you play customs and leave the
   window open. Results appear in Discord on their own.

**Requirements:** Windows 10/11, Halo: MCC, and Node.js 18 or newer.

**Good to know:**

- One person in the lobby running it is enough — the match report lists
  everyone, and each game is counted exactly once.
- The watcher keeps itself current: when a new version ships it offers the
  update in its own window (press <kbd>U</kbd> + <kbd>Enter</kbd>) — no
  re-downloading.

## Hosting your own leaderboard

The watcher only *feeds* a tracker. To run a leaderboard for a different
group, clone this repo and run the tracker host yourself (`npm install`, then
`npm run watch`) with your own Discord bot and channels — the source in
[src/](src/) is the reference for configuration.
