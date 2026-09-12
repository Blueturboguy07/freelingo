/**
 * The 64 px floor.
 *
 * deep/08 §10: "Every illustration must be readable at 64 px (widget) and 240 px
 * (ceremony) from the same source." That is one sentence and it is the hardest thing in
 * this lane, because the failure it describes is invisible to the person who caused it. A
 * pose is authored at desk size, looks right at desk size, is reviewed at desk size — and
 * the widget renders it at 64 px, where a 6-unit highlight is 1.6 px, a tail feather is
 * nine pixels of purple, and the whole bird is a green blob with two dots.
 *
 * So the floor is a test, not a review note. It re-renders every committed asset from its
 * own SVG at both sizes on every run and asserts four things. The thresholds below are
 * stated once, as named constants with the reasoning attached, and the current margins are
 * recorded in `docs/art-and-sound.md` so a future change can see how much room it has.
 *
 * This test owns no invariant id. §12 SND and §11 TYP/A11Y land at P3 with the components
 * that render these assets (plan §Phases, P3 gate); `docs/owned/art.json` says so.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ArtEntry } from '../assets/index.js';
import { ART_INDEX, ART_PALETTE, artEntryPath } from '../assets/index.js';
import { measure } from './metrics.js';
import { MASCOT_SIZES } from './poses.js';
import { writePreview } from './preview.js';
import { renderSvg } from './raster.js';

/**
 * The smallest number of 64 px pixels a colour the source actually paints may occupy.
 *
 * This is the mush detector, and it is the one threshold that matters. A feature authored
 * too small does not disappear from the 240 px render — it disappears from the 64 px one,
 * and the place that shows up is its colour's pixel count. 12 px is about a 3.5 px disc:
 * below that a reader is looking at a smudge, not a feature.
 *
 * Measured 2026-09-11, the tightest assets are mascot/sad and mascot/cheer at 17 px of
 * teal tail feather — a 1.4x margin, the smallest anywhere in art/. That is deliberately
 * recorded rather than rounded up: the tail is the first thing that will fail if a pose is
 * ever redrawn smaller, and sleepy's tail already failed this floor once at 7 px.
 */
const MIN_COLOUR_PIXELS_AT_64 = 12;

/**
 * How far the painted area may move between 64 px and 240 px.
 *
 * This catches the failure the colour census can miss: not a feature vanishing, but the
 * whole drawing thickening or thinning as detail merges. If a pose is the same picture at
 * both sizes its coverage barely moves; the committed art moves by about 0.015.
 */
const MAX_COVERAGE_DRIFT = 0.05;

/** Blocks smaller than this at 64 px are anti-aliasing speckle, not features. */
const MIN_REGION_AREA = 8;

/**
 * Ink and region floors per asset class.
 *
 * The first draft of this test used one pair of numbers for everything and failed thirteen
 * assets, which was the test being wrong rather than the art. A lesson node is *supposed*
 * to be three flat blocks — lip, face, icon — and a story cover is *supposed* to be a
 * full-bleed card; holding them to a figure's "leave ground around the silhouette, show
 * eight features" is holding them to somebody else's spec. One threshold across four
 * classes is either vacuous for the richest class or wrong for the simplest.
 *
 * So each class states what it is made of, and its floor is that content — not what the
 * committed art happens to score. Where the art scores far above its floor (the mascot
 * measures 17-20 regions against a floor of 8) the margin is real headroom, not slack in
 * the number.
 */
const CLASSES = {
  /** A figure on empty ground: body, belly, two wings, crest, two eyes, beak. */
  mascot: { ink: [0.2, 0.85], regions: 8 },
  /** A bust in a plate: plate, garment, face, hair, two eyes, mouth. */
  cast: { ink: [0.2, 0.95], regions: 5 },
  /** A disc plate: lip, face, icon. The progress ring is a component, not art. */
  node: { ink: [0.3, 0.95], regions: 3 },
  /** A full-bleed 3:4 card: card, band, motif. Not full-bleed is the bug. */
  cover: { ink: [0.95, 1.0], regions: 3 },
  /** Two-layer chrome (scope/10's outer box + inner face). Two blocks is all it is. */
  frame: { ink: [0.5, 0.98], regions: 2 },
} as const satisfies Record<ArtEntry['kind'], { ink: readonly [number, number]; regions: number }>;

interface Rendered {
  readonly entry: ArtEntry;
  readonly small: ReturnType<typeof measure>;
  readonly large: ReturnType<typeof measure>;
}

function renderEntry(entry: ArtEntry): Rendered {
  const svg = readFileSync(artEntryPath(entry), 'utf8');
  const [small, large] = MASCOT_SIZES.map((size) => {
    const bitmap = renderSvg(svg, size);
    writePreview(entry.source, size, bitmap);
    return measure(bitmap, bitmap.palette, size === 64 ? MIN_REGION_AREA : MIN_REGION_AREA * 5);
  }) as [ReturnType<typeof measure>, ReturnType<typeof measure>];
  return { entry, small, large };
}

