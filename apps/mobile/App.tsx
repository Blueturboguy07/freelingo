import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// The app renders engine output and forwards taps; it never computes a rule.
import { localDayOf, streakFromDays } from '@freelingo/core';
import { PROGRESS_DB_LOCATION } from '@freelingo/schema';
import { BUTTON, COLOR, FONT_FAMILY, TYPE } from '@freelingo/ui';

import { DevDiagnostics } from './src/dev/DevDiagnostics';
import { DIAGNOSTICS_ENABLED } from './src/dev/diagnosticsEnabled';
import { startPersistence, type PersistenceStatus } from './src/db/startPersistence';

const DEVICE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function App() {
  // P0 smoke: prove the workspace wiring (core + schema + ui) reaches the device.
  // The real path screen lands at P3.
  const today = localDayOf(new Date(), DEVICE_TIME_ZONE);
  const streak = streakFromDays([today], today);

  const [status, setStatus] = useState<PersistenceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Persistence is opened once, at start: DB in the document region, packs directory
    // in the cache region, packs excluded from backup (INV-PER-06, INV-PACK-11).
    startPersistence()
      .then(({ status: resolved }) => {
        if (!cancelled) setStatus(resolved);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (diagnosticsOpen && DIAGNOSTICS_ENABLED) {
    return (
      <DevDiagnostics status={status} error={error} onClose={() => setDiagnosticsOpen(false)} />
    );
  }

  return (
    <View style={styles.screen}>
      <Text
        testID="app-title"
        style={styles.title}
        // Dev builds, and the e2e builds native-e2e makes — which are Release, so
        // `__DEV__` alone would hide this from the one job that gates it. See
        // ./src/dev/diagnosticsEnabled.
        onLongPress={DIAGNOSTICS_ENABLED ? () => setDiagnosticsOpen(true) : undefined}
      >
        Freelingo
      </Text>
      <Text style={styles.body}>
        {DEVICE_TIME_ZONE} · {today} · streak {streak}
      </Text>
      <Text style={styles.body}>progress db: {PROGRESS_DB_LOCATION.region}</Text>
      <Text testID="persistence-state" style={styles.body}>
        {error !== null ? `persistence failed: ${error}` : status === null ? 'opening…' : 'ready'}
      </Text>
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
