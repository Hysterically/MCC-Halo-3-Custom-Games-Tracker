Halo 3 Customs Tracker
======================

What this does
--------------
Watches your Halo MCC custom games and automatically posts each match result
and the group's shared CSR leaderboard (a Halo 5-style rank, Bronze to Onyx)
to Discord. There is one leaderboard for everyone - no matter whose PC records
a match, it feeds the same standings.

Quick start - joining the group's shared leaderboard
----------------------------------------------------
1. Put the group's settings file (.env) next to Run-Tracker.bat. Ask the person who
   runs the leaderboard for it - it's shared privately (a Discord DM is fine),
   never posted publicly.
2. Double-click  Install.bat  - one time only. It tells you what it's about
   to set up (Node.js if missing, plus the tracker's packages), takes a
   minute or two, and can start the tracker for you when it's done.
3. From then on, double-click  Run-Tracker.bat  and leave the window open
   while you play. New matches show up on their own. It's fine if several
   people run the tracker during the same game - every match is counted
   exactly once.

Quick start - setting up your own, separate leaderboard
-------------------------------------------------------
1. Double-click  Install.bat  (one time).
2. Double-click  Setup.bat  - it asks for two Discord "webhook" URLs (and
   explains how to make them in Discord):
     - one for a #game-results channel (a summary after every match)
     - one for a #leaderboard channel (a single, always-updated standings post)
   You can type 'skip' for either and set it later.
3. Double-click  Run-Tracker.bat  and leave the window open while you play.

To change your Discord settings later, double-click  Setup.bat

Updating to a new version
-------------------------
Download the latest .zip, extract it to a fresh folder, put your .env next
to Run-Tracker.bat (or keep the old folder's app\.env), and run Install.bat
once - it's quick when Node.js is already there. Your ranks rebuild from
match history automatically.

Where your matches are saved
----------------------------
If your .env points at the group's shared online database (DB_URL=...), every
match is recorded there - that's what makes it one combined leaderboard for
everyone. Without a DB_URL, matches are saved to a local file on this PC
(app\data\h3.db) and you get your own standalone leaderboard.

Files in this folder
--------------------
  Install.bat      one-time setup - installs Node.js if missing + packages
  Run-Tracker.bat  run the tracker (never installs anything itself)
  Setup.bat        re-run the Discord setup
  README.txt       this file
  app\             the tracker itself - you never need to open this folder
                   (source code, settings (.env), version, local match
                   history, and the packages Install.bat downloads)

Requirements: Windows 10 or 11. Install.bat installs Node.js for you if it's
missing (or grab it yourself from https://nodejs.org if the automatic install
doesn't work).

Running your own leaderboard on several PCs
-------------------------------------------
If you set up your own leaderboard and want several hosts to share it, create
a free database at turso.tech, then put these in every host's .env:
  DB_URL=libsql://your-database.turso.io
  DB_AUTH_TOKEN=your-token

Optional: live /leaderboard and /stats commands
------------------------------------------------
One PC in the group (normally whoever runs the leaderboard) can add a Discord
bot token to .env to answer slash commands on demand:
  DISCORD_BOT_TOKEN=your-bot-token
  DISCORD_GUILD_ID=your-server-id     (optional; makes commands appear instantly)
Only one PC should run the bot - don't add the token on every machine.

Where matches come from
-----------------------
The tracker reads Halo MCC's carnage reports from:
  %USERPROFILE%\AppData\LocalLow\MCC\Temporary
If your MCC writes them elsewhere, set MCC_CARNAGE_DIR in .env.