const RENDERED: readonly Rendered[] = ART_INDEX.map(renderEntry);

describe('art is legible at both required sizes', () => {
  it.each(RENDERED.map((r) => [r.entry.id, r] as const))(
    '%s survives reduction to 64 px',
    (_id, rendered) => {
      const { small, large, entry } = rendered;
      const floor = CLASSES[entry.kind];

      expect(small.inkCoverage, `${entry.id} ink at 64 px`).toBeGreaterThanOrEqual(floor.ink[0]);
      expect(small.inkCoverage, `${entry.id} ink at 64 px`).toBeLessThanOrEqual(floor.ink[1]);

      expect(
        Math.abs(small.inkCoverage - large.inkCoverage),
        `${entry.id} coverage drift between 64 px and 240 px`,
      ).toBeLessThanOrEqual(MAX_COVERAGE_DRIFT);

      expect(small.regions, `${entry.id} distinct regions at 64 px`).toBeGreaterThanOrEqual(
        floor.regions,
      );

      // The mush detector. Named per colour so a failure says which feature vanished.
      for (const { hex, pixels } of small.colours) {
        expect(pixels, `${entry.id}: ${hex} survives at 64 px`).toBeGreaterThanOrEqual(
          MIN_COLOUR_PIXELS_AT_64,
        );
      }
    },
  );

  it('the floor rejects art that is mush at 64 px', () => {
    // The falsifier. A 240-unit frame whose only detail is a 2-unit stripe and a 5-unit
    // dot: both plainly there at 240 px, both gone at 64 px. If this ever passes, the
    // floor is decorative.
    const mush = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">',
      '<circle cx="120" cy="120" r="96" fill="#58CC02"/>',
      '<rect x="118" y="30" width="2" height="180" fill="#FFC700"/>',
      '<circle cx="80" cy="80" r="5" fill="#3C3C3C"/>',
      '</svg>',
    ].join('');

    const gold = ART_PALETTE.gold.toLowerCase();
    const ink = ART_PALETTE.ink.toLowerCase();

    const bitmap = renderSvg(mush, 64);
    const m = measure(bitmap, bitmap.palette, MIN_REGION_AREA);
    const survivors = m.colours.filter((c) => c.pixels >= MIN_COLOUR_PIXELS_AT_64);

    expect(m.colours.map((c) => c.hex)).toContain(gold);
    expect(survivors.map((c) => c.hex)).not.toContain(gold);
    expect(survivors.map((c) => c.hex)).not.toContain(ink);

    // …and the same source at 240 px keeps both, which is exactly why a desk-size review
    // cannot catch this and a test can.
    const big = renderSvg(mush, 240);
    const mBig = measure(big, big.palette, MIN_REGION_AREA);
    for (const hex of [gold, ink]) {
      const entry = mBig.colours.find((c) => c.hex === hex);
      expect(entry?.pixels ?? 0, `${hex} at 240 px`).toBeGreaterThan(MIN_COLOUR_PIXELS_AT_64);
    }
  });
});

describe('the art inventory matches the product map', () => {
  it('every registered asset exists and parses in the authoring subset', () => {
    expect(ART_INDEX.length).toBeGreaterThan(0);
    for (const entry of ART_INDEX) {
      expect(() => readFileSync(artEntryPath(entry), 'utf8')).not.toThrow();
    }
  });

  it('every asset names at least one product-map screen that renders it', () => {
    for (const entry of ART_INDEX) {
      expect(entry.screens.length, `${entry.id} has no consuming screen`).toBeGreaterThan(0);
      for (const screen of entry.screens) expect(screen).toMatch(/^S\d{3}$/);
    }
  });

  it('art paints only colours from the declared palette', () => {
    const allowed = new Set(Object.values(ART_PALETTE).map((hex) => hex.toLowerCase()));
    // Derived shades used by node plates, covers and the cast. Listed here rather than in
    // ART_PALETTE because nothing outside art/ may use them as UI colours.
    for (const hex of ['#6b7c87', '#3b9fd4', '#ffe0bd', '#f1c9a0', '#c68642', '#8d5524']) {
      allowed.add(hex);
    }
    for (const { entry, small } of RENDERED) {
      for (const { hex } of small.colours) {
        expect(allowed, `${entry.id} paints ${hex}, which is not a declared art colour`).toContain(
          hex.toLowerCase(),
        );
      }
    }
  });

  it('no .riv file is in the repository (EC-PLAT-09)', () => {
    for (const entry of ART_INDEX) expect(entry.source.endsWith('.svg')).toBe(true);
  });
});
