// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { openPack, type PackReader } from '@freelingo/core/packs';
import {
  emptySchedulerState,
  registerRows,
  introduce,
  applyEncounter,
  asItemId,
  asSessionId,
  rowAt,
} from '@freelingo/core/scheduler';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import type { LearningSchedulerTransition } from './learningTransitions';
import {
  freshSession,
  item,
  step,
  DEFAULT_FLAVOUR_MATRIX,
  type SessionState,
  type StepDeps,
} from '@freelingo/core/session';
import { toLocalDay } from '@freelingo/core/day';
import { DAILY_GOAL_CHEST_GEMS } from '@freelingo/core/economy';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { readPathModel } from '../services/readPathModel';
import { SqliteLearningContextStore, type LearningContext } from './SqliteLearningContextStore';
import { SqliteDayStore } from './SqliteDayStore';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import {
  planLearningRewards,
  writeLearningRewards,
  type LearningRewardInput,
} from './learningRewards';
const close: (() => void)[] = [];
afterEach(() => {
  for (const c of close.splice(0)) c();
});
const epoch = Date.parse('2026-09-13T12:00:00Z');
const zone = { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'fixed_offset' } as const;
function completed(sessionId = 'session-1'): SessionState {
  let state = freshSession({
    sessionId,
    flavour: 'nodePractice',
    nodeRef: 'u001:learn',
    queue: [item(1, { nodeRef: 'u001:learn' })],
    motivationalMessages: false,
    monotonicMs: 1000,
  });
  let clock = 1000;
  const deps: StepDeps = {
    config: DEFAULT_FLAVOUR_MATRIX.nodePractice,
    grading: { grade: () => ({ kind: 'correct' }) },
    clock: { nowMs: () => (clock += 1000) },
    isTypeEligible: () => true,
    stepUpTripped: () => false,
  };
  for (let n = 0; n < 20 && state.exited === null; n++) {
    const event =
      state.shellState === 'loading'
        ? { type: 'rendered' as const }
        : state.shellState === 'challenge.idle'
          ? { type: 'input' as const, text: 'cat', caret: 3, partialState: {}, gradeable: true }
          : state.shellState === 'challenge.armed'
            ? { type: 'check' as const }
            : state.shellState === 'grading'
              ? { type: 'graded' as const }
              : { type: 'continue' as const };
    state = step(state, event, deps).state;
  }
  expect(state.exited).toBe('complete');
  return state;
}
function setup(sessionId = 'session-1') {
  const db = createNodeDb();
  migrate(db);
  close.push(() => db.close());
  db.run(
    "INSERT INTO course_progress(course_id,added_at,pack_content_hash,pack_state,score_unlocked,score_ceiling_beat_shown) VALUES('en-es','2026-09-13',?,'installed',0,0)",
    ['a'.repeat(64)],
  );
  db.run("INSERT INTO course_progress(course_id,added_at,xp) VALUES('en-fr','2026-09-13',40)");
  db.run("INSERT INTO course_path_state VALUES('en-es',100,0,0)");
  db.run('UPDATE account SET daily_goal_xp=10,selection_seed=1,perfect_lessons=2');
  for (const id of ['earnXp', 'completeLessons', 'perfectLessons'])
    db.run("INSERT INTO account_quest VALUES('2026-09-13',?,?,100,100,'2026-09-13T11:00:00Z')", [
      id,
      id,
    ]);
  const source = new DatabaseSync(
    new URL('../../../../tools/coursekit/tests/fixtures/path/loader-pack.sqlite', import.meta.url),
    { readOnly: true },
  );
  close.push(() => source.close());
  const reader: PackReader = {
    all: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).all(...(p as never[])) as T[],
    get: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).get(...(p as never[])) as T | undefined,
  };
  const pack = openPack(reader, { packRoot: '/test-only' });
  const verified: VerifiedInstalledPack = {
    courseId: 'en-es',
    contentHash: 'a'.repeat(64),
    pack,
    manifest: {
      packId: pack.meta.packId,
      courseId: 'en-es',
      version: pack.meta.version,
      major: 1,
      payloadSha256: 'a'.repeat(64),
      payloadBytes: 1,
      audioBytes: 0,
      itemIds: [],
    },
    audioUri: () => null,
    runtimeItem: () => {
      throw Error('No grading is performed by rewards');
    },
  };
  const state = completed(sessionId);
  const context: LearningContext = {
    launch: {
      courseId: 'en-es',
      sessionKind: 'graded',
      nodeRef: 'u001:learn',
      start: { sessionId, startedAtUtcMs: epoch, startedAtMonotonicMs: 1000, startZone: zone },
      economyFlavour: 'hubWords',
      practiceItemRatio: 1,
      longFormEntry: null,
      boostAtStart: null,
      packContentHash: verified.contentHash,
      origin: { kind: 'hub', offerId: 'words', localDay: toLocalDay('2026-09-13') },
      targetNodeId: null,
    },
    startedLocalDay: toLocalDay('2026-09-13'),
    slots: [],
    activeMs: 1234,
    completion: {
      completedAtUtcMs: epoch + 60000,
      completedAtMonotonicMs: 61000,
      completionZone: zone,
      outcome: 'completed',
      intendedAtUtc: new Date(epoch + 60000).toISOString(),
    },
  };
  const scheduler = emptySchedulerState('UTC');
  const path = readPathModel(db, verified);
  const input: LearningRewardInput = {
    state,
    context,
    pack: verified,
    transitions: [],
    schedulerBefore: scheduler,
    schedulerAfter: scheduler,
    pathBefore: path,
    pathAfter: path,
  };
  return { db, input };
}
function scoped(db: Db): Db {
  return { ...db, withExclusiveTransaction: <T>(fn: () => T) => fn() };
}
function apply(db: Db, input: LearningRewardInput) {
  return db.withExclusiveTransaction(() => {
    const tx = scoped(db);
    return writeLearningRewards(tx, planLearningRewards(tx, input));
  });
}
it('[INV-CER-01][INV-ECO-05] actual terminal machine plans without writes, then commits XP, one goal chest and frozen ceremony atomically', () => {
  const { db, input } = setup();
  const before = db.get('SELECT * FROM account');
  const plan = planLearningRewards(db, input);
  expect(db.get('SELECT * FROM account')).toEqual(before);
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
  const receipt = apply(db, input);
  expect(db.get('SELECT lifetime_xp,gems FROM account')).toEqual({
    lifetime_xp: 10,
    gems: Number(before!.gems) + DAILY_GOAL_CHEST_GEMS,
  });
  expect(db.get("SELECT xp FROM course_progress WHERE course_id='en-es'")!.xp).toBe(10);
  expect(db.get("SELECT xp FROM course_progress WHERE course_id='en-fr'")!.xp).toBe(40);
  expect(db.get('SELECT xp_awarded,active_ms,reward_local_day FROM committed_session')).toEqual({
    xp_awarded: 10,
    active_ms: 1234,
    reward_local_day: '2026-09-13',
  });
  expect(receipt.result.committed?.xp).toBe(10);
  expect(db.get('SELECT presentation_json FROM course_ceremony')).toBeDefined();
  expect(() => writeLearningRewards(db, plan)).toThrow(/already|committed|consumed/i);
});
it('[INV-DAY-08][INV-ECO-02] boost expiry and grace use captured monotonic completion while goal XP uses completion date', () => {
  const { db, input } = setup();
  const start = Date.parse('2026-09-13T23:59:00Z');
  const context: LearningContext = {
    ...input.context,
    launch: {
      ...input.context.launch,
      start: { ...input.context.launch.start, startedAtUtcMs: start },
      boostAtStart: {
        kind: 'xpBoost',
        multiplier: 2,
        startedAtUtc: new Date(start - 60000).toISOString(),
        expiresAtUtc: new Date(start + 180000).toISOString(),
      },
    },
    completion: {
      ...input.context.completion!,
      completedAtUtcMs: start + 600000,
      completedAtMonotonicMs: 121000,
    },
  };
  apply(db, { ...input, context });
  expect(
    db.get(
      'SELECT credited_local_day,reward_local_day,credited_by_grace,multiplier_applied,derived_completion_utc_ms FROM committed_session',
    ),
  ).toEqual({
    credited_local_day: '2026-09-13',
    reward_local_day: '2026-09-14',
    credited_by_grace: 1,
    multiplier_applied: 2,
    derived_completion_utc_ms: start + 120000,
  });
  expect(db.get("SELECT earned_xp FROM account_day WHERE local_day='2026-09-14'")!.earned_xp).toBe(
    20,
  );
});
it('[INV-ECO-05] a second distinct session after raising the goal preserves the same chest and daily ladder', () => {
  const { db, input } = setup();
  apply(db, input);
  const gems = db.get('SELECT gems FROM account')!.gems;
  db.run('UPDATE account SET daily_goal_xp=50');
  const id = 'session-2';
  apply(db, {
    ...input,
    state: completed(id),
    context: {
      ...input.context,
      launch: { ...input.context.launch, start: { ...input.context.launch.start, sessionId: id } },
    },
  });
  expect(db.get('SELECT gems FROM account')!.gems).toBe(gems);
  expect(db.get('SELECT goal_met,goal_xp_at_grant,earned_xp FROM account_day')).toEqual({
    goal_met: 1,
    goal_xp_at_grant: 10,
    earned_xp: 15,
  });
});
it('[INV-CER-01] a late SQL failure rolls back archive, counters, day and ceremony and preserves retry', () => {
  const { db, input } = setup();
  db.run(
    "CREATE TRIGGER fail_ceremony BEFORE INSERT ON course_ceremony BEGIN SELECT RAISE(ABORT,'simulated power loss'); END",
  );
  expect(() => apply(db, input)).toThrow('simulated power loss');
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(db.get('SELECT lifetime_xp FROM account')!.lifetime_xp).toBe(0);
  expect(db.all('SELECT * FROM account_day')).toEqual([]);
  db.run('DROP TRIGGER fail_ceremony');
  expect(apply(db, input).result.committed?.xp).toBe(10);
});
it('[INV-SESS-23] live, zero-graded and mismatched session/pack evidence cannot manufacture completion', () => {
  const { db, input } = setup();
  expect(() => planLearningRewards(db, { ...input, state: freshSession() })).toThrow();
  expect(() =>
    planLearningRewards(db, {
      ...input,
      state: { ...input.state, core: { ...input.state.core, answers: [] } },
    }),
  ).toThrow();
  expect(() =>
    planLearningRewards(db, { ...input, context: { ...input.context, completion: null } }),
  ).toThrow();
  expect(() =>
    planLearningRewards(db, { ...input, pack: { ...input.pack, contentHash: 'b'.repeat(64) } }),
  ).toThrow();
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
});
it('[INV-CER-01] a plan cannot be forged, transferred between connections or reused after a competing durable mutation', () => {
  const one = setup(),
    two = setup('other');
  const plan = planLearningRewards(one.db, one.input);
  expect(() => writeLearningRewards(two.db, plan)).toThrow();
  expect(() => writeLearningRewards(one.db, { ...plan })).toThrow();
  one.db.run('UPDATE account SET gems=gems+1');
  expect(() => writeLearningRewards(one.db, plan)).toThrow(/stale|changed/i);
});

