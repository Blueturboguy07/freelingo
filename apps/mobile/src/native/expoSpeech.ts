import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { createSpeechCapture } from './speechCapture';
/** Native module binding. Unsupported web hosts expose typed/skippable lessons. */
export function createExpoSpeechCapture(announcementInFlight: () => boolean) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  return createSpeechCapture(ExpoSpeechRecognitionModule, {
    platform: Platform.OS,
    announcementInFlight,
  });
}
/** Call only from the explicit onboarding or Settings action, never lesson entry. */
export async function requestSpeechPermission(origin: 'onboarding' | 'settings') {
  if (origin !== 'onboarding' && origin !== 'settings')
    throw new Error('Permission requests require an explicit settings action');
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return permission.granted;
}
