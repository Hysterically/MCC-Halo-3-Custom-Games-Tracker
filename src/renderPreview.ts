/**
 * Dev tool: render sample carnage reports to PNG so the carnage-screen look
 * can be tweaked without playing a match.
 *
 *   npx tsx src/renderPreview.ts          -> preview-team.png / preview-ffa.png
 */

import { writeFile } from "node:fs/promises";
import { renderCarnagePng } from "./renderCarnage.ts";
import { sampleTeam, sampleFfa, sampleEloDeltas } from "./sampleReports.ts";

await writeFile("preview-team.png", renderCarnagePng(sampleTeam, sampleEloDeltas(sampleTeam)));
await writeFile("preview-ffa.png", renderCarnagePng(sampleFfa, sampleEloDeltas(sampleFfa)));
console.log("wrote preview-team.png, preview-ffa.png");
