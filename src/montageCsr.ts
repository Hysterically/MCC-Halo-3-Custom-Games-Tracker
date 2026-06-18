// One-off: montage of all sliced CSR sub-rank emblems, to eyeball the crops.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";

const tiers = ["bronze", "silver", "gold", "platinum", "diamond"];
const CELL = 110;
const PAD = 60;
const W = PAD + 6 * CELL;
const H = PAD + tiers.length * CELL;
const cv = createCanvas(W, H);
const ctx = cv.getContext("2d");
ctx.fillStyle = "#11202e";
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = "#cfe3f2";
ctx.font = "18px Arial";
for (let n = 1; n <= 6; n++) ctx.fillText(String(n), PAD + (n - 1) * CELL + CELL / 2 - 5, 30);
for (let r = 0; r < tiers.length; r++) {
  ctx.fillText(tiers[r], 4, PAD + r * CELL + CELL / 2);
  for (let n = 1; n <= 6; n++) {
    const img = await loadImage(await readFile(new URL(`../assets/csr-${tiers[r]}-${n}.png`, import.meta.url)));
    const s = 84;
    const w = (img.width / img.height) * s;
    const cx = PAD + (n - 1) * CELL + CELL / 2;
    const cy = PAD + r * CELL + CELL / 2;
    ctx.drawImage(img, cx - w / 2, cy - s / 2, w, s);
  }
}
await writeFile(new URL("../preview-csr-emblems.png", import.meta.url), cv.toBuffer("image/png"));
console.log("wrote preview-csr-emblems.png");
