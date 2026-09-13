import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import {
  BodyText,
  Button3D,
  Heading,
  LAYOUT,
  Panel,
  SPACE,
  UiProvider,
  useUiTheme,
} from '@freelingo/ui';
import type { SessionEvent } from '@freelingo/core/session';
import { LessonPlayer } from '../lesson';
import { OnboardingScreen } from '../onboarding';
import { PathScreen } from '../path';
import { CeremonyScreen, NotificationsScreen, PracticeHubScreen, SettingsScreen } from '../loop';
import type { LoopPorts, LoopRoute, SettingsRoute } from '../loop/contracts';
import { createAppController } from './controller';
import type { AppController, AppViewState } from './controller';
import type { AppLifecyclePort } from './lifecycle';
import type {
  AppRuntime,
  AppSnapshot,
  AppSurfaceRequest,
  AppTab,
  FreelingoServices,
} from './ports';

const INITIAL: AppViewState = {
  status: 'opening',
  route: 'path',
  snapshot: null,
  document: null,
  documentOrigin: null,
  error: null,
  busy: false,
};
const NO_SUBSCRIPTION = () => () => {};
const INITIAL_STATE = () => INITIAL;
/** deep08 §5, approved five tabs. Geometry uses shared spacing; icon parity is a separate visual gate. */
const TABS: readonly { readonly route: AppTab; readonly label: string }[] = [
  { route: 'path', label: 'Learn' },
  { route: 'practice', label: 'Practice' },
  { route: 'quests', label: 'Quests' },
  { route: 'shop', label: 'Shop' },
  { route: 'profile', label: 'Profile' },
];
export interface FreelingoAppProps {
  readonly services: FreelingoServices;
  readonly lifecycle?: AppLifecyclePort;
  readonly onDiagnostics?: (runtime: AppRuntime) => void;
}
/** One effect owns one retained runtime, including React's setup/cleanup replay. */
export function FreelingoApp({ services, lifecycle, onDiagnostics }: FreelingoAppProps) {
  const [controller, setController] = useState<AppController | null>(null);
  useEffect(() => {
    const next = createAppController(services);
    setController(next);
    void next.open().catch(() => {});
    return () => {
      void next.dispose().catch(() => {});
    };
  }, [services]);
  const state = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getState ?? INITIAL_STATE,
    INITIAL_STATE,
  );
  useEffect(() => {
    if (controller === null || lifecycle === undefined) return;
    const offState = lifecycle.subscribe((active) => {
      if (controller.getState().status !== 'ready') return;
      void (active ? controller.foreground() : controller.background()).catch(() => {});
    });
    const offBack = lifecycle.onBack(() => back(controller));
    return () => {
      offState();
      offBack();
    };
  }, [controller, lifecycle]);
  return (
    <UiProvider {...state.snapshot?.ui}>
      <Shell controller={controller} state={state} onDiagnostics={onDiagnostics} />
    </UiProvider>
  );
}
function ignore(promise: Promise<void>) {
  void promise.catch(() => {});
}
function back(controller: AppController): boolean {
  const current = controller.getState();
  if (current.status !== 'ready') return false;
  if (current.snapshot?.sessionOffer !== null && current.snapshot?.sessionOffer !== undefined) {
    ignore(controller.perform('offer:cancel', (r) => r.resolveSessionOffer('cancel')));
    return true;
  }
  if (current.route === 'lesson') {
    ignore(controller.dispatchLesson({ type: 'exit', route: 'hardwareBack' }));
    return true;
  }
  if (current.route === 'document') {
    controller.leaveDocument();
    return true;
  }
  if (current.route === 'ceremony') return true;
  if (current.route === 'onboarding') {
    ignore(controller.perform('onboarding:back', (r) => r.handleOnboarding({ type: 'back' })));
    return true;
  }
  if (current.route === 'path') return false;
  controller.navigate(
    ['preferences', 'notifications', 'goal', 'courses'].includes(current.route)
      ? 'settings'
      : 'path',
  );
  return true;
}
function Shell({
  controller,
  state,
  onDiagnostics,
}: {
  readonly controller: AppController | null;
  readonly state: AppViewState;
  readonly onDiagnostics: FreelingoAppProps['onDiagnostics'];
}) {
  const { colors } = useUiTheme();
  const runtime = controller?.runtime() ?? null;
  const snapshot = state.snapshot;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const event = useCallback(
    (value: SessionEvent) => {
      if (controller !== null) ignore(controller.dispatchLesson(value));
    },
    [controller],
  );
  const navigateLoop = useCallback(
    (route: LoopRoute) => {
      if (controller === null) return;
      if (route === 'about' || route === 'credits' || route === 'integrity') {
        ignore(controller.showDocument({ kind: 'route', route }));
      } else if (route === 'addCourse') {
        controller.showError(new Error('Adding a course is unavailable.'));
      } else controller.navigate(route);
    },
    [controller],
  );
  const loop = useMemo<LoopPorts | null>(() => {
    if (controller === null || runtime === null) return null;
    return {
      navigate: navigateLoop,
      launchHub: (offer) =>
        controller.perform('launch:hub', (r) => r.launchLesson({ kind: 'hub', offer })),
      saveHubDaily: (daily) => controller.perform('hub:daily', (r) => r.loop.saveHubDaily(daily)),
      switchCourse: (id) => controller.perform('course:switch', (r) => r.loop.switchCourse(id)),
      setPreference: (id, change) =>
        controller.perform(`preference:${change.key}`, (r) => r.loop.setPreference(id, change)),
      setAppearance: (appearance) =>
        controller.perform('appearance', (r) => r.loop.setAppearance(appearance)),
      setGoal: (goal) => controller.perform('goal', (r) => r.loop.setGoal(goal)),
      applyCourseAction: (plan) =>
        controller.perform('course:action', (r) => r.loop.applyCourseAction(plan)),
      advanceCeremony: (request) =>
        controller.perform('ceremony:advance', (r) => r.loop.advanceCeremony(request)),
      retryCommit: () => controller.perform('ceremony:retry', (r) => r.loop.retryCommit()),
      launchLegendary: (id) =>
        controller.perform('launch:legendary', (r) => r.loop.launchLegendary(id)),
      shareCard: (id) => controller.perform('share', (r) => r.loop.shareCard(id)),
      playWord: (course, item, audio) =>
        controller.perform('word:play', (r) => r.loop.playWord(course, item, audio), false),
    };
  }, [controller, runtime, navigateLoop]);
  const document = (request: AppSurfaceRequest) => {
    if (controller !== null) ignore(controller.showDocument(request));
  };
  let body;
  if (state.status === 'opening')
    body = (
      <Centered>
        <ActivityIndicator accessibilityLabel="Opening Freelingo" />
        <BodyText>Opening Freelingo…</BodyText>
      </Centered>
    );
  else if (state.status === 'failed')
    body = (
      <Centered>
        <Heading>Freelingo could not open</Heading>
        <BodyText>{state.error}</BodyText>
        <Button3D
          label="Try again"
          onPress={() => {
            if (controller !== null) ignore(controller.open());
          }}
        />
      </Centered>
    );
  else if (controller === null || runtime === null || snapshot === null || loop === null)
    body = (
      <Centered>
        <BodyText>Freelingo is closed.</BodyText>
      </Centered>
    );
  else if (state.route === 'onboarding' && snapshot.onboarding !== null)
    body = (
      <OnboardingScreen
        {...snapshot.ui}
        state={snapshot.onboarding}
        onEvent={(value) =>
          ignore(
            controller.perform(`onboarding:${JSON.stringify(value)}`, (r) =>
              value.type === 'startPlacement'
                ? r.launchLesson({ kind: 'placement' })
                : r.handleOnboarding(value),
            ),
          )
        }
      />
    );
  else if (state.route === 'lesson' && snapshot.lesson !== null)
    body = (
      <LessonPlayer
        {...snapshot.ui}
        {...snapshot.lesson}
        media={runtime.media}
        onEvent={event}
        onComplete={() =>
          ignore(controller.perform('lesson:complete', (r) => r.completeLesson(), true, true))
        }
        onReport={(item, reason) =>
          ignore(controller.perform('report', (r) => r.reportItem(item, reason)))
        }
        onSnooze={(item) => ignore(controller.perform('snooze', (r) => r.snoozeItem(item)))}
        onCredits={(itemId) => document({ kind: 'credits', itemId })}
        onExplain={(request) => document({ kind: 'explain', ...request })}
      />
    );
  else if (state.route === 'ceremony' && snapshot.ceremony !== null)
    body = <CeremonyScreen presentation={snapshot.ceremony} ports={loop} />;
  else if (state.route === 'path')
    body = (
      <PathScreen
        {...snapshot.ui}
        {...snapshot.path}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        onLaunch={(request) =>
          ignore(
            controller.perform('launch:path', (r) => r.launchLesson({ kind: 'path', request })),
          )
        }
        onOpenGuidebook={(unitIndex) => document({ kind: 'guidebook', unitIndex })}
        onOpenSections={() => document({ kind: 'sections' })}
        onRepairPack={() => ignore(controller.perform('pack:repair', (r) => r.repairPack()))}
      />
    );
  else if (state.route === 'practice' && snapshot.hub !== null)
    body = <PracticeHubScreen input={snapshot.hub} ports={loop} />;
  else if (
    ['settings', 'preferences', 'goal', 'courses'].includes(state.route) &&
    snapshot.settings !== null
  )
    body = (
      <SettingsScreen
        route={state.route as SettingsRoute}
        snapshot={snapshot.settings}
        ports={loop}
      />
    );
  else if (state.route === 'notifications' && snapshot.notifications !== null)
    body = (
      <NotificationsScreen
        snapshot={snapshot.notifications}
        ports={{
          save: (change) =>
            controller.perform('notification:save', (r) => r.notifications.save(change)),
          requestPermission: () =>
            controller.perform('notification:request', async (r) => {
              await r.notifications.requestPermission();
            }),
          openSettings: (channel) =>
            controller.perform(
              'notification:settings',
              (r) => r.notifications.openSettings(channel),
              false,
            ),
          openExactAlarmSettings: () =>
            controller.perform(
              'notification:exact',
              (r) => r.notifications.openExactAlarmSettings(),
              false,
            ),
          continueOnboarding: () =>
            ignore(
              controller.perform('onboarding:continue', (r) =>
                r.handleOnboarding({ type: 'continue' }),
              ),
            ),
          done: () => controller.navigate('settings'),
        }}
      />
    );
  else if (state.route === 'document' && state.document !== null)
    body = (
      <ScrollView contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}>
        <Heading>{state.document.title}</Heading>
        {state.document.paragraphs.map((text, i) => (
          <BodyText key={i}>{text}</BodyText>
        ))}
        {state.document.rows.map((row) => (
          <Panel key={row.id}>
            <Heading>{row.label}</Heading>
            <BodyText>{row.value}</BodyText>
          </Panel>
        ))}
      </ScrollView>
    );
  else
    body = (
      <Centered>
        <Heading>{state.route[0]!.toUpperCase() + state.route.slice(1)} is unavailable</Heading>
        <BodyText>Please try again after the course is ready.</BodyText>
        <Button3D label="Return to Learn" onPress={() => controller.navigate('path')} />
      </Centered>
    );
  const immersive =
    ['onboarding', 'lesson', 'ceremony'].includes(state.route) ||
    (state.route === 'document' &&
      ['onboarding', 'lesson', 'ceremony'].includes(state.documentOrigin ?? ''));
  return (
    <View style={{ flex: 1, backgroundColor: colors.snow }}>
      {(!immersive || state.route === 'document') && state.status === 'ready' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: SPACE.md,
          }}
        >
          <Pressable
            testID="app-title"
            onLongPress={
              runtime === null || onDiagnostics === undefined
                ? undefined
                : () => onDiagnostics(runtime)
            }
          >
            <Heading>Freelingo</Heading>
          </Pressable>
          {state.route !== 'path' && (
            <Button3D
              label="Back"
              compact
              tone="neutral"
              onPress={() => {
                if (controller !== null) back(controller);
              }}
            />
          )}
          {!immersive && (
            <Button3D
              label="Settings"
              compact
              tone="neutral"
              onPress={() => controller?.navigate('settings')}
            />
          )}
        </View>
      )}
      <View
        style={{ flex: 1, width: '100%', maxWidth: LAYOUT.contentMaxWidthPx, alignSelf: 'center' }}
      >
        {body}
      </View>
      {state.error !== null && state.status === 'ready' && (
        <View accessibilityRole="alert" style={{ padding: SPACE.md }}>
          <Panel>
            <BodyText>{state.error}</BodyText>
            <Button3D label="Dismiss" tone="neutral" onPress={() => controller?.clearError()} />
          </Panel>
        </View>
      )}
      {!immersive && state.status === 'ready' && (
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            borderTopWidth: 2,
            borderTopColor: colors.swan,
            padding: SPACE.sm,
          }}
        >
          {TABS.map((tab) => (
            <Pressable
              key={tab.route}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: state.route === tab.route }}
              aria-selected={state.route === tab.route}
              onPress={() => controller?.navigate(tab.route)}
              style={{ flex: 1, alignItems: 'center', paddingVertical: SPACE.sm }}
            >
              <BodyText>{tab.label}</BodyText>
            </Pressable>
          ))}
        </View>
      )}
      {snapshot?.sessionOffer !== null &&
        snapshot?.sessionOffer !== undefined &&
        controller !== null && (
          <SessionOfferSheet snapshot={snapshot} controller={controller} busy={state.busy} />
        )}
    </View>
  );
}
function Centered({ children }: { readonly children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: SPACE.md, gap: SPACE.md }}>
      {children}
    </View>
  );
}
function SessionOfferSheet({
  snapshot,
  controller,
  busy,
}: {
  readonly snapshot: AppSnapshot;
  readonly controller: AppController;
  readonly busy: boolean;
}) {
  const offer = snapshot.sessionOffer;
  if (offer === null) return null;
  const decide = (choice: Parameters<AppRuntime['resolveSessionOffer']>[0]) =>
    ignore(controller.perform('offer', (r) => r.resolveSessionOffer(choice)));
  return (
    <Modal transparent visible onRequestClose={() => decide('cancel')}>
      <Centered>
        <Panel>
          <Heading>
            {offer.kind === 'collision' ? 'You have a lesson in progress' : 'Resume your lesson?'}
          </Heading>
          <BodyText>{offer.lessonLabel}</BodyText>
          {offer.kind === 'collision' && (
            <BodyText>
              Exercise {offer.exerciseIndex + 1} of {offer.exerciseCount}
            </BodyText>
          )}
          <Button3D label="Resume" disabled={busy} onPress={() => decide('resume')} />
          <Button3D
            label={offer.kind === 'collision' ? 'End and start new' : 'Start over'}
            disabled={busy}
            tone="neutral"
            onPress={() => decide(offer.kind === 'collision' ? 'end-and-start-new' : 'start-over')}
          />
          <Button3D
            label="Cancel"
            disabled={busy}
            tone="neutral"
            onPress={() => decide('cancel')}
          />
        </Panel>
      </Centered>
    </Modal>
  );
}
