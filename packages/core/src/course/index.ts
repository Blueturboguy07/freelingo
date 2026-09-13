/** S130/S133/S134 — explicit actions for an injected transactional persistence port. */
import { IMPORT_UNDO_WINDOW_HOURS } from '../data/manifest.js';
export type CourseAction = 'switch' | 'remove' | 'reset' | 'removeAudio';
export interface CourseActionRequest {
  readonly action: CourseAction;
  readonly courseId: string;
  readonly installedCourseIds: readonly string[];
  readonly activeCourseId: string | null;
  readonly importedAtUtc: string | null;
  readonly nowUtc: string;
}
export interface CourseActionPlan {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly action: CourseAction;
  readonly courseId: string;
  readonly deleteProgress: boolean;
  readonly deleteSession: boolean;
  readonly deletePack: boolean;
  readonly deleteAudio: boolean;
  readonly affectsAccount: false;
  readonly nextActiveCourseId: string | null;
}
export const COURSE_IMPORT_PAUSE_COPY =
  'You recently imported data. To protect your progress, course removal is paused for 24 hours.';
export function courseActionPlan(request: CourseActionRequest): CourseActionPlan {
  const destructive = request.action === 'remove' || request.action === 'reset';
  const age =
    request.importedAtUtc === null
      ? Infinity
      : Date.parse(request.nowUtc) - Date.parse(request.importedAtUtc);
  const blocked =
    destructive &&
    ((!Number.isFinite(age) && age !== Infinity) ||
      age < IMPORT_UNDO_WINDOW_HOURS * 60 * 60 * 1000);
  const allowed = request.installedCourseIds.includes(request.courseId) && !blocked;
  return {
    allowed,
    reason: blocked ? COURSE_IMPORT_PAUSE_COPY : allowed ? null : 'This course is not installed',
    action: request.action,
    courseId: request.courseId,
    deleteProgress: allowed && destructive,
    deleteSession: allowed && destructive,
    deletePack: allowed && request.action === 'remove',
    deleteAudio: allowed && (request.action === 'remove' || request.action === 'removeAudio'),
    affectsAccount: false,
    nextActiveCourseId: !allowed
      ? request.activeCourseId
      : request.action === 'switch'
        ? request.courseId
        : request.action === 'remove' && request.activeCourseId === request.courseId
          ? (request.installedCourseIds.find((id) => id !== request.courseId) ?? null)
          : request.activeCourseId,
  };
}
export type PreferenceKey =
  'soundEffects' | 'animations' | 'motivationalMessages' | 'listening' | 'speaking';
export interface PreferenceChange {
  readonly key: PreferenceKey;
  readonly value: boolean;
  readonly clearSuspension: 'listening' | 'speaking' | null;
}
export function preferenceChange(key: PreferenceKey, value: boolean): PreferenceChange {
  return {
    key,
    value,
    clearSuspension: value && (key === 'listening' || key === 'speaking') ? key : null,
  };
}
