export type AppBackRoute = 'hardwareBack' | 'androidSystemBack';
/** Native lifecycle is injected so shell tests do not manufacture platform callbacks. */
export interface AppLifecyclePort {
  subscribe(listener: (active: boolean) => void): () => void;
  /** true consumes the back event; false permits the platform's root behavior. */
  onBack(listener: (route?: AppBackRoute) => boolean): () => void;
}
interface NativeSubscription {
  remove(): void;
}
export interface NativeLifecycleSource {
  readonly currentState: string | null;
  readonly platform: string;
  onState(listener: (state: string) => void): NativeSubscription;
  onBack(listener: () => boolean): NativeSubscription;
}
export function createLifecyclePort(source: NativeLifecycleSource): AppLifecyclePort {
  return {
    subscribe(listener) {
      const subscription = source.onState((state) => listener(state === 'active'));
      listener(source.currentState === 'active');
      return () => subscription.remove();
    },
    onBack(listener) {
      const subscription = source.onBack(() =>
        listener(source.platform === 'android' ? 'androidSystemBack' : 'hardwareBack'),
      );
      return () => subscription.remove();
    },
  };
}
