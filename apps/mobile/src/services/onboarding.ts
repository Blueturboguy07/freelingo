import type { GoalTierKey } from '@freelingo/core/economy';
import { packSurface } from '@freelingo/core/packs';
import type { NotificationSettingsSnapshot } from '@freelingo/core/notifications';
import { NOTIFICATION_PERMISSION_FOREGROUND_LIMIT } from '@freelingo/core/notifications';
import type { InstalledPackRepository, VerifiedInstalledPack } from '../packs/installedPackPorts';
import type {
  OnboardingCourse,
  OnboardingEvent,
  OnboardingState,
  RestorePresentation,
} from '../onboarding/ports';
import { AppDataError, type SqliteAppState, type OnboardingStep } from './SqliteAppState';

export interface OnboardingFlowPorts {
  readonly state: SqliteAppState;
  readonly nowUtc: () => string;
  readonly catalogue: {
    read(): readonly OnboardingCourse[];
    /** Resolve after starting/queuing the explicit request, not after the full download. */
    download(courseId: string): Promise<void>;
    pauseDownload(courseId: string): Promise<void>;
    playSample(courseId: string): Promise<void>;
  };
  /** Narrow read of the same verified repository. No second verification implementation. */
  readonly packs: Pick<InstalledPackRepository, 'refresh' | 'state'> & {
    get(courseId: string): Pick<VerifiedInstalledPack, 'contentHash'> | null;
  };
  readonly goal: { read(): GoalTierKey; choose(goal: GoalTierKey): Promise<void> };
  readonly notifications: {
    read(): Pick<
      NotificationSettingsSnapshot,
      'permission' | 'requestedPermission' | 'undeterminedForegrounds'
    >;
    /** Persist and initiate the prompt. OS callback completion is deliberately independent. */
    requestPermission(): void | Promise<void>;
    openSettings(): Promise<void>;
  };
  readonly restore: {
    read(): RestorePresentation;
    pick(): Promise<void>;
    confirm(): Promise<void>;
    cancel(): Promise<void>;
  };
  readonly placement: {
    active(): boolean;
    /** Actual reviewed pack population and durable runtime; may refuse missing content. */
    start(): Promise<void>;
  };
}
function unavailable(message: string): never {
  throw new AppDataError(message);
}
/** S001–S009 coordinates already-declared UI choices and real adapters. It never infers
 * a catalogue percentage, permission result, section placement, reward or installed pack. */
