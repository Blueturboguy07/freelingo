import { useState } from 'react';
import { AppState, BackHandler, Modal, Platform } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AppStartup } from './AppStartup';
import { bundledFonts } from './nativeFonts';
import { createLifecyclePort } from './lifecycle';
import type { AppRuntime, FreelingoServices } from './ports';
import { DevDiagnostics } from '../dev/DevDiagnostics';
import { DIAGNOSTICS_ENABLED } from '../dev/diagnosticsEnabled';
const lifecycle = createLifecyclePort({
  get currentState() {
    return AppState.currentState;
  },
  platform: Platform.OS,
  onState: (listener) => AppState.addEventListener('change', listener),
  onBack: (listener) => BackHandler.addEventListener('hardwareBackPress', listener),
});
/** Native entry composes real bundled assets and system callbacks; factory remains injected. */
export function NativeApp({ services }: { readonly services: FreelingoServices }) {
  const [diagnostics, setDiagnostics] = useState<AppRuntime | null>(null);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1 }}>
        <AppStartup
          services={services}
          lifecycle={lifecycle}
          fonts={bundledFonts}
          onDiagnostics={DIAGNOSTICS_ENABLED ? setDiagnostics : undefined}
        />
        <StatusBar style="auto" />
        {DIAGNOSTICS_ENABLED && (
          <Modal visible={diagnostics !== null} onRequestClose={() => setDiagnostics(null)}>
            <DevDiagnostics
              status={diagnostics?.persistence ?? null}
              error={null}
              onClose={() => setDiagnostics(null)}
            />
          </Modal>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
