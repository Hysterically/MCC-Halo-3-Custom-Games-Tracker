# Halo 3 Customs Tracker

Plays Halo 3 custom games with us in MCC? This little program watches your
games and posts the results to **our shared Discord leaderboard**
automatically. There's **one leaderboard for everyone** — no matter whose PC
records a match, it all feeds the same standings:

- **After every match** — a picture of the post-game carnage screen (scores,
  kills, deaths) in the results channel.
- **The live leaderboard** — one always-up-to-date standings post with separate
  **2v2 / 4v4 / FFA** rankings, updated after every game.
- Type `/leaderboard` or `/stats` in Discord to check standings on demand.

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

**A player's name looks wrong on the leaderboard.**
Open `aliases.json` (in the tracker folder) with Notepad and add a line like
`"TheirGamertag": "Display Name"`. It only changes how the name is shown.

**Where does my data go?**
Matches go into the group's shared database (that's what makes it one
leaderboard for everyone) and the posts go to our Discord server. Nothing else
leaves your PC.

**Why shouldn't I share the `.env` file?**
It contains the keys to the group's leaderboard database and Discord channels —
anyone who has it can post there. Pass it around privately (a Discord DM is
fine), just never post it somewhere public.

**MCC saves its files somewhere unusual on my PC.**
The tracker reads `%USERPROFILE%\AppData\LocalLow\MCC\Temporary`. If yours
differs, set `MCC_CARNAGE_DIR` in `.env`.

**I'm not in this group — can I run my own leaderboard with this?**
Yes, everything is self-serve. Skip the `.env` step: on first launch the
tracker walks you through creating two Discord webhooks for your own server
(about four clicks each; `Setup.bat` re-runs this anytime). That gives your
group its own leaderboard, stored on your PC. Optional extras in `.env`:

- **Several hosts, one leaderboard:** create a free database at
  [turso.tech](https://turso.tech) and set `DB_URL=libsql://…` and
  `DB_AUTH_TOKEN=…` on every host's PC.
- **`/leaderboard` and `/stats` commands:** set `DISCORD_BOT_TOKEN=…` and
  `DISCORD_GUILD_ID=…` (the guild id makes the commands show up instantly).

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

The zip is distributed via [GitHub Releases](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases)
(the README's download link always points at the latest release) — **rebuild
the zip and publish a new release whenever tracker behaviour changes.**
