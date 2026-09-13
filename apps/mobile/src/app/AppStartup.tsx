import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { FreelingoApp } from './FreelingoApp';
import type { FreelingoAppProps } from './FreelingoApp';
export interface AppFontPort {
  load(): Promise<void>;
}
/** Never render measured text until the exact bundled faces are available. */
export function AppStartup({ fonts, ...app }: FreelingoAppProps & { readonly fonts: AppFontPort }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    setState('loading');
    setError(null);
    void fonts
      .load()
      .then(() => {
        if (!disposed) setState('ready');
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : 'Bundled fonts could not load.');
          setState('failed');
        }
      });
    return () => {
      disposed = true;
    };
  }, [fonts, retry]);
  if (state === 'ready') return <FreelingoApp {...app} />;
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 }}>
      {state === 'loading' ? (
        <>
          <ActivityIndicator accessibilityLabel="Loading bundled fonts" />
          <Text>Loading Freelingo…</Text>
        </>
      ) : (
        <>
          <Text accessibilityRole="alert">{error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => setRetry((n) => n + 1)}
            style={{ padding: 16 }}
          >
            <Text>Try again</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
