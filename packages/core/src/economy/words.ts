/**
 * The two XP counters and the two word counters.
 *
 * INV-ECO-13: `account.lifetime_xp` feeds the achievements and SURVIVES course removal;
 * `course_progress.xp` is destroyed with the course. One label, two counters — and
 * word-count achievements read the UNION of content-hashed item ids, never a sum, or a
 * lexeme taught by two Romance packs is counted twice (EC-ECO-16).
 *
 * INV-ECO-27: exactly TWO word counters exist, `words_learned <= words_introduced`
 * always, every word-shaped surface reads one of them, and both count only
 * `countable: true` ledger items — characters, particles and bound morphemes are
 * excluded, so a morpheme pack and a lemma pack with equal taught vocabulary report
 * comparable numbers (EC-ECO-32).
 */
import type { AccountState, CourseId, CourseProgress, ItemId } from '../types/index.js';

/** One ledger row as the word counters see it. */
export interface WordLedgerEntry {
  readonly itemId: ItemId;
  readonly countable: boolean;
  /** Held above the retirement threshold across two consecutive successful reviews. */
  readonly learned: boolean;
}

/** The two counters. There is no third, and nothing computes a word count at render. */
export interface WordCounters {
  readonly wordsIntroduced: number;
  readonly wordsLearned: number;
}

export function wordCounters(entries: readonly WordLedgerEntry[]): WordCounters {
  const introduced = new Set<ItemId>();
  const learned = new Set<ItemId>();
  for (const entry of entries) {
    if (!entry.countable) continue;
    introduced.add(entry.itemId);
    if (entry.learned) learned.add(entry.itemId);
  }
  return { wordsIntroduced: introduced.size, wordsLearned: learned.size };
}

/**
 * The UNION of content-hashed ids across courses (INV-ECO-13).
 *
 * Ids are content hashes and carry no language, so the same lexeme in two courses is one
 * id and is counted once. A sum would report a learner of two Romance languages as
 * knowing more words than they do.
 */
export function unionItemIds(
  courses: readonly CourseProgress[],
  which: 'introduced' | 'learned',
): Set<ItemId> {
  const union = new Set<ItemId>();
  for (const course of courses) {
    const ids = which === 'introduced' ? course.introducedItemIds : course.learnedItemIds;
    for (const id of ids) union.add(id);
  }
  return union;
}

/** Course-region XP, summed. This one IS a sum: it is money, not vocabulary. */
export function totalCourseXp(courses: readonly CourseProgress[]): number {
  return courses.reduce((total, course) => total + course.xp, 0);
}

export interface CourseRemoval {
  /** Returned UNCHANGED, by identity: no account counter moves (INV-ECO-13). */
  readonly account: AccountState;
  readonly courses: readonly CourseProgress[];
}

/**
 * Remove a course (S133).
 *
 * "Your streak, gems and other courses are not affected" is a promise Freelingo makes in
 * the confirm dialog, so it is implemented as an identity: the account state that goes in
 * is the object that comes out. Only the course row is dropped.
 */
export function removeCourse(
  account: AccountState,
  courses: readonly CourseProgress[],
  courseId: CourseId,
): CourseRemoval {
  return { account, courses: courses.filter((course) => course.courseId !== courseId) };
}
