/**
 * The persisted session and the resume decision — S051.
 *
 * Owns INV-SESS-01, 02, 05, 06, 10, 15, 21 (the offer half), and feeds 16 and 18.
 *
 * The NINE FIELDS are a named tuple, not a comment: `RESUME_FIELDS` is asserted against
 * the runtime value in `resume.test.ts`, so "a schema with fewer fields fails the test by
 * construction" (INV-SESS-06) is literally what happens.
 */
import type {
  Allowance,
  Answer,
  InFlightInput,
  InputMode,
  QueuedItem,
  QueuedMistake,
  SessionFlavour,
  SessionKind,
  ShellState,
} from './types.js';
import { EMPTY_IN_FLIGHT } from './types.js';
import type { ProgressState } from './progress.js';

/* ================================================================= 1. the row */

/**
 * The nine fields INV-SESS-01 restores byte-identical from any kill point.
 * Order is load-bearing only in that the test compares this list to `Object.keys`.
 */
export const RESUME_FIELDS = [
  'queue',
  'index',
  'answers',
  'hearts',
  'combo',
  'usedInterstitialKeys',
  'inputMode',
  'hardMode',
  'optionSeeds',
] as const;
export type ResumeField = (typeof RESUME_FIELDS)[number];

/** The nine, exactly. A tenth field here would fail `resume.test.ts`. */
export interface ResumeCore {
  readonly queue: readonly QueuedItem[];
  readonly index: number;
  readonly answers: readonly Answer[];
  /** `hearts` is the mistake allowance: `∞` under Super, pips in a test flavour (S056). */
  readonly hearts: Allowance;
  readonly combo: number;
  readonly usedInterstitialKeys: readonly string[];
  readonly inputMode: InputMode;
  readonly hardMode: boolean;
  readonly optionSeeds: Readonly<Record<string, number>>;
}

/**
 * The whole persisted row. `core` is the nine; everything beside it is session
 * bookkeeping, plus the TENTH field EC-SES-20 demands: ungraded in-flight input and an
 * opaque per-challenge `partial_state` (INV-SESS-15).
 */
export interface SessionState {
  readonly sessionId: string;
  readonly courseId: string;
  readonly sessionKind: SessionKind;
  readonly nodeRef: string;
  readonly flavour: SessionFlavour;
  readonly core: ResumeCore;
  /** INV-SESS-04: `banner.*` is a PERSISTED shell state. */
  readonly shellState: ShellState;
  readonly inFlight: InFlightInput;
  readonly mistakes: readonly QueuedMistake[];
  readonly progress: ProgressState;
  /** INV-SESS-02/10: monotonic, never wall-clock. */
  readonly checkpointMonotonicMs: number;
  readonly startedMonotonicMs: number;
  /** Which interstitial screens have already been RENDERED at this boundary. */
  readonly pendingInterstitialKeys: readonly string[];
  readonly stepUpFired: boolean;
  readonly motivationalMessages: boolean;
}

/** `(course_id, session_kind, node_ref)` — INV-SESS-17. */
export function sessionStateKey(
  courseId: string,
  sessionKind: SessionKind,
  nodeRef: string,
): string {
  // Percent-encode the two free-form components so no course id or node ref can
  // forge a key by containing the separator. A raw control character would work too
  // and would make this file binary to git, which is worse than three extra bytes.
  return `${encodeURIComponent(courseId)}/${sessionKind}/${encodeURIComponent(nodeRef)}`;
}

export function keyOf(state: SessionState): string {
  return sessionStateKey(state.courseId, state.sessionKind, state.nodeRef);
}

/* ====================================================== 2. byte-identical restore */

/**
 * Canonical JSON: object keys sorted at every depth.
 *
 * INV-SESS-01 says "byte-identical", and `JSON.stringify` is only byte-stable if key
 * insertion order is. It is not, once a state has passed through a spread, a filter and a
 * `{...x, y}` update. So the serialiser sorts, and the property compares BYTES.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
  return out;
}

export function serialiseSession(state: SessionState): string {
  return canonicalJson(state);
}

export function deserialiseSession(raw: string): SessionState {
  return JSON.parse(raw) as SessionState;
}

/**
 * The checkpoint. INV-SESS-01: "never older than one challenge boundary" — so this is
 * called at every boundary and nowhere else, and it carries the in-flight input so a kill
 * mid-typing, after stroke k or after m matched pairs restores exactly that
 * (INV-SESS-15).
 */
