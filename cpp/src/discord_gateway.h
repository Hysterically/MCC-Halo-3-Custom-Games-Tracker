// Discord Gateway bot (WebSocket): answers /leaderboard and /stats slash
// commands on demand (CSR ladder). Started in the background by the watcher when
// a bot token is configured. Mirrors the bot half of src/discord.ts.
#pragma once
#include "db.h"

// Starts the bot in a background thread if DISCORD_BOT_TOKEN is set; otherwise
// logs that slash commands are disabled. Returns immediately.
void startBotIfConfigured(Db& db);
