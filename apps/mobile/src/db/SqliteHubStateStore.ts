import type { Db } from '@freelingo/schema';
import {
  buildHub,
  nextHubChoice,
  HUB_CONFIG,
  type HubDailyState,
  type HubInput,
} from '@freelingo/core/hub';
import { toLocalDay, type LocalDay } from '@freelingo/core/day';
import { canonicalJson } from '@freelingo/core/session';
import { LearningDataError } from './SqliteSchedulerStore';
function fail(detail: string): never {
  throw new LearningDataError('Practice Hub: ' + detail);
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return fail('invalid source identity');
  return v;
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
/** Offer identity and economy are separate saved fields; both must agree with the
 * actual global receipt. A matching course/day prefix alone proves no completed mode. */
function validateCompletionSource(
  id: string,
  prefix: string,
  flavour: unknown,
  node: unknown,
): void {
  if (!id.startsWith(prefix)) return fail('completion source identity');
  const tail = id.slice(prefix.length),
    slash = tail.indexOf('/');
  const kind = tail.slice(0, slash),
    suffix = tail.slice(slash + 1);
  const modes: Record<string, string> = {
    today: 'hubTargetPractice',
    target: 'hubTargetPractice',
    mistakes: 'hubMistakes',
    words: 'hubWords',
    listen: 'hubListenUp',
    speak: 'hubPronunciation',
    rewind: 'hubUnitRewind',
    path: 'lesson',
  };
  if (slash < 0 || !Object.hasOwn(modes, kind) || modes[kind] !== flavour)
    return fail('completion flavour differs from offer');
  if (kind === 'path') {
    if (!suffix.trim() || typeof node !== 'string' || !node.trim())
      return fail('completion path source');
  } else if (
    node !== null ||
    (kind === 'rewind'
      ? !/^(0|[1-9][0-9]*)$/.test(suffix) || !Number.isSafeInteger(Number(suffix))
      : suffix !== '')
  )
    return fail('completion offer source');
}
/** Daily choice state is mutable navigation. Completed offers are projected exclusively
 * from actual committed lesson sources; a UI callback cannot manufacture completion.
 * These methods never grade, reserve the shared pool, or alter the mistake history. */
export class SqliteHubStateStore {
  constructor(private readonly db: Db) {}
  private course(courseId: string) {
    if (!this.db.get('SELECT course_id FROM course_progress WHERE course_id=?', [courseId]))
      return fail('course no longer exists');
  }
  load(courseId: string, localDay: LocalDay): HubDailyState | null {
    this.course(courseId);
    toLocalDay(localDay);
    const header = this.db.get(
      'SELECT cursor FROM course_hub_day WHERE course_id=? AND local_day=?',
      [courseId, localDay],
    );
    const choices = this.db.all(
      'SELECT choice_id,position FROM course_hub_choice WHERE course_id=? AND local_day=? ORDER BY position',
      [courseId, localDay],
    );
    const choiceIds = choices.map((r, i) => {
      if (r.position !== i) return fail('saved choice order');
      const id = text(r.choice_id);
      if (!id.startsWith(localDay + '/' + courseId + '/')) return fail('saved choice source');
      return id;
    });
    if (choiceIds.length > HUB_CONFIG.maxChoices || new Set(choiceIds).size !== choiceIds.length)
      return fail('saved choice population');
    const cursor = header?.cursor ?? 0;
    if (
      typeof cursor !== 'number' ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor >= Math.max(1, choiceIds.length)
    )
      return fail('saved cursor');
    if (!header && choices.length) return fail('missing daily header');
    const rows = this.db.all(
      `SELECT link.session_id,link.origin_offer_id,link.economy_flavour,link.node_id,s.flavour,s.outcome,s.graded_attempts
      FROM course_session_commit_link link JOIN committed_session s ON s.session_id=link.session_id
      WHERE link.course_id=? AND link.origin_local_day=?`,
      [courseId, localDay],
    );
    const completed = new Map<string, string>();
    for (const r of rows) {
      const id = text(r.origin_offer_id);
      validateCompletionSource(id, localDay + '/' + courseId + '/', r.economy_flavour, r.node_id);
      if (r.flavour !== r.economy_flavour)
        return fail('completion flavour differs from committed session');
      if (r.outcome !== 'completed' && r.outcome !== 'replayed') continue;
      if (
        typeof r.graded_attempts !== 'number' ||
        !Number.isSafeInteger(r.graded_attempts) ||
        r.graded_attempts <= 0
      )
        return fail('completion has no graded history');
      completed.set(text(r.session_id), id);
    }
    for (const cache of this.db.all(
      'SELECT offer_id,completed_session_id FROM course_hub_completion WHERE course_id=? AND local_day=?',
      [courseId, localDay],
    )) {
      if (completed.get(text(cache.completed_session_id)) !== cache.offer_id)
        return fail('completion cache differs from committed source');
    }
    const completedIds = [...new Set(completed.values())].sort();
    return header || completedIds.length
      ? { courseId, localDay, choiceIds, completedIds, cursor }
      : null;
  }
  /** Fresh input is read inside the same transaction as the comparison and write.
   * Accept the visible state or exactly its next switch, never arbitrary cursor movement. */
  save(read: () => HubInput, requested: HubDailyState): void {
    this.db.withExclusiveTransaction(() => {
      const active = this.db.get('SELECT course_id FROM course_selection WHERE is_active=1');
      if (active?.course_id !== requested.courseId) return fail('active course changed');
      const fresh = read();
      if (fresh.courseId !== requested.courseId || fresh.localDay !== requested.localDay)
        return fail('stale course or day');
      const actual = this.load(requested.courseId, requested.localDay);
      const model = buildHub({ ...fresh, daily: actual });
      if (!equal(requested, model.daily) && !equal(requested, nextHubChoice(model).daily))
        return fail('stale or changed daily choice');
      if (!actual || actual.choiceIds.length === 0) {
        this.db.run(
          'INSERT INTO course_hub_day(course_id,local_day,cursor) VALUES(?,?,?) ON CONFLICT(course_id,local_day) DO UPDATE SET cursor=excluded.cursor',
          [requested.courseId, requested.localDay, requested.cursor],
        );
        requested.choiceIds.forEach((id, position) =>
          this.db.run('INSERT INTO course_hub_choice VALUES(?,?,?,?)', [
            requested.courseId,
            requested.localDay,
            id,
            position,
          ]),
        );
      } else
        this.db.run('UPDATE course_hub_day SET cursor=? WHERE course_id=? AND local_day=?', [
          requested.cursor,
          requested.courseId,
          requested.localDay,
        ]);
      if (!equal(this.load(requested.courseId, requested.localDay), requested))
        return fail('saved daily state changed');
    });
  }
  /** Offers saved by Switch and real launched fallback rewinds share the same cooldown.
   * A historical choice is compared as a whole ID, so separators in course IDs are safe. */
  rewindDays(
    courseId: string,
    unitIndices: readonly number[],
    through: LocalDay,
  ): Readonly<Record<number, LocalDay>> {
    this.course(courseId);
    toLocalDay(through);
    const out: Record<number, LocalDay> = {};
    const rows = this.db.all(
      `SELECT local_day,choice_id AS offer_id FROM course_hub_choice WHERE course_id=?
      UNION ALL SELECT origin_local_day AS local_day,origin_offer_id AS offer_id FROM course_session_commit_link
      WHERE course_id=? AND economy_flavour='hubUnitRewind' AND origin_local_day IS NOT NULL`,
      [courseId, courseId],
    );
    for (const row of rows) {
      const day = toLocalDay(text(row.local_day));
      if (day > through) continue;
      for (const unit of unitIndices) {
        if (!Number.isSafeInteger(unit) || unit < 0) return fail('rewind unit');
        if (
          row.offer_id === day + '/' + courseId + '/rewind/' + unit &&
          (out[unit] === undefined || day > out[unit])
        )
          out[unit] = day;
      }
    }
    return out;
  }
}
