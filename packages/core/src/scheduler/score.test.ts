/**
 * INV-SCH-09: displayed Score is non-decreasing over any 400-day sequence of reviews,
 * absences, zone changes and clock moves.
 *
 * EC-SCH-10's falsifier is "three days offline lowering the Score chip or the Score
 * fraction", and the bug it describes is the natural implementation: compute the Score at
 * render time from live retrievability, the same number the hub's strength bars show. It
 * costs nothing, it is always current, and it takes a number away from someone for not
 * opening an app.
 *
 * The 400-day sequence below is the invariant's own length, and it contains the four kinds
 * of event the text names: reviews (of every grade, lapses included), absences, zone
 * changes, and clock moves in both directions.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, VirtualClock, ZONES, arbInstant } from '@freelingo/testkit';
import {
  DEFAULT_PACK_SCORE_CEILING,
  ITEMS_PER_SCORE_POINT,
  MASTERY_STABILITY_DAYS,
  MS_PER_DAY,
  SCORE_SCALE_MAX,
} from './config.js';
import { dueAt, introduceRow, newRow, reviewRow, type FsrsRow } from './fsrs.js';
import {
  EMPTY_SCORE_STATE,
  displayedScore,
  observeMastery,
  rowIsMastered,
  scoreDisplayIsNonDecreasing,
  type DisplayedScore,
  type ScoreState,
} from './score.js';
import { asItemId, type Grade, type ItemId } from './types.js';

/** The invariant's own length: "any 400-day sequence". */
const DAYS = 400;

function format(score: DisplayedScore): string {
  return `${score.points}+${score.fractionToNext.toFixed(3)}`;
}

function seed(start: Date, count: number): FsrsRow[] {
  return Array.from({ length: count }, (_, i) =>
    introduceRow(newRow({ itemId: asItemId(`lex:${i}`), surface: 'x', kind: 'lexeme' }), start),
  );
}

