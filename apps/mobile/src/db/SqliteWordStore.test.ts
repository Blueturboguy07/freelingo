// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { contentHashItemId } from '../../../../packages/core/src/packs/items';
import type {
  VerifiedRuntimeItem,
  RuntimeLexicalBinding,
} from '../../../../packages/core/src/packs/runtime-item-types';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import { SqliteWordStore } from './SqliteWordStore';
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});
const hash = 'a'.repeat(64);
const at = Date.parse('2026-09-13T12:00:00Z');
function runtime(patch: Partial<RuntimeLexicalBinding> = {}): VerifiedRuntimeItem {
  const semantic = {
    prompt: 'a domestic feline',
    preferredSurface: 'gato',
    register: 'neutral',
    lexemes: ['gato'],
    grammarConcepts: [],
    graphemes: [],
  };
  const binding: RuntimeLexicalBinding = {
    schedulerItemId: 'aggregate-cat',
    surfaceId: 'sf:cat',
    surface: 'el gato',
    language: 'es',
    lexemeId: 'lx:gato:NOUN',
    lemma: 'gato',
    pos: 'NOUN',
    wordItemId: contentHashItemId(semantic),
    semantic,
    countable: true,
    classification: 'word',
    proof: {
      sourceId: 'source-cat',
      sourceSha256: hash,
      declarationSha256: hash,
      bindingSha256: hash,
    },
    ...patch,
  };
  return {
    schemaVersion: 1,
    exerciseId: 'exercise-cat',
    itemId: 'aggregate-cat',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: 'source-cat',
      sourceSha256: hash,
      approvalId: 'review-cat',
      approvalSha256: hash,
      draftSha256: hash,
    },
    gradable: {
      itemId: 'aggregate-cat',
      family: 'typed-translate',
      accepted: [{ surface: 'el gato', surfaceId: 'sf:cat', rank: 1 }],
    },
    presentation: {
      itemId: 'aggregate-cat',
      type: 'typedTranslate',
      instruction: 'Translate',
      prompt: 'the cat',
      promptLanguage: 'en',
      language: 'es',
      acceptedAnswers: ['el gato'],
    },
    schedulerSurfaces: [
      {
        itemId: binding.schedulerItemId,
        surfaceId: binding.surfaceId,
        surface: binding.surface,
        language: binding.language,
        kind: 'lexeme',
        itemRef: binding.lexemeId,
        canonical: true,
      },
    ],
    introductions: [
      {
        surfaceId: binding.surfaceId,
        surface: binding.surface,
        language: binding.language,
        when: 'wrong-feedback',
      },
    ],
    lexicalBindings: [binding],
    explanation: 'Cat',
    grading: { pack: ES_PACK, unit: ES_UNIT, profileId: 'es', responseLanguage: 'es' },
  };
}
function setup(initialize = true) {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  const words = new SqliteWordStore(db);
  if (initialize) words.initializeFreshHistory(at, { databaseWasCreated: true });
  db.run(
    "INSERT INTO course_progress(course_id,added_at,pack_content_hash) VALUES('en-es','2026-09-13',?)",
    [hash],
  );
  db.run(
    "INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES('en-es','aggregate-cat',0,0)",
  );
  return { db, words };
}
function display(db: Db, courseId = 'en-es') {
  db.run('INSERT INTO course_surface_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
    courseId,
    'sf:cat',
    'el gato',
    'es',
    'observed-session',
    'observed-slot',
    'exercise-cat',
    hash,
    'wrong-feedback',
    at + 1,
  ]);
}
function source(item = runtime(), courseId = 'en-es') {
  return { courseId, packContentHash: hash, item, surfaceId: 'sf:cat' };
}
it('[INV-ECO-27][INV-SCH-11] source loading alone introduces nothing; an exact actual display introduces one word', () => {
  const { db, words } = setup();
  const item = runtime();
  expect(words.readCounters()).toEqual({ wordsIntroduced: 0, wordsLearned: 0 });
  expect(() => words.recordIntroduction(source(item))).toThrow(/observ/i);
  display(db);
  expect(words.recordIntroduction(source(item))).toEqual({ wordsIntroduced: 1, wordsLearned: 0 });
  expect(db.get('SELECT introduced_at_utc_ms FROM account_word')!.introduced_at_utc_ms).toBe(
    at + 1,
  );
});
it('[INV-ECO-13][INV-ECO-27] repeated exposure and a second course union the reviewed semantic identity and survive removal', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  words.recordIntroduction(source());
  db.run(
    "INSERT INTO course_progress(course_id,added_at,pack_content_hash) VALUES('en-fr','2026-09-13',?)",
    [hash],
  );
  db.run(
    "INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES('en-fr','aggregate-cat',0,0)",
  );
  display(db, 'en-fr');
  words.recordIntroduction(source(runtime(), 'en-fr'));
  db.run('DELETE FROM course_progress');
  expect(new SqliteWordStore(db).readCounters()).toEqual({ wordsIntroduced: 1, wordsLearned: 0 });
  expect(db.all('SELECT * FROM account_word')).toHaveLength(1);
});
it('[INV-ECO-27] explicit uncountable lexical declarations affect neither counter', () => {
  const { db, words } = setup();
  display(db);
  expect(
    words.recordIntroduction(source(runtime({ countable: false, classification: 'particle' }))),
  ).toEqual({ wordsIntroduced: 0, wordsLearned: 0 });
  expect(db.all('SELECT * FROM account_word')).toHaveLength(1);
});
it('[INV-ECO-27] raw lexeme IDs, changed meanings and excluded classifications cannot forge word identities', () => {
  const { db, words } = setup();
  display(db);
  expect(() => words.recordIntroduction(source(runtime({ wordItemId: 'lx:gato:NOUN' })))).toThrow();
  expect(() => words.recordIntroduction(source(runtime({ classification: 'particle' })))).toThrow();
  words.recordIntroduction(source());
  expect(() => words.recordIntroduction(source(runtime({ countable: false })))).toThrow(
    /ident|meaning|count/i,
  );
  expect(words.readCounters().wordsIntroduced).toBe(1);
});
it('[INV-ECO-27][INV-SCH-11] a stale pack, foreign source or unobserved target never creates an introduction', () => {
  const { db, words } = setup();
  display(db);
  const item = runtime();
  expect(() =>
    words.recordIntroduction({ ...source(item), packContentHash: 'b'.repeat(64) }),
  ).toThrow();
  expect(() => words.recordIntroduction(source({ ...item, exerciseId: 'different' }))).toThrow();
  expect(() => words.recordIntroduction(source({ ...item, introductions: [] }))).toThrow();
  expect(db.all('SELECT * FROM account_word')).toEqual([]);
});
it('[INV-ECO-27] legacy scalar counters never become fabricated known vocabulary history', () => {
  const { db, words } = setup(false);
  db.run('UPDATE account SET words_introduced=40,words_learned=10');
  expect(() => words.readCounters()).toThrow(/history/i);
  expect(() => words.initializeFreshHistory(at, { databaseWasCreated: true })).toThrow();
  expect(db.get('SELECT words_introduced,words_learned FROM account')).toEqual({
    words_introduced: 40,
    words_learned: 10,
  });
  expect(db.all('SELECT * FROM account_word_state')).toEqual([]);
});
it('[INV-ECO-27][INV-PACK-02] a quarantined target cannot add vocabulary credit', () => {
  const { db, words } = setup();
  display(db);
  db.run('UPDATE course_item SET quarantined=1');
  expect(() => words.recordIntroduction(source())).toThrow(/quarant/i);
  expect(db.all('SELECT * FROM account_word')).toEqual([]);
});
it('[INV-ECO-27][INV-CER-01] a failed outer transaction rolls back observation, identity and cached counters together', () => {
  const { db, words } = setup();
  expect(() =>
    db.withExclusiveTransaction(() => {
      display(db);
      words.recordIntroduction(source());
      throw new Error('kill');
    }),
  ).toThrow('kill');
  expect(words.readCounters()).toEqual({ wordsIntroduced: 0, wordsLearned: 0 });
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
});

