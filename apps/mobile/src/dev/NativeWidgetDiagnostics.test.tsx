import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('expo', () => ({ requireNativeModule: load }));
import { NativeWidgetDiagnostics } from './NativeWidgetDiagnostics';
import { WIDGET_PROBE_BASELINE_JSON } from './widgetPublicationProbe';
afterEach(() => {
  cleanup();
  load.mockReset();
});
it('[INV-WID-01] disabled diagnostic does not load native module or mutate publication', () => {
  render(<NativeWidgetDiagnostics enabled={false} />);
  expect(screen.queryByText('CHECK NATIVE WIDGET')).toBeNull();
  expect(load).not.toHaveBeenCalled();
});
it('[INV-WID-01][INV-WID-04] explicit E2E tap reports success only after real port operations and restoration', async () => {
  let raw = WIDGET_PROBE_BASELINE_JSON;
  const release = vi.fn(async () => {}),
    reload = vi.fn(async () => {});
  load.mockReturnValue({
    acquire: async () => 'lease',
    read: async () => raw,
    write: async (_t: string, v: string) => {
      raw = v;
    },
    release,
    reload,
  });
  render(<NativeWidgetDiagnostics enabled />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('CHECK NATIVE WIDGET'));
  await waitFor(() => expect(screen.getByText('bridge-passed')).toBeTruthy());
  expect(raw).toBe(WIDGET_PROBE_BASELINE_JSON);
  expect(release).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});