describe('scheduler/score', () => {
  it('[INV-SCH-09] Score is the high-water set of ever-mastered items, never live strength', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    let row = seed(start, 1)[0]!;
    let at = start;
    // Review it up to mastery.
    while (!rowIsMastered(row)) {
      row = reviewRow(row, { grade: 4, now: at }).row;
      at = dueAt(row);
      if (at.getTime() - start.getTime() > 4_000 * MS_PER_DAY) break;
    }
    expect(rowIsMastered(row)).toBe(true);
    expect(row.card.stability).toBeGreaterThanOrEqual(MASTERY_STABILITY_DAYS);

    const mastered = observeMastery(EMPTY_SCORE_STATE, [row]);
    expect(mastered.masteredItemIds.has(row.itemId)).toBe(true);

    // Now forget it hard. Live strength collapses; the Score set does not move.
    const lapsed = reviewRow(row, { grade: 1, now: new Date(at.getTime() + 400 * MS_PER_DAY) }).row;
    expect(lapsed.card.stability).toBeLessThan(row.card.stability);
    const after = observeMastery(mastered, [lapsed]);
    expect(after.masteredItemIds.has(row.itemId)).toBe(true);
    expect(displayedScore(after).masteredCount).toBe(displayedScore(mastered).masteredCount);
  });

  /**
   * Two things keep this inside the timeout without touching `numRuns`.
   *
   * The 400 days are expanded from a generated PATTERN of 8-40 events rather than generated
   * one by one: fast-check building 400 structured records per case, 40,000 times, costs
   * more than every FSRS call in this file put together, and a repeating pattern of
   * reviews, absences and clock moves is the shape the invariant is about.
   *
   * And the loop makes no `expect` call. `expect` is roughly a microsecond; five of them a
   * day over 400 days over 10,000 cases is twenty million, which is most of a minute per
   * zone and, measured 2026-09-11, was enough to starve the vitest worker's RPC and produce
   * two unhandled `Timeout calling "onTaskUpdate"` errors beside a green suite. Violations
   * are collected and asserted once, which is also a better failure message.
   */
  for (const zone of ZONES) {
    it(`[INV-SCH-09] Score never falls over 400 days of reviews, absences, zone changes and clock moves (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.array(
            fc.record({
              answers: fc.integer({ min: 0, max: 2 }),
              grade: fc.constantFrom<Grade>(1, 2, 3, 4),
              rowIndex: fc.integer({ min: 0, max: 23 }),
              // A day, an absence, a clock set back or forward.
              jumpHours: fc.oneof(
                fc.integer({ min: 0, max: 72 }),
                fc.integer({ min: -240, max: -1 }),
                fc.constant(24),
              ),
            }),
            { minLength: 8, maxLength: 40 },
          ),
          (start, pattern) => {
            const clock = new VirtualClock(start);
            const rows = seed(clock.now(), 24);
            let score: ScoreState = EMPTY_SCORE_STATE;
            let shown = displayedScore(score);
            const violations: string[] = [];

            for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
              const day = pattern[dayIndex % pattern.length]!;
              // Only the rows this day touched are folded in — which is what the app does.
              const touched: FsrsRow[] = [];
              for (let a = 0; a < day.answers; a += 1) {
                const index = (day.rowIndex + a + dayIndex) % rows.length;
                rows[index] = reviewRow(rows[index]!, {
                  grade: day.grade,
                  now: clock.now(),
                }).row;
                touched.push(rows[index]!);
              }
              score = observeMastery(score, touched);
              const next = displayedScore(score);
              // The chip, and the bar under it.
              if (!scoreDisplayIsNonDecreasing(shown, next)) {
                violations.push(`day ${dayIndex}: ${format(shown)} -> ${format(next)}`);
              }
              if (next.masteredCount < shown.masteredCount) {
                violations.push(`day ${dayIndex}: mastered set shrank`);
              }
              if (next.points > next.packCeiling)
                violations.push(`day ${dayIndex}: points past the pack ceiling`);
              if (next.scaleMax !== SCORE_SCALE_MAX)
                violations.push(`day ${dayIndex}: chip denominator moved`);
              shown = next;
              clock.advanceHours(day.jumpHours);
            }

            expect(violations, `${zone.id} (${zone.why})`).toEqual([]);
            // An absence at the end changes nothing at all: the Score is a fact about what
            // was learned, not about what is remembered right now.
            const afterAbsence = displayedScore(observeMastery(score, rows));
            expect(afterAbsence.points).toBe(shown.points);
            expect(afterAbsence.masteredCount).toBe(shown.masteredCount);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-09] the scale is 0-160 and the pack ceiling clamps the numerator, not the denominator', () => {
    // The corpus number, in the two places it is stated: blog.duolingo.com/duolingo-score
    // (2024-10-23) via deep/04:147 and deep/02:98. It is NOT 150, and no observation of a
    // 150 ceiling exists; an earlier draft of config.ts invented one.
    expect(SCORE_SCALE_MAX).toBe(160);
    expect(DEFAULT_PACK_SCORE_CEILING.declaredScoreCeiling).toBe(SCORE_SCALE_MAX);

    // EC-PACK-55's own example: an A1-band beta pack completes and the chip reads 29 / 160.
    const start = new Date('2026-01-01T00:00:00Z');
    let rows = seed(start, ITEMS_PER_SCORE_POINT * 40); // 800 items -> 40 points earned
    let at = start;
    for (let round = 0; round < 12; round += 1) {
      rows = rows.map((row) => reviewRow(row, { grade: 4, now: at }).row);
      at = new Date(Math.min(...rows.map((r) => r.card.due.getTime())));
    }
    const score = observeMastery(EMPTY_SCORE_STATE, rows);
    expect(displayedScore(score).points).toBe(40);

    const beta = displayedScore(score, { packCeiling: { declaredScoreCeiling: 29 } });
    expect(beta.points).toBe(29);
    expect(beta.scaleMax).toBe(160);
    expect(beta.packCeiling).toBe(29);
    // Pack complete: there is no next point to be a fraction of the way to.
    expect(beta.fractionToNext).toBe(1);
  });

  it('[INV-SCH-09] a band floor raises the chip without being read back as mastery', () => {
    // EC-PTH-09 / INV-PATH-06: a passed jump-here sets `score_floor` to the target band's
    // floor, `displayed_score = max(score_earned, score_floor)`, "stored apart from mastery
    // and never read back by FSRS as evidence of it". So it arrives as a parameter, and
    // nothing it touches ends up in the mastered set.
    const floored = displayedScore(EMPTY_SCORE_STATE, { bandFloorPoints: 60 });
    expect(floored.points).toBe(60);
    expect(floored.masteredCount).toBe(0);
    // The bar sits at the start of the band rather than reporting mastery's own progress,
    // which would walk backwards every time mastery crossed a multiple of 20 under a
    // pinned chip.
    expect(floored.fractionToNext).toBe(0);
    expect(EMPTY_SCORE_STATE.masteredItemIds.size).toBe(0);
    expect(EMPTY_SCORE_STATE.masteryHighWaterPoints).toBe(0);

    // And it is a floor, not an override: mastery past it wins.
    const past = { masteredItemIds: new Set<ItemId>(), masteryHighWaterPoints: 75 };
    expect(displayedScore(past, { bandFloorPoints: 60 }).points).toBe(75);
  });

  it('[INV-SCH-09] the chip never falls while a band floor is pinned and mastery climbs', () => {
    // The specific regression the fraction rule above exists for: 400 steps of mastery
    // under a floor that dominates the whole way.
    let state: ScoreState = EMPTY_SCORE_STATE;
    const start = new Date('2026-01-01T00:00:00Z');
    let shown = displayedScore(state, { bandFloorPoints: 60 });
    const rows = seed(start, 400);
    for (let i = 0; i < rows.length; i += 1) {
      // Force mastery one item at a time without paying for 400 FSRS ladders.
      const mastered = { ...rows[i]!, card: { ...rows[i]!.card, stability: 999 } };
      state = observeMastery(state, [mastered]);
      const next = displayedScore(state, { bandFloorPoints: 60 });
      expect(scoreDisplayIsNonDecreasing(shown, next), `item ${i}`).toBe(true);
      shown = next;
    }
    expect(shown.masteredCount).toBe(400);
    expect(shown.points).toBe(60); // 400/20 = 20 earned, still under the floor
  });

  it('[INV-SCH-09] falsifier: three days offline do not move the chip or the fraction', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    let rows = seed(start, ITEMS_PER_SCORE_POINT * 3);
    let at = start;
    // Drive every row to mastery.
    for (let round = 0; round < 12; round += 1) {
      rows = rows.map((row) => reviewRow(row, { grade: 4, now: at }).row);
      at = new Date(Math.min(...rows.map((r) => r.card.due.getTime())));
    }
    const score = observeMastery(EMPTY_SCORE_STATE, rows);
    const before = displayedScore(score);
    expect(before.points).toBeGreaterThan(0);

    // Three days offline: ~180 items decay below the mastery threshold in EC-SCH-10's
    // telling, and the learner opens the app expecting their number to be there.
    const threeDaysLater = new Date(at.getTime() + 3 * MS_PER_DAY);
    const decayed = rows.map((row) => ({
      ...row,
      retrievability: 0.1,
      card: { ...row.card, stability: 1 },
    }));
    const after = displayedScore(observeMastery(score, decayed));
    expect(after.points).toBe(before.points);
    expect(after.fractionToNext).toBe(before.fractionToNext);
    expect(after.masteredCount).toBe(before.masteredCount);
    expect(threeDaysLater.getTime()).toBeGreaterThan(at.getTime());

    // The floor also survives a mastery threshold that somebody raises in a later release.
    const harsher = observeMastery({ ...score, masteredItemIds: new Set() }, []);
    expect(displayedScore({ ...harsher, masteryHighWaterPoints: before.points }).points).toBe(
      before.points,
    );
  });
});
