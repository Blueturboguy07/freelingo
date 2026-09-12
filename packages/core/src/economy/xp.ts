/**
 * The XP award engine: the boost resolution, the per-mode ladder, and the one function
 * that decides what a session pays.
 *
 * Owns INV-ECO-02 (the multiplier is read at start, committed as read, and cannot be
 * banked past the grace), INV-ECO-06 (the per-mode daily ladder, keyed globally),
 * INV-ECO-07 and INV-ECO-08 (once-per-node Legendary, replayable Daily Refresh),
 * INV-ECO-15 (advertised equals awarded), INV-ECO-16 (one checkpoint award per node per
 * day), INV-ECO-21 (`goalMet`) and INV-ECO-30 (the tile agrees with the multiplier).
 *
 * Every number comes from `config.ts`. Nothing here spells one.
 */
import type {
  ActiveBoost,
  SessionFlavour,
  SessionOutcomeKind,
  XpLadderMode,
} from '../types/index.js';
import {
  BOOST_GRACE_SECONDS,
  FLAVOUR_XP,
  GOAL_TIERS,
  RADIO_XP,
  REPLAY_PRACTICE_XP,
  STORY_XP,
  XP_LADDERS,
  ZERO_AWARD_LABEL,
  comboBonus,
  flavourRow,
  type GoalTierKey,
  type LongFormEntryPoint,
  type LongFormXpTable,
} from './config.js';

/* ------------------------------------------------------------------- the boost */

/**
 * The one-line explanation S067 carries when a parked session commits at 1x
 * (ruling EC-ECO-02). It exists so the smaller number is explained rather than merely
 * smaller — the learner saw a doubled tile promised when the session began.
 */
export const BOOST_LAPSED_EXPLANATION =
  'Your XP Boost ran out while this was parked, so it paid the usual XP.';

export interface BoostResolutionInput {
  readonly flavour: SessionFlavour;
  readonly outcome: SessionOutcomeKind;
  /** The boost in force AT SESSION START, as written to the session row. */
  readonly boostAtSessionStart: ActiveBoost | null;
  readonly committedAtUtc: string;
}

export interface BoostResolution {
  /** What the session row recorded when it started. */
  readonly recordedMultiplier: number;
  /** What the commit actually applies. Equal to the recorded one unless the grace lapsed. */
  readonly appliedMultiplier: number;
  /** Non-empty exactly when the applied number is smaller than the recorded one. */
  readonly explanation: string;
  /** [INV-ECO-30] the XP tile's boosted look agrees with the APPLIED multiplier. */
  readonly tileIsBoosted: boolean;
}

/**
 * INV-ECO-02, in one function.
 *
 * A boost that expires mid-session still pays: the learner started under it. A session
 * PARKED past `BOOST_GRACE_SECONDS` after expiry does not, because otherwise a killed
 * session is an indefinite store of value and the multiplier stops meaning "the next
 * fifteen minutes".
 */
export function resolveBoost(input: BoostResolutionInput): BoostResolution {
  const applies = flavourRow(input.flavour, input.outcome).boostApplies;
  const boost = input.boostAtSessionStart;
  if (!applies || boost === null) {
    return {
      recordedMultiplier: 1,
      appliedMultiplier: 1,
      explanation: '',
      tileIsBoosted: false,
    };
  }
  const recordedMultiplier = boost.multiplier;
  const deadline = Date.parse(boost.expiresAtUtc) + BOOST_GRACE_SECONDS * 1_000;
  const lapsed = Date.parse(input.committedAtUtc) > deadline;
  const appliedMultiplier = lapsed ? 1 : recordedMultiplier;
  return {
    recordedMultiplier,
    appliedMultiplier,
    explanation: appliedMultiplier < recordedMultiplier ? BOOST_LAPSED_EXPLANATION : '',
    tileIsBoosted: appliedMultiplier > 1,
  };
}

/* ------------------------------------------------------------------ the ladder */

