import type { Db, DbRow } from '@freelingo/schema';
import type { WordCounters } from '@freelingo/core/economy';
import type {
  VerifiedRuntimeItem,
  RuntimeLexicalBinding,
} from '../../../../packages/core/src/packs/runtime-item-types';
import { canonicalJson, contentHashItemId } from '../../../../packages/core/src/packs/items';
import { LearningDataError, SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
import { SqliteSessionStore } from './SqliteSessionStore';
import { isGradedAttempt } from '@freelingo/core/session';
import {
  MASTERY_STABILITY_DAYS,
  ITEM_KINDS,
  ANOMALY_KINDS,
  type SchedulerState,
  REVIEW_KINDS,
  rowKeyOf,
  asItemId,
} from '@freelingo/core/scheduler';
import type { LearningSchedulerTransition } from './learningTransitions';
export interface ObservedWordSource {
  readonly courseId: string;
  readonly packContentHash: string;
  readonly item: VerifiedRuntimeItem;
  readonly surfaceId: string;
}
export interface LearningWordInput {
  /** Actual outer-transaction load before applyEncounter/save, never reconstructed. */
  readonly schedulerBefore: SchedulerState;
  readonly courseId: string;
  readonly sessionId: string;
  readonly transitions: readonly LearningSchedulerTransition[];
}
export interface LearningWordPlan {
  readonly courseId: string;
  readonly sessionId: string;
  readonly before: WordCounters;
  readonly after: WordCounters;
  readonly newlyLearnedWordIds: readonly string[];
}
function fail(reason: string): never {
  throw new LearningDataError('Invalid word evidence: ' + reason);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fail(field);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(field);
  return value;
}
function timestamp(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(new Date(value).getTime())
  )
    return fail('timestamp');
  return value;
}
function parse(value: unknown, field: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text(value, field));
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return fail(field);
    return result as Record<string, unknown>;
  } catch {
    return fail(field);
  }
}
function bindingFor(item: VerifiedRuntimeItem, surfaceId: string): RuntimeLexicalBinding | null {
  const targets = item.schedulerSurfaces.filter(
    (s) => s.surfaceId === surfaceId && s.kind === 'lexeme',
  );
  if (!targets.length) return null;
  if (targets.length !== 1) return fail('ambiguous lexical target');
  const target = targets[0]!;
  const bindings = item.lexicalBindings.filter(
    (b) => b.schedulerItemId === target.itemId && b.surfaceId === surfaceId,
  );
  const b = bindings.length === 1 ? bindings[0] : undefined;
  if (
    !b ||
    b.lexemeId !== target.itemRef ||
    b.surface !== target.surface ||
    b.language !== target.language
  )
    return fail('lexical target identity');
  text(b.lemma, 'lemma');
  text(b.pos, 'POS');
  const semantic = b.semantic;
  if (
    Object.keys(semantic).sort().join(',') !==
      'grammarConcepts,graphemes,lexemes,preferredSurface,prompt,register' ||
    canonicalJson(semantic.lexemes) !== canonicalJson([b.lemma]) ||
    semantic.grammarConcepts.length !== 0 ||
    semantic.graphemes.length !== 0
  )
    return fail('lexical meaning');
  text(semantic.prompt, 'meaning prompt');
  text(semantic.preferredSurface, 'preferred surface');
  text(semantic.register, 'register');
  if (contentHashItemId(semantic) !== b.wordItemId) return fail('word content identity');
  if (
    typeof b.countable !== 'boolean' ||
    !['word', 'particle', 'bound-morpheme', 'character'].includes(b.classification) ||
    (b.countable && b.classification !== 'word')
  )
    return fail('countability classification');
  if (
    b.proof.sourceId !== item.proof.sourceId ||
    b.proof.sourceSha256 !== item.proof.sourceSha256 ||
    [b.proof.sourceSha256, b.proof.declarationSha256, b.proof.bindingSha256].some(
      (v) => !/^[0-9a-f]{64}$/.test(v),
    )
  )
    return fail('lexical source proof');
  return b;
}
function sameIdentity(row: DbRow, binding: RuntimeLexicalBinding): void {
  const proof = parse(row.introduction_evidence_json, 'introduction history');
  const prior = proof.binding as RuntimeLexicalBinding | undefined;
  if (
    canonicalJson(parse(row.semantic_json, 'semantic history')) !==
      canonicalJson(binding.semantic) ||
    row.countable !== Number(binding.countable) ||
    !prior ||
    prior.classification !== binding.classification ||
    prior.wordItemId !== binding.wordItemId
  )
    return fail('conflicting permanent word identity/countability');
}
/** Freelingo implementation policy, 2026-09-13: no measured numerical retirement
 * threshold exists. Reuse the scheduler's named 21-day mastery threshold; two
 * consecutive qualifying scheduled successes are necessary. Any wrong resets.
 */