it('[INV-CER-01] caller mutation after planning cannot change the frozen completion evidence written', () => {
  const { db, input } = setup();
  db.withExclusiveTransaction(() => {
    const tx = scoped(db),
      plan = planLearningRewards(tx, input);
    const original = input.context.activeMs;
    Object.assign(input.context, { activeMs: 999999 });
    writeLearningRewards(tx, plan);
    expect(db.get('SELECT active_ms FROM committed_session')!.active_ms).toBe(original);
  });
});
it('[INV-ECO-11][INV-ECO-22] actual quest predicates award once and count completed quests rather than XP in the month', () => {
  const { db, input } = setup();
  db.run('DELETE FROM account_quest');
  for (const [id, target] of [
    ['earnXp', 10],
    ['fiveInARow', 1],
    ['perfectLessons', 1],
  ] as const)
    db.run("INSERT INTO account_quest VALUES('2026-09-13',?,?,?,0,NULL)", [id, id, target]);
  apply(db, input);
  expect(
    db.all('SELECT template_id,progress,completed_at FROM account_quest ORDER BY template_id'),
  ).toEqual([
    { template_id: 'earnXp', progress: 10, completed_at: expect.any(String) },
    { template_id: 'fiveInARow', progress: 0, completed_at: null },
    { template_id: 'perfectLessons', progress: 1, completed_at: expect.any(String) },
  ]);
  expect(db.get('SELECT completed_quests FROM account_monthly_badge')!.completed_quests).toBe(2);
  const id = 'session-2';
  apply(db, {
    ...input,
    state: completed(id),
    context: {
      ...input.context,
      launch: { ...input.context.launch, start: { ...input.context.launch.start, sessionId: id } },
    },
  });
  expect(db.get('SELECT completed_quests FROM account_monthly_badge')!.completed_quests).toBe(2);
});
it('[INV-ECO-33][INV-CER-07] punitive perfect lessons cross achievement tiers once; an accepted-only response cannot', () => {
  const { db, input } = setup();
  db.run('UPDATE account SET perfect_lessons=0');
  const result = apply(db, input);
  expect(db.get('SELECT perfect_lessons FROM account')!.perfect_lessons).toBe(1);
  expect(db.all('SELECT achievement_id,tier_index FROM account_achievement_award')).toContainEqual({
    achievement_id: 'sharpshooter',
    tier_index: 0,
  });
  expect(result.state.account.achievementCrossings).toContainEqual(
    expect.objectContaining({ achievementId: 'sharpshooter', gems: 25 }),
  );
  const id = 'accepted-only';
  const state = {
    ...completed(id),
    core: {
      ...completed(id).core,
      answers: completed(id).core.answers.map((a) => ({
        ...a,
        type: 'readAndRespond' as const,
        verdict: 'accepted' as const,
        scorable: false,
      })),
    },
  };
  apply(db, {
    ...input,
    state,
    context: {
      ...input.context,
      launch: { ...input.context.launch, start: { ...input.context.launch.start, sessionId: id } },
    },
  });
  expect(db.get('SELECT perfect_lessons FROM account')!.perfect_lessons).toBe(1);
});

