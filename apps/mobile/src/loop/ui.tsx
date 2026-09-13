/** P4 layout and persistence guard over the shared P3 atoms. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  BodyText,
  Button3D,
  Heading,
  Panel,
  BUTTON,
  CARD,
  FONT,
  LAYOUT,
  SPACE,
  TYPE,
  useUiTheme,
} from '@freelingo/ui';
export { Panel };
export function useLoopUi() {
  const { colors } = useUiTheme();
  return useMemo(
    () => ({
      tokens: {
        background: colors.snow,
        surface: colors.polar,
        border: colors.swan,
        text: colors.eel,
        muted: colors.wolf,
        primary: colors.owl,
        primaryLip: colors.owlLip,
        macaw: colors.macaw,
        danger: colors.cardinal,
        gold: colors.bee,
        space: SPACE.md,
        radius: BUTTON.radiusPx,
        cardRadius: CARD.radiusPx,
        font: FONT.body,
        maxWidth: LAYOUT.contentMaxWidthPx,
        buttonHeight: BUTTON.minHeightPx,
      },
      styles: StyleSheet.create({
        page: { flex: 1, backgroundColor: colors.snow },
        content: {
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidthPx,
          alignSelf: 'center',
          padding: SPACE.md,
          gap: SPACE.md,
          paddingBottom: SPACE.xl,
          flexGrow: 1,
        },
        heading: {
          fontFamily: FONT.heading,
          fontSize: TYPE.heading.fontSizePx,
          lineHeight: TYPE.heading.lineHeightPx,
          color: colors.eel,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: SPACE.sm,
        },
        title: {
          fontFamily: FONT.strong,
          fontSize: TYPE.subheading.fontSizePx,
          lineHeight: TYPE.subheading.lineHeightPx,
          color: colors.eel,
          flexShrink: 1,
        },
      }),
    }),
    [colors],
  );
}
export function Page({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { styles } = useLoopUi();
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {title !== '' && <Heading>{title}</Heading>}
      {children}
      {footer && (
        <View style={{ marginTop: 'auto', paddingTop: SPACE.md, gap: SPACE.md }}>{footer}</View>
      )}
    </ScrollView>
  );
}
export function Label({
  children,
  muted = false,
  language,
}: {
  children: ReactNode;
  muted?: boolean;
  language?: string;
}) {
  const { colors } = useUiTheme();
  return (
    <BodyText
      {...(language === undefined ? {} : { language })}
      style={muted ? { color: colors.wolf } : undefined}
    >
      {children}
    </BodyText>
  );
}
export function Action({
  label,
  onPress,
  disabled = false,
  tone = 'primary',
  testID,
  hint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'macaw' | 'danger' | 'neutral';
  testID?: string;
  hint?: string;
}) {
  return (
    <Button3D
      label={label}
      onPress={onPress}
      disabled={disabled}
      tone={tone}
      {...(testID === undefined ? {} : { testID })}
      {...(hint === undefined ? {} : { accessibilityHint: hint })}
    />
  );
}
/** A ref guards taps synchronously, before React has committed its disabled render. */
export function useLoopAction(identity: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    busy.current = false;
    setPending(false);
    setError(null);
    return () => {
      epoch.current++;
    };
  }, [identity]);
  const run = (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const turn = epoch.current;
    Promise.resolve()
      .then(action)
      .catch((e: unknown) => {
        if (turn === epoch.current)
          setError(
            e instanceof Error ? e.message : 'Could not save this change. Please try again.',
          );
      })
      .finally(() => {
        if (turn === epoch.current) {
          busy.current = false;
          setPending(false);
        }
      });
  };
  return { pending, error, run };
}

export function ErrorNotice({ message }: { message: string | null }) {
  const { colors } = useUiTheme();
  return message === null ? null : (
    <View accessibilityRole="alert">
      <BodyText style={{ color: colors.cardinal }}>{message}</BodyText>
    </View>
  );
}
