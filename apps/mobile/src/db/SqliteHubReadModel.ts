import type { Db } from '@freelingo/schema';
import {
  HUB_CONFIG,
  type HubInput,
  type HubItem,
  type HubDailyState,
  type HubMistake,
} from '@freelingo/core/hub';
import { localDayOfStamp, toLocalDay, civilDaysBetween } from '@freelingo/core/day';
import { allUnits, nodeUnlocked, isComplete, type PathModel } from '@freelingo/core/path';
import { exerciseSpec } from '@freelingo/core/session';
import {
  asItemId,
  projectStrengthAt,
  type SchedulerState,
  type FsrsRow,
} from '@freelingo/core/scheduler';
import { FLAVOUR_XP, type LadderStateToday } from '@freelingo/core/economy';
import type { XpLadderMode } from '@freelingo/core/types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { LearningRuntimePorts, LearningClock } from './learningRuntimePorts';
import { readPathModel } from '../services/readPathModel';
import { SqliteSchedulerStore, LearningDataError } from './SqliteSchedulerStore';
import { SqlitePreferences } from './SqlitePreferences';
import { SqlitePoolStore } from './SqlitePoolStore';
import { SqliteMistakeStore } from './SqliteMistakeStore';
import { SqliteHubStateStore } from './SqliteHubStateStore';
import { readLearningBoosts, persistLearningBoosts } from './learningBoosts';
import { registerSources, type RuntimeSource } from './learningSources';
import { allHubSources, readHubPracticeSources } from './learningHubSources';
function fail(message: string): never {
  throw new LearningDataError('Practice Hub: ' + message);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(field);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(field);
  return value;
}
function scoped(db: Db): Db {
  return { ...db, withExclusiveTransaction: <T>(fn: () => T) => fn() };
}
/** SQLite and the verified installed source own every item/date here. Reads are pure;
 * entering/switching Hub freezes its pool and choices together through save(). Word
 * counters and account union are intentionally not consulted for a course Words list. */
