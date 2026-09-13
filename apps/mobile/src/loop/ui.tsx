/** Temporary P4 wrapper; measured scope/10, web guest dark arm, 2026-09-10.
 * P3 replaces these atoms at integration. No gameplay rule lives here. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
export const LOOP_TOKENS = {
  background: '#131F24',
  surface: '#202F36',
  border: '#37464F',
  text: '#F1F7FB',
  muted: '#AFC1CA',
  primary: '#93D333',
  primaryLip: '#79B933',
  macaw: '#49C0F8',
  danger: '#EE5555',
  gold: '#FFC700',
  space: 16,
  radius: 16,
  cardRadius: 12,
  font: 'Nunito',
  maxWidth: 614,
  buttonHeight: 50,
} as const;
export function Page({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {title !== '' && (
        <Text accessibilityRole="header" style={styles.heading}>
          {title}
        </Text>
      )}
      {children}
      {footer}
    </ScrollView>
  );
}
export function Panel({ children }: { children: ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}
export function Label({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted]}>{children}</Text>;
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: disabled || tone === 'neutral' ? LOOP_TOKENS.border : LOOP_TOKENS[tone],
          borderBottomWidth: disabled || pressed ? 0 : 4,
          borderBottomColor: tone === 'primary' ? LOOP_TOKENS.primaryLip : LOOP_TOKENS.border,
        },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          { color: disabled || tone === 'neutral' ? LOOP_TOKENS.text : LOOP_TOKENS.background },
        ]}
      >
        {label}
      </Text>
    </Pressable>
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
  return message === null ? null : (
    <Text accessibilityRole="alert" style={[styles.body, { color: LOOP_TOKENS.danger }]}>
      {message}
    </Text>
  );
}
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: LOOP_TOKENS.background },
  content: {
    width: '100%',
    maxWidth: LOOP_TOKENS.maxWidth,
    alignSelf: 'center',
    padding: LOOP_TOKENS.space,
    gap: LOOP_TOKENS.space,
    paddingBottom: 32,
  },
  heading: {
    fontFamily: LOOP_TOKENS.font,
    fontSize: 28,
    fontWeight: '800',
    color: LOOP_TOKENS.text,
  },
  body: { fontFamily: LOOP_TOKENS.font, fontSize: 17, lineHeight: 25, color: LOOP_TOKENS.text },
  muted: { color: LOOP_TOKENS.muted },
  panel: {
    borderWidth: 2,
    borderColor: LOOP_TOKENS.border,
    borderRadius: LOOP_TOKENS.cardRadius,
    padding: LOOP_TOKENS.space,
    gap: 12,
  },
  button: {
    minHeight: LOOP_TOKENS.buttonHeight,
    borderRadius: LOOP_TOKENS.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  buttonText: {
    fontFamily: LOOP_TOKENS.font,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontFamily: LOOP_TOKENS.font, fontSize: 22, fontWeight: '800', color: LOOP_TOKENS.text },
});
