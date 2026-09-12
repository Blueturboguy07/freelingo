/**
 * Mid-lesson interstitials — S047, S049, and the step-up card S048.
 *
 * Owns INV-COM-03, INV-COM-07, INV-COM-08, INV-COM-09, INV-COM-12.
 *
 * THE ONE QUEUE. Three producers (combo milestone, difficulty step-up, mistake review)
 * emit into a single ordered queue drained a screen at a time. EC-COM-11's failure is two
 * mascot slide-ins in one frame or mistake-review jumping the step-up, so ordering is a
 * property of this module, not of whoever happens to call it first.
 */
import type { SessionFlavourConfig, StepUpKind } from './flavours.js';

/* ============================================================ 1. the producers */

export const INTERSTITIAL_PRODUCERS = ['combo', 'stepUp', 'mistakeReview'] as const;
export type InterstitialProducer = (typeof INTERSTITIAL_PRODUCERS)[number];

/** The render order EC-COM-11 fixes: combo → step-up → mistake-review. */
export const PRODUCER_ORDER: Readonly<Record<InterstitialProducer, number>> = {
  combo: 0,
  stepUp: 1,
  mistakeReview: 2,
};

export interface Interstitial {
  readonly producer: InterstitialProducer;
  /** Stable key; what `usedInterstitialKeys` persists (INV-SESS-01). */
  readonly key: string;
  /** The copy slot id. Never repeated within a session (INV-COM-03). */
  readonly copyKey: string;
  readonly comboValue?: number;
  readonly stepUp?: StepUpKind;
  readonly mistakeCount?: number;
}

/* ================================================================ 2. the pools */

/**
 * The combo pool — SEVEN strings (S047, `strings@09-11`). Two fixed milestones plus five
 * templated praise frames. `maxComboInterstitialsPerSession = 7` is the pool size, and
 * exhausting it STOPS the interstitials: falling back to the non-combo pool reads as a
 * downgrade on a Daily Refresh block that routinely reaches combo 60, and is forbidden
 * (EC-COM-03).
 */
export const COMBO_COPY_POOL: readonly string[] = [
  'combo.5_in_a_row', // `5 in a row!`
  'combo.10_in_a_row', // `10 in a row!`
  'combo.amazing_n', // `Amazing! {{n}} in a row!`
  'combo.outstanding_n', // `Outstanding! {{n}} in a row!`
  'combo.cool_n', // `Cool! {{n}} in a row!`
  'combo.learned_so_much', // `{{n}} in a row! You've learned so much!`
  'combo.worked_hard', // `You worked hard and got {{n}} right in a row!`
];

/**
 * The NON-combo pool. It exists for the step-up card and practice-only encouragement and
 * is NEVER reachable as a combo fallback (INV-COM-03).
 */
export const STEP_UP_COPY: Readonly<Record<StepUpKind, string>> = {
  // `Great work! Let's make this a bit harder…`
  production: 'stepup.production',
  // `Great work! Let's make this more challenging with less sound!`
  audio: 'stepup.audio',
};

/** S049, plural-aware: `Let's review the exercise(s) you missed!` */
export const MISTAKE_REVIEW_COPY_ONE = 'mistakeReview.one';
export const MISTAKE_REVIEW_COPY_MANY = 'mistakeReview.many';

/* ================================================== 3. the milestone predicate */

/** `deep/01` §Rules: fires at 5, at 10, then every 10 thereafter. */
export function isComboMilestone(combo: number): boolean {
  if (combo === 5) return true;
  return combo >= 10 && combo % 10 === 0;
}

/**
 * The copy for one milestone, or `null` once the pool of 7 is exhausted.
 *
 * Deterministic: 5 and 10 are pinned to the two fixed strings so `5 in a row!` can never
 * appear at combo 30, and the templated five are walked in order — so a resumed session,
 * restoring `usedInterstitialKeys`, cannot re-roll into a string it already showed.
 */
export function comboCopyFor(combo: number, used: readonly string[]): string | null {
  const seen = new Set(used);
  if (combo === 5 && !seen.has('combo.5_in_a_row')) return 'combo.5_in_a_row';
  if (combo === 10 && !seen.has('combo.10_in_a_row')) return 'combo.10_in_a_row';
  for (const key of COMBO_COPY_POOL) {
    if (key === 'combo.5_in_a_row' || key === 'combo.10_in_a_row') continue;
    if (!seen.has(key)) return key;
  }
  return null;
}

