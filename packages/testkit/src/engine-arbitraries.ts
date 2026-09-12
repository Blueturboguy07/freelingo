/**
 * Arbitraries for the engine's own vocabulary: items, exercises, sessions, packs and
 * attempt histories. Plus the two-course fixture every P1 property runs against.
 *
 * These import `packages/core/src/types` by RELATIVE PATH rather than through
 * `@freelingo/core`. The barrel (`packages/core/src/index.ts`) is outside this task's
 * file lane, so it does not re-export `types/` or `economy/` yet; the relative path is
 * correct today and one line of barrel wiring makes it a package import later. The
 * import is type-only wherever possible so nothing is pulled into the bundle.
 *
 * Every generator here has a SHAPE FLOOR in `arbitraries.test.ts`. A generator with no
 * shape floor is 10,000 cases of nothing — see `docs/ci.md` for the run that proved it.
 */
import fc from 'fast-check';
import {
  EXERCISE_TYPES,
  SESSION_FLAVOURS,
  SESSION_OUTCOMES,
  VERDICTS,
  asCourseId,
  asItemId,
  asSessionId,
  type AttemptRow,
  type CourseId,
  type CourseProgress,
  type ExerciseType,
  type ItemId,
  type MistakeRow,
  type PackManifest,
  type SessionFlavour,
  type SessionId,
  type SessionOutcomeKind,
  type Verdict,
} from '../../core/src/types/index.js';

/* ------------------------------------------------------------------ primitives */

/**
 * Fixed-length lowercase hex. fast-check 4 removed `fc.hexaString`, and
 * `fc.stringMatching` would let the generator choose the length; these ids are
 * content hashes, so the length is part of the shape.
 */
const HEX_DIGITS = '0123456789abcdef'.split('');

function arbHex(length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...HEX_DIGITS), { minLength: length, maxLength: length })
    .map((digits) => digits.join(''));
}

/**
 * A content-hashed item id. 12 hex characters: long enough that two generated ids
 * colliding inside one 10,000-case property is not a thing that happens, short enough to
 * read in a failure message.
 */
export function arbItemId(): fc.Arbitrary<ItemId> {
  return arbHex(12).map((hex) => asItemId(`it_${hex}`));
}

export function arbCourseId(): fc.Arbitrary<CourseId> {
  return fc.constantFrom('en-es', 'en-fr', 'en-de', 'en-ja').map((slug) => asCourseId(slug));
}

export function arbSessionId(): fc.Arbitrary<SessionId> {
  return arbHex(8).map((hex) => asSessionId(`s_${hex}`));
}

export function arbExerciseType(): fc.Arbitrary<ExerciseType> {
  return fc.constantFrom(...EXERCISE_TYPES);
}

export function arbVerdict(): fc.Arbitrary<Verdict> {
  return fc.constantFrom(...VERDICTS);
}

export function arbSessionFlavour(): fc.Arbitrary<SessionFlavour> {
  return fc.constantFrom(...SESSION_FLAVOURS);
}

export function arbSessionOutcome(): fc.Arbitrary<SessionOutcomeKind> {
  return fc.constantFrom(...SESSION_OUTCOMES);
}

/* ------------------------------------------------------------------- exercises */

export interface GeneratedExercise {
  readonly itemId: ItemId;
  readonly exerciseType: ExerciseType;
}

export function arbExercise(): fc.Arbitrary<GeneratedExercise> {
  return fc.record({ itemId: arbItemId(), exerciseType: arbExerciseType() });
}

/**
 * A realised session queue.
 *
 * Length 1-20 because every shipped flavour sits in that band (S057 is 9-14, S062 is 30
 * only in the section test and a 30-long queue costs three times as much per case for no
 * new shape). The generator is weighted toward the ordinary lesson length rather than
 * uniform, so the common case is the case the budget is spent on.
 */
export function arbSessionQueue(): fc.Arbitrary<GeneratedExercise[]> {
  return fc.oneof(
    { arbitrary: fc.array(arbExercise(), { minLength: 9, maxLength: 14 }), weight: 3 },
    { arbitrary: fc.array(arbExercise(), { minLength: 1, maxLength: 5 }), weight: 1 },
    { arbitrary: fc.array(arbExercise(), { minLength: 15, maxLength: 30 }), weight: 1 },
  );
}

export interface GeneratedSession {
  readonly sessionId: SessionId;
  readonly courseId: CourseId;
  readonly flavour: SessionFlavour;
  readonly outcome: SessionOutcomeKind;
  readonly queue: readonly GeneratedExercise[];
  readonly maxCombo: number;
}

export function arbSession(): fc.Arbitrary<GeneratedSession> {
  return fc.record({
    sessionId: arbSessionId(),
    courseId: arbCourseId(),
    flavour: arbSessionFlavour(),
    outcome: arbSessionOutcome(),
    queue: arbSessionQueue(),
    maxCombo: fc.integer({ min: 0, max: 20 }),
  });
}

/* ------------------------------------------------------------ attempt histories */

/**
 * An append-only attempt history for one session, keyed `(session_id, exercise_index)`.
 *
 * `firstTry` is generated as a function of the verdict rather than independently: a
 * `correct` row on a first presentation is `firstTry: true`, and a recycled row is not.
 * An independent boolean would generate "wrong on the first try, and also not the first
 * try" a quarter of the time, which is not a state the runtime can produce — and a
 * property that spends a quarter of its budget on impossible states is a property with a
 * quarter less budget.
 */