function history(
  db: Db,
  completedDays: number[],
  missedDays: number[] = [],
  challenge = false,
  lastProcessed = 12,
) {
  const store = new SqliteDayStore(db),
    prior = store.load(),
    d = (n: number) => toLocalDay(`2026-09-${String(n).padStart(2, '0')}`);
  const dispositions = new Map(prior.engine.dispositions);
  for (const n of completedDays) dispositions.set(d(n), 'completed');
  for (const n of missedDays) dispositions.set(d(n), 'missed');
  store.save({
    engine: {
      ...prior.engine,
      lastProcessedDay: d(lastProcessed),
      maxLocalDaySeen: d(lastProcessed),
      lastProcessedMonth: '2026-09',
      longestStreak: completedDays.length,
      dispositions,
      brk: challenge ? { brokenOn: d(11), previousStreak: 3, uncoveredDays: [d(11), d(12)] } : null,
      challenge: challenge
        ? {
            brokenOn: d(11),
            previousStreak: 3,
            expiresAfterDay: d(13),
            lessonsRequired: 3,
            lessonsDone: 2,
            earnedOnDay: null,
          }
        : null,
    },
    satisfiedDays: new Set(completedDays.map(d)),
    guard: {
      maxLocalDaySeen: d(lastProcessed),
      lastCompletedAtUtcMs: epoch - 86400000,
      lastZone: zone,
    },
  });
  db.run('UPDATE account SET streak=?', [challenge ? 0 : completedDays.length]);
}
it('[INV-FRZ-04][INV-ECO-03] seven-day Society entry pays exact freezes and one real boost, then same-day completion cannot replay it', () => {
  const { db, input } = setup();
  history(db, [7, 8, 9, 10, 11, 12]);
  const receipt = apply(db, input);
  expect(db.get('SELECT freeze_cap,society_entered_on_day FROM account')).toEqual({
    freeze_cap: 5,
    society_entered_on_day: '2026-09-13',
  });
  expect(
    db.all(
      "SELECT requested,applied FROM account_freeze_grant WHERE grant_key LIKE 'society_tier:%'",
    ),
  ).toEqual([{ requested: 3, applied: 3 }]);
  expect(db.all('SELECT duration_minutes,activated_at_utc FROM account_boost')).toEqual([
    { duration_minutes: 30, activated_at_utc: new Date(epoch + 60000).toISOString() },
  ]);
  expect(receipt.state.account.streakSocietyBeat).toBe('induction');
  const id = 'session-2';
  apply(db, {
    ...input,
    state: completed(id),
    context: {
      ...input.context,
      launch: { ...input.context.launch, start: { ...input.context.launch.start, sessionId: id } },
    },
  });
  expect(db.all('SELECT * FROM account_boost')).toHaveLength(1);
});
it('[INV-REC-02][INV-REC-05] a third actual recovery lesson repaints only missed dates and restores the saved streak with today satisfied', () => {
  const { db, input } = setup();
  history(db, [8, 9, 10], [11, 12], true);
  const state = { ...input.state, flavour: 'recovery' as const };
  apply(db, {
    ...input,
    state,
    context: { ...input.context, launch: { ...input.context.launch, economyFlavour: 'recovery' } },
  });
  expect(db.get('SELECT streak FROM account')!.streak).toBe(4);
  expect(
    db.all(
      "SELECT local_day,disposition FROM account_day WHERE local_day IN ('2026-09-11','2026-09-12') ORDER BY local_day",
    ),
  ).toEqual([
    { local_day: '2026-09-11', disposition: 'recovered' },
    { local_day: '2026-09-12', disposition: 'recovered' },
  ]);
  expect(db.all('SELECT * FROM account_recovery_challenge')).toEqual([]);
});

