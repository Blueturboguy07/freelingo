/**
 * The two XP counters and the two word counters: INV-ECO-13 and INV-ECO-27.
 *
 * Both named falsifiers are written as explicit cases: a course removal that takes
 * `lifetime_xp` with it, and two fixtures with equal taught vocabulary reporting
 * different Scholar tiers because one of them summed instead of unioning.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, arbItemId, twoCourseFixture } from '@freelingo/testkit';
import {
  asCourseId,
  asItemId,
  type AccountState,
  type CourseProgress,
  type ItemId,
} from '../types/index.js';
import { removeCourse, totalCourseXp, unionItemIds, wordCounters } from './words.js';
import { ACHIEVEMENTS } from './achievements.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;

const ACCOUNT: AccountState = {
  lifetimeXp: 460,
  gems: 505,
  streak: 12,
  longestStreak: 40,
  freezesOwned: 2,
  dailyGoalXp: 20,
  boostInventory: [],
  activeBoost: null,
  ownedCosmeticIds: [],
  maxLocalDaySeen: '2026-09-11' as AccountState['maxLocalDaySeen'],
  achievementCounters: {},
};

describe('the two XP counters', () => {
  it('[INV-ECO-13] falsifier: removing a course destroys its XP and leaves lifetime_xp untouched', () => {
    const fixture = twoCourseFixture();
    expect(totalCourseXp(fixture.courses)).toBe(460);
    expect(ACCOUNT.lifetimeXp).toBe(460);

    const after = removeCourse(ACCOUNT, fixture.courses, asCourseId('en-fr'));
    expect(after.courses).toHaveLength(1);
    expect(totalCourseXp(after.courses)).toBe(340);
    // The account-region counter is bit-identical: same object, same number.
    expect(after.account).toBe(ACCOUNT);
    expect(after.account.lifetimeXp).toBe(460);
  });

  it('[INV-ECO-13] no removal of any subset of courses changes lifetime_xp', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('en-es', 'en-fr'), { maxLength: 4 }), (removals) => {
        let courses: readonly CourseProgress[] = twoCourseFixture().courses;
        let account = ACCOUNT;
        for (const slug of removals) {
          const result = removeCourse(account, courses, asCourseId(slug));
          account = result.account;
          courses = result.courses;
        }
        expect(account.lifetimeXp).toBe(ACCOUNT.lifetimeXp);
      }),
      RUNS,
    );
  });

  it('[INV-ECO-13] word achievements read the UNION of content-hashed ids, never a sum', () => {
    const fixture = twoCourseFixture();
    const rowSum = fixture.courses.reduce((n, c) => n + c.introducedItemIds.length, 0);
    const union = unionItemIds(fixture.courses, 'introduced');
    expect(rowSum).toBe(12);
    expect(union.size).toBe(fixture.distinctIntroducedCount);
    expect(union.size).toBeLessThan(rowSum);
    // The Scholar ladder is what reads it, so the ladder must exist to be read.
    const scholar = ACHIEVEMENTS.find((a) => a.id === 'scholar');
    expect(scholar?.counterColumn).toBe('words_learned');
  });

  it('[INV-ECO-13] the union is idempotent under re-listing the same ids', () => {
    fc.assert(
      fc.property(fc.array(arbItemId(), { maxLength: 20 }), (ids) => {
        const course = (list: readonly ItemId[]): CourseProgress => ({
          courseId: asCourseId('en-es'),
          xp: 0,
          score: 0,
          scoreFloor: 0,
          completedNodeIds: [],
          legendaryNodeIds: [],
          introducedItemIds: list,
          learnedItemIds: [],
        });
        const once = unionItemIds([course(ids)], 'introduced');
        const twice = unionItemIds([course(ids), course(ids)], 'introduced');
        expect(twice.size).toBe(once.size);
      }),
      RUNS,
    );
  });
});

describe('the two word counters', () => {
  it('[INV-ECO-27] words_learned <= words_introduced, always', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ itemId: arbItemId(), countable: fc.boolean(), learned: fc.boolean() }),
          { maxLength: 40 },
        ),
        (entries) => {
          const counters = wordCounters(entries);
          expect(counters.wordsLearned).toBeLessThanOrEqual(counters.wordsIntroduced);
          expect(counters.wordsIntroduced).toBeGreaterThanOrEqual(0);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-27] only countable: true ledger items are counted', () => {
    const counters = wordCounters([
      { itemId: asItemId('it_a'), countable: false, learned: true },
      { itemId: asItemId('it_b'), countable: true, learned: true },
      { itemId: asItemId('it_c'), countable: true, learned: false },
    ]);
    expect(counters.wordsIntroduced).toBe(2);
    expect(counters.wordsLearned).toBe(1);
  });

  it('[INV-ECO-27] falsifier: two fixtures with equal taught vocabulary report equal counters', () => {
    // A `ja`-only and an `es`-only ledger with the same countable/learned shape must
    // agree. They differ only in the ids, which are content hashes and carry no language.
    const es = Array.from({ length: 30 }, (_, i) => ({
      itemId: asItemId(`it_es${i}`),
      countable: true,
      learned: i < 10,
    }));
    const ja = Array.from({ length: 30 }, (_, i) => ({
      itemId: asItemId(`it_ja${i}`),
      countable: true,
      learned: i < 10,
    }));
    expect(wordCounters(es)).toEqual(wordCounters(ja));
  });

  it('[INV-ECO-27] exactly two counters exist; nothing else is a word count', () => {
    const counters = wordCounters([]);
    expect(Object.keys(counters).sort()).toEqual(['wordsIntroduced', 'wordsLearned']);
    // Every word-shaped achievement reads one of them and not a third ad-hoc count.
    const wordAchievements = ACHIEVEMENTS.filter((a) => /word/i.test(a.copy));
    for (const achievement of wordAchievements) {
      expect(['words_learned', 'words_introduced']).toContain(achievement.counterColumn);
    }
  });

  it('[INV-ECO-27] counting the same id twice across courses does not move either counter', () => {
    const fixture = twoCourseFixture();
    const entries = fixture.courses.flatMap((course) =>
      course.introducedItemIds.map((itemId) => ({
        itemId,
        countable: true,
        learned: course.learnedItemIds.includes(itemId),
      })),
    );
    const counters = wordCounters(entries);
    expect(counters.wordsIntroduced).toBe(fixture.distinctIntroducedCount);
    expect(counters.wordsLearned).toBe(fixture.distinctLearnedCount);
  });
});
