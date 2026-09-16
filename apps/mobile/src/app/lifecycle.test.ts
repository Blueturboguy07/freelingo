import { describe, expect, it, vi } from 'vitest';
import { createLifecyclePort } from './lifecycle';
describe('native lifecycle adapter', () => {
  it('[INV-SESS-27] reports initial and changed activity and removes the same native subscription', () => {
    let event: (state: string) => void = () => {};
    const remove = vi.fn();
    const source = {
      currentState: 'background',
      onState: (listener: typeof event) => {
        event = listener;
        return { remove };
      },
      onBack: vi.fn(),
      platform: 'android',
    };
    const port = createLifecyclePort(source);
    const receive = vi.fn();
    const stop = port.subscribe(receive);
    expect(receive).toHaveBeenLastCalledWith(false);
    event('active');
    expect(receive).toHaveBeenLastCalledWith(true);
    event('inactive');
    expect(receive).toHaveBeenLastCalledWith(false);
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('[INV-SESS-14] Android system back preserves the unified contract route', () => {
    let event = () => false;
    const remove = vi.fn();
    const source = {
      currentState: 'active',
      onState: vi.fn(),
      onBack: (listener: typeof event) => {
        event = listener;
        return { remove };
      },
      platform: 'android',
    };
    const receive = vi.fn(() => true);
    const stop = createLifecyclePort(source).onBack(receive);
    expect(event()).toBe(true);
    expect(receive).toHaveBeenCalledWith('androidSystemBack');
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
