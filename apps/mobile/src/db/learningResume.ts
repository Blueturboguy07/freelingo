import type { Db } from '@freelingo/schema';
import type { SessionState } from '@freelingo/core/session';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteLearningContextStore, type LearningContext } from './SqliteLearningContextStore';
import { validateLearningSessionPolicy } from './learningModePolicy';

export interface ResumableCourseCandidate {
  readonly courseId: string;
  readonly sessionId: string;
  readonly nodeRef: string;
  readonly packContentHash: string;
}
export type ExpectedResumeCandidate = Pick<
  ResumableCourseCandidate,
  'sessionId' | 'packContentHash'
>;
export type ResumeInspection =
  | { readonly status: 'ready'; readonly candidate: ResumableCourseCandidate }
  | { readonly status: 'none' }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'another-course-active'
        | 'multiple-parked-sessions'
        | 'saved-state-unavailable'
        | 'saved-source-unavailable'
        | 'pending-completion'
        | 'pending-ceremony';
    };
export type ResumeCandidateRead =
  | {
      readonly status: 'ready';
      readonly candidate: ResumableCourseCandidate;
      readonly state: SessionState;
      readonly context: LearningContext;
    }
  | Exclude<ResumeInspection, { status: 'ready' }>;

/** INV-SESS-17 permits parked keys; no spec defines recency ordering between them.
 * Freelingo application policy, 2026-09-14: prefer the same-course active lease,
 * otherwise require one parked candidate. Ambiguity is retained for recovery.
 * There is no clock, lease, course-selection or checkpoint mutation on this path. */
export function readResumeCandidate(
  db: Db,
  courseId: string,
  sourceResolves: (state: SessionState) => boolean,
): ResumeCandidateRead {
  try {
    if (db.get('SELECT session_id FROM course_ceremony WHERE finished_at_utc IS NULL LIMIT 1'))
      return { status: 'unavailable', reason: 'pending-ceremony' };
    if (!db.get('SELECT course_id FROM course_selection WHERE course_id=?', [courseId]))
      return { status: 'none' };
    const store = new SqliteSessionStore(db),
      active = store.activeGraded();
    if (active && active.courseId !== courseId)
      return { status: 'unavailable', reason: 'another-course-active' };
    const states = active
      ? [active]
      : store.forCourse(courseId).filter((s) => s.sessionKind === 'graded');
    if (states.length === 0) return { status: 'none' };
    if (states.length !== 1) return { status: 'unavailable', reason: 'multiple-parked-sessions' };
    const state = states[0]!,
      context = new SqliteLearningContextStore(db).load(courseId, state.sessionId);
    if (!context) return { status: 'unavailable', reason: 'saved-state-unavailable' };
    if (state.exited !== null || context.completion !== null)
      return { status: 'unavailable', reason: 'pending-completion' };
    if (state.core.queue.length === 0)
      return { status: 'unavailable', reason: 'saved-state-unavailable' };
    const launch = context.launch;
    if (
      launch.courseId !== state.courseId ||
      launch.sessionKind !== state.sessionKind ||
      launch.nodeRef !== state.nodeRef ||
      launch.start.sessionId !== state.sessionId
    )
      return { status: 'unavailable', reason: 'saved-state-unavailable' };
    validateLearningSessionPolicy(state, launch);
    if (!sourceResolves(state))
      return { status: 'unavailable', reason: 'saved-source-unavailable' };
    return {
      status: 'ready',
      state,
      context,
      candidate: Object.freeze({
        courseId,
        sessionId: state.sessionId,
        nodeRef: state.nodeRef,
        packContentHash: launch.packContentHash,
      }),
    };
  } catch {
    // Widget and entry reads cannot destroy or normalize malformed saved progress.
    return { status: 'unavailable', reason: 'saved-state-unavailable' };
  }
}
