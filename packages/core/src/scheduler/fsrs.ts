/**
 * The FSRS wrapper (INV-SCH-01, INV-SCH-02, INV-SCH-11, INV-SCH-12).
 *
 * The algorithm is ts-fsrs 5.4.2 and is never re-implemented here — plan §Engine and the
 * task brief both say so, and a hand-rolled forgetting curve is exactly the kind of silent
 * fault §5 opens by warning about. What this file adds is everything the library has no
 * opinion about:
 *
 *   - the 0.6x early-review guard                      INV-SCH-01 / EC-SCH-01
 *   - a two-sided clamp on elapsed, with anomaly rows   INV-SCH-02 / EC-SCH-02
 *   - zero elapsed accrued across a hold                INV-SCH-07, -08
 *   - rows keyed `(item, surface)` with an introduction beat  INV-SCH-11
 *   - ruby-on encounters that credit the lexeme, not the grapheme  INV-SCH-12
 *
 * THE VIRTUAL-INSTANT TRICK, because it carries four of those rules at once: ts-fsrs
 * derives elapsed itself, from `card.last_review` to the `now` it is handed. There is no
 * parameter for "pretend three days of this did not happen". So instead of passing the
 * real instant, this file passes `last_review + effectiveElapsedMs` and then puts the
 * answer back on the row's own timeline. The row's timeline is `last_review + CLAMPED
 * elapsed` — the wall clock when the clock is honest, and never behind where it already
 * was when it is not — and `due_at` slides forward by the HELD time alone. That last part
 * is what makes "the due set on re-enable equals the due set at disable time" true rather
 * than aspirational, and the first is what stops a clock set back from dragging the whole
 * row backwards through ts-fsrs's calendar-day arithmetic.
 */
import { State, createEmptyCard, fsrs, type Card, type FSRS } from 'ts-fsrs';
import {
  EARLY_REVIEW_FRACTION,
  FSRS_PARAMETERS,
  MAXIMUM_INTERVAL_DAYS,
  MS_PER_DAY,
} from './config.js';
import { resolveElapsed } from './elapsed.js';
import { heldMsBetween, type HoldWindow } from './holds.js';
import type {
  AnomalyRow,
  FsrsRowKey,
  Grade,
  ItemId,
  ItemKind,
  Modality,
  ReviewKind,
  Surface,
} from './types.js';
import { rowKeyOf } from './types.js';

/** One row of FSRS state. Keyed `(item, surface)` — INV-SCH-11, EC-SCH-12. */
export interface FsrsRow {
  readonly key: FsrsRowKey;
  readonly itemId: ItemId;
  readonly surface: Surface;
  readonly kind: ItemKind;
  /** Which modalities this row can be generated in (`holds.ts` reads it). */
  readonly modalities: readonly Modality[];
  /** ts-fsrs state. Never written except through `reviewRow`. */
  readonly card: Card;
  /**
   * Retrievability at the last encounter, early ones included.
   *
   * EC-SCH-01: an early review "updates retrievability" and nothing else. This is the
   * field that moves; `card` is the field that does not.
   */
  readonly retrievability: number;
  /** The introduction beat. `null` = this surface has never been taught (INV-SCH-11). */
  readonly introducedAt: Date | null;
  readonly lastReviewKind: ReviewKind | null;
}

export interface NewRowSpec {
  readonly itemId: ItemId;
  readonly surface: Surface;
  readonly kind: ItemKind;
  readonly modalities?: readonly Modality[];
}

/** A row with no introduction beat: it exists, and it may not be rendered or credited. */
export function newRow(spec: NewRowSpec): FsrsRow {
  return {
    key: rowKeyOf(spec.itemId, spec.surface),
    itemId: spec.itemId,
    surface: spec.surface,
    kind: spec.kind,
    modalities: spec.modalities ?? [],
    card: createEmptyCard(new Date(0)),
    retrievability: 0,
    introducedAt: null,
    lastReviewKind: null,
  };
}

/**
 * The introduction beat (INV-SCH-11, EC-SCH-12).
 *
 * "Give every surface its own introduction beat. Never render or credit a surface with no
 * prior introduction, or a kana-only learner meets a kanji they have never been taught."
 * Introducing twice is a no-op, so a replayed commit cannot reset the clock.
 */
export function introduceRow(row: FsrsRow, at: Date): FsrsRow {
  if (row.introducedAt !== null) return row;
  return {
    ...row,
    card: createEmptyCard(at),
    introducedAt: at,
    lastReviewKind: 'introduction',
  };
}

