import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { GOAL_TIERS } from '@freelingo/core/economy';
import {
  BodyText,
  Button3D,
  CARD,
  Heading,
  LAYOUT,
  Panel,
  SPACE,
  UiProvider,
  useUiTheme,
} from '@freelingo/ui';
import type {
  OnboardingCourse,
  OnboardingEvent,
  OnboardingScreenProps,
  OnboardingState,
  SelfReportLevel,
} from './ports.js';

/** S001–S009 copy from product map/deep03; measured layout uses shared scope10 tokens.
 * Catalogue provenance/import/network facts are Freelingo's explicit departures. */
const PACK_COPY = {
  'not-downloaded': 'Not downloaded',
  partial: 'Audio download incomplete',
  installed: 'Ready to learn',
  corrupt: 'Needs repair',
  unverified: 'Could not verify this download',
  withdrawn: 'Course withdrawn',
} as const;
const LEVELS: readonly { key: SelfReportLevel; label: string }[] = [
  { key: 'new', label: "I'm brand new" },
  { key: 'words', label: 'I know some common words' },
  { key: 'basic', label: 'I can have basic conversations' },
  { key: 'topics', label: 'I can talk about various topics' },
  { key: 'detailed', label: 'I can discuss most topics in detail' },
];
const TITLES: Record<OnboardingState['screen'], string> = {
  courses: 'I want to learn…',
  'pack-detail': 'About this course',
  restore: 'Restoring from a Freelingo export?',
  'placement-choice': 'Find my level',
  'self-report': 'How much do you know?',
  'placement-result': 'Let’s start here!',
  goal: "What's your daily learning goal?",
  notifications: "I'll remind you to practice so it becomes a habit!",
  entering: 'Your learning path is ready',
};
const canStart = (course: OnboardingCourse | undefined) =>
  course?.packState === 'installed' || course?.packState === 'partial';
