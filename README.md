# h3-customs-tracker

Tracks Halo 3 (MCC) custom games for a friends group and posts an ELO
leaderboard to Discord.

## Architecture (final)

MCC writes a full `mpcarnagereport*.xml` to disk after **every** match
(including customs) — every player's Gamertag, XUID, team, score, kills,
deaths, medals. So:

```
Gaming PC (host):
  MCC writes mpcarnagereport*.xml  ->  watcher parses it
                                        |
                                        v
                            dedupe -> per-category ELO
                                        |
                          +-------------+-------------+
                          v                           v
                #game-results post        #leaderboard (edited in place,
                (per-match summary)        2v2 / 4v4 / FFA sections)
```

**No Microsoft auth. No Spartan token. No web API. No third party.** Just read
local files. The watcher must run on a PC that played the match (the host's
machine is enough — the XML lists *all* players).

> The earlier Spartan-token/auth approach was removed — this is strictly
> simpler and more robust.

## Status

Pipeline complete: **parse → dedupe → SQLite → ELO → Discord**. Schema is
locked against a real Halo 3 report; the watcher, store, rating engine, and
Discord delivery are built and smoke-tested end to end.

- **ELO:** classic, team-average, zero-sum, recomputed from the full match
  history every time (deterministic, retunable, no drift). Ratings are
  **per category** — a player's 2v2, 4v4, and FFA ELO are independent, each
  computed only from that category's matches.
- **Storage:** SQLite (`./data/h3.db`). Players keyed by XUID so Gamertag
  changes don't split history.
- **Discord** splits into two channels:
  - **#game-results** — a per-match summary (gametype, teams or FFA, K/D/A,
    winner) posted after every new match.
  - **#leaderboard** — a single always-current message, edited in place,
    with separate **2v2 / 4v4 / FFA** standings sections.
  - An optional bot answers `/leaderboard` and `/stats` on demand.
- **Display aliases:** `aliases.json` maps a Gamertag to a preferred display
  name (e.g. `HystericaIly` → `Hysterically`) without rewriting any history —
  matches stay keyed by XUID, only the rendered label changes.

## Run it — for end users (no Node install required)

The recommended distribution path: `npm run bundle` produces
`h3-tracker-windows.zip` (~30 MB). Ship that to whoever's hosting.
Their flow:

1. Extract the zip.
2. Double-click **Start.bat**.
3. First time only: paste two Discord webhook URLs the wizard asks for.
4. Leave the window open while playing.

That's it — no terminal, no Node.js install, no `.env` editing.

Reconfiguring later: double-click **Setup.bat** to re-enter the URLs.

## Run it — from source (developers)

```powershell
npm install
copy .env.example .env     # optional — fill in Discord bits if you want them
npm run watch              # live watcher
```

### Scripts

| command | what it does |
|---|---|
| `npm run watch` | live watcher: parse → dedupe → store → ELO → Discord |
| `npm run setup` | interactive `.env` wizard (also runs as first-launch from Start.bat) |
| `npm run announce` | force-refresh the live leaderboard message |
| `npm run backfill -- "<folder>"` | one-shot ingest a folder of old reports |
| `npm run board` | print current standings to the console |
| `npm run bundle` | build the Windows distribution zip |
| `npm run inspect` | dump an XML's structure (schema discovery) |
| `npm run parse` | classify reports (which are tracked H3 customs) |
| `npm run typecheck` | `tsc --noEmit` |

See `.env.example` for all options (MCC folder, DB path, ELO K/start,
Discord webhook URLs, bot token, guild ID).

To customize how a name shows on the board, create `aliases.json` (or point
`ALIASES_PATH` elsewhere) mapping in-game Gamertag → display name:

```json
{ "HystericaIly": "Hysterically" }
```

Matching is case-insensitive; unknown names render as-is. The file is read
once per run, so edits take effect on the next start.

## Important: one tracker PC per group

Each install has its own local SQLite DB. The architecture assumes a
single "tracker PC" (whoever hosts most often). If two people run the
tracker during the same game you get duplicate Discord posts and
divergent leaderboards. Pick one host. Multi-PC sync would need a
shared DB — out of scope for the current design.