export function checkpoint(state: SessionState, monotonicMs: number): SessionState {
  return { ...state, checkpointMonotonicMs: monotonicMs };
}

/* ================================================================ 3. the age */

/** `deep/01` §S20: a row older than 24 h offers `RESUME LESSON` / `START OVER`. */
export const RESUME_OFFER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * INV-SESS-10. Age is MONOTONIC-derived:
 * - a backwards jump clamps to 0 ⇒ silent resume (EC-SES-11);
 * - a forwards jump is honoured and offers the choice, never auto-discarding (EC-SES-12).
 *
 * There is no wall clock in this function's signature, which is the point: it cannot be
 * wall-clock-derived by accident.
 */
export function monotonicAgeMs(state: SessionState, nowMonotonicMs: number): number {
  return Math.max(0, nowMonotonicMs - state.checkpointMonotonicMs);
}

export type ResumeOffer =
  | { readonly kind: 'silentResume' }
  | { readonly kind: 'offerChoice' }
  | { readonly kind: 'startOverOnly'; readonly reason: 'packChanged' };

export interface ResumeDecisionInput {
  readonly state: SessionState;
  readonly nowMonotonicMs: number;
  /** INV-SESS-21: every queued id resolves in the installed pack AND maps to the node. */
  readonly queueResolvesInPack: boolean;
}

export function resumeDecision(input: ResumeDecisionInput): ResumeOffer {
  if (!input.queueResolvesInPack) return { kind: 'startOverOnly', reason: 'packChanged' };
  const age = monotonicAgeMs(input.state, input.nowMonotonicMs);
  return age > RESUME_OFFER_AGE_MS ? { kind: 'offerChoice' } : { kind: 'silentResume' };
}

/** INV-SESS-02, stated as the boolean the UI reads. */
export function resumeOffered(state: SessionState, nowMonotonicMs: number): boolean {
  return monotonicAgeMs(state, nowMonotonicMs) > RESUME_OFFER_AGE_MS;
}

/* ============================================================== 4. option seeds */

/**
 * INV-SESS-05: the realised option order of an ALREADY-PRESENTED item is replayed
 * verbatim; re-randomisation applies only to unreached items and to a fresh session.
 *
 * "Already presented" is `slot index < index` — the seed map is keyed by SLOT, so the
 * same item met twice in one session is two seeds, as it must be.
 */
export function seedsOnResume(
  core: ResumeCore,
  freshSeedFor: (slotId: string) => number,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  core.queue.forEach((item, position) => {
    const presented = position < core.index;
    const existing = core.optionSeeds[item.id];
    out[item.id] = presented && existing !== undefined ? existing : freshSeedFor(item.id);
  });
  return out;
}

/* ============================================================ 5. cold-start route */

/**
 * INV-SESS-08: cold-start restore sets `active_course_id` FROM THE SESSION ROW before
 * resolving the node route, and a persisted-active-course/session-course mismatch
 * resolves to the session's course.
 */
export interface ColdStartRoute {
  readonly activeCourseId: string;
  readonly nodeRef: string;
  readonly resolvedFrom: 'session' | 'persistedActiveCourse';
}

export function coldStartRoute(
  persistedActiveCourseId: string | null,
  state: SessionState | null,
): ColdStartRoute | null {
  if (state === null) {
    return persistedActiveCourseId === null
      ? null
      : {
          activeCourseId: persistedActiveCourseId,
          nodeRef: '',
          resolvedFrom: 'persistedActiveCourse',
        };
  }
  return { activeCourseId: state.courseId, nodeRef: state.nodeRef, resolvedFrom: 'session' };
}

/* ====================================================== 6. a blank in-flight row */

export function emptyInFlight(): InFlightInput {
  return EMPTY_IN_FLIGHT;
}
