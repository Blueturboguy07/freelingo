import { parseSessionState } from '../db/sessionCodec';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLAVOUR_MATRIX, freshSession, item, step } from '@freelingo/core/session';
import type { SessionEvent, SessionState, StepResult } from '@freelingo/core/session';
import type { LessonChallenge } from '@freelingo/core/presentation';
import { LessonPlayer } from './index.js';
import type { LessonMediaPort } from './ports.js';
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
function Harness({ port, results }: { port: LessonMediaPort; results: StepResult[] }) {
  const [state, setState] = useState<SessionState>(() => ({
    ...freshSession({
      queue: [item(1, { type: 'speakSentence' }), item(2, { type: 'speakSentence' })],
    }),
    shellState: 'challenge.idle' as const,
  }));
  const current = state.core.queue[state.core.index]!;
  const content: LessonChallenge = {
    itemId: current.itemId,
    type: current.type,
    language: 'es',
    promptLanguage: 'es',
    instruction:
      current.type === 'speakSentence' ? 'Speak this sentence' : 'Choose the correct meaning',
    prompt: 'Hola.',
    acceptedAnswers: ['Hello.'],
    options: [
      { id: 'hello', text: 'Hello.' },
      { id: 'bye', text: 'Goodbye.' },
    ],
  };
  const dispatch = (event: SessionEvent) =>
    setState((previous) => {
      const result = step(previous, event, {
        config: DEFAULT_FLAVOUR_MATRIX.lesson,
        grading: { grade: () => ({ kind: 'correct' }) },
        clock: { nowMs: () => 1 },
        isTypeEligible: () => true,
        stepUpTripped: () => false,
        modalityReplacement: (source) => ({
          ...source,
          itemId: `${source.itemId}-recognition`,
          type: 'meaningSelect',
          family: 'recognition',
          requiresAudio: false,
        }),
      });
      results.push(result);
      return result.state;
    });
  return (
    <LessonPlayer
      state={state}
      challenge={content}
      onEvent={dispatch}
      media={port}
      onReport={vi.fn()}
      onExplain={vi.fn()}
      onComplete={vi.fn()}
    />
  );
}
function startCapture(port: LessonMediaPort) {
  fireEvent.click(screen.getByRole('button', { name: /Tap to speak|Retry recording/ }));
  return vi.mocked(port.recognize).mock.calls.at(-1)![1];
}
describe('P3 microphone caller', () => {
  it('[INV-MOD-10] two real transient callbacks replace current exercise without arming a suspension', () => {
    const port = media(),
      results: StepResult[] = [];
    render(<Harness port={port} results={results} />);
    let callback = startCapture(port);
    act(() => callback.onError('route'));
    expect(screen.getByText(/Microphone Access Problem/)).toBeTruthy();
    callback = startCapture(port);
    act(() => callback.onError('unavailable'));
    expect(screen.getByText('Choose the correct meaning')).toBeTruthy();
    expect(results.some((result) => result.suspendFamily !== undefined)).toBe(false);
    expect(results.at(-1)?.state.core.queue[1]?.type).toBe('speakSentence');
  });
  it('[INV-MOD-09] silent real results cannot arm Check and the third converts all remaining speaking', () => {
    const port = media(),
      results: StepResult[] = [];
    render(<Harness port={port} results={results} />);
    for (let n = 0; n < 3; n++) {
      const callback = startCapture(port);
      act(() => callback.onResult({ transcript: n === 0 ? 'Hola.' : '', amplitude: 0 }));
      if (n < 2)
        expect(screen.getByRole('button', { name: /^check$/i }).getAttribute('aria-disabled')).toBe(
          'true',
        );
    }
    expect(screen.getByText('Choose the correct meaning')).toBeTruthy();
    expect(results.at(-1)?.state.core.queue.every((row) => row.type !== 'speakSentence')).toBe(
      true,
    );
    expect(results.at(-1)?.state.core.answers).toEqual([]);
  });
  it('[INV-MOD-02] explicit Can’t speak dispatches the source-bound replacement and one snooze effect', () => {
    const port = media(),
      results: StepResult[] = [];
    render(<Harness port={port} results={results} />);
    fireEvent.click(screen.getByRole('button', { name: 'Can’t speak now' }));
    expect(screen.getByText('Choose the correct meaning')).toBeTruthy();
    expect(results.filter((result) => result.suspendFamily === 'speaking')).toHaveLength(1);
    expect(results.at(-1)?.state.core.queue).toHaveLength(2);
    expect(results.at(-1)?.state.core.index).toBe(0);
  });
  it('[INV-MOD-05] denied capability substitutes without starting a recorder or a blocking modal', () => {
    const base = media(),
      results: StepResult[] = [];
    const port = {
      ...base,
      capabilities: {
        ...base.capabilities,
        canRecognize: false,
        microphonePermission: 'denied' as const,
      },
    };
    render(<Harness port={port} results={results} />);
    expect(screen.getByText('Choose the correct meaning')).toBeTruthy();
    expect(port.recognize).not.toHaveBeenCalled();
    expect(results.filter((result) => result.suspendFamily === 'speaking')).toHaveLength(1);
  });
});

it('[INV-MOD-13] the real player carries recognizer segments into the session event', () => {
  const port = media(),
    results: StepResult[] = [];
  render(<Harness port={port} results={results} />);
  const callback = startCapture(port);
  const segments = [{ segment: 'Hola.', startTimeMillis: 0, endTimeMillis: 500, confidence: -1 }];
  act(() => callback.onResult({ transcript: 'Hola.', amplitude: 0.5, segments }));
  const saved = parseSessionState(JSON.stringify(results.at(-1)!.state));
  expect(saved.inFlight.partialState.segments).toEqual(segments);
});
