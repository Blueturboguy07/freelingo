import { civilDaysBetween, isLocalDay, localDayOf, type LocalDay } from '../day/civil.js';
import { DAY_CONFIG } from '../day/config.js';
import {
  formatReminderTime,
  notificationSettingsModel,
  type NotificationChannel,
  type NotificationSettingsSnapshot,
} from './settings.js';

/** Local policy, 2026-09-13. deep07 S10 corrected by EC-NOT-01..19; no A/B arm.
 * Expiry and timezone rearming are capabilities, not inferred from Expo availability. */
export const NOTIFICATION_CONFIG = {
  rollingDays: 7,
  maximumPerDay: 2,
  iosPendingLimit: 64,
  collisionMs: 10 * 60_000,
  dangerLeadMs: 2 * 60 * 60_000,
  maximumDangerAheadMs: 24 * 60 * 60_000,
  recencyPenalty: 0.017,
  recencyHalfLifeDays: 15,
  rewardWindowMs: 2 * 60 * 60_000,
  rearmDebounceMs: 2_000,
} as const;
export type NotificationSlot = 'daily' | 'discretionary';
export type TemplateFamily =
  | 'habit'
  | 'course_progress'
  | 'content_tease'
  | 'goal_met'
  | 'streak_alive'
  | 'danger'
  | 'revive'
  | 'comeback'
  | 'mistakes_due'
  | 'target_practice'
  | 'freeze_used';
