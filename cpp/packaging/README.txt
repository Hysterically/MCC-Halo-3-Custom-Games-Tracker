Halo 3 Customs Tracker
======================

What this does
--------------
Watches your Halo MCC custom games and automatically posts each match result and
an ELO leaderboard to Discord.

Quick start
-----------
1. Double-click  Start.bat
2. The first time, it asks for two Discord "webhook" URLs (and explains how to
   make them in Discord):
     - one for a #game-results channel (a summary after every match)
     - one for a #leaderboard channel (a single, always-updated standings post)
   You can type 'skip' for either and set it later.
3. Leave the window open while you play. New matches show up on their own.

To change your Discord settings later, double-click  Setup.bat

Files in this folder
--------------------
  h3-tracker.exe   the tracker itself (one file, nothing to install)
  Start.bat        run the tracker
  Setup.bat        re-run the Discord setup
  README.txt       this file
  aliases.json     optional: change how player names appear on the leaderboard
  .env             your saved settings (created automatically on first run)
  data\h3.db       your match history (created automatically)

Nothing else is required - no Node.js, no runtime, no installer.

Optional: one shared leaderboard across several PCs
---------------------------------------------------
By default everything stays on this PC. To share a single leaderboard between
multiple PCs, open .env in Notepad and set:
  DB_URL=libsql://your-database.turso.io
  DB_AUTH_TOKEN=your-token
Every PC pointed at the same URL contributes to one combined leaderboard, and a
match is posted exactly once no matter how many PCs see it.

Optional: live /leaderboard and /stats commands
------------------------------------------------
Add a Discord bot token to .env to answer slash commands on demand:
  DISCORD_BOT_TOKEN=your-bot-token
  DISCORD_GUILD_ID=your-server-id     (optional; makes commands appear instantly)

Player name aliases
-------------------
Open aliases.json in Notepad to change how a gamertag is shown, e.g.:
  { "HystericaIly": "Hysterically" }
Matching is case-insensitive and only changes the display, not the saved history.

Where matches come from
-----------------------
The tracker reads Halo MCC's carnage reports from:
  %USERPROFILE%\AppData\LocalLow\MCC\Temporary
If your MCC writes them elsewhere, set MCC_CARNAGE_DIR in .env.