/** The repository boundary is an explicit typed test double; actual source receipts
 * below are stored and joined by the real SqliteLearningContextStore. No grading or
 * signature verification is claimed by this reward-only fixture. */
function checkpointFixture(wrongIndices: number[], skipReceipt = -1, sessionId = 'session-1') {
  const { db, input } = setup(sessionId),
    queue = Array.from({ length: 20 }, (_, n) => item(n + 1, { nodeRef: 'u001:learn' }));
  let clock = 1000,
    state = freshSession({
      sessionId,
      flavour: 'legendary',
      queue,
      nodeRef: 'u001:learn',
      motivationalMessages: false,
    });
  const seen = new Set<string>();
  const deps: StepDeps = {
    config: DEFAULT_FLAVOUR_MATRIX.legendary,
    grading: {
      grade: (r) => {
        const wrong =
          wrongIndices.includes(Number(r.item.id.split('-')[1]) - 1) && !seen.has(r.item.itemId);
        seen.add(r.item.itemId);
        return { kind: wrong ? 'wrong' : 'correct' };
      },
    },
    clock: { nowMs: () => (clock += 1000) },
    isTypeEligible: () => true,
    stepUpTripped: () => false,
  };
  for (let n = 0; n < 300 && state.shellState !== 'outOfHearts' && state.exited === null; n++) {
    const event =
      state.shellState === 'loading'
        ? { type: 'rendered' as const }
        : state.shellState === 'challenge.idle'
          ? { type: 'input' as const, text: 'cat', caret: 3, partialState: {}, gradeable: true }
          : state.shellState === 'challenge.armed'
            ? { type: 'check' as const }
            : state.shellState === 'grading'
              ? { type: 'graded' as const }
              : { type: 'continue' as const };
    state = step(state, event, deps).state;
  }
  expect(state.shellState).toBe('outOfHearts');
  const slots = queue.map((q) => ({
    slotId: q.id,
    itemId: q.itemId,
    exerciseId: `exercise:${q.id}`,
    surface: 'gato',
    role: 'recognition' as const,
    rubyShown: false,
  }));
  const context: LearningContext = {
    ...input.context,
    slots,
    launch: {
      ...input.context.launch,
      economyFlavour: 'legendary',
      origin: { kind: 'path' },
      targetNodeId: 'u001:learn',
    },
    completion: { ...input.context.completion!, outcome: 'failed' },
  };
  const store = new SqliteLearningContextStore(db);
  store.create(context.launch, slots);
  for (const answer of state.core.answers) {
    if (answer.exerciseIndex < 0 || answer.exerciseIndex === skipReceipt) continue;
    const slot = slots.find((s) => s.slotId === answer.slotId)!;
    store.recordReceipt('en-es', sessionId, {
      ...slot,
      exerciseIndex: answer.exerciseIndex,
      answeredAtUtcMs: epoch + answer.exerciseIndex * 100,
      answeredLocalDay: toLocalDay('2026-09-13'),
      activeMs: 100,
    });
  }
  const runtimeItem = (id: string): VerifiedRuntimeItem => {
    const slot = slots.find((s) => s.exerciseId === id)!;
    return {
      schemaVersion: 1,
      exerciseId: id,
      itemId: slot.itemId,
      unitId: 'u001',
      lessonIndex: 1,
      profileId: 'es',
      responseLanguage: 'es',
      proof: {
        sourceId: 'test-source',
        sourceSha256: 'test',
        approvalId: 'test-repository-double',
        approvalSha256: 'test',
        draftSha256: 'test',
      },
      gradable: {
        itemId: slot.itemId,
        family: 'select',
        accepted: [{ surfaceId: 'sf:gato', surface: 'gato', rank: 1 }],
      },
      presentation: {
        itemId: slot.itemId,
        type: 'meaningSelect',
        instruction: 'Select',
        prompt: 'cat',
        language: 'es',
        acceptedAnswers: ['gato'],
      },
      introductions: [],
      explanation: 'Test repository boundary',
      grading: { profileId: 'es', responseLanguage: 'es', pack: ES_PACK, unit: ES_UNIT },
    };
  };
  return { db, input: { ...input, state, context, pack: { ...input.pack, runtimeItem } } };
}
it('[INV-ECO-16] actual Legendary transition with earlier wrong answer still proves checkpoint and pays one node/day consolation', () => {
  const { db, input } = checkpointFixture([0, 10, 11]);
  const result = apply(db, input);
  expect(result.result.committed?.xp).toBe(20);
  expect(db.all('SELECT node_id,local_day FROM course_checkpoint_claim')).toEqual([
    { node_id: 'u001:learn', local_day: '2026-09-13' },
  ]);
  const next = checkpointFixture([0, 10, 11], -1, 'repeat');
  // An existing same-node/day receipt is the bounded reward exclusion, independent
  // of the second caller's current exact source proof.
  next.db.run(
    "INSERT INTO committed_session(session_id,committed_at) VALUES('earlier','2026-09-13')",
  );
  next.db.run(
    "INSERT INTO course_checkpoint_claim VALUES('en-es','u001:learn','2026-09-13','earlier')",
  );
  expect(apply(next.db, next.input).result.committed?.xp).toBe(0);
});
it('[INV-ECO-16] failure on the checkpoint boundary, or a missing exact first-section receipt, earns no consolation', () => {
  const boundary = checkpointFixture([0, 1, 9]);
  expect(apply(boundary.db, boundary.input).result.committed?.xp).toBe(0);
  const missing = checkpointFixture([0, 10, 11], 0);
  expect(apply(missing.db, missing.input).result.committed?.xp).toBe(0);
});

