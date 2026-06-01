/**
 * First-launch setup wizard. Walks a non-technical user through creating two
 * Discord webhooks (#game-results, #leaderboard) and writes the URLs to a
 * local `.env` next to the executable.
 *
 * Skips silently if both URLs are already configured. Run with `--force` to
 * reconfigure (start.bat exposes this as a menu option).
 *
 *   npm run setup
 *   tsx src/setup.ts --force
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ENV_PATH = resolve(process.cwd(), ".env");
const FORCE = process.argv.includes("--force");

const WEBHOOK_RE = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

interface EnvVars {
  results?: string;
  leaderboard?: string;
  [k: string]: string | undefined;
}

function readEnv(): EnvVars {
  if (!existsSync(ENV_PATH)) return {};
  const text = readFileSync(ENV_PATH, "utf8");
  const out: EnvVars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const v = m[2].trim();
    if (!v) continue;
    if (m[1] === "DISCORD_RESULTS_WEBHOOK_URL") out.results = v;
    else if (m[1] === "DISCORD_LEADERBOARD_WEBHOOK_URL") out.leaderboard = v;
    else out[m[1]] = v;
  }
  return out;
}

function writeEnv(vars: EnvVars): void {
  const lines = [
    "# Halo 3 Customs Tracker - local config.",
    "# Edit by running 'Setup.bat' again, or delete this file to start over.",
    "",
    `DISCORD_RESULTS_WEBHOOK_URL=${vars.results ?? ""}`,
    `DISCORD_LEADERBOARD_WEBHOOK_URL=${vars.leaderboard ?? ""}`,
  ];
  for (const [k, v] of Object.entries(vars)) {
    if (k === "results" || k === "leaderboard") continue;
    if (v) lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, lines.join("\r\n") + "\r\n", "utf8");
}

async function askUrl(rl: import("node:readline/promises").Interface, label: string): Promise<string> {
  while (true) {
    const v = (await rl.question(`Paste the ${label} webhook URL (or 'skip' to set later):\n> `)).trim();
    if (v.toLowerCase() === "skip" || v === "") return "";
    if (WEBHOOK_RE.test(v)) return v;
    console.log("  That doesn't look like a Discord webhook URL. It should start with");
    console.log("  https://discord.com/api/webhooks/ and have no trailing spaces. Try again.\n");
  }
}

const existing = readEnv();
const needsResults = !existing.results;
const needsLeaderboard = !existing.leaderboard;

if (!FORCE && !needsResults && !needsLeaderboard) {
  console.log("Discord is already configured. (Run Setup.bat again if you want to change it.)");
  process.exit(0);
}

console.log("=====================================================");
console.log("  Halo 3 Customs Tracker - First-time Discord setup  ");
console.log("=====================================================");
console.log("");
console.log("The tracker posts to two Discord channels:");
console.log("  1. #game-results  - one message per match (who won, K/D, etc.)");
console.log("  2. #leaderboard   - one always-current standings message");
console.log("");
console.log("You'll need to make a 'webhook' for each channel. Here's how:");
console.log("");
console.log("  In Discord:");
console.log("    a) Right-click the channel name -> Edit Channel");
console.log("    b) Left sidebar: Integrations -> Webhooks -> New Webhook");
console.log("    c) Name it (e.g. 'H3 Tracker') -> Copy Webhook URL");
console.log("    d) Save Changes");
console.log("");
console.log("Do this for BOTH channels, then paste the URLs below.");
console.log("(Press Ctrl+C any time to quit. You can also paste 'skip' to set later.)");
console.log("");

const rl = createInterface({ input, output });
try {
  const results = needsResults
    ? await askUrl(rl, "#game-results")
    : existing.results!;
  const leaderboard = needsLeaderboard
    ? await askUrl(rl, "#leaderboard")
    : existing.leaderboard!;

  writeEnv({ ...existing, results, leaderboard });

  console.log("");
  console.log("Saved to .env.");
  if (!results) console.log("  (No #game-results URL set - per-match posts will be disabled.)");
  if (!leaderboard) console.log("  (No #leaderboard URL set - live leaderboard will be disabled.)");
  console.log("");
  console.log("All set. The tracker will start now.");
} finally {
  rl.close();
}
