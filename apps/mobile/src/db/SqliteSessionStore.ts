import type { Db, DbRow } from '@freelingo/schema';
import {
  SessionStoreError,
  canonicalJson,
  serialiseSession,
  sessionStateKey,
  type SessionKind,
  type SessionState,
  type SessionStore,
} from '@freelingo/core/session';
import { parseSessionState } from './sessionCodec.js';

interface StoredRow extends DbRow {
  readonly course_id: string;
  readonly session_kind: SessionKind;
  readonly node_ref: string;
  readonly session_id: string;
  readonly flavour: string;
  readonly is_graded: number;
  readonly is_active: number;
  readonly runtime_json: string | null;
}
/** Keep the original row available for S051 start-over or S147 recovery. */
export class UnrestorableSessionError extends Error {
  constructor(
    readonly courseId: string,
    readonly nodeRef: string,
    readonly reason: 'legacy' | 'corrupt',
  ) {
    super(
      reason === 'legacy'
        ? 'This saved lesson needs to start over after the app update.'
        : 'This saved lesson could not be restored.',
    );
  }
}
function key(row: StoredRow): string {
  return sessionStateKey(row.course_id, row.session_kind, row.node_ref);
}
function restore(row: StoredRow): SessionState {
  if (row.runtime_json === null)
    throw new UnrestorableSessionError(row.course_id, row.node_ref, 'legacy');
  try {
    const state = parseSessionState(row.runtime_json);
    if (
      state.courseId !== row.course_id ||
      state.sessionKind !== row.session_kind ||
      state.nodeRef !== row.node_ref ||
      state.sessionId !== row.session_id ||
      state.flavour !== row.flavour ||
      (state.sessionKind === 'graded') !== (row.is_graded === 1)
    )
      throw new Error('Invalid runtime checkpoint');
    return state;
  } catch {
    throw new UnrestorableSessionError(row.course_id, row.node_ref, 'corrupt');
  }
}
/** S051/S052 persistence adapter. Every mutation is exclusive; a kill cannot update
 * the indexed resume fields without the complete runtime payload or active lease.
 * No runtime state lives solely in a JavaScript map. The wall timestamp is metadata;
 * resume age continues to use the persisted monotonic checkpoint inside the payload. */
export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: Db,
    private readonly nowUtc = () => new Date().toISOString(),
  ) {}
  get(courseId: string, kind: SessionKind, nodeRef: string): SessionState | null {
    const row = this.db.get<StoredRow>(
      'SELECT * FROM course_session_state WHERE course_id = ? AND session_kind = ? AND node_ref = ?',
      [courseId, kind, nodeRef],
    );
    return row ? restore(row) : null;
  }
  all(): readonly SessionState[] {
    return this.db
      .all<StoredRow>(
        'SELECT * FROM course_session_state ORDER BY course_id, session_kind, node_ref',
      )
      .map(restore);
  }
  forCourse(courseId: string): readonly SessionState[] {
    return this.db
      .all<StoredRow>(
        'SELECT * FROM course_session_state WHERE course_id = ? ORDER BY session_kind, node_ref',
        [courseId],
      )
      .map(restore);
  }
  private activeRow(): StoredRow | undefined {
    return this.db.get<StoredRow>(
      'SELECT * FROM course_session_state WHERE is_graded = 1 AND is_active = 1',
    );
  }
  activeGraded(): SessionState | null {
    const row = this.activeRow();
    return row ? restore(row) : null;
  }
  put(state: SessionState): void {
    this.db.withExclusiveTransaction(() => {
      const active = this.activeRow();
      const ownKey = sessionStateKey(state.courseId, state.sessionKind, state.nodeRef);
      this.save(state, state.sessionKind === 'graded' && (!active || key(active) === ownKey));
    });
  }
  activate(state: SessionState): void {
    if (state.sessionKind !== 'graded') return;
    this.db.withExclusiveTransaction(() => {
      const active = this.activeRow();
      if (
        active &&
        key(active) !== sessionStateKey(state.courseId, state.sessionKind, state.nodeRef)
      )
        throw new SessionStoreError('Another graded session is in flight. End or park it first.');
      this.save(state, true);
    });
  }
  park(): void {
    this.db.withExclusiveTransaction(() => {
      this.db.run(
        'UPDATE course_session_state SET is_active = 0 WHERE is_graded = 1 AND is_active = 1',
      );
    });
  }
  delete(courseId: string, kind: SessionKind, nodeRef: string): void {
    this.db.withExclusiveTransaction(() => {
      this.db.run(
        'DELETE FROM course_session_state WHERE course_id = ? AND session_kind = ? AND node_ref = ?',
        [courseId, kind, nodeRef],
      );
    });
  }
  private save(state: SessionState, active: boolean): void {
    const c = state.core;
    this.db.run(
      `INSERT INTO course_session_state
      (course_id, session_kind, node_ref, session_id, flavour, is_graded, is_active,
       started_at_monotonic_ms, checkpoint_at, queue_json, cursor_index, answers_json,
       hearts_remaining, combo, used_interstitial_keys_json, input_mode, hard_mode,
       option_seeds_json, runtime_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (course_id, session_kind, node_ref) DO UPDATE SET
       session_id = excluded.session_id, flavour = excluded.flavour, is_graded = excluded.is_graded,
       is_active = excluded.is_active, started_at_monotonic_ms = excluded.started_at_monotonic_ms,
       checkpoint_at = excluded.checkpoint_at, queue_json = excluded.queue_json,
       cursor_index = excluded.cursor_index, answers_json = excluded.answers_json,
       hearts_remaining = excluded.hearts_remaining, combo = excluded.combo,
       used_interstitial_keys_json = excluded.used_interstitial_keys_json, input_mode = excluded.input_mode,
       hard_mode = excluded.hard_mode, option_seeds_json = excluded.option_seeds_json,
       runtime_json = excluded.runtime_json`,
      [
        state.courseId,
        state.sessionKind,
        state.nodeRef,
        state.sessionId,
        state.flavour,
        state.sessionKind === 'graded' ? 1 : 0,
        active ? 1 : 0,
        state.startedMonotonicMs,
        this.nowUtc(),
        canonicalJson(c.queue),
        c.index,
        canonicalJson(c.answers),
        c.hearts.kind === 'infinite' ? null : c.hearts.remaining,
        c.combo,
        canonicalJson(c.usedInterstitialKeys),
        c.inputMode,
        c.hardMode ? 1 : 0,
        canonicalJson(c.optionSeeds),
        serialiseSession(state),
      ],
    );
  }
}