function atTime(
  input: LearningRewardInput,
  iso: string,
  id: string,
  offset = 0,
): LearningRewardInput {
  const start = Date.parse(iso),
    stamp = { ...zone, utcOffsetMinutes: offset };
  return {
    ...input,
    state: completed(id),
    context: {
      ...input.context,
      startedLocalDay: toLocalDay(new Date(start + offset * 60000).toISOString().slice(0, 10)),
      launch: {
        ...input.context.launch,
        start: {
          ...input.context.launch.start,
          sessionId: id,
          startedAtUtcMs: start,
          startZone: stamp,
        },
      },
      completion: {
        ...input.context.completion!,
        completedAtUtcMs: start + 60000,
        completionZone: stamp,
        intendedAtUtc: new Date(start + 60000).toISOString(),
      },
    },
  };
}
it('[INV-DAY-10][INV-DAY-13][INV-ECO-25] night and weekend achievements read exact saved clocks and count each lived weekend once', () => {
  const { db, input } = setup();
  apply(db, atTime(input, '2026-09-12T13:10:00Z', 'saturday', 540)); // Tokyo 22:10
  expect(db.get('SELECT night_lessons FROM account')!.night_lessons).toBe(1);
  apply(db, atTime(input, '2026-09-13T12:00:00Z', 'sunday'));
  expect(db.get('SELECT weekend_pairs FROM account')!.weekend_pairs).toBe(1);
  apply(db, atTime(input, '2026-09-13T13:00:00Z', 'sunday-again'));
  expect(db.get('SELECT night_lessons,weekend_pairs FROM account')).toEqual({
    night_lessons: 1,
    weekend_pairs: 1,
  });
});
it('[INV-FRZ-02][INV-ECO-23] an actual seventh practiced day earns Perfect Streak once and updates records silently', () => {
  const { db, input } = setup();
  history(db, [7, 8, 9, 10, 11, 12]);
  const receipt = apply(db, input);
  expect(receipt.state.account.perfectStreakBeat).toBe('earned');
  expect(
    db.get("SELECT value FROM account_personal_record WHERE record_kind='longestStreak'")!.value,
  ).toBe(7);
  expect(
    db.get("SELECT value FROM account_personal_record WHERE record_kind='dailyMostXp'")!.value,
  ).toBe(10);
  expect(receipt.result.chain).not.toContain('S126');
  const again = apply(db, atTime(input, '2026-09-13T13:00:00Z', 'same-day'));
  expect(again.state.account.perfectStreakBeat).toBe('none');
});
it('[INV-CER-14] actual recorded break rearms the picked goal once while preserving the old pick', () => {
  const { db, input } = setup();
  history(db, [7, 8, 9], [], false, 9);
  db.run('UPDATE account SET streak_goal_value=7,streak_goal_last_picked=7');
  const receipt = apply(db, input);
  expect(receipt.state.account.streakGoal).toEqual({ goal: null, presentations: 1, lastPicked: 7 });
  expect(
    db.get(
      'SELECT streak_goal_value,streak_goal_presentations,streak_goal_last_picked FROM account',
    ),
  ).toEqual({ streak_goal_value: null, streak_goal_presentations: 1, streak_goal_last_picked: 7 });
});