import {
  applyEncounter,
  asItemId,
  asSessionId,
  emptySchedulerState,
  registerRows,
  introduce,
  rowAt,
  MASTERY_STABILITY_DAYS,
} from '@freelingo/core/scheduler';
import { freshSession, type Answer, type SessionState } from '@freelingo/core/session';
import { toLocalDay } from '@freelingo/core/day';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
import type { LearningSchedulerTransition } from './learningTransitions';
const zone = { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' } as const;
function prepareReview(
  db: Db,
  words: SqliteWordStore,
  n: number,
  when: number,
  grade: 1 | 3 = 3,
  exerciseIndex = 0,
) {
  const item = runtime(),
    sessionId = 'review-' + n,
    courseId = 'en-es';
  const target = {
    itemId: item.itemId,
    surfaceId: 'sf:cat',
    surface: 'el gato',
    role: 'production' as const,
    rubyShown: false,
    grade,
  };
  const answer: Answer = {
    exerciseIndex,
    slotId: 'slot-' + n,
    itemId: item.itemId,
    type: 'typedTranslate',
    verdict: grade === 1 ? 'wrong' : 'correct',
    softCorrected: false,
    wrong: grade === 1,
    costPaid: 0,
    skipped: false,
    scorable: true,
    queue: exerciseIndex < 0 ? 'mistakes' : 'main',
    note: null,
  };
  const binding = {
    slotId: answer.slotId,
    exerciseId: item.exerciseId,
    itemId: item.itemId,
    surface: target.surface,
    role: target.role,
    rubyShown: false,
  };
  const initial = freshSession({
    sessionId,
    courseId,
    nodeRef: 'node-1',
    queue: [
      {
        id: answer.slotId,
        itemId: item.itemId,
        type: answer.type,
        family: 'production',
        conceptId: 'gato',
        nodeRef: 'node-1',
        requiresAudio: false,
      },
    ],
  });
  const state: SessionState = { ...initial, core: { ...initial.core, answers: [answer] } };
  const sessions = new SqliteSessionStore(db);
  db.run('DELETE FROM course_session_context WHERE course_id=?', [courseId]);
  sessions.delete(courseId, 'graded', 'node-1');
  sessions.activate(state);
  const contexts = new SqliteLearningContextStore(db);
  contexts.create(
    {
      courseId,
      sessionKind: 'graded',
      nodeRef: 'node-1',
      start: { sessionId, startedAtUtcMs: when - 1000, startedAtMonotonicMs: 0, startZone: zone },
      economyFlavour: 'lesson',
      practiceItemRatio: 1,
      longFormEntry: null,
      boostAtStart: null,
      packContentHash: hash,
      origin: { kind: 'path' },
      targetNodeId: 'node-1',
    },
    [binding],
  );
  const receipt = {
    ...binding,
    exerciseIndex,
    answeredAtUtcMs: when,
    answeredLocalDay: toLocalDay(new Date(when).toISOString().slice(0, 10)),
    activeMs: 1000,
  };
  contexts.recordReceipt(courseId, sessionId, receipt);
  contexts.recordTargets(courseId, sessionId, exerciseIndex, [target]);
  const scheduler = new SqliteSchedulerStore(db);
  let beforeState = scheduler.load(courseId, 'UTC');
  if (!beforeState.rows.size) {
    beforeState = registerRows(emptySchedulerState('UTC'), [
      { itemId: asItemId(item.itemId), surface: target.surface, kind: 'lexeme' },
    ]);
    beforeState = introduce(beforeState, asItemId(item.itemId), target.surface, new Date(at + 1));
  }
  const before = rowAt(beforeState, asItemId(item.itemId), target.surface) ?? null;
  const result = applyEncounter(beforeState, {
    sessionId: asSessionId(sessionId),
    exerciseIndex,
    itemId: asItemId(item.itemId),
    surface: target.surface,
    targetSurfaceId: target.surfaceId,
    role: target.role,
    grade,
    at: new Date(when),
  });
  scheduler.save(courseId, result.state, [
    {
      sessionId,
      exerciseId: item.exerciseId,
      packContentHash: hash,
      answer,
      surface: target.surface,
      role: target.role,
      rubyShown: false,
      answeredAtUtc: new Date(when).toISOString(),
      activeMs: 1000,
      targets: [target],
    },
  ]);
  const transition: LearningSchedulerTransition = {
    courseId,
    sessionId,
    answerOrdinal: 0,
    targetPosition: 0,
    answer,
    receipt,
    target,
    runtimeItem: item,
    packContentHash: hash,
    before,
    after: rowAt(result.state, asItemId(item.itemId), target.surface) ?? null,
    review: result.review,
    wroteAttempt: result.wroteAttempt,
  };
  const input = { courseId, sessionId, schedulerBefore: beforeState, transitions: [transition] };
  const commit = () => {
    db.run('INSERT INTO committed_session(session_id,committed_at,outcome) VALUES(?,?,?)', [
      sessionId,
      new Date(when).toISOString(),
      'completed',
    ]);
    db.run('INSERT INTO course_session_commit_link VALUES(?,?,?,?,?,?)', [
      sessionId,
      courseId,
      'node-1',
      'lesson',
      null,
      null,
    ]);
  };
  return { input, transition, commit, prepare: () => words.prepare(input) };
}
it('[INV-ECO-27][INV-SCH-03] learned credit follows two real qualifying FSRS reviews with permanent ordered evidence', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  let consecutive = 0,
    learned = false;
  for (let n = 1; n <= 7; n++) {
    const review = prepareReview(db, words, n, at + 2 ** n * 86400000);
    const actual = review.transition.review!;
    if (actual.kind === 'scheduled')
      consecutive = actual.row.card.stability >= MASTERY_STABILITY_DAYS ? consecutive + 1 : 0;
    learned ||= consecutive >= 2;
    const plan = review.prepare();
    expect(plan.before).toEqual(words.readCounters());
    expect(plan.after).toEqual({ wordsIntroduced: 1, wordsLearned: Number(learned) });
    expect(db.all('SELECT * FROM account_word_review')).toHaveLength(n - 1);
    review.commit();
    words.apply(plan);
    expect(new SqliteWordStore(db).readCounters()).toEqual(plan.after);
  }
  expect(learned).toBe(true);
  expect(
    db
      .all('SELECT word_sequence FROM account_word_review ORDER BY word_sequence')
      .map((r) => r.word_sequence),
  ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  const proof = JSON.parse(
    String(
      db.get('SELECT evidence_json FROM account_word_review WHERE word_sequence=0')!.evidence_json,
    ),
  );
  expect(proof.transition.after.card.due).toMatch(/^20/);
  db.run('DELETE FROM course_progress');
  expect(words.readCounters()).toEqual({ wordsIntroduced: 1, wordsLearned: 1 });
});
it('[INV-ECO-27][INV-CER-01] an opaque review plan requires the same owner, unchanged facts and permanent commit', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000),
    plan = review.prepare();
  expect(() => words.apply({ ...plan })).toThrow();
  expect(() => new SqliteWordStore(db).apply(plan)).toThrow();
  expect(() => words.apply(plan)).toThrow(/commit/i);
  review.commit();
  words.apply(plan);
  expect(() => words.apply(plan)).toThrow();
  expect(db.all('SELECT * FROM account_word_review')).toHaveLength(1);
});
it('[INV-ECO-27][INV-SCH-03] replay indices remain identity while incomplete, reordered or forged source transitions reject', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000, 3, -2);
  for (const transitions of [
    [],
    [review.transition, review.transition],
    [{ ...review.transition, answerOrdinal: 1 }],
    [{ ...review.transition, target: { ...review.transition.target, grade: 1 as const } }],
    [{ ...review.transition, receipt: { ...review.transition.receipt, answeredAtUtcMs: at } }],
  ])
    expect(() => words.prepare({ ...review.input, transitions })).toThrow();
  const plan = review.prepare();
  review.commit();
  words.apply(plan);
  const evidence = JSON.parse(
    String(db.get('SELECT evidence_json FROM account_word_review')!.evidence_json),
  );
  expect(evidence.transition.answer.exerciseIndex).toBe(-2);
  expect(db.get('SELECT word_sequence,answer_ordinal FROM account_word_review')).toEqual({
    word_sequence: 0,
    answer_ordinal: 0,
  });
});
it('[INV-ECO-27][INV-CER-01] stale plans and an interrupted learning claim cannot change cached vocabulary totals', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000),
    plan = review.prepare();
  db.run('UPDATE course_item SET quarantined=1');
  review.commit();
  expect(() => words.apply(plan)).toThrow(/stale|chang|quarant/i);
  expect(db.all('SELECT * FROM account_word_review')).toEqual([]);
  expect(words.readCounters()).toEqual({ wordsIntroduced: 1, wordsLearned: 0 });
});

