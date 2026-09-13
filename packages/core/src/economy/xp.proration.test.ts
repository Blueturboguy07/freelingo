import { expect, it } from 'vitest';
import { awardForSession, EMPTY_LADDER_STATE, type AwardInput } from './xp.js';
const input: AwardInput = {
  flavour: 'hubMistakes',
  outcome: 'completed',
  boostAtSessionStart: null,
  committedAtUtc: '2026-09-13T12:00:00Z',
  ladderStateToday: EMPTY_LADDER_STATE,
};
it('[INV-HUB-03] a small practice pool prorates the gross award before the remaining daily cap', () => {
  expect(
    awardForSession({
      ...input,
      practiceItemRatio: 0.2,
      ladderStateToday: { sessionsCompleted: 0, xpAwarded: 59 },
    }).awardedXp,
  ).toBe(1);
  expect(awardForSession({ ...input, practiceItemRatio: 0.2 }).awardedXp).toBe(2);
});
it('[INV-ECO-15] omitted and full pool ratios preserve every existing award field; zero pays zero', () => {
  expect(awardForSession({ ...input, practiceItemRatio: 1 })).toEqual(awardForSession(input));
  expect(awardForSession({ ...input, practiceItemRatio: 0 }).awardedXp).toBe(0);
});
it.each([NaN, Infinity, -Infinity, -0.01, 1.01])(
  '[INV-ECO-15] invalid practice ratio %s rejects before an award',
  (practiceItemRatio) => {
    expect(() => awardForSession({ ...input, practiceItemRatio })).toThrow(RangeError);
  },
);
it('[INV-ECO-02] small pools still apply the actual start boost, ladder and lapsed-grace rules', () => {
  const boostAtSessionStart = {
    kind: 'xpBoost' as const,
    multiplier: 2,
    startedAtUtc: '2026-09-13T11:55:00Z',
    expiresAtUtc: '2026-09-13T12:10:00Z',
  };
  const small = {
    ...input,
    practiceItemRatio: 0.2,
    boostAtSessionStart,
    ladderStateToday: { sessionsCompleted: 1, xpAwarded: 0 },
  };
  expect(awardForSession(small).awardedXp).toBe(2);
  expect(awardForSession({ ...small, committedAtUtc: '2026-09-13T13:00:00Z' }).awardedXp).toBe(1);
});