it('[INV-ECO-06][INV-CER-10] a graded quit archives no-credit facts without consuming the next completed practice ladder step', () => {
  const { db, input } = setup();
  const abandoned = {
    ...input,
    state: { ...input.state, exited: 'quit' as const },
    context: {
      ...input.context,
      completion: { ...input.context.completion!, outcome: 'quit' as const },
    },
  };
  expect(apply(db, abandoned).result.chain).toEqual([]);
  expect(db.all('SELECT * FROM account_daily_xp')).toEqual([]);
  expect(apply(db, atTime(input, '2026-09-13T13:00:00Z', 'next')).state.session.xp).toBe(10);
});
it('[INV-ECO-16] dismissing the actual failed grid through X preserves frozen failed proof; forged remaining allowance cannot pay', () => {
  const { db, input } = checkpointFixture([0, 10, 11]);
  const deps: StepDeps = {
    config: DEFAULT_FLAVOUR_MATRIX.legendary,
    clock: { nowMs: () => input.state.checkpointMonotonicMs + 1 },
    grading: { grade: () => ({ kind: 'wrong' }) },
    isTypeEligible: () => true,
    stepUpTripped: () => false,
  };
  const dialog = step(input.state, { type: 'exit', route: 'closeButton' }, deps).state;
  expect(dialog.shellState).toBe('quitDialog');
  const left = step(dialog, { type: 'endSession', route: 'closeButton' }, deps).state;
  expect(apply(db, { ...input, state: left }).state.session.xp).toBe(20);
  const other = checkpointFixture([0, 10, 11], -1, 'forged');
  expect(() =>
    planLearningRewards(other.db, {
      ...other.input,
      state: {
        ...other.input.state,
        core: { ...other.input.state.core, hearts: { kind: 'pips', total: 3, remaining: 1 } },
      },
    }),
  ).toThrow(/failure proof/);
});
it('[INV-ECO-22] benign travel into last month never credits its quest completions to the new month badge', () => {
  const { db, input } = setup();
  const dayStore = new SqliteDayStore(db),
    saved = dayStore.load();
  dayStore.save({
    ...saved,
    engine: { ...saved.engine, maxLocalDaySeen: toLocalDay('2026-10-01') },
    guard: {
      maxLocalDaySeen: toLocalDay('2026-10-01'),
      lastCompletedAtUtcMs: Date.parse('2026-09-30T12:00:00Z'),
      lastZone: { ...zone, utcOffsetMinutes: 840 },
    },
  });
  db.run("INSERT INTO account_monthly_badge VALUES('2026-10',20,4,'bronze',NULL)");
  for (const id of ['earnXp', 'completeLessons', 'perfectLessons'])
    db.run("INSERT INTO account_quest VALUES('2026-09-30',?,?,1,0,NULL)", [id, id]);
  apply(db, atTime(input, '2026-09-30T13:00:00Z', 'travel', -720));
  expect(db.get('SELECT reward_local_day FROM committed_session')!.reward_local_day).toBe(
    '2026-09-30',
  );
  expect(
    db
      .all("SELECT completed_at FROM account_quest WHERE local_day='2026-09-30'")
      .every((r) => r.completed_at !== null),
  ).toBe(true);
  expect(
    db.get("SELECT completed_quests FROM account_monthly_badge WHERE month_key='2026-10'")!
      .completed_quests,
  ).toBe(4);
});

