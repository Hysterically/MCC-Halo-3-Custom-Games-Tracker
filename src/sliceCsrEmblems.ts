/**
 * One-off: the halopedia CSR tier files are 6-emblem strips (one emblem per
 * sub-rank 1..6). Emblems vary in width (the star and laurel sub-ranks are wider
 * than the plain ones), so we can't slice into equal sixths — that clips them.
 * Instead we segment by the fully-transparent vertical gaps BETWEEN emblems,
 * giving each emblem's exact bounding box, then trim and write one file per
 * sub-rank: assets/csr-<tier>-<n>.png (n = 1..6). Onyx is a single emblem
 * (assets/csr-onyx.png), left as-is.
 *
 *   npx tsx src/sliceCsrEmblems.ts
 */
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";

const STRIP_TIERS = ["bronze", "silver", "gold", "platinum", "diamond"]; // onyx is single
const ALPHA = 24; // a pixel counts as "ink" above this alpha
const MIN_GAP = 6; // a run of this many empty columns separates two emblems
const MIN_W = 24; // ignore ink runs narrower than this (stray speck, not an emblem)

/** Column ranges [x0,x1] (inclusive) of each emblem in the strip. */
function segmentColumns(data: Uint8ClampedArray, w: number, h: number): [number, number][] {
  const inked: boolean[] = [];
  for (let x = 0; x < w; x++) {
    let any = false;
    for (let y = 0; y < h; y++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA) {
        any = true;
        break;
      }
    }
    inked.push(any);
  }
  const spans: [number, number][] = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x < w; x++) {
    if (inked[x]) {
      if (start < 0) start = x;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap >= MIN_GAP) {
        spans.push([start, x - gap]);
        start = -1;
      }
    }
  }
  if (start >= 0) spans.push([start, w - 1]);
  return spans.filter(([a, b]) => b - a + 1 >= MIN_W);
}

/** Crop the strip to column range [x0,x1], then trim its vertical bounding box. */
function cropEmblem(strip: Image, full: Uint8ClampedArray, sw: number, x0: number, x1: number): Buffer {
  const w = x1 - x0 + 1;
  const h = strip.height;
  let minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = x0; x <= x1; x++) {
      if (full[(y * sw + x) * 4 + 3] > ALPHA) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const ch = maxY - minY + 1;
  const out = createCanvas(w, ch);
  out.getContext("2d").drawImage(strip, x0, minY, w, ch, 0, 0, w, ch);
  return out.toBuffer("image/png");
}

for (const tier of STRIP_TIERS) {
  const strip = await loadImage(
    await readFile(new URL(`../assets/csr-${tier}-strip.png`, import.meta.url)),
  );
  const probe = createCanvas(strip.width, strip.height);
  probe.getContext("2d").drawImage(strip, 0, 0);
  const { data } = probe.getContext("2d").getImageData(0, 0, strip.width, strip.height);

  const spans = segmentColumns(data, strip.width, strip.height);
  if (spans.length !== 6) {
    console.warn(`csr-${tier}: found ${spans.length} emblems (expected 6) — widths ${spans.map(([a, b]) => b - a + 1).join(",")}`);
  }
  for (let n = 0; n < spans.length; n++) {
    const png = cropEmblem(strip, data, strip.width, spans[n][0], spans[n][1]);
    await writeFile(new URL(`../assets/csr-${tier}-${n + 1}.png`, import.meta.url), png);
  }
  console.log(`csr-${tier}: ${spans.length} emblems, widths ${spans.map(([a, b]) => b - a + 1).join(",")}`);
}
