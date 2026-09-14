// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { freshSession, item } from '@freelingo/core/session';
import type { LearningSessionView } from '../db/learningRuntimePorts';
import { createLessonMediaBinding } from './lessonMediaBinding';
function view(): LearningSessionView {
  const queued = item(1, { type: 'listenTypeWhatYouHear' });
  return {
    exerciseId: 'exercise-1',
    state: { ...freshSession({ queue: [queued] }), shellState: 'challenge.idle' },
    challenge: {
      itemId: queued.itemId,
      type: queued.type,
      instruction: 'Listen',
      prompt: 'hola',
      language: 'es',
      acceptedAnswers: ['hola'],
      audioRef: 'normal',
      slowAudioRef: 'slow',
    },
  };
}
it('[INV-AUD-01][INV-AUD-06] binds exact normal and separately baked slow requests with the pack reading', async () => {
  const activate = vi.fn(async () => {}),
    binding = createLessonMediaBinding(activate),
    current = view();
  await binding.synchronize({
    ...current,
    challenge: { ...current.challenge!, language: 'ja', prompt: '三本', audioText: 'さんぼん' },
  });
  expect(activate).toHaveBeenCalledWith({
    normal: {
      itemId: current.challenge!.itemId,
      assetRef: 'normal',
      text: 'さんぼん',
      locale: 'ja',
      slow: false,
    },
    slow: {
      itemId: current.challenge!.itemId,
      assetRef: 'slow',
      text: 'さんぼん',
      locale: 'ja',
      slow: true,
      assetIsSlow: true,
    },
  });
});
it('[INV-SESS-27][INV-AUD-06] typing and a repeated snapshot do not restart an unchanged media lease', async () => {
  const activate = vi.fn(async () => {}),
    binding = createLessonMediaBinding(activate),
    current = view();
  await binding.synchronize(current);
  await binding.synchronize({
    ...current,
    state: {
      ...current.state,
      shellState: 'challenge.armed',
      inFlight: { ...current.state.inFlight, text: 'hola', caret: 4 },
    },
  });
  expect(activate).toHaveBeenCalledOnce();
});
it('[INV-SESS-27] session, slot and pack-variant changes each invalidate an otherwise identical item', async () => {
  const activate = vi.fn(async () => {}),
    binding = createLessonMediaBinding(activate),
    current = view();
  await binding.synchronize(current);
  const other = { ...current, state: { ...current.state, sessionId: 'different-session' } };
  await binding.synchronize(other);
  const slot = {
    ...other,
    state: {
      ...other.state,
      core: { ...other.state.core, queue: [{ ...other.state.core.queue[0]!, id: 'other-slot' }] },
    },
  };
  await binding.synchronize(slot);
  await binding.synchronize({ ...slot, exerciseId: 'other-exercise' });
  expect(activate).toHaveBeenCalledTimes(4);
});
it('[INV-AUD-06] slow playback uses the normal take and native slowdown only when no slow asset is declared', async () => {
  const activate = vi.fn(async () => {}),
    binding = createLessonMediaBinding(activate),
    current = view();
  const { slowAudioRef: removed, ...challenge } = current.challenge!;
  void removed;
  await binding.synchronize({ ...current, challenge });
  expect(activate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      slow: {
        itemId: challenge.itemId,
        assetRef: 'normal',
        text: 'hola',
        locale: 'es',
        slow: true,
      },
    }),
  );
});
it('[INV-SESS-27] hidden shell and null session release media; return to the same exercise reacquires it', async () => {
  const activate = vi.fn(async () => {}),
    binding = createLessonMediaBinding(activate),
    current = view();
  await binding.synchronize(current);
  await binding.synchronize({
    ...current,
    state: { ...current.state, shellState: 'interstitial' },
  });
  expect(activate).toHaveBeenLastCalledWith(null);
  await binding.synchronize(null);
  expect(activate).toHaveBeenCalledTimes(2);
  await binding.synchronize(current);
  expect(activate).toHaveBeenCalledTimes(3);
});
it('[INV-PACK-52] missing Japanese reading and mismatched saved item stop stale media and refuse fabricated identity', async () => {
  const activate = vi.fn(async () => {}),
    binding = createLessonMediaBinding(activate),
    current = view();
  await binding.synchronize(current);
  await expect(
    binding.synchronize({ ...current, challenge: { ...current.challenge!, language: 'ja' } }),
  ).rejects.toThrow(/reading/i);
  expect(activate).toHaveBeenLastCalledWith(null);
  await expect(
    binding.synchronize({
      ...current,
      challenge: { ...current.challenge!, itemId: 'another-item' },
    }),
  ).rejects.toThrow(/saved/i);
  expect(activate).toHaveBeenLastCalledWith(null);
});
it('[INV-SESS-27] failed native activation is never cached as completed and the same exact binding can retry', async () => {
  const activate = vi.fn(async () => {}).mockRejectedValueOnce(Error('native failed')),
    binding = createLessonMediaBinding(activate),
    current = view();
  await expect(binding.synchronize(current)).rejects.toThrow('native failed');
  await binding.synchronize(current);
  expect(activate).toHaveBeenCalledTimes(2);
});
it('[INV-SESS-27] concurrent binding requests drain old cleanup before enabling the latest saved source', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const activate = vi.fn(async () => {}).mockImplementationOnce(() => gate),
    binding = createLessonMediaBinding(activate),
    current = view();
  const first = binding.synchronize(current),
    second = binding.synchronize(null);
  await Promise.resolve();
  await Promise.resolve();
  expect(activate).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(activate).toHaveBeenLastCalledWith(null);
});
