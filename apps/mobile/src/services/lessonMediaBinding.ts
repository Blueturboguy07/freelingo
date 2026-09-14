import { exerciseSpec } from '@freelingo/core/session';
import type { LearningSessionView } from '../db/learningRuntimePorts';
import type { LessonMediaPort } from '../lesson/ports';
import type { LessonMediaActivation } from '../native/expoLessonMedia';
type PlaybackRequest = Parameters<LessonMediaPort['play']>[0];
export type SavedLessonMediaActivation = LessonMediaActivation;
interface Projection {
  readonly key: string;
  readonly activation: SavedLessonMediaActivation | null;
}
const EMPTY: Projection = { key: 'null', activation: null };
function project(view: LearningSessionView | null): Projection {
  if (!view || !view.challenge || view.state.exited !== null) return EMPTY;
  const { state, challenge, exerciseId } = view;
  if (
    ![
      'loading',
      'challenge.idle',
      'challenge.armed',
      'grading',
      'banner.correct',
      'banner.softCorrect',
      'banner.wrong',
    ].includes(state.shellState)
  )
    return EMPTY;
  const queued = state.currentReplay?.item ?? state.core.queue[state.core.index];
  if (
    !queued ||
    queued.itemId !== challenge.itemId ||
    queued.type !== challenge.type ||
    !exerciseId.trim()
  )
    throw new Error('Media does not match its saved exercise.');
  // Match the actual LessonPlayer control contract. A text/mic-only source needs
  // its locale but must not invent TTS from display orthography or translated text.
  const audioVisible =
    exerciseSpec(challenge.type).requiresAudio || challenge.audioRef !== undefined;
  if (audioVisible && challenge.language.split('-')[0] === 'ja' && !challenge.audioText?.trim())
    throw new Error('The Japanese audio reading is unavailable.');
  const normal: PlaybackRequest = Object.freeze({
    itemId: challenge.itemId,
    ...(challenge.audioRef === undefined ? {} : { assetRef: challenge.audioRef }),
    text: audioVisible ? (challenge.audioText ?? challenge.prompt) : '',
    locale: challenge.language,
    slow: false,
  });
  const slowRef = audioVisible ? (challenge.slowAudioRef ?? challenge.audioRef) : undefined;
  const slow: PlaybackRequest = Object.freeze({
    ...normal,
    ...(slowRef === undefined ? {} : { assetRef: slowRef }),
    slow: true,
    ...(!audioVisible || challenge.slowAudioRef === undefined ? {} : { assetIsSlow: true }),
  });
  const activation = Object.freeze({ normal, slow });
  return {
    key: JSON.stringify([
      state.courseId,
      state.sessionId,
      exerciseId,
      queued.id,
      state.core.index,
      state.currentReplay?.phase ?? null,
      activation,
    ]),
    activation,
  };
}
/** One native resource owner calls this after durable transitions and before showing
 * their snapshots. Exact saved identity controls invalidation; typing never restarts
 * a player. Background/hidden surfaces synchronize null. A rejected activation is
 * not cached. No database, permission request, playback or recording starts here. */
export function createLessonMediaBinding(
  activate: (value: SavedLessonMediaActivation | null) => Promise<void>,
) {
  let tail: Promise<void> = Promise.resolve();
  let previous: string | undefined;
  return {
    synchronize(view: LearningSessionView | null): Promise<void> {
      let projection: Projection | undefined;
      let error: unknown;
      try {
        projection = project(view);
      } catch (reason) {
        error = reason;
      }
      const work = tail.then(async () => {
        if (!projection) {
          previous = undefined;
          try {
            await activate(null);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              'Saved media validation and cleanup failed.',
            );
          }
          previous = EMPTY.key;
          throw error;
        }
        if (projection.key === previous) return;
        previous = undefined;
        await activate(projection.activation);
        previous = projection.key;
      });
      tail = work.catch(() => undefined);
      return work;
    },
  };
}
