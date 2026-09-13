import type { Db, DbRow } from '@freelingo/schema';
import {
  DECLINED,
  ONE_TIME_SLOTS,
  STREAK_GOAL_OPTIONS,
  recordDeferred,
  recordPicked,
  type StreakGoalState,
} from '@freelingo/core/ceremony';
import type { CeremonyAdvance } from '../loop/contracts';
import {
  parseCeremonyReceipt,
  serialiseCeremonyReceipt,
  type CeremonyReceipt,
} from './ceremonyCodec';
import { LearningDataError } from './SqliteSchedulerStore';
export interface SavedCeremony {
  readonly receipt: CeremonyReceipt;
  readonly index: number;
  readonly finishedAtUtc: string | null;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new LearningDataError('Invalid ceremony counter.');
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new LearningDataError('Invalid ceremony timestamp.');
  return value;
}
function goalState(row: DbRow): StreakGoalState {
  if (row.streak_goal_declined !== 0 && row.streak_goal_declined !== 1)
    throw new LearningDataError('Invalid streak goal sentinel.');
  if (row.streak_goal_declined === 1 && row.streak_goal_value !== null)
    throw new LearningDataError('Conflicting streak goal.');
  return {
    goal:
      row.streak_goal_declined === 1
        ? DECLINED
        : row.streak_goal_value === null
          ? null
          : integer(row.streak_goal_value),
    presentations: integer(row.streak_goal_presentations),
    lastPicked: row.streak_goal_last_picked === null ? null : integer(row.streak_goal_last_picked),
  };
}
/** Frozen presentation and cursor only. Reward/attempt/day writes happen before insert
 * in the caller's one exclusive completion transaction; this class never re-awards. */
