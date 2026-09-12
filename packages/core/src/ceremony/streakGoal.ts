/**
 * The S5 streak-goal picker (S072).
 *
 * INV-CER-14 / EC-CER-22: the picker renders **at most once per streak run** and becomes
 * permanently false after two un-picked presentations, via a `DECLINED` sentinel distinct
 * from `null`. Backgrounding the app with `I CAN DO IT` disabled is a **defer**, not a
 * choice - and a screen with no back affordance must never have a disabled CTA as its only
 * exit, so the picker declares a dismiss path.
 *
 * The predicate is `streakGoal == null`, never `streakBroken`: on a recorded break the
 * goal is nulled, the old pick stays pre-selected, and the picker re-renders **once** on
 * the first session of the new run.
 */

/** Distinct from `null`: null means "not chosen yet", DECLINED means "never ask again". */
export const DECLINED = 'DECLINED';
export type StreakGoal = number | null | typeof DECLINED;

export interface StreakGoalState {
  readonly goal: StreakGoal;
  /** Un-picked presentations in the current streak run. */
  readonly presentations: number;
  /** The previous pick, kept pre-selected across a break. */
  readonly lastPicked: number | null;
}

export const FRESH_STREAK_GOAL_STATE: StreakGoalState = {
  goal: null,
  presentations: 0,
  lastPicked: null,
};

/** Presentations after which the sentinel is written. */
export const MAX_UNPICKED_PRESENTATIONS = 2;

/** `7 Good / 14 Great / 30 Incredible / 50 Unstoppable` (`screens/054`, L1991-1994). */
export const STREAK_GOAL_OPTIONS: readonly { readonly days: number; readonly qualifier: string }[] =
  [
    { days: 7, qualifier: 'Good' },
    { days: 14, qualifier: 'Great' },
    { days: 30, qualifier: 'Incredible' },
    { days: 50, qualifier: 'Unstoppable' },
  ];

export function pickerShouldRender(state: StreakGoalState): boolean {
  return state.goal === null && state.presentations < MAX_UNPICKED_PRESENTATIONS;
}

/** The picker was shown and the learner left without picking. */
export function recordDeferred(state: StreakGoalState): StreakGoalState {
  const presentations = state.presentations + 1;
  return {
    goal: presentations >= MAX_UNPICKED_PRESENTATIONS ? DECLINED : state.goal,
    presentations,
    lastPicked: state.lastPicked,
  };
}

export function recordPicked(state: StreakGoalState, days: number): StreakGoalState {
  return { goal: days, presentations: state.presentations, lastPicked: days };
}

/**
 * The streak broke. Scope the goal to a streak run: null the goal, keep the old pick
 * pre-selected, reset the presentation count so the new run gets its one render. A goal
 * already DECLINED stays declined - the sentinel is permanent.
 */
export function onStreakBroken(state: StreakGoalState): StreakGoalState {
  if (state.goal === DECLINED) return state;
  return {
    goal: null,
    presentations: 0,
    lastPicked: typeof state.goal === 'number' ? state.goal : state.lastPicked,
  };
}

/** Every ceremony screen needs an exit that is not a disabled button (EC-CER-22). */
export interface PickerScreen {
  readonly options: readonly { readonly days: number; readonly qualifier: string }[];
  readonly preselected: number | null;
  readonly ctaEnabled: boolean;
  /** Always true. The picker is also reachable from Settings. */
  readonly dismissible: true;
}

export function pickerScreen(state: StreakGoalState, selected: number | null): PickerScreen {
  return {
    options: STREAK_GOAL_OPTIONS,
    preselected: selected ?? state.lastPicked,
    ctaEnabled: (selected ?? state.lastPicked) !== null,
    dismissible: true,
  };
}
