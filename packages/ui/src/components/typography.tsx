import type { ReactNode } from 'react';
import { Platform, Text } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { FONT, TYPE } from '../tokens/index.js';
import { useUiTheme } from './theme.js';
/** Native language tags and the RN Web lang extension share the pack's BCP-47 value. */
export function languageProps(language?: string): {
  accessibilityLanguage?: string;
  lang?: string;
} {
  return language === undefined
    ? {}
    : { accessibilityLanguage: language, ...(Platform.OS === 'web' ? { lang: language } : {}) };
}
export function isCjkLanguage(language?: string): boolean {
  return /^(ja|zh|ko)(-|$)/i.test(language ?? '');
}
export interface TextProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<TextStyle>;
  readonly language?: string;
  readonly testID?: string;
}
export function BodyText({ children, style, language, testID }: TextProps) {
  const { colors, boldText } = useUiTheme();
  return (
    <Text
      {...languageProps(language)}
      testID={testID}
      style={[
        {
          color: colors.eel,
          fontFamily: language?.startsWith('ja')
            ? FONT.japanese
            : boldText
              ? FONT.strong
              : FONT.body,
          fontSize: TYPE.body.fontSizePx,
          lineHeight: TYPE.body.lineHeightPx,
          flexShrink: 1,
          letterSpacing: 0,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Heading({
  children,
  style,
  language,
  testID,
  level = 1,
}: TextProps & { readonly level?: 1 | 2 }) {
  const { colors } = useUiTheme();
  const role = level === 1 ? TYPE.heading : TYPE.subheading;
  return (
    <Text
      accessibilityRole="header"
      {...languageProps(language)}
      testID={testID}
      style={[
        {
          color: colors.eel,
          fontFamily: language?.startsWith('ja') ? FONT.japanese : FONT.heading,
          fontSize: role.fontSizePx,
          lineHeight: role.lineHeightPx,
          flexShrink: 1,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