it('[INV-ECO-27][INV-SCH-01] early success adds no retirement review and any actual wrong resets the pending streak', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  let n = 0,
    when = at,
    firstQualified = false;
  while (!firstQualified && n < 10) {
    n++;
    when = at + 2 ** n * 86400000;
    const r = prepareReview(db, words, n, when),
      p = r.prepare();
    firstQualified =
      r.transition.review?.kind === 'scheduled' &&
      (r.transition.after?.card.stability ?? 0) >= MASTERY_STABILITY_DAYS;
    expect(p.after.wordsLearned).toBe(0);
    r.commit();
    words.apply(p);
  }
  expect(firstQualified).toBe(true);
  const early = prepareReview(db, words, ++n, when + 1000);
  expect(early.transition.review!.kind).toBe('early');
  const earlyPlan = early.prepare();
  expect(earlyPlan.after.wordsLearned).toBe(0);
  early.commit();
  words.apply(earlyPlan);
  const wrong = prepareReview(db, words, ++n, when + 2000, 1);
  expect(wrong.transition.review!.kind).toBe('early');
  const wrongPlan = wrong.prepare();
  expect(wrongPlan.after.wordsLearned).toBe(0);
  wrong.commit();
  words.apply(wrongPlan);
  const due = wrong.transition.after!.card.due.getTime() + 86400000;
  const next = prepareReview(db, words, ++n, due);
  expect(next.transition.review!.kind).toBe('scheduled');
  expect(next.transition.after!.card.stability).toBeGreaterThanOrEqual(MASTERY_STABILITY_DAYS);
  expect(next.prepare().after.wordsLearned).toBe(0);
});
it('[INV-ECO-27][INV-CER-01] killing the transaction after word apply restores both permanent evidence and counters', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000),
    plan = review.prepare();
  expect(() =>
    db.withExclusiveTransaction(() => {
      review.commit();
      words.apply(plan);
      throw new Error('kill after word apply');
    }),
  ).toThrow('kill after word apply');
  expect(db.all('SELECT * FROM account_word_review')).toEqual([]);
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(words.readCounters()).toEqual({ wordsIntroduced: 1, wordsLearned: 0 });
  const retry = review.prepare();
  db.withExclusiveTransaction(() => {
    review.commit();
    words.apply(retry);
  });
  expect(db.all('SELECT * FROM account_word_review')).toHaveLength(1);
});
it('[INV-ECO-27][INV-PER-03] a malformed permanent learned claim cannot become a trusted counter', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000),
    plan = review.prepare();
  review.commit();
  words.apply(plan);
  expect(words.readCounters().wordsLearned).toBe(0);
  const word = db.get('SELECT word_item_id FROM account_word')!.word_item_id;
  db.run('INSERT INTO account_word_learning VALUES(?,?,?,?)', [
    word,
    at + 2 * 86400000,
    review.input.sessionId,
    '{}',
  ]);
  db.run('UPDATE account SET words_learned=1');
  expect(() => words.readCounters()).toThrow();
});
it('[INV-ECO-27][INV-PER-03] altered first before-card timestamp cannot be archived as an actual FSRS snapshot', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000);
  const t = review.transition,
    before = {
      ...t.before!,
      card: { ...t.before!.card, due: new Date(t.before!.card.due.getTime() + 1) },
    };
  expect(() => words.prepare({ ...review.input, transitions: [{ ...t, before }] })).toThrow();
});
it('[INV-ECO-27][INV-PER-03] malformed permanent review cards cannot seed the next qualifying streak', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const first = prepareReview(db, words, 1, at + 2 * 86400000),
    plan = first.prepare();
  first.commit();
  words.apply(plan);
  const row = db.get('SELECT * FROM account_word_review')!,
    e = JSON.parse(String(row.evidence_json));
  e.transition.sessionId = 'fake-review';
  e.transition.after.card.due = 'not-a-date';
  e.transition.after.card.stability = '999';
  e.transition.review.kind = 'scheduled';
  e.transition.review.row = e.transition.after;
  db.run(
    "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES('fake-review','2026-09-15','completed')",
  );
  db.run('INSERT INTO account_word_review VALUES(?,?,?,?,?,?,?)', [
    row.word_item_id,
    1,
    'fake-review',
    0,
    0,
    row.reviewed_at_utc_ms,
    JSON.stringify(e),
  ]);
  const next = prepareReview(db, words, 2, at + 4 * 86400000);
  expect(() => next.prepare()).toThrow();
});

