import { config } from "./config.ts";
import { openDb, matchesChrono } from "./db.ts";
import { categorize } from "./category.ts";

const needle = (process.argv[2] ?? "Hysterica").toLowerCase();
const db = await openDb(config.dbUrl, config.dbAuthToken);
const matches = await matchesChrono(db);

for (const m of matches) {
  if (!m.players.some((p) => p.gamertag.toLowerCase().includes(needle))) continue;
  const cat = categorize(m);
  if (cat !== "other") continue;

  // Replicate exactly what categorize() counts: real players (xuid present), by team.
  const real = m.players.filter((p) => p.xuid);
  const sizes = new Map<number, number>();
  for (const p of real) if (p.teamId >= 0) sizes.set(p.teamId, (sizes.get(p.teamId) ?? 0) + 1);

  console.log(
    `\n${new Date(m.playedAt).toISOString().slice(0, 16).replace("T", " ")} — ${m.gameTypeName}` +
      `  teamsEnabled=${m.teamsEnabled}  match_id=${m.matchId}`,
  );
  console.log(`   categorize() => "${cat}"   real-player team sizes: ${JSON.stringify([...sizes])}`);
  for (const p of [...m.players].sort((a, b) => a.teamId - b.teamId)) {
    console.log(
      `   team${p.teamId} ${p.gamertag.padEnd(18)} ${p.kills}k/${p.deaths}d/${p.assists}a  xuid=${p.xuid || "(none)"}`,
    );
  }
}

db.close();
