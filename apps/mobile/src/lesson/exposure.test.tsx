import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { freshSession, item } from '@freelingo/core/session';
import type { SessionState } from '@freelingo/core/session';
import type { LessonChallenge } from '@freelingo/core/presentation';
import { LessonPlayer } from './index';
import type { LessonPlayerProps } from './ports';
function fixture() {
  const challenge: LessonChallenge = {
    itemId: 'item-1',
    type: 'typedTranslate',
    instruction: 'Translate',
    prompt: 'Mi casa',
    promptLanguage: 'es',
    language: 'en',
    acceptedAnswers: ['My house'],
  };
  const state: SessionState = {
    ...freshSession({
      queue: [item(1, { type: challenge.type }), item(2, { type: challenge.type })],
    }),
    shellState: 'challenge.idle',
  };
  const onExposure = vi.fn();
  const props: LessonPlayerProps = {
    state,
    challenge,
    exerciseId: 'exercise-1',
    onExposure,
    onEvent: vi.fn(),
    onReport: vi.fn(),
    onExplain: vi.fn(),
    onComplete: vi.fn(),
    media: {
      capabilities: {
        canPlay: false,
        canRecognize: false,
        recognizerLocale: null,
        microphonePermission: 'undetermined',
        screenReaderActive: false,
        announcementInFlight: false,
      },
      play: () => () => {},
      recognize: () => () => {},
      remediate: vi.fn(),
      announce: vi.fn(),
    },
  };
  return { props, onExposure };
}
it('[INV-SCH-11] emits actual prompt exposure for every visible challenge, not just initial loading', () => {
  const { props, onExposure } = fixture();
  const view = render(<LessonPlayer {...props} />);
  expect(onExposure).toHaveBeenLastCalledWith({
    sessionId: 'session-1',
    slotId: 'slot-1',
    itemId: 'item-1',
    exerciseId: 'exercise-1',
    when: 'prompt',
  });
  view.rerender(
    <LessonPlayer
      {...props}
      state={{ ...props.state, core: { ...props.state.core, index: 1 } }}
      challenge={{ ...props.challenge!, itemId: 'item-2', prompt: 'Tu casa' }}
      exerciseId="exercise-2"
    />,
  );
  expect(onExposure).toHaveBeenCalledTimes(2);
  expect(onExposure).toHaveBeenLastCalledWith({
    sessionId: 'session-1',
    slotId: 'slot-2',
    itemId: 'item-2',
    exerciseId: 'exercise-2',
    when: 'prompt',
  });
});
it('[INV-SCH-11] a hidden loading prompt and hidden listening answer are not exposures', () => {
  const { props, onExposure } = fixture();
  const view = render(
    <LessonPlayer {...props} state={{ ...props.state, shellState: 'loading' }} />,
  );
  expect(onExposure).not.toHaveBeenCalled();
  view.rerender(
    <LessonPlayer {...props} challenge={{ ...props.challenge!, type: 'listenTypeWhatYouHear' }} />,
  );
  expect(onExposure).not.toHaveBeenCalled();
});
it('[INV-SCH-11] wrong feedback exposes only after the actual correction banner renders', () => {
  const { props, onExposure } = fixture();
  const audio = { ...props.challenge!, type: 'listenTypeWhatYouHear' as const };
  const view = render(<LessonPlayer {...props} challenge={audio} />);
  view.rerender(
    <LessonPlayer
      {...props}
      challenge={audio}
      state={{ ...props.state, shellState: 'banner.wrong' }}
    />,
  );
  expect(onExposure).toHaveBeenCalledTimes(1);
  expect(onExposure).toHaveBeenCalledWith({
    sessionId: 'session-1',
    slotId: 'slot-1',
    itemId: 'item-1',
    exerciseId: 'exercise-1',
    when: 'wrong-feedback',
  });
  view.rerender(
    <LessonPlayer
      {...props}
      challenge={audio}
      state={{ ...props.state, shellState: 'banner.correct' }}
    />,
  );
  expect(onExposure).toHaveBeenCalledTimes(1);
});
it('[INV-SCH-11] same-slot same-item replacement and fresh sessions retain their exact variant', () => {
  const { props, onExposure } = fixture();
  const view = render(<LessonPlayer {...props} />);
  view.rerender(<LessonPlayer {...props} exerciseId="replacement" />);
  view.rerender(
    <LessonPlayer
      {...props}
      exerciseId="replacement"
      state={{ ...props.state, sessionId: 'session-2' }}
    />,
  );
  expect(onExposure).toHaveBeenCalledTimes(3);
  expect(onExposure.mock.calls.map((row) => row[0].exerciseId)).toEqual([
    'exercise-1',
    'replacement',
    'replacement',
  ]);
  expect(onExposure.mock.calls[2]![0].sessionId).toBe('session-2');
});
it('deduplicates rerenders but refuses missing source identity or stale mismatched item props', () => {
  const { props, onExposure } = fixture();
  const view = render(<LessonPlayer {...props} />);
  view.rerender(<LessonPlayer {...props} onExposure={(e) => onExposure(e)} />);
  expect(onExposure).toHaveBeenCalledTimes(1);
  view.rerender(
    <LessonPlayer
      {...props}
      exerciseId={undefined}
      state={{ ...props.state, sessionId: 'other' }}
    />,
  );
  view.rerender(
    <LessonPlayer {...props} challenge={{ ...props.challenge!, itemId: 'different' }} />,
  );
  expect(onExposure).toHaveBeenCalledTimes(1);
});
it('[INV-SCH-11] complete-chat exposes the visible first turn despite its audio requirement', () => {
  const { props, onExposure } = fixture();
  render(
    <LessonPlayer
      {...props}
      challenge={{
        ...props.challenge!,
        type: 'completeChat',
        options: [{ id: 'a', text: 'Bien.' }],
      }}
    />,
  );
  expect(onExposure).toHaveBeenCalledOnce();
  expect(onExposure.mock.calls[0]![0].when).toBe('prompt');
});