export function isIntroduced(row: FsrsRow): boolean {
  return row.introducedAt !== null;
}

/**
 * INV-SCH-11's render gate. Generation asks this before it puts a surface on screen, and
 * `reviewRow` asks it again before crediting one — a gate checked on only one of those two
 * paths is a gate that holds until the first bug upstream.
 */
export function canRenderSurface(row: FsrsRow): boolean {
  return isIntroduced(row);
}

export interface ReviewInput {
  readonly grade: Grade;
  /** The real wall instant of the answer. */
  readonly now: Date;
  /** Held milliseconds inside `[last_review, now)`, from `heldMsBetween`. */
  readonly heldMs?: number;
  /** Whether furigana/ruby was rendered over the target (INV-SCH-12). */
  readonly rubyShown?: boolean | undefined;
  /** Whether the row is under an open hold right now (report, modality). */
  readonly held?: boolean | undefined;
}

export interface ReviewResult {
  readonly row: FsrsRow;
  readonly kind: ReviewKind;
  /** The interval the row carries AFTER this encounter, in days. */
  readonly intervalDays: number;
  readonly effectiveElapsedMs: number;
  readonly rawElapsedMs: number;
  readonly anomalies: readonly AnomalyRow[];
}

let shared: FSRS | null = null;
function engine(): FSRS {
  shared ??= fsrs(FSRS_PARAMETERS);
  return shared;
}

/** The scheduled interval a row is currently carrying, in milliseconds. */
export function scheduledIntervalMs(row: FsrsRow): number {
  return row.card.scheduled_days * MS_PER_DAY;
}

/**
 * Would this encounter be early? EC-SCH-01's `elapsed < 0.6 x scheduled_interval`.
 *
 * Only a card in the `Review` state has a scheduled interval worth the name: a card still
 * walking its learning steps is scheduled in minutes and is MEANT to come back inside the
 * hour, so applying the guard there would freeze it at step one forever.
 */
export function isEarlyReview(row: FsrsRow, effectiveElapsedMs: number): boolean {
  if (row.card.state !== State.Review) return false;
  const scheduled = scheduledIntervalMs(row);
  if (scheduled <= 0) return false;
  return effectiveElapsedMs < EARLY_REVIEW_FRACTION * scheduled;
}

/**
 * The retrievability ts-fsrs reports for this card after `elapsedMs` of honest time.
 *
 * Asked at the VIRTUAL instant, so a held week does not read as a week of forgetting.
 */
function retrievabilityAfter(card: Card, elapsedMs: number): number {
  const base = card.last_review ?? card.due;
  return engine().get_retrievability(
    card,
    new Date(base.getTime() + Math.max(0, elapsedMs)),
    false,
  );
}

/**
 * Apply one encounter to one row.
 *
 * Order matters and is the invariant list in miniature:
 *   1. no introduction beat, or held  -> `uncredited`, nothing moves (INV-SCH-11, -07, -08)
 *   2. ruby on, grapheme row          -> `rubyAssisted`, nothing moves (INV-SCH-12)
 *   3. elapsed clamped and de-held                                     (INV-SCH-02)
 *   4. early                          -> `early`, retrievability only  (INV-SCH-01)
 *   5. otherwise                      -> ts-fsrs decides everything
 */