type Send = (event: OnboardingEvent) => void;
function Choice({
  label,
  detail,
  selected,
  onPress,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useUiTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      style={{
        borderColor: selected ? colors.macaw : colors.swan,
        borderWidth: CARD.borderPx,
        borderBottomWidth: CARD.borderPx + CARD.lipHeightPx,
        borderRadius: CARD.radiusPx,
        padding: SPACE.md,
        minHeight: LAYOUT.lessonHeaderHeightPx,
        gap: SPACE.xxs,
        justifyContent: 'center',
        backgroundColor: colors.polar,
      }}
    >
      <Heading level={2}>{label}</Heading>
      {detail && <BodyText>{detail}</BodyText>}
    </Pressable>
  );
}
function Provenance({ course }: { course: OnboardingCourse }) {
  return (
    <>
      <BodyText>
        {course.alignment === 'cefr'
          ? `${course.levelLabel} · CEFR-aligned`
          : 'Beginner · frequency-ordered'}
      </BodyText>
      <BodyText>
        {course.machineAuthoredPercent === null
          ? 'Authorship breakdown not yet available'
          : `${course.machineAuthoredPercent}% machine-authored`}
      </BodyText>
      <BodyText>
        {course.wrongItemPercent === null
          ? 'Wrong-item rate not yet measured'
          : `Measured wrong-item rate ${course.wrongItemPercent}%`}
      </BodyText>
      {course.nativeReview === 'provisional' ||
      (course.nativeReview !== 'paid' && course.wrongItemPercent !== null) ? (
        <BodyText>PROVISIONAL (unreviewed by a paid native speaker)</BodyText>
      ) : (
        <BodyText>
          {course.nativeReview === 'paid'
            ? 'Reviewed by a paid native speaker'
            : 'Native-speaker review pending'}
        </BodyText>
      )}
    </>
  );
}
function DownloadStatus({ course, onEvent }: { course: OnboardingCourse; onEvent: Send }) {
  const { download, packState } = course;
  let label: string | null = null;
  let status: ReactNode = null;
  if (packState === 'withdrawn')
    status = <BodyText>Your progress is kept. This course is read-only.</BodyText>;
  else if (download.kind === 'downloading') {
    const percent = Math.round(
      Math.max(0, Math.min(1, Number.isFinite(download.progress) ? download.progress : 0)) * 100,
    );
    status = (
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Course download"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
      >
        <BodyText>Downloading · {percent}%</BodyText>
      </View>
    );
    label = 'PAUSE DOWNLOAD';
  } else if (download.kind === 'insufficient-disk')
    status = (
      <BodyText>
        Not enough space. This download needs {download.requiredMb} MB; {download.availableMb} MB is
        available.
      </BodyText>
    );
  else if (download.kind === 'queued') {
    status = <BodyText>Waiting for a connection. Your download is queued.</BodyText>;
    label = 'RESUME DOWNLOAD';
  } else if (download.kind === 'paused') {
    status = <BodyText>Download paused</BodyText>;
    label = 'RESUME DOWNLOAD';
  } else if (download.kind === 'failed') {
    status = <BodyText>Download failed. {download.message}</BodyText>;
    label = 'TRY AGAIN';
  } else if (packState === 'unverified') label = 'DOWNLOAD AGAIN';
  else if (packState === 'corrupt') label = 'REPAIR DOWNLOAD';
  else if (packState === 'partial') label = 'RESUME DOWNLOAD';
  else if (packState === 'not-downloaded') label = `DOWNLOAD · ${course.sizeMb} MB`;
  return (
    <>
      {status}
      {label && (
        <Button3D
          label={label}
          tone="macaw"
          onPress={() =>
            onEvent({
              type: download.kind === 'downloading' ? 'pauseDownload' : 'download',
              courseId: course.id,
            })
          }
        />
      )}
    </>
  );
}
function CourseCard({
  course,
  selected,
  onEvent,
}: {
  course: OnboardingCourse;
  selected: boolean;
  onEvent: Send;
}) {
  return (
    <Panel style={{ flexGrow: 1, flexBasis: '45%', minWidth: 240 }}>
      <Choice
        label={`English → ${course.languageName}`}
        detail={course.beta ? 'BETA' : undefined}
        selected={selected}
        onPress={() => onEvent({ type: 'selectCourse', courseId: course.id })}
      />
      <Provenance course={course} />
      <BodyText>{PACK_COPY[course.packState]}</BodyText>
      <Button3D
        label={`About ${course.languageName}`}
        tone="neutral"
        onPress={() => onEvent({ type: 'showPack', courseId: course.id })}
      />
      <DownloadStatus course={course} onEvent={onEvent} />
    </Panel>
  );
}
function Restore({
  state,
  onEvent,
}: {
  state: Extract<OnboardingState, { screen: 'restore' }>;
  onEvent: Send;
}) {
  const value = state.restore;
  switch (value.kind) {
    case 'offered':
      return (
        <>
          <BodyText>Bring your progress back before starting a new lesson.</BodyText>
          <Button3D label="CHOOSE EXPORT FILE" onPress={() => onEvent({ type: 'pickRestore' })} />
          <Button3D
            label="START FRESH"
            tone="neutral"
            onPress={() => onEvent({ type: 'cancelRestore' })}
          />
        </>
      );
    case 'picking-file':
      return (
        <>
          <BodyText>Choose a Freelingo export from your files.</BodyText>
          <Button3D
            label="CANCEL"
            tone="neutral"
            onPress={() => onEvent({ type: 'cancelRestore' })}
          />
        </>
      );
    case 'validating':
      return <BodyText>Checking your export…</BodyText>;
    case 'version-mismatch':
      return (
        <>
          <BodyText>This export needs a newer version of Freelingo.</BodyText>
          <BodyText>{value.message}</BodyText>
          <Button3D
            label="CHOOSE ANOTHER FILE"
            tone="neutral"
            onPress={() => onEvent({ type: 'pickRestore' })}
          />
        </>
      );
    case 'failed':
      return (
        <>
          <BodyText>We couldn’t restore this export.</BodyText>
          <BodyText>{value.message}</BodyText>
          <Button3D label="CHOOSE ANOTHER FILE" onPress={() => onEvent({ type: 'pickRestore' })} />
        </>
      );
    case 'confirm-replace':
      return (
        <>
          <BodyText>This will replace everything on this device.</BodyText>
          <Panel>
            <BodyText>
              Last study day on this device: {value.currentLastDay ?? 'No completed lessons'}
            </BodyText>
            <BodyText>
              Last study day in the export: {value.importedLastDay ?? 'No completed lessons'}
            </BodyText>
            <BodyText>{value.sessionsSinceInstall} sessions completed since installation</BodyText>
          </Panel>
          <BodyText>
            A backup of your current progress will be kept for 24 hours so you can undo the restore.
          </BodyText>
          <Button3D
            label="REPLACE AND RESTORE"
            tone="danger"
            onPress={() => onEvent({ type: 'confirmRestore' })}
          />
          <Button3D
            label="KEEP CURRENT PROGRESS"
            tone="neutral"
            onPress={() => onEvent({ type: 'cancelRestore' })}
          />
        </>
      );
    case 'importing':
      return <BodyText>Restoring your progress…</BodyText>;
    case 'done':
      return (
        <>
          <BodyText>Your progress is restored.</BodyText>
          <Button3D label="CONTINUE" onPress={() => onEvent({ type: 'continue' })} />
        </>
      );
  }
}
function Body({ state, onEvent }: { state: OnboardingState; onEvent: Send }) {
  switch (state.screen) {
    case 'courses':
      return (
        <>
          <Button3D
            label="Import data"
            tone="neutral"
            accessibilityHint="Restore a Freelingo export before your first lesson"
            onPress={() => onEvent({ type: 'restore' })}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
            {state.courses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                selected={state.selectedCourseId === course.id}
                onEvent={onEvent}
              />
            ))}
          </View>
          {state.courses.length === 0 && (
            <BodyText>
              No course information is available yet. You can still restore an export.
            </BodyText>
          )}
        </>
      );
    case 'pack-detail':
      return (
        <>
          <Heading level={2}>English → {state.course.languageName}</Heading>
          <Provenance course={state.course} />
          <BodyText>{PACK_COPY[state.course.packState]}</BodyText>
          <BodyText>
            {state.course.itemCount} items · {state.course.sizeMb} MB
          </BodyText>
          <BodyText>{state.course.validatorSummary}</BodyText>
          {state.course.sample && (
            <Panel>
              <BodyText language={state.course.language}>{state.course.sample.text}</BodyText>
              <BodyText language="en">{state.course.sample.translation}</BodyText>
              <Button3D
                label={state.course.sample.playing ? 'STOP SAMPLE' : 'PLAY SAMPLE'}
                tone="neutral"
                onPress={() => onEvent({ type: 'playSample', courseId: state.course.id })}
              />
            </Panel>
          )}
          <DownloadStatus course={state.course} onEvent={onEvent} />
        </>
      );
    case 'restore':
      return <Restore state={state} onEvent={onEvent} />;
    case 'placement-choice':
      return (
        <>
          <BodyText>
            Let the parrot recommend where you should start learning {state.languageName}.
          </BodyText>
          <Choice
            label="Start from scratch"
            detail="Build your first words and phrases"
            selected={state.choice === 'scratch'}
            onPress={() => onEvent({ type: 'choosePlacement', choice: 'scratch' })}
          />
          <Choice
            label="Take a placement test"
            detail="Find the right starting point for you"
            selected={state.choice === 'test'}
            onPress={() => onEvent({ type: 'choosePlacement', choice: 'test' })}
          />
        </>
      );
    case 'self-report':
      return (
        <>
          <BodyText>Tell us about your {state.languageName}.</BodyText>
          {LEVELS.map((level) => (
            <Choice
              key={level.key}
              label={level.label}
              selected={state.level === level.key}
              onPress={() => onEvent({ type: 'chooseLevel', level: level.key })}
            />
          ))}
        </>
      );
    case 'placement-result':
      return (
        <BodyText>
          Section {state.section} looks like the right level! Let’s start there and we’ll adjust
          later if we need to.
        </BodyText>
      );
    case 'goal':
      return (
        <>
          {GOAL_TIERS.map((tier) => (
            <Choice
              key={tier.key}
              label={tier.key.charAt(0).toUpperCase() + tier.key.slice(1)}
              detail={`${tier.minutes} min / day`}
              selected={state.selected === tier.key}
              onPress={() => onEvent({ type: 'chooseGoal', goal: tier.key })}
            />
          ))}
        </>
      );
    case 'notifications':
      return (
        <>
          <BodyText>You can change reminders any time in Settings.</BodyText>
          {state.permission === 'never-asked' ? (
            <Button3D
              label="ALLOW NOTIFICATIONS"
              tone="macaw"
              onPress={() => onEvent({ type: 'requestNotifications' })}
            />
          ) : state.permission === 'requesting' ? (
            <BodyText>You can continue while your device asks for permission.</BodyText>
          ) : state.permission === 'granted' ? (
            <BodyText>Reminders are allowed.</BodyText>
          ) : (
            <>
              <BodyText>
                Notifications are off. You can enable them in your device settings.
              </BodyText>
              <Button3D
                label="OPEN SETTINGS"
                tone="neutral"
                onPress={() => onEvent({ type: 'openNotificationSettings' })}
              />
            </>
          )}
        </>
      );
    case 'entering':
      return <BodyText>Start with the highlighted lesson.</BodyText>;
  }
}
function Screen({
  state,
  onEvent,
  onDiagnostics,
}: Pick<OnboardingScreenProps, 'state' | 'onEvent' | 'onDiagnostics'>) {
  const { colors } = useUiTheme();
  const footer = state.screen !== 'restore';
  const disabled =
    state.screen === 'courses'
      ? !canStart(state.courses.find((course) => course.id === state.selectedCourseId))
      : state.screen === 'pack-detail'
        ? !canStart(state.course)
        : state.screen === 'placement-choice'
          ? state.choice === null
          : state.screen === 'self-report'
            ? state.level === null
            : false;
  const label =
    state.screen === 'placement-result'
      ? `JUMP TO SECTION ${state.section}`
      : state.screen === 'entering'
        ? 'START LEARNING'
        : 'CONTINUE';
  const busy =
    state.screen === 'restore' &&
    (state.restore.kind === 'validating' || state.restore.kind === 'importing');
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.snow, direction: 'ltr' }}
      testID={`onboarding-${state.screen}`}
    >
      <View
        style={{
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidthPx,
          alignSelf: 'center',
          padding: SPACE.md,
          gap: SPACE.sm,
        }}
      >
        {state.screen !== 'courses' && (
          <Button3D
            label="BACK"
            compact
            tone="neutral"
            disabled={busy}
            onPress={() => onEvent({ type: 'back' })}
          />
        )}
        <Pressable testID="app-title" onLongPress={onDiagnostics}>
          <Heading style={{ color: colors.owl }}>freelingo</Heading>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidthPx,
          alignSelf: 'center',
          padding: SPACE.md,
          gap: SPACE.lg,
          paddingBottom: SPACE.xl,
        }}
      >
        <Heading>{TITLES[state.screen]}</Heading>
        <Body state={state} onEvent={onEvent} />
      </ScrollView>
      {footer && (
        <View
          style={{ borderTopWidth: CARD.borderPx, borderTopColor: colors.swan, padding: SPACE.md }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: LAYOUT.contentMaxWidthPx - 2 * SPACE.md,
              alignSelf: 'center',
            }}
          >
            <Button3D
              label={label}
              disabled={disabled}
              onPress={() =>
                onEvent({
                  type:
                    state.screen === 'placement-choice' && state.choice === 'test'
                      ? 'startPlacement'
                      : 'continue',
                })
              }
            />
          </View>
        </View>
      )}
    </View>
  );
}
export function OnboardingScreen({
  state,
  onEvent,
  onDiagnostics,
  ...preferences
}: OnboardingScreenProps) {
  return (
    <UiProvider {...preferences}>
      <Screen state={state} onEvent={onEvent} onDiagnostics={onDiagnostics} />
    </UiProvider>
  );
}
