/**
 * INV-SCH-01, INV-SCH-02, INV-SCH-11, INV-SCH-12.
 *
 * The four rules the FSRS wrapper adds to ts-fsrs, each with the long history the
 * invariant text names, each on the testkit virtual clock in each of the four zones.
 *
 * WHY ONE `it()` PER ZONE rather than a zone loop inside one: the floor is
 * `PROPERTY_RUNS` cases IN EACH zone (testkit/config.ts), a 500-review history is 500
 * FSRS steps, and 40,000 x 500 in a single test does not fit the 60-second per-test
 * timeout. Four tests of 10,000 each fit comfortably and assert exactly the same thing.
 * The number of runs is never the thing that gets lowered.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { S_MAX, State } from 'ts-fsrs';
import { PROPERTY_RUNS, VirtualClock, ZONES } from '@freelingo/testkit';
import {
  EARLY_REVIEW_FRACTION,
  MAXIMUM_INTERVAL_DAYS,
  MAX_HONEST_ELAPSED_MS,
  MS_PER_DAY,
} from './config.js';
import {
  dueAt,
  replayOnHonestClock,
  introduceRow,
  isEarlyReview,
  newRow,
  reviewRow,
  scheduledIntervalMs,
  type FsrsRow,
  type ReviewResult,
} from './fsrs.js';
import { asItemId, type Grade } from './types.js';

const ITEM = asItemId('lex:es:gato');
const SURFACE = 'gato';

function seedRow(at: Date, kind: 'lexeme' | 'grapheme' = 'lexeme'): FsrsRow {
  return introduceRow(newRow({ itemId: ITEM, surface: SURFACE, kind }), at);
}

/** Grades that are not a lapse. See the note on the median property below. */
const NON_LAPSE: readonly Grade[] = [2, 3, 4];

/**
 * Drive a history at a fixed CADENCE: each next review happens at
 * `fraction x (the interval the row is currently carrying)` after the last one.
 *
 * `fraction < 0.6` is the case EC-SCH-01 is about — "20 sessions a day re-encounter items
 * far ahead of their due date". `fraction >= 1` is a learner who is late. The clock is the
 * testkit's `VirtualClock`, advanced explicitly; nothing here reads `Date.now()`.
 */
function runCadence(
  start: Date,
  fraction: number,
  grades: readonly Grade[],
): { results: ReviewResult[]; row: FsrsRow } {
  const clock = new VirtualClock(start);
  let row = seedRow(clock.now());
  const results: ReviewResult[] = [];
  for (const grade of grades) {
    const now = clock.now();
    const result = reviewRow(row, { grade, now });
    results.push(result);
    row = result.row;
    const aheadMs = Math.max(dueAt(row).getTime() - now.getTime(), 60_000);
    clock.advanceMs(Math.max(60_000, Math.round(aheadMs * fraction)));
  }
  return { results, row };
}

/** The running median of a sequence, one value per prefix. */
function runningMedians(values: readonly number[]): number[] {
  const sorted: number[] = [];
  const medians: number[] = [];
  for (const value of values) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 0, value);
    const n = sorted.length;
    medians.push(n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
  }
  return medians;
}

function isNonDecreasing(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i += 1) if (values[i]! < values[i - 1]!) return false;
  return true;
}

/**
 * Cadences, log-spread from "twenty sessions a day" to "a week late".
 *
 * Log-uniform rather than uniform because the invariant lives at the small end: uniform on
 * [0, 2] would spend 70% of the budget on cadences above the 0.6 threshold, where the
 * guard never fires and the property asserts that ts-fsrs is ts-fsrs.
 */
function arbCadence(): fc.Arbitrary<number> {
  return fc.integer({ min: -3000, max: 400 }).map((milli) => Math.pow(10, milli / 1000));
}

function arbNonLapseGrades(maxLength: number): fc.Arbitrary<Grade[]> {
  return fc.array(fc.constantFrom(...NON_LAPSE), { minLength: 2, maxLength });
}

