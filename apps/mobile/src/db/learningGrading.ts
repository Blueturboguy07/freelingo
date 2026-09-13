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
  matchRuntime,
  type Answer,
  type GradeRequest,
  type Verdict,
} from '@freelingo/core/session';
import { roleOfExerciseType, type Grade } from '@freelingo/core/scheduler';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import { LearningDataError, type SchedulerTargetEvidence } from './SqliteSchedulerStore';

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
  /** Actual accepted response ID, including the sole supported gap checker result. */
  readonly responseSurfaceId: string | null;
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
  let gapSurfaceId: string | null = null;
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
      const result = gradeMultiGap({ ...base, answers });
      feedback = result.verdict;
      if (result.perGap.length === 1) gapSurfaceId = result.perGap[0]!.matchedSurfaceId;
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
  return {
    session: { kind, ...(note === null ? {} : { note }) },
    feedback,
    responseSurfaceId: item.family === 'gap-fill' ? gapSurfaceId : feedback.matchedSurfaceId,
  };
}

export interface TargetSelectionEvidence {
  readonly targetLanguage: string;
  readonly rubyShown: boolean;
  readonly responseSurfaceId: string | null;
  readonly partialState: Readonly<Record<string, unknown>>;
}
/** Exact-checker families must retain the actual accepted ID; other families have
 * explicitly nonmatching success evidence (ordered characters, trace, open response). */
const EXACT_RESPONSE_FAMILIES = new Set([
  'typed-translate',
  'select',
  'word-bank',
  'listening',
  'gap-fill',
]);
export function targetsForRuntimeAnswer(
  runtime: VerifiedRuntimeItem,
  answer: Answer,
  proof: TargetSelectionEvidence,
): readonly SchedulerTargetEvidence[] {
  const grade = schedulerGradeFor(answer);
  if (grade === null) return [];
  if (
    answer.itemId !== runtime.itemId ||
    answer.type !== runtime.presentation.type ||
    answer.wrong !== (answer.verdict === 'wrong')
  )
    throw new LearningDataError('Answer target source binding changed.');
  const role = roleOfExerciseType(answer.type);
  const select = (
    itemId: string,
    surfaceId: string | null,
    rating: Grade,
  ): SchedulerTargetEvidence => {
    const available = runtime.schedulerSurfaces.filter((surface) => surface.itemId === itemId);
    const canonical = available.filter((surface) => surface.canonical);
    if (
      canonical.length !== 1 ||
      available.some((surface) => surface.language !== proof.targetLanguage)
    )
      throw new LearningDataError('Target canonical surface is undeclared.');
    const found =
      surfaceId === null
        ? canonical
        : available.filter((surface) => surface.surfaceId === surfaceId);
    if (found.length !== 1)
      throw new LearningDataError('The matched target surface is unavailable.');
    const selected = found[0]!;
    return {
      itemId,
      surfaceId: selected.surfaceId,
      surface: selected.surface,
      role,
      rubyShown: proof.rubyShown,
      grade: rating,
    };
  };
  if (runtime.gradable.family === 'match') {
    const pairs = runtime.presentation.pairs ?? [];
    const match = matchRuntime(proof.partialState, pairs);
    if (
      !pairs.length ||
      match === null ||
      match.taps.length === 0 ||
      answer.costPaid !== match.paid ||
      answer.wrong !== match.paid > 0
    )
      throw new LearningDataError('Actual match target history is unavailable.');
    // A pip-limited grid may finish early. Untouched LEFT items receive no encounter.
    return pairs.flatMap((pair) => {
      const taps = match.taps.filter((tap) => tap.leftItemId === pair.leftItemId);
      if (!taps.length) return [];
      const wrong = taps.some((tap) => tap.wrong);
      if (!wrong && !match.matchedLeftIds.includes(pair.leftId))
        throw new LearningDataError('Unfinished match target.');
      return [
        select(
          pair.leftItemId,
          null,
          wrong ? LEARNING_GRADE_POLICY.wrong : LEARNING_GRADE_POLICY.accepted,
        ),
      ];
    });
  }
  if (
    !answer.wrong &&
    EXACT_RESPONSE_FAMILIES.has(runtime.gradable.family) &&
    proof.responseSurfaceId === null
  )
    throw new LearningDataError('The exact checker lost its matched surface identity.');
  const matched =
    !answer.wrong && runtime.responseLanguage === proof.targetLanguage
      ? proof.responseSurfaceId
      : null;
  return [select(runtime.itemId, matched, grade)];
}
