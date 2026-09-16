import { Text, View } from 'react-native';
import {
  buildHub,
  nextHubChoice,
  wordRows,
  type HubInput,
  type HubItem,
  type WordSort,
} from '@freelingo/core/hub';
import { preferenceChange } from '@freelingo/core/course';
import type { LoopPorts } from './contracts';
import { Action, ErrorNotice, Label, Page, Panel, useLoopAction, useLoopUi } from './ui';

export function PracticeHubScreen({ input, ports }: { input: HubInput; ports: LoopPorts }) {
  const { tokens: LOOP_TOKENS, styles } = useLoopUi();
  const model = buildHub(input);
  const action = useLoopAction(input.courseId);
  const hero = model.hero;
  return (
    <Page
      title="Practice"
      footer={
        <>
          <ErrorNotice message={action.error} />
          {model.otherCourseMistakes.map((c) => (
            <Action
              key={c.courseId}
              label={`${c.courseLabel} · ${c.count} mistakes`}
              tone="neutral"
              disabled={action.pending}
              onPress={() => action.run(() => ports.switchCourse(c.courseId))}
            />
          ))}
        </>
      }
    >
      <View style={styles.row}>
        <Label>{model.courseLabel}</Label>
        <Label muted>YOUR DAILY PRACTICE</Label>
      </View>
      <Panel>
        {hero ? (
          <>
            <Text style={[styles.title, { color: LOOP_TOKENS.macaw }]}>{hero.title}</Text>
            <Label muted>
              {hero.kind === 'path'
                ? 'Keep making progress on your path.'
                : `${hero.itemIds.length} exercises · +${hero.advertisedXp} XP`}
            </Label>
            <Action
              label="START"
              disabled={action.pending}
              onPress={() => action.run(() => ports.launchHub(hero))}
            />
            <Action
              label="Switch session"
              tone="neutral"
              disabled={action.pending || !model.canSwitch}
              onPress={() => action.run(() => ports.saveHubDaily(nextHubChoice(model).daily))}
            />
          </>
        ) : (
          <>
            <Text style={styles.title}>
              {input.packReady
                ? 'A little progress goes a long way'
                : 'Practice Hub is currently unavailable'}
            </Text>
            <Label>Come back later to practice as you make more progress</Label>
            <Action label="GO TO PATH" tone="macaw" onPress={() => ports.navigate('path')} />
          </>
        )}
      </Panel>
      {model.modes
        .filter((m) => m.kind !== 'path' && m.kind !== 'today')
        .map((mode) => (
          <Panel key={mode.kind}>
            <View style={styles.row}>
              <Text style={styles.title}>{mode.title}</Text>
              <Label muted>
                {mode.kind === 'mistakes' ? model.mistakeBadge : String(mode.count)}
              </Label>
            </View>
            {mode.reason && <Label muted>{mode.reason}</Label>}
            {mode.offer && (
              <Action
                label={`Practice ${mode.title}`}
                tone="neutral"
                disabled={action.pending}
                onPress={() => action.run(() => ports.launchHub(mode.offer!))}
              />
            )}{' '}
            {mode.kind === 'words' && (
              <Action label="YOUR LIBRARY" tone="macaw" onPress={() => ports.navigate('words')} />
            )}{' '}
            {mode.kind === 'listen' && !input.preferences.listening && (
              <Action
                label="Turn on listening"
                tone="macaw"
                disabled={action.pending}
                onPress={() =>
                  action.run(() =>
                    ports.setPreference(input.courseId, preferenceChange('listening', true)),
                  )
                }
              />
            )}{' '}
            {mode.kind === 'speak' && !input.preferences.speaking && (
              <Action
                label="Turn on speaking"
                tone="macaw"
                disabled={action.pending}
                onPress={() =>
                  action.run(() =>
                    ports.setPreference(input.courseId, preferenceChange('speaking', true)),
                  )
                }
              />
            )}
          </Panel>
        ))}
    </Page>
  );
}
export function WordsScreen({
  courseId,
  items,
  sort,
  sorts,
  onSort,
  ports,
}: {
  courseId: string;
  items: readonly HubItem[];
  sort: WordSort;
  sorts: readonly WordSort[];
  onSort: (id: string) => void;
  ports: LoopPorts;
}) {
  const { styles } = useLoopUi();
  const action = useLoopAction(courseId);
  const rows = wordRows(items, sort);
  return (
    <Page title="Your library">
      <View style={styles.row}>
        {sorts.map((s) => (
          <Action
            key={s.id}
            label={s.label}
            tone={s.id === sort.id ? 'macaw' : 'neutral'}
            onPress={() => onSort(s.id)}
          />
        ))}
      </View>
      {rows.length === 0 && <Label>Your words will appear here as you learn.</Label>}
      {rows.map((row) => (
        <Panel key={row.itemId}>
          <Text style={styles.title}>{row.text}</Text>
          <Label>{row.gloss}</Label>
          <Label
            muted
          >{`Strength ${Math.round(Math.max(0, Math.min(1, row.retrievability)) * 4)} of 4 · Last seen ${row.lastSeenLocalDay}`}</Label>
          <Label>{row.example}</Label>
          <Action
            label={`Listen to ${row.text}`}
            tone="neutral"
            disabled={action.pending}
            onPress={() => action.run(() => ports.playWord(courseId, row.itemId, row.audioRef))}
          />
        </Panel>
      ))}
      <ErrorNotice message={action.error} />
    </Page>
  );
}
