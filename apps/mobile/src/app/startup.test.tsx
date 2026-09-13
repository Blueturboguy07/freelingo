import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FreelingoServices } from './ports';
import { AppStartup } from './AppStartup';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
const services = (): FreelingoServices => ({
  open: vi.fn(async () => {
    throw new Error('No verified runtime in this test');
  }),
});
describe('bundled typography startup boundary', () => {
  it('[INV-TYP-01] holds the real App runtime until bundled fonts have finished loading', async () => {
    const gate = deferred();
    const host = services();
    render(<AppStartup services={host} fonts={{ load: () => gate.promise }} />);
    expect(host.open).not.toHaveBeenCalled();
    expect(screen.getByText('Loading Freelingo…')).toBeTruthy();
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(host.open).toHaveBeenCalledTimes(1));
  });
  it('[INV-TYP-01] a failed font load stays visible and retries instead of rendering with a substitute face', async () => {
    const host = services();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bundled fonts could not load'))
      .mockResolvedValueOnce(undefined);
    render(<AppStartup services={host} fonts={{ load }} />);
    expect(await screen.findByText('Bundled fonts could not load')).toBeTruthy();
    expect(host.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(host.open).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('[INV-PER-06] a late font completion after unmount never opens a database', async () => {
    const gate = deferred();
    const host = services();
    const view = render(<AppStartup services={host} fonts={{ load: () => gate.promise }} />);
    view.unmount();
    await act(async () => {
      gate.resolve();
    });
    expect(host.open).not.toHaveBeenCalled();
  });
});
