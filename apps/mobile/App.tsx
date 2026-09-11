import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// The app renders engine output and forwards taps; it never computes a rule.
import { localDayOf, streakFromDays } from '@freelingo/core';
import { PROGRESS_DB_LOCATION } from '@freelingo/schema';
import { BUTTON, COLOR, FONT_FAMILY, TYPE } from '@freelingo/ui';

const DEVICE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function App() {
  // P0 smoke: prove the workspace wiring (core + schema + ui) reaches the device.
  // The real path screen lands at P3.
  const today = localDayOf(new Date(), DEVICE_TIME_ZONE);
  const streak = streakFromDays([today], today);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Freelingo</Text>
      <Text style={styles.body}>
        {DEVICE_TIME_ZONE} · {today} · streak {streak}
      </Text>
      <Text style={styles.body}>progress db: {PROGRESS_DB_LOCATION.region}</Text>
      <View style={styles.button}>
        <Text style={styles.buttonLabel}>CONTINUE</Text>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: COLOR.owl,
  },
  body: {
    fontSize: 14,
  },
  button: {
    backgroundColor: COLOR.owl,
    borderBottomColor: COLOR.owlLip,
    borderBottomWidth: BUTTON.lipHeightPx,
    borderRadius: BUTTON.radiusPx,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginTop: 12,
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontSize: TYPE.labelButton.fontSizePx,
    fontWeight: '700',
    letterSpacing: TYPE.labelButton.letterSpacingPx,
  },
});

// Referenced so the bundled font name stays wired into the app once Nunito ships (P3).
export const APP_FONT_FAMILY = FONT_FAMILY;
