/**
 * Dev tool: render sample carnage reports to PNG so the carnage-screen look
 * can be tweaked without playing a match.
 *
 *   npx tsx src/renderPreview.ts          -> preview-team.png / preview-ffa.png
 */

import { writeFile } from "node:fs/promises";
import { renderCarnagePng } from "./renderCarnage.ts";
import { sampleTeam, sampleFfa } from "./sampleReports.ts";

await writeFile("preview-team.png", renderCarnagePng(sampleTeam));
await writeFile("preview-ffa.png", renderCarnagePng(sampleFfa));
console.log("wrote preview-team.png, preview-ffa.png");
