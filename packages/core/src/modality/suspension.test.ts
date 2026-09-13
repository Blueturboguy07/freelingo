import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  clearModalitySuspension,
  parseModalitySuspensions,
  pruneExpiredSuspensions,
  remainingSuspensionMs,
  suspendModality,
  SUSPENSION_MS,
} from './index.js';
const clock = { utcMs: Date.UTC(2026, 8, 13), monotonicMs: 8_000_000, bootId: 'boot-one' };
describe('account modality suspension', () => {
  it('[INV-MOD-01] one account record survives kill and course switch with the same real remainder', () => {
    const es = suspendModality(null, 'speaking', clock);
    const killed = parseModalitySuspensions(JSON.stringify(es));
    expect(killed).toEqual(es);
    const after = {
      ...clock,
      utcMs: clock.utcMs + 120_000,
      monotonicMs: clock.monotonicMs + 120_000,
    };
    expect(remainingSuspensionMs(killed, 'speaking', after)).toBe(58 * 60_000);
    expect(remainingSuspensionMs(killed, 'listening', after)).toBe(0);
    expect(Object.keys(es).sort()).toEqual(['listening', 'speaking', 'version']);
  });
  it('[INV-MOD-01] clock manipulation cannot extend suspension past 60 real minutes over 10000 runs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -30 * 86400_000, max: 30 * 86400_000 }),
        fc.integer({ min: 0, max: 2 * SUSPENSION_MS }),
        (wallJump, elapsed) => {
          const record = suspendModality(null, 'listening', clock);
          expect(
            remainingSuspensionMs(record, 'listening', {
              ...clock,
              utcMs: clock.utcMs + wallJump,
              monotonicMs: clock.monotonicMs + elapsed,
            }),
          ).toBe(Math.max(0, SUSPENSION_MS - elapsed));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
  it('[INV-MOD-01] changed boot identity or a detected backwards monotonic clock immediately expires', () => {
    const record = suspendModality(null, 'speaking', clock);
    expect(
      remainingSuspensionMs(record, 'speaking', {
        ...clock,
        bootId: 'boot-two',
        monotonicMs: clock.monotonicMs + 1,
      }),
    ).toBe(0);
    expect(
      remainingSuspensionMs(record, 'speaking', { ...clock, monotonicMs: clock.monotonicMs - 1 }),
    ).toBe(0);
    expect(pruneExpiredSuspensions(record, { ...clock, bootId: 'boot-two' })).toEqual({
      version: 1,
      listening: null,
      speaking: null,
    });
  });
  it('[INV-MOD-03] enabling one family clears only its own global suspension', () => {
    const speaking = suspendModality(null, 'speaking', clock);
    const both = suspendModality(speaking, 'listening', {
      ...clock,
      monotonicMs: clock.monotonicMs + 100,
    });
    const snapshot = JSON.stringify(both);
    const cleared = clearModalitySuspension(both, 'speaking');
    expect(cleared.speaking).toBeNull();
    expect(cleared.listening).toEqual(both.listening);
    expect(JSON.stringify(both)).toBe(snapshot);
  });
  it('[INV-MOD-01] malformed, legacy or unbounded records fail open instead of locking a family', () => {
    const valid = suspendModality(null, 'listening', clock);
    for (const raw of [
      null,
      '',
      '2026-09-13T01:00:00Z',
      'null',
      '[]',
      '{}',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, courseId: 'en-es' }),
      JSON.stringify({ ...valid, speaking: false }),
      JSON.stringify({ ...valid, listening: { ...valid.listening, startedUtcMs: '2026-09-13' } }),
      JSON.stringify({ ...valid, listening: { ...valid.listening, expiresUtcMs: null } }),
      JSON.stringify({ ...valid, listening: { ...valid.listening, startedMonotonicMs: -1 } }),
      JSON.stringify({
        ...valid,
        listening: {
          ...valid.listening,
          deadlineMonotonicMs: clock.monotonicMs + 2 * SUSPENSION_MS,
        },
      }),
      JSON.stringify({ ...valid, listening: { ...valid.listening, bootId: '' } }),
    ])
      expect(parseModalitySuspensions(raw)).toBeNull();
    expect(remainingSuspensionMs(null, 'speaking', clock)).toBe(0);
    expect(suspendModality(null, 'speaking', { ...clock, bootId: '' }).speaking).toBeNull();
  });
  it('[INV-MOD-01] exact deadline expires and pruning never renews the other family', () => {
    const one = suspendModality(null, 'speaking', clock);
    const both = suspendModality(one, 'listening', {
      ...clock,
      utcMs: clock.utcMs + 100,
      monotonicMs: clock.monotonicMs + 100,
    });
    const at = { ...clock, monotonicMs: clock.monotonicMs + SUSPENSION_MS };
    const pruned = pruneExpiredSuspensions(both, at);
    expect(pruned.speaking).toBeNull();
    expect(remainingSuspensionMs(pruned, 'listening', at)).toBe(100);
  });
});
