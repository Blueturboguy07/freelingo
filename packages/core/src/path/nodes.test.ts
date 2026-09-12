/**
 * Node visual state and node popups: INV-PATH-02, INV-PATH-03, INV-PATH-18.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { nodeVisual, popupFor, type PopupContext } from './nodes.js';
import { NODE_TYPES } from './types.js';
import type { NodeType } from './types.js';
import { specFor } from './registry.js';
import { node } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

const ctx: PopupContext = {
  unitTitle: 'Order at a café',
  legendaryAvailable: true,
  advertisedXp: { lesson: 10, practice: 5, legendary: 40 },
};

describe('node visual state', () => {
  it('[INV-PATH-02] falsifier: a node at 1 of 4 renders the same ring however long it sat there', () => {
    const input = falsifier('INV-PATH-02');
    const first = nodeVisual(input.progress as never);
    const later = nodeVisual(input.progress as never);
    expect(first).toEqual(input.expect);
    expect(later).toEqual(first);
  });

  it('[INV-PATH-02] the visual is a pure function of (done, total, legendary)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        (done, total, legendary) => {
          const progress = { subLessonsDone: done, subLessonsTotal: total, legendary };
          const a = nodeVisual(progress);
          const b = nodeVisual({ ...progress });
          expect(b).toEqual(a);
          expect(a.ringFraction).toBeGreaterThanOrEqual(0);
          expect(a.ringFraction).toBeLessThanOrEqual(1);
          // A complete node loses its ring and gains a check; gold is legendary only.
          const complete = done >= total;
          expect(a.showsRing).toBe(!complete);
          expect(a.showsCheck).toBe(complete);
          expect(a.gold).toBe(legendary);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-02] complete is solid green with a check, never gold', () => {
    const done = nodeVisual({ subLessonsDone: 3, subLessonsTotal: 3, legendary: false });
    expect(done.state).toBe('complete');
    expect(done.gold).toBe(false);
    const legendary = nodeVisual({ subLessonsDone: 3, subLessonsTotal: 3, legendary: true });
    expect(legendary.state).toBe('legendary');
    expect(legendary.gold).toBe(true);
  });

  it('[INV-PATH-02] nodeVisual takes exactly one argument, so no clock can be threaded in', () => {
    expect(nodeVisual.length).toBe(1);
  });
});

describe('node popups', () => {
  it('[INV-PATH-03] falsifier: the complete popup carries no counter and no START', () => {
    const input = falsifier('INV-PATH-03');
    const spec = input.node as { type: NodeType; subLessonsDone: number; subLessonsTotal: number };
    const popup = popupFor(node('n', spec.type, 0, spec), true, ctx);
    expect(popup.kind).toBe('complete');
    expect(popup.subLessonCounter).toBeNull();
    expect(popup.hasStart).toBe(false);
    expect(popup.buttons.map((b) => b.label)).toEqual(
      (input.expect as { buttons: string[] }).buttons,
    );
    expect(popup.subtitle).toBe('Prove your proficiency with Legendary');
  });

  it('[INV-PATH-18] falsifier: a completed story node never falls through to the lesson popup', () => {
    const input = falsifier('INV-PATH-18');
    const spec = input.node as { type: NodeType; subLessonsDone: number; subLessonsTotal: number };
    const popup = popupFor(node('s', spec.type, 0, spec), true, {
      ...ctx,
      contentTitle: 'El café',
    });
    expect(popup.buttons.map((b) => b.label)).toEqual(
      (input.expect as { buttons: string[] }).buttons,
    );
    expect(popup.subtitle).toBeNull();
    expect(popup.title).toBe('El café');
    expect(popup.buttons.map((b) => b.label)).not.toContain('PRACTICE');
  });

  it('[INV-PATH-18] every completed-popup button maps to a flavour that node can launch', () => {
    for (const type of NODE_TYPES) {
      const spec = specFor(type);
      for (const button of spec.completedButtons) {
        expect(spec.launchable, `${type} popup button ${button.label}`).toContain(button.flavour);
      }
    }
  });

  it('[INV-PATH-18] every node type declares a completed-popup shape (no fall-through)', () => {
    for (const type of NODE_TYPES) {
      const popup = popupFor(
        node('x', type, 0, { subLessonsDone: 1, subLessonsTotal: 1 }),
        true,
        ctx,
      );
      expect(popup.kind).toBe('complete');
      expect(popup.nodeType).toBe(type);
      expect(popup.subLessonCounter).toBeNull();
    }
  });

  it('[INV-PATH-01] every node type renders a popup when tapped while locked', () => {
    for (const type of NODE_TYPES) {
      const popup = popupFor(node('x', type, 0), false, ctx);
      expect(popup.kind).toBe('locked');
      expect(popup.subtitle).toBe('Complete all levels above to unlock this!');
    }
  });

  it('[INV-PATH-03] an already-legendary node drops the LEGENDARY button and keeps practice', () => {
    const popup = popupFor(
      node('n', 'lesson', 0, { subLessonsDone: 3, subLessonsTotal: 3, legendary: true }),
      true,
      ctx,
    );
    expect(popup.buttons.map((b) => b.label)).toEqual(['PRACTICE']);
  });

  it('[INV-PATH-25] the LEGENDARY button never appears on a script node', () => {
    const popup = popupFor(
      node('l', 'letters', 0, { subLessonsDone: 1, subLessonsTotal: 1 }),
      true,
      ctx,
    );
    expect(popup.buttons.map((b) => b.flavour)).not.toContain('legendary');
  });

  it('[INV-PATH-03] the incomplete popup carries the counter and START, never Legendary', () => {
    const popup = popupFor(
      node('n', 'lesson', 0, { subLessonsDone: 2, subLessonsTotal: 3 }),
      true,
      ctx,
    );
    expect(popup.subLessonCounter).toBe('Lesson 3 of 3');
    expect(popup.hasStart).toBe(true);
    expect(popup.buttons.map((b) => b.flavour)).not.toContain('legendary');
  });
});
