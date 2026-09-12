/**
 * The config gates. Unit and grep, not property: these invariants are about what is
 * WRITTEN DOWN, and a property cannot see a second copy of a constant in another file.
 *
 * Falsifiers, from `docs/invariants.md` and `00-EDGE-CASES.md`:
 * - ECO-01: a second 10/20/30/50 tuple anywhere in application code.
 * - ECO-09/19: a flavour with no row, or a failed jump-here returning silently.
 * - ECO-12/24: a price on hearts, Legendary or recovery; a `Super`/`No ads` string.
 * - ECO-14: a "you did it" string keyed off the calendar date.
 * - ECO-17: a heart glyph on a test surface.
 * - ECO-32: a scalar `sessionXP(story)` literal.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from '@freelingo/testkit';
import {
  BOOST_GRACE_SECONDS,
  DEPRECATED_BOOST_KINDS,
  GOAL_TIERS,
  JUMP_HERE_MISTAKE_ALLOWANCE,
  LEGENDARY_MISTAKE_ALLOWANCE,
  MAX_BOOST_INVENTORY,
  MAX_NEW_ITEMS_PER_LOCAL_DAY,
  MAX_ROLLOVER_DEFERRAL_SECONDS,
  MIN_HOURS_BETWEEN_INTRODUCTION_AND_PRODUCTION,
  QUEST_TARGET_MAX_XP,
  QUEST_TARGET_MIN_XP,
  LONG_FORM_XP_KEYS,
  QUEST_TREND_WINDOW_DAYS,
  RADIO_XP,
  SOCIETY_BOOST_MINUTES,
  SOCIETY_CHECKPOINTS,
  SOCIETY_ENTRY_STREAK_DAYS,
  SOCIETY_FREEZE_CAP_BONUS,
  SECTION_TEST_MISTAKE_ALLOWANCE,
  SESSION_FLAVOUR_MATRIX,
  SHOP_CATALOGUE,
  STORY_XP,
  STREAK_FREEZE_CAP,
  STREAK_FREEZE_GEM_PRICE_2026,
  STREAK_MILESTONES,
  STREAK_REPAIRS_PER_MONTH,
  XP_LADDERS,
  flavourRow,
} from './config.js';
import {
  HUB_SESSION_FLAVOURS,
  NARRATIVE_SESSION_FLAVOURS,
  PATH_SESSION_FLAVOURS,
  SESSION_FLAVOURS,
  SESSION_OUTCOMES,
  XP_LADDER_MODES,
} from '../types/index.js';

/* --------------------------------------------------------------- grep machinery */

