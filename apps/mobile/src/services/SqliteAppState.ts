import type { Db, DbRow } from '@freelingo/schema';
import type { PlacementChoice, SelfReportLevel } from '../onboarding/ports';

/** Existing v6 onboarding steps. S001–S009, 2026-09-13; no new persistence schema. */
export const ONBOARDING_STEPS = [
  'courses',
  'pack-detail',
  'restore',
  'placement-choice',
  'self-report',
  'placement-test',
  'placement-result',
  'goal',
  'notifications',
  'entering',
  'complete',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export interface SelectedCourse {
  readonly courseId: string;
  readonly placementChoice: PlacementChoice | null;
  readonly selfReportLevel: SelfReportLevel | null;
  readonly placementSectionIndex: number | null;
}
export interface StoredAppState {
  readonly step: OnboardingStep;
  readonly completedAtUtc: string | null;
  readonly selectionSeed: number;
  readonly activeCourseId: string | null;
  readonly selectedCourse: SelectedCourse | null;
  readonly courseIds: readonly string[];
}
export class AppDataError extends Error {}
function fail(field: string): never {
  throw new AppDataError(`Invalid application ${field}.`);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(field);
  return value;
}
function time(value: unknown): string {
  const result = text(value, 'time');
  if (!Number.isFinite(Date.parse(result))) return fail('time');
  return result;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(field);
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  const found = values.find((candidate) => candidate === value);
  return found === undefined ? fail(field) : found;
}
function selected(row: DbRow): SelectedCourse {
  return {
    courseId: text(row.course_id, 'course'),
    placementChoice:
      row.placement_choice === null
        ? null
        : oneOf(row.placement_choice, ['scratch', 'test'] as const, 'placement choice'),
    selfReportLevel:
      row.self_report_level === null
        ? null
        : oneOf(
            row.self_report_level,
            ['new', 'words', 'basic', 'topics', 'detailed'] as const,
            'self-report level',
          ),
    placementSectionIndex:
      row.placement_section_index === null
        ? null
        : integer(row.placement_section_index, 'placement section'),
  };
}

/** Owns only application choices. Verified installs, path advancement and every reward
 * remain in their dedicated adapters. Selecting a catalogue row is not installing it.
 * The factory serializes user events; transition additionally rejects stale async callbacks. */
export class SqliteAppState {
  constructor(private readonly db: Db) {}

  initialize(selectionSeed: number): StoredAppState {
    integer(selectionSeed, 'seed');
    return this.db.withExclusiveTransaction(() => {
      const account = this.db.get('SELECT selection_seed FROM account WHERE id=1');
      if (!account) return fail('account');
      if (account.selection_seed === null) {
        this.db.run('UPDATE account SET selection_seed=? WHERE id=1', [selectionSeed]);
      } else integer(account.selection_seed, 'seed');
      this.db.run(
        "INSERT OR IGNORE INTO account_onboarding(id,step,completed_at_utc) VALUES(1,'courses',NULL)",
      );
      return this.read();
    });
  }

  read(): StoredAppState {
    const onboarding = this.db.get(
      'SELECT step,completed_at_utc FROM account_onboarding WHERE id=1',
    );
    const account = this.db.get('SELECT selection_seed FROM account WHERE id=1');
    if (!onboarding || !account) return fail('uninitialized state');
    const step = oneOf(onboarding.step, ONBOARDING_STEPS, 'onboarding step');
    const completedAtUtc =
      onboarding.completed_at_utc === null ? null : time(onboarding.completed_at_utc);
    if ((step === 'complete') !== (completedAtUtc !== null)) return fail('onboarding completion');
    const selectedRows = this.db.all('SELECT * FROM course_selection WHERE is_selected=1');
    const activeRows = this.db.all('SELECT course_id FROM course_selection WHERE is_active=1');
    if (selectedRows.length > 1 || activeRows.length > 1) return fail('ambiguous course selection');
    return {
      step,
      completedAtUtc,
      selectionSeed: integer(account.selection_seed, 'seed'),
      selectedCourse: selectedRows[0] ? selected(selectedRows[0]) : null,
      activeCourseId: activeRows[0] ? text(activeRows[0].course_id, 'course') : null,
      courseIds: this.db
        .all('SELECT course_id FROM course_progress ORDER BY added_at,course_id')
        .map((row) => text(row.course_id, 'course')),
    };
  }

  /** Caller first resolves this exact ID in the source-backed catalogue. */
  selectCourse(courseId: string, nowUtc: string): void {
    text(courseId, 'course');
    time(nowUtc);
    this.db.withExclusiveTransaction(() => {
      this.db.run('INSERT OR IGNORE INTO course_progress(course_id,added_at) VALUES(?,?)', [
        courseId,
        nowUtc,
      ]);
      this.db.run('UPDATE course_selection SET is_selected=0 WHERE is_selected=1');
      this.db.run(
        'INSERT INTO course_selection(course_id,is_selected) VALUES(?,1) ON CONFLICT(course_id) DO UPDATE SET is_selected=1',
        [courseId],
      );
    });
  }

  transition(expected: OnboardingStep, next: Exclude<OnboardingStep, 'complete'>): boolean {
    oneOf(expected, ONBOARDING_STEPS, 'onboarding step');
    oneOf(
      next,
      ONBOARDING_STEPS.filter((step) => step !== 'complete'),
      'onboarding step',
    );
    return this.db.withExclusiveTransaction(() => {
      const state = this.read();
      if (state.step === 'complete' || state.step !== expected) return false;
      if (next !== 'courses' && next !== 'restore' && !state.selectedCourse)
        return fail('selected course');
      this.db.run('UPDATE account_onboarding SET step=?,completed_at_utc=NULL WHERE id=1', [next]);
      return true;
    });
  }

  choosePlacement(choice: PlacementChoice): void {
    oneOf(choice, ['scratch', 'test'], 'placement choice');
    this.db.withExclusiveTransaction(() => {
      const id = this.requireSelected();
      this.db.run('UPDATE course_selection SET placement_choice=? WHERE course_id=?', [choice, id]);
    });
  }

  chooseLevel(level: SelfReportLevel): void {
    oneOf(level, ['new', 'words', 'basic', 'topics', 'detailed'] as const, 'self-report level');
    this.db.withExclusiveTransaction(() => {
      const id = this.requireSelected();
      this.db.run('UPDATE course_selection SET self_report_level=? WHERE course_id=?', [level, id]);
    });
  }

  private requireSelected(): string {
    const course = this.read().selectedCourse;
    if (!course) return fail('selected course');
    return course.courseId;
  }

  /** Exact contentHash is from repository.get after refresh. The SQL join prevents a
   * stale install callback from activating a different version or an unverified pack. */
  completeOnboarding(courseId: string, contentHash: string, nowUtc: string): void {
    text(courseId, 'course');
    text(contentHash, 'pack identity');
    time(nowUtc);
    this.db.withExclusiveTransaction(() => {
      const state = this.read();
      if (state.selectedCourse?.courseId !== courseId) return fail('selected course');
      const course = this.db.get(
        'SELECT pack_state,pack_content_hash FROM course_progress WHERE course_id=?',
        [courseId],
      );
      if (!course || (course.pack_state !== 'installed' && course.pack_state !== 'partial'))
        return fail('verified playable pack');
      if (course.pack_content_hash !== contentHash) return fail('pack identity');
      if (state.step === 'complete' && state.activeCourseId === courseId) return;
      this.activate(courseId);
      this.db.run("UPDATE account_onboarding SET step='complete',completed_at_utc=? WHERE id=1", [
        state.completedAtUtc ?? nowUtc,
      ]);
    });
  }

  private activate(courseId: string): void {
    this.db.run('UPDATE course_selection SET is_active=0 WHERE is_active=1');
    this.db.run(
      'INSERT INTO course_selection(course_id,is_active) VALUES(?,1) ON CONFLICT(course_id) DO UPDATE SET is_active=1',
      [courseId],
    );
  }

  /** Switching is allowed for unavailable/read-only courses; launch eligibility is a
   * separate verified-pack decision. No saved lesson or selected onboarding choice changes. */
  switchCourse(courseId: string): void {
    text(courseId, 'course');
    this.db.withExclusiveTransaction(() => {
      if (!this.db.get('SELECT course_id FROM course_progress WHERE course_id=?', [courseId]))
        return fail('course');
      this.activate(courseId);
    });
  }
}