export class SqliteCeremonyStore {
  constructor(
    private readonly db: Db,
    private readonly nowUtc: () => string,
  ) {}
  load(sessionId: string): SavedCeremony | null {
    const row = this.db.get(
      `SELECT c.*,s.xp_awarded,s.gems_awarded,l.course_id AS committed_course_id
      FROM course_ceremony c JOIN committed_session s ON s.session_id=c.session_id
      JOIN course_session_commit_link l ON l.session_id=c.session_id WHERE c.session_id=?`,
      [sessionId],
    );
    if (!row) {
      if (this.db.get('SELECT session_id FROM course_ceremony WHERE session_id=?', [sessionId]))
        throw new LearningDataError('Ceremony has no committed course binding.');
      return null;
    }
    if (
      row.schema_version !== 1 ||
      row.course_id !== row.committed_course_id ||
      typeof row.presentation_json !== 'string' ||
      typeof row.course_id !== 'string'
    )
      throw new LearningDataError('Invalid ceremony source binding.');
    const index = integer(row.cursor);
    const receipt = parseCeremonyReceipt(row.presentation_json, {
      sessionId,
      courseId: row.course_id,
      cursor: index,
      xpAwarded: integer(row.xp_awarded),
      gemsAwarded: integer(row.gems_awarded),
    });
    const finishedAtUtc = row.finished_at_utc === null ? null : date(row.finished_at_utc);
    if ((finishedAtUtc !== null) !== (index === receipt.result.chain.length))
      throw new LearningDataError('Ceremony completion marker disagrees with its cursor.');
    return { receipt, index, finishedAtUtc };
  }
  pending(): SavedCeremony | null {
    const rows = this.db.all(
      'SELECT session_id FROM course_ceremony WHERE finished_at_utc IS NULL ORDER BY rowid',
    );
    if (rows.length > 1)
      throw new LearningDataError(
        'Multiple ceremonies are pending; their saved receipts were retained.',
      );
    if (!rows.length) return null;
    const id = rows[0]!.session_id;
    if (typeof id !== 'string') throw new LearningDataError('Invalid pending ceremony identity.');
    return this.load(id);
  }
  insert(receipt: CeremonyReceipt): void {
    const raw = serialiseCeremonyReceipt(receipt),
      sessionId = receipt.state.session.sessionId,
      courseId = receipt.state.course.courseId;
    this.db.withExclusiveTransaction(() => {
      const existing = this.load(sessionId);
      if (existing) {
        if (serialiseCeremonyReceipt(existing.receipt) !== raw)
          throw new LearningDataError('The committed ceremony is immutable.');
        return;
      }
      const row = this.db.get(
        `SELECT s.xp_awarded,s.gems_awarded,l.course_id FROM committed_session s
        JOIN course_session_commit_link l ON l.session_id=s.session_id WHERE s.session_id=?`,
        [sessionId],
      );
      if (!row || row.course_id !== courseId)
        throw new LearningDataError('Ceremony needs an actual committed session and course.');
      parseCeremonyReceipt(raw, {
        sessionId,
        courseId,
        cursor: 0,
        xpAwarded: integer(row.xp_awarded),
        gemsAwarded: integer(row.gems_awarded),
      });
      this.db.run(
        'INSERT INTO course_ceremony(session_id,course_id,schema_version,presentation_json,cursor,finished_at_utc) VALUES(?,?,1,?,0,?)',
        [sessionId, courseId, raw, receipt.result.chain.length === 0 ? date(this.nowUtc()) : null],
      );
      this.load(sessionId);
    });
  }
  advance(request: CeremonyAdvance): boolean {
    integer(request.expectedIndex);
    integer(request.nextIndex);
    return this.db.withExclusiveTransaction(() => {
      const saved = this.load(request.sessionId);
      if (!saved) throw new LearningDataError('The ceremony receipt is unavailable.');
      if (saved.index !== request.expectedIndex || saved.finishedAtUtc !== null) return false;
      const { chain } = saved.receipt.result;
      if (request.nextIndex <= saved.index || request.nextIndex > chain.length)
        throw new LearningDataError('Invalid ceremony cursor advance.');
      for (const slot of chain.slice(saved.index + 1, request.nextIndex))
        if (ONE_TIME_SLOTS.includes(slot) || slot === 'S087_returnToPath')
          throw new LearningDataError('A one-time ceremony screen cannot be skipped.');
      const picker = chain[saved.index] === 'S072_streakGoalPicker';
      if (picker !== (request.goalChoice !== null))
        throw new LearningDataError(
          'Only the goal picker accepts a choice, and it needs choose or defer.',
        );
      if (request.goalChoice !== null) {
        const row = this.db.get(
          'SELECT streak_goal_value,streak_goal_declined,streak_goal_presentations,streak_goal_last_picked FROM account WHERE id=1',
        );
        if (!row) throw new LearningDataError('Missing account goal.');
        const prior = goalState(row),
          choice = request.goalChoice;
        if (choice.kind !== 'choose' && choice.kind !== 'defer')
          throw new LearningDataError('Invalid goal choice.');
        if (choice.kind === 'choose' && !STREAK_GOAL_OPTIONS.some((o) => o.days === choice.days))
          throw new LearningDataError('Undeclared streak goal.');
        const next =
          choice.kind === 'choose' ? recordPicked(prior, choice.days) : recordDeferred(prior);
        this.db.run(
          'UPDATE account SET streak_goal_value=?,streak_goal_declined=?,streak_goal_presentations=?,streak_goal_last_picked=? WHERE id=1',
          [
            typeof next.goal === 'number' ? next.goal : null,
            next.goal === DECLINED ? 1 : 0,
            next.presentations,
            next.lastPicked,
          ],
        );
      }
      this.db.run(
        'UPDATE course_ceremony SET cursor=?,finished_at_utc=? WHERE session_id=? AND cursor=?',
        [
          request.nextIndex,
          request.nextIndex === chain.length ? date(this.nowUtc()) : null,
          request.sessionId,
          saved.index,
        ],
      );
      this.load(request.sessionId);
      return true;
    });
  }
}
