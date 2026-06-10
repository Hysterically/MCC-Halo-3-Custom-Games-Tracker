// Discord Gateway bot (WebSocket): answers /leaderboard and /stats slash
// commands on demand. Started in the background by the watcher when a bot token
// is configured. Mirrors the bot half of src/discord.ts. Implemented in
// Phase 5 (discord_gateway.cpp); until then cli.cpp provides a stub.
#pragma once
#include "db.h"
#include "elo.h"

// Starts the bot in a background thread if DISCORD_BOT_TOKEN is set; otherwise
// logs that slash commands are disabled. Returns immediately.
void startBotIfConfigured(Db& db, EloOptions elo);