export const WORD_LEARNING_POLICY = Object.freeze({
  stabilityDays: MASTERY_STABILITY_DAYS,
  successfulScheduledReviews: 2,
});
interface ReviewEvidence {
  readonly schemaVersion: 1;
  readonly wordItemId: string;
  readonly binding: RuntimeLexicalBinding;
  readonly transition: Omit<LearningSchedulerTransition, 'runtimeItem'> & {
    readonly source: Pick<VerifiedRuntimeItem, 'exerciseId' | 'itemId' | 'proof'>;
  };
}
interface PendingReview {
  readonly wordId: string;
  readonly sequence: number;
  readonly evidence: string;
  readonly at: number;
  readonly ordinal: number;
  readonly position: number;
}
interface PendingLearned {
  readonly wordId: string;
  readonly at: number;
  readonly evidence: string;
  readonly countable: boolean;
}
interface OwnedPlan {
  readonly fingerprint: string;
  readonly reviews: readonly PendingReview[];
  readonly learned: readonly PendingLearned[];
}
const WORD_READ_TABLES = [
  'account_word_state',
  'account_word',
  'account_word_learning',
  'account_word_review',
  'course_surface_exposure',
  'course_source_exposure',
  'course_item',
  'course_item_surface',
  'course_session_state',
  'course_session_context',
  'course_session_slot',
  'course_session_answer_receipt',
  'course_session_answer_target',
  'course_attempt',
  'course_attempt_target',
] as const;
/** JSON's Date codec runs BEFORE canonical object ordering; never erase FSRS instants. */
function snapshot(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)));
}
function sameSnapshot(a: unknown, b: unknown): boolean {
  return snapshot(a) === snapshot(b);
}
function fingerprint(db: Db): string {
  return canonicalJson([
    db.get('SELECT words_introduced,words_learned FROM account WHERE id=1'),
    ...WORD_READ_TABLES.map((table) => [
      table,
      db.all(`SELECT * FROM ${table}`).map(canonicalJson).sort(),
    ]),
  ]);
}
/** One word receives at most one qualifying review per physical parent answer.
 * Inspect its complete target group first: a wrong sibling for THAT SAME WORD resets
 * it; another word making the aggregate MATCH wrong does not erase correct targets. */
