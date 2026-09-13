import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import {
  courseActionPlan,
  preferenceChange,
  type CourseAction,
  type PreferenceKey,
} from '@freelingo/core/course';
import { GOAL_TIERS } from '@freelingo/core/economy';
import type { LoopPorts, LoopRoute, SettingsRoute, SettingsSnapshot } from './contracts';
import { Action, ErrorNotice, Label, Page, Panel, useLoopAction, useLoopUi } from './ui';
const PREFERENCES: readonly { key: PreferenceKey; label: string }[] = [
  { key: 'soundEffects', label: 'Sound effects' },
  { key: 'animations', label: 'Animations' },
  { key: 'motivationalMessages', label: 'Motivational messages' },
  { key: 'listening', label: 'Listening exercises' },
  { key: 'speaking', label: 'Speaking exercises' },
];
const GROUPS: readonly { title: string; rows: readonly { label: string; route: LoopRoute }[] }[] = [
  {
    title: 'Account',
    rows: [
      { label: 'Preferences', route: 'preferences' },
      { label: 'Notifications', route: 'notifications' },
      { label: 'Daily goal', route: 'goal' },
    ],
  },
  { title: 'Courses', rows: [{ label: 'Manage courses', route: 'courses' }] },
  {
    title: 'Data',
    rows: [
      { label: 'Export · Import · Delete all data', route: 'data' },
      { label: 'Reported items', route: 'reports' },
    ],
  },
  {
    title: 'About',
    rows: [
      { label: 'About Freelingo', route: 'about' },
      { label: 'Content credits', route: 'credits' },
    ],
  },
];
export function SettingsScreen({
  route = 'settings',
  snapshot,
  ports,
}: {
  route?: SettingsRoute;
  snapshot: SettingsSnapshot;
  ports: LoopPorts;
}) {
  const { styles } = useLoopUi();
  const action = useLoopAction(snapshot.courseId + '/' + route);
  const [confirm, setConfirm] = useState<{
    courseId: string;
    name: string;
    action: CourseAction;
  } | null>(null);
  const plan = (courseId: string, type: CourseAction) =>
    courseActionPlan({
      courseId,
      action: type,
      activeCourseId: snapshot.courseId,
      installedCourseIds: snapshot.courses.map((c) => c.courseId),
      importedAtUtc: snapshot.importedAtUtc,
      nowUtc: snapshot.nowUtc,
    });
  return (
    <Page
      title={
        route === 'preferences'
          ? 'Preferences'
          : route === 'goal'
            ? 'Learning Goal'
            : route === 'courses'
              ? 'Manage courses'
              : 'Settings'
      }
    >
      {route === 'settings' &&
        GROUPS.map((g) => (
          <Panel key={g.title}>
            <Text style={styles.title}>{g.title}</Text>
            {g.rows.map((r) => (
              <Action
                key={r.route}
                label={r.label}
                tone="neutral"
                onPress={() => ports.navigate(r.route)}
              />
            ))}
          </Panel>
        ))}
      {route === 'preferences' && (
        <>
          <Panel>
            <Text style={styles.title}>Lesson experience</Text>
            {PREFERENCES.map((pref) => (
              <View key={pref.key}>
                <View style={styles.row}>
                  <Label>{pref.label}</Label>
                  <Switch
                    accessibilityLabel={pref.label}
                    value={snapshot.preferences[pref.key]}
                    disabled={action.pending}
                    onValueChange={(value) =>
                      action.run(() =>
                        ports.setPreference(snapshot.courseId, preferenceChange(pref.key, value)),
                      )
                    }
                  />
                </View>
                {(pref.key === 'listening' || pref.key === 'speaking') &&
                  snapshot.suspensions[pref.key] && (
                    <>
                      <Label muted>{`Paused until ${snapshot.suspensions[pref.key]}`}</Label>
                      <Action
                        label={`RESUME ${pref.key.toUpperCase()} NOW`}
                        tone="macaw"
                        disabled={action.pending}
                        onPress={() =>
                          action.run(() =>
                            ports.setPreference(
                              snapshot.courseId,
                              preferenceChange(pref.key, true),
                            ),
                          )
                        }
                      />
                    </>
                  )}
              </View>
            ))}
          </Panel>
          <Panel>
            <Text style={styles.title}>Dark mode</Text>
            {(['dark', 'light', 'system'] as const).map((value) => (
              <Action
                key={value}
                label={value === 'dark' ? 'On' : value === 'light' ? 'Off' : 'System Default'}
                tone={snapshot.appearance === value ? 'macaw' : 'neutral'}
                disabled={action.pending}
                onPress={() => action.run(() => ports.setAppearance(value))}
              />
            ))}
          </Panel>
        </>
      )}
      {route === 'goal' && (
        <>
          <Label>What's your daily learning goal?</Label>
          {GOAL_TIERS.map((tier) => (
            <Action
              key={tier.key}
              label={`${tier.key[0]!.toUpperCase() + tier.key.slice(1)} · ${tier.minutes} min/day`}
              tone={snapshot.goalTier === tier.key ? 'macaw' : 'neutral'}
              disabled={action.pending}
              onPress={() => action.run(() => ports.setGoal(tier.key))}
            />
          ))}
        </>
      )}
      {route === 'courses' && (
        <>
          {snapshot.courses.map((c) => (
            <Panel key={c.courseId}>
              <Text style={styles.title}>{c.name}</Text>
              <Label>{c.courseId === snapshot.courseId ? 'Current' : c.progressLabel}</Label>
              <Label muted>
                {c.progressLabel} ·{' '}
                {c.audioBytes === null
                  ? 'Audio size unavailable'
                  : `${Math.round(c.audioBytes / 1024 / 1024)} MB audio`}
              </Label>
              {c.courseId !== snapshot.courseId && (
                <Action
                  label={`Set ${c.name} as active`}
                  disabled={action.pending}
                  onPress={() => action.run(() => ports.switchCourse(c.courseId))}
                />
              )}
              <Action
                label={`Remove downloaded ${c.name} audio`}
                tone="neutral"
                disabled={action.pending}
                onPress={() =>
                  action.run(() => ports.applyCourseAction(plan(c.courseId, 'removeAudio')))
                }
              />
              {(['reset', 'remove'] as const).map((type) => (
                <Action
                  key={type}
                  label={`${type === 'reset' ? 'Reset' : 'Remove'} ${c.name}`}
                  tone="danger"
                  disabled={action.pending || !plan(c.courseId, type).allowed}
                  hint={plan(c.courseId, type).reason ?? undefined}
                  onPress={() => setConfirm({ courseId: c.courseId, name: c.name, action: type })}
                />
              ))}
              {plan(c.courseId, 'remove').reason && (
                <Label muted>{plan(c.courseId, 'remove').reason}</Label>
              )}
            </Panel>
          ))}
          <Action
            label="ADD A NEW COURSE"
            tone="macaw"
            onPress={() => ports.navigate('addCourse')}
          />
        </>
      )}
      {confirm && (
        <Panel>
          <Text accessibilityRole="header" style={styles.title}>
            {confirm.action === 'reset' ? 'Reset' : 'Remove'} {confirm.name}?
          </Text>
          <Label>
            {confirm.action === 'reset'
              ? 'Resetting this course removes its progress and in-flight lesson. Your downloaded course stays installed.'
              : "Be careful, removing a language gets rid of all your progress and can't be undone."}
          </Label>
          <Label>Your streak, gems and other courses are not affected.</Label>
          <Action label="CANCEL" tone="neutral" onPress={() => setConfirm(null)} />
          <Action
            label={confirm.action === 'reset' ? 'RESET PROGRESS' : 'REMOVE COURSE'}
            tone="danger"
            disabled={action.pending || !plan(confirm.courseId, confirm.action).allowed}
            onPress={() =>
              action.run(async () => {
                await ports.applyCourseAction(plan(confirm.courseId, confirm.action));
                setConfirm(null);
              })
            }
          />
        </Panel>
      )}
      <ErrorNotice message={action.error} />
      <Action
        label="DONE"
        tone="neutral"
        onPress={() => ports.navigate(route === 'settings' ? 'profile' : 'settings')}
      />
    </Page>
  );
}
