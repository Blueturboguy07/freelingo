/**
 * Legibility metrics for a rasterised piece of art.
 *
 * deep/08 §10 states the requirement in one sentence — "every illustration must be
 * readable at 64 px (widget) and 240 px (ceremony) from the same source" — and that
 * sentence is the whole difficulty of this lane. A pose that is beautiful at 240 px and
 * grey mush at 64 px passes every review a human does at desk size and then ships into
 * the widget, which is the one surface where the mascot is the entire UI.
 *
 * So "readable" is made measurable here, as three things that a mushy pose fails and a
 * legible one passes:
 *
 * 1. `inkCoverage` — how much of the frame the art occupies. Too little and the pose is a
 *    speck in a 64 px box; too much and it is a filled square with no silhouette.
 * 2. `colourCensus` — how many pixels survive *of each colour the source actually paints*.
 *    This is the one that catches mush: a feature authored too small does not vanish from
 *    the 240 px render, it vanishes from the 64 px one, and its colour's pixel count is
 *    exactly where that shows up.
 * 3. `regionCount` — how many separate blocks of flat colour a reader can pick out. Two
 *    features that merge into one blob at 64 px keep their colours but lose their count.
 *
 * Nothing here knows what a parrot is. These are properties of a raster, which is why the
 * same floor holds node art, cast avatars and story covers as well as the mascot.
 */

import type { Bitmap, Rgb } from './raster.js';
import { parseColour, toHex } from './raster.js';

/** Alpha at or above which a pixel counts as painted rather than as an edge. */
const OPAQUE = 200;

/** Fraction of the frame that is painted. */
export function inkCoverage(bitmap: Bitmap): number {
  const { pixels, width, height } = bitmap;
  let painted = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] as number) >= OPAQUE) painted += 1;
  }
  return painted / (width * height);
}

function squaredDistance(px: Rgb, q: Rgb): number {
  return (px[0] - q[0]) ** 2 + (px[1] - q[1]) ** 2 + (px[2] - q[2]) ** 2;
}

/**
 * How far a pixel may sit from a palette colour and still be counted as *being* that
 * colour, in RGB euclidean distance.
 *
 * Nearest-in-palette alone is not enough, and the falsifier in `legibility.test.ts` is
 * what proved it: a 2-unit gold stripe on a green body renders at 64 px as a half-pixel
 * column of roughly 53% gold, 47% green. Every one of those pixels is *nearer* to gold
 * than to green, so a nearest-match census reported 48 surviving gold pixels and declared
 * a hairline legible. A reader sees a faint tint, not a stripe.
 *
 * 64 is about a quarter of the way between two typical art colours, so a pixel counts for
 * a colour only when it is mostly that colour. Pixels that are a genuine blend of two —
 * anti-aliased edges — are counted for neither, which is also what makes `regionCount`
 * separate two touching blocks instead of merging them.
 */
const MAX_CLASSIFY_DISTANCE = 64;

/**
 * Classify every opaque, near-pure pixel to the closest colour in `palette`, returning
 * per-colour pixel counts and the per-pixel label map (-1 = not painted, or not close
 * enough to any one colour to be reading as it).
 */
export function colourCensus(
  bitmap: Bitmap,
  palette: readonly string[],
): { counts: Map<string, number>; labels: Int32Array } {
  const swatches = palette.map((hex) => parseColour(hex) as Rgb);
  const counts = new Map<string, number>(palette.map((hex) => [hex, 0]));
  const labels = new Int32Array(bitmap.width * bitmap.height).fill(-1);
  const { pixels } = bitmap;
  for (let i = 0; i < labels.length; i += 1) {
    const o = i * 4;
    if ((pixels[o + 3] as number) < OPAQUE) continue;
    const px: Rgb = [pixels[o] as number, pixels[o + 1] as number, pixels[o + 2] as number];
    let best = -1;
    let bestDistance = MAX_CLASSIFY_DISTANCE ** 2;
    for (let s = 0; s < swatches.length; s += 1) {
      const d = squaredDistance(px, swatches[s] as Rgb);
      if (d <= bestDistance) {
        bestDistance = d;
        best = s;
      }
    }
    if (best < 0) continue;
    labels[i] = best;
    const hex = toHex(swatches[best] as Rgb);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return { counts, labels };
}

/**
 * Count 4-connected regions of one classified colour whose area is at least `minArea`
 * pixels. Regions smaller than that are anti-aliasing speckle, not features a reader sees.
 */
export function regionCount(
  labels: Int32Array,
  width: number,
  height: number,
  minArea: number,
): number {
  const seen = new Uint8Array(labels.length);
  const stack: number[] = [];
  let regions = 0;
  for (let start = 0; start < labels.length; start += 1) {
    if (seen[start] || (labels[start] as number) < 0) continue;
    const label = labels[start] as number;
    let area = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      area += 1;
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || seen[n] || labels[n] !== label) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (area >= minArea) regions += 1;
  }
  return regions;
}

export interface Legibility {
  readonly size: number;
  readonly inkCoverage: number;
  readonly regions: number;
  /** Pixel count per authored colour, smallest first — the mush detector. */
  readonly colours: readonly { readonly hex: string; readonly pixels: number }[];
}

export function measure(
  bitmap: Bitmap,
  palette: readonly string[],
  minRegionArea: number,
): Legibility {
  const { counts, labels } = colourCensus(bitmap, palette);
  return {
    size: bitmap.width,
    inkCoverage: inkCoverage(bitmap),
    regions: regionCount(labels, bitmap.width, bitmap.height, minRegionArea),
    colours: [...counts.entries()]
      .map(([hex, pixels]) => ({ hex, pixels }))
      .sort((a, b) => a.pixels - b.pixels),
  };
}