function firstQualifyingWindow(
  history: readonly ReviewEvidence[],
): readonly ReviewEvidence[] | null {
  const groups: ReviewEvidence[][] = [];
  for (const e of history) {
    const group = groups.at(-1),
      prior = group?.[0]?.transition,
      t = e.transition;
    if (prior?.sessionId === t.sessionId && prior.answerOrdinal === t.answerOrdinal) group!.push(e);
    else groups.push([e]);
  }
  let successful: ReviewEvidence[] = [];
  for (const group of groups) {
    if (group.some((e) => e.transition.target.grade === 1)) {
      successful = [];
      continue;
    }
    const scheduled = group.filter((e) => e.transition.review?.kind === 'scheduled');
    if (!scheduled.length) continue;
    if (
      scheduled.some(
        (e) =>
          e.transition.after === null ||
          e.transition.after.card.stability < WORD_LEARNING_POLICY.stabilityDays,
      )
    ) {
      successful = [];
      continue;
    }
    successful.push(scheduled.at(-1)!);
    if (successful.length === WORD_LEARNING_POLICY.successfulScheduledReviews) return successful;
  }
  return null;
}
function reviewEvidence(
  t: LearningSchedulerTransition,
  binding: RuntimeLexicalBinding,
): ReviewEvidence {
  const { runtimeItem, ...transition } = t;
  // Grading dictionaries may have millions of entries. Only immutable source identity,
  // declared lexical meaning and actual scalar/card review evidence belong in history.
  return {
    schemaVersion: 1,
    wordItemId: binding.wordItemId,
    binding,
    transition: {
      ...transition,
      source: {
        exerciseId: runtimeItem.exerciseId,
        itemId: runtimeItem.itemId,
        proof: runtimeItem.proof,
      },
    },
  };
}
function objectValue(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(where);
  return value as Record<string, unknown>;
}
function finite(value: unknown, where: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    return fail(where);
  return value;
}
function instant(value: unknown): number {
  if (value instanceof Date) return timestamp(value.getTime());
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail('FSRS date instant');
  return Date.parse(value);
}
function validateRow(value: unknown, itemId: string, surface: string): void {
  if (value === null) return;
  const r = objectValue(value, 'FSRS row'),
    card = objectValue(r.card, 'FSRS card');
  if (
    r.key !== rowKeyOf(asItemId(itemId), surface) ||
    r.itemId !== itemId ||
    r.surface !== surface ||
    !ITEM_KINDS.some((k) => k === r.kind) ||
    !Array.isArray(r.modalities) ||
    r.modalities.some((m) => typeof m !== 'string' || !m.trim()) ||
    (r.lastReviewKind !== null && !REVIEW_KINDS.some((k) => k === r.lastReviewKind))
  )
    return fail('FSRS row identity');
  finite(r.retrievability, 'retrievability', 0, 1);
  if (r.introducedAt !== null) instant(r.introducedAt);
  instant(card.due);
  if (card.last_review !== undefined) instant(card.last_review);
  finite(card.stability, 'stability', 0);
  finite(card.difficulty, 'difficulty', 0, 10);
  for (const key of ['elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses'])
    integer(card[key], 'card ' + key);
  if (![0, 1, 2, 3].includes(card.state as number)) return fail('FSRS state');
}
function validateReview(e: ReviewEvidence): void {
  const t = e.transition;
  timestamp(t.receipt.answeredAtUtcMs);
  integer(t.answerOrdinal, 'review ordinal');
  integer(t.targetPosition, 'review position');
  validateRow(t.before, t.target.itemId, t.target.surface);
  validateRow(t.after, t.target.itemId, t.target.surface);
  if (t.review !== null) {
    if (!REVIEW_KINDS.includes(t.review.kind) || !sameSnapshot(t.review.row, t.after))
      return fail('review result snapshot');
    finite(t.review.intervalDays, 'review interval', 0);
    finite(t.review.effectiveElapsedMs, 'effective elapsed', 0);
    finite(t.review.rawElapsedMs, 'raw elapsed');
    if (!Array.isArray(t.review.anomalies)) return fail('review anomalies');
    for (const anomaly of t.review.anomalies) {
      if (
        !ANOMALY_KINDS.includes(anomaly.kind) ||
        anomaly.rowKey !== rowKeyOf(asItemId(t.target.itemId), t.target.surface)
      )
        return fail('review anomaly');
      instant(anomaly.at);
      text(anomaly.note, 'anomaly note');
      if (anomaly.observedMs !== null) finite(anomaly.observedMs, 'observed elapsed');
      if (anomaly.usedMs !== null) finite(anomaly.usedMs, 'used elapsed');
    }
  } else if (!sameSnapshot(t.before, t.after)) return fail('card changed without review');
}
function storedBinding(word: DbRow): RuntimeLexicalBinding {
  const p = parse(word.introduction_evidence_json, 'introduction proof'),
    b = objectValue(p.binding, 'introduced binding') as unknown as RuntimeLexicalBinding;
  const observed = objectValue(p.observed, 'actual introduction'),
    source = objectValue(p.source, 'introduced source'),
    proof = objectValue(source.proof, 'introduced source proof');
  if (
    p.schemaVersion !== 1 ||
    word.word_item_id !== b.wordItemId ||
    contentHashItemId(b.semantic) !== b.wordItemId ||
    word.countable !== Number(b.countable) ||
    typeof b.countable !== 'boolean' ||
    !['word', 'particle', 'bound-morpheme', 'character'].includes(b.classification) ||
    (b.countable && b.classification !== 'word') ||
    canonicalJson(parse(word.semantic_json, 'introduced semantic')) !== canonicalJson(b.semantic) ||
    canonicalJson(b.semantic.lexemes) !== canonicalJson([b.lemma]) ||
    b.semantic.grammarConcepts.length !== 0 ||
    b.semantic.graphemes.length !== 0 ||
    observed.surface !== b.surface ||
    observed.language !== b.language ||
    observed.observed_at_utc_ms !== word.introduced_at_utc_ms ||
    source.exerciseId !== observed.exercise_id ||
    proof.sourceId !== b.proof.sourceId ||
    proof.sourceSha256 !== b.proof.sourceSha256 ||
    !['prompt', 'wrong-feedback'].includes(observed.display_role as string)
  )
    return fail('permanent introduction identity');
  timestamp(word.introduced_at_utc_ms);
  for (const value of [
    b.semantic.prompt,
    b.semantic.preferredSurface,
    b.semantic.register,
    b.lexemeId,
    b.lemma,
    b.pos,
    b.language,
    b.schedulerItemId,
    b.surfaceId,
    b.surface,
    observed.course_id,
    observed.session_id,
    observed.slot_id,
    observed.exercise_id,
    source.itemId,
    proof.approvalId,
  ])
    text(value, 'introduction source field');
  for (const value of [
    b.proof.sourceSha256,
    b.proof.declarationSha256,
    b.proof.bindingSha256,
    observed.pack_content_hash,
    proof.approvalSha256,
    proof.draftSha256,
  ])
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
      return fail('introduced source digest');
  return b;
}
function readHistory(db: Db, binding: RuntimeLexicalBinding): ReviewEvidence[] {
  return db
    .all('SELECT * FROM account_word_review WHERE word_item_id=? ORDER BY word_sequence', [
      binding.wordItemId,
    ])
    .map((row, index) => {
      if (row.word_sequence !== index) return fail('gapped word review chronology');
      const e = parse(row.evidence_json, 'word review history') as unknown as ReviewEvidence;
      const t = e.transition;
      if (
        e.schemaVersion !== 1 ||
        e.wordItemId !== binding.wordItemId ||
        !e.binding ||
        contentHashItemId(e.binding.semantic) !== binding.wordItemId ||
        canonicalJson(e.binding.semantic) !== canonicalJson(binding.semantic) ||
        e.binding.countable !== binding.countable ||
        e.binding.classification !== binding.classification ||
        !t ||
        t.sessionId !== row.source_session_id ||
        t.answerOrdinal !== row.answer_ordinal ||
        t.targetPosition !== row.target_position ||
        t.receipt.answeredAtUtcMs !== row.reviewed_at_utc_ms ||
        t.target.itemId !== e.binding.schedulerItemId ||
        t.target.surfaceId !== e.binding.surfaceId ||
        ![1, 3].includes(t.target.grade) ||
        !isGradedAttempt(t.answer) ||
        !t.wroteAttempt ||
        (t.review !== null &&
          (!REVIEW_KINDS.includes(t.review.kind) || !sameSnapshot(t.review.row, t.after)))
      )
        return fail('invalid permanent word review history');
      const source = objectValue(t.source, 'review source'),
        proof = objectValue(source.proof, 'review source proof');
      if (
        source.exerciseId !== t.receipt.exerciseId ||
        source.itemId !== t.answer.itemId ||
        t.receipt.itemId !== t.answer.itemId ||
        t.receipt.slotId !== t.answer.slotId ||
        t.receipt.exerciseIndex !== t.answer.exerciseIndex ||
        e.binding.surface !== t.target.surface ||
        proof.sourceId !== e.binding.proof.sourceId ||
        proof.sourceSha256 !== e.binding.proof.sourceSha256 ||
        !['recognition', 'production'].includes(t.target.role) ||
        typeof t.target.rubyShown !== 'boolean'
      )
        return fail('historical source/answer/receipt join');
      text(t.courseId, 'review source course');
      text(source.exerciseId, 'review exercise');
      text(source.itemId, 'review item');
      text(proof.approvalId, 'review approval');
      for (const digest of [
        t.packContentHash,
        proof.sourceSha256,
        proof.approvalSha256,
        proof.draftSha256,
        e.binding.proof.sourceSha256,
        e.binding.proof.declarationSha256,
        e.binding.proof.bindingSha256,
      ])
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
          return fail('historical source digest');
      const committed = db.get('SELECT session_id FROM committed_session WHERE session_id=?', [
        t.sessionId,
      ]);
      const linked = db.get('SELECT course_id FROM course_session_commit_link WHERE session_id=?', [
        t.sessionId,
      ]);
      // Removing a course destroys its link, but the global commit and full immutable
      // source evidence above survive. A still-present link must agree with that source.
      if (!committed || (linked && linked.course_id !== t.courseId))
        return fail('historical commit ownership');
      validateReview(e);
      return e;
    });
}
/** Account history is independent of course deletion. The caller owns an exclusive
 * transaction shared with the real display/answer writer; this store never opens a
 * nested transaction and never turns loading a verified item into an exposure.
 */