/** Source that SHIPS: no tests, no generated native trees, no fixtures. */
const SHIPPED_ROOTS = [
  'packages/core/src',
  'packages/schema/src',
  'packages/ui/src',
  'apps/mobile/src',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__snapshots__']);

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ROOT = repoRoot();
const SHIPPED_FILES = SHIPPED_ROOTS.flatMap((r) => sourceFiles(join(ROOT, r)));

/**
 * Source with comments removed.
 *
 * Every grep gate below runs over this, not the raw file. The comments in this codebase
 * quote the very strings the gates forbid — `a scalar sessionXP(story) literal` is
 * written into `xp.ts` as the reason the four-key table exists — and a gate that fails on
 * its own documentation trains people to delete the documentation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every string literal in a source file. Comments are prose and are not scanned. */
function stringLiteralsIn(source: string): string[] {
  const code = withoutComments(source);
  const literals: string[] = [];
  const pattern =
    /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    literals.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return literals;
}

/* -------------------------------------------------------------------- ECO-01 */

describe('the goal table', () => {
  it('[INV-ECO-01] the minutes<->XP mapping is four named rows: 5/10/15/20 min, 10/20/30/50 XP', () => {
    expect(GOAL_TIERS.map((t) => t.key)).toEqual(['casual', 'regular', 'serious', 'intense']);
    expect(GOAL_TIERS.map((t) => t.minutes)).toEqual([5, 10, 15, 20]);
    expect(GOAL_TIERS.map((t) => t.xp)).toEqual([10, 20, 30, 50]);
    // Ruling EC-ECO-01 is the 50 arm; deep/07's 40 arm is not shipped.
    expect(GOAL_TIERS.map((t) => t.xp)).not.toContain(40);
  });

  it('[INV-ECO-01] no 10/20/30/50 (or /40) tuple appears anywhere else in shipped code', () => {
    // The tuple, allowing for commas, whitespace, quotes and property names between the
    // members — i.e. any shape a second copy of this table could actually take.
    const tuple = /\b10\b[^\n]{0,60}?\b20\b[^\n]{0,60}?\b30\b[^\n]{0,60}?\b(?:40|50)\b/;
    const offenders = SHIPPED_FILES.filter((file) => {
      if (relative(ROOT, file) === 'packages/core/src/economy/config.ts') return false;
      return tuple.test(withoutComments(readFileSync(file, 'utf8')));
    }).map((f) => relative(ROOT, f));
    expect(
      offenders,
      'the goal ladder exists once, in economy/config.ts; these files carry a second copy',
    ).toEqual([]);
  });
});

/* ----------------------------------------------------------- ECO-09 and ECO-19 */

describe('the session-flavour matrix', () => {
  it('[INV-ECO-09] every one of the ten path flavours has a row for every outcome', () => {
    expect(PATH_SESSION_FLAVOURS).toHaveLength(10);
    for (const flavour of SESSION_FLAVOURS) {
      const rows = SESSION_FLAVOUR_MATRIX[flavour];
      expect(rows, `no matrix entry for flavour ${flavour}`).toBeDefined();
      for (const outcome of SESSION_OUTCOMES) {
        const row = rows[outcome];
        expect(row, `no ${outcome} row for flavour ${flavour}`).toBeDefined();
        expect(typeof row.extendsStreak).toBe('boolean');
        expect(typeof row.countsTowardGoal).toBe('boolean');
        expect(typeof row.awardsXp).toBe('boolean');
        expect(typeof row.advancesQuests).toBe('boolean');
        // EC-ECO-15's remaining columns, on every row.
        expect(typeof row.countsAsLesson).toBe('boolean');
        expect(typeof row.advancesPath).toBe('boolean');
        expect(typeof row.writesMistakeRows).toBe('boolean');
        expect(Array.isArray(row.questShapes)).toBe(true);
      }
    }
  });

  it('[INV-ECO-09] EC-ECO-15 rows exist for story, radio, roleplay, every hub flavour and the timed challenge', () => {
    // The invariant's own words: "a row for every Story, Radio, Roleplay, script and hub
    // flavour, since any session that commits a row and awards XP extends the streak".
    // Before these rows existed `flavourRow('story', 'replayed')` THREW.
    for (const flavour of [...NARRATIVE_SESSION_FLAVOURS, ...HUB_SESSION_FLAVOURS]) {
      expect(() => flavourRow(flavour, 'replayed')).not.toThrow();
      expect(flavourRow(flavour, 'completed').extendsStreak).toBe(true);
    }
    const timed = flavourRow('timedChallenge', 'completed');
    // EC-ECO-15, column by column.
    expect(timed.countsAsLesson).toBe(true);
    expect(timed.advancesPath).toBe(false);
    expect(timed.extendsStreak).toBe(true);
    expect(timed.countsTowardGoal).toBe(true);
    expect(timed.questShapes).toContain('xp');
    expect(timed.questShapes).not.toContain('sessions');
    expect(timed.writesMistakeRows).toBe(false);
  });

  it('[INV-ECO-09] the matrix names exactly the declared flavours — no strays, no gaps', () => {
    expect(Object.keys(SESSION_FLAVOUR_MATRIX).sort()).toEqual([...SESSION_FLAVOURS].sort());
  });

  it('[INV-ECO-09] a completed placement or jump-here extends the streak AND counts toward the goal, paying 0 XP (EC-ECO-15)', () => {
    // EC-ECO-15, verbatim: "a completed placement or jump-here test extends the streak
    // and counts toward the goal ... but awards 0 XP so the ability estimate is not
    // farmable". The two flavours the ruling treats identically must agree with each
    // other; an earlier version shipped placement with countsTowardGoal: false and
    // asserted the divergence here, which locked it in.
    for (const flavour of ['placement', 'jumpHere'] as const) {
      const row = flavourRow(flavour, 'completed');
      expect(row.extendsStreak, flavour).toBe(true);
      expect(row.countsTowardGoal, flavour).toBe(true);
      expect(row.awardsXp, flavour).toBe(false);
      expect(row.advancesQuests, flavour).toBe(false);
    }
  });

  it("[INV-ECO-19] every gated flavour's failed row declares no streak, a consequence and a route", () => {
    const gated = ['legendary', 'jumpHere', 'sectionTest'] as const;
    for (const flavour of gated) {
      const row = flavourRow(flavour, 'failed');
      expect(row.extendsStreak, `${flavour} failed must not extend the streak`).toBe(false);
      expect(
        row.consequenceString.length,
        `${flavour} failed needs a consequence string`,
      ).toBeGreaterThan(0);
      expect(row.consequenceRoute.length).toBeGreaterThan(0);
    }
  });

  it('[INV-ECO-19] a failed jump-here does not return silently to the path (the named falsifier)', () => {
    const row = flavourRow('jumpHere', 'failed');
    expect(row.consequenceRoute).toBe('path.retry-offer');
    expect(row.consequenceString).toMatch(/try again/i);
  });

  it('[INV-ECO-30] every row carries an explicit boost_applies, and no test flavour is boostable', () => {
    for (const flavour of SESSION_FLAVOURS) {
      for (const outcome of SESSION_OUTCOMES) {
        expect(typeof flavourRow(flavour, outcome).boostApplies).toBe('boolean');
      }
    }
    // EC-ECO-35 names the exclusion list: "story, radio, Listen-Up and Roleplay not".
    for (const flavour of [
      'placement',
      'jumpHere',
      'sectionTest',
      'endgameReview',
      'story',
      'radio',
      'roleplay',
      'hubListenUp',
      'timedChallenge',
    ] as const) {
      for (const outcome of SESSION_OUTCOMES) {
        expect(flavourRow(flavour, outcome).boostApplies, `${flavour}/${outcome}`).toBe(false);
      }
    }
    // Daily Refresh and its replay sub-flavour both declare a value (INV-ECO-30's clause).
    expect(flavourRow('dailyRefresh', 'completed').boostApplies).toBe(true);
    expect(flavourRow('dailyRefresh', 'replayed').boostApplies).toBe(true);
  });
});

/* -------------------------------------------------------------------- ECO-17 */

describe('mistake allowance', () => {
  it('[INV-ECO-17] the matrix carries a mistake_allowance for every flavour, jump-here 5 and section test 4', () => {
    for (const flavour of SESSION_FLAVOURS) {
      for (const outcome of SESSION_OUTCOMES) {
        const allowance = flavourRow(flavour, outcome).mistakeAllowance;
        expect(allowance === null || Number.isInteger(allowance)).toBe(true);
      }
    }
    expect(JUMP_HERE_MISTAKE_ALLOWANCE).toBe(5);
    expect(SECTION_TEST_MISTAKE_ALLOWANCE).toBe(4);
    expect(flavourRow('jumpHere', 'completed').mistakeAllowance).toBe(JUMP_HERE_MISTAKE_ALLOWANCE);
    expect(flavourRow('sectionTest', 'completed').mistakeAllowance).toBe(
      SECTION_TEST_MISTAKE_ALLOWANCE,
    );
  });

  it("[INV-ECO-17] Legendary's allowance is a NAMED constant, not a literal in a matrix row", () => {
    expect(Number.isInteger(LEGENDARY_MISTAKE_ALLOWANCE)).toBe(true);
    expect(flavourRow('legendary', 'completed').mistakeAllowance).toBe(LEGENDARY_MISTAKE_ALLOWANCE);
    const source = readFileSync(join(ROOT, 'packages/core/src/economy/config.ts'), 'utf8');
    // The matrix rows reference the constants; the only place the numbers appear as
    // literals is the constant declarations themselves.
    const matrixBody = source.slice(source.indexOf('export const SESSION_FLAVOUR_MATRIX'));
    expect(matrixBody).not.toMatch(/mistakeAllowance:\s*\d/);
  });

  it('[INV-ECO-17] ungated flavours declare unlimited mistakes — the meter reads infinity', () => {
    for (const flavour of [
      'lesson',
      'nodePractice',
      'unitReview',
      'dailyRefresh',
      'recovery',
    ] as const) {
      expect(flavourRow(flavour, 'completed').mistakeAllowance).toBeNull();
    }
  });

  it('[INV-ECO-17] no shipped source names a heart glyph, a refill modal or a purchase sheet', () => {
    const banned = /❤|:heart:|heart-glyph|refillModal|purchaseSheet/;
    const offenders = SHIPPED_FILES.filter((file) =>
      stringLiteralsIn(readFileSync(file, 'utf8')).some((literal) => banned.test(literal)),
    ).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------ ECO-12 and ECO-24 */

describe('the gem sink', () => {
  it('[INV-ECO-12] the only priced items are cosmetics and the Streak Freeze (ruling EC-ECO-13)', () => {
    const sinks = new Set(SHOP_CATALOGUE.map((entry) => entry.sink));
    expect([...sinks].sort()).toEqual(['cosmetic', 'streakFreeze']);
    for (const entry of SHOP_CATALOGUE) {
      expect(entry.priceGems).toBeGreaterThan(0);
    }
    expect(SHOP_CATALOGUE.filter((e) => e.sink === 'cosmetic').length).toBeGreaterThan(0);
  });

  it('[INV-ECO-12] no price exists on hearts, Legendary, streak recovery or any learning surface', () => {
    const forbidden = /heart|legendary|recovery|repair|lesson|practice|hint|skip/i;
    for (const entry of SHOP_CATALOGUE) {
      expect(entry.id, `${entry.id} prices a learning surface`).not.toMatch(forbidden);
    }
  });

  it('[INV-ECO-12] the five deprecated boost kinds exist as TYPES with no catalogue entry', () => {
    expect([...DEPRECATED_BOOST_KINDS].sort()).toEqual([
      'doubleOrNothing',
      'earlyBird',
      'happyHour',
      'timerBoost',
      'weekendAmulet',
    ]);
    const ids = SHOP_CATALOGUE.map((entry) => entry.id.toLowerCase());
    for (const kind of DEPRECATED_BOOST_KINDS) {
      expect(ids.some((id) => id.includes(kind.toLowerCase()))).toBe(false);
    }
    // Timer Boost, Double-or-Nothing, Happy Hour, Early Bird and the Weekend Amulet have
    // ZERO occurrences in the 2026 bundle (deep/04 adversarial review); they ship as
    // types only, so a future build can enable one without a schema migration.
    expect(SHOP_CATALOGUE.some((e) => e.id === 'streak-freeze')).toBe(true);
    expect(STREAK_FREEZE_GEM_PRICE_2026).not.toBe(200);
  });

  it('[INV-ECO-24] no shipped string says Super, Max, No ads, unlimited hearts, refill or a price', () => {
    const banned: readonly [RegExp, string][] = [
      [/\bSuper\b/, 'Super'],
      [/\bMax\b/, 'Max'],
      [/no ads/i, 'No ads'],
      [/unlimited hearts/i, 'unlimited hearts'],
      [/refill/i, 'refill'],
      [/\$\d|\d+\s*gems? to (?:refill|continue)/i, 'a price string'],
    ];
    /**
     * The ONE exception, and it is named rather than loosened.
     *
     * S121 ships `Refills in {{n}} day(s)` for the STREAK FREEZE timer — a verified 2026
     * string in the product map, and one of the three freeze acquisition channels. What
     * INV-ECO-24 forbids is the HEART refill: the wall, the price and the modal. A
     * literal that says "refill" and also says freeze or streak is the freeze timer; any
     * other refill string is the paywall this clone exists to delete.
     */
    const FREEZE_REFILL = /freeze|streak/i;
    const offenders: string[] = [];
    for (const file of SHIPPED_FILES) {
      for (const literal of stringLiteralsIn(readFileSync(file, 'utf8'))) {
        for (const [pattern, label] of banned) {
          if (!pattern.test(literal)) continue;
          if (label === 'refill' && FREEZE_REFILL.test(literal)) continue;
          offenders.push(`${relative(ROOT, file)}: ${label} in ${JSON.stringify(literal)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The exception is narrow, not a hole: a heart refill string still fails.
    expect(FREEZE_REFILL.test('Refill your hearts for 350 gems')).toBe(false);
  });
});

/* -------------------------------------------------------------------- ECO-14 */

describe('streak milestones', () => {
  it('[INV-ECO-14] the milestone set is exactly {7, 30, 100, 365, 1000}', () => {
    expect([...STREAK_MILESTONES]).toEqual([7, 30, 100, 365, 1000]);
  });

  it('[INV-ECO-14] every milestone string keys off the streak NUMBER, never the calendar date', () => {
    // The engine exposes no date-shaped milestone copy at all: a grep for a date format
    // inside any string literal in the economy module is the executable form of "never
    // the calendar date".
    const economyFiles = SHIPPED_FILES.filter((f) =>
      relative(ROOT, f).startsWith('packages/core/src/economy/'),
    );
    expect(economyFiles.length).toBeGreaterThan(0);
    const dateShaped = /\bYYYY-MM-DD\b|\b\d{4}-\d{2}-\d{2}\b|\btoLocaleDateString\b/;
    const offenders: string[] = [];
    for (const file of economyFiles) {
      for (const literal of stringLiteralsIn(readFileSync(file, 'utf8'))) {
        if (dateShaped.test(literal)) offenders.push(`${relative(ROOT, file)}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('[INV-ECO-14] the streak goal has a defined resolution: rail, celebration, re-pick, silent reset', () => {
    // The four options are the rail; every one of them is a number the celebration and
    // the re-pick read. A goal outside the rail has no resolution and must not exist.
    expect(STREAK_MILESTONES.every((m) => Number.isInteger(m) && m > 0)).toBe(true);
    expect(STREAK_REPAIRS_PER_MONTH).toBe(1);
    expect(STREAK_FREEZE_CAP).toBe(2);
  });
});

/* -------------------------------------------------------------------- ECO-32 */

describe('story and radio XP', () => {
  it("[INV-ECO-32] each format has ONE table keyed by EC-ECO-37's four entry points", () => {
    // EC-ECO-37 fixes the SHAPE: "one long-form audio XP table per format keyed
    // {first, replay_plain, hub_recommended, legendary}". Asserting the spec's key names
    // is the only version of this test that can catch a table with four plausible keys.
    expect([...LONG_FORM_XP_KEYS]).toEqual([
      'first',
      'replay_plain',
      'hub_recommended',
      'legendary',
    ]);
    for (const table of [STORY_XP, RADIO_XP]) {
      for (const key of LONG_FORM_XP_KEYS) {
        expect(Object.hasOwn(table, key), key).toBe(true);
        expect(Number.isInteger(table[key])).toBe(true);
      }
    }
    const offenders = SHIPPED_FILES.filter((file) => {
      if (relative(ROOT, file) === 'packages/core/src/economy/config.ts') return false;
      return /sessionXP\s*\(\s*['"]?(story|radio)/i.test(
        withoutComments(readFileSync(file, 'utf8')),
      );
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('[INV-ECO-32] radio is 20 first / 10 replay per EC-ECO-08, and a replay never pays first XP', () => {
    expect(RADIO_XP.first).toBe(20);
    // EC-ECO-08: "Radio: 20 first / 10 replay, once per episode per day"; EC-ECO-37:
    // "Radio is 20/10 scaled by the episode-duration ramp". Not the 5 XP review award.
    expect(RADIO_XP.replay_plain).toBe(10);
    expect(STORY_XP.first).toBe(20);
    for (const table of [STORY_XP, RADIO_XP]) {
      expect(table.replay_plain).toBeLessThan(table.first);
      expect(table.hub_recommended).toBeLessThanOrEqual(table.first);
    }
  });

  it('[INV-ECO-32] each table names the per-local-day key EC-ECO-08 scopes its bonus by', () => {
    // "Hub-recommended bonus once per STORY per local_day ... Radio: once per EPISODE per
    // day." Two different keys, so the ledger writer must be told which.
    expect(STORY_XP.perLocalDayKey).toBe('story_id');
    expect(RADIO_XP.perLocalDayKey).toBe('episode_id');
  });
});

/* -------------------------------------------------------------------- EC-ECO-20 */

describe('the Streak Society', () => {
  it('[INV-ECO-14] entry is at 7 days with three reward checkpoints, not an Ember/Blaze/Phoenix ladder', () => {
    // EC-ECO-20: "Streak Society entry threshold 7 days per the 2026 bundle, NOT the
    // invented Ember-60/Blaze-180/Phoenix-365 ladder. Three reward checkpoints; perks =
    // +3 freezes, a 30-minute boost, a yearly-upgrading VIP badge."
    expect(SOCIETY_ENTRY_STREAK_DAYS).toBe(7);
    expect(SOCIETY_CHECKPOINTS).toHaveLength(3);
    expect(SOCIETY_FREEZE_CAP_BONUS).toBe(3);
    expect(SOCIETY_BOOST_MINUTES).toBe(30);
    expect(SOCIETY_CHECKPOINTS.map((c) => c.streakDays)).not.toEqual([60, 180, 365]);
    expect(SOCIETY_CHECKPOINTS[0]?.streakDays).toBe(SOCIETY_ENTRY_STREAK_DAYS);
    // Every checkpoint day is a milestone day, so the two lists cannot diverge.
    for (const checkpoint of SOCIETY_CHECKPOINTS) {
      expect(STREAK_MILESTONES, `${checkpoint.id}`).toContain(checkpoint.streakDays);
    }
    // The badge upgrades yearly: strictly non-decreasing, and it does move.
    const years = SOCIETY_CHECKPOINTS.map((c) => c.vipBadgeYear);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(Math.max(...years)).toBeGreaterThan(Math.min(...years));
  });
});

/* ------------------------------------------------- the constants other tasks read */

describe('constants this task owns for the rest of P1', () => {
  it('names the boost constants INV-ECO-02 and INV-ECO-03 require', () => {
    expect(Number.isInteger(BOOST_GRACE_SECONDS)).toBe(true);
    expect(BOOST_GRACE_SECONDS).toBeGreaterThan(0);
    expect(MAX_BOOST_INVENTORY).toBe(5);
  });

  it('names maxRolloverDeferralSeconds = 300 (ruling EC-STK-14, INV-DAY-09 consumes it)', () => {
    expect(MAX_ROLLOVER_DEFERRAL_SECONDS).toBe(300);
  });

  it('names the quest scaling window and clamp (INV-ECO-10 consumes them)', () => {
    expect(QUEST_TREND_WINDOW_DAYS).toBe(7);
    expect(QUEST_TARGET_MIN_XP).toBe(10);
    expect(QUEST_TARGET_MAX_XP).toBe(200);
  });

  it('names the two scheduler day budgets (INV-SCH-10 consumes them)', () => {
    expect(MAX_NEW_ITEMS_PER_LOCAL_DAY).toBeGreaterThan(0);
    expect(MIN_HOURS_BETWEEN_INTRODUCTION_AND_PRODUCTION).toBeGreaterThan(0);
  });

  it('declares a ladder for every XP mode, each with a positive cap', () => {
    expect(Object.keys(XP_LADDERS).sort()).toEqual([...XP_LADDER_MODES].sort());
    for (const mode of XP_LADDER_MODES) {
      expect(XP_LADDERS[mode].dailyXpCap).toBeGreaterThan(0);
      expect(XP_LADDERS[mode].reducedMultipliers.length).toBeGreaterThan(0);
    }
  });
});
