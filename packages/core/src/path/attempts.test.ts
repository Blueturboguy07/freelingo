/**
 * Failed Legendary and failed jump-here: INV-PATH-04.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  consolationPayable,
  EMPTY_ATTEMPT_LOG,
  recordFailedAttempt,
  type AttemptLog,
  type AttemptRecord,
} from './attempts.js';
import { buildModel, linearModelArb } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('failed attempts', () => {
  it('[INV-PATH-04] falsifier: three failed attempts change nothing but the log, and the retry is free', () => {
    const input = falsifier('INV-PATH-04');
    const model = buildModel(
      [
        [
          ['lesson', 'unitReview'],
          ['lesson', 'unitReview'],
        ],
      ],
      2,
    );
    let log: AttemptLog = EMPTY_ATTEMPT_LOG;
    let consolations = 0;
    for (const record of input.attempts as AttemptRecord[]) {
      if (record.reachedCheckpoint && consolationPayable(log, record.nodeId, record.localDay)) {
        consolations += 1;
      }
      const result = recordFailedAttempt(model, log, record);
      // Reference equality: the model was not rebuilt, so it cannot have been changed.
      expect(result.model).toBe(model);
      expect(result.retry.available).toBe(true);
      expect(result.retry.costGems).toBe(0);
      expect(result.retry.retainedProgress).toBeNull();
      log = result.log;
    }
    expect(log.records).toHaveLength(3);
    expect(log.records.every((r) => !r.passed)).toBe(true);
    expect(consolations).toBe(
      (input.expect as { consolationsPayable: number }).consolationsPayable,
    );
  });

  it('[INV-PATH-04] a failed attempt never mutates the path model, over generated paths', () => {
    fc.assert(
      fc.property(
        linearModelArb,
        fc.constantFrom('legendary' as const, 'jumpHere' as const, 'sectionTest' as const),
        fc.nat({ max: 50 }),
        fc.boolean(),
        ({ model }, kind, localDay, reachedCheckpoint) => {
          const snapshot = JSON.stringify(model);
          const result = recordFailedAttempt(model, EMPTY_ATTEMPT_LOG, {
            kind,
            nodeId: 'n',
            localDay,
            passed: true, // even a record claiming a pass is written as a failure
            reachedCheckpoint,
          });
          expect(result.model).toBe(model);
          expect(JSON.stringify(model)).toBe(snapshot);
          expect(result.log.records[0]?.passed).toBe(false);
          expect(result.retry.costGems).toBe(0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-04] the checkpoint consolation pays at most once per node per local day', () => {
    let log = EMPTY_ATTEMPT_LOG;
    const record: AttemptRecord = {
      kind: 'legendary',
      nodeId: 'a',
      localDay: 7,
      passed: false,
      reachedCheckpoint: true,
    };
    expect(consolationPayable(log, 'a', 7)).toBe(true);
    log = recordFailedAttempt(buildModel([[['lesson']]], 0), log, record).log;
    expect(consolationPayable(log, 'a', 7)).toBe(false);
    expect(consolationPayable(log, 'a', 8)).toBe(true);
    expect(consolationPayable(log, 'b', 7)).toBe(true);
  });
});