/**
 * One mode's state for one local day. It carries NO course: that omission is INV-ECO-06
 * (EC-ECO-06, "make it global per `local_day` — the rule's whole purpose is anti-farming
 * and XP is global state"), and it is why switching courses buys nothing.
 */
export interface LadderStateToday {
  readonly sessionsCompleted: number;
  readonly xpAwarded: number;
}

export const EMPTY_LADDER_STATE: LadderStateToday = { sessionsCompleted: 0, xpAwarded: 0 };

export function ladderDailyCap(mode: XpLadderMode): number {
  return XP_LADDERS[mode].dailyXpCap;
}

/** The multiplier for the (n+1)th session of a mode today; past the end, the last value. */
export function ladderMultiplier(mode: XpLadderMode, sessionsCompleted: number): number {
  const steps = XP_LADDERS[mode].reducedMultipliers;
  const index = Math.max(0, Math.min(sessionsCompleted, steps.length - 1));
  return steps[index] ?? 0;
}

/* ------------------------------------------------------ once-per-node, once-per-day */

/**
 * INV-ECO-07: `legendary_awarded_at` is set ONCE per node, ever. The second pass is a
 * `replayed` outcome, which pays the replay award and whose matrix row exposes only the
 * practice route (EC-PTH-04). Without this, unlimited free attempts under Super parity
 * make a 40 XP node the largest farm in the app.
 */
export function legendaryOutcomeFor(
  legendaryAwardedAt: string | null,
  passed: boolean,
): SessionOutcomeKind {
  if (!passed) return 'failed';
  return legendaryAwardedAt === null ? 'completed' : 'replayed';
}

/** The new value of `legendary_awarded_at`. Never overwritten once set. */
export function nextLegendaryAwardedAt(
  legendaryAwardedAt: string | null,
  passed: boolean,
  atUtc: string,
): string | null {
  if (legendaryAwardedAt !== null) return legendaryAwardedAt;
  return passed ? atUtc : null;
}

/** INV-ECO-08: a completed Daily Refresh level is replayable — never a dead screen. */
export function dailyRefreshLevelIsReplayable(): boolean {
  return true;
}

/** …and a replay is a `replayed` outcome, so it pays the replay award, not the level's. */
export function dailyRefreshOutcomeFor(alreadyCompletedToday: boolean): SessionOutcomeKind {
  return alreadyCompletedToday ? 'replayed' : 'completed';
}

/* -------------------------------------------------------------------- the award */

export interface AwardInput {
  readonly flavour: SessionFlavour;
  readonly outcome: SessionOutcomeKind;
  readonly maxCombo?: number;
  readonly boostAtSessionStart: ActiveBoost | null;
  readonly committedAtUtc: string;
  readonly ladderStateToday: LadderStateToday;
  /** Legendary only: whether this failed attempt got past the mid checkpoint. */
  readonly reachedLegendaryCheckpoint?: boolean;
  /** Legendary only: whether the checkpoint consolation was already paid TODAY. */
  readonly checkpointAlreadyPaidToday?: boolean;
  /**
   * Story/radio only: which of EC-ECO-37's four entry points this session came through.
   * Omitted, it is derived from the outcome, so a caller that forgets still cannot pay
   * first-completion XP for a replay.
   */
  readonly longFormEntry?: LongFormEntryPoint;
}

export interface SessionAward {
  readonly baseXp: number;
  readonly recordedMultiplier: number;
  readonly multiplierApplied: number;
  readonly awardedXp: number;
  readonly ladderMode: XpLadderMode;
  readonly tileIsBoosted: boolean;
  readonly explanation: string;
  /** The honest label when the ladder has run out (EC-ECO-07). */
  readonly label: string;
}

/**
 * Which of EC-ECO-37's four entry points an outcome corresponds to.
 *
 * `hub_recommended` and `legendary` are entry points the caller knows about and the
 * outcome does not, so they are passed in; everything else falls out of the outcome, and
 * a caller who passes nothing gets the safe answer rather than the generous one.
 */
