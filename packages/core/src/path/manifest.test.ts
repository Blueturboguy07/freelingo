/**
 * The manifest decides the section list, the completion copy, the Score ceiling and the
 * entry points: INV-PATH-17, INV-PACK-03, INV-PACK-56.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  completionCopy,
  emptyStates,
  sectionCards,
  shippedEntryPoints,
  unreachableFlavours,
} from './manifest.js';
import { LAUNCH_FLAVOURS, NODE_TYPES, SESSION_FLAVOURS } from './types.js';
import type { PackManifest, PathModel } from './types.js';
import { specFor } from './registry.js';
import { bandRange, displayedScore, sectionScore } from './score.js';
import {
  buildModel,
  FULL_MANIFEST,
  NO_STORIES_MANIFEST,
  linearModelArb,
} from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

function completeAll(model: PathModel): PathModel {
  return {
    ...model,
    sections: model.sections.map((s) => ({
      ...s,
      units: s.units.map((u) => ({
        ...u,
        nodes: u.nodes.map((n) => ({ ...n, subLessonsDone: n.subLessonsTotal })),
      })),
    })),
  };
}

describe('flavour entry points', () => {
  it('[INV-PATH-17] falsifier: every flavour is reachable, and the section test is the S019 boundary variant', () => {
    const input = falsifier('INV-PATH-17');
    const expected = input.expect as {
      unreachableFlavours: string[];
      sectionTestNodeTypes: string[];
    };
    expect(unreachableFlavours(FULL_MANIFEST)).toEqual(expected.unreachableFlavours);
    // Exactly one node type can launch `sectionTest`, and it is the jump-here node.
    const launchers = NODE_TYPES.filter((t) => specFor(t).launchable.includes('sectionTest'));
    expect(launchers).toEqual(expected.sectionTestNodeTypes);
  });

  it('[INV-PATH-17] no second component renders a section test', () => {
    const entries = shippedEntryPoints(FULL_MANIFEST).filter((e) =>
      e.flavours.includes('sectionTest'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toEqual({ kind: 'section-boundary-jump-here' });
  });

  it('[INV-PATH-17] the ten session-runtime flavours are S057-S066', () => {
    expect(SESSION_FLAVOURS).toHaveLength(10);
    expect(SESSION_FLAVOURS).toEqual([
      'lesson',
      'practice',
      'legendary',
      'placement',
      'jumpHere',
      'sectionTest',
      'unitReview',
      'dailyRefresh',
      'recovery',
      'endgame',
    ]);
  });

  it('[INV-PATH-17] every flavour has an entry point for any pack that declares every node type', () => {
    fc.assert(
      fc.property(
        fc.subarray([...NODE_TYPES.filter((t) => t !== 'jumpHere')], { minLength: 1 }),
        (declared) => {
          const manifest: PackManifest = { ...FULL_MANIFEST, declaredNodeTypes: declared };
          const reachable = new Set(shippedEntryPoints(manifest).flatMap((e) => e.flavours));
          // Every flavour a DECLARED node can launch is reachable, and the five
          // path-independent flavours are always reachable.
          for (const type of declared) {
            for (const flavour of specFor(type).launchable)
              expect(reachable.has(flavour)).toBe(true);
          }
          for (const flavour of [
            'placement',
            'dailyRefresh',
            'recovery',
            'endgame',
            'sectionTest',
          ] as const) {
            expect(reachable.has(flavour)).toBe(true);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-17] the enum has no value the registry cannot name', () => {
    const all = new Set(LAUNCH_FLAVOURS);
    for (const type of NODE_TYPES) {
      for (const flavour of specFor(type).launchable) expect(all.has(flavour)).toBe(true);
    }
  });
});

describe('the section list and completion copy', () => {
  it('[INV-PACK-56] falsifier: a three-section beta renders three cards and copy that matches its ceiling', () => {
    const input = falsifier('INV-PACK-56');
    const expected = input.expect as Record<string, string | number | boolean>;
    const manifest: PackManifest = {
      ...NO_STORIES_MANIFEST,
      sectionTitles: input.sectionTitles as string[],
      scoreCeiling: input.scoreCeiling as number,
    };
    const model = completeAll(
      buildModel(
        [[['lesson', 'unitReview']], [['lesson', 'unitReview']], [['lesson', 'unitReview']]],
        0,
        manifest,
      ),
    );
    expect(sectionCards(model)).toHaveLength(expected.sectionCards as number);
    const copy = completionCopy(model);
    expect(copy).not.toBeNull();
    expect(copy?.beta).toBe(expected.beta);
    expect(copy?.bandReached).toBe(expected.bandReached);
    expect(copy?.scoreCeiling).toBe(expected.copyCeiling);
    expect(copy?.sectionsShipped).toBe(expected.sectionCards);
  });

  it('[INV-PACK-56] the section list length is the pack manifest, never a constant', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        expect(sectionCards(model)).toHaveLength(model.sections.length);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-56] completion copy is null until the course is actually complete', () => {
    const model = buildModel([[['lesson', 'unitReview']]], 1);
    expect(completionCopy(model)).toBeNull();
  });

  it('[INV-PACK-03] a pack with no stories renders no stories label and no empty state', () => {
    const model = buildModel([[['lesson', 'unitReview']]], 1, NO_STORIES_MANIFEST);
    for (const card of sectionCards(model)) expect(card.storiesLabel).toBeNull();
    expect(emptyStates(model)).toEqual([]);
  });

  it('[INV-PACK-03] no surface renders an empty state, over generated paths', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        expect(emptyStates(model)).toEqual([]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-22] every RENDERED section card clamps the course Score into its OWN band', () => {
    // The refutation this test exists for: `sectionScore` was correct and tested, but dead
    // on the render path - `sectionCards` wrote `sectionScore: score`, the course Score
    // clamped into the FRONTIER section's band. A learner standing in Section 1 opening the
    // section list saw the same `very early A1` number on the Section 5 card. S023 renders
    // this field, so the property has to run over the card, not over the bare function.
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        const cards = sectionCards(model);
        const course = displayedScore(model);
        for (let i = 0; i < cards.length; i += 1) {
          const card = cards[i];
          const band = model.sections[i]?.band;
          if (card === undefined || band === undefined) continue;
          const range = bandRange(band);
          expect(card.sectionScore).toBeGreaterThanOrEqual(range.min);
          expect(card.sectionScore).toBeLessThanOrEqual(range.max);
          expect(card.sectionScore).toBe(sectionScore(course, model.sections[i]!));
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-22] a card number is non-decreasing in the course Score', () => {
    fc.assert(
      fc.property(linearModelArb, fc.nat({ max: 200 }), fc.nat({ max: 200 }), ({ model }, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const low = sectionCards({ ...model, scoreEarned: lo, scoreFloor: lo });
        const high = sectionCards({ ...model, scoreEarned: hi, scoreFloor: hi });
        for (let i = 0; i < low.length; i += 1) {
          expect(high[i]!.sectionScore).toBeGreaterThanOrEqual(low[i]!.sectionScore);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-22] a far-off section card does not read the frontier section`s number', () => {
    const model = buildModel(
      [[['lesson', 'unitReview']], [['lesson', 'unitReview']], [['lesson', 'unitReview']]],
      0,
      { ...FULL_MANIFEST, scoreCeiling: 129 },
    );
    const cards = sectionCards({ ...model, scoreEarned: 5, scoreFloor: 0 });
    // Section 1 is `very early A1` (0-9), Section 2 `early A1` (10-19), Section 3 `high A1`.
    expect(cards.map((c) => c.sectionScore)).toEqual([5, 10, 20]);
  });

  it('[EC-PTH-26] the section action follows reachability, not a completed-unit count', () => {
    // The frontier section a learner is standing in, with no unit yet fully complete, must
    // not offer to `JUMP HERE` to where they already are.
    const model = buildModel([[['lesson', 'unitReview']], [['lesson', 'unitReview']]], 0);
    const cards = sectionCards(model);
    expect(cards[0]?.percent).toBe(0);
    expect(cards[0]?.action).toBe('Go to current unit');
    expect(cards[1]?.action).toBe('JUMP HERE');
  });

  it('[INV-PACK-56] the CEFR chip reads `CEFR-checked` only where the pack says so', () => {
    const es = buildModel([[['lesson', 'unitReview']]], 0, FULL_MANIFEST);
    expect(sectionCards(es)[0]?.cefrChip).toContain('CEFR-checked');
    const ja = buildModel([[['lesson', 'unitReview']]], 0, NO_STORIES_MANIFEST);
    expect(sectionCards(ja)[0]?.cefrChip).toBe('Beginner - frequency-ordered');
  });
});
