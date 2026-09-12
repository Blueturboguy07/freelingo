/**
 * INV-SCH-03: attempt rows are written exactly once per answered exercise, keyed by
 * `(session_id, exercise_index)`; replay of any commit is idempotent.
 *
 * EC-SCH-03 is the case that makes this load-bearing: an abandoned session's answers are
 * committed to FSRS (INV-SESS-11), and `START OVER` must not then double-count them
 * (EC-SES-03). Two commits of the same answers is not a cosmetic duplicate — every counter
 * in the app is recomputable from these rows (plan §Data model), so a doubled attempt is a
 * doubled XP figure, a doubled accuracy denominator and a second FSRS update at a
 * near-zero interval.
 *
 * The property is written over the ENGINE, not just the ledger, because the interesting
 * failure is not "a Map accepted two writes". It is a replayed commit that reaches FSRS
 * before anything checks the key.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, ZONES, arbInstant } from '@freelingo/testkit';
import {
  appendAttempt,
  attemptCount,
  attemptKeyOf,
  attemptLedgerOf,
  attemptsForSession,
  commitAttempts,
  hasAttempt,
  pendingAttempts,
  type AttemptKey,
  type AttemptRow,
} from './attempts.js';
import { MS_PER_DAY } from './config.js';
import { applyEncounter, emptySchedulerState, introduce, registerRows, rowAt } from './engine.js';
import { asItemId, asSessionId, type Encounter, type Grade } from './types.js';

function attempt(session: string, index: number, grade: Grade = 3, at = new Date(0)): AttemptRow {
  return {
    sessionId: asSessionId(session),
    exerciseIndex: index,
    itemId: asItemId(`lex:${index}`),
    surface: 'x',
    grade,
    at,
    reviewKind: 'scheduled',
  };
}

describe('scheduler/attempts', () => {
  it('[INV-SCH-03] the key is (session_id, exercise_index) and nothing else', () => {
    const a = attempt('s1', 0);
    const b = { ...attempt('s1', 0, 1), itemId: asItemId('lex:other'), surface: 'y' as const };
    const ledger = commitAttempts(attemptLedgerOf(), [a, b]);
    expect(attemptCount(ledger)).toBe(1);
    // First write wins: the row every counter was computed from is the row that stays.
    expect(ledger.rows.get(attemptKeyOf(asSessionId('s1'), 0))).toBe(a);
    // A different index, or a different session, is a different attempt.
    expect(attemptCount(commitAttempts(ledger, [attempt('s1', 1), attempt('s2', 0)]))).toBe(3);
    expect(hasAttempt(ledger, asSessionId('s1'), 0)).toBe(true);
    expect(hasAttempt(ledger, asSessionId('s1'), 1)).toBe(false);
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-03] any replay, in any order, any number of times, writes the same ledger (${zone.id})`, () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              session: fc.constantFrom('s1', 's2', 's3'),
              index: fc.integer({ min: 0, max: 14 }),
              grade: fc.constantFrom<Grade>(1, 2, 3, 4),
            }),
            { minLength: 1, maxLength: 40 },
          ),
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.integer({ min: 0, max: 39 }), { maxLength: 20 }),
          (answers, replays, shuffleSeed) => {
            const batch = answers.map((a) => attempt(a.session, a.index, a.grade));

            // The order the rows actually ARRIVE in: a crashed commit retried, a resumed
            // session re-grading, rows coming from two code paths. First write wins is a
            // statement about arrival order, so the reference is built from that order and
            // not from the generator's.
            const arrival = [...batch];
            for (const seed of shuffleSeed) {
              const at = seed % Math.max(1, arrival.length);
              arrival.push(...arrival.splice(at, 1));
            }

            // The reference: the arrival order de-duplicated by key, first occurrence kept.
            const expected = new Map<AttemptKey, AttemptRow>();
            for (const row of arrival) {
              const key = attemptKeyOf(row.sessionId, row.exerciseIndex);
              if (!expected.has(key)) expected.set(key, row);
            }

            let ledger = attemptLedgerOf();
            for (let i = 0; i < replays; i += 1) ledger = commitAttempts(ledger, arrival);
            // A replay that arrives in a DIFFERENT order still writes nothing: the ledger
            // already holds every key, so the order of the second delivery cannot matter.
            ledger = commitAttempts(ledger, [...arrival].reverse());

            expect(attemptCount(ledger), `${zone.id} (${zone.why})`).toBe(expected.size);
            expect([...ledger.rows.keys()].sort()).toEqual([...expected.keys()].sort());
            for (const [key, row] of expected) expect(ledger.rows.get(key)).toBe(row);
            // A further replay writes nothing at all, and says so.
            expect(pendingAttempts(ledger, arrival)).toEqual([]);
            expect(commitAttempts(ledger, arrival).rows.size).toBe(ledger.rows.size);
            for (const row of arrival) expect(appendAttempt(ledger, row)).toBe(ledger);
            // Per-session slices keep insertion order.
            for (const session of ['s1', 's2', 's3']) {
              const slice = attemptsForSession(ledger, asSessionId(session));
              expect(slice.every((r) => r.sessionId === session)).toBe(true);
            }
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  for (const zone of ZONES) {
    it(`[INV-SCH-03] a replayed commit reaches FSRS zero times (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.array(
            fc.record({
              index: fc.integer({ min: 0, max: 9 }),
              grade: fc.constantFrom<Grade>(1, 2, 3, 4),
              afterDays: fc.integer({ min: 0, max: 90 }),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (start, steps) => {
            const itemId = asItemId('lex:es:gato');
            let state = registerRows(emptySchedulerState(zone.id), [
              { itemId, surface: 'gato', kind: 'lexeme' },
            ]);
            state = introduce(state, itemId, 'gato', start);

            const encounters: Encounter[] = steps.map((step, i) => ({
              sessionId: asSessionId('s1'),
              exerciseIndex: step.index,
              itemId,
              surface: 'gato',
              role: 'recognition' as const,
              grade: step.grade,
              at: new Date(start.getTime() + (step.afterDays + i) * MS_PER_DAY),
            }));

            for (const encounter of encounters) state = applyEncounter(state, encounter).state;
            const afterFirstPass = state;

            // The same commit again. Not one FSRS write, not one anomaly row, not one
            // attempt — and the state is returned by identity, so a caller can tell.
            for (const encounter of encounters) {
              const replay = applyEncounter(state, encounter);
              expect(replay.state, `${zone.id} (${zone.why})`).toBe(state);
              expect(replay.wroteAttempt).toBe(false);
              expect(replay.review).toBeNull();
              state = replay.state;
            }
            expect(state.rows).toBe(afterFirstPass.rows);
            expect(rowAt(state, itemId, 'gato')).toBe(rowAt(afterFirstPass, itemId, 'gato'));
            expect(state.anomalies.length).toBe(afterFirstPass.anomalies.length);
            expect(attemptCount(state.attempts)).toBe(new Set(steps.map((s) => s.index)).size);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-03] falsifier: START OVER after an abandoned session does not double-count', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const itemId = asItemId('lex:es:gato');
    let state = registerRows(emptySchedulerState('America/Los_Angeles'), [
      { itemId, surface: 'gato', kind: 'lexeme' },
    ]);
    state = introduce(state, itemId, 'gato', start);

    const abandoned: Encounter[] = [0, 1, 2, 3].map((index) => ({
      sessionId: asSessionId('session-abandoned'),
      exerciseIndex: index,
      itemId,
      surface: 'gato',
      role: 'recognition',
      grade: 3,
      at: new Date(start.getTime() + index * 60_000),
    }));
    for (const encounter of abandoned) state = applyEncounter(state, encounter).state;
    const committed = rowAt(state, itemId, 'gato')!;
    expect(attemptCount(state.attempts)).toBe(4);

    // `START OVER` replays the same four answers of the same session id.
    for (const encounter of abandoned) state = applyEncounter(state, encounter).state;
    expect(attemptCount(state.attempts)).toBe(4);
    expect(rowAt(state, itemId, 'gato')).toBe(committed);

    // A genuinely NEW session with the same exercise indices is four more attempts.
    const restarted = abandoned.map((e) => ({ ...e, sessionId: asSessionId('session-restarted') }));
    for (const encounter of restarted) state = applyEncounter(state, encounter).state;
    expect(attemptCount(state.attempts)).toBe(8);
  });
});