export function longFormEntryFor(
  outcome: SessionOutcomeKind,
  declared?: LongFormEntryPoint,
): LongFormEntryPoint {
  if (declared !== undefined) return declared;
  return outcome === 'completed' ? 'first' : 'replay_plain';
}

/** The award for one entry point of one format. The ONE reader of the four-key table. */
export function longFormXp(table: LongFormXpTable, entry: LongFormEntryPoint): number {
  return table[entry];
}

/**
 * What a session pays before the ladder and the multiplier.
 *
 * Three shapes, in one place:
 *
 * 1. A row that declares `checkpointConsolationXp` pays THAT and nothing else when it is
 *    eligible — Legendary's failed row, at most once per node per local day (INV-ECO-16 /
 *    EC-PTH-27). Retry stays immediate, free and unlimited; ten checkpoint-abandon runs
 *    in ten minutes pay one award, not ten. The consolation is read OFF THE ROW, so a
 *    consumer that reads the matrix to decide "does this pay" and the ceremony that
 *    actually pays can no longer disagree — the previous version special-cased
 *    `legendary/failed` in code while the row said `awardsXp: false`.
 * 2. A long-form flavour reads its four-key table at the entry point it came through
 *    (EC-ECO-37), so six replays cannot pay first-completion XP.
 * 3. Everything else is `base (+ combo)`, or the flavour's own replay award.
 */
export function baseXpFor(input: AwardInput): number {
  const row = flavourRow(input.flavour, input.outcome);
  const shape = FLAVOUR_XP[input.flavour];

  if (row.checkpointConsolationXp !== null) {
    const eligible =
      input.reachedLegendaryCheckpoint === true && input.checkpointAlreadyPaidToday !== true;
    return eligible ? row.checkpointConsolationXp : 0;
  }
  if (!row.awardsXp) return 0;

  if (shape.longForm !== null) {
    return longFormXp(shape.longForm, longFormEntryFor(input.outcome, input.longFormEntry));
  }
  if (input.outcome === 'replayed') return shape.replayXp ?? REPLAY_PRACTICE_XP;
  return shape.base + (shape.comboApplies ? comboBonus(input.maxCombo) : 0);
}

/**
 * The ONE place a session's XP is decided.
 *
 * Ordered and explicit, so a term that is switched off contributes zero rather than
 * being silently dropped (EC-ECO-26): `base (+ combo) x ladder x boost`, then clamped to
 * what is left of the mode's daily cap.
 */
export function awardForSession(input: AwardInput): SessionAward {
  const ladderMode = FLAVOUR_XP[input.flavour].ladderMode;
  const baseXp = baseXpFor(input);
  const boost = resolveBoost({
    flavour: input.flavour,
    outcome: input.outcome,
    boostAtSessionStart: input.boostAtSessionStart,
    committedAtUtc: input.committedAtUtc,
  });
  const reduced = ladderMultiplier(ladderMode, input.ladderStateToday.sessionsCompleted);
  const gross = Math.floor(baseXp * reduced * boost.appliedMultiplier);
  const remaining = Math.max(0, ladderDailyCap(ladderMode) - input.ladderStateToday.xpAwarded);
  const awardedXp = Math.max(0, Math.min(gross, remaining));
  return {
    baseXp,
    recordedMultiplier: boost.recordedMultiplier,
    multiplierApplied: boost.appliedMultiplier,
    awardedXp,
    ladderMode,
    tileIsBoosted: boost.tileIsBoosted,
    explanation: boost.explanation,
    label: awardedXp === 0 && baseXp > 0 ? ZERO_AWARD_LABEL : '',
  };
}

/* ---------------------------------------------------------------- advertised XP */

export interface AdvertisedXp {
  readonly xp: number;
  /**
   * True when the advert is a FLOOR rather than an exact promise — the combo bonus can
   * only take it up. INV-ECO-15 allows a discrepancy only when it is an explicit, named
   * config value, and this is that value.
   */
  readonly isFloor: boolean;
}

