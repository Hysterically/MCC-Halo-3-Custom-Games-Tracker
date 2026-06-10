# Halo 3 Customs Tracker — native C++ port

A from-scratch C++20 rewrite of the TypeScript tracker that compiles to a single,
self-contained **`h3-tracker.exe`** (~2.6 MB) — no Node.js, no DLLs, no Visual C++
redistributable, and no CA cert bundle. A layman extracts the zip and double-clicks
`Start.bat`.

It is feature-complete against the Node app: the live folder watcher, deterministic
team-average ELO, the local **and** shared remote (libSQL/Turso) database with the
same cross-instance "record exactly once" dedupe, Discord result/leaderboard
webhooks, and the gateway bot (`/leaderboard`, `/stats`).

## Building

Requires Visual Studio 2022 (Desktop C++ workload — ships CMake, Ninja, and vcpkg).

```bat
build.bat      :: configure + compile  -> build\bin\h3-tracker.exe
bundle.bat     :: build + assemble the flat release zip -> dist\h3-tracker-windows.zip
```

The first `build.bat` bootstraps vcpkg dependencies (pugixml, sqlite3, nlohmann-json,
curl[websockets] on Schannel) into `build\vcpkg_installed`. Everything links statically
via the `x64-windows-static` triplet + static CRT.

## Commands

```
h3-tracker            watch (default) — live-track the MCC carnage folder
h3-tracker setup      first-time Discord setup wizard (writes .env)
h3-tracker backfill   bulk-ingest a folder of carnage reports
h3-tracker board      print the current standings
h3-tracker announce   force-refresh the Discord leaderboard
h3-tracker clear      wipe all matches
h3-tracker parse      classify which reports would be tracked
h3-tracker inspect    dump XML structure (debug)
```

Diagnostics (not advertised in the help): `show <xml>`, `ping-webhook [url]`,
`curl-info`, `gw-probe`.

## Source map (mirrors the TS `src/`)

| C++ | Role | TS origin |
|---|---|---|
| `config.*` | `.env` + defaults, `%LOCALLOW%` resolution | `config.ts` |
| `carnage.*` | pugixml parse → `CarnageReport`, winner logic | `parseCarnage.ts` |
| `elo.*` | deterministic team-average ELO | `elo.ts` |
| `category.h` | 2v2 / 4v4 / ffa / other | `category.ts` |
| `aliases.*` | Gamertag → display map | `aliases.ts` |
| `format.*` | leaderboard + per-match text | `discord.ts` (formatters) |
| `db.h` / `db_sqlite.*` / `db_hrana.*` | storage interface + local + remote (Hrana) | `db.ts` |
| `http.*` | libcurl/Schannel wrapper | — |
| `discord_webhook.*` | result post + leaderboard upsert | `discord.ts` (webhooks) |
| `discord_gateway.*` | WebSocket bot (curl wss) | `discord.ts` (bot) |
| `watcher.*` | `ReadDirectoryChangesW` + awaitWriteFinish | `watch.ts` |
| `setup.*` | first-launch wizard | `setup.ts` |
| `cli.cpp` / `main.cpp` | subcommand dispatch | per-script tools |

## Parity

Verified byte-for-byte against the Node app: `board` and `formatMatchResult` produce
identical output (matching MD5s), and the remote libSQL dedupe is wire-compatible —
running the Node and C++ apps against the same Turso DB records each match exactly once.
