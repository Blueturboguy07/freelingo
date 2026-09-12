/**
 * INV-SCH-04: `due_items > k x session_length` surfaces a review session first, AND the
 * lesson node's generated contents are byte-identical to what they would have been.
 *
 * The second clause is the invariant. Routing is easy to get right and easy to see; the
 * quiet failure is the router reaching into the node generator — dropping the items the
 * review is about, re-weighting by due-ness, shortening the node — so that the lesson a
 * learner gets depends on how long they were away, and the path stops being a curriculum.
 * Nothing on screen would say so.
 *
 * "Byte-identical" is taken literally here: the node is serialised in both branches and the
 * two STRINGS are compared, not the objects. A deep-equal check passes on `{a: 1}` versus
 * `{a: 1.0000000000000002}` at the wrong moment and on a reordered key set always.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, ZONES, arbInstant } from '@freelingo/testkit';
import {
  dueBacklogExceeded,
  generateNodeContents,
  planCourseReentry,
  type NodeSpec,
} from './backlog.js';
import { DUE_BACKLOG_SESSION_MULTIPLIER, MS_PER_DAY } from './config.js';
import { dueAt, introduceRow, newRow, reviewRow, type FsrsRow } from './fsrs.js';
import { asItemId, type ItemId } from './types.js';

function nodeSpec(size: number, length: number): NodeSpec {
  return {
    nodeId: 'unit-3-node-2',
    itemIds: Array.from({ length: size }, (_, i) => asItemId(`lex:node:${i}`)) as ItemId[],
    length,
  };
}

/**
 * `reviews: 0` is the default because this property is about the ROUTING and the node, and
 * a backlog of 40 rows x 3 FSRS calls x 40,000 cases is five million calls spent proving
 * that a count is a count. The falsifier below uses real schedules.
 */
function dueRows(start: Date, count: number, reviews = 0): FsrsRow[] {
  return Array.from({ length: count }, (_, i) => {
    let row = introduceRow(
      newRow({ itemId: asItemId(`lex:due:${i}`), surface: 'x', kind: 'lexeme' }),
      start,
    );
    let at = start;
    for (let r = 0; r < reviews; r += 1) {
      row = reviewRow(row, { grade: 3, now: at }).row;
      at = dueAt(row);
    }
    return row;
  });
}

describe('scheduler/backlog', () => {
  it('[INV-SCH-04] the threshold is k x session_length, strictly greater', () => {
    expect(DUE_BACKLOG_SESSION_MULTIPLIER).toBe(3);
    expect(dueBacklogExceeded(45, 15)).toBe(false); // exactly k x length is not "more than"
    expect(dueBacklogExceeded(46, 15)).toBe(true);
    expect(dueBacklogExceeded(0, 15)).toBe(false);
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-04] the node's generated contents never depend on the backlog (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 1, max: 25 }),
          fc.integer({ min: 0, max: 120 }),
          (start, nodeSize, nodeLength, sessionLength, backlog) => {
            const node = nodeSpec(nodeSize, nodeLength);
            const rows = dueRows(start, Math.min(backlog, 40));

            const withBacklog = planCourseReentry({
              node,
              dueRows: rows,
              sessionLength,
            });
            const withNone = planCourseReentry({ node, dueRows: [], sessionLength });
            const reference = generateNodeContents(node);

            // Byte for byte, in both branches and against the generator on its own.
            const bytes = JSON.stringify(reference);
            expect(JSON.stringify(withBacklog.node), `${zone.id} (${zone.why})`).toBe(bytes);
            expect(JSON.stringify(withNone.node)).toBe(bytes);

            // The routing decision itself, which is allowed to differ.
            expect(withBacklog.surfaceReviewFirst).toBe(
              dueBacklogExceeded(rows.length, sessionLength),
            );
            expect(withNone.surfaceReviewFirst).toBe(false);
            expect(withNone.reviewRows).toHaveLength(0);
            if (withBacklog.surfaceReviewFirst) {
              expect(withBacklog.reviewRows.length).toBeGreaterThan(0);
              expect(withBacklog.reviewRows.length).toBeLessThanOrEqual(sessionLength);
            } else {
              expect(withBacklog.reviewRows).toHaveLength(0);
            }
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-04] the node generator is a pure function of the spec and nothing else', () => {
    const node = nodeSpec(5, 12);
    const once = JSON.stringify(generateNodeContents(node));
    for (let i = 0; i < 50; i += 1) expect(JSON.stringify(generateNodeContents(node))).toBe(once);
    // Every item of the node appears; the node is not a sample of itself.
    const contents = generateNodeContents(node);
    expect(new Set(contents.itemIds).size).toBe(5);
    expect(contents.itemIds).toHaveLength(12);
  });

  it('[INV-SCH-04] falsifier: a 200-item backlog leaves the node byte-identical', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const node = nodeSpec(7, 15);
    const fresh = planCourseReentry({ node, dueRows: [], sessionLength: 15 });

    // A learner back after three months. 200 due items against a 15-exercise session is
    // more than thirteen sessions of backlog; the popup must lead with a review.
    const rows = dueRows(new Date(start.getTime() - 400 * MS_PER_DAY), 200, 3);
    const returning = planCourseReentry({ node, dueRows: rows, sessionLength: 15 });

    expect(returning.surfaceReviewFirst).toBe(true);
    expect(returning.dueItems).toBe(200);
    expect(JSON.stringify(returning.node)).toBe(JSON.stringify(fresh.node));
    expect(returning.node.itemIds).toEqual(fresh.node.itemIds);
    // The review slice is drawn from the backlog, and never from the node's own items.
    const nodeItems = new Set<ItemId>(node.itemIds);
    for (const row of returning.reviewRows) expect(nodeItems.has(row.itemId)).toBe(false);
  });
});
