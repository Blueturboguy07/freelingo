/**
 * The S5 streak-goal picker (S072).
 *
 * INV-CER-14 / EC-CER-22: the picker becomes permanently false after two un-picked
 * presentations, via a `DECLINED` sentinel distinct from `null`. Backgrounding the app with
 * `I CAN DO IT` disabled is a **defer**, not a choice - and a screen with no back
 * affordance must never have a disabled CTA as its only exit, so the picker declares a
 * dismiss path.
 *
 * The predicate is `streakGoal == null`, never `streakBroken`: on a recorded break the
 * goal is nulled, the old pick stays pre-selected, and the picker re-renders **once** on
 * the first session of the new run.
 *
 * ## Ruling: a registry-vs-catalogue conflict, resolved in favour of EC-CER-22
 *
 * The invariant registry's one-line summary says the picker renders *"at most once per
 * streak run"*. EC-CER-22 - the dated, twice-cited edge case it is derived from - says
 * *"re-show S5 at most once more, then write a `DECLINED` sentinel"*, and separately
 * *"re-render S5 once on the first session of the new run"*. Those cannot both hold: the
 * day-1 defer and its one re-show happen inside a single streak run (on day 1 there is no
 * streak at all), so the opening ladder is two presentations in one run.
 *
 * **EC-CER-22 wins**, because it is the grounded ruling and the registry line is its
 * summary. What ships, and what the properties assert:
 *
 * 1. At most `MAX_UNPICKED_PRESENTATIONS` (2) *consecutive un-picked* presentations ever;
 *    the second writes `DECLINED`, which is permanent and survives a break.
 * 2. A pick resets that counter - a picked presentation was never an un-picked one.
 * 3. A break after a pick re-arms the picker for **exactly one** render in the new run
 *    (`RENDERS_GRANTED_AFTER_A_BREAK`), which is EC-CER-22's second sentence verbatim. A
 *    break part-way through the opening ladder grants nothing: the ladder simply continues.
 *
 * This ruling is recorded in `docs/owned/ceremony.json` under `rulings`.
 */

/** Distinct from `null`: null means "not chosen yet", DECLINED means "never ask again". */
export const DECLINED = 'DECLINED';
export type StreakGoal = number | null | typeof DECLINED;

export interface StreakGoalState {
  readonly goal: StreakGoal;
  /**
   * **Consecutive un-picked** presentations. Not per-run and not lifetime-total: a pick
   * resets it to 0, and a break after a pick re-arms it to leave exactly one render.
   */
  readonly presentations: number;
  /** The previous pick, kept pre-selected across a break. */
  readonly lastPicked: number | null;
}

export const FRESH_STREAK_GOAL_STATE: StreakGoalState = {
  goal: null,
  presentations: 0,
  lastPicked: null,
};

/** Consecutive un-picked presentations after which the sentinel is written. */
export const MAX_UNPICKED_PRESENTATIONS = 2;

/**
 * `re-render S5 once on the first session of the new run` (EC-CER-22). One, not two: the
 * two-step ladder is the *opening* offer, and a learner who has already picked a goal once
 * has told us they understand the screen.
 */
export const RENDERS_GRANTED_AFTER_A_BREAK = 1;

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

/** A picked presentation was never an un-picked one, so the ladder resets. */
export function recordPicked(state: StreakGoalState, days: number): StreakGoalState {
  return { goal: days, presentations: 0, lastPicked: days };
}

/**
 * The streak broke. Scope the goal to a streak run: null the goal and keep the old pick
 * pre-selected. A goal already DECLINED stays declined - the sentinel is permanent.
 *
 * The re-arm is deliberately **not** a reset to zero. A learner who had picked a goal gets
 * exactly one render in the new run (EC-CER-22); a learner who broke part-way through the
 * opening two-step ladder gets no free renders - the ladder continues where it stopped, so
 * no trace can ever produce three consecutive un-picked presentations.
 */
export function onStreakBroken(state: StreakGoalState): StreakGoalState {
  if (state.goal === DECLINED) return state;
  const hadPicked = typeof state.goal === 'number';
  return {
    goal: null,
    presentations: hadPicked
      ? MAX_UNPICKED_PRESENTATIONS - RENDERS_GRANTED_AFTER_A_BREAK
      : state.presentations,
    lastPicked: hadPicked ? (state.goal as number) : state.lastPicked,
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