export function reviewRow(row: FsrsRow, input: ReviewInput): ReviewResult {
  const { now, grade } = input;

  if (!isIntroduced(row) || input.held === true) {
    const anomaly: AnomalyRow = {
      kind: input.held === true ? 'heldItemEncounter' : 'uncreditedSurface',
      rowKey: row.key,
      at: now,
      observedMs: null,
      usedMs: null,
      note: isIntroduced(row)
        ? 'encounter of a held row: generation should not have offered it'
        : 'encounter of a surface with no introduction beat',
    };
    return {
      row: { ...row, lastReviewKind: 'uncredited' },
      kind: 'uncredited',
      intervalDays: row.card.scheduled_days,
      effectiveElapsedMs: 0,
      rawElapsedMs: row.card.last_review ? now.getTime() - row.card.last_review.getTime() : 0,
      anomalies: [anomaly],
    };
  }

  const elapsed = resolveElapsed({
    lastReviewAt: row.card.last_review ?? row.introducedAt,
    now,
    heldMs: input.heldMs ?? 0,
    rowKey: row.key,
  });

  /**
   * INV-SCH-12. "Grapheme items accrue FSRS credit ONLY from ruby-suppressed encounters;
   * lexeme items schedule normally with ruby on. Furigana is a display choice, never a
   * silent difficulty setting." Twelve ruby-rendered sightings of a kanji must leave its
   * grapheme row exactly where it was.
   *
   * Retrievability still moves: the learner did see the glyph, and the hub uses that to
   * promote exactly the graphemes with no ruby-off encounter.
   */
  if (input.rubyShown === true && row.kind === 'grapheme') {
    return {
      row: {
        ...row,
        retrievability: retrievabilityAfter(row.card, elapsed.effectiveElapsedMs),
        lastReviewKind: 'rubyAssisted',
      },
      kind: 'rubyAssisted',
      intervalDays: row.card.scheduled_days,
      effectiveElapsedMs: elapsed.effectiveElapsedMs,
      rawElapsedMs: elapsed.rawElapsedMs,
      anomalies: elapsed.anomalies,
    };
  }

  /**
   * INV-SCH-01. Retrievability and the attempt row; NOT stability, NOT `due_at`.
   *
   * `card` is returned by reference-equal spread on purpose: the test asserts the four
   * scheduling fields are untouched, and the cheapest way to be sure of that is not to
   * build a new card at all.
   */
  if (isEarlyReview(row, elapsed.effectiveElapsedMs)) {
    return {
      row: {
        ...row,
        retrievability: retrievabilityAfter(row.card, elapsed.effectiveElapsedMs),
        lastReviewKind: 'early',
      },
      kind: 'early',
      intervalDays: row.card.scheduled_days,
      effectiveElapsedMs: elapsed.effectiveElapsedMs,
      rawElapsedMs: elapsed.rawElapsedMs,
      anomalies: elapsed.anomalies,
    };
  }

  const lastReview = row.card.last_review ?? row.introducedAt ?? now;
  const virtualNow = new Date(lastReview.getTime() + elapsed.effectiveElapsedMs);
  /**
   * The row's own anchor: the last review PLUS THE CLAMPED elapsed, not the wall clock.
   *
   * On an honest clock with nothing held these are the same instant, and `due` lands on
   * the wall clock as you would expect. They separate in exactly two cases, and in both
   * the anchor is the honest reading:
   *
   * - The clock went BACKWARDS. Clamped elapsed is 0, so the anchor stays where it was and
   *   `due` does not move. Writing the earlier wall instant instead would drag the row's
   *   whole timeline backwards — and it is not a cosmetic drag: ts-fsrs derives elapsed in
   *   whole days from the calendar, so an anchor pushed across midnight reads as a day of
   *   forgetting that never happened. Measured 2026-09-11: the three-step history
   *   `[Again@-1h, Again@+1h, Again]` from 2026-01-01T00:00Z reached stability 0.04715711
   *   with a real-clock anchor against 0.03485141 on the honest replay of the same elapsed.
   * - The clock jumped FORWARD past the honest ceiling. The excess is clamped away, so the
   *   anchor moves by the ceiling and not by the three centuries somebody typed in.
   *
   * `offsetMs` is therefore the HELD time and nothing else: time that genuinely passed and
   * that the row is entitled to have `due` pushed forward by (INV-SCH-07, INV-SCH-08).
   */
  const anchorNow = new Date(lastReview.getTime() + elapsed.clampedElapsedMs);
  const offsetMs = elapsed.heldMs;

  const next = engine().next(row.card, virtualNow, grade).card;
  const card = translateToRealTime(next, anchorNow, offsetMs);

  return {
    row: {
      ...row,
      card,
      retrievability: retrievabilityAfter(row.card, elapsed.effectiveElapsedMs),
      lastReviewKind: 'scheduled',
    },
    kind: 'scheduled',
    intervalDays: card.scheduled_days,
    effectiveElapsedMs: elapsed.effectiveElapsedMs,
    rawElapsedMs: elapsed.rawElapsedMs,
    anomalies: elapsed.anomalies,
  };
}

/**
 * Move a card ts-fsrs scheduled in virtual time onto the row's own timeline.
 *
 * `due` slides forward by the held time and `last_review` becomes the anchor computed
 * above, so the next encounter measures elapsed from where the learner actually is.
 * `scheduled_days` is clamped to `MAXIMUM_INTERVAL_DAYS`:
 * ts-fsrs caps the interval it computes but then re-derives the day count from the due
 * date, which lands on 36500, 36501 or 36502 by rounding (measured 2026-09-11), and that
 * one-day jitter is the only thing that makes a saturated card's interval sequence
 * non-monotonic under INV-SCH-01.
 */
