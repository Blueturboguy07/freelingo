import {
  gradeTypedAnswer,
  gradeListening,
  gradeWordBank,
  gradeMultiGap,
  gradeCharacterSelect,
  gradeOpenResponse,
  type LearnerSurfaceState,
  type Verdict as GradingVerdict,
} from '@freelingo/core/grading';
import {
  isGradedAttempt,
  type Answer,
  type GradeRequest,
  type Verdict,
} from '@freelingo/core/session';
import type { Grade } from '@freelingo/core/scheduler';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import { LearningDataError } from './SqliteSchedulerStore';

/** Application integration policy, approved 2026-09-13. This is not a measured
 * Duolingo rating: no latency/typo inference invents a Hard or Easy response. */
export const LEARNING_GRADE_POLICY = { wrong: 1, accepted: 3 } as const;
export function schedulerGradeFor(answer: Answer): Grade | null {
  if (!isGradedAttempt(answer)) return null;
  switch (answer.verdict) {
    case 'wrong':
      return LEARNING_GRADE_POLICY.wrong;
    case 'correct':
    case 'softCorrect':
    case 'accepted':
      return LEARNING_GRADE_POLICY.accepted;
    default:
      throw new LearningDataError('Undeclared scheduler verdict.');
  }
}
export interface RuntimeGrade {
  readonly session: Verdict;
  /** The actual checker result remains available for feedback/source attribution. */
  readonly feedback: GradingVerdict;
}
function tileIds(value: unknown, allowed: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((id) => typeof id !== 'string' || !allowed.includes(id)) ||
    new Set(value).size !== value.length ||
    Object.keys(value).length !== value.length
  )
    throw new LearningDataError('The answer must use the exact available tile IDs.');
  return value as string[];
}
/** No accepted-answer fallback. All fields come from the repository's verified item;
 * the caller checks its exact exercise/pack receipt before entering this dispatcher. */
export function gradeRuntimeItem(
  runtime: VerifiedRuntimeItem,
  request: GradeRequest,
  learner: LearnerSurfaceState,
): RuntimeGrade {
  if (
    runtime.itemId !== request.item.itemId ||
    runtime.gradable.itemId !== runtime.itemId ||
    runtime.presentation.itemId !== runtime.itemId ||
    runtime.presentation.type !== request.item.type
  )
    throw new LearningDataError('The runtime item binding changed before grading.');
  const item = runtime.gradable;
  const base = { pack: runtime.grading.pack, unit: runtime.grading.unit, item, learner };
  let feedback: GradingVerdict;
  switch (item.family) {
    case 'typed-translate':
      feedback = gradeTypedAnswer({ ...base, answer: request.raw });
      break;
    case 'listening':
      feedback = gradeListening({ ...base, answer: request.raw });
      break;
    case 'select': {
      const option = runtime.presentation.options?.find(
        (o) => o.id === request.partialState['selectedOptionId'],
      );
      if (!option) throw new LearningDataError('The selected option is not in this exercise.');
      feedback = gradeTypedAnswer({ ...base, answer: option.text });
      break;
    }
    case 'word-bank': {
      const selected = tileIds(
        request.partialState['selectedTileIds'],
        (item.tiles ?? []).map((t) => t.tileId),
      );
      feedback = gradeWordBank({ ...base, tappedTileIds: selected });
      break;
    }
    case 'gap-fill': {
      const gaps = item.gaps;
      if (!gaps?.length) throw new LearningDataError('The exercise has no declared gaps.');
      let answers: readonly string[];
      if (request.item.type === 'gapFillSelect') {
        const option = runtime.presentation.options?.find(
          (o) => o.id === request.partialState['selectedOptionId'],
        );
        if (!option || gaps.length !== 1)
          throw new LearningDataError('The gap option binding is unavailable.');
        answers = [option.text];
      } else {
        const value = request.partialState['gapAnswers'];
        if (value === undefined && gaps.length === 1) answers = [request.raw];
        else {
          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Object.keys(value).length !== gaps.length ||
            gaps.some(
              (g) =>
                !Object.hasOwn(value, g.gapId) ||
                typeof (value as Record<string, unknown>)[g.gapId] !== 'string',
            )
          )
            throw new LearningDataError('Each declared gap needs its exact authored answer ID.');
          answers = gaps.map((g) => (value as Record<string, string>)[g.gapId]!);
        }
      }
      feedback = gradeMultiGap({ ...base, answers }).verdict;
      break;
    }
    case 'character-select': {
      if (!item.orderedTileIds?.length)
        throw new LearningDataError('The character order is undeclared.');
      const taps = tileIds(
        request.partialState['selectedTileIds'],
        (item.tiles ?? []).map((t) => t.tileId),
      );
      feedback = gradeCharacterSelect(item, { taps, armed: true, heartsSpentOnTaps: 0 });
      break;
    }
    case 'read-and-respond':
    case 'listen-and-respond':
      feedback = gradeOpenResponse({ ...base, reply: request.raw, path: 'keyword-length' });
      break;
    case 'speaking':
      throw new LearningDataError('Verified speech token grading is unavailable.');
    case 'match':
    case 'character-trace':
      throw new LearningDataError(
        'The session engine must grade the verified pair/stroke event history.',
      );
  }
  const kind: Verdict['kind'] =
    !feedback.writesAttemptRow || feedback.verdictClass === 'no-verdict'
      ? 'noVerdict'
      : feedback.wrong
        ? 'wrong'
        : feedback.softCorrected
          ? 'softCorrect'
          : item.family === 'read-and-respond' || item.family === 'listen-and-respond'
            ? 'accepted'
            : 'correct';
  const note = feedback.note ?? feedback.advisories[0] ?? feedback.notArmedReason;
  return { session: { kind, ...(note === null ? {} : { note }) }, feedback };
}
