/** Native lifecycle is injected so shell tests do not manufacture platform callbacks. */
export interface AppLifecyclePort {
  subscribe(listener: (active: boolean) => void): () => void;
  /** true consumes the back event; false permits the platform's root behavior. */
  onBack(listener: () => boolean): () => void;
}