function matchFixture(sameWord = false) {
  const { db, words } = setup();
  const labels = ['gato', sameWord ? 'Gato' : 'perro', 'casa', 'pan', 'agua'];
  const bindings = labels.map((lemma, i) => {
    const shared = sameWord && i === 1;
    const semantic = {
      prompt: shared ? 'meaning gato' : 'meaning ' + lemma,
      preferredSurface: shared ? 'gato' : lemma,
      register: 'neutral',
      lexemes: [shared ? 'gato' : lemma],
      grammarConcepts: [],
      graphemes: [],
    };
    return {
      ...runtime().lexicalBindings[0]!,
      schedulerItemId: 'lx:' + lemma + ':' + (shared ? 'PROPN' : 'NOUN'),
      surfaceId: 'sf:match:' + i,
      surface: lemma,
      lexemeId: 'lx:' + lemma + ':' + (shared ? 'PROPN' : 'NOUN'),
      lemma: shared ? 'gato' : lemma,
      pos: shared ? 'PROPN' : 'NOUN',
      wordItemId: contentHashItemId(semantic),
      semantic,
    };
  });
  const item: VerifiedRuntimeItem = {
    ...runtime(),
    itemId: 'aggregate-match',
    exerciseId: 'exercise-match',
    gradable: {
      itemId: 'aggregate-match',
      family: 'match',
      accepted: [],
      pairs: bindings.map((b, i) => ({
        leftLexemeId: b.schedulerItemId,
        rightLexemeId: 'en:' + i,
        left: b.surface,
        right: b.semantic.prompt,
        facet: 'meaning',
      })),
    },
    presentation: {
      ...runtime().presentation,
      itemId: 'aggregate-match',
      type: 'matchPairs',
      pairs: bindings.map((b, i) => ({
        leftItemId: b.schedulerItemId,
        leftId: 'left-' + i,
        rightId: 'right-' + i,
        left: b.surface,
        right: b.semantic.prompt,
      })),
    },
    schedulerSurfaces: bindings.map((b) => ({
      itemId: b.schedulerItemId,
      surfaceId: b.surfaceId,
      surface: b.surface,
      language: b.language,
      kind: 'lexeme',
      itemRef: b.lexemeId,
      canonical: true,
    })),
    introductions: bindings.map((b) => ({
      surfaceId: b.surfaceId,
      surface: b.surface,
      language: b.language,
      when: 'prompt',
    })),
    lexicalBindings: bindings,
  };
  db.run(
    "INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES('en-es','aggregate-match',0,0)",
  );
  for (const b of bindings) {
    db.run(
      "INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES('en-es',?,0,0)",
      [b.schedulerItemId],
    );
    db.run('INSERT INTO course_surface_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
      'en-es',
      b.surfaceId,
      b.surface,
      'es',
      'observed-match',
      'observed-match-slot',
      item.exerciseId,
      hash,
      'prompt',
      at + 1,
    ]);
    words.recordIntroduction({
      courseId: 'en-es',
      packContentHash: hash,
      item,
      surfaceId: b.surfaceId,
    });
  }
  return { db, words, item };
}
function prepareMatchReview(
  db: Db,
  words: SqliteWordStore,
  item: VerifiedRuntimeItem,
  n: number,
  when: number,
  grades: readonly (1 | 3)[],
) {
  const courseId = 'en-es',
    sessionId = 'match-review-' + n;
  const targets = item.lexicalBindings.map((b, i) => ({
    itemId: b.schedulerItemId,
    surfaceId: b.surfaceId,
    surface: b.surface,
    role: 'recognition' as const,
    rubyShown: false,
    grade: grades[i]!,
  }));
  const wrong = grades.some((g) => g === 1);
  const answer: Answer = {
    exerciseIndex: 0,
    slotId: 'match-slot-' + n,
    itemId: item.itemId,
    type: 'matchPairs',
    verdict: wrong ? 'wrong' : 'correct',
    softCorrected: false,
    wrong,
    costPaid: 0,
    skipped: false,
    scorable: true,
    queue: 'main',
    note: null,
  };
  const binding = {
    slotId: answer.slotId,
    exerciseId: item.exerciseId,
    itemId: item.itemId,
    surface: targets[0]!.surface,
    role: 'recognition' as const,
    rubyShown: false,
  };
  const initial = freshSession({
    sessionId,
    courseId,
    nodeRef: 'node-1',
    queue: [
      {
        id: answer.slotId,
        itemId: item.itemId,
        type: answer.type,
        family: 'recognition',
        conceptId: 'match',
        nodeRef: 'node-1',
        requiresAudio: false,
      },
    ],
  });
  const state: SessionState = { ...initial, core: { ...initial.core, answers: [answer] } };
  const sessions = new SqliteSessionStore(db);
  db.run('DELETE FROM course_session_context WHERE course_id=?', [courseId]);
  sessions.delete(courseId, 'graded', 'node-1');
  sessions.activate(state);
  const contexts = new SqliteLearningContextStore(db);
  contexts.create(
    {
      courseId,
      sessionKind: 'graded',
      nodeRef: 'node-1',
      start: { sessionId, startedAtUtcMs: when - 1000, startedAtMonotonicMs: 0, startZone: zone },
      economyFlavour: 'lesson',
      practiceItemRatio: 1,
      longFormEntry: null,
      boostAtStart: null,
      packContentHash: hash,
      origin: { kind: 'path' },
      targetNodeId: 'node-1',
    },
    [binding],
  );
  const receipt = {
    ...binding,
    exerciseIndex: 0,
    answeredAtUtcMs: when,
    answeredLocalDay: toLocalDay(new Date(when).toISOString().slice(0, 10)),
    activeMs: 1000,
  };
  contexts.recordReceipt(courseId, sessionId, receipt);
  contexts.recordTargets(courseId, sessionId, 0, targets);
  const scheduler = new SqliteSchedulerStore(db);
  let current = scheduler.load(courseId, 'UTC');
  if (!current.rows.size) {
    current = registerRows(
      current,
      targets.map((t) => ({ itemId: asItemId(t.itemId), surface: t.surface, kind: 'lexeme' })),
    );
    for (const t of targets)
      current = introduce(current, asItemId(t.itemId), t.surface, new Date(at + 1));
  }
  const schedulerBefore = current;
  const transitions: LearningSchedulerTransition[] = [];
  targets.forEach((target, targetPosition) => {
    const before = rowAt(current, asItemId(target.itemId), target.surface) ?? null;
    const result = applyEncounter(current, {
      sessionId: asSessionId(sessionId),
      exerciseIndex: 0,
      itemId: asItemId(target.itemId),
      surface: target.surface,
      targetSurfaceId: target.surfaceId,
      role: target.role,
      grade: target.grade,
      at: new Date(when),
    });
    transitions.push({
      courseId,
      sessionId,
      answerOrdinal: 0,
      targetPosition,
      answer,
      receipt,
      target,
      runtimeItem: item,
      packContentHash: hash,
      before,
      after: rowAt(result.state, asItemId(target.itemId), target.surface) ?? null,
      review: result.review,
      wroteAttempt: result.wroteAttempt,
    });
    current = result.state;
  });
  scheduler.save(courseId, current, [
    {
      sessionId,
      exerciseId: item.exerciseId,
      packContentHash: hash,
      answer,
      surface: binding.surface,
      role: binding.role,
      rubyShown: false,
      answeredAtUtc: new Date(when).toISOString(),
      activeMs: 1000,
      targets,
    },
  ]);
  const input = { courseId, sessionId, schedulerBefore, transitions };
  const commit = () => {
    db.run('INSERT INTO committed_session(session_id,committed_at,outcome) VALUES(?,?,?)', [
      sessionId,
      new Date(when).toISOString(),
      'completed',
    ]);
    db.run('INSERT INTO course_session_commit_link VALUES(?,?,?,?,?,?)', [
      sessionId,
      courseId,
      'node-1',
      'lesson',
      null,
      null,
    ]);
  };
  return { input, transitions, prepare: () => words.prepare(input), commit };
}
it('[INV-ECO-27][INV-PER-03] actual five-target MATCH credits a successful cat after another target makes the parent wrong', () => {
  const { db, words, item } = matchFixture();
  let n = 0,
    when = at,
    qualified = false,
    nextDue = at;
  while (!qualified && n < 10) {
    n++;
    when = at + 2 ** n * 86400000;
    const r = prepareMatchReview(db, words, item, n, when, [3, 3, 3, 3, 3]);
    qualified =
      r.transitions[0]!.review?.kind === 'scheduled' &&
      r.transitions[0]!.after!.card.stability >= MASTERY_STABILITY_DAYS;
    nextDue = Math.max(...r.transitions.map((t) => t.after!.card.due.getTime())) + 86400000;
    const p = r.prepare();
    expect(p.after.wordsLearned).toBe(0);
    r.commit();
    words.apply(p);
  }
  expect(qualified).toBe(true);
  const r = prepareMatchReview(db, words, item, ++n, nextDue, [3, 1, 3, 3, 3]);
  expect(r.transitions[0]!.answer.wrong).toBe(true);
  expect(r.transitions[0]!.target.grade).toBe(3);
  expect(r.transitions[0]!.review!.kind).toBe('scheduled');
  expect(r.transitions[0]!.after!.card.stability).toBeGreaterThanOrEqual(MASTERY_STABILITY_DAYS);
  expect(r.prepare().after.wordsLearned).toBe(4);
});
it('[INV-ECO-27][INV-PER-03] two targets bound to one word in a physical MATCH answer supply only one qualifying word review', () => {
  const { db, words, item } = matchFixture(true);
  expect(item.lexicalBindings[0]!.wordItemId).toBe(item.lexicalBindings[1]!.wordItemId);
  expect(new Set(item.lexicalBindings.map((b) => b.schedulerItemId)).size).toBe(5);
  let n = 0,
    qualified = false;
  while (!qualified && n < 10) {
    n++;
    const r = prepareMatchReview(db, words, item, n, at + 2 ** n * 86400000, [3, 3, 3, 3, 3]);
    qualified =
      r.transitions[0]!.review?.kind === 'scheduled' &&
      r.transitions[0]!.after!.card.stability >= MASTERY_STABILITY_DAYS;
    expect(r.prepare().after.wordsLearned).toBe(0);
    const p = r.prepare();
    r.commit();
    words.apply(p);
  }
  expect(qualified).toBe(true);
});

