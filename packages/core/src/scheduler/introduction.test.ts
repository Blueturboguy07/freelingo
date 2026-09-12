/**
 * INV-SCH-10: over any local day, first-exposure items never exceed
 * `max_new_items_per_local_day`, and no lexeme reaches a production type within
 * `min_hours_between_introduction_and_production` of its introduction.
 *
 * EC-SCH-11's falsifier is "a recognition-then-production pair inside one sitting", and the
 * case that produces it is "twenty frontier lessons in four hours introduce ~120 new
 * lexemes plus their grammar-concept items". The second clause is the one with a trap in
 * it: "inside one sitting" is a statement about the CLOCK, not the calendar. A lexeme
 * introduced at 23:50 and produced at 00:10 is one sitting across two local days, and a
 * delay implemented as "not on the same local day" would wave it through — which is why
 * the day loop below deliberately generates encounters either side of midnight in each of
 * the four zones.
 *
 * The cap is never a wall (EC-SCH-11): `planIntroductions` returns a SHORTER list and the
 * caller tops the node up with reviews, so the node still completes and still pays XP.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, VirtualClock, ZONES, arbInstant } from '@freelingo/testkit';
import { localDayOf, type LocalDay } from '../day/civil.js';
import { DEFAULT_SCHEDULER_ECONOMY, MS_PER_HOUR } from './config.js';
import { applyEncounter, emptySchedulerState, introduce, registerRows } from './engine.js';
import {
  EMPTY_INTRODUCTION_LEDGER,
  firstExposuresOnDay,
  introductionRecordFor,
  planIntroductions,
  productionAllowedAt,
  recordIntroduction,
  remainingNewItemBudget,
  roleAllowedAt,
  type IntroductionLedger,
} from './introduction.js';
import { asItemId, asSessionId, type Encounter, type ItemId } from './types.js';

const ECONOMY = DEFAULT_SCHEDULER_ECONOMY;

function candidates(n: number): ItemId[] {
  return Array.from({ length: n }, (_, i) => asItemId(`lex:new:${i.toString().padStart(3, '0')}`));
}

/**
 * Hoisted, and the properties below collect violations instead of calling `expect` per
 * step, for the reason recorded in `score.test.ts`: rebuilding a 300-item pool and making
 * a few dozen `expect` calls inside every one of 40,000 cases costs more than the rules
 * being tested, and a worker starved of CPU reports RPC timeouts beside a green suite.
 */
const POOL = candidates(300);

