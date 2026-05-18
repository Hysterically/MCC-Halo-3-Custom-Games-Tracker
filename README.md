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

Building the **parser** against a real carnage report. Everything else (watch
→ dedupe → ELO → Discord) follows once the schema is locked.

## What I need from you (one file, no auth)

A single real `mpcarnagereport*.xml` from the **gaming PC**, where MCC writes
them (typically `%USERPROFILE%\AppData\LocalLow\MCC\Temporary\`, or the
Microsoft Store package path). Get it here either way:

- **Easiest:** copy one such file into OneDrive so it syncs to the dev PC, then
  drop it in `samples/`; **or**
- paste the file's contents into chat.

Then:

```powershell
cd C:\Users\Johann\h3-customs-tracker
npm install
npm run inspect            # newest xml in ./samples
# or, run ON the gaming PC against the live folder:
npm run inspect -- "C:\Users\<you>\AppData\LocalLow\MCC\Temporary"
```

`npm run inspect` prints the XML's structure. Paste that back and the exact
parser gets written (players, teams, scores, winner, map, mode, timestamp) —
then the watcher, ELO, and Discord bot.