export class SqliteWordStore {
  private readonly plans = new WeakMap<LearningWordPlan, OwnedPlan>();
  constructor(private readonly db: Db) {}
  /** Only the native new-file creation path may supply this fact. Migration/restore
   * callers cannot infer it from zero scalar counters; legacy history stays unknown. */
  initializeFreshHistory(atUtcMs: number, proof: { readonly databaseWasCreated: true }): void {
    timestamp(atUtcMs);
    if (proof.databaseWasCreated !== true) return fail('new database creation proof');
    if (this.db.get('SELECT id FROM account_word_state'))
      return fail('history already initialized');
    const account = this.db.get(
      'SELECT words_introduced,words_learned,lifetime_xp FROM account WHERE id=1',
    );
    if (
      !account ||
      Object.values(account).some((v) => v !== 0) ||
      ['course_progress', 'committed_session', 'account_word', 'account_word_learning'].some((t) =>
        this.db.get(`SELECT 1 FROM ${t} LIMIT 1`),
      )
    )
      return fail('cannot invent legacy word history');
    this.db.run('INSERT INTO account_word_state VALUES(1,?)', [atUtcMs]);
  }
  /** Called after saving the actual scheduler targets, before global reward commit. */
  prepare(input: LearningWordInput): LearningWordPlan {
    const before = this.readCounters(),
      { courseId, sessionId, transitions } = input;
    if (this.db.get('SELECT session_id FROM committed_session WHERE session_id=?', [sessionId]))
      return fail('session already committed');
    if (!Array.isArray(transitions)) return fail('missing actual transitions');
    const state = new SqliteSessionStore(this.db)
      .forCourse(courseId)
      .find((s) => s.sessionId === sessionId);
    const contexts = new SqliteLearningContextStore(this.db),
      context = contexts.load(courseId, sessionId);
    if (!state || !context) return fail('missing live source checkpoint');
    const receipts = contexts.receipts(courseId, sessionId);
    if (receipts.length !== state.core.answers.length)
      return fail('incomplete source receipt history');
    const expected = this.db.all(
      'SELECT * FROM course_attempt_target WHERE course_id=? AND session_id=?',
      [courseId, sessionId],
    );
    const staged = this.db.all(
      'SELECT * FROM course_session_answer_target WHERE course_id=? AND session_id=?',
      [courseId, sessionId],
    );
    if (expected.length !== transitions.length || staged.length !== transitions.length)
      return fail('incomplete review target population');
    const histories = new Map<string, ReviewEvidence[]>(),
      learned: PendingLearned[] = [],
      reviews: PendingReview[] = [];
    const latest = new Map<string, LearningSchedulerTransition['after']>();
    let ordinal = -1,
      position = -1;
    for (const t of transitions) {
      integer(t.answerOrdinal, 'answer ordinal');
      integer(t.targetPosition, 'target position');
      timestamp(t.receipt.answeredAtUtcMs);
      const parent = this.db.get(
        'SELECT * FROM course_attempt WHERE session_id=? AND exercise_index=?',
        [sessionId, t.answer.exerciseIndex],
      );
      const target = contexts.targets(courseId, sessionId, t.answer.exerciseIndex)[
        t.targetPosition
      ];
      const actual = expected.find(
        (r) => r.exercise_index === t.answer.exerciseIndex && r.position === t.targetPosition,
      );
      if (
        t.courseId !== courseId ||
        t.sessionId !== sessionId ||
        t.packContentHash !== context.launch.packContentHash ||
        t.answerOrdinal < ordinal ||
        t.targetPosition !== (t.answerOrdinal === ordinal ? position + 1 : 0) ||
        !sameSnapshot(state.core.answers[t.answerOrdinal] ?? null, t.answer) ||
        !sameSnapshot(receipts[t.answerOrdinal] ?? null, t.receipt) ||
        !sameSnapshot(target ?? null, t.target) ||
        !isGradedAttempt(t.answer) ||
        !t.wroteAttempt ||
        ![1, 3].includes(t.target.grade) ||
        t.runtimeItem.exerciseId !== t.receipt.exerciseId ||
        t.runtimeItem.itemId !== t.answer.itemId ||
        !parent ||
        parent.course_id !== courseId ||
        parent.exercise_id !== t.receipt.exerciseId ||
        parent.pack_content_hash !== t.packContentHash ||
        !actual ||
        actual.target_item_id !== t.target.itemId ||
        actual.target_surface_id !== t.target.surfaceId ||
        actual.target_surface !== t.target.surface ||
        actual.grade !== t.target.grade ||
        actual.encounter_role !== t.target.role ||
        actual.ruby_shown !== Number(t.target.rubyShown) ||
        actual.answered_at_utc_ms !== t.receipt.answeredAtUtcMs ||
        actual.review_kind !== (t.review?.kind ?? 'uncredited')
      )
        return fail('review source/target identity or order');
      ordinal = t.answerOrdinal;
      position = t.targetPosition;
      const key = rowKeyOf(asItemId(t.target.itemId), t.target.surface);
      if (
        !sameSnapshot(
          latest.has(key) ? latest.get(key) : (input.schedulerBefore.rows.get(key) ?? null),
          t.before,
        )
      )
        return fail('review card chronology changed');
      for (const row of [t.before, t.after]) {
        if (
          row !== null &&
          (row.key !== key ||
            row.itemId !== t.target.itemId ||
            row.surface !== t.target.surface ||
            !Number.isFinite(row.card.stability) ||
            row.card.stability < 0)
        )
          return fail('review card identity or stability');
      }
      if (
        t.review !== null
          ? !REVIEW_KINDS.includes(t.review.kind) || !sameSnapshot(t.review.row, t.after)
          : !sameSnapshot(t.before, t.after)
      )
        return fail('review result/card mismatch');
      latest.set(key, t.after);
      const binding = bindingFor(t.runtimeItem, t.target.surfaceId);
      if (!binding) continue;
      if (binding.schedulerItemId !== t.target.itemId) return fail('word target changed');
      const word = this.db.get('SELECT * FROM account_word WHERE word_item_id=?', [
        binding.wordItemId,
      ]);
      if (!word) return fail('reviewed word has no actual introduction');
      sameIdentity(word, binding);
      const item = this.db.get(
        'SELECT quarantined FROM course_item WHERE course_id=? AND item_id=?',
        [courseId, t.target.itemId],
      );
      if (!item || item.quarantined !== 0) return fail('quarantined word review');
      const history = histories.get(binding.wordItemId) ?? readHistory(this.db, binding);
      const evidence = reviewEvidence(t, binding);
      validateReview(evidence);
      reviews.push({
        wordId: binding.wordItemId,
        sequence: history.length,
        evidence: snapshot(evidence),
        at: t.receipt.answeredAtUtcMs,
        ordinal: t.answerOrdinal,
        position: t.targetPosition,
      });
      histories.set(binding.wordItemId, [...history, evidence]);
    }
    for (const [wordId, history] of histories) {
      const qualified = firstQualifyingWindow(history);
      if (
        qualified !== null &&
        !this.db.get('SELECT 1 FROM account_word_learning WHERE word_item_id=?', [wordId])
      ) {
        const last = qualified.at(-1)!;
        learned.push({
          wordId,
          at: last.transition.receipt.answeredAtUtcMs,
          countable: last.binding.countable,
          evidence: snapshot({
            schemaVersion: 1,
            policy: WORD_LEARNING_POLICY,
            reviews: qualified,
          }),
        });
      }
    }
    const saved = new SqliteSchedulerStore(this.db).load(
      courseId,
      context.launch.start.startZone.tzId,
    );
    for (const [key, row] of latest)
      if (!sameSnapshot(saved.rows.get(key as NonNullable<typeof row>['key']) ?? null, row))
        return fail('saved final review card changed');
    const after = Object.freeze({
      ...before,
      wordsLearned: before.wordsLearned + learned.filter((w) => w.countable).length,
    });
    const plan = Object.freeze({
      courseId,
      sessionId,
      before,
      after,
      newlyLearnedWordIds: Object.freeze(learned.map((w) => w.wordId)),
    });
    this.plans.set(plan, { fingerprint: fingerprint(this.db), reviews, learned });
    return plan;
  }
  /** Same owning store and scoped DB; the global commit/archive must already exist. */
  apply(plan: LearningWordPlan): WordCounters {
    const owned = this.plans.get(plan);
    if (!owned) return fail('unknown or consumed review plan');
    const committed = this.db.get(
      'SELECT l.course_id FROM committed_session s JOIN course_session_commit_link l ON l.session_id=s.session_id WHERE s.session_id=?',
      [plan.sessionId],
    );
    if (!committed || committed.course_id !== plan.courseId)
      return fail('missing committed word session');
    if (fingerprint(this.db) !== owned.fingerprint) return fail('stale word facts changed');
    for (const r of owned.reviews)
      this.db.run('INSERT INTO account_word_review VALUES(?,?,?,?,?,?,?)', [
        r.wordId,
        r.sequence,
        plan.sessionId,
        r.ordinal,
        r.position,
        r.at,
        r.evidence,
      ]);
    for (const w of owned.learned)
      this.db.run('INSERT INTO account_word_learning VALUES(?,?,?,?)', [
        w.wordId,
        w.at,
        plan.sessionId,
        w.evidence,
      ]);
    this.db.run('UPDATE account SET words_introduced=?,words_learned=? WHERE id=1', [
      plan.after.wordsIntroduced,
      plan.after.wordsLearned,
    ]);
    const result = this.readCounters();
    if (!sameSnapshot(result, plan.after)) return fail('applied word counters changed');
    this.plans.delete(plan);
    return result;
  }
  readCounters(): WordCounters {
    const header = this.db.get('SELECT * FROM account_word_state WHERE id=1');
    if (!header) return fail('unknown word history');
    timestamp(header.initialized_at_utc_ms);
    let wordsIntroduced = 0,
      wordsLearned = 0;
    for (const word of this.db.all('SELECT * FROM account_word')) {
      const binding = storedBinding(word),
        history = readHistory(this.db, binding);
      if (binding.countable) wordsIntroduced++;
      const learned = this.db.get('SELECT * FROM account_word_learning WHERE word_item_id=?', [
        binding.wordItemId,
      ]);
      const first = firstQualifyingWindow(history);
      if ((first !== null) !== (learned !== undefined))
        return fail('learned history/claim mismatch');
      if (learned) {
        const expected = { schemaVersion: 1, policy: WORD_LEARNING_POLICY, reviews: first };
        if (
          !first ||
          snapshot(parse(learned.evidence_json, 'learned proof')) !== snapshot(expected) ||
          learned.source_session_id !== first.at(-1)!.transition.sessionId ||
          learned.learned_at_utc_ms !== first.at(-1)!.transition.receipt.answeredAtUtcMs
        )
          return fail('invalid learned proof');
        if (binding.countable) wordsLearned++;
      }
    }
    const result = { wordsIntroduced, wordsLearned };
    const cache = this.db.get('SELECT words_introduced,words_learned FROM account WHERE id=1');
    if (
      !cache ||
      cache.words_introduced !== result.wordsIntroduced ||
      cache.words_learned !== result.wordsLearned
    )
      return fail('word counter cache needs reconciliation');
    return Object.freeze(result);
  }
  recordIntroduction(source: ObservedWordSource): WordCounters {
    const before = this.readCounters();
    const { courseId, packContentHash, item, surfaceId } = source;
    if (
      !/^[0-9a-f]{64}$/.test(packContentHash) ||
      this.db.get('SELECT pack_content_hash FROM course_progress WHERE course_id=?', [courseId])
        ?.pack_content_hash !== packContentHash
    )
      return fail('observed pack identity');
    // Later exercises can teach the same full surface under another lexical source.
    // Prefer that exact actual callback receipt. The first observation remains usable
    // only when its own exercise and pack match below; migration never backfills it.
    const observed =
      this.db.get(
        'SELECT * FROM course_source_exposure WHERE course_id=? AND surface_id=? AND exercise_id=? AND pack_content_hash=?',
        [courseId, surfaceId, item.exerciseId, packContentHash],
      ) ??
      this.db.get('SELECT * FROM course_surface_exposure WHERE course_id=? AND surface_id=?', [
        courseId,
        surfaceId,
      ]);
    if (
      !observed ||
      observed.exercise_id !== item.exerciseId ||
      observed.pack_content_hash !== packContentHash ||
      !item.introductions.some(
        (i) =>
          i.surfaceId === surfaceId &&
          i.surface === observed.surface &&
          i.language === observed.language &&
          i.when === observed.display_role,
      )
    )
      return fail('missing exact observed source');
    timestamp(observed.observed_at_utc_ms);
    const binding = bindingFor(item, surfaceId);
    if (!binding) return before;
    if (binding.surface !== observed.surface || binding.language !== observed.language)
      return fail('observed lexical surface');
    for (const id of new Set([item.itemId, binding.schedulerItemId])) {
      const target = this.db.get(
        'SELECT quarantined FROM course_item WHERE course_id=? AND item_id=?',
        [courseId, id],
      );
      if (!target || target.quarantined !== 0) return fail('missing or quarantined word target');
    }
    const old = this.db.get('SELECT * FROM account_word WHERE word_item_id=?', [
      binding.wordItemId,
    ]);
    if (old) {
      sameIdentity(old, binding);
      return before;
    }
    this.db.run('INSERT INTO account_word VALUES(?,?,?,?,?,1)', [
      binding.wordItemId,
      canonicalJson(binding.semantic),
      Number(binding.countable),
      observed.observed_at_utc_ms,
      canonicalJson({
        schemaVersion: 1,
        binding,
        observed,
        source: { exerciseId: item.exerciseId, itemId: item.itemId, proof: item.proof },
      }),
    ]);
    this.db.run('UPDATE account SET words_introduced=words_introduced+? WHERE id=1', [
      Number(binding.countable),
    ]);
    return this.readCounters();
  }
}
