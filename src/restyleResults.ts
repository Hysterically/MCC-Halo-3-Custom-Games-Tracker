/**
 * One-off maintenance: force a re-style of every #game-results post to the
 * current carnage layout, editing each message in place. This is the manual,
 * version-ignoring counterpart to the automatic startup heal (see heal.ts):
 * the watcher heals only posts behind RESULTS_FMT_VERSION, whereas this re-does
 * all of them — handy right after a format change to refresh the channel now
 * instead of waiting for instances to restart.
 *
 *   npm run restyle            -- dry run: report what would be touched
 *   npm run restyle -- --apply -- adopt orphan posts + re-style everything
 *
 * Posts made by an older build have no stored message id; they are recovered
 * from channel history (needs the bot token) and adopted into the DB, exactly
 * like the startup heal's Tier B. See heal.ts for the full mechanism.
 */

import { config } from "./config.ts";
import { openDb, matchCount, resultsRestyleTargets } from "./db.ts";
import { fetchWebhookMessages, healStaleResults, snowflakeMs } from "./heal.ts";

const APPLY = process.argv.includes("--apply");

if (!config.discordResultsWebhookUrl) {
  console.error("No DISCORD_RESULTS_WEBHOOK_URL configured — set it in .env first.");
  process.exit(1);
}
if (!config.discordBotToken) {
  console.error("No DISCORD_BOT_TOKEN configured — it's needed to read channel history.");
  process.exit(1);
}

const db = await openDb(config.dbUrl, config.dbAuthToken);

if (!APPLY) {
  // Dry run: how many posts the webhook made, how many matches are id-tracked.
  const messages = await fetchWebhookMessages(
    config.discordResultsWebhookUrl,
    config.discordBotToken,
  );
  const tracked = await resultsRestyleTargets(db, 0, true);
  console.log(`[db] ${await matchCount(db)} matches recorded`);
  console.log(`[discord] ${messages.length} posts by the results webhook`);
  console.log(`[db] ${tracked.length} matches already have a stored message id`);
  console.log(
    `\nDry run. Re-run with --apply to adopt any orphan posts and re-style all ${messages.length} posts.`,
  );
  console.log(`(oldest post: ${new Date(snowflakeMs(messages[0]?.id ?? "0")).toISOString().slice(0, 16)})`);
} else {
  const { adopted, restyled, gone } = await healStaleResults(db, {
    force: true,
    log: (m) => console.log(`[restyle] ${m}`),
  });
  console.log(
    `\nDone: adopted ${adopted}, re-styled ${restyled}${gone ? `, ${gone} had vanished` : ""}.`,
  );
}

db.close();
