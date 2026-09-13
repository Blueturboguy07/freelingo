import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FLAVOUR_MATRIX,
  EXERCISE_TYPES,
  freshSession,
  item,
  step,
} from '@freelingo/core/session';
import type { SessionEvent, SessionState } from '@freelingo/core/session';
import type { LessonChallenge } from '@freelingo/core/presentation';
import { LessonPlayer, EXERCISE_RENDERERS } from './index';
import type { LessonMediaPort } from './ports';
const challenge: LessonChallenge = {
  itemId: 'item-1',
  type: 'wordBankTranslate',
  instruction: 'Write this in Spanish',
  prompt: 'My house',
  language: 'es',
  promptLanguage: 'en',
  acceptedAnswers: ['mi casa'],
  bank: [
    { id: 'a', text: 'mi' },
    { id: 'b', text: 'casa' },
    { id: 'c', text: 'tu' },
  ],
};
function media(): LessonMediaPort {
  return {
    capabilities: {
      canPlay: true,
      canRecognize: true,
      recognizerLocale: 'es',
      microphonePermission: 'granted',
      screenReaderActive: false,
      announcementInFlight: false,
    },
    play: vi.fn(() => () => {}),
    recognize: vi.fn(() => () => {}),
    remediate: vi.fn(),
    announce: vi.fn(),
  };
}
function initial(type = challenge.type): SessionState {
  return { ...freshSession({ queue: [item(1, { type })] }), shellState: 'challenge.idle' };
}
function Harness({
  content = challenge,
  port = media(),
  start = initial(content.type),
}: {
  content?: LessonChallenge;
  port?: LessonMediaPort;
  start?: SessionState;
}) {
  const [state, setState] = useState(start);
  const dispatch = (event: SessionEvent) =>
    setState((previous) => {
      const deps = {
        config: DEFAULT_FLAVOUR_MATRIX.lesson,
        grading: {
          grade: ({ raw }: { raw: string }) => ({
            kind: content.acceptedAnswers.includes(raw) ? ('correct' as const) : ('wrong' as const),
          }),
        },
        clock: { nowMs: () => 1 },
        isTypeEligible: () => true,
        stepUpTripped: () => false,
        traceDefinition: () => content.trace ?? null,
        matchPairs: () =>
          content.pairs?.map((pair) => ({
            leftId: pair.leftId,
            rightId: pair.rightId,
            leftItemId: pair.leftItemId,
          })) ?? [],
      };
      let result = step(previous, event, deps);
      if (result.state.shellState === 'grading')
        result = step(result.state, { type: 'graded' }, deps);
      return result.state;
    });
  return (
    <LessonPlayer
      state={state}
      challenge={content}
      onEvent={dispatch}
      media={port}
      onReport={() => {}}
      onExplain={() => {}}
      onComplete={() => {}}
    />
  );
}
describe('P3 real session player', () => {
  it('[INV-A11Y-04] selected answer exposes its pressed state in the actual accessibility tree', () => {
    render(
      <Harness
        content={{
          ...challenge,
          type: 'meaningSelect',
          options: [
            { id: 'one', text: 'house' },
            { id: 'two', text: 'road' },
          ],
        }}
      />,
    );
    const chosen = screen.getByRole('button', { name: 'house' });
    expect(chosen.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chosen);
    expect(screen.getByRole('button', { name: 'house' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'road' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('[INV-MOD-08] a stopped old clip cannot mark a different restored challenge as heard', () => {
    const port = media(),
      onEvent = vi.fn();
    const props = {
      state: initial('listenTypeWhatYouHear'),
      challenge: { ...challenge, type: 'listenTypeWhatYouHear' as const, audioRef: 'one' },
      onEvent,
      media: port,
      onReport: () => {},
      onExplain: () => {},
      onComplete: () => {},
    };
    const view = render(<LessonPlayer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play audio' }));
    const callbacks = vi.mocked(port.play).mock.calls[0]![1];
    view.rerender(
      <LessonPlayer {...props} challenge={{ ...props.challenge, itemId: 'next-item' }} />,
    );
    onEvent.mockClear();
    callbacks.onComplete();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('[INV-GRD-12] report shows contextual reasons, the escape hatch, credits and exactly three banner utilities', () => {
    const onSnooze = vi.fn(),
      onCredits = vi.fn();
    render(
      <LessonPlayer
        state={{ ...initial(), shellState: 'banner.correct' }}
        challenge={challenge}
        onEvent={() => {}}
        media={media()}
        onReport={() => {}}
        onExplain={() => {}}
        onComplete={() => {}}
        onSnooze={onSnooze}
        onCredits={onCredits}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Snooze exercise' }));
    expect(onSnooze).toHaveBeenCalledWith(challenge.itemId);
    fireEvent.click(screen.getByRole('button', { name: 'Report exercise' }));
    expect(screen.getByRole('button', { name: 'Something else went wrong.' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'The dictionary hints on hover are wrong.' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'The audio is missing.' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Source and credits' }));
    expect(onCredits).toHaveBeenCalledWith(challenge.itemId);
  });
  it('[INV-PACK-52] playback uses the explicit pack reading instead of synthesising displayed Japanese orthography', () => {
    const port = media();
    render(
      <Harness
        port={port}
        content={{
          ...challenge,
          language: 'ja',
          prompt: '今日は',
          audioText: 'きょうは',
          audioRef: 'ja.opus',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play audio' }));
    expect(vi.mocked(port.play).mock.calls[0]?.[0].text).toBe('きょうは');
  });
  it('[INV-A11Y-04] character introduction can continue using a presentation-only answer', () => {
    render(
      <Harness
        content={{ ...challenge, type: 'learnCharacters', prompt: 'あ', acceptedAnswers: ['あ'] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Correct!')).toBeTruthy();
  });
  it('[INV-A11Y-16] trace exposes every ordinal and grades actual pointer geometry without CHECK', () => {
    const content: LessonChallenge = {
      ...challenge,
      type: 'characterTrace',
      trace: {
        version: 1,
        source: 'test:source',
        viewBox: { width: 100, height: 100 },
        strokes: [
          {
            points: [
              { x: 10, y: 20 },
              { x: 90, y: 20 },
            ],
          },
          {
            points: [
              { x: 50, y: 10 },
              { x: 50, y: 90 },
            ],
          },
        ],
      },
    };
    render(<Harness content={content} />);
    expect(screen.getByText('Stroke 1 of 2')).toBeTruthy();
    expect(screen.getAllByTestId(/stroke-ordinal-/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    const canvas = screen.getByTestId('trace-canvas');
    fireEvent.mouseDown(canvas, { clientX: 32, clientY: 64, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 288, clientY: 64, buttons: 1 });
    fireEvent.mouseUp(canvas, { clientX: 288, clientY: 64, button: 0 });
    expect(screen.getByText('Stroke 2 of 2')).toBeTruthy();
    fireEvent.mouseDown(canvas, { clientX: 160, clientY: 32, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 160, clientY: 288, buttons: 1 });
    fireEvent.mouseUp(canvas, { clientX: 160, clientY: 288, button: 0 });
    expect(screen.getByText('Correct!')).toBeTruthy();
  });

  it('[INV-TYP-07] [INV-COM-01] matches five pairs through accessibility actions with no CHECK control', () => {
    const pairs = Array.from({ length: 5 }, (_, n) => ({
      leftItemId: `lexeme${n}`,
      leftId: `l${n}`,
      left: `word ${n}`,
      rightId: `r${n}`,
      right: `meaning ${n}`,
    }));
    render(<Harness content={{ ...challenge, type: 'matchPairs', pairs }} />);
    expect(screen.getAllByTestId(/match-row-/)).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    for (let n = 0; n < 5; n++) {
      fireEvent.click(screen.getByRole('button', { name: `word ${n}` }));
      fireEvent.click(screen.getByRole('button', { name: `meaning ${n}` }));
    }
    expect(screen.getByText('Correct!')).toBeTruthy();
    expect(screen.getAllByTestId(/match-row-/)).toHaveLength(5);
  });

  it('[INV-SESS-04] [INV-TYP-12] plays bank → CHECK → persisted banner → CONTINUE through the real machine', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Check' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.click(screen.getByTestId('bank-a'));
    fireEvent.click(screen.getByTestId('bank-b'));
    expect(screen.getByTestId('bank-a').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('submitted-answer').textContent).toContain('mi');
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByText('Correct!')).toBeTruthy();
    expect(screen.getByTestId('submitted-answer').textContent).toContain('casa');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Lesson complete!')).toBeTruthy();
  });
  it('[INV-SESS-15] restores opaque bank selection without reordering and routes X to one quit event', () => {
    const onEvent = vi.fn();
    render(
      <LessonPlayer
        state={{
          ...initial(),
          inFlight: {
            text: 'casa mi',
            caret: 7,
            partialState: { selectedTileIds: ['b', 'a'] },
            audioHeardToEnd: false,
          },
        }}
        challenge={challenge}
        onEvent={onEvent}
        media={media()}
        onReport={() => {}}
        onExplain={() => {}}
        onComplete={() => {}}
      />,
    );
    expect(screen.getByTestId('submitted-answer').textContent).toBe('casami');
    fireEvent.click(screen.getByRole('button', { name: 'Close lesson' }));
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'exit', route: 'closeButton' });
  });
  it('[INV-A11Y-11] chat reading NEXT is separate from selecting and checking a reply', () => {
    const port = media();
    render(
      <Harness
        port={port}
        content={{
          ...challenge,
          type: 'completeChat',
          prompt: '¿Dónde están?',
          options: [
            { id: 'yes', text: 'Están dentro.' },
            { id: 'no', text: 'Son las cinco.' },
          ],
          acceptedAnswers: ['Están dentro.'],
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Están dentro.' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Están dentro.' }));
    expect(port.announce).toHaveBeenCalledWith('Están dentro.');
    expect(screen.getByRole('button', { name: 'Check' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });
  it('[INV-I18N-05] IME composition cannot CHECK or close and preserves ungraded text', () => {
    render(
      <Harness
        content={{ ...challenge, type: 'typedTranslate', requiresIme: true, language: 'ja' }}
      />,
    );
    const field = screen.getByRole('textbox');
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: 'かな' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close lesson' }));
    expect(screen.queryByText('Correct!')).toBeNull();
    expect(screen.queryByText('End session?')).toBeNull();
    expect((field as HTMLInputElement).value).toBe('かな');
    fireEvent.compositionEnd(field);
    expect(screen.getByRole('button', { name: 'Check' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });
  it('[INV-A11Y-12] no microphone starts on mount or while an announcement is active', () => {
    const base = media();
    const port = {
      ...base,
      capabilities: { ...base.capabilities, screenReaderActive: true, announcementInFlight: true },
    };
    render(<Harness port={port} content={{ ...challenge, type: 'speakSentence' }} />);
    expect(port.recognize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tap to speak' }));
    expect(port.recognize).not.toHaveBeenCalled();
  });
  it('[INV-MOD-08] route interruption preserves input and re-offers playback without a suspension', async () => {
    const port = media();
    render(
      <Harness
        port={port}
        content={{ ...challenge, type: 'listenTypeWhatYouHear', audioRef: 'clip.opus' }}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mi casa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play audio' }));
    const callbacks = vi.mocked(port.play).mock.calls[0]![1];
    callbacks.onInterrupted();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check' }).getAttribute('aria-disabled')).toBe(
        'true',
      ),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('mi casa');
    expect(screen.getByRole('button', { name: 'Play audio' })).toBeTruthy();
    expect(port.remediate).not.toHaveBeenCalled();
  });
  it('[INV-A11Y-04] declares a renderer and screen-reader contract for every runtime exercise type', () => {
    expect(Object.keys(EXERCISE_RENDERERS).sort()).toEqual([...EXERCISE_TYPES].sort());
    for (const row of Object.values(EXERCISE_RENDERERS))
      expect(row.accessibilityInstructions.length).toBeGreaterThan(15);
  });
});
