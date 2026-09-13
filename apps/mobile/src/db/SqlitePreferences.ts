import type { Db, DbRow } from '@freelingo/schema';
import { preferenceChange, type PreferenceKey } from '@freelingo/core/course';
import {
  parseModalitySuspensions,
  clearModalitySuspension,
  suspendModality,
  remainingSuspensionMs,
  type ModalityClock,
  type ModalityFamily,
} from '@freelingo/core/modality';

/** Schema v4 owns the matching defaults; the migration test checks old installs. */
const PREFERENCE_COLUMNS = {
  soundEffects: 'sound_effects_enabled',
  animations: 'animations_enabled',
  motivationalMessages: 'motivational_messages_enabled',
  listening: 'listening_enabled',
  speaking: 'speaking_enabled',
} as const satisfies Record<PreferenceKey, string>;
const GENERAL_PREFERENCES: ReadonlySet<PreferenceKey> = new Set([
  'soundEffects',
  'animations',
  'motivationalMessages',
]);
export type Appearance = 'light' | 'dark' | 'system';
export interface CoursePreferences {
  readonly preferences: Readonly<Record<PreferenceKey, boolean>>;
  readonly suspensions: { readonly listening: string | null; readonly speaking: string | null };
}
const DEFAULT_COURSE: CoursePreferences = {
  preferences: {
    soundEffects: true,
    animations: true,
    motivationalMessages: true,
    listening: true,
    speaking: true,
  },
  suspensions: { listening: null, speaking: null },
};
export class PreferencesError extends Error {}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new PreferencesError('Invalid suspension/import timestamp');
  const canonical = new Date(value).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z'))
    throw new PreferencesError('Invalid suspension/import timestamp');
  return value;
}
function appearance(value: unknown): Appearance {
  if (value !== 'light' && value !== 'dark' && value !== 'system')
    throw new PreferencesError('Invalid appearance');
  return value;
}
function booleanColumn(row: DbRow, column: string): boolean {
  const value = row[column];
  if (value !== 0 && value !== 1) throw new PreferencesError(`Invalid preference ${column}`);
  return value === 1;
}
/** The settings writer uses only whitelisted column names and bound course identifiers.
 * Each action checks the live course inside its exclusive transaction, so a queued
 * callback cannot recreate preferences after course removal. Reads never create rows. */
export class SqlitePreferences {
  constructor(
    private readonly db: Db,
    private readonly clock: () => ModalityClock | null,
  ) {}
  private requireCourse(courseId: string): void {
    if (!this.db.get('SELECT course_id FROM course_progress WHERE course_id=?', [courseId]))
      throw new PreferencesError('This course is no longer installed.');
  }
  private ensureCourse(courseId: string): void {
    this.requireCourse(courseId);
    this.db.run('INSERT OR IGNORE INTO course_display(course_id) VALUES (?)', [courseId]);
  }
  readCourse(courseId: string): CoursePreferences {
    this.requireCourse(courseId);
    const course = this.db.get('SELECT * FROM course_display WHERE course_id=?', [courseId]);
    const account = this.db.get('SELECT * FROM account WHERE id=1');
    if (!account) throw new PreferencesError('Missing account settings');
    const state = parseModalitySuspensions(
      typeof account.modality_suspension_until === 'string'
        ? account.modality_suspension_until
        : null,
    );
    const now = this.clock();
    const until = (family: ModalityFamily): string | null => {
      if (now === null) return null;
      const remainingMs = remainingSuspensionMs(state, family, now);
      // This is an ephemeral projection for wall-clock view models. The durable
      // deadline stays monotonic; neither reading nor clock changes rewrite it.
      return remainingMs > 0 ? new Date(now.utcMs + remainingMs).toISOString() : null;
    };
    return {
      preferences: {
        soundEffects: booleanColumn(account, PREFERENCE_COLUMNS.soundEffects),
        animations: booleanColumn(account, PREFERENCE_COLUMNS.animations),
        motivationalMessages: booleanColumn(account, PREFERENCE_COLUMNS.motivationalMessages),
        listening: course
          ? booleanColumn(course, PREFERENCE_COLUMNS.listening)
          : DEFAULT_COURSE.preferences.listening,
        speaking: course
          ? booleanColumn(course, PREFERENCE_COLUMNS.speaking)
          : DEFAULT_COURSE.preferences.speaking,
      },
      suspensions: { listening: until('listening'), speaking: until('speaking') },
    };
  }
  readAccount(): { readonly appearance: Appearance; readonly importedAtUtc: string | null } {
    const row = this.db.get('SELECT appearance,imported_at_utc FROM account WHERE id=1');
    if (!row) throw new PreferencesError('Missing account settings');
    return {
      appearance: appearance(row.appearance),
      importedAtUtc: timestamp(row.imported_at_utc),
    };
  }
  setCoursePreference(courseId: string, key: PreferenceKey, value: boolean): void {
    if (!Object.hasOwn(PREFERENCE_COLUMNS, key) || typeof value !== 'boolean')
      throw new PreferencesError('Invalid course preference');
    const column = PREFERENCE_COLUMNS[key];
    const change = preferenceChange(key, value);
    this.db.withExclusiveTransaction(() => {
      // A stale course callback may not change even account-wide lesson preferences.
      this.requireCourse(courseId);
      if (GENERAL_PREFERENCES.has(key)) {
        this.db.run(`UPDATE account SET ${column}=? WHERE id=1`, [value ? 1 : 0]);
      } else {
        this.ensureCourse(courseId);
        this.db.run(`UPDATE course_display SET ${column}=? WHERE course_id=?`, [
          value ? 1 : 0,
          courseId,
        ]);
      }
      if (change.clearSuspension !== null) {
        const row = this.db.get('SELECT modality_suspension_until FROM account WHERE id=1');
        const raw =
          typeof row?.modality_suspension_until === 'string' ? row.modality_suspension_until : null;
        const state = clearModalitySuspension(
          parseModalitySuspensions(raw),
          change.clearSuspension,
        );
        this.db.run('UPDATE account SET modality_suspension_until=? WHERE id=1', [
          JSON.stringify(state),
        ]);
      }
    });
  }
  suspend(courseId: string, family: ModalityFamily): void {
    this.db.withExclusiveTransaction(() => {
      this.requireCourse(courseId);
      const row = this.db.get('SELECT modality_suspension_until FROM account WHERE id=1');
      const raw =
        typeof row?.modality_suspension_until === 'string' ? row.modality_suspension_until : null;
      const now = this.clock();
      if (now === null) throw new PreferencesError('The device clock is unavailable. Try again.');
      const state = suspendModality(parseModalitySuspensions(raw), family, now);
      this.db.run('UPDATE account SET modality_suspension_until=? WHERE id=1', [
        JSON.stringify(state),
      ]);
    });
  }
  setAppearance(value: Appearance): void {
    const next = appearance(value);
    this.db.withExclusiveTransaction(() => {
      this.readAccount();
      this.db.run('UPDATE account SET appearance=? WHERE id=1', [next]);
    });
  }
}
