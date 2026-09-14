import { expect, it } from 'vitest';
import { HUB_SESSION_FLAVOURS, type ActiveBoost } from '../types/index.js';
import { HUB_CONFIG } from '../hub/index.js';
import { LESSON_TARGET_LENGTH } from '../session/flavours.js';
import { BOOST_GRACE_SECONDS } from './config.js';
import { advertisedXpFor, awardForSession, EMPTY_LADDER_STATE, type AwardInput } from './xp.js';
const now = '2026-09-13T12:00:00Z';
const boost: ActiveBoost = {
  kind: 'xpBoost',
  multiplier: 2,
  startedAtUtc: now,
  expiresAtUtc: '2026-09-13T12:15:00Z',
};
const base: AwardInput = {
  flavour: 'lesson',
  outcome: 'completed',
  maxCombo: 0,
  boostAtSessionStart: null,
  committedAtUtc: now,
  ladderStateToday: EMPTY_LADDER_STATE,
};
it.each(HUB_SESSION_FLAVOURS)(
  '[INV-HUB-06] %s never exceeds the actual path base rate for any physical short set, boost or ladder',
  (flavour) => {
    for (const granted of [null, boost])
      for (const sessionsCompleted of [0, 1, 2, 3, 4, 20])
        for (const xpAwarded of [0, 59, 60]) {
          const path = awardForSession({ ...base, boostAtSessionStart: granted });
          for (let served = 1; served <= HUB_CONFIG.target; served++) {
            const award = awardForSession({
              ...base,
              flavour,
              practiceItemRatio: served / HUB_CONFIG.target,
              boostAtSessionStart: granted,
              ladderStateToday: { sessionsCompleted, xpAwarded },
              maxCombo: 100,
            });
            expect(award.awardedXp / served).toBeLessThanOrEqual(
              path.awardedXp / LESSON_TARGET_LENGTH,
            );
            expect(Number.isInteger(award.awardedXp)).toBe(true);
          }
        }
  },
);
it('[INV-HUB-06][INV-ECO-02] the rate cap remains fractional until boost and ladder resolve, with a single final floor', () => {
  const input = { ...base, flavour: 'hubWords' as const, practiceItemRatio: 3 / HUB_CONFIG.target };
  expect(awardForSession(input).awardedXp).toBe(2);
  expect(awardForSession({ ...input, boostAtSessionStart: boost }).awardedXp).toBe(5);
  expect(
    awardForSession({
      ...input,
      boostAtSessionStart: boost,
      ladderStateToday: { sessionsCompleted: 1, xpAwarded: 0 },
    }).awardedXp,
  ).toBe(2);
  const boundary = Date.parse(boost.expiresAtUtc) + BOOST_GRACE_SECONDS * 1000;
  expect(
    awardForSession({
      ...input,
      boostAtSessionStart: boost,
      committedAtUtc: new Date(boundary).toISOString(),
    }).awardedXp,
  ).toBe(5);
  expect(
    awardForSession({
      ...input,
      boostAtSessionStart: boost,
      committedAtUtc: new Date(boundary + 1).toISOString(),
    }).awardedXp,
  ).toBe(2);
  expect(
    awardForSession({ ...input, flavour: 'hubListenUp', boostAtSessionStart: boost }).awardedXp,
  ).toBe(2);
});
it('[INV-HUB-06][INV-ECO-15] every full Hub advert is the same capped first award and no minimum XP is invented', () => {
  for (const flavour of HUB_SESSION_FLAVOURS) {
    expect(advertisedXpFor(flavour)).toEqual({ xp: 8, isFloor: false });
    const input = { ...base, flavour };
    expect(awardForSession(input).awardedXp).toBe(8);
    expect(awardForSession({ ...input, practiceItemRatio: 1 })).toEqual(awardForSession(input));
    expect(awardForSession({ ...input, practiceItemRatio: 0 }).awardedXp).toBe(0);
    expect(awardForSession({ ...input, practiceItemRatio: 1 / HUB_CONFIG.target }).awardedXp).toBe(
      0,
    );
    expect(
      awardForSession({ ...input, ladderStateToday: { sessionsCompleted: 0, xpAwarded: 57 } })
        .awardedXp,
    ).toBe(3);
  }
});
it('[INV-ECO-09][INV-ECO-15] the Hub rate repair preserves existing non-Hub base awards and proration', () => {
  for (const [flavour, xp] of [
    ['lesson', 10],
    ['nodePractice', 10],
    ['legendary', 40],
    ['placement', 0],
    ['jumpHere', 0],
    ['sectionTest', 50],
    ['unitReview', 20],
    ['dailyRefresh', 10],
    ['recovery', 10],
    ['endgameReview', 5],
  ] as const) {
    expect(awardForSession({ ...base, flavour }).awardedXp).toBe(xp);
    expect(awardForSession({ ...base, flavour, practiceItemRatio: 0.2 }).awardedXp).toBe(
      Math.floor(xp * 0.2),
    );
  }
});
