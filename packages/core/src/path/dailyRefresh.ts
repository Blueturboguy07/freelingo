/**
 * Daily Refresh (S025) - the permanent tail of a finished course.
 *
 * INV-PATH-08 / EC-PTH-12, EC-PTH-13: locked **iff** the course is incomplete, and it
 * unlocks exactly once. `Complete the course to unlock this section!` (str:2276) ->
 * `You unlocked Daily Refresh! Come back daily to practice fresh skills and stay sharp!`
 * (str:2739).
 */
import type { PathModel } from './types.js';
import { allUnits } from './types.js';
import { unitCompleted } from './unlock.js';

/** 6 levels, daily reset, recycled content only (duoplanet daily-refresh). */
export const DAILY_REFRESH_LEVELS = 6;

/** Every unit of every main section is fully complete. */
export function courseComplete(model: PathModel): boolean {
  const units = allUnits(model);
  return units.length > 0 && units.every(unitCompleted);
}

/**
 * Locked iff the course is incomplete. Exactly the invariant, with no second clause.
 *
 * **The `dailyRefreshUnlocked` latch is deliberately NOT read here**, and the two halves of
 * INV-PATH-08 are why. "Locked iff the course is incomplete" is a biconditional over the
 * *current* model, so a pack update that adds a unit re-locks the section - the learner has
 * not finished the course any more, and offering a finished-course surface would be a lie.
 * "Unlocks exactly once" is about the *ceremony*: `unlockDailyRefresh` fires the screen on
 * the first incomplete->complete transition and never again, whatever the pack does later.
 * Folding the latch into this predicate would collapse the two clauses into one and lose
 * the re-lock. `dailyRefresh.test.ts` owns both directions.
 */
export function dailyRefreshLocked(model: PathModel): boolean {
  return !courseComplete(model);
}

export const DAILY_REFRESH_LOCKED_COPY = 'Complete the course to unlock this section!';

export interface DailyRefreshUnlock {
  readonly headline: string;
  readonly body: string;
}

/**
 * Fires on the incomplete->complete transition only. `model.dailyRefreshUnlocked` is the
 * once-ever latch: after it is set the ceremony never renders the unlock again, however
 * many times the course is re-completed by a pack update.
 */
export function unlockDailyRefresh(model: PathModel): {
  readonly model: PathModel;
  readonly screen: DailyRefreshUnlock | null;
} {
  if (model.dailyRefreshUnlocked || dailyRefreshLocked(model)) return { model, screen: null };
  return {
    model: { ...model, dailyRefreshUnlocked: true },
    screen: {
      headline: `Congrats on finishing the Freelingo ${model.manifest.languageName} course!`,
      body: 'You unlocked Daily Refresh! Come back daily to practice fresh skills and stay sharp!',
    },
  };
}
