import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { requireNativeModule } from 'expo';
import type { WidgetPublicationNative } from '../widget/nativeWidgetPorts';
import { runWidgetPublicationProbe } from './widgetPublicationProbe';
/** Only explicit E2E bundles expose this state-writing probe, even in development. */
export const WIDGET_PROBE_ENABLED = process.env.EXPO_PUBLIC_FREELINGO_E2E === '1';
export function NativeWidgetDiagnostics({
  enabled = WIDGET_PROBE_ENABLED,
}: {
  readonly enabled?: boolean;
}) {
  const [result, setResult] = useState('not-run');
  const [running, setRunning] = useState(false);
  if (!enabled) return null;
  async function probe() {
    if (running) return;
    setRunning(true);
    setResult('running');
    try {
      const native = requireNativeModule<WidgetPublicationNative>('WidgetPublication');
      const outcome = await runWidgetPublicationProbe(native, Date.now());
      setResult(outcome.status);
    } catch (error) {
      setResult(`probe-failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  }
  return (
    <View style={{ gap: 6 }}>
      <Text>Widget bridge diagnostic fixture — no real-account or draw verdict.</Text>
      <Pressable
        testID="native-widget-probe"
        accessibilityRole="button"
        disabled={running}
        onPress={() => {
          void probe();
        }}
      >
        <Text>CHECK NATIVE WIDGET</Text>
      </Pressable>
      <Text testID="native-widget-result">{result}</Text>
    </View>
  );
}