it('[INV-FRZ-02] halfway needs four actually completed days and recovered days never substitute for practice', () => {
  const { db, input } = setup();
  history(db, [14, 15, 16], [], false, 16);
  expect(
    apply(db, atTime(input, '2026-09-17T12:00:00Z', 'fourth')).state.account.perfectStreakBeat,
  ).toBe('halfway');
  expect(
    apply(db, atTime(input, '2026-09-17T13:00:00Z', 'fourth-again')).state.account
      .perfectStreakBeat,
  ).toBe('none');
  const second = setup('recovered-week');
  history(second.db, [7, 8, 9, 10, 11, 12]);
  const store = new SqliteDayStore(second.db),
    saved = store.load();
  // Real stored recovered disposition; never call it an actually practiced date.
  second.db.run("UPDATE account_day SET disposition='recovered' WHERE local_day='2026-09-12'");
  expect(apply(second.db, second.input).state.account.perfectStreakBeat).not.toBe('earned');
  expect(saved.engine.dispositions.get(toLocalDay('2026-09-12'))).toBe('completed');
});
it('[INV-ECO-23][INV-DAY-08] Daily Most XP includes actual consolation XP even when it cannot satisfy a goal', () => {
  const { db, input } = checkpointFixture([0, 10, 11]);
  apply(db, input);
  expect(
    db.get("SELECT value FROM account_personal_record WHERE record_kind='dailyMostXp'")!.value,
  ).toBe(20);
  expect(
    db.get("SELECT goal_met FROM account_day WHERE local_day='2026-09-13'")?.goal_met ?? 0,
  ).toBe(0);
});
it('[INV-ECO-16] a receipt from a different exact exercise cannot prove the checkpoint', () => {
  const { db, input } = checkpointFixture([0, 10, 11]);
  const changed = {
    ...input,
    context: {
      ...input.context,
      slots: input.context.slots.map((s, n) =>
        n === 0 ? { ...s, exerciseId: 'another-exercise' } : s,
      ),
    },
  };
  expect(apply(db, changed).state.session.xp).toBe(0);
});
it('[INV-CER-08] unknown legacy one-time Score history fails explicitly without resetting earned standing', () => {
  const { db, input } = setup();
  db.run('UPDATE course_progress SET score=10,score_unlocked=NULL');
  expect(() => planLearningRewards(db, input)).toThrow(/unknown legacy Score/);
  expect(db.get("SELECT score FROM course_progress WHERE course_id='en-es'")!.score).toBe(10);
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
});

