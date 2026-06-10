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
- **Storage:** libSQL / SQLite. Defaults to a local file (`./data/h3.db`);
  point `DB_URL` at a shared remote libSQL/Turso DB to run several PCs at once
  (see [Running on more than one PC](#running-on-more-than-one-pc)). Players
  keyed by XUID so Gamertag changes don't split history.
- **Discord** splits into two channels:
  - **#game-results** — a rendered carnage-screen image (styled after Halo 3's
    post-game screen: team-coloured rows with Score / Kills / Assists / Deaths)
    posted after every new match, with map + leaderboard-category caption.
    Falls back to a text summary if rendering fails.
  - **#leaderboard** — a single always-current message, edited in place,
    with separate **2v2 / 4v4 / FFA** standings sections.
  - An optional bot answers `/leaderboard` and `/stats` on demand.
    `/stats <player>` shows that player's ELO, rank, W-L-D, Win% and K/D in
    each category (2v2 / 4v4 / FFA) plus an overall line; `/stats` with no
    player just reports how many matches are recorded.
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

See `.env.example` for all options (MCC folder, DB path/URL, ELO K/start,
Discord webhook URLs, bot token, guild ID).

## Running on more than one PC

By default each install has its own local SQLite DB, so the design assumes a
single "tracker PC" — if two people ran it with separate local DBs during the
same game, each would post the same match independently and maintain its own
diverging leaderboard.

To run the tracker on two or more PCs at once (e.g. for failover, or because
different people host on different nights), point every PC at **one shared
remote DB** via `DB_URL` (+ `DB_AUTH_TOKEN`). The shared DB then acts as a
**cross-instance guard**:

- **No duplicate posts.** A match is recorded inside a write transaction with
  `INSERT … ON CONFLICT(match_id) DO NOTHING`. Whichever instance's insert
  actually creates the row owns that match and posts it to Discord; every other
  instance that later sees the same `GameUniqueId` gets "already recorded" and
  stays silent. The claim is atomic, so it holds even if two PCs finish the
  same match at the same instant.
- **One shared leaderboard.** The leaderboard message id lives in the shared DB
  and is edited in place, so all instances update the same message instead of
  each posting their own. ELO is computed from the single canonical history, so
  the board is correct no matter which PC posts it.

Setup: create a free DB at [turso.tech](https://turso.tech), then set
`DB_URL=libsql://…` and `DB_AUTH_TOKEN=…` in each PC's `.env`. A solo user
needs none of this — leaving `DB_URL` unset uses the local file as before.

### Migrating an existing local DB

The store switched from `better-sqlite3` to libSQL (same on-disk SQLite
format, so existing `data/h3.db` files are read as-is). When upgrading a
running install, **stop the old watcher before starting the new one** so its
write-ahead log is flushed into `h3.db` on a clean shutdown.