it('[INV-ECO-27][INV-PER-03] a later wrong target for the same word cancels an earlier target in that physical parent', () => {
  const { db, words, item } = matchFixture(true);
  let n = 0,
    qualified = false,
    nextDue = at;
  while (!qualified && n < 10) {
    n++;
    const r = prepareMatchReview(db, words, item, n, at + 2 ** n * 86400000, [3, 3, 3, 3, 3]);
    qualified =
      r.transitions[0]!.review?.kind === 'scheduled' &&
      r.transitions[0]!.after!.card.stability >= MASTERY_STABILITY_DAYS;
    nextDue = Math.max(...r.transitions.map((t) => t.after!.card.due.getTime())) + 86400000;
    const p = r.prepare();
    r.commit();
    words.apply(p);
  }
  expect(qualified).toBe(true);
  const r = prepareMatchReview(db, words, item, ++n, nextDue, [3, 1, 3, 3, 3]);
  expect(r.transitions[0]!.review!.kind).toBe('scheduled');
  const plan = r.prepare();
  expect(plan.newlyLearnedWordIds).not.toContain(item.lexicalBindings[0]!.wordItemId);
  r.commit();
  words.apply(plan);
  expect(
    db.get('SELECT word_item_id FROM account_word_learning WHERE word_item_id=?', [
      item.lexicalBindings[0]!.wordItemId,
    ]),
  ).toBeUndefined();
});

it('[INV-ECO-27][INV-PER-03] contradictory permanent source and receipt identities never become trusted review history', () => {
  const { db, words } = setup();
  display(db);
  words.recordIntroduction(source());
  const review = prepareReview(db, words, 1, at + 2 * 86400000),
    plan = review.prepare();
  review.commit();
  words.apply(plan);
  const stored = db.get('SELECT * FROM account_word_review')!,
    proof = JSON.parse(String(stored.evidence_json));
  proof.transition.source.exerciseId = 'unrelated-exercise';
  proof.transition.sessionId = 'contradictory-source';
  db.run(
    "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES('contradictory-source','2026-09-15','completed')",
  );
  db.run('INSERT INTO account_word_review VALUES(?,?,?,?,?,?,?)', [
    stored.word_item_id,
    1,
    'contradictory-source',
    0,
    0,
    stored.reviewed_at_utc_ms,
    JSON.stringify(proof),
  ]);
  expect(() => words.readCounters()).toThrow(/source|receipt|histor/i);
});
