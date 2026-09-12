/**
 * `session_state` — the store contract, S052.
 *
 * Owns INV-SESS-03, 07, 09, 17.
 *
 * LANE NOTE: the SQLite table and its migration live in `packages/schema` (another P1
 * lane). This file owns the RULES — the key, the one-row-per-key bound, the one-graded-
 * session-in-flight bound, and what `START OVER` deletes — and `InMemorySessionStore` is
 * the reference implementation the properties run against. A SQLite implementation that
 * satisfies this interface satisfies the invariants; one that does not is caught here
 * rather than on a device.
 */
import type { MistakeRow, QueuedItem, SessionKind } from './types.js';
import type { SessionState } from './resume.js';
import { keyOf, sessionStateKey } from './resume.js';

export interface SessionStore {
  get(courseId: string, kind: SessionKind, nodeRef: string): SessionState | null;
  /** Upsert on the key. NEVER two rows for one key (INV-SESS-17). */
  put(state: SessionState): void;
  delete(courseId: string, kind: SessionKind, nodeRef: string): void;
  all(): readonly SessionState[];
  /** Every row for a course, all kinds — a course switch parks, never deletes. */
  forCourse(courseId: string): readonly SessionState[];
}

export class SessionStoreError extends Error {}

export class InMemorySessionStore implements SessionStore {
  #rows = new Map<string, SessionState>();

  get(courseId: string, kind: SessionKind, nodeRef: string): SessionState | null {
    return this.#rows.get(sessionStateKey(courseId, kind, nodeRef)) ?? null;
  }

  put(state: SessionState): void {
    // INV-SESS-09/17: at most one GRADED session in flight globally. Story and radio
    // positions are their own rows and never collide with it — "opening a lesson evicts a
    // parked story" is the falsifier, so the guard is scoped to `graded` only.
    if (state.sessionKind === 'graded') {
      const other = [...this.#rows.values()].find(
        (row) => row.sessionKind === 'graded' && keyOf(row) !== keyOf(state),
      );
      if (other !== undefined) {
        throw new SessionStoreError(
          `one graded session in flight: ${keyOf(other)} is live, refusing ${keyOf(state)}`,
        );
      }
    }
    this.#rows.set(keyOf(state), state);
  }

  delete(courseId: string, kind: SessionKind, nodeRef: string): void {
    this.#rows.delete(sessionStateKey(courseId, kind, nodeRef));
  }

  all(): readonly SessionState[] {
    return [...this.#rows.values()];
  }

  forCourse(courseId: string): readonly SessionState[] {
    return [...this.#rows.values()].filter((row) => row.courseId === courseId);
  }
}

/* ================================================= 1. the one-in-flight guard sheet */

/**
 * S052. A second session request never clobbers the live row and never creates a second
 * one: it opens the guard sheet, and the DESTRUCTIVE branch runs the `End session` commit
 * first (INV-SESS-09).
 *
 * EC-SES-09: the collision is reachable from the widget deep link, the lesson-complete
 * deep link and the hub `Switch session` control, so every one of them resolves through
 * this function rather than creating a session.
 */
export type StartRequestOutcome =
  | { readonly kind: 'start' }
  | {
      readonly kind: 'guardSheet';
      readonly live: SessionState;
      /** The sheet names the suspended session by node and exercise count (EC-SES-09). */
      readonly liveNodeRef: string;
      readonly liveIndex: number;
      readonly liveLength: number;
    };

export function requestStart(
  store: SessionStore,
  request: { courseId: string; kind: SessionKind; nodeRef: string },
): StartRequestOutcome {
  if (request.kind !== 'graded') return { kind: 'start' };
  const live = store.all().find((row) => row.sessionKind === 'graded');
  if (live === undefined) return { kind: 'start' };
  if (keyOf(live) === sessionStateKey(request.courseId, request.kind, request.nodeRef)) {
    return { kind: 'start' };
  }
  return {
    kind: 'guardSheet',
    live,
    liveNodeRef: live.nodeRef,
    liveIndex: live.core.index,
    liveLength: live.core.queue.length,
  };
}

/* ===================================================================== 2. START OVER */

/**
 * INV-SESS-03 / EC-SES-03.
 *
 * `START OVER` DISCARDS and REGENERATES; it does not replay. The new queue is disjoint
 * from the abandoned one except for items FSRS considers due, it writes NO new attempt
 * rows for items already answered (the committed rows stand), the parked session's
 * undrained mistakes are HANDED TO the mistakes queue rather than vanishing, and the
 * `session_state` row plus any reserved node-ring advance are deleted in the SAME
 * transaction as the regeneration.
 */
export interface StartOverPlan {
  /** Ids the regenerated queue may not contain. */
  readonly excludedItemIds: readonly string[];
  /** Already-answered ids that ARE due and may therefore return. */
  readonly dueExceptions: readonly string[];
  /** Mistakes handed over rather than dropped. */
  readonly handedOverMistakes: readonly string[];
  readonly deleteKey: string;
  readonly releaseNodeRingReservation: boolean;
}

export function planStartOver(
  state: SessionState,
  isDue: (itemId: string) => boolean,
): StartOverPlan {
  const answered = [...new Set(state.core.answers.map((a) => a.itemId))];
  const dueExceptions = answered.filter((id) => isDue(id));
  const excludedItemIds = answered.filter((id) => !isDue(id));
  return {
    excludedItemIds,
    dueExceptions,
    handedOverMistakes: state.mistakes.map((m) => m.itemId),
    deleteKey: keyOf(state),
    releaseNodeRingReservation: true,
  };
}

/** The regenerated queue, with the exclusion applied. Disjoint except for due items. */
export function applyStartOverExclusion(
  candidates: readonly QueuedItem[],
  plan: StartOverPlan,
): readonly QueuedItem[] {
  const excluded = new Set(plan.excludedItemIds);
  return candidates.filter((c) => !excluded.has(c.itemId));
}

/* ============================================================ 3. live mistake rows */

/** Convenience for the resume re-filter (INV-SESS-18). */
export function liveMistakeIds(rows: readonly MistakeRow[]): ReadonlySet<string> {
  return new Set(rows.map((r) => r.itemId));
}