export interface NotificationTemplate {
  readonly id: string;
  readonly family: TemplateFamily;
  readonly slot: NotificationSlot;
  readonly body: string;
  readonly score: number;
}
export interface NotificationCourseFacts {
  readonly courseId: string;
  readonly courseName: string;
  readonly lastSessionLocalDay: LocalDay | null;
  readonly mistakesDue: number;
  readonly recentWeakItems: number;
  readonly hasProgress: boolean;
  readonly hasContentTease: boolean;
}
export interface NotificationDayFacts {
  readonly localDay: LocalDay;
  readonly goalMet: boolean;
  readonly streakExtendedToday: boolean;
  readonly streakCount: number;
  readonly freezeCoversToday: boolean;
  readonly previousDayDisposition: 'extended' | 'frozen' | 'missed' | 'unlived' | 'none';
  readonly recoveryUntilUtc: string | null;
}
export interface CalendarOccurrence {
  readonly localDay: LocalDay;
  readonly atUtc: string;
  readonly calendar: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  };
}
export interface NotificationPlanInput {
  nowUtc: string;
  localDay: LocalDay;
  timeZone: string;
  nextLocalMidnightUtc: string;
  settings: NotificationSettingsSnapshot;
  native: {
    readonly calendarRearmCapable: boolean;
    readonly expirationCapable: boolean;
    readonly pendingLimit: number;
    readonly otherPendingCount: number;
  };
  day: NotificationDayFacts;
  courses: readonly NotificationCourseFacts[];
  dailyOccurrences: readonly CalendarOccurrence[];
  history: readonly NotificationDelivery[];
}
export interface PlannedNotification {
  readonly id: string;
  readonly localDay: LocalDay;
  readonly courseId: string;
  readonly templateId: string;
  readonly family: TemplateFamily;
  readonly slot: NotificationSlot;
  readonly channel: NotificationChannel;
  readonly body: string;
  readonly atUtc: string;
  readonly expiresAtUtc: string | null;
  readonly trigger:
    | ({
        readonly kind: 'calendar';
        readonly repeats: false;
        readonly inexact: true;
      } & CalendarOccurrence['calendar'])
    | { readonly kind: 'absolute'; readonly atUtc: string };
}
/** Only actual presentation enters this log. Queue reservations are never persisted as use. */
export interface NotificationDelivery {
  readonly id: string;
  readonly templateId: string;
  readonly courseId: string;
  readonly localDay: LocalDay;
  readonly slot: NotificationSlot;
  readonly deliveredAtUtc: string;
  readonly rewardedAtUtc: string | null;
}
function templates(
  family: TemplateFamily,
  slot: NotificationSlot,
  bodies: readonly string[],
): NotificationTemplate[] {
  return bodies.map((body, index) => ({
    id: `${family}_${index + 1}`,
    family,
    slot,
    body,
    score: 1,
  }));
}
/** Original local copy; the bundle's decaying countdowns remain widget-only. */
export const NOTIFICATION_TEMPLATES: readonly NotificationTemplate[] = [
  ...templates('habit', 'daily', [
    'Make a little room for {course}.',
    'A little {course} practice goes a long way.',
    'Take a small step with {course}.',
    'Keep exploring {course} at your own pace.',
    'Bring some {course} into your day.',
    'There is always more {course} to discover.',
    'Ready for a little {course}?',
    'Spend a moment with {course}.',
  ]),
  ...templates('course_progress', 'daily', ['Build on what you know in {course}.']),
  ...templates('content_tease', 'daily', ['Explore something in your {course} course.']),
  ...templates('streak_alive', 'daily', ['Keep your practice habit going with {course}.']),
  ...templates('goal_met', 'daily', [
    'Enjoy the progress you are making in {course}.',
    'Keep enjoying your {course} journey.',
    'Every bit of {course} practice adds up.',
    'Your {course} skills are worth building on.',
    'Keep your curiosity for {course} alive.',
    'Carry your {course} practice with you.',
    'A little {course} can be a rewarding habit.',
    'Make your next discovery in {course}.',
  ]),
  ...templates('danger', 'discretionary', [
    'Keep your streak going with {course}.',
    'Give your streak some {course} practice.',
    'A little {course} can keep your streak going.',
    'Make room for your streak with {course}.',
    'Keep showing up for your {course} practice.',
    'Continue your streak with some {course}.',
    'Let your {course} habit keep growing.',
    'Take the next step for your streak in {course}.',
  ]),
  ...templates('revive', 'discretionary', [
    'Your streak recovery is available. Practice {course}.',
    'Pick up your streak recovery with {course}.',
    'Return to {course} with your streak recovery challenge.',
    'Give your streak a fresh start with {course}.',
    'Continue your recovery challenge in {course}.',
    'Your recovery challenge is ready for {course} practice.',
    'Take a step toward streak recovery with {course}.',
    'Make progress on streak recovery in {course}.',
  ]),
  ...templates('comeback', 'discretionary', [
    'Come back to {course} and refresh your skills.',
    'Your {course} practice is here when you are ready.',
    'Reconnect with your {course} learning.',
    'Find your rhythm again with {course}.',
    'Take a fresh look at {course}.',
    'A small return to {course} is a good start.',
    'Pick up where you left off in {course}.',
    'Welcome some {course} practice back into your day.',
  ]),
  ...templates('mistakes_due', 'discretionary', [
    'Revisit your {course} mistakes with fresh eyes.',
    'Give a tricky part of {course} another try.',
    'Learn from your recent {course} mistakes.',
    'Turn a {course} mistake into another chance to learn.',
    'Your {course} mistakes are ready to review.',
    'Take another look at the {course} items that challenged you.',
    'Build confidence by reviewing your {course} mistakes.',
    'Practice a tricky {course} item again.',
  ]),
  ...templates('target_practice', 'discretionary', [
    'Give your recent {course} skills a little practice.',
    'Strengthen a recent {course} skill.',
    'Build on your recent {course} sessions.',
    'Revisit something you have been learning in {course}.',
    'Take another step with a recent {course} topic.',
    'Refresh a skill from your {course} practice.',
    'Bring your recent {course} learning back to mind.',
    'Make your recent {course} practice stick.',
  ]),
  ...templates('freeze_used', 'discretionary', [
    'A freeze protected your streak. Pick up your {course} practice.',
    'Your freeze helped. Return to {course} practice.',
    'Keep going with {course} after your freeze.',
    'Your streak had freeze support. Practice some {course}.',
    'A freeze covered the gap. Continue with {course}.',
    'Return to your {course} habit after using a freeze.',
    'Your freeze kept the streak intact. Take a step with {course}.',
    'Build on your protected streak with {course}.',
  ]),
];
function millis(utc: string): number {
  const result = Date.parse(utc);
  if (!Number.isFinite(result)) throw new RangeError('Invalid notification instant');
  return result;
}
function count(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function fresh(input: NotificationPlanInput): boolean {
  return (
    input.day.localDay === input.localDay &&
    localDayOf(new Date(input.nowUtc), input.timeZone) === input.localDay
  );
}
function dangerEligible(input: NotificationPlanInput): boolean {
  return (
    input.day.streakCount > 0 &&
    !input.day.goalMet &&
    !input.day.streakExtendedToday &&
    !input.day.freezeCoversToday
  );
}
function recoveryEligible(input: NotificationPlanInput): boolean {
  return (
    input.day.streakCount === 0 &&
    !input.day.goalMet &&
    input.day.recoveryUntilUtc !== null &&
    millis(input.day.recoveryUntilUtc) > millis(input.nowUtc)
  );
}
function eligible(
  t: NotificationTemplate,
  course: NotificationCourseFacts,
  input: NotificationPlanInput,
  day: LocalDay,
): boolean {
  // Future state is unknown: never project today's goal, streak or recovery into a future body.
  if (day !== input.localDay) return t.slot === 'daily' && t.family === 'habit';
  if (t.slot === 'daily') {
    if (input.day.goalMet && !input.day.freezeCoversToday) return t.family === 'goal_met';
    return (
      t.family === 'habit' ||
      (t.family === 'course_progress' && course.hasProgress) ||
      (t.family === 'content_tease' && course.hasContentTease) ||
      (t.family === 'streak_alive' && input.day.streakCount > 0)
    );
  }
  if (input.day.goalMet) return false;
  switch (t.family) {
    case 'danger':
      return dangerEligible(input);
    case 'revive':
      return recoveryEligible(input);
    case 'comeback':
      return (
        !recoveryEligible(input) &&
        course.lastSessionLocalDay !== null &&
        civilDaysBetween(course.lastSessionLocalDay, day) >= 3
      );
    case 'mistakes_due':
      return course.mistakesDue >= 5;
    case 'target_practice':
      return course.recentWeakItems >= 8;
    case 'freeze_used':
      return input.day.previousDayDisposition === 'frozen';
    default:
      return false;
  }
}
function urgency(template: NotificationTemplate): number {
  if (template.slot === 'daily') return 0;
  switch (template.family) {
    case 'danger':
    case 'revive':
      return 4;
    case 'freeze_used':
      return 3;
    case 'comeback':
      return 2;
    default:
      return 1;
  }
}
export function recencyScore(score: number, daysSinceUse: number | null): number {
  return daysSinceUse === null
    ? score
    : score -
        NOTIFICATION_CONFIG.recencyPenalty *
          0.5 ** (Math.max(0, daysSinceUse) / NOTIFICATION_CONFIG.recencyHalfLifeDays);
}
export function chooseTemplate(
  input: NotificationPlanInput,
  slot: NotificationSlot,
  day: LocalDay,
  pool: readonly NotificationTemplate[] = NOTIFICATION_TEMPLATES,
): { template: NotificationTemplate; course: NotificationCourseFacts } | null {
  const candidates = input.courses.flatMap((course) =>
    pool
      .filter((t) => t.slot === slot && eligible(t, course, input, day))
      .map((template) => {
        const uses = input.history.filter((h) => h.templateId === template.id);
        const last = uses.reduce<number | null>((least, h) => {
          const age = civilDaysBetween(h.localDay, day);
          return least === null ? age : Math.min(least, age);
        }, null);
        const rewards = uses.filter(
          (h) =>
            h.courseId === course.courseId &&
            h.rewardedAtUtc !== null &&
            millis(h.rewardedAtUtc) >= millis(h.deliveredAtUtc) &&
            millis(h.rewardedAtUtc) - millis(h.deliveredAtUtc) <=
              NOTIFICATION_CONFIG.rewardWindowMs,
        ).length;
        return { template, course, score: recencyScore(template.score, last), rewards };
      }),
  );
  candidates.sort(
    (a, b) =>
      urgency(b.template) - urgency(a.template) ||
      b.score - a.score ||
      b.rewards - a.rewards ||
      a.template.id.localeCompare(b.template.id) ||
      a.course.courseId.localeCompare(b.course.courseId),
  );
  return candidates[0] ?? null;
}
function validate(input: NotificationPlanInput): void {
  millis(input.nowUtc);
  const midnight = millis(input.nextLocalMidnightUtc);
  if (!isLocalDay(input.localDay) || midnight <= millis(input.nowUtc))
    throw new RangeError('Invalid local day boundary');
  if (
    localDayOf(new Date(midnight - 1), input.timeZone) !== input.localDay ||
    localDayOf(new Date(midnight), input.timeZone) === input.localDay
  )
    throw new RangeError('Invalid local day boundary for timezone');
  formatReminderTime(input.settings);
  if (
    !count(input.native.pendingLimit) ||
    !count(input.native.otherPendingCount) ||
    !count(input.day.streakCount)
  )
    throw new RangeError('Invalid notification capacity or streak');
  const courses = new Set<string>();
  for (const c of input.courses) {
    if (
      !c.courseId ||
      !c.courseName ||
      courses.has(c.courseId) ||
      !count(c.mistakesDue) ||
      !count(c.recentWeakItems)
    )
      throw new RangeError('Invalid notification course facts');
    courses.add(c.courseId);
  }
  const days = new Set<string>();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: input.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (const occurrence of input.dailyOccurrences) {
    const c = occurrence.calendar,
      civil = `${String(c.year).padStart(4, '0')}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
    if (c.hour !== input.settings.hour || c.minute !== input.settings.minute)
      throw new RangeError('Calendar does not match reminder time');
    if (!isLocalDay(occurrence.localDay) || civil !== occurrence.localDay || days.has(civil))
      throw new RangeError('Invalid or duplicate calendar day');
    const instant = new Date(millis(occurrence.atUtc));
    if (
      localDayOf(instant, input.timeZone) !== occurrence.localDay ||
      formatter.format(instant) !== formatReminderTime(c)
    )
      throw new RangeError('Calendar and instant do not join in the current timezone');
    days.add(civil);
  }
}
function request(
  winner: NonNullable<ReturnType<typeof chooseTemplate>>,
  day: LocalDay,
  atUtc: string,
  expiresAtUtc: string | null,
  trigger: PlannedNotification['trigger'],
): PlannedNotification {
  const { template, course } = winner;
  return {
    id: `freelingo/${day}/${template.slot}`,
    localDay: day,
    courseId: course.courseId,
    templateId: template.id,
    family: template.family,
    slot: template.slot,
    channel: template.slot === 'daily' ? 'daily' : 'streak',
    body: template.body.replace('{course}', course.courseName),
    atUtc,
    expiresAtUtc,
    trigger,
  };
}
/** Computes a complete desired set. Never mutates history or schedules anything. */
export function buildNotificationPlan(input: NotificationPlanInput): PlannedNotification[] {
  validate(input);
  if (
    !fresh(input) ||
    (input.settings.platform === 'android' && !input.native.calendarRearmCapable)
  )
    return [];
  const settings = notificationSettingsModel(input.settings),
    now = millis(input.nowUtc),
    midnight = millis(input.nextLocalMidnightUtc);
  const result: PlannedNotification[] = [];
  const delivered = (day: LocalDay, slot: NotificationSlot) =>
    input.history.some((h) => h.localDay === day && h.slot === slot);
  if (
    settings.streak.canSchedule &&
    input.native.expirationCapable &&
    !delivered(input.localDay, 'discretionary')
  ) {
    const winner = chooseTemplate(input, 'discretionary', input.localDay);
    if (winner) {
      const expiry =
        winner.template.family === 'revive'
          ? Math.min(midnight, millis(input.day.recoveryUntilUtc!))
          : midnight;
      const at = expiry - NOTIFICATION_CONFIG.dangerLeadMs;
      if (at > now && at - now <= NOTIFICATION_CONFIG.maximumDangerAheadMs)
        result.push(
          request(
            winner,
            input.localDay,
            new Date(at).toISOString(),
            new Date(expiry).toISOString(),
            { kind: 'absolute', atUtc: new Date(at).toISOString() },
          ),
        );
    }
  }
  // Ephemeral future reservations rotate copy within this plan. They are not delivered history.
  const reservations = [...input.history];
  if (settings.daily.canSchedule) {
    for (const occurrence of [...input.dailyOccurrences].sort(
      (a, b) => millis(a.atUtc) - millis(b.atUtc),
    )) {
      const age = civilDaysBetween(input.localDay, occurrence.localDay);
      if (
        age < 0 ||
        age >= NOTIFICATION_CONFIG.rollingDays ||
        millis(occurrence.atUtc) <= now ||
        delivered(occurrence.localDay, 'daily')
      )
        continue;
      if (
        result.some(
          (n) =>
            Math.abs(millis(n.atUtc) - millis(occurrence.atUtc)) <= NOTIFICATION_CONFIG.collisionMs,
        )
      )
        continue;
      const winner = chooseTemplate(
        { ...input, history: reservations },
        'daily',
        occurrence.localDay,
      );
      if (!winner) continue;
      const next = request(winner, occurrence.localDay, occurrence.atUtc, null, {
        kind: 'calendar',
        ...occurrence.calendar,
        repeats: false,
        inexact: true,
      });
      result.push(next);
      reservations.push({ ...next, deliveredAtUtc: next.atUtc, rewardedAtUtc: null });
    }
  }
  const limit = Math.max(
    0,
    Math.min(
      input.native.pendingLimit,
      input.settings.platform === 'ios'
        ? NOTIFICATION_CONFIG.iosPendingLimit
        : input.native.pendingLimit,
    ) - input.native.otherPendingCount,
  );
  return result
    .sort((a, b) => millis(a.atUtc) - millis(b.atUtc))
    .filter((n) => {
      const used = new Set(input.history.filter((h) => h.localDay === n.localDay).map((h) => h.id));
      return used.size < NOTIFICATION_CONFIG.maximumPerDay;
    })
    .slice(0, limit);
}
export interface NotificationPresentationFacts {
  readonly input: NotificationPlanInput;
  readonly clock: { readonly bootId: string; readonly monotonicMs: number };
  readonly session: { readonly bootId: string; readonly checkpointMonotonicMs: number } | null;
}
/** Native presentation/recheck ports must call with a fresh durable snapshot; unknown facts suppress. */
export function notificationMayPresent(
  notification: PlannedNotification,
  facts: NotificationPresentationFacts,
): boolean {
  const { input, clock, session } = facts;
  try {
    if (
      !fresh(input) ||
      notification.localDay !== input.localDay ||
      millis(input.nowUtc) < millis(notification.atUtc)
    )
      return false;
    if (
      notification.expiresAtUtc !== null &&
      millis(input.nowUtc) >= millis(notification.expiresAtUtc)
    )
      return false;
    if (!Number.isFinite(clock.monotonicMs) || clock.monotonicMs < 0) return false;
    if (session && session.bootId === clock.bootId) {
      const elapsed = clock.monotonicMs - session.checkpointMonotonicMs;
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed < DAY_CONFIG.maxRolloverDeferralSeconds * 1000
      )
        return false;
    }
    const settings = notificationSettingsModel(input.settings);
    if (!settings[notification.channel].canSchedule) return false;
    if (input.settings.platform === 'android' && !input.native.calendarRearmCapable) return false;
    if (
      notification.slot === 'discretionary' &&
      (!input.native.expirationCapable ||
        notification.expiresAtUtc === null ||
        notification.trigger.kind !== 'absolute')
    )
      return false;
    if (
      notification.id !== `freelingo/${notification.localDay}/${notification.slot}` ||
      notification.channel !== (notification.slot === 'daily' ? 'daily' : 'streak')
    )
      return false;
    const course = input.courses.find((c) => c.courseId === notification.courseId);
    const template = NOTIFICATION_TEMPLATES.find((t) => t.id === notification.templateId);
    if (
      !course ||
      !template ||
      template.slot !== notification.slot ||
      template.family !== notification.family ||
      !eligible(template, course, input, input.localDay)
    )
      return false;
    if (notification.body !== template.body.replace('{course}', course.courseName)) return false;
    if (
      notification.slot === 'daily' &&
      (notification.trigger.kind !== 'calendar' ||
        notification.trigger.hour !== input.settings.hour ||
        notification.trigger.minute !== input.settings.minute)
    )
      return false;
    if (notification.slot === 'discretionary') {
      const expiry =
        template.family === 'revive' && input.day.recoveryUntilUtc !== null
          ? Math.min(millis(input.nextLocalMidnightUtc), millis(input.day.recoveryUntilUtc))
          : millis(input.nextLocalMidnightUtc);
      if (
        millis(notification.expiresAtUtc!) !== expiry ||
        millis(notification.atUtc) !== expiry - NOTIFICATION_CONFIG.dangerLeadMs
      )
        return false;
    }
    if (
      input.history.some(
        (h) =>
          h.id === notification.id ||
          (h.localDay === notification.localDay && h.slot === notification.slot),
      )
    )
      return false;
    return (
      new Set(input.history.filter((h) => h.localDay === input.localDay).map((h) => h.id)).size <
      NOTIFICATION_CONFIG.maximumPerDay
    );
  } catch {
    return false;
  }
}
