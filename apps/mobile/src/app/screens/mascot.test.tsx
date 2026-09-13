import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mascot, MascotProvider } from '@freelingo/ui';
import type { MascotRenderer } from '@freelingo/ui';

describe('central mascot rendering', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('[S123] system reduced motion suppresses decorative rig movement even with animations on', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const ref = createRef<MascotRenderer>();
    const { container } = render(<Mascot ref={ref} label="Parrot" />);
    const initial = container.innerHTML;
    act(() => {
      ref.current!.setNumber('blink', 1);
      ref.current!.setNumber('bounce', 1);
    });
    expect(container.innerHTML).toBe(initial);
  });

  it('[S123] returning to a prior equipped snapshot never resurrects its old rig override', () => {
    const ref = createRef<MascotRenderer>();
    const view = (outfitId: string | null) => (
      <Mascot ref={ref} outfitId={outfitId} label="Parrot" />
    );
    const { container, rerender } = render(view(null));
    const neutral = container.innerHTML;
    act(() => ref.current!.setNumber('outfit', 1));
    rerender(view('cosmetic-brass-perch'));
    rerender(view(null));
    expect(container.innerHTML).toBe(neutral);
  });
  it('[S075] returning to a prior caller pose never resurrects its old rig override', () => {
    const ref = createRef<MascotRenderer>();
    const view = (pose: 'idle' | 'happy') => <Mascot ref={ref} pose={pose} label="Parrot" />;
    const { container, rerender } = render(view('idle'));
    const idle = container.innerHTML;
    act(() => ref.current!.fire('droop'));
    rerender(view('happy'));
    rerender(view('idle'));
    expect(container.innerHTML).toBe(idle);
  });

  it('[S123] a fresh equipped snapshot supersedes a previous imperative preview immediately', () => {
    const ref = createRef<MascotRenderer>();
    const view = (outfitId: string) => (
      <MascotProvider outfitId={outfitId}>
        <Mascot ref={ref} label="Parrot" />
      </MascotProvider>
    );
    const { container, rerender } = render(view('cosmetic-explorer-outfit'));
    act(() => ref.current!.setNumber('outfit', 0));
    expect(container.querySelector('[id="mascot-outfit"]')).toBeNull();
    rerender(view('cosmetic-snowfall-suit'));
    expect(container.querySelector('[id="mascot-outfit"]')).not.toBeNull();
  });
  it('[S123] disabled animations leave blink and bounce inputs still while pose selection works', () => {
    const ref = createRef<MascotRenderer>();
    const { container } = render(
      <MascotProvider outfitId={null} animationsEnabled={false}>
        <Mascot ref={ref} label="Parrot" />
      </MascotProvider>,
    );
    const original = container.innerHTML;
    act(() => {
      ref.current!.setNumber('blink', 1);
      ref.current!.setNumber('bounce', 1);
    });
    expect(container.innerHTML).toBe(original);
    act(() => ref.current!.fire('droop'));
    expect(container.innerHTML).not.toBe(original);
  });

  it('[INV-ECO-31] the shared equipped snapshot changes every parrot and unknown ids return neutral', () => {
    const view = (outfitId: string | null) => (
      <MascotProvider outfitId={outfitId}>
        <Mascot label="Path parrot" size={64} />
        <Mascot label="Ceremony parrot" pose="happy" size={240} />
      </MascotProvider>
    );
    const { container, rerender } = render(view(null));
    const original = container.innerHTML;
    rerender(view('cosmetic-explorer-outfit'));
    expect(container.querySelectorAll('[id="mascot-outfit"]')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Path parrot' })).toBeTruthy();
    rerender(view('future-outfit'));
    expect(container.innerHTML).toBe(original);
  });
  it('[S123] explicit shop previews do not change another surface or the equipped context', () => {
    const { container } = render(
      <MascotProvider outfitId="cosmetic-explorer-outfit">
        <Mascot label="Equipped parrot" />
        <Mascot label="Preview parrot" outfitId="cosmetic-snowfall-suit" />
      </MascotProvider>,
    );
    const images = [...container.querySelectorAll('svg')];
    expect(images).toHaveLength(2);
    expect(images[0]!.innerHTML).not.toEqual(images[1]!.innerHTML);
  });
  it('[S075] the number-and-trigger renderer seam changes actual poses and preserves outfits', () => {
    const ref = createRef<MascotRenderer>();
    const { container } = render(
      <Mascot ref={ref} label="Parrot" outfitId="cosmetic-brass-perch" />,
    );
    const initial = container.innerHTML;
    act(() => ref.current!.fire('celebrate'));
    expect(container.innerHTML).not.toBe(initial);
    expect(container.querySelector('[id="mascot-outfit"]')).not.toBeNull();
    act(() => ref.current!.setNumber('pose', 0));
    expect(container.innerHTML).toBe(initial);
    act(() => ref.current!.setNumber('outfit', 999));
    expect(container.querySelector('[id="mascot-outfit"]')).toBeNull();
  });
});
