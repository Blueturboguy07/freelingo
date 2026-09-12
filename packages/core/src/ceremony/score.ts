/**
 * The Score slot of the ceremony (S068 / S069 / S070) and the two quantities behind it.
 *
 * INV-CER-11 / EC-CER-18: split the quantity. `exposure_fraction` is cumulative
 * retrievability-weighted exposure, so **any answered item advances it** and the Score
 * screen keeps its observed cadence; the integer `mastery_score` stays mastery-gated and
 * **non-decreasing forever**. Document it, or the two readings silently disagree.
 *
 * INV-CER-17 / EC-CER-28: a Score tick-over and a CEFR band crossing contribute **exactly
 * one** entry at the Score slot - a band crossing adds one extra line, never a second
 * screen, because the dwell budget binds.
 *
 * INV-CER-08 / EC-CER-12: `ceilingReachedThisSession` fires exactly once in a course's
 * lifetime; afterwards the Score-progress screen is permanently suppressed and the chip's
 * tap target is repointed. Never let a recurring screen vanish without a terminal beat.
 */

export interface ScoreState {
  /** 0..1, strictly increasing over any session with >= 1 graded item. */
  readonly exposureFraction: number;
  /** The integer the chip shows. Non-decreasing forever. */
  readonly masteryScore: number;
  /** Course ceiling, from the pack manifest. */
  readonly ceiling: number;
  /** Has the once-ever `Score maxed` beat already rendered? */
  readonly ceilingBeatShown: boolean;
  readonly unlocked: boolean;
}

export interface SessionScoreInput {
  readonly gradedItems: number;
  /** Retrievability-weighted exposure this session adds, before clamping. */
  readonly exposureDelta: number;
  /** Mastery the scheduler says was gained. Negative values are refused. */
  readonly masteryDelta: number;
}

/** Smallest exposure step. A session with graded items always moves the fraction. */
export const MIN_EXPOSURE_STEP = 1e-6;

export interface ScoreAdvance {
  readonly state: ScoreState;
  readonly unlockedThisSession: boolean;
  readonly fractionChanged: boolean;
  readonly ceilingReachedThisSession: boolean;
  /** Band boundaries the integer crossed this session. */
  readonly bandBoundariesCrossed: number;
}

export function advanceScore(
  state: ScoreState,
  input: SessionScoreInput,
  bandIndexOf: (score: number) => number,
): ScoreAdvance {
  const hadGraded = input.gradedItems > 0;
  const rawFraction = hadGraded
    ? Math.max(
        state.exposureFraction + Math.max(input.exposureDelta, MIN_EXPOSURE_STEP),
        state.exposureFraction + MIN_EXPOSURE_STEP,
      )
    : state.exposureFraction;
  const exposureFraction = Math.min(1, rawFraction);
  // Non-decreasing forever, and the ceiling clamps the GAIN, never the standing number.
  //
  // `Math.min(ceiling, ...)` on the outside was wrong in exactly one way that matters: the
  // ceiling is pack data (`manifest.scoreCeiling`), so a pack update that ships a lower
  // ceiling - a beta pack narrowing its scope, a re-baked manifest - would have *lowered*
  // a learner's Score, which is the one thing INV-CER-11 forbids. A negative mastery delta
  // is dropped, and so is a shrinking ceiling.
  const masteryScore = Math.max(
    state.masteryScore,
    Math.min(state.ceiling, state.masteryScore + Math.max(0, input.masteryDelta)),
  );
  const reachedCeiling = masteryScore >= state.ceiling && !state.ceilingBeatShown;
  return {
    state: {
      ...state,
      exposureFraction,
      masteryScore,
      unlocked: state.unlocked || hadGraded,
      ceilingBeatShown: state.ceilingBeatShown || reachedCeiling,
    },
    unlockedThisSession: !state.unlocked && hadGraded,
    fractionChanged: exposureFraction !== state.exposureFraction,
    ceilingReachedThisSession: reachedCeiling,
    bandBoundariesCrossed: Math.max(0, bandIndexOf(masteryScore) - bandIndexOf(state.masteryScore)),
  };
}

/**
 * The ONE entry the Score slot contributes. `bandBeats` is a line on that entry, never a
 * second screen (INV-CER-17).
 */
export interface ScoreSlotEntry {
  readonly slot: 'S068_scoreUnlock' | 'S069_scoreProgress' | 'S070_scoreMaxed';
  readonly bandBeats: number;
}

export function scoreSlotEntries(
  advance: ScoreAdvance,
  ceilingBeatAlreadyShown: boolean,
): readonly ScoreSlotEntry[] {
  if (advance.unlockedThisSession) {
    return [{ slot: 'S068_scoreUnlock', bandBeats: advance.bandBoundariesCrossed }];
  }
  if (advance.ceilingReachedThisSession) {
    return [{ slot: 'S070_scoreMaxed', bandBeats: advance.bandBoundariesCrossed }];
  }
  // After the terminal beat the progress screen is permanently suppressed.
  if (ceilingBeatAlreadyShown) return [];
  if (advance.fractionChanged) {
    return [{ slot: 'S069_scoreProgress', bandBeats: advance.bandBoundariesCrossed }];
  }
  return [];
}
