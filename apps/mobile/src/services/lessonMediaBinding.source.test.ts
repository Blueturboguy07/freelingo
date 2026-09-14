// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { freshSession, item, exerciseSpec } from '@freelingo/core/session';
import { createLessonMediaBinding } from './lessonMediaBinding';
function view(type: 'meaningSelect' | 'listenTypeWhatYouHear' | 'speakSentence' = 'meaningSelect') {
  const q = item(1, { type });
  return {
    exerciseId: 'exact-saved-exercise',
    state: { ...freshSession({ queue: [q] }), shellState: 'challenge.idle' as const },
    challenge: {
      itemId: q.itemId,
      type,
      instruction: 'Choose the meaning',
      prompt: '猫',
      language: 'ja',
      acceptedAnswers: ['cat'],
    },
  };
}
it('[INV-SESS-27][INV-AUD-06] actual non-audio Japanese recognition is displayable without an unused reading', async () => {
  const v = view();
  expect(exerciseSpec(v.challenge.type).requiresAudio).toBe(false);
  const activate = vi.fn(async () => {});
  await expect(createLessonMediaBinding(activate).synchronize(v)).resolves.toBeUndefined();
  expect(activate).toHaveBeenLastCalledWith({
    normal: { itemId: v.challenge.itemId, text: '', locale: 'ja', slow: false },
    slow: { itemId: v.challenge.itemId, text: '', locale: 'ja', slow: true },
  });
});
it('[INV-AUD-06] Japanese audio shape missing reading remains refused and clears media', async () => {
  const activate = vi.fn(async () => {});
  await expect(
    createLessonMediaBinding(activate).synchronize(view('listenTypeWhatYouHear')),
  ).rejects.toThrow(/reading/i);
  expect(activate).toHaveBeenLastCalledWith(null);
});
it('[INV-AUD-06] explicit audio on otherwise silent recognition still needs exact reading', async () => {
  const v = view();
  const activate = vi.fn(async () => {});
  await expect(
    createLessonMediaBinding(activate).synchronize({
      ...v,
      challenge: { ...v.challenge, audioRef: 'clip' },
    }),
  ).rejects.toThrow(/reading/i);
});
it('[INV-SESS-27] exact source change while ordinary activation is pending keeps immutable captured requests', async () => {
  const v = view('listenTypeWhatYouHear');
  const calls: unknown[] = [];
  const activate = vi.fn(async (x: unknown) => {
    calls.push(x);
  });
  const binding = createLessonMediaBinding(activate);
  const spoken = { ...v, challenge: { ...v.challenge, audioRef: 'clip', audioText: 'ねこ' } };
  const pending = binding.synchronize(spoken);
  spoken.challenge.audioText = 'いぬ';
  await pending;
  expect(calls[0]).toMatchObject({ normal: { text: 'ねこ' }, slow: { text: 'ねこ' } });
});
it('[INV-SESS-27] validation and cleanup rejection both remain visible and next valid request retries', async () => {
  const activate = vi.fn(async () => {}).mockRejectedValueOnce(Error('cleanup'));
  const binding = createLessonMediaBinding(activate);
  await expect(binding.synchronize(view('listenTypeWhatYouHear'))).rejects.toBeInstanceOf(
    AggregateError,
  );
  const v = view('listenTypeWhatYouHear');
  await binding.synchronize({ ...v, challenge: { ...v.challenge, audioText: 'ねこ' } });
  expect(activate).toHaveBeenCalledTimes(2);
});

it('[INV-MOD-13] microphone-only Japanese speech keeps locale but invents no audio reading', async () => {
  const v = view('speakSentence');
  expect(exerciseSpec(v.challenge.type).requiresAudio).toBe(false);
  const activate = vi.fn(async () => {});
  await expect(createLessonMediaBinding(activate).synchronize(v)).resolves.toBeUndefined();
  expect(activate).toHaveBeenLastCalledWith({
    normal: { itemId: v.challenge.itemId, text: '', locale: 'ja', slow: false },
    slow: { itemId: v.challenge.itemId, text: '', locale: 'ja', slow: true },
  });
});
