import { useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import type {
  NarrativeAnswer,
  Span,
  StoryChallenge,
  StoryMode,
  StoryText,
} from '@freelingo/core/stories';
import { STORY_COPY, STORY_MATCH_RENDER_CAP, storyHints, storyRuby } from '@freelingo/core/stories';
import { styles } from './style';
export function MediaButton({
  label,
  onPress,
  disabled = false,
  secondary = false,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}
    >
      <Text
        style={[styles.buttonText, secondary && styles.secondaryText, disabled && styles.muted]}
      >
        {children ?? label}
      </Text>
    </Pressable>
  );
}
export function useForeground(override?: boolean): boolean {
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const listener = AppState.addEventListener('change', (value) =>
      setForeground(value === 'active'),
    );
    return () => listener.remove();
  }, []);
  return override ?? foreground;
}
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    >
      <View style={[styles.fill, { width: `${Math.max(0, Math.min(1, value)) * 100}%` }]} />
    </View>
  );
}
export function NarrativeText({
  content,
  mode,
  hidden = [],
  rubyEnabled = true,
  highlight = null,
  selectable = [],
  onSelect,
  onHint,
}: {
  content: StoryText;
  mode: StoryMode;
  hidden?: readonly Span[];
  rubyEnabled?: boolean;
  highlight?: Span | null;
  selectable?: readonly (Span & { readonly id: string })[];
  onSelect?: (id: string) => void;
  onHint: (gloss: string) => void;
}) {
  const hints = storyHints(content, mode, hidden);
  const ruby = storyRuby(content, hidden, rubyEnabled);
  const boundaries = [
    ...new Set([
      0,
      content.text.length,
      ...content.hints.flatMap((span) => [span.start, span.end]),
      ...hidden.flatMap((span) => [span.start, span.end]),
      ...ruby.flatMap((span) => [span.start, span.end]),
      ...selectable.flatMap((span) => [span.start, span.end]),
      ...(highlight ? [highlight.start, highlight.end] : []),
    ]),
  ].sort((a, b) => a - b);
  return (
    <Text style={styles.text}>
      {boundaries.slice(0, -1).map((start, i) => {
        const end = boundaries[i + 1]!;
        const concealed = hidden.some((span) => start < span.end && span.start < end);
        const hint = hints.find((span) => span.start <= start && span.end >= end);
        const reading = ruby.find((span) => span.start === start && span.end === end);
        const lit = highlight && start < highlight.end && highlight.start < end;
        const choice = selectable.find((span) => span.start <= start && span.end >= end);
        return (
          <Text
            key={start}
            accessibilityRole={choice ? 'button' : undefined}
            accessibilityLabel={choice ? content.text.slice(start, end) : undefined}
            onPress={
              choice ? () => onSelect?.(choice.id) : hint ? () => onHint(hint.gloss) : undefined
            }
            style={[hint && styles.hint, lit && styles.highlight]}
          >
            {concealed
              ? '____'
              : reading
                ? `${content.text.slice(start, end)}（${reading.reading}）`
                : content.text.slice(start, end)}
          </Text>
        );
      })}
    </Text>
  );
}
export function ChallengeCard({
  question,
  answered,
  onAnswer,
}: {
  question: StoryChallenge;
  answered: boolean;
  onAnswer: (answer: NarrativeAnswer) => void;
}) {
  const [tileIds, setTileIds] = useState<readonly string[]>([]);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [pairs, setPairs] = useState<readonly { leftId: string; rightId: string }[]>([]);
  if (question.type === 'MATCH') {
    const shown = question.pairs.slice(0, STORY_MATCH_RENDER_CAP);
    return (
      <View style={styles.card}>
        <Text style={styles.text}>{STORY_COPY.match}</Text>
        <View style={styles.row}>
          {shown.map((pair) => (
            <MediaButton
              key={pair.id}
              label={`Match ${pair.left}`}
              secondary
              disabled={answered || pairs.some((p) => p.leftId === pair.id)}
              onPress={() => setLeftId(pair.id)}
            />
          ))}
        </View>
        <View style={styles.row}>
          {shown.toReversed().map((pair) => (
            <MediaButton
              key={pair.id}
              label={`With ${pair.right}`}
              secondary
              disabled={answered || leftId === null || pairs.some((p) => p.rightId === pair.id)}
              onPress={() => {
                if (leftId) setPairs([...pairs, { leftId, rightId: pair.id }]);
                setLeftId(null);
              }}
            />
          ))}
        </View>
        <MediaButton
          label="Check matches"
          disabled={answered || pairs.length !== shown.length}
          onPress={() => onAnswer({ kind: 'matches', pairs })}
        />
      </View>
    );
  }
  if (question.type === 'ARRANGE')
    return (
      <View style={styles.card}>
        <Text style={styles.text}>{question.prompt}</Text>
        <View style={styles.row}>
          {tileIds.map((id, index) => (
            <MediaButton
              key={id}
              label={`Remove ${question.tiles.find((tile) => tile.id === id)?.text ?? ''}`}
              secondary
              disabled={answered}
              onPress={() => setTileIds(tileIds.filter((_, i) => i !== index))}
            >
              {question.tiles.find((tile) => tile.id === id)?.text}
            </MediaButton>
          ))}
        </View>
        <View style={styles.row}>
          {question.tiles.map((tile) => (
            <MediaButton
              key={tile.id}
              label={tile.text}
              secondary
              disabled={answered || tileIds.includes(tile.id)}
              onPress={() => setTileIds([...tileIds, tile.id])}
            />
          ))}
        </View>
        <MediaButton
          label="Check answer"
          disabled={answered || tileIds.length === 0}
          onPress={() => onAnswer({ kind: 'tiles', tileIds })}
        />
      </View>
    );
  if (question.type === 'POINT_TO_PHRASE')
    return (
      <View style={styles.card}>
        <Text style={styles.text}>{question.prompt}</Text>
      </View>
    );
  return (
    <View style={styles.card}>
      <Text style={styles.text}>{question.prompt}</Text>
      {question.options.map((option) => (
        <MediaButton
          key={option.id}
          label={option.text}
          secondary
          disabled={answered}
          onPress={() => onAnswer({ kind: 'option', optionId: option.id })}
        />
      ))}
    </View>
  );
}