export class SqliteHubReadModel {
  constructor(
    private readonly db: Db,
    private readonly ports: LearningRuntimePorts,
  ) {}
  private clock(): LearningClock {
    const c = this.ports.clock();
    if (
      !Number.isSafeInteger(c.utcMs) ||
      !Number.isFinite(new Date(c.utcMs).getTime()) ||
      !Number.isFinite(c.monotonicMs) ||
      c.monotonicMs < 0
    )
      return fail('invalid clock');
    localDayOfStamp(new Date(c.utcMs), c.zone);
    return c;
  }
  private active(courseId: string): VerifiedInstalledPack {
    if (
      this.db.get('SELECT course_id FROM course_selection WHERE is_active=1')?.course_id !==
      courseId
    )
      return fail('active course changed');
    const pack = this.ports.packs.get(courseId);
    if (!pack || pack.courseId !== courseId) return fail('verified pack is unavailable');
    return pack;
  }
  private words(
    courseId: string,
    pack: VerifiedInstalledPack,
    scheduler: SchedulerState,
    clock: LearningClock,
    all: readonly RuntimeSource[],
  ): readonly HubItem[] {
    const byItem = new Map<string, FsrsRow[]>();
    for (const row of scheduler.rows.values()) {
      if (!row.introducedAt || row.introducedAt.getTime() > clock.utcMs) continue;
      const stored = this.db.get(
        'SELECT quarantined FROM course_item WHERE course_id=? AND item_id=?',
        [courseId, row.itemId],
      );
      if (stored?.quarantined === 1) continue;
      if (stored?.quarantined !== 0) return fail('missing scheduler item');
      const list = byItem.get(row.itemId) ?? [];
      list.push(row);
      byItem.set(row.itemId, list);
    }
    return [...byItem].map(([itemId, rows]): HubItem => {
      rows.sort(
        (a, b) =>
          a.introducedAt!.getTime() - b.introducedAt!.getTime() ||
          a.surface.localeCompare(b.surface),
      );
      const row = rows[0]!;
      const matching = all.flatMap((source) =>
        source.item.schedulerSurfaces
          .filter((s) => s.itemId === itemId && s.surface === row.surface)
          .map((surface) => ({ source, surface })),
      );
      const chosen = matching.find((m) => m.surface.canonical) ?? matching[0];
      if (!chosen) return fail('introduced item has no current reviewed source');
      const { source, surface } = chosen;
      if (surface.kind !== row.kind || surface.language !== pack.pack.meta.lang)
        return fail('introduced source identity changed');
      const observed = this.db.get(
        'SELECT surface,language,observed_at_utc_ms FROM course_surface_exposure WHERE course_id=? AND surface_id=?',
        [courseId, surface.surfaceId],
      );
      if (
        !observed ||
        observed.surface !== row.surface ||
        observed.language !== surface.language ||
        observed.observed_at_utc_ms !== row.introducedAt!.getTime()
      )
        return fail('introduced surface has no exact display history');
      const lexical = source.item.lexicalBindings.filter(
        (b) => b.schedulerItemId === itemId && b.surfaceId === surface.surfaceId,
      );
      if (row.kind === 'lexeme' && lexical.length !== 1)
        return fail('reviewed lexical metadata is unavailable');
      const binding = lexical[0];
      if (pack.pack.meta.lang === 'ja')
        return fail('reviewed Japanese word readings are unavailable in this source revision');
      const kind: HubItem['kind'] =
        row.kind === 'grammarConcept'
          ? 'grammar'
          : row.kind === 'grapheme'
            ? 'character'
            : binding?.classification === 'particle'
              ? 'particle'
              : binding?.classification === 'bound-morpheme'
                ? 'morpheme'
                : binding?.classification === 'character'
                  ? 'character'
                  : 'lexeme';
      const attempts = [
        ...scheduler.attempts.rows.values(),
        ...scheduler.attempts.targetRows.values(),
      ].filter((a) => a.itemId === itemId);
      const history = scheduler.introductions.records
        .filter((r) => r.itemId === itemId)
        .map((r) => ({ at: r.at.getTime(), day: r.localDay }));
      for (const attempt of attempts) {
        const receipt = this.db.get(
          'SELECT course_id,answered_at_utc_ms,answered_local_day FROM course_session_answer_receipt WHERE session_id=? AND exercise_index=?',
          [attempt.sessionId, attempt.exerciseIndex],
        );
        if (
          !receipt ||
          receipt.course_id !== courseId ||
          receipt.answered_at_utc_ms !== attempt.at.getTime()
        )
          return fail('review has no recorded last-seen day');
        history.push({
          at: attempt.at.getTime(),
          day: toLocalDay(text(receipt.answered_local_day, 'recorded review day')),
        });
      }
      const lastSeen = history.sort((a, b) => a.at - b.at).at(-1);
      if (!lastSeen) return fail('introduced item has no recorded day');
      const seen = lastSeen.at;
      const strength = rows.map((r) =>
        projectStrengthAt(r, new Date(clock.utcMs), scheduler.holds),
      );
      return {
        itemId,
        unitIndex: source.unitIndex,
        introducedAtUtc: row.introducedAt!.toISOString(),
        lastSeenAtUtc: new Date(seen).toISOString(),
        lastSeenLocalDay: lastSeen.day,
        dueAtUtc: new Date(Math.min(...strength.map((s) => s.dueAt.getTime()))).toISOString(),
        text: text(binding?.semantic.preferredSurface ?? row.surface, 'word text'),
        gloss: text(binding?.semantic.prompt ?? source.item.explanation, 'reviewed word gloss'),
        readingForm: '',
        kind,
        example: text(row.surface, 'reviewed example'),
        audioRef: null,
        retrievability: Math.min(...strength.map((s) => s.retrievability)),
        modalities: [],
      };
    });
  }
  private practices(
    courseId: string,
    pack: VerifiedInstalledPack,
    path: PathModel,
    scheduler: SchedulerState,
    clock: LearningClock,
    all: readonly RuntimeSource[],
    words: readonly HubItem[],
  ): readonly HubItem[] {
    const known = new Map(words.map((w) => [w.itemId, w]));
    const out = new Map<string, HubItem>();
    for (const { source, modes } of readHubPracticeSources(
      this.db,
      this.ports,
      clock,
      pack,
      path,
      scheduler,
      all,
    )) {
      const item = source.item;
      const targets = [
        ...new Set(item.schedulerSurfaces.filter((s) => s.canonical).map((s) => s.itemId)),
      ];
      const rows = targets.flatMap((id) => (known.has(id) ? [known.get(id)!] : []));
      if (!targets.length || rows.length !== targets.length) continue;
      const spec = exerciseSpec(item.presentation.type),
        mode: HubItem['modalities'][number] =
          spec.family === 'speaking' ? 'speak' : spec.requiresAudio ? 'listen' : 'text';
      const previous = out.get(item.itemId);
      if (previous) {
        if (
          JSON.stringify([...previous.targetItemIds!].sort()) !==
          JSON.stringify([...targets].sort())
        )
          return fail('exercise variants changed scheduler targets');
        out.set(item.itemId, {
          ...previous,
          modalities: [...new Set([...previous.modalities, mode])],
          practiceModes: [...new Set([...previous.practiceModes!, ...modes])],
        });
        continue;
      }
      out.set(item.itemId, {
        ...rows[0]!,
        itemId: item.itemId,
        targetItemIds: targets,
        unitIndex: source.unitIndex,
        introducedAtUtc: new Date(
          Math.max(...rows.map((r) => Date.parse(r.introducedAtUtc))),
        ).toISOString(),
        lastSeenAtUtc: new Date(
          Math.max(...rows.map((r) => Date.parse(r.lastSeenAtUtc))),
        ).toISOString(),
        lastSeenLocalDay: rows
          .map((r) => r.lastSeenLocalDay)
          .sort()
          .at(-1)!,
        dueAtUtc: new Date(Math.max(...rows.map((r) => Date.parse(r.dueAtUtc)))).toISOString(),
        modalities: [mode],
        practiceModes: modes,
      });
    }
    return [...out.values()].sort(
      (a, b) => Date.parse(a.dueAtUtc) - Date.parse(b.dueAtUtc) || a.itemId.localeCompare(b.itemId),
    );
  }
  private mistakes(courseId: string): readonly HubMistake[] {
    return new SqliteMistakeStore(this.db)
      .load(courseId)
      .filter(
        (m) =>
          m.retiredAtUtcMs === null &&
          this.db.get('SELECT quarantined FROM course_item WHERE course_id=? AND item_id=?', [
            courseId,
            m.row.itemId,
          ])?.quarantined === 0,
      )
      .map((m) => ({
        itemId: m.row.itemId,
        lastMissedAtUtc: new Date(m.lastMissedAtUtcMs).toISOString(),
        lastMissedLocalDay: toLocalDay(m.lastMissedLocalDay),
        misses: m.misses,
      }));
  }
  read(courseId: string): HubInput {
    const pack = this.active(courseId),
      clock = this.clock(),
      localDay = localDayOfStamp(new Date(clock.utcMs), clock.zone),
      path = readPathModel(this.db, pack),
      scheduler = new SqliteSchedulerStore(this.db).load(courseId, clock.zone.tzId),
      all = allHubSources(pack);
    const items = this.words(courseId, pack, scheduler, clock, all),
      practiceItems = this.practices(courseId, pack, path, scheduler, clock, all, items),
      pool = new SqlitePoolStore(this.db).load(courseId, localDay),
      daily = new SqliteHubStateStore(this.db),
      preferences = new SqlitePreferences(this.db, this.ports.modalityClock).readCourse(courseId);
    const units = allUnits(path),
      currentUnitIndex = Math.max(
        0,
        ...units
          .filter((u) => u.nodes.some((_n, i) => nodeUnlocked(path, u.index, i)))
          .map((u) => u.index),
      );
    const ladders: Partial<Record<XpLadderMode, LadderStateToday>> = {};
    const modes = new Set(Object.values(FLAVOUR_XP).map((f) => f.ladderMode));
    for (const r of this.db.all('SELECT * FROM account_daily_xp WHERE local_day=?', [localDay])) {
      const mode = r.ladder_mode as XpLadderMode;
      if (!modes.has(mode)) return fail('unknown XP ladder');
      ladders[mode] = {
        sessionsCompleted: integer(r.sessions_counted, 'XP ladder count'),
        xpAwarded: integer(r.xp_awarded, 'XP ladder award'),
      };
    }
    const seed = integer(
      this.db.get('SELECT selection_seed FROM account WHERE id=1')?.selection_seed,
      'selection seed',
    );
    const lastPath = this.db.get(
      `SELECT s.completed_local_day FROM course_session_commit_link link JOIN committed_session s ON s.session_id=link.session_id WHERE link.course_id=? AND link.node_id IS NOT NULL AND link.origin_offer_id IS NULL AND s.outcome='completed' AND s.graded_attempts>0 ORDER BY s.completed_at_utc_ms DESC LIMIT 1`,
      [courseId],
    );
    const initialized = this.db.get(
      'SELECT initialized_at_utc_ms FROM course_path_state WHERE course_id=?',
      [courseId],
    )!;
    const lastPathCompletedDay = lastPath
      ? toLocalDay(text(lastPath.completed_local_day, 'path completion day'))
      : localDayOfStamp(
          new Date(integer(initialized.initialized_at_utc_ms, 'path initialization')),
          clock.zone,
        );
    const otherCourseMistakes = this.db
      .all('SELECT course_id FROM course_progress WHERE course_id<>? ORDER BY course_id', [
        courseId,
      ])
      .map((r) => {
        const id = text(r.course_id, 'course');
        return {
          courseId: id,
          courseLabel: this.ports.packs.get(id)?.pack.meta.lang ?? id,
          count: this.mistakes(id).filter(
            (m) => civilDaysBetween(m.lastMissedLocalDay, localDay) <= HUB_CONFIG.mistakeAgeDays,
          ).length,
        };
      });
    return {
      courseId,
      courseLabel: pack.pack.meta.lang,
      localDay,
      nowUtc: new Date(clock.utcMs).toISOString(),
      seed: String(seed),
      items,
      practiceItems,
      mistakes: this.mistakes(courseId),
      sharedReview: {
        localDay,
        itemIds:
          pool?.pool.itemIds ??
          practiceItems.filter((i) => Date.parse(i.dueAtUtc) <= clock.utcMs).map((i) => i.itemId),
        spentIds: pool ? [...pool.pool.spentBy.keys()] : [],
      },
      completedUnitIndices: units
        .filter((u) => u.nodes.length && u.nodes.every(isComplete))
        .map((u) => u.index),
      currentUnitIndex,
      unitLastOfferedDays: daily.rewindDays(
        courseId,
        units.map((u) => u.index),
        localDay,
      ),
      pathOffer: null,
      lastPathCompletedDay,
      preferences: {
        listening: preferences.preferences.listening,
        speaking: preferences.preferences.speaking,
        listeningUntilUtc: preferences.suspensions.listening,
        speakingUntilUtc: preferences.suspensions.speaking,
      },
      audioAvailable: practiceItems.some((i) => i.modalities.includes('listen')),
      microphoneAvailable: practiceItems.some((i) => i.modalities.includes('speak')),
      packReady: true,
      daily: daily.load(courseId, localDay),
      activeBoost: readLearningBoosts(this.db, clock).active,
      ladders,
      otherCourseMistakes,
    };
  }
  save(requested: HubDailyState): void {
    this.db.withExclusiveTransaction(() => {
      const db = scoped(this.db),
        clock = this.clock(),
        model = new SqliteHubReadModel(db, { ...this.ports, clock: () => clock }),
        input = model.read(requested.courseId);
      if (input.localDay !== requested.localDay) return fail('stale day');
      const pack = model.active(requested.courseId),
        scheduler = new SqliteSchedulerStore(db),
        before = scheduler.load(requested.courseId, clock.zone.tzId),
        available = readHubPracticeSources(
          db,
          this.ports,
          clock,
          pack,
          readPathModel(db, pack),
          before,
          allHubSources(pack),
        );
      // A known five-target MATCH may have no aggregate parent row until it is first
      // offered. Register only source-verified metadata before the pool's actual FK;
      // the resolver already requires every canonical target to have been introduced.
      scheduler.save(
        requested.courseId,
        registerSources(
          db,
          requested.courseId,
          before,
          available.map((s) => s.source),
          clock,
        ),
      );
      new SqlitePoolStore(db).open(
        requested.courseId,
        input.localDay,
        input.seed,
        input.sharedReview.itemIds.map(asItemId),
        clock.utcMs,
      );
      new SqliteHubStateStore(db).save(() => model.read(requested.courseId), requested);
      persistLearningBoosts(db, readLearningBoosts(db, clock));
    });
  }
}
