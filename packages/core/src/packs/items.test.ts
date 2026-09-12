import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  ITEM_ID_HEX_LENGTH,
  additiveOnlyViolations,
  applyPackUpdate,
  canonicalJson,
  contentHashItemId,
  isContentHashItemId,
  retiredNotice,
  scoreFrom,
  wordsLearned,
  type ScheduledItem,
} from './items.js';

/** INV-PACK-02 — content-hashed, additive-only ids; quarantine, never delete. */

const arbRow: fc.Arbitrary<ScheduledItem> = fc.record({
  itemId: fc.integer({ min: 0, max: 60 }).map((n) => contentHashItemId({ n })),
  quarantined: fc.boolean(),
  learned: fc.boolean(),
  scoreContribution: fc.integer({ min: 0, max: 40 }),
});

/** Rows may repeat an id: two courses can schedule the same lexeme. */
const arbRows = fc.array(arbRow, { maxLength: 30 });
const arbPackIds = fc
  .array(fc.integer({ min: 0, max: 60 }), { maxLength: 40 })
  .map((ns) => new Set(ns.map((n) => contentHashItemId({ n }))));

describe('INV-PACK-02 content-hashed, additive-only item ids', () => {
  it('[INV-PACK-02] an id is a function of the content, not of the position', () => {
    fc.assert(
      fc.property(
        fc.record({
          lemma: fc.string({ maxLength: 12 }),
          form: fc.string({ maxLength: 12 }),
          kind: fc.constantFrom('translate', 'listen', 'match'),
        }),
        fc.nat({ max: 5000 }),
        (content, position) => {
          const id = contentHashItemId(content);
          expect(contentHashItemId({ ...content })).toBe(id);
          // Key order must not change the id: two generator versions must agree.
          expect(
            contentHashItemId({ kind: content.kind, form: content.form, lemma: content.lemma }),
          ).toBe(id);
          // The position is not part of the content, so an item that moves keeps its id
          // — and an id that DID carry a position would differ from this one.
          expect(contentHashItemId({ ...content, position })).not.toBe(id);
          expect(isContentHashItemId(id)).toBe(true);
          expect(id).toHaveLength(2 + ITEM_ID_HEX_LENGTH);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-02] different content gets a different id', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        if (a === b) return;
        expect(contentHashItemId({ text: a })).not.toBe(contentHashItemId({ text: b }));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-02] canonical JSON is order-independent and undefined-free', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(null)).toBe('null');
  });

  it('[INV-PACK-02] within a major version, a vanished id is a build failure, not a quarantine', () => {
    const previous = [contentHashItemId({ n: 1 }), contentHashItemId({ n: 2 })];
    const next = new Set([contentHashItemId({ n: 1 }), contentHashItemId({ n: 3 })]);
    expect(additiveOnlyViolations(previous, next, { fromMajor: 1, toMajor: 1 })).toEqual([
      contentHashItemId({ n: 2 }),
    ]);
    // Adding is always fine.
    expect(
      additiveOnlyViolations(previous, new Set([...previous, contentHashItemId({ n: 9 })]), {
        fromMajor: 1,
        toMajor: 1,
      }),
    ).toEqual([]);
    // Across a major bump the rule does not apply — that is what quarantine is for.
    expect(additiveOnlyViolations(previous, next, { fromMajor: 1, toMajor: 2 })).toEqual([]);
  });

  it('[INV-PACK-02] a minor update quarantines nothing', () => {
    fc.assert(
      fc.property(arbRows, arbPackIds, (rows, itemIds) => {
        const result = applyPackUpdate(rows, { fromMajor: 3, toMajor: 3, itemIds });
        expect(result.retired).toBe(0);
        expect(result.notice).toBeNull();
        for (const [index, row] of result.rows.entries()) {
          // Only a restore can change a row inside a major version.
          if (!itemIds.has(row.itemId)) expect(row.quarantined).toBe(rows[index]!.quarantined);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-02] on a major bump unresolvable rows are quarantined and never deleted', () => {
    fc.assert(
      fc.property(arbRows, arbPackIds, (rows, itemIds) => {
        const result = applyPackUpdate(rows, { fromMajor: 1, toMajor: 2, itemIds });

        // Nothing is lost: same count, same ids, same order.
        expect(result.rows).toHaveLength(rows.length);
        expect(result.rows.map((r) => r.itemId)).toEqual(rows.map((r) => r.itemId));

        for (const row of result.rows) {
          expect(row.quarantined).toBe(!itemIds.has(row.itemId));
        }
        const newlyQuarantined = rows.filter(
          (row) => !row.quarantined && !itemIds.has(row.itemId),
        ).length;
        expect(result.retired).toBe(newlyQuarantined);
        expect(result.notice).toBe(retiredNotice(newlyQuarantined));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-02] quarantined rows stop counting toward Score and words learned', () => {
    fc.assert(
      fc.property(arbRows, arbPackIds, (rows, itemIds) => {
        const result = applyPackUpdate(rows, { fromMajor: 1, toMajor: 2, itemIds });
        const live = result.rows.filter((row) => !row.quarantined);
        expect(scoreFrom(result.rows)).toBe(
          live.reduce((sum, row) => sum + row.scoreContribution, 0),
        );
        expect(wordsLearned(result.rows)).toBe(live.filter((row) => row.learned).length);
        // ...and the quarantined ones are still there to be restored later.
        expect(result.rows.length - live.length).toBe(
          result.rows.filter((row) => row.quarantined).length,
        );
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-02] a quarantined row comes back when a pack that resolves it is installed again', () => {
    // EC-PACK-04: the export may later be restored onto a build with the older pack.
    const id = contentHashItemId({ n: 7 });
    const rows: ScheduledItem[] = [
      { itemId: id, quarantined: true, learned: true, scoreContribution: 5 },
    ];
    const restored = applyPackUpdate(rows, { fromMajor: 2, toMajor: 1, itemIds: new Set([id]) });
    expect(restored.rows[0]!.quarantined).toBe(false);
    expect(restored.restored).toBe(1);
    expect(wordsLearned(restored.rows)).toBe(1);
  });

  it('[INV-PACK-02] the update notice counts exactly what was retired', () => {
    expect(retiredNotice(0)).toBeNull();
    expect(retiredNotice(12)).toBe('12 items retired in this update');
  });
});
