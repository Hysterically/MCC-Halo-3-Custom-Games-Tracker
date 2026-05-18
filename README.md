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
                            dedupe -> ELO -> Discord leaderboard
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

- **ELO:** classic, team-average, zero-sum. Ratings are recomputed from the
  full match history every time (deterministic, retunable, no drift).
- **Storage:** SQLite (`./data/h3.db`). Players keyed by XUID so Gamertag
  changes don't split history.
- **Discord:** webhook auto-posts the board after each new match; an optional
  bot answers `/leaderboard` and `/stats`.

## Run it (on the gaming PC)

```powershell
npm install
copy .env.example .env     # optional — fill in Discord bits if you want them
npm run watch              # ingests existing reports, then watches live
```

Zero config works: with no `.env` it watches
`%USERPROFILE%\AppData\LocalLow\MCC\Temporary` and just keeps the local DB
(Discord disabled until you add a webhook URL / bot token).

### Scripts

| command | what it does |
|---|---|
| `npm run watch` | live watcher: parse → dedupe → store → ELO → Discord |
| `npm run backfill -- "<folder>"` | one-shot ingest a folder of old reports |
| `npm run board` | print current standings from the DB (no Discord) |
| `npm run inspect` | dump an XML's structure (schema discovery) |
| `npm run parse` | classify reports (which are tracked H3 customs) |
| `npm run typecheck` | `tsc --noEmit` |

See `.env.example` for all options (MCC folder, DB path, ELO K/start,
Discord webhook URL, bot token, guild ID).
