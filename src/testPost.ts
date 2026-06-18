/**
 * Dev tool: post one SAMPLE carnage image (with the CSR column) to the
 * configured results webhook so the new image post can be checked in Discord
 * without playing a match. Nothing is written to the DB; just delete the
 * Discord message afterwards.
 *
 *   npm run testpost
 */

import { config } from "./config.ts";
import { postCsrMatchResult } from "./discord.ts";
import { sampleTeam, sampleCsrChanges } from "./sampleReports.ts";

if (!config.discordResultsWebhookUrl) {
  console.error("No DISCORD_RESULTS_WEBHOOK_URL in .env — nothing to post to.");
  process.exit(1);
}

await postCsrMatchResult(config.discordResultsWebhookUrl, sampleTeam, sampleCsrChanges(sampleTeam));
console.log("Posted a sample carnage image to the results webhook.");
console.log("(It is a fake match — delete the Discord message when done looking.)");
