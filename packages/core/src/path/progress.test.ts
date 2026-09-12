/**
 * Section fractions, transitions, viewport and absence: INV-PATH-09, INV-PATH-20,
 * INV-PATH-21.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  applyAbsence,
  NO_TRANSITIONS,
  sectionCompleted,
  sectionProgress,
  transitionsBetween,
  viewportAfterCeremony,
  viewportOf,
} from './progress.js';
import { unitAdvanced, unitCompleted, applyJump } from './unlock.js';
import { allUnits } from './types.js';
import type { NodeType, PathModel } from './types.js';
import {
  buildModel,
  FULL_MANIFEST,
  linearModelArb,
  NO_STORIES_MANIFEST,
} from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

/** Mark every node of the model complete. */
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

describe('section progress', () => {
  it('[INV-PATH-20] falsifier: a jumped-past unit is advanced but not completed, so the fraction stays 0', () => {
    const input = falsifier('INV-PATH-20');
    const shape = input.shape as readonly (readonly (readonly NodeType[])[])[];
    const jumped = applyJump(buildModel(shape, 0), input.jumpTo as number);
    const units = allUnits(jumped);
    // The jump advanced the learner past unit 0 without completing a single node.
    expect(units[0] && unitCompleted(units[0])).toBe(false);
    const progress = sectionProgress(jumped.sections[0]!, FULL_MANIFEST);
    expect(progress.unitsCompleted).toBe(
      (input.expect as { unitsCompleted: number }).unitsCompleted,
    );
    expect(progress.fraction).toBe((input.expect as { fraction: number }).fraction);
  });

  it('[INV-PATH-20] the fraction counts only units with EVERY node complete, over generated paths', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        for (const section of model.sections) {
          const progress = sectionProgress(section, FULL_MANIFEST);
          expect(progress.unitsCompleted).toBe(section.units.filter(unitCompleted).length);
          // `advanced` is always at least `completed`, and the fraction never uses it.
          const advanced = section.units.filter(unitAdvanced).length;
          expect(advanced).toBeGreaterThanOrEqual(progress.unitsCompleted);
          expect(progress.fraction).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-03] a pack with no stories renders no stories counter at all, not 0/0', () => {
    const model = buildModel([[['lesson', 'unitReview']]], 0, NO_STORIES_MANIFEST);
    const progress = sectionProgress(model.sections[0]!, NO_STORIES_MANIFEST);
    expect(progress.storiesTotal).toBeNull();
    expect(progress.storiesCompleted).toBeNull();
  });

  it('[INV-PATH-20] unitCompleted fires only on an incomplete -> complete transition', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        const done = completeAll(model);
        const first = transitionsBetween(model, done);
        // Every unit that was not already complete transitions exactly once...
        const expected = allUnits(model)
          .map((u, i) => (unitCompleted(u) ? -1 : i))
          .filter((i) => i >= 0);
        expect(first.unitCompleted).toEqual(expected);
        // ...and never again.
        expect(transitionsBetween(done, done)).toEqual(NO_TRANSITIONS);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('viewport and transitions', () => {
  it('[INV-PATH-21] falsifier: practising in a finished past section fires nothing and returns there', () => {
    const input = falsifier('INV-PATH-21');
    const model = completeAll(
      buildModel([[['lesson', 'unitReview']], [['lesson', 'unitReview']]], 0),
    );
    // Re-practising changes no completion state, so there is no transition to fire.
    expect(transitionsBetween(model, model)).toEqual(NO_TRANSITIONS);
    const launching = {
      viewingSection: input.viewingSection as number,
      currentSection: input.currentSection as number,
    };
    expect(viewportAfterCeremony(launching, NO_TRANSITIONS)).toEqual(launching);
    expect(viewportAfterCeremony(launching, NO_TRANSITIONS).viewingSection).toBe(
      (input.expect as { viewportAfter: number }).viewportAfter,
    );
  });

  it('[INV-PATH-21] the post-ceremony viewport equals the launching viewport unless that section completed', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 7 }),
        fc.nat({ max: 7 }),
        fc.array(fc.nat({ max: 7 }), { maxLength: 3 }),
        (viewingSection, currentSection, completedSections) => {
          const launching = { viewingSection, currentSection };
          const transitions = {
            ...NO_TRANSITIONS,
            sectionCompleted: completedSections,
          };
          const after = viewportAfterCeremony(launching, transitions);
          if (completedSections.includes(viewingSection)) {
            expect(after.viewingSection).toBe(viewingSection + 1);
          } else {
            expect(after).toEqual(launching);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-21] the section switch is applied before the return renders', () => {
    const before = buildModel([[['lesson', 'unitReview']], [['lesson', 'unitReview']]], 0);
    const after = completeAll(before);
    const transitions = transitionsBetween(before, after);
    expect(transitions.sectionCompleted).toContain(0);
    const viewport = viewportAfterCeremony(viewportOf(before), transitions);
    expect(viewport.viewingSection).toBe(1);
  });

  it('[INV-PATH-20] sectionCompleted is false for a section with an unearned trophy', () => {
    const model = buildModel([[['lesson', 'unitReview']]], 1);
    expect(sectionCompleted(model.sections[0]!)).toBe(false);
  });
});

describe('absence', () => {
  it('[INV-PATH-09] falsifier: an absence of any length returns the identical model', () => {
    const input = falsifier('INV-PATH-09');
    const model = buildModel([[['lesson', 'chest', 'unitReview']]], 2);
    for (const days of input.absenceDays as number[]) {
      expect(applyAbsence(model, days)).toBe(model);
    }
  });

  it('[INV-PATH-09] no absence relocks a node or moves the current node, over generated paths', () => {
    fc.assert(
      fc.property(linearModelArb, fc.nat({ max: 100_000 }), ({ model }, days) => {
        const after = applyAbsence(model, days);
        expect(after).toBe(model);
        expect(viewportOf(after)).toEqual(viewportOf(model));
        expect(transitionsBetween(model, after)).toEqual(NO_TRANSITIONS);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