describe('scheduler/introduction', () => {
  it('[INV-SCH-10] the two constants are the ones EC-SCH-11 names', () => {
    expect(ECONOMY.maxNewItemsPerLocalDay).toBe(40);
    expect(ECONOMY.minHoursBetweenIntroductionAndProduction).toBe(4);
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-10] first-exposure items never exceed the daily cap (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.array(
            fc.record({
              ask: fc.integer({ min: 0, max: 12 }),
              afterMinutes: fc.integer({ min: 0, max: 6 * 60 }),
              // Occasionally re-offer items already taught: a replayed node, a jump back.
              reoffer: fc.boolean(),
            }),
            // Twelve lessons of up to twelve, not twenty of twenty-five. The cap still
            // bites — 144 candidates against a budget of 40 — and the exact EC-SCH-11 case
            // ("twenty frontier lessons in four hours") has its own deterministic test
            // below. Measured 2026-09-11: the larger generator spent most of its 17 s per
            // zone inside `localDayOf`, which builds a fresh `Intl.DateTimeFormat` on every
            // call (28 us against 0.6 us for a reused one, 200k calls), and inside
            // `recordIntroduction` copying a growing Map per introduction. Neither is a
            // fact about the invariant. The first is recorded as a request against `day/`.
            { minLength: 1, maxLength: 12 },
          ),
          (start, lessons) => {
            const clock = new VirtualClock(start);
            let ledger: IntroductionLedger = EMPTY_INTRODUCTION_LEDGER;
            let nextFresh = 0;
            const days = new Set<LocalDay>();
            const violations: string[] = [];

            for (const lesson of lessons) {
              clock.advanceMs(lesson.afterMinutes * 60_000);
              const now = clock.now();
              const day = localDayOf(now, zone.id);
              days.add(day);

              const offered = lesson.reoffer
                ? POOL.slice(0, lesson.ask)
                : POOL.slice(nextFresh, nextFresh + lesson.ask);
              const budget = remainingNewItemBudget(ledger, day, ECONOMY);
              const planned = planIntroductions(ledger, day, offered, ECONOMY);

              // Never more than the budget, never an item already taught, never a refusal
              // that isn't simply a shorter list.
              if (planned.length > budget) violations.push(`${day}: ${planned.length} > ${budget}`);
              if (new Set(planned).size !== planned.length) violations.push(`${day}: duplicates`);
              for (const id of planned) {
                if (ledger.firstIntroducedAt.has(id))
                  violations.push(`${day}: ${id} re-introduced`);
                ledger = recordIntroduction(ledger, introductionRecordFor(id, 'x', now, zone.id));
              }
              if (!lesson.reoffer) nextFresh += lesson.ask;
            }

            // The invariant, over every local day the history touched.
            for (const day of days) {
              const exposures = firstExposuresOnDay(ledger, day);
              if (exposures > ECONOMY.maxNewItemsPerLocalDay) {
                violations.push(`${day}: ${exposures} first exposures`);
              }
            }
            expect(violations, `${zone.id} (${zone.why})`).toEqual([]);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  for (const zone of ZONES) {
    it(`[INV-SCH-10] no lexeme reaches a production type inside the delay (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.array(fc.integer({ min: 0, max: 24 * 60 }), { minLength: 1, maxLength: 25 }),
          (introducedAt, offsetsMinutes) => {
            const itemId = asItemId('lex:es:gato');
            const ledger = recordIntroduction(
              EMPTY_INTRODUCTION_LEDGER,
              introductionRecordFor(itemId, 'gato', introducedAt, zone.id),
            );
            const delayMs = ECONOMY.minHoursBetweenIntroductionAndProduction * MS_PER_HOUR;

            const violations: string[] = [];
            for (const minutes of offsetsMinutes) {
              // Both signs: a later encounter, and one on a clock that went backwards.
              for (const sign of [1, -1]) {
                const at = new Date(introducedAt.getTime() + sign * minutes * 60_000);
                const allowed = productionAllowedAt(ledger, itemId, at, ECONOMY);
                const shouldAllow = at.getTime() - introducedAt.getTime() >= delayMs;
                if (allowed !== shouldAllow) violations.push(`${sign * minutes}min: ${allowed}`);
                // Recognition is never delayed; only production is.
                if (!roleAllowedAt(ledger, itemId, 'recognition', at, ECONOMY)) {
                  violations.push(`${sign * minutes}min: recognition refused`);
                }
                if (roleAllowedAt(ledger, itemId, 'production', at, ECONOMY) !== allowed) {
                  violations.push(`${sign * minutes}min: role gate disagrees`);
                }
              }
            }
            expect(violations, `${zone.id} (${zone.why})`).toEqual([]);
            // An item nobody introduced can be produced at no time at all.
            const unknown = asItemId('lex:es:perro');
            expect(productionAllowedAt(ledger, unknown, introducedAt, ECONOMY)).toBe(false);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-10] falsifier: a recognition-then-production pair inside one sitting', () => {
    const zone = 'Asia/Tokyo';
    const introducedAt = new Date('2026-03-05T14:50:00Z'); // 23:50 local, one sitting
    const itemId = asItemId('lex:es:gato');

    let state = registerRows(emptySchedulerState(zone), [
      { itemId, surface: 'gato', kind: 'lexeme' },
    ]);
    state = introduce(state, itemId, 'gato', introducedAt);

    // Twenty minutes later: a new local day in this zone, and still the same sitting.
    const twentyMinutesLater = new Date(introducedAt.getTime() + 20 * 60_000);
    expect(localDayOf(twentyMinutesLater, zone)).not.toBe(localDayOf(introducedAt, zone));

    const production: Encounter = {
      sessionId: asSessionId('s1'),
      exerciseIndex: 0,
      itemId,
      surface: 'gato',
      role: 'production',
      grade: 3,
      at: twentyMinutesLater,
    };
    const refused = applyEncounter(state, production);
    expect(refused.review).toBeNull();
    expect(refused.wroteAttempt).toBe(true); // it happened; it is on the record
    expect(refused.state.anomalies.map((a) => a.kind)).toContain('productionTooSoon');
    // Nothing was credited: the row map is the one the introduction left behind.
    expect(refused.state.rows).toBe(state.rows);

    // Four hours after introduction it is allowed, and it credits.
    const later = new Date(introducedAt.getTime() + 4 * MS_PER_HOUR);
    const allowed = applyEncounter(refused.state, { ...production, exerciseIndex: 1, at: later });
    expect(allowed.review?.kind).toBe('scheduled');
  });

  it('[INV-SCH-10] the cap is a shorter list, never a wall', () => {
    const zone = 'America/Los_Angeles';
    const at = new Date('2026-03-05T17:00:00Z');
    const day = localDayOf(at, zone);
    let ledger = EMPTY_INTRODUCTION_LEDGER;
    const pool = candidates(120);

    // Six lessons of ten new items each, then four more.
    for (let lesson = 0; lesson < 12; lesson += 1) {
      const offered = pool.slice(lesson * 10, lesson * 10 + 10);
      const planned = planIntroductions(ledger, day, offered, ECONOMY);
      for (const id of planned) {
        ledger = recordIntroduction(ledger, introductionRecordFor(id, 'x', at, zone));
      }
    }
    expect(firstExposuresOnDay(ledger, day)).toBe(ECONOMY.maxNewItemsPerLocalDay);
    // The thirteenth lesson gets zero new items — and zero is a review-only draw, not an
    // error and not a blocked node.
    expect(planIntroductions(ledger, day, pool.slice(110), ECONOMY)).toEqual([]);
    expect(remainingNewItemBudget(ledger, day, ECONOMY)).toBe(0);
  });

  it('[INV-SCH-11] a second surface of a word taught today is not a first exposure', () => {
    const zone = 'Asia/Tokyo';
    const at = new Date('2026-03-05T02:00:00Z');
    const day = localDayOf(at, zone);
    const itemId = asItemId('lex:ja:neko');
    let ledger = recordIntroduction(
      EMPTY_INTRODUCTION_LEDGER,
      introductionRecordFor(itemId, 'ねこ', at, zone),
    );
    expect(firstExposuresOnDay(ledger, day)).toBe(1);
    // EC-SCH-12: the kanji surface gets its own introduction beat...
    ledger = recordIntroduction(
      ledger,
      introductionRecordFor(itemId, '猫', new Date(at.getTime() + MS_PER_HOUR), zone),
    );
    expect(ledger.records).toHaveLength(2);
    // ...and does not spend a second slot of the day's budget, nor restart the delay.
    expect(firstExposuresOnDay(ledger, day)).toBe(1);
    expect(ledger.firstIntroducedAt.get(itemId)!.getTime()).toBe(at.getTime());
  });
});
