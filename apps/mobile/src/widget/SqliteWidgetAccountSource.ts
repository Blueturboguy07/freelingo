import type { Db } from '@freelingo/schema';
import { localDayOf } from '@freelingo/core/day';
import { packSurface } from '@freelingo/core/packs';
import { allUnits, isComplete, nodeUnlocked, unitUnlocked } from '@freelingo/core/path';
import type { WidgetAccountRead, WidgetDrawClock } from '@freelingo/core/widget';
import type { ResumeInspection } from '../db/learningResume';
import type { InstalledPackRepository } from '../packs/installedPackPorts';
import { SqliteAppState } from '../services/SqliteAppState';
import { readPathModel } from '../services/readPathModel';
import { readSqliteWidgetHistory } from './SqliteWidgetHistory';
import { readSqliteWidgetAccount } from './SqliteWidgetSource';
import type { WidgetAccountReadPort } from './WidgetPublisher';

/** App process only. The factory calls this inside its serialized post-commit chain.
 * All projections are synchronous within this read: no pack refresh, source repair,
 * session activation, foreground clock mutation or day/reward write occurs here. */
export class SqliteWidgetAccountSource implements WidgetAccountReadPort {
  constructor(
    private readonly db: Db,
    private readonly packs: Pick<InstalledPackRepository, 'get' | 'state'>,
    private readonly learning: { readResumableCourse(courseId: string): ResumeInspection },
  ) {}

  async readCommitted(clock: WidgetDrawClock): Promise<WidgetAccountRead> {
    try {
      if (!Number.isSafeInteger(clock.nowMs) || clock.nowMs < 0)
        return { kind: 'unavailable', reason: 'unreliable-clock' };
      const observedDay = localDayOf(new Date(clock.nowMs), clock.zone);
      const app = new SqliteAppState(this.db).read();
      if (app.step !== 'complete') return { kind: 'unavailable', reason: 'unavailable' };
      const courseId = app.activeCourseId;
      if (courseId === null) return { kind: 'unavailable', reason: 'no-active-course' };
      if (!app.courseIds.includes(courseId))
        return { kind: 'unavailable', reason: 'invalid-source' };
      const pack = this.packs.get(courseId);
      if (
        pack === null ||
        pack.courseId !== courseId ||
        !packSurface(this.packs.state(courseId)).lessonsPlayable
      )
        return { kind: 'unavailable', reason: 'invalid-source' };
      const path = readPathModel(this.db, pack);
      const history = readSqliteWidgetHistory(this.db, observedDay);
      if (history.kind === 'unavailable') return { kind: 'unavailable', reason: 'unknown-history' };
      const resume = this.learning.readResumableCourse(courseId);
      if (
        resume.status === 'unavailable' &&
        resume.reason !== 'pending-ceremony' &&
        resume.reason !== 'pending-completion'
      )
        return { kind: 'unavailable', reason: 'invalid-source' };
      if (
        resume.status === 'ready' &&
        (resume.candidate.courseId !== courseId ||
          resume.candidate.packContentHash !== pack.contentHash)
      )
        return { kind: 'unavailable', reason: 'invalid-source' };
      // A known terminal/ceremony blocker is not missing account history: publish
      // committed rewards while offering no resumable lesson until it is resolved.
      // The frontier unit stays the furthest unlocked unit even after it completes;
      // never fall back to intentionally skipped work behind a passed jump.
      const frontier = allUnits(path)
        .filter((unit) => unitUnlocked(path, unit.index))
        .at(-1);
      const activeNodeId =
        frontier?.nodes.find(
          (candidate, index) => !isComplete(candidate) && nodeUnlocked(path, frontier.index, index),
        )?.id ?? null;
      return readSqliteWidgetAccount(this.db, clock, history, {
        courseId,
        activeNodeId,
        hasResumableSession: resume.status === 'ready',
      });
    } catch {
      return { kind: 'unavailable', reason: 'unavailable' };
    }
  }
}
