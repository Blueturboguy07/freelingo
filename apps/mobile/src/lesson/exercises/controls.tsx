import { useEffect, useRef } from 'react';
import { Image, Platform, Pressable, TextInput, View } from 'react-native';
import type { InFlightInput } from '@freelingo/core/session';
import type { LessonChallenge } from '@freelingo/core/presentation';
import {
  readSelectedTileIds,
  selectedBankText,
  toggleBankTile,
  insertAtSelection,
} from '@freelingo/core/presentation';
import { BodyText, CARD, FONT, SPACE, useUiTheme, languageProps } from '@freelingo/ui';
export interface ExerciseControlsProps {
  readonly challenge: LessonChallenge;
  readonly input: InFlightInput;
  readonly disabled: boolean;
  readonly onInput: (
    text: string,
    caret: number,
    partial: Readonly<Record<string, unknown>>,
    gradeable: boolean,
  ) => void;
  readonly onComposition: (active: boolean) => void;
  readonly onSubmit: () => void;
  readonly announce: (text: string) => void;
}
export function ChoiceControls({
  challenge,
  input,
  disabled,
  onInput,
  announce,
}: ExerciseControlsProps) {
  const { colors } = useUiTheme();
  const picture = challenge.type === 'pictureSelect';
  return (
    <View
      style={{
        flexDirection: picture ? 'row' : 'column',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: SPACE.sm,
      }}
    >
      {challenge.options?.map((option) => {
        const selected = input.partialState['selectedOptionId'] === option.id;
        return (
          <Pressable
            key={option.id}
            testID={`option-${option.id}`}
            accessibilityRole="button"
            accessibilityLabel={option.text}
            accessibilityState={{ selected, disabled }}
            aria-pressed={selected}
            disabled={disabled}
            onPress={() => {
              onInput(
                option.text,
                option.text.length,
                { ...input.partialState, selectedOptionId: option.id },
                true,
              );
              announce(option.text);
            }}
            style={{
              borderWidth: CARD.borderPx,
              borderBottomWidth: CARD.borderPx + CARD.lipHeightPx,
              borderRadius: CARD.radiusPx,
              borderColor: selected ? colors.macaw : colors.swan,
              backgroundColor: selected ? colors.polar : colors.snow,
              padding: SPACE.md,
              minHeight: picture ? 180 : 58,
              width: picture ? '47%' : '100%',
              alignItems: picture ? 'center' : 'flex-start',
              justifyContent: 'center',
              gap: SPACE.sm,
            }}
          >
            {picture && option.imageUri !== undefined ? (
              <Image
                source={{ uri: option.imageUri }}
                accessibilityLabel={option.imageDescription ?? option.text}
                style={{ width: 100, height: 100 }}
                resizeMode="contain"
              />
            ) : null}
            <BodyText language={challenge.language}>{option.text}</BodyText>
            {selected ? (
              <BodyText style={{ color: colors.macaw, fontSize: 15 }}>Selected ✓</BodyText>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
export function BankControls({ challenge, input, disabled, onInput }: ExerciseControlsProps) {
  const { colors } = useUiTheme();
  const bank = challenge.bank ?? [];
  const selected = readSelectedTileIds(input.partialState, bank);
  const toggle = (id: string) => {
    const next = toggleBankTile(selected, id, bank);
    const text = selectedBankText(next, bank);
    onInput(text, text.length, { ...input.partialState, selectedTileIds: next }, next.length > 0);
  };
  const tileStyle = {
    borderWidth: CARD.borderPx,
    borderBottomWidth: CARD.borderPx + CARD.lipHeightPx,
    borderRadius: CARD.radiusPx,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
    minHeight: 48,
  };
  return (
    <View style={{ gap: SPACE.xxl }}>
      <View
        testID="submitted-answer"
        accessibilityLabel={`Your answer: ${input.text || 'empty'}`}
        style={{
          minHeight: 104,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignContent: 'flex-start',
          gap: SPACE.xs,
          borderBottomWidth: CARD.borderPx,
          borderColor: colors.swan,
          paddingVertical: SPACE.xs,
        }}
      >
        {selected.map((id) => (
          <Pressable
            key={id}
            testID={`answer-${id}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${bank.find((tile) => tile.id === id)?.text ?? ''}`}
            disabled={disabled}
            onPress={() => toggle(id)}
            style={[tileStyle, { borderColor: colors.swan }]}
          >
            <BodyText language={challenge.language}>
              {bank.find((tile) => tile.id === id)?.text}
            </BodyText>
          </Pressable>
        ))}
      </View>
      <View
        testID="word-bank"
        style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACE.xs }}
      >
        {bank.map((tile) => {
          const consumed = selected.includes(tile.id);
          return (
            <Pressable
              key={tile.id}
              testID={`bank-${tile.id}`}
              accessibilityRole="button"
              accessibilityLabel={tile.text}
              accessibilityElementsHidden={consumed}
              importantForAccessibility={consumed ? 'no-hide-descendants' : 'auto'}
              aria-hidden={consumed}
              disabled={disabled || consumed}
              onPress={() => toggle(tile.id)}
              style={[
                tileStyle,
                { borderColor: colors.swan, backgroundColor: consumed ? colors.swan : colors.snow },
              ]}
            >
              <BodyText language={challenge.language} style={{ opacity: consumed ? 0 : 1 }}>
                {tile.text}
              </BodyText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
export function TypedControls({
  challenge,
  input,
  disabled,
  onInput,
  onComposition,
  onSubmit,
}: ExerciseControlsProps) {
  const { colors } = useUiTheme();
  const field = useRef<TextInput>(null);
  const selection = useRef({ start: input.caret, end: input.caret });
  const composing = useRef(false);
  const callbacks = useRef({ onComposition, onSubmit });
  callbacks.current = { onComposition, onSubmit };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = field.current as unknown as HTMLElement | null;
    if (element === null) return;
    const start = () => {
      composing.current = true;
      callbacks.current.onComposition(true);
    };
    const end = () => {
      composing.current = false;
      callbacks.current.onComposition(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current) {
        event.stopPropagation();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) callbacks.current.onSubmit();
      }
    };
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    element.addEventListener('keydown', key);
    return () => {
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
      element.removeEventListener('keydown', key);
    };
  }, []);
  return (
    <View style={{ gap: SPACE.sm }}>
      <TextInput
        ref={field}
        testID="typed-answer"
        accessibilityLabel="Your answer"
        {...languageProps(challenge.language)}
        editable={!disabled}
        multiline
        value={input.text}
        placeholder="Type your answer"
        placeholderTextColor={colors.hare}
        onChangeText={(text) => {
          const caret = Math.min(
            text.length,
            selection.current.start + Math.max(0, text.length - input.text.length),
          );
          onInput(text, caret, input.partialState, text.trim().length > 0);
        }}
        onSelectionChange={(event) => {
          selection.current = event.nativeEvent.selection;
        }}
        onSubmitEditing={() => {
          if (!composing.current) onSubmit();
        }}
        style={{
          color: colors.eel,
          backgroundColor: colors.polar,
          borderColor: colors.swan,
          borderWidth: CARD.borderPx,
          borderRadius: CARD.radiusPx,
          minHeight: 150,
          padding: SPACE.md,
          fontFamily: challenge.language.startsWith('ja') ? FONT.japanese : FONT.body,
          fontSize: 20,
          lineHeight: 30,
          textAlignVertical: 'top',
        }}
      />
      {(challenge.accentCharacters?.length ?? 0) > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
          {challenge.accentCharacters?.map((character) => (
            <Pressable
              key={character}
              accessibilityRole="button"
              accessibilityLabel={`Insert ${character}`}
              disabled={disabled}
              onPress={() => {
                if (composing.current) return;
                const value = insertAtSelection(input.text, character, selection.current);
                selection.current = { start: value.caret, end: value.caret };
                onInput(value.text, value.caret, input.partialState, true);
                field.current?.focus();
              }}
              style={{
                padding: SPACE.sm,
                borderWidth: CARD.borderPx,
                borderColor: colors.swan,
                borderRadius: CARD.radiusPx,
              }}
            >
              <BodyText language={challenge.language}>{character}</BodyText>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