/**
 * INV-ECO-15: the XP a node or offer advertises is a field read from the SAME config the
 * award reads, AT THE ENTRY POINT BEING OFFERED.
 *
 * `PRACTICE +10 XP` on the node button is `PRACTICE_XP`, the number the ceremony commits
 * — not the observed `+5` label, which under a 10 XP goal would steer a five-minute
 * learner into a longer lesson every day (ruling EC-ECO-19).
 *
 * The outcome is a PARAMETER because the offer knows it: a completed Daily Refresh level
 * and a re-tapped Legendary node both advertise a replay, and advertising the first
 * completion there is exactly the EC-HUB-06 discrepancy this invariant forbids.
 */
export function advertisedXpFor(
  flavour: SessionFlavour,
  outcome: SessionOutcomeKind = 'completed',
  longFormEntry?: LongFormEntryPoint,
): AdvertisedXp {
  const row = flavourRow(flavour, outcome);
  const shape = FLAVOUR_XP[flavour];
  const xp = baseXpFor({
    flavour,
    outcome,
    ...(longFormEntry === undefined ? {} : { longFormEntry }),
    boostAtSessionStart: null,
    committedAtUtc: new Date(0).toISOString(),
    ladderStateToday: EMPTY_LADDER_STATE,
  });
  return {
    xp,
    isFloor: row.awardsXp && shape.comboApplies && shape.longForm === null,
  };
}

/**
 * INV-ECO-32: story and radio XP come from one four-key table per format, and the
 * advertised number equals the committed number at every entry point. The falsifier is a
 * scalar literal at the call site, so there is no call site that can hold one.
 *
 * This is the table reader the node button uses; `awardForSession` reaches the SAME table
 * through `baseXpFor`, and `narrativeAward` below is the one that also applies the
 * per-mode daily ladder (EC-ECO-07: "Stories replay, Radio replay" ride it too).
 */
export function narrativeXp(format: 'story' | 'radio', entry: LongFormEntryPoint): number {
  return longFormXp(format === 'story' ? STORY_XP : RADIO_XP, entry);
}

/**
 * A story or radio session's real award: the table, then the ladder, then the cap.
 *
 * EC-ECO-07 puts "Stories replay, Radio replay" on the per-mode daily ladder by name, and
 * EC-ECO-38 puts Roleplay on it. Before this existed `narrativeXp` returned a raw
 * constant with no ladder anywhere near it, which made unlimited replays an unbounded XP
 * farm and left INV-ECO-06's property unable to see the two modes it was written for.
 */
export function narrativeAward(
  format: 'story' | 'radio',
  entry: LongFormEntryPoint,
  ladderStateToday: LadderStateToday,
  options: { readonly boostAtSessionStart?: ActiveBoost | null; readonly committedAtUtc?: string } = {},
): SessionAward {
  return awardForSession({
    flavour: format,
    outcome: entry === 'first' ? 'completed' : 'replayed',
    longFormEntry: entry,
    boostAtSessionStart: options.boostAtSessionStart ?? null,
    committedAtUtc: options.committedAtUtc ?? new Date(0).toISOString(),
    ladderStateToday,
  });
}

/* --------------------------------------------------------------------- the goal */

export function goalXpFor(tier: GoalTierKey): number {
  const row = GOAL_TIERS.find((candidate) => candidate.key === tier);
  if (row === undefined) throw new Error(`goal tier: no row for ${tier}`);
  return row.xp;
}

/**
 * INV-ECO-21 / EC-ECO-24: `goalMet <=> earnedXP >= goalXP`, INCLUSIVE. The cheapest
 * legitimate session — a flat 10 XP practice — must clear Casual, or a five-minute
 * learner on a five-minute goal misses it by one XP every single day.
 */
export function goalMet(earnedXp: number, goalXp: number): boolean {
  return earnedXp >= goalXp;
}
