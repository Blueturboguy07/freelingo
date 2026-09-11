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
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planCommit, type SessionOutcome } from './commit.js';

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
        fc.string({ minLength: 1 }),
        fc.nat({ max: 5000 }),
        fc.nat({ max: 5000 }),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 20 }),
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
      { numRuns: 10_000 },
    );
  });

  it('[INV-CER-01] the plan never invents or drops value: it carries the outcome verbatim', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 5000 }),
        fc.nat({ max: 5000 }),
        (s, xp, gems) => {
          const delta = planCommit(outcome(s, xp, gems), []);
          expect(delta).not.toBeNull();
          expect(delta?.xp).toBe(xp);
          expect(delta?.gems).toBe(gems);
          expect(delta?.sessionId).toBe(s);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