it('[INV-CER-11] equal-value SQLite reloads do not create exposure; only the actual ordered target review contributes', () => {
  const { db, input } = setup();
  const store = new SqliteSchedulerStore(db),
    answer = input.state.core.answers[0]!;
  const specs = [answer.itemId, 'untouched-a', 'untouched-b'].map((itemId) => ({
    itemId: asItemId(itemId),
    surface: 'gato',
    kind: 'lexeme' as const,
  }));
  let initial = registerRows(emptySchedulerState('UTC'), specs);
  for (const spec of specs) {
    db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,1)', [
      'en-es',
      spec.itemId,
    ]);
    initial = introduce(initial, spec.itemId, spec.surface, new Date(epoch - 3 * 86400000));
  }
  // Seed nonzero cards with the real core review function; no historical receipt
  // claim is made for this fixture snapshot, whose SQL reload is the tested boundary.
  for (const spec of specs)
    for (const days of [2, 1]) {
      const seeded = applyEncounter(initial, {
        sessionId: asSessionId('seed-' + spec.itemId + '-' + days),
        exerciseIndex: 0,
        itemId: spec.itemId,
        surface: spec.surface,
        targetSurfaceId: 'seed-surface',
        role: 'recognition',
        grade: 3,
        at: new Date(epoch - days * 86400000),
      });
      initial = { ...initial, rows: seeded.state.rows };
    }
  expect([...initial.rows.values()].every((r) => r.retrievability > 0)).toBe(true);
  store.save('en-es', initial);
  const before = store.load('en-es', 'UTC'),
    untouchedReload = store.load('en-es', 'UTC');
  expect(untouchedReload).toEqual(before);
  expect([...untouchedReload.rows.values()][0]).not.toBe([...before.rows.values()][0]);
  const noReview = {
    ...input,
    schedulerBefore: before,
    schedulerAfter: untouchedReload,
    transitions: [],
  };
  expect(planLearningRewards(db, noReview).receipt.state.course.scoreEntries).toHaveLength(1);
  expect(planLearningRewards(db, noReview).receipt.facts.score).toBe(0);
  const exact = checkpointFixture([0, 10, 11]).input.pack.runtimeItem('exercise:' + answer.slotId);
  const target = {
    itemId: answer.itemId,
    surfaceId: 'sf:gato',
    surface: 'gato',
    role: 'recognition' as const,
    rubyShown: false,
    grade: 3 as const,
  };
  const receipt = {
    slotId: answer.slotId,
    exerciseId: exact.exerciseId,
    itemId: answer.itemId,
    surface: 'gato',
    role: target.role,
    rubyShown: false,
    exerciseIndex: answer.exerciseIndex,
    answeredAtUtcMs: epoch,
    answeredLocalDay: toLocalDay('2026-09-13'),
    activeMs: 100,
  };
  const contexts = new SqliteLearningContextStore(db);
  contexts.create(input.context.launch, [receipt]);
  contexts.recordReceipt('en-es', input.state.sessionId, receipt);
  db.run('INSERT INTO course_session_answer_target VALUES(?,?,?,?,?,?,?,?,?,?)', [
    'en-es',
    input.state.sessionId,
    answer.exerciseIndex,
    target.itemId,
    target.surfaceId,
    target.surface,
    target.role,
    0,
    target.grade,
    0,
  ]);
  const review = applyEncounter(before, {
    sessionId: asSessionId(input.state.sessionId),
    exerciseIndex: answer.exerciseIndex,
    itemId: asItemId(target.itemId),
    surface: target.surface,
    targetSurfaceId: target.surfaceId,
    role: target.role,
    grade: target.grade,
    at: new Date(epoch),
  });
  store.save('en-es', review.state, [
    {
      sessionId: input.state.sessionId,
      exerciseId: exact.exerciseId,
      packContentHash: input.pack.contentHash,
      answer,
      surface: target.surface,
      role: target.role,
      rubyShown: false,
      answeredAtUtc: new Date(epoch).toISOString(),
      activeMs: 100,
      targets: [target],
    },
  ]);
  const after = store.load('en-es', 'UTC');
  const transition: LearningSchedulerTransition = {
    courseId: 'en-es',
    sessionId: input.state.sessionId,
    answerOrdinal: 0,
    targetPosition: 0,
    answer,
    receipt,
    target,
    runtimeItem: exact,
    packContentHash: input.pack.contentHash,
    before: rowAt(before, asItemId(target.itemId), target.surface)!,
    after: rowAt(review.state, asItemId(target.itemId), target.surface)!,
    review: review.review,
    wroteAttempt: review.wroteAttempt,
  };
  const next = {
    ...input,
    context: { ...input.context, slots: [receipt] },
    schedulerBefore: before,
    schedulerAfter: after,
    transitions: [transition],
  };
  expect(() => planLearningRewards(db, { ...next, transitions: [] })).toThrow(
    /incomplete scheduler transitions/,
  );
  expect(() =>
    planLearningRewards(db, {
      ...next,
      transitions: [{ ...transition, target: { ...target, surfaceId: 'other-source' } }],
    }),
  ).toThrow(/source or order/);
  expect(() =>
    planLearningRewards(db, { ...next, transitions: [{ ...transition, answerOrdinal: 1 }] }),
  ).toThrow(/source or order/);
  expect(() =>
    planLearningRewards(db, {
      ...next,
      transitions: [
        {
          ...transition,
          before: {
            ...transition.before!,
            card: {
              ...transition.before!.card,
              due: new Date(transition.before!.card.due.getTime() + 1),
            },
          },
        },
      ],
    }),
  ).toThrow(/transition chain/);
  expect(() => planLearningRewards(db, { ...next, schedulerAfter: before })).toThrow(/final state/);
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
  apply(db, next);
  expect(
    db.get("SELECT exposure_fraction FROM course_progress WHERE course_id='en-es'")!
      .exposure_fraction,
  ).toBeCloseTo(transition.after!.retrievability / 3, 12);
});
it('[INV-ECO-16][INV-COM-06] a shortened mutable queue cannot redefine the fixed-at-launch Legendary boundary', () => {
  const { db, input } = checkpointFixture([0, 10, 11]);
  expect(input.state.progress.denominator).toBe(20);
  const shortened = {
    ...input,
    state: {
      ...input.state,
      core: { ...input.state.core, queue: input.state.core.queue.slice(0, 12) },
    },
  };
  expect(apply(db, shortened).state.session.xp).toBe(0);
});
