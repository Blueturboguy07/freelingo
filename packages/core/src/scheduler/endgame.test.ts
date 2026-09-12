/**
 * INV-SCH-06: the endgame generator terminates, is non-empty while anything is due,
 * returns `Come back later...` when nothing is, and never introduces an unseen item.
 *
 * EC-SCH-06: "Course finished; the learner still wants 20 sessions... Without it, session 7
 * of a completed-course day has no legal source." The failure this catches is not a crash;
 * it is the generator reaching for an uncredited row to fill a short session, which hands
 * the learner content nobody taught them (INV-SCH-11) and mints an introduction outside the
 * daily budget (INV-SCH-10) — two invariants broken by one convenience.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, VirtualClock, ZONES, arbInstant } from '@freelingo/testkit';
import { MS_PER_DAY } from './config.js';
import { dueCount, eligibleDueRows, generateEndgameSession, orderByOverdue } from './endgame.js';
import {
  dueAt,
  introduceRow,
  isIntroduced,
  newRow,
  overdueMsAt,
  reviewRow,
  type FsrsRow,
} from './fsrs.js';
import { disableModality } from './holds.js';
import { asItemId, type Grade, type ItemId } from './types.js';

function introducedRow(start: Date, id: string, reviews: number): FsrsRow {
  let row = introduceRow(newRow({ itemId: asItemId(id), surface: 'x', kind: 'lexeme' }), start);
  let at = start;
  for (let i = 0; i < reviews; i += 1) {
    row = reviewRow(row, { grade: 3, now: at }).row;
    at = dueAt(row);
  }
  return row;
}

function unseenRow(id: string): FsrsRow {
  return newRow({ itemId: asItemId(id), surface: 'x', kind: 'lexeme' });
}

describe('scheduler/endgame', () => {
  it('[INV-SCH-06] non-empty while anything is due, `Come back later...` when nothing is', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const rows = [introducedRow(start, 'lex:a', 3), introducedRow(start, 'lex:b', 4)];
    const far = new Date(start.getTime() + 4_000 * MS_PER_DAY);

    const session = generateEndgameSession({ rows, at: far, sessionLength: 15 });
    expect(session.kind).toBe('session');
    if (session.kind === 'session') expect(session.rows.length).toBeGreaterThan(0);

    // Nothing due: every row is still inside its interval.
    const soon = new Date(Math.min(...rows.map((r) => r.card.due.getTime())) - MS_PER_DAY);
    expect(rows.every((r) => overdueMsAt(r, soon) < 0)).toBe(true);
    expect(generateEndgameSession({ rows, at: soon, sessionLength: 15 }).kind).toBe(
      'comeBackLater',
    );
    // And an empty course is the same state, not a crash.
    expect(generateEndgameSession({ rows: [], at: far, sessionLength: 15 }).kind).toBe(
      'comeBackLater',
    );
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-06] never introduces an unseen item, at any clock (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 0, max: 1_000 }),
          fc.array(fc.record({ reviews: fc.integer({ min: 0, max: 5 }), seen: fc.boolean() }), {
            minLength: 0,
            maxLength: 15,
          }),
          fc.integer({ min: 1, max: 30 }),
          (start, ageDays, specs, sessionLength) => {
            const rows = specs.map((spec, i) =>
              spec.seen ? introducedRow(start, `lex:${i}`, spec.reviews) : unseenRow(`lex:${i}`),
            );
            const at = new Date(start.getTime() + ageDays * MS_PER_DAY);
            const session = generateEndgameSession({ rows, at, sessionLength });

            const due = eligibleDueRows({ rows, at, sessionLength });
            if (due.length === 0) {
              expect(session.kind, `${zone.id} (${zone.why})`).toBe('comeBackLater');
            } else {
              expect(session.kind).toBe('session');
              if (session.kind === 'session') {
                expect(session.rows.length).toBeGreaterThan(0);
                expect(session.rows.length).toBeLessThanOrEqual(sessionLength);
                for (const row of session.rows) {
                  // The clause that would be quiet if it broke.
                  expect(isIntroduced(row)).toBe(true);
                  expect(overdueMsAt(row, at)).toBeGreaterThanOrEqual(0);
                }
                // No duplicates inside one session.
                expect(new Set(session.rows.map((r) => r.key)).size).toBe(session.rows.length);
              }
            }
            expect(dueCount({ rows, at, sessionLength })).toBe(due.length);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  for (const zone of ZONES) {
    it(`[INV-SCH-06] the generate-answer-regenerate loop terminates (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 1, max: 6 }),
          (start, itemCount, sessionLength) => {
            const clock = new VirtualClock(start);
            let rows = Array.from({ length: itemCount }, (_, i) =>
              introducedRow(start, `lex:${i}`, 2),
            );
            clock.advanceMs(3_000 * MS_PER_DAY);

            // Every due item answered correctly, repeatedly, at a FIXED instant: the only
            // way the loop can end is by the due set genuinely emptying.
            let iterations = 0;
            const limit = itemCount + 2;
            for (; iterations <= limit; iterations += 1) {
              const session = generateEndgameSession({
                rows,
                at: clock.now(),
                sessionLength,
              });
              if (session.kind === 'comeBackLater') break;
              const answered = new Map<string, FsrsRow>();
              for (const row of session.rows) {
                answered.set(row.key, reviewRow(row, { grade: 3, now: clock.now() }).row);
              }
              rows = rows.map((row) => answered.get(row.key) ?? row);
            }
            expect(iterations, `${zone.id} (${zone.why})`).toBeLessThanOrEqual(limit);
            expect(generateEndgameSession({ rows, at: clock.now(), sessionLength }).kind).toBe(
              'comeBackLater',
            );
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-06] the ordering is deterministic: most overdue first, ties by row key', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const rows = [
      introducedRow(start, 'lex:c', 2),
      introducedRow(start, 'lex:a', 4),
      introducedRow(start, 'lex:b', 2),
    ];
    const at = new Date(start.getTime() + 1_000 * MS_PER_DAY);
    const once = orderByOverdue(rows, at).map((r) => r.key);
    const twice = orderByOverdue([...rows].reverse(), at).map((r) => r.key);
    expect(once).toEqual(twice);
    // `lex:b` and `lex:c` carry the same schedule, so the tie is broken by row key.
    const keyB = rows.find((r) => r.itemId === 'lex:b')!.key;
    const keyC = rows.find((r) => r.itemId === 'lex:c')!.key;
    expect(once.indexOf(keyB)).toBeLessThan(once.indexOf(keyC));
  });

  it('[INV-SCH-06] falsifier: session 7 of a completed-course day has a legal source', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    // Twenty sessions of fifteen is 300 answers, so the pool must be able to feed them.
    const rows = Array.from({ length: 400 }, (_, i) =>
      introducedRow(start, `lex:${i.toString().padStart(3, '0')}`, 3),
    );
    const unseen = Array.from({ length: 50 }, (_, i) => unseenRow(`lex:new:${i}`));
    const at = new Date(start.getTime() + 900 * MS_PER_DAY);

    const seenIds = new Set<ItemId>(rows.map((r) => r.itemId));
    let pool = [...rows, ...unseen];
    for (let session = 1; session <= 20; session += 1) {
      const generated = generateEndgameSession({ rows: pool, at, sessionLength: 15 });
      expect(generated.kind).toBe('session');
      if (generated.kind !== 'session') break;
      for (const row of generated.rows) {
        // Twenty sessions in one day and not one of them reaches for a new item.
        expect(seenIds.has(row.itemId)).toBe(true);
      }
      const grade: Grade = 3;
      const answered = new Map(
        generated.rows.map((row) => [row.key, reviewRow(row, { grade, now: at }).row]),
      );
      pool = pool.map((row) => answered.get(row.key) ?? row);
    }
  });

  it('[INV-SCH-06] a held item is not a due item', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const row = introduceRow(
      newRow({
        itemId: asItemId('lex:listen'),
        surface: 'x',
        kind: 'lexeme',
        modalities: ['listening'],
      }),
      start,
    );
    const at = new Date(start.getTime() + 500 * MS_PER_DAY);
    const holds = [disableModality('listening', new Date(start.getTime() + MS_PER_DAY))];
    expect(eligibleDueRows({ rows: [row], at, sessionLength: 15 })).toHaveLength(1);
    expect(eligibleDueRows({ rows: [row], at, sessionLength: 15, holds })).toHaveLength(0);
  });
});
