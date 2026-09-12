/**
 * INV-CER-01, engine half.
 *
 * `packages/schema` owns the test that the commit is ONE exclusive transaction (a kill
 * mid-ceremony leaves nothing applied). This file owns the pure half: what the engine
 * decides to apply, and that a replayed session_id decides to apply nothing.
 *
 * It exists because nightly mutation testing scored ceremony/ at 0.00 with every mutant
 * uncovered: the only INV-CER-01 tests lived in the schema project, which Stryker does
 * not run, so the engine function was formally unexercised while the coverage map read
 * green. A gate that green-lights untested code is worse than no gate.
 *
 * P1 FIX (the P0 report's own finding): both properties below drew session ids from
 * `fc.string()`, so a generated ledger practically never contained the generated id and
 * the LEDGER-COLLISION BRANCH was never reached in 20,000 cases. The ids are now drawn
 * from `SESSION_ID_POOL`, eight values, so a collision is the common case rather than a
 * lottery win - and `it('[INV-CER-01] the generator actually reaches ...')` asserts the
 * generator still hits the branch, so the fix cannot silently rot back.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { planCommit, type SessionOutcome } from './commit.js';

/**
 * A small id pool. The point of this property is the "already committed" branch, and a
 * generator whose ids never collide tests only the other one. Eight values against a
 * ledger of up to 20 entries makes a hit the usual outcome.
 */
const SESSION_ID_POOL = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;
const sessionIdArb = fc.constantFrom(...SESSION_ID_POOL);

const outcome = (sessionId: string, xp: number, gems: number): SessionOutcome => ({
  sessionId,
  xp,
  gems,
});

describe('planCommit', () => {
  it('[INV-CER-01] a first commit applies exactly the session outcome', () => {
    expect(planCommit(outcome('s1', 20, 3), [])).toEqual({ sessionId: 's1', xp: 20, gems: 3 });
  });

  it('[INV-CER-01] replaying a committed session_id awards nothing extra', () => {
    expect(planCommit(outcome('s1', 20, 3), ['s1'])).toBeNull();
    expect(planCommit(outcome('s1', 20, 3), ['s0', 's1', 's2'])).toBeNull();
  });

  it('[INV-CER-01] a different session still commits while others are on the ledger', () => {
    expect(planCommit(outcome('s9', 10, 1), ['s0', 's1'])).toEqual({
      sessionId: 's9',
      xp: 10,
      gems: 1,
    });
  });

  it('[INV-CER-01] the decision is idempotent: replaying any planned commit yields null', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        fc.nat({ max: 5000 }),
        fc.nat({ max: 5000 }),
        fc.array(sessionIdArb, { maxLength: 20 }),
        (sessionId, xp, gems, ledger) => {
          const first = planCommit(outcome(sessionId, xp, gems), ledger);
          if (first === null) {
            // Already on the ledger: it must stay refused.
            expect(ledger).toContain(sessionId);
            return;
          }
          expect(first).toEqual({ sessionId, xp, gems });
          // Once recorded, the same session can never pay again.
          expect(planCommit(outcome(sessionId, xp, gems), [...ledger, sessionId])).toBeNull();
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  /**
   * The gate on the gate above. With `fc.string()` this ran at roughly 0% and nobody
   * noticed, because 10,000 green cases look identical whether or not they reached the
   * branch under test.
   */
  it('[INV-CER-01] the generator actually reaches the ledger-collision branch', () => {
    let collisions = 0;
    let total = 0;
    fc.assert(
      fc.property(sessionIdArb, fc.array(sessionIdArb, { maxLength: 20 }), (sessionId, ledger) => {
        total += 1;
        if (planCommit(outcome(sessionId, 1, 1), ledger) === null) collisions += 1;
      }),
      { numRuns: PROPERTY_RUNS },
    );
    expect(total).toBe(PROPERTY_RUNS);
    // Measured 2026-09-11 with this pool: ~85% of cases hit the refusal branch.
    expect(collisions / total).toBeGreaterThan(0.25);
    expect(collisions / total).toBeLessThan(0.99);
  });

  it('[INV-CER-01] the plan never invents or drops value: it carries the outcome verbatim', () => {
    fc.assert(
      fc.property(sessionIdArb, fc.nat({ max: 5000 }), fc.nat({ max: 5000 }), (s, xp, gems) => {
        const delta = planCommit(outcome(s, xp, gems), []);
        expect(delta).not.toBeNull();
        expect(delta?.xp).toBe(xp);
        expect(delta?.gems).toBe(gems);
        expect(delta?.sessionId).toBe(s);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
