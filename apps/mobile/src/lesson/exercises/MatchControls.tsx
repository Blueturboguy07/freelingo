import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { mulberry32 } from '@freelingo/core/session';
import { matchRuntime } from '@freelingo/core/session';
import type { SessionEvent } from '@freelingo/core/session';
import { BodyText, CARD, SPACE, useUiTheme } from '@freelingo/ui';
import type { ExerciseControlsProps } from './controls.js';
export function MatchControls({
  challenge,
  input,
  disabled,
  onInput,
  announce,
  seed,
  slotId,
  onEvent,
}: ExerciseControlsProps & {
  readonly seed: number;
  readonly slotId: string;
  readonly onEvent: (event: SessionEvent) => void;
}) {
  const { colors } = useUiTheme();
  const pairs = challenge.pairs ?? [];
  const rightColumn = useMemo(() => {
    const rows = [...pairs];
    const random = mulberry32(seed);
    for (let n = rows.length - 1; n > 0; n--) {
      const j = Math.floor(random() * (n + 1));
      [rows[n], rows[j]] = [rows[j]!, rows[n]!];
    }
    return rows;
  }, [pairs, seed]);
  const runtime = matchRuntime(input.partialState, pairs);
  if (runtime === null || pairs.length === 0)
    return (
      <BodyText>Matching data is unavailable. Return to the path to reload this lesson.</BodyText>
    );
  const selected = input.partialState['selectedPairLeft'];
  const last = runtime.taps.at(-1);
  return (
    <View style={{ gap: SPACE.sm }}>
      {pairs.map((pair, index) => {
        const right = rightColumn[index]!;
        const leftMatched = runtime.matchedLeftIds.includes(pair.leftId);
        const rightMatched = runtime.matchedLeftIds.includes(right.leftId);
        const style = {
          flex: 1,
          minWidth: 0,
          minHeight: 62,
          justifyContent: 'center' as const,
          padding: SPACE.sm,
          borderWidth: CARD.borderPx,
          borderBottomWidth: CARD.borderPx + CARD.lipHeightPx,
          borderRadius: CARD.radiusPx,
        };
        return (
          <View
            key={pair.leftId}
            testID={`match-row-${index}`}
            style={{ flexDirection: 'row', gap: SPACE.md }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pair.left}
              accessibilityState={{
                disabled: disabled || leftMatched,
                selected: selected === pair.leftId,
              }}
              disabled={disabled || leftMatched}
              onPress={() =>
                onInput(
                  input.text,
                  input.caret,
                  { ...input.partialState, selectedPairLeft: pair.leftId },
                  false,
                )
              }
              style={[
                style,
                {
                  borderColor: selected === pair.leftId ? colors.macaw : colors.swan,
                  backgroundColor: leftMatched ? colors.polar : colors.snow,
                },
              ]}
            >
              <BodyText language={challenge.language}>
                {leftMatched ? '✓ ' : ''}
                {pair.left}
              </BodyText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={right.right}
              accessibilityState={{ disabled: disabled || rightMatched }}
              disabled={disabled || rightMatched}
              onPress={() => {
                if (typeof selected !== 'string') {
                  announce('Choose a word in the first column first.');
                  return;
                }
                onEvent({
                  type: 'matchPair',
                  attemptId: `${slotId}:pair:${runtime.taps.length}`,
                  leftId: selected,
                  rightId: right.rightId,
                });
                announce(
                  pairs.find((p) => p.leftId === selected)?.rightId === right.rightId
                    ? 'Pair matched.'
                    : 'Those words do not match. Try again.',
                );
              }}
              style={[
                style,
                {
                  borderColor: colors.swan,
                  backgroundColor: rightMatched ? colors.polar : colors.snow,
                },
              ]}
            >
              <BodyText language={challenge.promptLanguage ?? 'en'}>
                {rightMatched ? '✓ ' : ''}
                {right.right}
              </BodyText>
            </Pressable>
          </View>
        );
      })}
      {last?.wrong ? <BodyText>Those words do not match. Try again.</BodyText> : null}
    </View>
  );
}
