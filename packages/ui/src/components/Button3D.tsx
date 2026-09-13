import { useId } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { BUTTON, FONT, SPACE, TYPE } from '../tokens/index.js';
import { useUiTheme } from './theme.js';
import { isCjkLanguage, languageProps } from './typography.js';
export interface Button3DProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
  readonly tone?: 'primary' | 'macaw' | 'danger' | 'neutral';
  readonly testID?: string;
  readonly compact?: boolean;
  readonly language?: string;
}
export function Button3D({
  label,
  onPress,
  disabled = false,
  accessibilityHint,
  tone = 'primary',
  testID,
  compact = false,
  language,
}: Button3DProps) {
  const { colors, highContrast } = useUiTheme();
  const cjk = isCjkLanguage(language);
  const hintId = useId();
  const hint = accessibilityHint ?? (disabled ? 'Complete the required action first' : undefined);
  const hintProps =
    Platform.OS === 'web' && hint !== undefined ? { 'aria-describedby': hintId } : {};
  const fill = disabled
    ? colors.swan
    : tone === 'primary'
      ? colors.owl
      : tone === 'macaw'
        ? colors.macaw
        : tone === 'danger'
          ? colors.cardinal
          : colors.polar;
  const lip = disabled
    ? colors.swan
    : tone === 'primary'
      ? colors.owlLip
      : tone === 'macaw'
        ? colors.macawLip
        : tone === 'danger'
          ? colors.cardinalLip
          : colors.swan;
  const ink = disabled
    ? highContrast
      ? colors.highContrastDisabled
      : colors.hare
    : tone === 'neutral'
      ? colors.eel
      : colors.onPrimary;
  return (
    <>
      <Pressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        {...hintProps}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        testID={testID}
        style={{
          minHeight: BUTTON.minHeightPx,
          alignSelf: compact ? 'flex-start' : 'stretch',
          borderRadius: BUTTON.radiusPx,
          backgroundColor: lip,
        }}
      >
        {({ pressed }) => (
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID={testID === undefined ? undefined : `${testID}-face`}
            style={{
              pointerEvents: 'none',
              backgroundColor: fill,
              borderRadius: BUTTON.radiusPx,
              minHeight: BUTTON.minHeightPx - (disabled ? 0 : BUTTON.lipHeightPx),
              marginBottom: disabled ? 0 : BUTTON.lipHeightPx,
              transform: [{ translateY: pressed && !disabled ? BUTTON.lipHeightPx : 0 }],
              paddingHorizontal: SPACE.md,
              paddingVertical: SPACE.sm,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              testID={testID === undefined ? undefined : `${testID}-label`}
              {...languageProps(language)}
              style={{
                color: ink,
                fontFamily: language?.startsWith('ja') ? FONT.japanese : FONT.strong,
                fontSize: TYPE.labelButton.fontSizePx,
                lineHeight: 18,
                letterSpacing: cjk ? 0 : TYPE.labelButton.letterSpacingPx,
                textAlign: 'center',
                flexShrink: 1,
              }}
            >
              {cjk ? label : label.toUpperCase()}
            </Text>
          </View>
        )}
      </Pressable>
      {Platform.OS === 'web' && hint !== undefined ? (
        <Text
          nativeID={hintId}
          accessible={false}
          style={{ position: 'absolute', height: 0, width: 0, overflow: 'hidden', opacity: 0 }}
        >
          {hint}
        </Text>
      ) : null}
    </>
  );
}
