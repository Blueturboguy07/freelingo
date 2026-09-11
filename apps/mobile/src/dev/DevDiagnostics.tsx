/**
 * DevDiagnostics — the INV-PER-06 device gate, made visible.
 *
 * Dev builds only. Reached by long-pressing the app title. Every row carries a `testID`
 * so `e2e/flows/p0-db-path.yaml` asserts on the value the app actually resolved, not on
 * a value a test computed for itself.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { COLOR } from '@freelingo/ui';
import type { PersistenceStatus } from '../db/startPersistence';

export interface DevDiagnosticsProps {
  readonly status: PersistenceStatus | null;
  readonly error: string | null;
  readonly onClose: () => void;
}

function Row({ testID, label, value }: { testID: string; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text testID={testID} accessibilityLabel={value} style={styles.value} selectable>
        {value}
      </Text>
    </View>
  );
}

/** `true`/`false`/`unavailable` — never a bare empty string, which reads as a pass. */
function tristate(value: boolean | null): string {
  return value === null ? 'unavailable' : String(value);
}

export function DevDiagnostics({ status, error, onClose }: DevDiagnosticsProps) {
  return (
    <ScrollView testID="dev-diagnostics" contentContainerStyle={styles.screen}>
      <Text style={styles.heading}>Diagnostics</Text>

      {status === null ? (
        <Row testID="db-path" label="db-path" value={error ?? 'resolving…'} />
      ) : (
        <>
          <Row testID="db-path" label="db-path" value={status.dbPath} />
          <Row testID="journal-mode" label="journal-mode" value={status.journalMode} />
          <Row testID="user-version" label="user-version" value={String(status.userVersion)} />
          <Row testID="packs-dir" label="packs-dir" value={status.packsDir} />
          <Row
            testID="packs-excluded"
            label="packs-excluded"
            value={
              status.packsExcludedError === null
                ? tristate(status.packsExcluded)
                : `unavailable: ${status.packsExcludedError}`
            }
          />
          <Row testID="platform" label="platform" value={status.platform} />
          <Row
            testID="db-path-persistent"
            label="db-path-persistent"
            value={String(status.dbPathPersistent)}
          />
          <Row
            testID="pre-migration-backup"
            label="pre-migration-backup"
            value={status.preMigrationBackup ?? 'none'}
          />
        </>
      )}

      <Pressable testID="dev-diagnostics-close" onPress={onClose} style={styles.close}>
        <Text style={styles.closeLabel}>CLOSE</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 24, paddingTop: 72, gap: 12 },
  heading: { fontSize: 24, fontWeight: '800', color: COLOR.owl, marginBottom: 8 },
  row: { gap: 2 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, opacity: 0.6 },
  value: { fontSize: 13 },
  close: { marginTop: 24, alignSelf: 'flex-start' },
  closeLabel: { fontSize: 15, fontWeight: '700', color: COLOR.owl, letterSpacing: 0.8 },
});
