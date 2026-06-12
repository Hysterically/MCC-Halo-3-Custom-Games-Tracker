# Halo 3 Customs Tracker

Plays Halo 3 custom games with your friends in MCC? This little program watches
your games and posts the results to your Discord server automatically:

- **After every match** — a picture of the post-game carnage screen (scores,
  kills, deaths) in your results channel.
- **A live leaderboard** — one always-up-to-date standings post with separate
  **2v2 / 4v4 / FFA** rankings, updated after every game.
- **Optional**: type `/leaderboard` or `/stats` in Discord to see standings on
  demand.

It works by reading the match report files MCC saves on your PC after each game.
No logins, no passwords, nothing to sign up for — it never touches your
Microsoft or Xbox account.

## How to use it (no technical skills needed)

1. **[⬇ Download the tracker (zip)](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/raw/main/cpp/dist/h3-tracker-windows.zip)**
2. Right-click the zip → **Extract All** → put the folder anywhere you like.
3. Double-click **`Start.bat`**.
4. The first time, it asks for two Discord "webhook" URLs — one for match
   results, one for the leaderboard — **and walks you through creating them**
   (it's about four clicks in Discord). You can type `skip` and add them later.
5. That's it. Leave the window open while you play customs; results appear in
   Discord on their own.

To change your Discord settings later, double-click **`Setup.bat`**.

**Requirements:** Windows 10/11 and Halo: MCC. Nothing to install — the zip is
a single small program (~1 MB).

**Important:** the tracker only sees games that *your* PC played in. One person
in the lobby running it is enough (the match report lists everyone), so the
usual setup is: whoever hosts the customs runs the tracker.

## Common questions

**Does everyone need to run it?**
No — one PC in the lobby is enough. If different people host on different
nights, see "one leaderboard across several PCs" below.

**A player's name looks wrong on the leaderboard.**
Open `aliases.json` (in the tracker folder) with Notepad and add a line like
`"TheirGamertag": "Display Name"`. It only changes how the name is shown.

**Where does my data go?**
Match history is saved in a small file on your PC (`data\h3.db`). Nothing is
uploaded anywhere except the posts to your own Discord server.

**Can two or more hosts share one leaderboard?**
Yes. Create a free database at [turso.tech](https://turso.tech), then put its
URL and token into each host's `.env` file (in the tracker folder):

```
DB_URL=libsql://your-database.turso.io
DB_AUTH_TOKEN=your-token
```

Every PC pointed at the same database feeds one combined leaderboard, and each
match is only posted once no matter how many of you were in the game.

**How do I get the `/leaderboard` and `/stats` commands?**
Add a Discord bot token to `.env`:

```
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-server-id    (optional — makes the commands show up instantly)
```

**MCC saves its files somewhere unusual on my PC.**
The tracker reads `%USERPROFILE%\AppData\LocalLow\MCC\Temporary`. If yours
differs, set `MCC_CARNAGE_DIR` in `.env`.

---

## For developers

Everything below this line is only relevant if you want to work on the tracker
itself.

### How it works

MCC writes a full `mpcarnagereport*.xml` after **every** match (including
customs): every player's Gamertag, XUID, team, score, kills, deaths, medals.

```
MCC writes mpcarnagereport*.xml  ->  watcher parses it
                                      |
                                      v
                          dedupe -> per-category ELO
                                      |
                        +-------------+-------------+
                        v                           v
              #game-results post        #leaderboard (edited in place,
              (carnage-screen PNG)       2v2 / 4v4 / FFA sections)
```

- **ELO:** classic, team-average, zero-sum, recomputed from the full match
  history every time (deterministic, retunable, no drift). Ratings are
  per-category — 2v2, 4v4, and FFA ELO are independent.
- **Storage:** libSQL / SQLite. Local file by default; point `DB_URL` at a
  shared Turso DB to run several PCs at once. A match is claimed inside a write
  transaction (`INSERT … ON CONFLICT(match_id) DO NOTHING`), so exactly one
  instance posts it even if several finish the same game simultaneously. The
  leaderboard message id lives in the shared DB, so all instances edit the same
  Discord message. Players are keyed by XUID so Gamertag changes don't split
  history.

### Two implementations

| | Role |
|---|---|
| `src/` (TypeScript) | reference implementation; what the maintainer runs from source |
| `cpp/` (C++20) | **the distributed build** — single self-contained `h3-tracker.exe` |

The C++ port is parity-verified against the TS app (identical `board` output,
wire-compatible shared-DB dedupe — see [cpp/README.md](cpp/README.md)).
**New features must be implemented in both.**

### TypeScript: run from source

```powershell
npm install
copy .env.example .env     # optional — fill in Discord bits if you want them
npm run watch              # live watcher
```

| command | what it does |
|---|---|
| `npm run watch` | live watcher: parse → dedupe → store → ELO → Discord |
| `npm run setup` | interactive `.env` wizard |
| `npm run announce` | force-refresh the live leaderboard message |
| `npm run backfill -- "<folder>"` | one-shot ingest a folder of old reports |
| `npm run board` | print current standings to the console |
| `npm run inspect` | dump an XML's structure (schema discovery) |
| `npm run parse` | classify reports (which are tracked H3 customs) |
| `npm run typecheck` | `tsc --noEmit` |

See `.env.example` for all options (MCC folder, DB path/URL, ELO K/start,
Discord webhook URLs, bot token, guild ID).

### C++: build the distribution zip

Requires Visual Studio 2022 (Desktop C++ workload). See
[cpp/README.md](cpp/README.md) for details.

```bat
cpp\build.bat      :: configure + compile -> cpp\build\bin\h3-tracker.exe
cpp\bundle.bat     :: assemble cpp\dist\h3-tracker-windows.zip
```

The zip is committed to the repo so end users can download it straight from
GitHub — **rebuild and re-commit it whenever tracker behaviour changes.**
