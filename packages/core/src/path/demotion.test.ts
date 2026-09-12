/**
 * The demotion offer: INV-PATH-07, INV-PATH-14.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  acceptDemotion,
  DEMOTION,
  EMPTY_DEMOTION_LEDGER,
  evaluateDemotion,
  recordDeclined,
  recordOffered,
  type DemotionLedger,
  type SessionResult,
} from './demotion.js';
import { buildModel } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

/** Run a trace and count how many offers actually fired. */
function runTrace(sessions: readonly SessionResult[]): {
  offers: number;
  ledger: DemotionLedger;
} {
  let ledger = EMPTY_DEMOTION_LEDGER;
  let offers = 0;
  const history: SessionResult[] = [];
  for (const s of sessions) {
    history.push(s);
    const offer = evaluateDemotion(history, ledger, s.localDay);
    if (offer !== null) {
      offers += 1;
      ledger = recordOffered(ledger, offer.nodeId, s.localDay);
    }
  }
  return { offers, ledger };
}

describe('the demotion offer', () => {
  it('[INV-PATH-14] falsifier: a 20-session day of ordinary variance produces exactly one prompt', () => {
    const input = falsifier('INV-PATH-14');
    const sessions: SessionResult[] = [];
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    for (let i = 0; i < (input.sessionsThatDay as number); i += 1) {
      sessions.push({
        nodeId: nodes[Math.floor(i / (input.failuresPerNode as number)) % nodes.length] ?? 'n1',
        accuracy: input.accuracy as number,
        localDay: input.localDay as number,
      });
    }
    expect(runTrace(sessions).offers).toBe((input.expect as { offersFired: number }).offersFired);
  });

  it('[INV-PATH-14] at most one offer per node and one per 7 local days, over generated histories', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            nodeId: fc.constantFrom('a', 'b', 'c'),
            accuracy: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
            localDay: fc.nat({ max: 40 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (raw) => {
          // local_day must be non-decreasing: time does not run backwards in a history.
          const sessions = [...raw].sort((x, y) => x.localDay - y.localDay);
          let ledger = EMPTY_DEMOTION_LEDGER;
          const history: SessionResult[] = [];
          const firedDays: number[] = [];
          const firedNodes: string[] = [];
          for (const s of sessions) {
            history.push(s);
            const offer = evaluateDemotion(history, ledger, s.localDay);
            if (offer === null) continue;
            firedDays.push(s.localDay);
            firedNodes.push(offer.nodeId);
            ledger = recordOffered(ledger, offer.nodeId, s.localDay);
          }
          expect(new Set(firedNodes).size).toBe(firedNodes.length);
          for (let i = 1; i < firedDays.length; i += 1) {
            expect((firedDays[i] ?? 0) - (firedDays[i - 1] ?? 0)).toBeGreaterThanOrEqual(
              DEMOTION.cooldownDays,
            );
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-14] three consecutive sub-60% sessions on the SAME node are required', () => {
    const bad = (nodeId: string): SessionResult => ({ nodeId, accuracy: 0.3, localDay: 1 });
    expect(evaluateDemotion([bad('a'), bad('a')], EMPTY_DEMOTION_LEDGER, 1)).toBeNull();
    expect(evaluateDemotion([bad('a'), bad('b'), bad('a')], EMPTY_DEMOTION_LEDGER, 1)).toBeNull();
    expect(
      evaluateDemotion([bad('a'), bad('a'), bad('a')], EMPTY_DEMOTION_LEDGER, 1),
    ).not.toBeNull();
  });

  it('[INV-PATH-14] a good session in the run resets the signal', () => {
    const history: SessionResult[] = [
      { nodeId: 'a', accuracy: 0.3, localDay: 1 },
      { nodeId: 'a', accuracy: 0.95, localDay: 1 },
      { nodeId: 'a', accuracy: 0.3, localDay: 1 },
    ];
    expect(evaluateDemotion(history, EMPTY_DEMOTION_LEDGER, 1)).toBeNull();
  });

  it('[INV-PATH-14] a decline is remembered: that node never offers again', () => {
    const history: SessionResult[] = [
      { nodeId: 'a', accuracy: 0.3, localDay: 1 },
      { nodeId: 'a', accuracy: 0.3, localDay: 1 },
      { nodeId: 'a', accuracy: 0.3, localDay: 1 },
    ];
    const declined = recordDeclined(EMPTY_DEMOTION_LEDGER, 'a');
    expect(evaluateDemotion(history, declined, 999)).toBeNull();
  });

  it('[INV-PATH-07] falsifier: accepting moves the learner and destroys no progress', () => {
    const input = falsifier('INV-PATH-07');
    const before = buildModel([[['lesson', 'unitReview']], [['lesson', 'unitReview']]], 3);
    const after = acceptDemotion(before, input.targetSection as number);
    expect(after.viewingSection).toBe(input.targetSection);
    expect(JSON.stringify(after.sections)).toBe(JSON.stringify(before.sections));
    expect(after.scoreFloor).toBe(before.scoreFloor);
    expect(after.jumpUnlockedUnits).toEqual(before.jumpUnlockedUnits);
  });

  it('[INV-PATH-07] the offer carries the shipped copy', () => {
    const history: SessionResult[] = Array.from({ length: 3 }, () => ({
      nodeId: 'a',
      accuracy: 0.1,
      localDay: 1,
    }));
    const offer = evaluateDemotion(history, EMPTY_DEMOTION_LEDGER, 1);
    expect(offer?.headline).toBe('Is this lesson too hard?');
    expect(offer?.body).toBe("We can jump to another lesson that's closer to your level");
  });
});
