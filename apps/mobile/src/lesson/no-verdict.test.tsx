import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { gradeOpenResponse } from '@freelingo/core/grading';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import { DEFAULT_FLAVOUR_MATRIX, freshSession, item, step } from '@freelingo/core/session';
import type { SessionEvent, SessionState, StepDeps } from '@freelingo/core/session';
import type { LessonChallenge } from '@freelingo/core/presentation';
import { LessonPlayer } from './index';
import type { LessonMediaPort } from './ports';
const content: LessonChallenge = {
  itemId: 'item-1',
  type: 'readAndRespond',
  instruction: 'Write a response',
  prompt: 'El gato come',
  language: 'es',
  promptLanguage: 'es',
  acceptedAnswers: ['Mi gato juega feliz'],
};
const grade = (reply: string) =>
  gradeOpenResponse({
    pack: ES_PACK,
    unit: { ...ES_UNIT, openResponseMinimumLength: 3, taughtInflections: { gato: ['gato'] } },
    item: {
      itemId: 'item-1',
      family: 'read-and-respond',
      accepted: [],
      prompt: content.prompt,
      requiredLexemeIds: ['gato'],
    },
    reply,
    path: 'keyword-length',
  });
function Harness({ port, onComplete }: { port: LessonMediaPort; onComplete: () => void }) {
  const [state, setState] = useState<SessionState>({
    ...freshSession({ queue: [item(1, { type: 'readAndRespond' })] }),
    shellState: 'challenge.idle' as const,
  });
  const dispatch = (event: SessionEvent) =>
    setState((previous) => {
      const deps: StepDeps = {
        config: DEFAULT_FLAVOUR_MATRIX.lesson,
        clock: { nowMs: () => 100 },
        isTypeEligible: () => true,
        stepUpTripped: () => false,
        grading: {
          grade: ({ raw }) => {
            const result = grade(raw);
            return {
              kind: result.writesAttemptRow ? 'accepted' : 'noVerdict',
              ...(result.notArmedReason ? { note: result.notArmedReason } : {}),
            };
          },
        },
      };
      let result = step(previous, event, deps);
      if (result.state.shellState === 'grading')
        result = step(result.state, { type: 'graded' }, deps);
      return result.state;
    });
  return (
    <>
      <LessonPlayer
        state={state}
        challenge={content}
        onEvent={dispatch}
        media={port}
        onReport={() => {}}
        onExplain={() => {}}
        onComplete={onComplete}
      />
      <output data-testid="saved-answers">{state.core.answers.length}</output>
    </>
  );
}
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
it.each(['El gato come', 'gato'])(
  '[INV-GRD-10] shows actual ungraded retry reason for %s while preserving the editable draft and avoiding a success banner',
  (draft) => {
    const port = media(),
      done = vi.fn();
    render(<Harness port={port} onComplete={done} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: draft },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const reason = grade(draft).notArmedReason!;
    expect(screen.getByText(reason)).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value,
    ).toBe(draft);
    expect(screen.getByTestId('saved-answers').textContent).toBe('0');
    expect(done).not.toHaveBeenCalled();
    expect(screen.queryByText('Correct!')).toBeNull();
    expect(port.announce).toHaveBeenCalledWith(reason);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'Mi gato juega feliz' },
    });
    // The learner may still read the specific guidance while editing the retry.
    expect(screen.getByText(reason)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.queryByText(reason)).toBeNull();
    expect(screen.getByTestId('saved-answers').textContent).toBe('1');
  },
);
