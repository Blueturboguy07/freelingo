/**
 * The ceremony queue: INV-CER-02, INV-CER-03, INV-CER-04, INV-CER-05, INV-CER-06,
 * INV-CER-13.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  CEREMONY_SLOTS,
  isCanonicalSubsequence,
  ONE_TIME_SLOTS,
  pathMutationIndex,
  QUEUE,
  runCeremony,
  sessionCard,
  viewFor,
  type CeremonySlot,
} from './queue.js';
import { BASE_SESSION, ceremonyState, ceremonyStateArb } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('the ordered predicate queue', () => {
  it('[INV-CER-02] falsifier: node + unit + section in one session renders the fixed order, once', () => {
    const input = falsifier('INV-CER-02');
    const state = ceremonyState(
      { questsProgressed: 1, bundle: { gems: 5, freezes: 0, boost: null, tierGrant: null } },
      {
        scoreEntries: [{ slot: 'S069_scoreProgress', bandBeats: 0 }],
        nodeCompletedThisSession: true,
        nodeIsComplete: true,
        unitCompleted: true,
        sectionCompleted: true,
      },
    );
    const result = runCeremony(state);
    expect(result.chain).toEqual((input.expect as { chain: CeremonySlot[] }).chain);
    // Evaluated ONCE: every row ran exactly one time, whatever the chain length.
    for (const row of QUEUE) expect(result.predicateEvaluations[row.slot]).toBe(1);
  });

  it('[INV-CER-02] the chain is a duplicate-free subsequence of the canonical order', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const result = runCeremony(state);
        expect(isCanonicalSubsequence(result.chain)).toBe(true);
        for (const row of QUEUE)
          expect(result.predicateEvaluations[row.slot] ?? 0).toBeLessThanOrEqual(1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-02] the path mutation is due before the return screen, which is always last', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const result = runCeremony(state);
        if (result.chain.length === 0) return;
        expect(result.chain[result.chain.length - 1]).toBe('S087_returnToPath');
        expect(pathMutationIndex(result.chain)).toBe(result.chain.length - 1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-02] the reward commit runs once, before any screen', () => {
    const state = ceremonyState();
    expect(runCeremony(state).committed).toEqual({ sessionId: 's1', xp: 13, gems: 0 });
    // Replaying the same session id commits nothing extra, whatever the chain does.
    expect(runCeremony(state, { committedSessionIds: ['s1'] }).committed).toBeNull();
  });

  it('[INV-CER-02] a legendary level and a unit completion render as two screens, never one (EC-CER-20)', () => {
    // EC-CER-20: two tiers of one system, each with its own shipped copy.
    const result = runCeremony(
      ceremonyState({}, { nodeIsComplete: true, nodeIsLegendary: false, unitCompleted: true }),
    );
    expect(result.chain).toContain('S081_nodeCompleteLegendaryOffer');
    expect(result.chain).toContain('S082_unitComplete');
  });
});

describe('predicate scope', () => {
  it('[INV-CER-03] every queue row declares a scope in {account, course}', () => {
    for (const row of QUEUE) expect(['account', 'course']).toContain(row.scope);
    expect(QUEUE.map((r) => r.slot)).toEqual([...CEREMONY_SLOTS]);
  });

  it('[INV-CER-03] falsifier: a second course re-fires the Score unlock but not the streak count-up', () => {
    const input = falsifier('INV-CER-03');
    const expected = input.expect as Record<string, string>;
    // Course 1: first lesson ever. Score unlocks, streak extends.
    const first = runCeremony(
      ceremonyState(
        { streakBeat: 'extended' },
        { courseId: 'es', scoreEntries: [{ slot: 'S068_scoreUnlock', bandBeats: 0 }] },
      ),
    );
    expect(first.chain).toContain('S068_scoreUnlock');
    expect(first.chain).toContain('S071_streakCountUp');

    // Course 2, same day: its own Score unlocks; the account streak is already extended.
    const second = runCeremony(
      ceremonyState(
        { streakBeat: 'already-extended' },
        { courseId: 'fr', scoreEntries: [{ slot: 'S068_scoreUnlock', bandBeats: 0 }] },
        { sessionId: 's2' },
      ),
    );
    expect(second.chain).toContain(expected.secondCourseChainContains);
    expect(second.chain).not.toContain(expected.secondCourseChainExcludes);
  });

  it('[INV-CER-03] a course-scoped predicate cannot see account state at all', () => {
    const state = ceremonyState();
    const courseView = viewFor('course', state) as unknown as Record<string, unknown>;
    expect(Object.isFrozen(courseView)).toBe(true);
    expect(courseView.streak).toBeUndefined();
    expect(courseView.bundle).toBeUndefined();
    expect(courseView.courseId).toBe('es');
    const accountView = viewFor('account', state) as unknown as Record<string, unknown>;
    expect(accountView.courseId).toBeUndefined();
    expect(accountView.streak).toBe(1);
  });
});

describe('the streak branch', () => {
  it('[INV-CER-04] the two streak beats are mutually exclusive and jointly exhaustive', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const chain = runCeremony(state).chain;
        if (chain.length === 0) return;
        const countUp = chain.includes('S071_streakCountUp');
        const tomorrow = chain.includes('S074_streakStartsTomorrow');
        expect(countUp !== tomorrow).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-04] falsifier: one discriminant, so no pair of booleans can drift apart', () => {
    const input = falsifier('INV-CER-04');
    const pair = (input.expect as { exactlyOneOf: CeremonySlot[] }).exactlyOneOf;
    for (const beat of input.beats as ('extended' | 'already-extended')[]) {
      const chain = runCeremony(ceremonyState({ streakBeat: beat })).chain;
      expect(pair.filter((slot) => chain.includes(slot))).toHaveLength(1);
    }
    const extended = runCeremony(ceremonyState({ streakBeat: 'extended' })).chain;
    expect(extended).toContain('S071_streakCountUp');
    expect(extended).not.toContain('S074_streakStartsTomorrow');
    const already = runCeremony(ceremonyState({ streakBeat: 'already-extended' })).chain;
    expect(already).toContain('S074_streakStartsTomorrow');
    expect(already).not.toContain('S071_streakCountUp');
  });

  it('[INV-CER-02] a milestone session renders the count-up AND the milestone', () => {
    const chain = runCeremony(ceremonyState({ streak: 7, streakBeat: 'extended' })).chain;
    expect(chain).toContain('S071_streakCountUp');
    expect(chain).toContain('S075_streakMilestone');
    expect(chain.indexOf('S071_streakCountUp')).toBeLessThan(chain.indexOf('S075_streakMilestone'));
  });

  it('[INV-CER-02] 50 is not a milestone day: it was contamination from the goal picker', () => {
    expect(runCeremony(ceremonyState({ streak: 50 })).chain).not.toContain('S075_streakMilestone');
    expect(runCeremony(ceremonyState({ streak: 1000 })).chain).toContain('S075_streakMilestone');
  });
});

describe('the session card', () => {
  it('[INV-CER-05] falsifier: a flawless PRACTICE run is scored, not celebrated', () => {
    const input = falsifier('INV-CER-05');
    for (const c of input.cases as Record<string, string | number | boolean>[]) {
      const card = sessionCard({
        ...BASE_SESSION,
        flavour: c.flavour as string,
        mistakes: c.mistakes as number,
      });
      expect(card.variant, c.flavour as string).toBe(c.variant);
      expect(card.tileCount).toBe(c.tileCount);
      expect(card.terminal).toBe(c.terminal);
    }
  });

  it('[INV-CER-05] Perfect lesson! fires only for lesson flavours and terminates on one tile', () => {
    const perfect = sessionCard({ ...BASE_SESSION, mistakes: 0, flavour: 'lesson' });
    expect(perfect.variant).toBe('Perfect lesson!');
    expect(perfect.subtitle).toBe('You made no mistakes in this lesson');
    expect(perfect.terminal).toBe(true);
    expect(perfect.tileCount).toBe(1);
  });

  it('[INV-CER-05] a 100% Practice run renders Practice Complete!, not Perfect lesson!', () => {
    const practice = sessionCard({ ...BASE_SESSION, mistakes: 0, flavour: 'practice' });
    expect(practice.variant).toBe('Practice Complete!');
    expect(practice.tileCount).toBe(2);
  });

  it('[INV-CER-05] the perfect layout never fires with a mistake, for any flavour', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('lesson', 'practice', 'story', 'legendary', 'recovery', 'unitReview'),
        fc.nat({ max: 5 }),
        (flavour, mistakes) => {
          const card = sessionCard({ ...BASE_SESSION, flavour, mistakes });
          const expectPerfect = mistakes === 0 && (flavour === 'lesson' || flavour === 'recovery');
          expect(card.variant === 'Perfect lesson!').toBe(expectPerfect);
          expect(card.tileCount).toBe(expectPerfect ? 1 : 2);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('failure and abandonment', () => {
  it('[INV-CER-06] falsifier: a failed challenge is consoled; only a zero-award abandonment is silent', () => {
    const input = falsifier('INV-CER-06');
    for (const c of input.cases as Record<string, string | number | boolean>[]) {
      const chain = runCeremony(
        ceremonyState(
          {},
          {},
          {
            outcome: c.outcome as 'passed' | 'failed' | 'abandoned',
            gated: c.gated as boolean,
            xp: c.xp as number,
          },
        ),
      ).chain;
      if (typeof c.expectChainLength === 'number') expect(chain).toHaveLength(c.expectChainLength);
      else expect(chain).toContain(c.expectSlot);
    }
  });

  it('[INV-CER-06] a failed gated challenge renders the consolation screen, not the session card', () => {
    const chain = runCeremony(
      ceremonyState({}, {}, { outcome: 'failed', gated: true, xp: 20 }),
    ).chain;
    expect(chain).toContain('S085_consolation');
    expect(chain).not.toContain('S067_sessionComplete');
  });

  it('[INV-CER-06] a genuinely zero-award abandonment renders no ceremony at all', () => {
    const result = runCeremony(ceremonyState({}, {}, { outcome: 'abandoned', xp: 0 }));
    expect(result.chain).toEqual([]);
  });

  it('[INV-CER-06] an abandonment that still paid XP keeps its ceremony', () => {
    const result = runCeremony(ceremonyState({}, {}, { outcome: 'abandoned', xp: 7 }));
    expect(result.chain).toContain('S067_sessionComplete');
  });

  it('[INV-CER-06] exactly one of the session card and the consolation screen renders', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const chain = runCeremony(state).chain;
        if (chain.length === 0) return;
        const card = chain.includes('S067_sessionComplete');
        const consolation = chain.includes('S085_consolation');
        expect(card !== consolation).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('Skip all', () => {
  it('[INV-CER-13] falsifier: the ledger is byte-identical and every one-time screen still renders', () => {
    const input = falsifier('INV-CER-13');
    const state = ceremonyState(
      {
        streak: 7,
        streakBeat: 'extended',
        questsProgressed: 2,
        bundle: { gems: 5, freezes: 0, boost: null, tierGrant: null },
      },
      {
        scoreEntries: [{ slot: 'S068_scoreUnlock', bandBeats: 0 }],
        nodeIsComplete: true,
        unitCompleted: true,
        sectionCompleted: true,
      },
    );
    const full = runCeremony(state);
    const skipped = runCeremony(state, { skipAll: true });
    expect(JSON.stringify(skipped.committed)).toBe(JSON.stringify(full.committed));
    expect(input.expect).toBeDefined();
    for (const slot of full.chain) {
      if (ONE_TIME_SLOTS.includes(slot)) expect(skipped.chain).toContain(slot);
    }
    expect(skipped.chain).toContain('S075_streakMilestone');
    expect(skipped.skippedToToast.length).toBeGreaterThan(0);
  });

  it('[INV-CER-13] Skip all commits the identical ledger over generated states', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const full = runCeremony(state);
        const skipped = runCeremony(state, { skipAll: true });
        expect(JSON.stringify(skipped.committed)).toBe(JSON.stringify(full.committed));
        expect(JSON.stringify(skipped.bundle)).toBe(JSON.stringify(full.bundle));
        for (const slot of full.chain) {
          if (ONE_TIME_SLOTS.includes(slot)) expect(skipped.chain).toContain(slot);
        }
        expect(isCanonicalSubsequence(skipped.chain)).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