function translateToRealTime(card: Card, anchorNow: Date, offsetMs: number): Card {
  const scheduledDays = Math.min(card.scheduled_days, MAXIMUM_INTERVAL_DAYS);
  const due =
    scheduledDays === card.scheduled_days
      ? new Date(card.due.getTime() + offsetMs)
      : new Date(anchorNow.getTime() + scheduledDays * MS_PER_DAY);
  return { ...card, due, scheduled_days: scheduledDays, last_review: anchorNow };
}

/**
 * INV-SCH-02's honest-clock bound, as a CONSTRUCTION rather than a number.
 *
 * The bound is "the most stability an honest clock could have produced". The temptation is
 * to compute it analytically — evaluate the same grade at the largest elapsed the clamp
 * admits and call that the ceiling. That is wrong, and measurably so: run 2026-09-11,
 * `Australia/Lord_Howe`, the two-step history `[Easy, Again]` reached stability 8.2956
 * against a "ceiling" of 3.9056, because stability is NOT monotone in elapsed across
 * states and grades — a lapse and a learning-step card both break the direction.
 *
 * So the bound is proved instead of estimated. This replays a grade sequence on a strictly
 * monotone clock, waiting the effective elapsed the clamp produced before each answer, and
 * the INV-SCH-02 property asserts the replay lands on the same state. The adversarial
 * outcome is therefore not merely below the honest bound, it IS an honest outcome — here is
 * a specific, non-negative, monotone clock sequence that produces it.
 *
 * Pass only the encounters that CHANGED the row (`kind === 'scheduled'`). An early, ruby-on
 * or uncredited encounter moves nothing and does not consume its elapsed — `last_review`
 * stays where it was — so including one would advance the replay clock past the anchor the
 * real row is measuring from. That is not a licence to skip them: they are no-ops, which is
 * itself asserted, by INV-SCH-01 and INV-SCH-12 and again at the call site.
 */
export function replayOnHonestClock(
  seed: FsrsRow,
  steps: readonly { readonly grade: Grade; readonly effectiveElapsedMs: number }[],
  start: Date,
): FsrsRow {
  let row = seed;
  let at = start.getTime();
  for (const step of steps) {
    at += Math.max(0, step.effectiveElapsedMs);
    row = reviewRow(row, { grade: step.grade, now: new Date(at) }).row;
  }
  return row;
}

/** When this row next comes due, on the wall clock, ignoring holds. */
export function dueAt(row: FsrsRow): Date {
  return row.card.due;
}

/** The instant the row's current interval is measured from. */
function intervalBase(row: FsrsRow): Date {
  return row.card.last_review ?? row.introducedAt ?? row.card.due;
}

/**
 * How far past its due date the row is, in ms. Negative when it is not due yet.
 *
 * WITH HOLDS, this is the whole of INV-SCH-07 and INV-SCH-08 as the generator sees them.
 * Overdue-ness is `unheld elapsed - the scheduled interval`, so a row that spent three days
 * with its modality off, or seven local days under a report, comes back exactly as overdue
 * as it was when the window opened — not three days and not a week further on. That is
 * what stops "three days with listening off" from producing EC-SCH-09's several-hundred-
 * item false backlog, and what stops a dismissed report from reading as a lapse.
 *
 * With no holds it reduces to `at - due`, algebraically: the base cancels.
 */
export function overdueMsAt(row: FsrsRow, at: Date, holds: readonly HoldWindow[] = []): number {
  const base = intervalBase(row).getTime();
  const intervalMs = row.card.due.getTime() - base;
  const elapsed = at.getTime() - base;
  const held = holds.length === 0 ? 0 : heldMsBetween(row, holds, base, at.getTime());
  return elapsed - Math.min(held, Math.max(0, elapsed)) - intervalMs;
}

export function isDueAt(row: FsrsRow, at: Date, holds: readonly HoldWindow[] = []): boolean {
  return isIntroduced(row) && overdueMsAt(row, at, holds) >= 0;
}

/**
 * The instant this row becomes due once every hold that touched it is accounted for.
 *
 * A fixed point, because pushing the due date forward can drag more of a hold window
 * inside the interval. It converges: each iteration can only move the answer later, every
 * move lands on a window boundary, and there are finitely many of those.
 */
export function effectiveDueAt(row: FsrsRow, holds: readonly HoldWindow[] = []): Date {
  if (holds.length === 0) return row.card.due;
  const base = intervalBase(row).getTime();
  let t = row.card.due.getTime();
  for (let i = 0; i <= holds.length; i += 1) {
    const next = row.card.due.getTime() + heldMsBetween(row, holds, base, t);
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}
