/**
 * The path chest, S016: INV-PATH-19 (the completion path), INV-PATH-01/03/18 (the popup),
 * INV-PATH-02 (visual state as a pure function).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { CHEST_ACTION, CHEST_LABEL, chestState, openChest } from './chest.js';
import { isComplete, popupFor, type PopupContext } from './nodes.js';
import { specFor } from './registry.js';
import { node } from './__falsifiers__/fixtures.js';

const ctx: PopupContext = {
  unitTitle: 'Order food',
  legendaryAvailable: true,
  advertisedXp: {},
};

describe('the chest node (S016)', () => {
  it('[INV-PATH-19] opening a chest completes it, so the chain advances past it', () => {
    const closed = node('c', 'chest', 0, { subLessonsDone: 0, subLessonsTotal: 1 });
    expect(isComplete(closed)).toBe(false);
    const opened = openChest(closed);
    expect(isComplete(opened.node)).toBe(true);
    expect(opened.state).toBe('opened');
    expect(opened.awardsBundle).toBe(true);
  });

  it('[INV-PATH-19] a chest pays once: re-opening an open chest owes nothing', () => {
    const opened = openChest(node('c', 'chest', 0, { subLessonsDone: 0, subLessonsTotal: 1 })).node;
    const again = openChest(opened);
    expect(again.node).toBe(opened);
    expect(again.awardsBundle).toBe(false);
  });

  it('[INV-PATH-19] openChest refuses a node that is not a chest', () => {
    expect(() => openChest(node('l', 'lesson', 0))).toThrow(/openChest called on a lesson node/);
  });

  it('[INV-PATH-02] every S016 state is a pure function of the node and its lock state', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(),
        fc.boolean(),
        (done, total, unlocked, opening) => {
          const n = node('c', 'chest', 0, { subLessonsDone: done, subLessonsTotal: total });
          const state = chestState(n, unlocked, opening);
          const expected = isComplete(n)
            ? 'opened'
            : !unlocked
              ? 'locked'
              : opening
                ? 'opening'
                : 'unlocked';
          expect(state).toBe(expected);
          // Called twice with the same inputs, it answers the same: no clock, no memory.
          expect(chestState(n, unlocked, opening)).toBe(state);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-03] the incomplete chest popup says `Open chest`, with no sub-lesson counter', () => {
    const popup = popupFor(
      node('c', 'chest', 0, { subLessonsDone: 0, subLessonsTotal: 3 }),
      true,
      ctx,
    );
    expect(popup.kind).toBe('incomplete');
    expect(popup.buttons.map((b) => b.label)).toEqual([CHEST_ACTION]);
    expect(popup.buttons.map((b) => b.flavour)).toEqual(['chest']);
    // A chest has one tap, not `Lesson 1 of 3`.
    expect(popup.subLessonCounter).toBeNull();
    expect(CHEST_LABEL).toBe('Chest');
  });

  it('[INV-PATH-18] the opened chest declares a popup shape with no buttons, never a fall-through', () => {
    const opened = openChest(node('c', 'chest', 0, { subLessonsDone: 0, subLessonsTotal: 1 })).node;
    const popup = popupFor(opened, true, ctx);
    expect(popup.kind).toBe('complete');
    expect(popup.buttons).toEqual([]);
    expect(popup.subLessonCounter).toBeNull();
    expect(popup.hasStart).toBe(false);
    // And the LEGENDARY offer never reaches a chest.
    expect(specFor('chest').offersLegendary).toBe(false);
  });

  it('[INV-PATH-01] a locked chest renders the locked popup (the capture showed nothing)', () => {
    const popup = popupFor(node('c', 'chest', 0), false, ctx);
    expect(popup.kind).toBe('locked');
    expect(popup.subtitle).toBe('Complete all levels above to unlock this!');
    expect(chestState(node('c', 'chest', 0), false)).toBe('locked');
  });
});