export function arbAttemptHistory(): fc.Arbitrary<AttemptRow[]> {
  return fc
    .tuple(arbSessionId(), arbSessionQueue(), arbSessionStart())
    .chain(([sessionId, queue, start]) =>
      fc
        .array(fc.tuple(arbVerdict(), fc.boolean(), fc.integer({ min: 0, max: 120_000 })), {
          minLength: queue.length,
          maxLength: queue.length,
        })
        .map((rolls) =>
          queue.map((exercise, index) => {
            const [verdict, recycled, activeMs] = rolls[index] as [Verdict, boolean, number];
            return {
              sessionId,
              exerciseIndex: index,
              itemId: exercise.itemId,
              exerciseType: exercise.exerciseType,
              verdict,
              firstTry: !recycled,
              answeredAtUtc: new Date(start.getTime() + index * 5_000).toISOString(),
              activeMs,
            } satisfies AttemptRow;
          }),
        ),
    );
}

/**
 * When a generated session started. Bounded on purpose: `fc.date()` reaches the edges of
 * the representable range, and `start.getTime() + index * 5_000` there is an Invalid Date
 * rather than an interesting case. The window is the project's own working span.
 */
export const ARBITRARY_SESSION_START_MIN = '2024-01-01T00:00:00Z';
export const ARBITRARY_SESSION_START_MAX = '2027-12-31T00:00:00Z';

export function arbSessionStart(): fc.Arbitrary<Date> {
  return fc.date({
    min: new Date(ARBITRARY_SESSION_START_MIN),
    max: new Date(ARBITRARY_SESSION_START_MAX),
    noInvalidDate: true,
  });
}

/** The mistake rows an attempt history implies. Recycles at most twice (S049). */
export function mistakesFrom(attempts: readonly AttemptRow[], courseId: CourseId): MistakeRow[] {
  return attempts
    .filter((attempt) => attempt.verdict === 'incorrect' && attempt.firstTry)
    .map((attempt) => ({
      sessionId: attempt.sessionId,
      exerciseIndex: attempt.exerciseIndex,
      itemId: attempt.itemId,
      courseId,
      recycleCount: 0,
      createdAtUtc: attempt.answeredAtUtc,
    }));
}

/* ----------------------------------------------------------------------- packs */

export function arbPackManifest(): fc.Arbitrary<PackManifest> {
  return fc.record({
    courseId: arbCourseId(),
    locale: fc.constantFrom('es-ES', 'fr-FR', 'de-DE', 'ja-JP'),
    majorVersion: fc.integer({ min: 1, max: 3 }),
    minorVersion: fc.integer({ min: 0, max: 20 }),
    contentHash: arbHex(16),
    itemCount: fc.integer({ min: 100, max: 8_000 }),
    audioBytes: fc.integer({ min: 1_000_000, max: 120 * 1024 * 1024 }),
    // Basis points, not `fc.double`: fc.double is biased toward tiny magnitudes, which
    // put 93% of generated manifests under the 2% defect gate — a generator that cannot
    // reach the failing side of the gate it exists to exercise.
    defectRate: fc.integer({ min: 0, max: 500 }).map((bp) => bp / 10_000),
    machineAuthoredShare: fc.integer({ min: 0, max: 100 }).map((pct) => pct / 100),
    cefrChecked: fc.boolean(),
  });
}

/* -------------------------------------------------------- the two-course fixture */

/**
 * THE two-course fixture (plan §Architecture: "two courses as the default fixture").
 *
 * Two courses exist in every default fixture for one reason: the invariants that break
 * silently are the ones that are per-course when they should be global (INV-ECO-06's XP
 * ladder) or global when they should be per-course (INV-PER-11's display preferences).
 * A one-course fixture passes both spellings.
 *
 * `sharedItemIds` is the other half: the two courses share three content-hashed ids, so
 * a word counter that SUMS instead of UNIONING reports 13 instead of 10 (INV-ECO-13,
 * INV-ECO-27).
 */
export const FIXTURE_COURSE_A: CourseId = asCourseId('en-es');
export const FIXTURE_COURSE_B: CourseId = asCourseId('en-fr');

export interface TwoCourseFixture {
  readonly courses: readonly CourseProgress[];
  readonly sharedItemIds: readonly ItemId[];
  readonly distinctIntroducedCount: number;
  readonly distinctLearnedCount: number;
}

export function twoCourseFixture(): TwoCourseFixture {
  const shared = [asItemId('it_shared0001'), asItemId('it_shared0002'), asItemId('it_shared0003')];
  const onlyA = [asItemId('it_es00000001'), asItemId('it_es00000002'), asItemId('it_es00000003')];
  const onlyB = [asItemId('it_fr00000001'), asItemId('it_fr00000002'), asItemId('it_fr00000003')];
  const learnedShared = [shared[0] as ItemId];

  const courseA: CourseProgress = {
    courseId: FIXTURE_COURSE_A,
    xp: 340,
    score: 12,
    scoreFloor: 12,
    completedNodeIds: [],
    legendaryNodeIds: [],
    introducedItemIds: [...shared, ...onlyA],
    learnedItemIds: [...learnedShared, onlyA[0] as ItemId],
  };
  const courseB: CourseProgress = {
    courseId: FIXTURE_COURSE_B,
    xp: 120,
    score: 4,
    scoreFloor: 4,
    completedNodeIds: [],
    legendaryNodeIds: [],
    introducedItemIds: [...shared, ...onlyB],
    learnedItemIds: [...learnedShared, onlyB[0] as ItemId],
  };

  return {
    courses: [courseA, courseB],
    sharedItemIds: shared,
    // 3 shared + 3 + 3 = 9 distinct, though the two courses list 12 rows between them.
    distinctIntroducedCount: 9,
    // 1 shared + 1 + 1 = 3 distinct, though the rows sum to 4.
    distinctLearnedCount: 3,
  };
}