/** A start instant inside a generated zone, so histories can begin on a DST-shift day. */
function arbStart(): fc.Arbitrary<Date> {
  return fc.date({
    min: new Date('2026-01-01T00:00:00Z'),
    max: new Date('2026-12-31T23:59:00Z'),
    noInvalidDate: true,
  });
}

describe('scheduler/fsrs', () => {
  /* ================================================================== INV-SCH-01 */

  it('[INV-SCH-01] an early review updates retrievability and moves nothing else', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    let row = seedRow(start);
    // Four honest reviews to get the card into the Review state with a real interval.
    let at = start;
    for (let i = 0; i < 4; i += 1) {
      const result = reviewRow(row, { grade: 3, now: at });
      row = result.row;
      at = dueAt(row);
    }
    expect(row.card.state).toBe(State.Review);
    expect(row.card.scheduled_days).toBeGreaterThan(1);

    const before = row;
    const early = new Date(
      (row.card.last_review ?? start).getTime() +
        Math.floor(EARLY_REVIEW_FRACTION * scheduledIntervalMs(row)) -
        1,
    );
    const result = reviewRow(row, { grade: 3, now: early });

    expect(result.kind).toBe('early');
    expect(result.row.lastReviewKind).toBe('early');
    // The four scheduling fields. Not "roughly equal": identical.
    expect(result.row.card.stability).toBe(before.card.stability);
    expect(result.row.card.difficulty).toBe(before.card.difficulty);
    expect(result.row.card.due.getTime()).toBe(before.card.due.getTime());
    expect(result.row.card.scheduled_days).toBe(before.card.scheduled_days);
    // Retrievability is the field that does move.
    expect(result.row.retrievability).not.toBe(before.retrievability);
    expect(result.row.retrievability).toBeGreaterThan(0);

    // One millisecond later is 0.6x exactly, and is no longer early.
    const onTime = new Date(early.getTime() + 1);
    const scheduled = reviewRow(before, { grade: 3, now: onTime });
    expect(scheduled.kind).toBe('scheduled');
    expect(scheduled.row.card.due.getTime()).toBeGreaterThan(before.card.due.getTime());
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-01] 500 reviews at any cadence: the interval and its median never fall (${zone.id})`, () => {
      fc.assert(
        fc.property(arbStart(), arbCadence(), arbNonLapseGrades(500), (start, fraction, grades) => {
          const { results } = runCadence(start, fraction, grades);
          const intervals = results.map((r) => r.intervalDays);

          // The invariant's own clause.
          expect(isNonDecreasing(runningMedians(intervals)), `${zone.id} (${zone.why})`).toBe(true);
          // Strictly stronger, and the clause the guard actually buys: measured
          // 2026-09-11, removing the guard produces up to 28 outright interval
          // decreases in a 500-review non-lapse history, and a median decrease in
          // roughly one history in four hundred.
          expect(isNonDecreasing(intervals)).toBe(true);

          for (let i = 0; i < results.length; i += 1) {
            const result = results[i]!;
            if (result.kind !== 'early') continue;
            const previous = i === 0 ? null : results[i - 1]!.row;
            if (previous === null) continue;
            // An early review never moves the schedule, whatever else happened.
            expect(result.row.card).toBe(previous.card);
            expect(result.intervalDays).toBe(previous.card.scheduled_days);
            expect(result.effectiveElapsedMs).toBeLessThan(
              EARLY_REVIEW_FRACTION * previous.card.scheduled_days * MS_PER_DAY,
            );
          }
          // The stored interval never exceeds the algorithm's own ceiling.
          for (const interval of intervals) {
            expect(interval).toBeLessThanOrEqual(MAXIMUM_INTERVAL_DAYS);
          }
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-01] falsifier: the 0.01x cadence that reaches maximum stability in 306 days', () => {
    const falsifier = loadFalsifier('inv-sch-01');
    const grades = falsifier.grades as Grade[];
    const { results, row } = runCadence(
      new Date(falsifier.start as string),
      falsifier.cadenceFraction as number,
      grades,
    );
    const earlies = results.filter((r) => r.kind === 'early').length;
    // Measured 2026-09-11 with the guard REMOVED: this history drives stability to the
    // 36,500-day ceiling inside 64,934 simulated days of a learner who never waits. With
    // the guard, 493 of the 500 answers are logged as `early`, the interval sequence is
    // flat where it should be flat, and the card is nowhere near saturation.
    expect(earlies).toBeGreaterThanOrEqual(falsifier.minimumEarlyReviews as number);
    expect(row.card.stability).toBeLessThan(falsifier.stabilityCeiling as number);
    expect(isNonDecreasing(results.map((r) => r.intervalDays))).toBe(true);
  });

  /* ================================================================== INV-SCH-02 */

  it('[INV-SCH-02] a backward clock is clamped to zero and writes an anomaly row', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    let row = seedRow(start);
    let at = start;
    for (let i = 0; i < 5; i += 1) {
      row = reviewRow(row, { grade: 3, now: at }).row;
      at = dueAt(row);
    }
    const lastReview = row.card.last_review!;
    const backwards = new Date(lastReview.getTime() - 365 * MS_PER_DAY);

    // ts-fsrs itself throws on this input: measured 2026-09-11, `Invalid delta_t "-202"`.
    const result = reviewRow(row, { grade: 3, now: backwards });
    expect(result.effectiveElapsedMs).toBe(0);
    expect(result.rawElapsedMs).toBeLessThan(0);
    expect(result.anomalies.map((a) => a.kind)).toContain('negativeElapsed');
    expect(Number.isFinite(result.row.card.stability)).toBe(true);
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-02] no adversarial clock beats the honest-clock bound (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbStart(),
          fc.array(
            fc.record({
              grade: fc.constantFrom<Grade>(1, 2, 3, 4),
              // Jumps in hours, including a decade backwards and three centuries forward.
              jumpHours: fc.oneof(
                fc.integer({ min: -3_000_000, max: 3_000_000 }),
                fc.integer({ min: -48, max: 48 }),
              ),
            }),
            { minLength: 1, maxLength: 60 },
          ),
          (start, steps) => {
            const clock = new VirtualClock(start);
            let row = seedRow(clock.now());
            const honestSteps: { grade: Grade; effectiveElapsedMs: number }[] = [];

            for (const step of steps) {
              const before = row;
              // ts-fsrs itself throws on a sufficiently negative elapsed (measured
              // 2026-09-11: `Invalid delta_t "-202"`), so reaching the next line at all is
              // part of the assertion.
              const result = reviewRow(row, { grade: step.grade, now: clock.now() });
              row = result.row;

              // Never NaN, never negative, never past the algorithm's own ceiling.
              expect(Number.isFinite(row.card.stability), `${zone.id} (${zone.why})`).toBe(true);
              expect(row.card.stability).toBeGreaterThan(0);
              expect(row.card.stability).toBeLessThanOrEqual(S_MAX);
              expect(Number.isFinite(row.card.due.getTime())).toBe(true);
              // What the clamp claims, literally: whatever the clock said, what reached
              // the algorithm was inside the honest window.
              expect(result.effectiveElapsedMs).toBeGreaterThanOrEqual(0);
              expect(result.effectiveElapsedMs).toBeLessThanOrEqual(MAX_HONEST_ELAPSED_MS);
              // Every clamp is on the record.
              if (result.rawElapsedMs < 0) {
                expect(result.effectiveElapsedMs).toBe(0);
                expect(result.anomalies.map((a) => a.kind)).toContain('negativeElapsed');
              }
              if (result.rawElapsedMs > MAX_HONEST_ELAPSED_MS) {
                expect(result.effectiveElapsedMs).toBe(MAX_HONEST_ELAPSED_MS);
                expect(result.anomalies.map((a) => a.kind)).toContain('implausibleElapsed');
              }
              if (result.kind === 'scheduled') {
                honestSteps.push({
                  grade: step.grade,
                  effectiveElapsedMs: result.effectiveElapsedMs,
                });
              } else {
                // Everything else is a no-op on the schedule, which is why the replay can
                // leave it out — asserted here rather than assumed.
                expect(result.row.card).toBe(before.card);
              }
              clock.advanceMs(step.jumpHours * 3_600_000);
            }

            // THE BOUND. Replaying the same grades on a strictly monotone clock, waiting
            // the elapsed the clamp produced, lands on the same state — so the adversarial
            // outcome is not merely below the honest-clock bound, it IS an honest outcome,
            // and here is the honest clock that produces it. That is a proof rather than an
            // estimate, which matters because stability is not monotone in elapsed across
            // states and grades: the analytic ceiling this replaced was falsified by
            // `[Easy, Again]` reaching 8.2956 against a computed ceiling of 3.9056.
            const honestRow = replayOnHonestClock(seedRow(start), honestSteps, start);
            expect(honestRow.card.stability).toBeCloseTo(row.card.stability, 9);
            expect(honestRow.card.difficulty).toBeCloseTo(row.card.difficulty, 9);
            expect(honestRow.card.scheduled_days).toBe(row.card.scheduled_days);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-02] falsifier: the week-back clock that used to move stability', () => {
    const falsifier = loadFalsifier('inv-sch-02');
    const start = new Date(falsifier.start as string);
    let row = seedRow(start);
    let at = start;
    for (let i = 0; i < (falsifier.honestReviews as number); i += 1) {
      row = reviewRow(row, { grade: 3, now: at }).row;
      at = dueAt(row);
    }
    const before = row;
    for (const backDays of falsifier.backwardJumpsDays as number[]) {
      const tampered = new Date(before.card.last_review!.getTime() - backDays * MS_PER_DAY);
      const result = reviewRow(before, { grade: 3, now: tampered });
      expect(result.effectiveElapsedMs).toBe(0);
      expect(result.anomalies.some((a) => a.kind === 'negativeElapsed')).toBe(true);
      expect(Number.isFinite(result.row.card.stability)).toBe(true);
    }
  });

  /* ================================================================== INV-SCH-11 */

  it('[INV-SCH-11] FSRS rows are keyed (item, surface) and each surface carries its own state', () => {
    const at = new Date('2026-03-01T09:00:00Z');
    const kana = introduceRow(
      newRow({ itemId: asItemId('lex:ja:neko'), surface: 'ねこ', kind: 'lexeme' }),
      at,
    );
    const kanji = newRow({ itemId: asItemId('lex:ja:neko'), surface: '猫', kind: 'lexeme' });

    expect(kana.key).not.toBe(kanji.key);
    const reviewed = reviewRow(kana, { grade: 3, now: at });
    expect(reviewed.kind).toBe('scheduled');
    // The kanji surface has no introduction beat, so it is neither renderable nor
    // creditable — EC-SCH-12's "a kana-only learner meets a kanji nobody taught them".
    const stolen = reviewRow(kanji, { grade: 3, now: at });
    expect(stolen.kind).toBe('uncredited');
    expect(stolen.row.card.stability).toBe(kanji.card.stability);
    expect(stolen.row.card.due.getTime()).toBe(kanji.card.due.getTime());
    expect(stolen.anomalies.map((a) => a.kind)).toContain('uncreditedSurface');
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-11] no surface is ever credited without a prior introduction beat (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbStart(),
          fc.array(
            fc.record({
              surface: fc.constantFrom('ねこ', '猫', 'neko'),
              introduce: fc.boolean(),
              grade: fc.constantFrom<Grade>(1, 2, 3, 4),
              afterHours: fc.integer({ min: 0, max: 20_000 }),
            }),
            { minLength: 1, maxLength: 40 },
          ),
          (start, steps) => {
            const clock = new VirtualClock(start);
            const rows = new Map<string, FsrsRow>(
              ['ねこ', '猫', 'neko'].map((s) => [
                s,
                newRow({ itemId: asItemId('lex:ja:neko'), surface: s, kind: 'lexeme' }),
              ]),
            );
            for (const step of steps) {
              clock.advanceHours(step.afterHours);
              const row = rows.get(step.surface)!;
              if (step.introduce) {
                rows.set(step.surface, introduceRow(row, clock.now()));
                continue;
              }
              const result = reviewRow(row, { grade: step.grade, now: clock.now() });
              if (row.introducedAt === null) {
                expect(result.kind, `${zone.id} (${zone.why})`).toBe('uncredited');
                expect(result.row.card).toBe(row.card);
              } else {
                expect(result.kind).not.toBe('uncredited');
              }
              rows.set(step.surface, result.row);
            }
            // A surface never introduced is never scheduled, however many answers landed.
            for (const row of rows.values()) {
              if (row.introducedAt !== null) continue;
              expect(row.card.state).toBe(State.New);
              expect(row.card.reps).toBe(0);
            }
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  /* ================================================================== INV-SCH-12 */

  for (const zone of ZONES) {
    it(`[INV-SCH-12] no ruby-on encounter moves a grapheme's stability or due_at (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbStart(),
          fc.array(
            fc.record({
              rubyShown: fc.boolean(),
              grade: fc.constantFrom<Grade>(1, 2, 3, 4),
              afterHours: fc.integer({ min: 1, max: 2_000 }),
            }),
            { minLength: 1, maxLength: 40 },
          ),
          (start, steps) => {
            const clock = new VirtualClock(start);
            let grapheme = seedRow(clock.now(), 'grapheme');
            let lexeme = seedRow(clock.now(), 'lexeme');
            for (const step of steps) {
              clock.advanceHours(step.afterHours);
              const now = clock.now();
              const before = grapheme;
              const g = reviewRow(grapheme, { grade: step.grade, now, rubyShown: step.rubyShown });
              const l = reviewRow(lexeme, { grade: step.grade, now, rubyShown: step.rubyShown });
              if (step.rubyShown) {
                expect(g.kind, `${zone.id} (${zone.why})`).toBe('rubyAssisted');
                expect(g.row.card).toBe(before.card);
                expect(g.row.card.stability).toBe(before.card.stability);
                expect(g.row.card.due.getTime()).toBe(before.card.due.getTime());
                // Furigana is a display choice: the LEXEME still schedules normally.
                expect(l.kind).not.toBe('rubyAssisted');
              }
              grapheme = g.row;
              lexeme = l.row;
            }
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-12] falsifier: twelve ruby-on sightings of 学校 leave 学 exactly where it was', () => {
    const falsifier = loadFalsifier('inv-sch-12');
    const start = new Date(falsifier.start as string);
    let grapheme = introduceRow(
      newRow({
        itemId: asItemId(falsifier.graphemeItemId as string),
        surface: '学',
        kind: 'grapheme',
      }),
      start,
    );
    const before = grapheme;
    const clock = new VirtualClock(start);
    for (let i = 0; i < (falsifier.rubyOnEncounters as number); i += 1) {
      clock.advanceHours(falsifier.hoursBetweenEncounters as number);
      grapheme = reviewRow(grapheme, { grade: 3, now: clock.now(), rubyShown: true }).row;
    }
    expect(grapheme.card.stability).toBe(before.card.stability);
    expect(grapheme.card.due.getTime()).toBe(before.card.due.getTime());
    expect(grapheme.card.state).toBe(before.card.state);
    // And a single ruby-OFF encounter does move it, or the item could never be learned.
    clock.advanceHours(falsifier.hoursBetweenEncounters as number);
    const unaided = reviewRow(grapheme, { grade: 3, now: clock.now(), rubyShown: false });
    expect(unaided.kind).toBe('scheduled');
    expect(unaided.row.card.due.getTime()).toBeGreaterThan(before.card.due.getTime());
  });

  /* =================================================================== the guard */

  it('[INV-SCH-01] a learning-step card is never treated as early', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const row = seedRow(start);
    expect(row.card.state).toBe(State.New);
    // A New card has no scheduled interval worth the name; freezing it here would leave
    // it on learning step one forever.
    expect(isEarlyReview(row, 0)).toBe(false);
    const first = reviewRow(row, { grade: 3, now: start });
    expect(first.kind).toBe('scheduled');
  });
});

/** Committed falsifier inputs, one file per invariant (plan §The build workflow, step 2). */
function loadFalsifier(id: string): Record<string, unknown> {
  const path = new URL(`./__falsifiers__/${id}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