/* ============================================================ 4. emitting a screen */

export interface EmitRequest {
  readonly config: SessionFlavourConfig;
  readonly combo: number;
  /** `Motivational messages` (S047 / EC-COM-10). */
  readonly motivationalMessages: boolean;
  readonly usedInterstitialKeys: readonly string[];
  /** The step-up heuristic tripped on this answer. */
  readonly stepUpTripped: boolean;
  /** A step-up already fired this session (INV-COM-12: at most one). */
  readonly stepUpAlreadyFired: boolean;
  /** How many mistakes are awaiting a replay — S049's copy is plural-aware on this. */
  readonly mistakesPending: number;
  /**
   * A replay is about to be served AND this review block has not announced itself yet.
   * The machine decides: the block may be MID-LESSON (a single miss coming back two
   * exercises later) or the end-of-queue drain. The producer does not need to know which,
   * only that a `Let's review the exercise(s) you missed!` screen is owed.
   */
  readonly mistakeReviewDue: boolean;
}

/**
 * The queue for ONE answer boundary, already ordered and duplicate-free.
 *
 * INV-COM-08: "All interstitial producers emit into one queue whose render is a
 * duplicate-free subsequence of combo → step-up → mistake-review."
 */
export function emitInterstitials(request: EmitRequest): readonly Interstitial[] {
  const out: Interstitial[] = [];
  const used = [...request.usedInterstitialKeys];

  // --- combo -----------------------------------------------------------------
  // INV-COM-07: with motivational messages OFF, ZERO combo interstitials render for any
  // combo sequence — while combo state itself advances identically (combo.ts never sees
  // this flag).
  if (request.motivationalMessages && isComboMilestone(request.combo)) {
    const comboUsed = used.filter((k) => k.startsWith('combo.'));
    if (comboUsed.length < request.config.maxComboInterstitials) {
      const copyKey = comboCopyFor(request.combo, comboUsed);
      // `null` = the pool of 7 is exhausted ⇒ stop firing. No fallback pool.
      if (copyKey !== null) {
        out.push({
          producer: 'combo',
          key: copyKey,
          copyKey,
          comboValue: request.combo,
        });
        used.push(copyKey);
      }
    }
  }

  // --- step-up ---------------------------------------------------------------
  // INV-COM-07, second half: the step-up card renders in EVERY run, motivational
  // messages or not — it announces a rule change to the next exercise.
  // INV-COM-12: at most one escalation per session, and its kind comes from the flavour
  // config, so the less-sound copy can never appear outside an audio flavour.
  if (request.stepUpTripped && !request.stepUpAlreadyFired && request.config.stepUp !== null) {
    const kind = request.config.stepUp;
    out.push({
      producer: 'stepUp',
      key: `stepup:${kind}`,
      copyKey: STEP_UP_COPY[kind],
      stepUp: kind,
    });
  }

  // --- mistake review --------------------------------------------------------
  // INV-COM-08: it emits into THE SAME queue as the other two and sorts last. The machine
  // renders it as the `mistakeReview` shell state (S029 declares one) carrying this
  // copyKey, rather than as a second `interstitial` screen — see machine.ts §route.
  if (request.mistakeReviewDue && request.mistakesPending > 0) {
    const copyKey =
      request.mistakesPending === 1 ? MISTAKE_REVIEW_COPY_ONE : MISTAKE_REVIEW_COPY_MANY;
    out.push({
      producer: 'mistakeReview',
      key: 'mistakeReview',
      copyKey,
      mistakeCount: request.mistakesPending,
    });
  }

  return out.sort((a, b) => PRODUCER_ORDER[a.producer] - PRODUCER_ORDER[b.producer]);
}

/** Is `rendered` a duplicate-free subsequence of the canonical producer order? */
export function isCanonicalInterstitialOrder(rendered: readonly Interstitial[]): boolean {
  const seen = new Set<InterstitialProducer>();
  let rank = -1;
  for (const screen of rendered) {
    if (seen.has(screen.producer)) return false;
    seen.add(screen.producer);
    const next = PRODUCER_ORDER[screen.producer];
    if (next <= rank) return false;
    rank = next;
  }
  return true;
}