export function createOnboardingFlow(ports: OnboardingFlowPorts) {
  const store = ports.state;
  function catalogueCourse(id: string): OnboardingCourse {
    const rows = ports.catalogue.read().filter((course) => course.id === id);
    if (rows.length !== 1)
      return unavailable('The selected course is unavailable in the catalogue.');
    return rows[0]!;
  }
  function selectedId(): string {
    const id = store.read().selectedCourse?.courseId;
    if (!id) return unavailable('Select a course first.');
    catalogueCourse(id);
    return id;
  }
  async function verifiedSelection(): Promise<{ courseId: string; contentHash: string }> {
    const courseId = selectedId();
    await ports.packs.refresh([courseId]);
    if (store.read().selectedCourse?.courseId !== courseId)
      return unavailable('The course selection changed during verification.');
    const verified = ports.packs.get(courseId);
    if (!verified || !packSurface(ports.packs.state(courseId)).lessonsPlayable)
      return unavailable(
        'A verified playable course pack is required. Download or repair the course first.',
      );
    return { courseId, contentHash: verified.contentHash };
  }
  function read(): OnboardingState | null {
    const saved = store.read();
    if (saved.step === 'complete') return null;
    const courses = ports.catalogue.read();
    const course = courses.find((row) => row.id === saved.selectedCourse?.courseId);
    const picker: OnboardingState = {
      screen: 'courses',
      courses,
      selectedCourseId: course?.id ?? null,
    };
    if (saved.step === 'courses') return picker;
    if (saved.step === 'restore') return { screen: 'restore', restore: ports.restore.read() };
    if (!course) return picker;
    switch (saved.step) {
      case 'pack-detail':
        return { screen: 'pack-detail', course };
      case 'placement-choice':
        return {
          screen: 'placement-choice',
          languageName: course.languageName,
          choice: saved.selectedCourse!.placementChoice,
        };
      case 'self-report':
        return {
          screen: 'self-report',
          languageName: course.languageName,
          level: saved.selectedCourse!.selfReportLevel,
        };
      case 'placement-test':
        if (!ports.placement.active())
          return unavailable(
            'The saved placement session is unavailable. Return to the course picker to try again.',
          );
        return null;
      case 'placement-result': {
        const section = saved.selectedCourse!.placementSectionIndex;
        if (section === null) return unavailable('The placement result has not been recorded.');
        return { screen: 'placement-result', section: section + 1 };
      }
      case 'goal':
        return { screen: 'goal', selected: ports.goal.read() };
      case 'notifications': {
        const facts = ports.notifications.read();
        return {
          screen: 'notifications',
          permission:
            facts.permission === 'granted'
              ? 'granted'
              : facts.permission === 'denied'
                ? 'denied'
                : !facts.requestedPermission
                  ? 'never-asked'
                  : facts.undeterminedForegrounds >= NOTIFICATION_PERMISSION_FOREGROUND_LIMIT
                    ? 'blocked'
                    : 'requesting',
        };
      }
      case 'entering':
        return { screen: 'entering' };
    }
  }
  function requireStep(...allowed: readonly OnboardingStep[]): OnboardingStep {
    const step = store.read().step;
    if (!allowed.includes(step))
      return unavailable('This onboarding action is no longer available.');
    return step;
  }
  async function startPlacement(): Promise<void> {
    requireStep('self-report');
    if (store.read().selectedCourse?.selfReportLevel === null)
      return unavailable('Choose your current level first.');
    await verifiedSelection();
    if (!store.transition('self-report', 'placement-test')) return;
    try {
      await ports.placement.start();
    } catch (error) {
      store.transition('placement-test', 'self-report');
      throw error;
    }
  }
  async function continueFlow(): Promise<void> {
    const saved = store.read();
    switch (saved.step) {
      case 'courses':
      case 'pack-detail':
        await verifiedSelection();
        store.transition(saved.step, 'placement-choice');
        return;
      case 'placement-choice': {
        const choice = saved.selectedCourse?.placementChoice;
        if (!choice) return unavailable('Choose how you want to start first.');
        store.transition(saved.step, choice === 'scratch' ? 'goal' : 'self-report');
        return;
      }
      case 'self-report':
        await startPlacement();
        return;
      case 'placement-result':
        if (saved.selectedCourse?.placementSectionIndex == null)
          return unavailable('The placement result has not been recorded.');
        store.transition(saved.step, 'goal');
        return;
      case 'goal':
        store.transition(saved.step, 'notifications');
        return;
      case 'notifications':
        store.transition(saved.step, 'entering');
        return;
      case 'entering': {
        const verified = await verifiedSelection();
        if (store.read().step !== saved.step) return;
        store.completeOnboarding(verified.courseId, verified.contentHash, ports.nowUtc());
        return;
      }
      case 'restore':
        if (ports.restore.read().kind !== 'done')
          return unavailable('Finish or cancel the restore first.');
        store.transition(saved.step, 'courses');
        return;
      case 'complete':
        return;
      case 'placement-test':
        return unavailable('Finish or exit the active placement test first.');
    }
  }
  async function dispatch(event: OnboardingEvent): Promise<void> {
    // A queued callback from the dismissed onboarding surface must never restart it
    // or perform its old external action. Explicit account reset has another owner.
    if (store.read().step === 'complete') return;
    switch (event.type) {
      case 'selectCourse':
      case 'showPack':
        catalogueCourse(event.courseId);
        store.selectCourse(event.courseId, ports.nowUtc());
        if (event.type === 'showPack') store.transition(store.read().step, 'pack-detail');
        return;
      case 'download':
        catalogueCourse(event.courseId);
        await ports.catalogue.download(event.courseId);
        return;
      case 'pauseDownload':
        catalogueCourse(event.courseId);
        await ports.catalogue.pauseDownload(event.courseId);
        return;
      case 'playSample':
        catalogueCourse(event.courseId);
        await ports.catalogue.playSample(event.courseId);
        return;
      case 'restore':
        store.transition(store.read().step, 'restore');
        return;
      case 'pickRestore':
        requireStep('restore');
        await ports.restore.pick();
        return;
      case 'confirmRestore':
        requireStep('restore');
        await ports.restore.confirm();
        return;
      case 'cancelRestore':
        requireStep('restore');
        await ports.restore.cancel();
        store.transition('restore', 'courses');
        return;
      case 'choosePlacement':
        requireStep('placement-choice');
        store.choosePlacement(event.choice);
        return;
      case 'chooseLevel':
        requireStep('self-report');
        store.chooseLevel(event.level);
        return;
      case 'chooseGoal':
        requireStep('goal');
        await ports.goal.choose(event.goal);
        return;
      case 'requestNotifications':
        requireStep('notifications');
        await ports.notifications.requestPermission();
        return;
      case 'openNotificationSettings':
        requireStep('notifications');
        await ports.notifications.openSettings();
        return;
      case 'startPlacement':
        await startPlacement();
        return;
      case 'continue':
        await continueFlow();
        return;
      case 'back': {
        const step = store.read().step;
        if (step === 'restore') {
          await ports.restore.cancel();
          store.transition(step, 'courses');
          return;
        }
        const previous: Partial<Record<OnboardingStep, Exclude<OnboardingStep, 'complete'>>> = {
          'pack-detail': 'courses',
          'placement-choice': 'courses',
          'self-report': 'placement-choice',
          'placement-result': 'placement-choice',
          goal: 'placement-choice',
          notifications: 'goal',
          entering: 'notifications',
        };
        const target = previous[step];
        if (target) store.transition(step, target);
        return;
      }
    }
  }
  return { read, dispatch };
}
