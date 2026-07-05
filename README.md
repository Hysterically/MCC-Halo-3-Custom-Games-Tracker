<div align="center">

# Halo 3 Customs Tracker

**Automatic match tracking, TrueSkill 2 ratings, and a live Halo 5-style CSR
leaderboard for Halo 3 custom games in MCC — posted straight to Discord.**

[![Latest release](https://img.shields.io/github/v/release/Hysterically/MCC-Halo-3-Custom-Games-Tracker?label=release&color=4c9)](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d6)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)

</div>

The tracker reads the carnage report files Halo: MCC saves after each game — no
game hooks, no screen capture, and it never touches a Microsoft or Xbox
account. Every finished custom becomes a post-game carnage screen in Discord:

![Example match result](docs/img/example-match.png)

…and a single, always-current standings post ranks everyone with a Halo 5-style
CSR (Bronze through Onyx, with Champion for the top of the board):

![Example leaderboard](docs/img/example-leaderboard.png)

*Both images are actual tracker output, rendered from fictional players.*

## Contents

- [Who this is for](#who-this-is-for)
- [Features](#features)
- [The rank ladder](#the-rank-ladder)
- [How it works](#how-it-works)
- [Join an existing leaderboard](#join-an-existing-leaderboard)
- [Host your own leaderboard](#host-your-own-leaderboard)
- [Configuration reference](#configuration-reference)
- [Repository layout](#repository-layout)
- [Development](#development)

## Who this is for

Ever wished the games from customs night actually *counted*? Matchmaking got
ranks, stats, and a ladder to climb — your custom games, the ones you care
about, evaporated the moment the carnage screen faded. This tracker gives a
small community of friends the full ranked experience for the customs they
already play: **TrueSkill 2** — the rating model Halo 5's matchmaking
actually ran on, descended from the TrueSkill system that ranked you in
Halo 3 back on Xbox Live — doing the math underneath, and the **Halo 5 CSR
ladder** you already know (Bronze through Onyx, Champion at the top) as the
face of it. Grind for Onyx. Defend your Champion spot. Talk trash with
receipts — every kill, death, and rating point is on the board.

It's built for exactly one shape of group: a Discord of friends who get
together for Halo 3 customs regularly and want a persistent, competitive
leaderboard — **without changing how they play**. Nobody queues, nobody
reports scores, nobody fills in spreadsheets. You start a custom game like
always; one person in the lobby has the tracker running; the results and
standings show up in Discord on their own.

### Why not a queue bot like NeatQueue?

Queue bots such as [NeatQueue](https://www.neatqueue.com/) are excellent at
what they're built for — organized PUGs and tournaments — but they run the
match *through Discord*: every player joins the server, queues up via the
bot before each game, and when it ends the lobby goes back to Discord to
vote on who won. And because MCC has no public stats API, a bot can never
see the game itself — its MMR runs on those hand-reported wins and losses
alone.

This tracker inverts that. MCC already writes a full carnage report to disk
after every game, so the source of truth is the game itself:

| | **Halo 3 Customs Tracker** | **Queue bots (e.g. NeatQueue)** |
|---|---|---|
| Playing a match | Just join the lobby, like any customs night | Everyone queues through the bot in Discord first |
| Recording results | Automatic — parsed from MCC's own carnage reports | Players vote on / report the winner after each game |
| Stats | Full scoreboard: score, kills, assists, deaths, K/D | Win–loss only (MCC has no API for a bot to read) |
| Rating | TrueSkill 2 per player, from real match data | Bot MMR from reported outcomes |
| Per-player effort | None — one person in the lobby runs the tracker | Every player, every match |

If your group runs structured pick-up games with strangers, a queue bot is
the right tool. If your group just *plays customs* and wants those games to
feed a real ranking, this is.

## Features

- **Per-match carnage posts** — a rendered image of the post-game scoreboard
  (score, kills, assists, deaths) with each player's new CSR and rating change,
  plus a pre-match win-probability bar for rated team games.
- **Live 4v4 leaderboard** — one standings image, edited in place after every
  game, so the channel never fills with stale copies. Columns: CSR (with
  division emblem), W-L-D, win %, K/D, and peak CSR.
- **TrueSkill 2 ratings** — matches are rated with the TrueSkill 2 model and
  displayed on the familiar Halo 5 CSR ladder. Ranks rebuild deterministically
  from match history.
- **Slash commands** — `/leaderboard` and `/stats <player>` (with name
  autocomplete) answer on demand as rich embeds; admins get `/delete` (void a
  game) and `/exclude` (keep the post, drop it from the boards).
- **Weekly recap** — a Sunday-evening embed with games played, most active
  player, MVP by K/D, and the current board leaders.
- **Counted exactly once** — matches are deduplicated by the game's unique id,
  so several people can run the tracker in the same lobby safely.
- **Tiny friend install** — friends run a single self-contained
  `Run-Tracker.bat` (a zero-dependency Node 18+ watcher, plain readable source,
  no EXE). It uploads finished games through a write-only webhook and keeps
  itself up to date.
- **Local or shared storage** — SQLite on disk by default; point several hosts
  at one [Turso](https://turso.tech)/libSQL database for a single combined
  leaderboard.

## The rank ladder

CSR is a display of the underlying TrueSkill 2 rating (the conservative
`mu − 3σ` skill, scaled). Bronze through Diamond are split into sub-ranks 1–6
of 50 CSR each; Onyx shows the raw number. **Champion** is an accolade, not a
tier: up to the top 3 players on the board who are at or above 1600 CSR.

| <img src="assets/csr-bronze-3.png" height="44"><br>Bronze | <img src="assets/csr-silver-3.png" height="44"><br>Silver | <img src="assets/csr-gold-3.png" height="44"><br>Gold | <img src="assets/csr-platinum-3.png" height="44"><br>Platinum | <img src="assets/csr-diamond-3.png" height="44"><br>Diamond | <img src="assets/csr-onyx.png" height="44"><br>Onyx | <img src="assets/csr-champion.png" height="44"><br>Champion |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 0–299 | 300–599 | 600–899 | 900–1199 | 1200–1499 | 1500+ | top 3 at 1600+ |

## How it works

Two ingest paths feed one pipeline. The tracker host watches its own MCC
carnage folder directly, and (optionally) a private `#carnage-inbox` channel
that friends' watchers upload to — so the leaderboard stays current no matter
whose PC recorded the game.

```mermaid
flowchart LR
    subgraph friends["Friends' PCs"]
        X1["MCC writes<br/>mpcarnagereport*.xml"] --> W["watcher<br/>(Run-Tracker.bat)"]
    end
    W -- "write-only webhook" --> INBOX["#carnage-inbox<br/>(private channel)"]
    subgraph host["Tracker host (runs 24/7)"]
        X2["host's own<br/>MCC carnage folder"] --> PIPE
        INBOX --> PIPE["parse → record →<br/>TrueSkill 2 → render"]
    end
    PIPE --> RES["#game-results"]
    PIPE --> LB["#leaderboard<br/>(edited in place)"]
```

The watcher never touches the database; the host does all parsing, rating, and
posting, and reacts to each upload (✅ recorded / 🔁 duplicate / ⚠️ unusable)
so the watcher can tell the tracker is alive.

## Join an existing leaderboard

For players joining a group whose leaderboard is already hosted. Requirements:
Windows 10/11, Halo: MCC, Node.js 18+.

1. **Install Node.js** if you don't have it —
   [nodejs.org](https://nodejs.org) → the LTS installer, or download
   [`Install-Node.bat`](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases/latest/download/Install-Node.bat)
   and let it do the work. (The watcher is plain source code rather than an
   .exe — Node.js runs it, and you can open the file and read every line.)
2. **Download
   [`Run-Tracker.bat`](https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases/latest/download/Run-Tracker.bat)**
   and put it in its own folder anywhere. That single file is the whole
   install — nothing to extract.
3. **Add your group's upload settings** — ask whoever hosts the leaderboard
   for the group's inbox webhook line. (If your group shares a preconfigured
   copy of `Run-Tracker.bat` on Discord, it has the settings baked in already —
   grab that one and skip this step.)
4. **Double-click `Run-Tracker.bat`** whenever you play customs and leave the
   window open. Results appear in Discord on their own.

Good to know:

- One person in the lobby running it is enough — the match report lists
  everyone, and each game is counted exactly once.
- The only secret you hold is a write-only webhook URL; the watcher can't read
  the channel it posts to.
- The watcher keeps itself current: when a new version ships it offers the
  update in its own window (press <kbd>U</kbd> + <kbd>Enter</kbd>) — no
  re-downloading.

## Host your own leaderboard

The watcher only *feeds* a tracker — to run a leaderboard for your own group,
run the tracker host yourself. It's a Node/TypeScript app; the host machine
(or a cloud box) should stay up so the leaderboard does.

```sh
git clone https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker.git
cd MCC-Halo-3-Custom-Games-Tracker
npm install
cp .env.example .env   # then fill it in — see below
npm run watch
```

### Discord setup

1. Create two channels, **#game-results** and **#leaderboard**, and add a
   webhook to each (channel settings → Integrations → Webhooks). Put the two
   URLs in `.env` as `DISCORD_RESULTS_WEBHOOK_URL` and
   `DISCORD_LEADERBOARD_WEBHOOK_URL`.
2. *(Optional — slash commands.)* Create a bot application in the
   [Discord developer portal](https://discord.com/developers/applications),
   invite it to your server, and put its token in `.env` as
   `DISCORD_BOT_TOKEN` (plus `DISCORD_GUILD_ID` so commands register
   instantly). Only one host should run the bot.
3. *(Optional — friend uploads.)* Create a private **#carnage-inbox** channel
   the friends can't read, add a webhook there (this URL is what friends'
   watchers get), and set `H3_INBOX_CHANNEL_ID` in `.env`. The bot needs the
   **Message Content Intent** (developer portal → Bot) and View Channel, Read
   Message History, and Add Reactions permissions in that channel.

### Sharing one leaderboard across several hosts

Create a free database at [turso.tech](https://turso.tech) and put the same
`DB_URL` + `DB_AUTH_TOKEN` in every host's `.env`. Recording is atomic on the
match id, so overlapping hosts can't double-count a game.

### Running 24/7 on a server (auto-updating)

Hosting on a Linux box (Oracle Cloud, any VPS)? `sudo deploy/install.sh`
sets up systemd units that keep the tracker running across crashes and
reboots **and** auto-pull `main` every 5 minutes — pushing to GitHub is
deploying. See [deploy/README.md](deploy/README.md).

### Building the friend launchers

`bundle-watcher.bat` assembles the one-file installs from
`packaging/Run-Tracker.template.bat` + `watcher/watcher.mjs`:

- `dist\watcher-public\Run-Tracker.bat` — no settings baked in (this is the
  GitHub release asset),
- `dist\watcher-ready\Run-Tracker.bat` + `H3-Tracker.zip` — your group's
  webhook baked in, for pinning in your own Discord.

## Configuration reference

### Tracker host (`.env`, see `.env.example`)

| Variable | Purpose | Default |
|---|---|---|
| `MCC_CARNAGE_DIR` | Folder MCC writes `mpcarnagereport*.xml` to | `%USERPROFILE%\AppData\LocalLow\MCC\Temporary` |
| `DB_PATH` | Local SQLite database file | `./data/h3.db` |
| `DB_URL` | Shared libSQL/Turso URL for a combined multi-host leaderboard | local file DB |
| `DB_AUTH_TOKEN` | Auth token for the remote database | — |
| `DISCORD_RESULTS_WEBHOOK_URL` | `#game-results` webhook (per-match posts) | — (Discord posting off) |
| `DISCORD_LEADERBOARD_WEBHOOK_URL` | `#leaderboard` webhook (standings, edited in place) | — |
| `DISCORD_BOT_TOKEN` | Enables slash commands + admin buttons | — |
| `DISCORD_GUILD_ID` | Server to register slash commands in (instant instead of ~1 h) | — |
| `H3_INBOX_CHANNEL_ID` | `#carnage-inbox` channel id for friend uploads | — (local-folder only) |
| `H3_INBOX_BACKLOG_MESSAGES` | Inbox messages scanned on startup for missed uploads | `300` |
| `ALIASES_PATH` | Gamertag → display-name JSON | `./aliases.json` |
| `H3_BELL` | Ring the terminal bell on each new match | off |

### Friend watcher (`watcher.env`, see `watcher/watcher.env.example`)

| Variable | Purpose |
|---|---|
| `WEBHOOK_URL` | **Required.** The group's `#carnage-inbox` upload webhook (write-only). |
| `MCC_CARNAGE_DIR` | Override if MCC writes reports to a non-standard folder. |

## Repository layout

```
src/        the tracker host — watch, parse, rate (TrueSkill 2 → CSR),
            render PNGs, post to Discord, slash-command bot
watcher/    the friend install — zero-dependency watcher.mjs + launcher
packaging/  files bundled into the distributables (installers, launcher
            template, README.txt)
deploy/     systemd units + installer for a 24/7 auto-updating Linux host
assets/     rank emblems, podium medals, fonts used by the renderers
docs/       the example images above
```

## Development

```sh
npm run watch      # run the tracker (tsx, no build step)
npm run typecheck  # type-check before shipping
```

`src/sampleReports.ts` + `src/testPost.ts` (`npm run testpost`) post a sample
carnage image to your results webhook so renderer changes can be checked
without playing a match; `Test-Game.bat` drops a sample XML into a watched
folder to exercise the whole pipeline.
