/** Explicit development probe of the installed native patch, never a simulated verdict. */
import { useEffect, useRef, useState } from 'react';
import { requireNativeModule } from 'expo';
import { Pressable, Text, View } from 'react-native';
interface NativeSpeech {
  readonly freelingoLocalSpeechRevision?: number;
  getVoices(): Promise<readonly { identifier: string; language: string }[]>;
  speak(id: string, text: string, options: { voice: string; language: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(name: string, listener: (event: { id: string }) => void): { remove(): void };
}
export function NativeSpeechDiagnostics() {
  const [result, setResult] = useState('not-run');
  const [revision, setRevision] = useState('not-read');
  const [voices, setVoices] = useState('not-read');
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  async function probe() {
    cleanup.current?.();
    let alive = true;
    let finished = false;
    const subscriptions: { remove(): void }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let native: NativeSpeech | null = null;
    cleanup.current = () => {
      alive = false;
      clearTimeout(timer);
      for (const subscription of subscriptions) subscription.remove();
      void native?.stop().catch(() => {});
    };
    const finish = (message: string) => {
      if (!alive || finished) return;
      finished = true;
      clearTimeout(timer);
      setResult(message);
    };
    setResult('running');
    try {
      native = requireNativeModule<NativeSpeech>('ExpoSpeech');
      setRevision(String(native.freelingoLocalSpeechRevision ?? 'missing'));
      if (native.freelingoLocalSpeechRevision !== 1) return finish('unpatched-binary');
      const id = 'freelingo-diagnostic-missing-voice';
      for (const [name, outcome] of [
        ['Exponent.speakingError', 'missing-voice-blocked'],
        ['Exponent.speakingStarted', 'UNEXPECTED-speech'],
        ['Exponent.speakingDone', 'UNEXPECTED-speech'],
      ] as const)
        subscriptions.push(
          native.addListener(name, (event) => {
            if (event.id === id) finish(outcome);
          }),
        );
      // Resource bound for this explicit diagnostic only, not an application voice timeout.
      timer = setTimeout(() => finish('native-probe-timeout'), 15_000);
      const available = await native.getVoices();
      if (!alive) return;
      setVoices(
        JSON.stringify(available.map(({ identifier, language }) => ({ identifier, language }))),
      );
      try {
        await native.speak(id, 'Hola', {
          voice: '__freelingo_missing_offline_voice__',
          language: 'es-ES',
        });
      } catch {
        finish('missing-voice-blocked');
      }
    } catch (error) {
      finish(`probe-failed: ${String(error)}`);
    }
  }
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        testID="native-speech-probe"
        accessibilityRole="button"
        onPress={() => {
          void probe();
        }}
      >
        <Text>CHECK NATIVE SPEECH</Text>
      </Pressable>
      <Text testID="native-speech-revision">{revision}</Text>
      <Text testID="native-speech-voices">{voices}</Text>
      <Text testID="native-speech-result">{result}</Text>
    </View>
  );
}
