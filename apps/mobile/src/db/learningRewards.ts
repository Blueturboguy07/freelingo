import type { Db, DbRow } from '@freelingo/schema';
import {
  canonicalJson,
  comboAfter,
  gradedAttemptCount,
  exerciseSpec,
  DEFAULT_FLAVOUR_MATRIX,
  type SessionState,
} from '@freelingo/core/session';
import { perfectWeekVerdict } from '@freelingo/core/streak';
import type { SessionFlavour as EconomyFlavour } from '@freelingo/core/types';
import { rowKeyOf, asItemId, type FsrsRow, type SchedulerState } from '@freelingo/core/scheduler';
import type { LearningSchedulerTransition } from './learningTransitions';
import {
  allUnits,
  unitTrophyLegendary,
  CEFR_BAND_RANGES,
  type PathModel,
} from '@freelingo/core/path';
import {
  awardForSession,
  flavourRow,
  FLAVOUR_XP,
  recordGoalXp,
  activeBoostFrom,
  activateBoost,
  grantBoost,
  SOCIETY_CHECKPOINTS,
  type BoostState,
  questsForDay,
  QUEST_TEMPLATES,
  QUESTS_PER_DAY,
  QUEST_CHEST_GEMS_MIN,
  QUEST_CHEST_GEMS_MAX,
  seededPrng,
  ACHIEVEMENTS,
  ACHIEVEMENT_TIER_GEMS,
  badgeTargetForMonth,
  trailingMedianDailyXp,
  type GoalLedger,
  type SessionAward,
} from '@freelingo/core/economy';
import {
  isNocturnal,
  weekendWarriorWeeks,
  weekKeyOf,
  type DayLedger,
  type ZoneStamp,
  enterSocietyTier,
  hasEnteredTier,
  recordChallengeLesson,
  completeChallenge,
  addCivilDays,
  commitSession,
  mayMintDayKeyedReward,
  rolloverTo,
  streakFromDispositions,
  toLocalDay,
  type SessionRow,
} from '@freelingo/core/day';
import {
  onStreakBroken,
  advanceScore,
  scoreSlotEntries,
  runCeremony,
  EMPTY_BUNDLE,
  STREAK_MILESTONE_DAYS,
  type TierCrossing,
  type CeremonyState,
} from '@freelingo/core/ceremony';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import { SqliteLearningContextStore, type LearningContext } from './SqliteLearningContextStore';
import { SqliteDayStore, type PersistedDayState } from './SqliteDayStore';
import { SqliteCeremonyStore } from './SqliteCeremonyStore';
import { serialiseCeremonyReceipt, type CeremonyReceipt } from './ceremonyCodec';
import { LearningDataError } from './SqliteSchedulerStore';
import { SqliteWordStore, type LearningWordPlan } from './SqliteWordStore';

/** Source-backed reward slice. Scholar consumes the owned WordStore plan; Reviewer
 * still needs an explicit FSRS-retirement rule and Strategist a real guidebook display
 * receipt. Those existing counters remain unchanged until their source features exist.
 * These are actual before/after views inside the runtime's one completion transaction.
 * The runtime owns source/attempt validation, scheduler updates and path progress. */
export interface LearningRewardInput {
  readonly state: SessionState;
  readonly context: LearningContext;
  readonly pack: VerifiedInstalledPack;
  readonly transitions: readonly LearningSchedulerTransition[];
  readonly schedulerBefore: SchedulerState;
  readonly schedulerAfter: SchedulerState;
  readonly pathBefore: PathModel;
  readonly pathAfter: PathModel;
}
/** Opaque capability: copying these display fields does not create a writable plan. */
export interface LearningRewardPlan {
  readonly sessionId: string;
  readonly courseId: string;
  readonly award: SessionAward;
  readonly receipt: CeremonyReceipt;
}
interface Planned {
  readonly db: Db;
  readonly wordStore: SqliteWordStore;
  readonly wordPlan: LearningWordPlan;
  readonly fingerprint: string;
  readonly writerFacts: { readonly context: LearningContext; readonly graded: number };
  readonly streakGoal: CeremonyState['account']['streakGoal'];
  readonly records: readonly DbRow[];
  readonly accountCounters: Readonly<Record<string, number>>;
  readonly quests: readonly DbRow[];
  readonly badge: DbRow | null;
  readonly achievementCrossings: readonly TierCrossing[];
  readonly boosts: readonly DbRow[];
  readonly societyEntered: string | null;
  readonly checkpointReached: boolean;
  readonly row: SessionRow;
  readonly day: PersistedDayState;
  readonly goals: GoalLedger;
  readonly goalMet: boolean;
  readonly streak: number;
  readonly score: ReturnType<typeof advanceScore>['state'];
  readonly plan: LearningRewardPlan;
}
const plans = new WeakMap<LearningRewardPlan, Planned>();
/** Named persistence binding, 2026-09-13 implementation policy, not measured UI data.
 * A detached caller may not apply a read plan after any relevant durable fact changed. */
const REWARD_READ_TABLES = [
  'account',
  'course_progress',
  'course_node',
  'account_day',
  'account_daily_xp',
  'account_quest',
  'account_monthly_badge',
  'account_boost',
  'account_personal_record',
  'account_achievement_award',
  'account_freeze',
  'account_freeze_grant',
  'account_streak_break',
  'account_streak_break_day',
  'account_recovery_challenge',
  'account_streak_repair',
  'account_streak_repair_day',
  'account_month_settlement',
  'account_long_absence',
  'course_checkpoint_claim',
  'committed_session',
  'course_session_context',
  'course_session_slot',
  'course_session_answer_receipt',
  'course_session_answer_target',
  'course_session_commit_link',
] as const;
function fingerprint(db: Db): string {
  return canonicalJson(
    REWARD_READ_TABLES.map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]),
  );
}
function fail(reason: string): never {
  throw new LearningDataError('Invalid learning rewards: ' + reason);
}
function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return fail(name);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (value !== 0 && value !== 1) return fail(name);
  return value === 1;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function goalsFrom(db: Db): GoalLedger {
  return new Map(
    db.all('SELECT * FROM account_day ORDER BY local_day').map((r) => {
      const day = toLocalDay(String(r.local_day));
      if ((r.chest_granted_at === null) !== (r.goal_xp_at_grant === null))
        return fail('unknown goal grant history');
      if (boolean(r.goal_met, 'goal met') !== (r.chest_granted_at !== null))
        return fail('goal grant mismatch');
      return [
        day,
        {
          localDay: day,
          earnedXp: integer(r.earned_xp, 'day XP'),
          goalXpAtGrant:
            r.goal_xp_at_grant === null ? null : integer(r.goal_xp_at_grant, 'goal at grant'),
          grantedAtUtc: r.chest_granted_at === null ? null : String(r.chest_granted_at),
        },
      ];
    }),
  );
}
function maximumCombo(state: SessionState): number {
  let combo = 0,
    max = 0;
  for (const answer of state.core.answers) {
    combo = comboAfter(combo, answer);
    max = Math.max(max, combo);
  }
  return max;
}
function validate(input: LearningRewardInput, db: Db): DbRow {
  const { state: s, context: c, pack, pathBefore: b, pathAfter: a } = input;
  if (
    !c.completion ||
    s.sessionId !== c.launch.start.sessionId ||
    s.courseId !== c.launch.courseId ||
    s.courseId !== pack.courseId ||
    s.sessionKind !== c.launch.sessionKind ||
    s.nodeRef !== c.launch.nodeRef ||
    c.launch.packContentHash !== pack.contentHash
  )
    return fail('session or pack binding');
  if (gradedAttemptCount(s) === 0) return fail('terminal graded state required');
  if (c.completion.outcome === 'failed') {
    // Exhaustion is durable before the learner dismisses S060. The final graded
    // answer can be a negative-index replay or the aggregate of a partial match grid.
    const terminal = s.core.answers.at(-1),
      allowance = DEFAULT_FLAVOUR_MATRIX[s.flavour].mistakeAllowance;
    if (
      s.core.hearts.kind !== 'pips' ||
      s.core.hearts.remaining !== 0 ||
      s.core.hearts.total !== allowance ||
      (s.exited !== null && s.exited !== 'quit') ||
      allowance === null ||
      !terminal ||
      !terminal.wrong ||
      terminal.skipped ||
      terminal.verdict === 'noVerdict' ||
      s.core.answers.reduce((sum, a) => sum + integer(a.costPaid, 'terminal cost'), 0) < allowance
    )
      return fail('exhausted failure proof');
  } else {
    if (s.exited === null) return fail('terminal graded state required');
    if ((c.completion.outcome === 'quit') !== (s.exited === 'quit'))
      return fail('terminal outcome');
  }
  if (
    (c.completion.outcome === 'completed' || c.completion.outcome === 'replayed') &&
    s.shellState !== 'complete'
  )
    return fail('incomplete session');
  if (db.get('SELECT session_id FROM committed_session WHERE session_id=?', [s.sessionId]))
    return fail('already committed');
  const course = db.get('SELECT * FROM course_progress WHERE course_id=?', [s.courseId]);
  if (!course || course.pack_content_hash !== pack.contentHash) return fail('saved pack binding');
  const declared = pack.pack.path();
  if (
    canonicalJson(a.manifest) !== canonicalJson(declared.manifest) ||
    canonicalJson(a.manifest) !== canonicalJson(b.manifest) ||
    a.scoreEarned < b.scoreEarned ||
    a.scoreFloor < b.scoreFloor
  )
    return fail('path or score binding');
  if (
    input.schedulerAfter.score.masteryHighWaterPoints <
    input.schedulerBefore.score.masteryHighWaterPoints
  )
    return fail('scheduler high-water regressed');
  integer(c.activeMs, 'active milliseconds');
  return course;
}
/** Deterministic gem draw inside the approved 5–15 range, implementation choice
 * 2026-09-13. The saved device seed/day/template key cannot be rerolled on resume. */
function questGems(seed: number, day: string, id: string): number {
  return seededPrng(`quest-reward:${seed}:${day}:${id}`).int(
    QUEST_CHEST_GEMS_MIN,
    QUEST_CHEST_GEMS_MAX,
  );
}
function questRows(db: Db, day: NonNullable<SessionRow['rewardLocalDay']>, account: DbRow) {
  const seed = integer(account.selection_seed, 'saved selection seed');
  const history = db.all(
    'SELECT local_day,earned_xp FROM account_day WHERE local_day<? ORDER BY local_day',
    [day],
  );
  const first = history[0]?.local_day;
  const trend: number[] = [];
  if (typeof first === 'string')
    for (let d = addCivilDays(day, -7); d < day; d = addCivilDays(d, 1))
      if (d >= first)
        trend.push(
          integer(history.find((r) => r.local_day === d)?.earned_xp ?? 0, 'quest history XP'),
        );
  const stored = db.all('SELECT * FROM account_quest WHERE local_day=? ORDER BY quest_id', [day]);
  const rows =
    stored.length === 0
      ? questsForDay(day, String(seed), {
          goalXp: integer(account.daily_goal_xp, 'daily goal', 1),
          trailingDailyXp: trend,
        }).map((q) => ({
          local_day: day,
          quest_id: q.templateId,
          template_id: q.templateId,
          target: q.target,
          progress: 0,
          completed_at: null,
        }))
      : stored;
  if (
    rows.length !== QUESTS_PER_DAY ||
    new Set(rows.map((r) => r.template_id)).size !== rows.length
  )
    return fail('quest population');
  for (const r of rows) {
    if (!QUEST_TEMPLATES.some((q) => q.id === r.template_id)) return fail('unknown quest template');
    integer(r.target, 'quest target', 1);
    integer(r.progress, 'quest progress');
    if (r.completed_at !== null && Number(r.progress) < Number(r.target))
      return fail('quest completion');
  }
  return { seed, trend, rows };
}
function questIncrement(
  id: string,
  facts: {
    xp: number;
    comboXp: number;
    combo: number;
    accuracy: number | null;
    perfect: boolean;
    lessons: boolean;
    streak: number;
    gems: number;
  },
): number {
  switch (id) {
    case 'earnXp':
      return facts.xp;
    case 'comboBonusXp':
      return facts.comboXp;
    case 'completeLessons':
      return Number(facts.lessons);
    case 'perfectLessons':
      return Number(facts.lessons && facts.perfect);
    case 'accuracy90':
      return Number(facts.lessons && facts.accuracy !== null && facts.accuracy >= 0.9);
    case 'accuracy80':
      return Number(facts.lessons && facts.accuracy !== null && facts.accuracy >= 0.8);
    case 'fiveInARow':
      return Number(facts.lessons && facts.combo >= 5);
    case 'tenInARow':
      return Number(facts.lessons && facts.combo >= 10);
    case 'earnGems':
      return facts.gems;
    case 'reachStreak':
      return facts.streak;
    default:
      return fail('unknown quest effect');
  }
}
/** Parent-approved Freelingo partition, 2026-09-13: the actual frozen initial
 * main queue has two nonempty sections, split at ceil(N/2). This proves the engine
 * proceeded past that boundary; it does not claim any checkpoint interstitial rendered. */
function checkpointReached(db: Db, input: LearningRewardInput): boolean {
  if (
    input.context.launch.economyFlavour !== 'legendary' ||
    input.context.completion?.outcome === 'quit'
  )
    return false;
  const { state, context } = input,
    queue = state.core.queue,
    boundary = Math.ceil(state.progress.denominator / 2);
  if (
    queue.length !== state.progress.denominator ||
    queue.length < 2 ||
    state.core.index < boundary ||
    context.launch.targetNodeId === null
  )
    return false;
  const receipts = new SqliteLearningContextStore(db).receipts(state.courseId, state.sessionId);
  let cost = 0;
  for (let index = 0; index < boundary; index++) {
    const q = queue[index]!,
      answer = state.core.answers.find((a) => a.exerciseIndex === index && a.queue === 'main');
    const slot = context.slots.find((s) => s.slotId === q.id),
      receipt = receipts.find((r) => r.exerciseIndex === index);
    if (
      !answer ||
      answer.skipped ||
      answer.verdict === 'noVerdict' ||
      answer.slotId !== q.id ||
      answer.itemId !== q.itemId ||
      answer.type !== q.type ||
      !slot ||
      !receipt ||
      slot.itemId !== q.itemId ||
      receipt.slotId !== slot.slotId ||
      receipt.itemId !== slot.itemId ||
      receipt.exerciseId !== slot.exerciseId
    )
      return false;
    const exact = input.pack.runtimeItem(slot.exerciseId);
    if (exact.itemId !== q.itemId || exact.presentation.type !== q.type) return false;
    cost += integer(answer.costPaid, 'checkpoint cost');
  }
  const allowance = DEFAULT_FLAVOUR_MATRIX.legendary.mistakeAllowance;
  return allowance !== null && cost < allowance;
}
function boostRows(db: Db, at: string, sequenceMs: number) {
  const rows = db.all('SELECT * FROM account_boost ORDER BY granted_at,grant_id'),
    out: DbRow[] = [];
  let active: BoostState['activeBoost'] = null;
  const inventory: BoostState['inventory'][number][] = [];
  for (const r of rows) {
    if (
      r.kind !== 'xpBoost' &&
      r.kind !== 'happyHour' &&
      r.kind !== 'timerBoost' &&
      r.kind !== 'earlyBird'
    )
      return fail('boost kind');
    const grant: BoostState['inventory'][number] = {
      kind: r.kind,
      multiplier: integer(r.multiplier, 'boost multiplier', 1),
      durationMinutes: integer(r.duration_minutes, 'boost minutes', 1),
      grantedAtUtc: String(r.granted_at),
    };
    if (r.activated_at_utc === null) {
      inventory.push(grant);
      out.push(r);
      continue;
    }
    const found = activeBoostFrom(
      {
        ...grant,
        activatedAtUtc: String(r.activated_at_utc),
        activationSequenceMs: integer(r.activation_sequence_ms, 'boost sequence'),
        durationSeconds: integer(r.duration_seconds, 'boost seconds', 1),
        tamperHighWaterUtc: String(r.tamper_high_water_utc),
      },
      { nowUtc: at, sequenceMs },
    );
    if (found.active !== null) {
      if (active !== null) return fail('multiple active boosts');
      active = found.active;
    }
    out.push({
      ...r,
      tamper_high_water_utc: found.clamp.boost.tamperHighWaterUtc,
      expires_at: found.active?.expiresAtUtc ?? at,
    });
  }
  return { rows: out, state: { activeBoost: active, inventory } satisfies BoostState };
}
/** Only fully stamped committed lessons can prove calendar predicates. Legacy rows
 * with no captured completion stamp do not invent a lived day or move lifetime counters. */
function archivedLessons(db: Db): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const r of db.all(
    'SELECT * FROM committed_session WHERE derived_completion_utc_ms IS NOT NULL AND graded_attempts > 0',
  )) {
    const flavour = Object.keys(FLAVOUR_XP).find((k) => k === r.flavour) as
      EconomyFlavour | undefined;
    const outcome = (['completed', 'replayed', 'failed', 'quit'] as const).find(
      (k) => k === r.outcome,
    );
    if (!flavour || !outcome) return fail('archived flavour or outcome');
    if (!flavourRow(flavour, outcome).countsAsLesson) continue;
    const zone = (prefix: 'start' | 'completion'): ZoneStamp => {
      const source = r[prefix + '_tz_source'];
      if (source !== 'iana' && source !== 'fixed_offset' && source !== 'unknown')
        return fail('archived zone');
      return {
        tzId: String(r[prefix + '_tz_id']),
        utcOffsetMinutes: integer(r[prefix + '_utc_offset_minutes'], 'zone offset', -1440),
        tzSource: source,
      };
    };
    rows.push({
      sessionId: String(r.session_id),
      startedAtUtcMs: integer(r.started_at_utc_ms, 'archive start', -Number.MAX_SAFE_INTEGER),
      startZone: zone('start'),
      startedLocalDay: toLocalDay(String(r.started_local_day)),
      completedAtUtcMs: integer(
        r.completed_at_utc_ms,
        'archive completion',
        -Number.MAX_SAFE_INTEGER,
      ),
      completionZone: zone('completion'),
      completedLocalDay: toLocalDay(String(r.completed_local_day)),
      derivedCompletionUtcMs: integer(
        r.derived_completion_utc_ms,
        'archive derived',
        -Number.MAX_SAFE_INTEGER,
      ),
      creditedLocalDay:
        r.credited_local_day === null ? null : toLocalDay(String(r.credited_local_day)),
      rewardLocalDay: r.reward_local_day === null ? null : toLocalDay(String(r.reward_local_day)),
      creditedByGrace: boolean(r.credited_by_grace, 'archive grace'),
      dayKeyingDeferred: boolean(r.day_keying_deferred, 'archive deferred'),
      earnedXp: integer(r.xp_awarded, 'archive XP'),
      earnedGems: integer(r.gems_awarded, 'archive gems'),
    });
  }
  return rows;
}
/** Approved 2026-09-13 Freelingo implementation partition: halfway means 4 of
 * 7 actually completed lived dates in the Monday-keyed week. No frozen, recovered
 * or unlived date contributes a practice day. The existing core owns week verdicts. */
const PERFECT_WEEK_HALFWAY_DAYS = 4;
function perfectBeat(
  before: DayLedger,
  after: DayLedger,
  day: NonNullable<SessionRow['rewardLocalDay']>,
): CeremonyState['account']['perfectStreakBeat'] {
  const week = weekKeyOf(day),
    previous = perfectWeekVerdict(before, week),
    next = perfectWeekVerdict(after, week);
  if (previous !== 'broken' && next === 'broken') return 'reset';
  if (previous !== 'perfect' && next === 'perfect') return 'earned';
  if (next === 'broken') return 'none';
  const practiced = (ledger: DayLedger) =>
    Array.from({ length: 7 }, (_, n) => ledger.get(addCivilDays(week, n))).filter(
      (v) => v === 'completed',
    ).length;
  return practiced(before) < PERFECT_WEEK_HALFWAY_DAYS &&
    practiced(after) >= PERFECT_WEEK_HALFWAY_DAYS
    ? 'halfway'
    : 'none';
}
/** Compare values across SQLite reloads while preserving Date instants. Session
 * canonicalJson alone intentionally has no Date codec and would erase card timestamps. */
function sameSnapshot(a: unknown, b: unknown): boolean {
  return (
    canonicalJson(JSON.parse(JSON.stringify(a))) === canonicalJson(JSON.parse(JSON.stringify(b)))
  );
}
/** Sum exactly the ordered, source-bound review targets produced by the outer
 * completion loop. Reloaded object identities and untouched cards provide no exposure. */
function reviewedExposure(db: Db, input: LearningRewardInput): number {
  const { transitions, state } = input;
  if (!Array.isArray(transitions)) return fail('missing scheduler transitions');
  const targets = db.all('SELECT * FROM course_session_answer_target WHERE session_id=?', [
    state.sessionId,
  ]);
  if (targets.length !== transitions.length) return fail('incomplete scheduler transitions');
  const receipts = transitions.length
    ? new SqliteLearningContextStore(db).receipts(state.courseId, state.sessionId)
    : [];
  const latest = new Map<string, FsrsRow | null>();
  let ordinal = -1,
    position = -1,
    exposure = 0;
  for (const t of transitions) {
    integer(t.answerOrdinal, 'transition answer order');
    integer(t.targetPosition, 'transition target order');
    const source = targets.find(
      (r) => r.exercise_index === t.answer.exerciseIndex && r.position === t.targetPosition,
    );
    if (
      t.courseId !== state.courseId ||
      t.sessionId !== state.sessionId ||
      t.packContentHash !== input.pack.contentHash ||
      t.answerOrdinal < ordinal ||
      t.targetPosition !== (t.answerOrdinal === ordinal ? position + 1 : 0) ||
      !sameSnapshot(state.core.answers[t.answerOrdinal] ?? null, t.answer) ||
      !sameSnapshot(receipts[t.answerOrdinal] ?? null, t.receipt) ||
      t.receipt.exerciseIndex !== t.answer.exerciseIndex ||
      t.receipt.slotId !== t.answer.slotId ||
      t.receipt.itemId !== t.answer.itemId ||
      t.runtimeItem.exerciseId !== t.receipt.exerciseId ||
      t.runtimeItem.itemId !== t.receipt.itemId ||
      !source ||
      source.course_id !== state.courseId ||
      source.target_item_id !== t.target.itemId ||
      source.target_surface_id !== t.target.surfaceId ||
      source.target_surface !== t.target.surface ||
      source.encounter_role !== t.target.role ||
      source.ruby_shown !== Number(t.target.rubyShown) ||
      source.grade !== t.target.grade
    )
      return fail('scheduler transition source or order');
    ordinal = t.answerOrdinal;
    position = t.targetPosition;
    const key = rowKeyOf(asItemId(t.target.itemId), t.target.surface),
      expected = latest.has(key) ? latest.get(key)! : (input.schedulerBefore.rows.get(key) ?? null);
    if (
      !sameSnapshot(expected, t.before) ||
      (t.before !== null && t.before.key !== key) ||
      (t.after !== null && t.after.key !== key)
    )
      return fail('scheduler transition chain');
    if (t.review !== null) {
      if (
        !t.wroteAttempt ||
        t.after === null ||
        !sameSnapshot(t.review.row, t.after) ||
        !Number.isFinite(t.after.retrievability) ||
        t.after.retrievability < 0 ||
        t.after.retrievability > 1
      )
        return fail('scheduler review result');
      exposure += t.after.retrievability;
    } else if (!sameSnapshot(t.before, t.after)) return fail('row changed without review');
    latest.set(key, t.after);
  }
  for (const [key, row] of latest)
    if (!sameSnapshot(row, input.schedulerAfter.rows.get(key as FsrsRow['key']) ?? null))
      return fail('scheduler transition final state');
  return exposure;
}
/** Read-only planning. No clock reads: boost/day decisions use the frozen completion intent. */
export function planLearningRewards(db: Db, input: LearningRewardInput): LearningRewardPlan {
  const course = validate(input, db),
    account = db.get('SELECT * FROM account WHERE id=1');
  if (!account) return fail('missing account');
  const { state, context, pack, pathBefore, pathAfter } = input,
    completion = context.completion!;
  const mode = flavourRow(context.launch.economyFlavour, completion.outcome);
  const savedDay = new SqliteDayStore(db).load();
  const beforeDays = new Map(savedDay.engine.dispositions);
  for (const d of savedDay.satisfiedDays) if (!beforeDays.has(d)) beforeDays.set(d, 'completed');
  let row = commitSession(
    context.launch.start,
    { ...completion, earnedXp: 0, earnedGems: 0 },
    { satisfiedDays: savedDay.satisfiedDays },
  );
  if (
    row.rewardLocalDay !== null &&
    !mayMintDayKeyedReward(savedDay.guard, {
      day: row.rewardLocalDay,
      completedAtUtcMs: row.completedAtUtcMs,
      completionZone: row.completionZone,
    })
  )
    row = {
      ...row,
      creditedLocalDay: null,
      rewardLocalDay: null,
      creditedByGrace: false,
      dayKeyingDeferred: true,
    };
  const rewardDay = row.rewardLocalDay,
    at = new Date(row.derivedCompletionUtcMs).toISOString();
  const ladderMode = FLAVOUR_XP[context.launch.economyFlavour].ladderMode;
  const ladder =
    rewardDay === null
      ? undefined
      : db.get('SELECT * FROM account_daily_xp WHERE local_day=? AND ladder_mode=?', [
          rewardDay,
          ladderMode,
        ]);
  const checkpoint =
    context.launch.targetNodeId === null || rewardDay === null
      ? true
      : db.get(
          'SELECT 1 FROM course_checkpoint_claim WHERE course_id=? AND node_id=? AND local_day=?',
          [state.courseId, context.launch.targetNodeId, rewardDay],
        ) !== undefined;
  const reachedCheckpoint = checkpointReached(db, input);
  const award = awardForSession({
    flavour: context.launch.economyFlavour,
    outcome: completion.outcome,
    maxCombo: maximumCombo(state),
    practiceItemRatio: context.launch.practiceItemRatio,
    boostAtSessionStart: context.launch.boostAtStart,
    committedAtUtc: at,
    ladderStateToday: {
      sessionsCompleted: ladder ? integer(ladder.sessions_counted, 'ladder count') : 0,
      xpAwarded: ladder ? integer(ladder.xp_awarded, 'ladder XP') : 0,
    },
    checkpointAlreadyPaidToday: checkpoint,
    reachedLegendaryCheckpoint: reachedCheckpoint,
    ...(context.launch.longFormEntry === null
      ? {}
      : { longFormEntry: context.launch.longFormEntry }),
  });
  let goals = goalsFrom(db),
    chest = false,
    gems = 0,
    goalMet = false;
  if (rewardDay !== null && mode.countsTowardGoal) {
    const result = recordGoalXp(
      goals,
      rewardDay,
      award.awardedXp,
      integer(account.daily_goal_xp, 'daily goal', 1),
      at,
    );
    goals = result.ledger;
    chest = result.chestFired;
    gems = result.gemsAwarded;
    goalMet = result.dayMet;
  }
  let engine = savedDay.engine;
  const satisfied = new Set(savedDay.satisfiedDays),
    grace = new Set(engine.graceCreditedDays);
  if (mode.extendsStreak && row.creditedLocalDay !== null) {
    satisfied.add(row.creditedLocalDay);
    if (row.creditedByGrace) grace.add(row.creditedLocalDay);
  }
  if (rewardDay !== null && context.launch.economyFlavour === 'recovery' && mode.countsAsLesson)
    engine = recordChallengeLesson(engine, context.startedLocalDay);
  if (rewardDay !== null)
    engine = rolloverTo({ ...engine, graceCreditedDays: grace }, rewardDay, {
      completedDays: satisfied,
      graceCreditedDays: grace,
    }).state;
  if (rewardDay !== null && context.launch.economyFlavour === 'recovery' && mode.countsAsLesson) {
    const restore = completeChallenge(engine, rewardDay);
    engine = restore.state;
    if (restore.restored) satisfied.add(rewardDay);
  }
  const effective = new Map(engine.dispositions);
  for (const d of satisfied) if (!effective.has(d)) effective.set(d, 'completed');
  const streak =
    rewardDay === null
      ? integer(account.streak, 'streak')
      : streakFromDispositions(effective, rewardDay);
  const maxDay =
    rewardDay === null
      ? savedDay.guard.maxLocalDaySeen
      : savedDay.guard.maxLocalDaySeen === null || rewardDay > savedDay.guard.maxLocalDaySeen
        ? rewardDay
        : savedDay.guard.maxLocalDaySeen;
  let day: PersistedDayState = {
    engine: {
      ...engine,
      maxLocalDaySeen: maxDay,
      longestStreak: Math.max(engine.longestStreak, streak),
      clockUnreliable: engine.clockUnreliable || row.dayKeyingDeferred,
    },
    satisfiedDays: satisfied,
    guard:
      rewardDay === null
        ? savedDay.guard
        : {
            maxLocalDaySeen: maxDay,
            lastCompletedAtUtcMs: row.completedAtUtcMs,
            lastZone: row.completionZone,
          },
  };
  const boosted = boostRows(db, at, completion.completedAtMonotonicMs);
  let boostState: BoostState = boosted.state;
  let societyEntered: string | null = null,
    freezeGift = 0,
    boostGift: CeremonyState['account']['bundle']['boost'] = null,
    societyBeat: CeremonyState['account']['streakSocietyBeat'] = 'none';
  if (rewardDay !== null && mode.extendsStreak) {
    for (const checkpoint of SOCIETY_CHECKPOINTS) {
      if (
        integer(account.longest_streak, 'longest streak') >= checkpoint.streakDays ||
        streak < checkpoint.streakDays ||
        hasEnteredTier(day.engine.ledger, checkpoint.id)
      )
        continue;
      const granted = enterSocietyTier(day.engine.ledger, checkpoint.id, at, rewardDay);
      day = { ...day, engine: { ...day.engine, ledger: granted.ledger } };
      freezeGift += granted.applied;
      societyBeat = checkpoint === SOCIETY_CHECKPOINTS[0] ? 'induction' : 'reward';
      if (checkpoint === SOCIETY_CHECKPOINTS[0] && account.society_entered_on_day === null)
        societyEntered = rewardDay;
      const gift = {
        kind: 'xpBoost' as const,
        multiplier: 2,
        durationMinutes: checkpoint.boostMinutes,
        grantedAtUtc: at,
      };
      const grant = grantBoost(boostState, gift, at);
      boostState = grant.state;
      if (grant.accepted) {
        const running = grant.started
          ? activateBoost(gift, { nowUtc: at, sequenceMs: completion.completedAtMonotonicMs })
          : null;
        boosted.rows.push({
          grant_id: `society:${checkpoint.id}`,
          kind: gift.kind,
          multiplier: gift.multiplier,
          duration_minutes: gift.durationMinutes,
          duration_seconds: gift.durationMinutes * 60,
          granted_at: at,
          activated_at_utc: running?.activatedAtUtc ?? null,
          activation_sequence_ms: running?.activationSequenceMs ?? null,
          tamper_high_water_utc: running?.tamperHighWaterUtc ?? null,
          expires_at: grant.started ? grant.state.activeBoost!.expiresAtUtc : null,
        });
        boostGift = { multiplier: gift.multiplier, durationMinutes: gift.durationMinutes };
      }
    }
  }
  const beforeScore = integer(course.score, 'stored score');
  // A legacy nonzero score cannot prove whether its one-time screens already ran.
  if (
    (course.score_unlocked === null || course.score_ceiling_beat_shown === null) &&
    (beforeScore !== 0 || course.exposure_fraction !== 0)
  )
    return fail('unknown legacy Score presentation history');
  const previousScore = {
    exposureFraction: Number(course.exposure_fraction),
    masteryScore: Math.max(beforeScore, pathBefore.scoreEarned),
    ceiling: pathAfter.manifest.scoreCeiling,
    unlocked:
      course.score_unlocked === null ? false : boolean(course.score_unlocked, 'score unlock'),
    ceilingBeatShown:
      course.score_ceiling_beat_shown === null
        ? false
        : boolean(course.score_ceiling_beat_shown, 'score max'),
  };
  const graded = gradedAttemptCount(state);
  const exposed = reviewedExposure(db, input);
  const wordStore = new SqliteWordStore(db);
  const wordPlan = wordStore.prepare({
    courseId: state.courseId,
    sessionId: state.sessionId,
    schedulerBefore: input.schedulerBefore,
    transitions: input.transitions,
  });
  const score = advanceScore(
    previousScore,
    {
      gradedItems: graded,
      exposureDelta: exposed / Math.max(1, input.schedulerAfter.rows.size),
      masteryDelta: Math.max(0, pathAfter.scoreEarned - previousScore.masteryScore),
    },
    (n) =>
      Math.max(
        0,
        CEFR_BAND_RANGES.findIndex((b) => n >= b.min && n <= b.max),
      ),
  );
  const nodesBefore = new Map(
      allUnits(pathBefore).flatMap((u) => u.nodes.map((n) => [n.id, n] as const)),
    ),
    nodesAfter = allUnits(pathAfter).flatMap((u) => u.nodes);
  const target = context.launch.targetNodeId,
    node = nodesAfter.find((n) => n.id === target),
    oldNode = target === null ? undefined : nodesBefore.get(target);
  const nodeCompleted =
    node !== undefined &&
    oldNode !== undefined &&
    oldNode.subLessonsDone < oldNode.subLessonsTotal &&
    node.subLessonsDone === node.subLessonsTotal;
  const newUnits = pathAfter.completedUnits.filter((u) => !pathBefore.completedUnits.includes(u));
  const sectionCompleted = pathAfter.sections.some(
    (s) =>
      s.units.every((u) => pathAfter.completedUnits.includes(u.index)) &&
      !s.units.every((u) => pathBefore.completedUnits.includes(u.index)),
  );
  const courseCompleted =
    allUnits(pathAfter).every((u) => pathAfter.completedUnits.includes(u.index)) &&
    !allUnits(pathBefore).every((u) => pathBefore.completedUnits.includes(u.index));
  let consecutive = 0;
  if (rewardDay !== null)
    for (let d = rewardDay; goals.get(d)?.grantedAtUtc != null; d = addCivilDays(d, -1))
      consecutive++;
  const selectedGoal =
    account.streak_goal_declined === 1
      ? ('DECLINED' as const)
      : account.streak_goal_value === null
        ? null
        : integer(account.streak_goal_value, 'streak goal');
  let streakGoal: CeremonyState['account']['streakGoal'] = {
    goal: selectedGoal,
    presentations: integer(account.streak_goal_presentations, 'goal presentations'),
    lastPicked:
      account.streak_goal_last_picked === null
        ? null
        : integer(account.streak_goal_last_picked, 'prior goal'),
  };
  if (day.engine.brk !== null && day.engine.brk.brokenOn !== savedDay.engine.brk?.brokenOn)
    streakGoal = onStreakBroken(streakGoal);
  const goal = streakGoal.goal;
  const extended = streak > integer(account.streak, 'prior streak');
  const mistakes = state.core.answers.filter((a) => a.wrong && !a.skipped).length;
  const denominator = state.core.answers.filter((a) => a.scorable && !a.skipped);
  const accuracy =
    denominator.length === 0
      ? null
      : denominator.filter((a) => !a.wrong).length / denominator.length;
  const perfect =
    mistakes === 0 &&
    state.core.answers.some((a) => !a.skipped && a.scorable && exerciseSpec(a.type).punitive);
  const priorLessons = archivedLessons(db),
    priorWeekends = weekendWarriorWeeks(priorLessons, beforeDays);
  const nextWeekends = weekendWarriorWeeks(
    mode.countsAsLesson ? [...priorLessons, row] : priorLessons,
    effective,
  );
  const counters: Record<string, number> = {
    night_lessons:
      integer(account.night_lessons, 'night lessons') +
      Number(mode.countsAsLesson && rewardDay !== null && isNocturnal(row)),
    weekend_pairs:
      integer(account.weekend_pairs, 'weekend pairs') +
      nextWeekends.filter((w) => !priorWeekends.includes(w)).length,
    stories_completed:
      integer(account.stories_completed, 'stories') +
      Number(
        mode.countsAsLesson &&
          context.launch.economyFlavour === 'story' &&
          completion.outcome === 'completed',
      ),
    // Strategist requires an actual guidebook display receipt. That source feature is
    // not implemented yet; no qualifying event is manufactured from the launch unit.
    guidebook_then_lesson: integer(account.guidebook_then_lesson, 'guidebook lessons'),
    lifetime_xp: integer(account.lifetime_xp, 'lifetime XP') + award.awardedXp,
    longest_streak: day.engine.longestStreak,
    perfect_lessons:
      integer(account.perfect_lessons, 'perfect lessons') + Number(mode.countsAsLesson && perfect),
    nodes_completed: integer(account.nodes_completed, 'nodes completed') + Number(nodeCompleted),
    sections_completed:
      integer(account.sections_completed, 'sections completed') + Number(sectionCompleted),
    units_legendary:
      integer(account.units_legendary, 'legendary units') +
      allUnits(pathAfter).filter(
        (u) =>
          unitTrophyLegendary(u, pathAfter.manifest) &&
          !unitTrophyLegendary(
            allUnits(pathBefore).find((b) => b.index === u.index) ?? fail('missing prior unit'),
            pathBefore.manifest,
          ),
      ).length,
    legendary_levels_earned:
      integer(account.legendary_levels_earned, 'legendary levels') +
      Number(node?.legendary === true && oldNode?.legendary === false),
  };
  const crossings: TierCrossing[] = [];
  for (const achievement of ACHIEVEMENTS) {
    const before =
      achievement.counterColumn === 'words_learned'
        ? wordPlan.before.wordsLearned
        : integer(account[achievement.counterColumn], achievement.counterColumn);
    const after =
      achievement.counterColumn === 'words_learned'
        ? wordPlan.after.wordsLearned
        : (counters[achievement.counterColumn] ?? before);
    for (let tier = 0; tier < achievement.tiers.length; tier++) {
      const threshold = achievement.tiers[tier]!;
      if (
        before < threshold &&
        after >= threshold &&
        !db.get('SELECT 1 FROM account_achievement_award WHERE achievement_id=? AND tier_index=?', [
          achievement.id,
          tier,
        ])
      )
        crossings.push({
          achievementId: achievement.id,
          achievementName: achievement.displayName,
          tier,
          gems: ACHIEVEMENT_TIER_GEMS,
        });
    }
  }
  let quests: DbRow[] = [],
    badge: DbRow | null = null,
    questsProgressed = 0;
  if (rewardDay !== null && mode.advancesQuests) {
    const board = questRows(db, rewardDay, account),
      derivedAt = new Date(row.derivedCompletionUtcMs).toISOString();
    let completedNow = 0;
    const facts = {
      xp: award.awardedXp,
      comboXp: Math.max(0, award.baseXp - FLAVOUR_XP[context.launch.economyFlavour].base),
      combo: maximumCombo(state),
      accuracy,
      perfect,
      lessons: mode.countsAsLesson,
      streak,
      gems: gems + crossings.reduce((n, c) => n + c.gems, 0),
    };
    const ordered = [...board.rows].sort(
      (a, b) => Number(a.template_id === 'earnGems') - Number(b.template_id === 'earnGems'),
    );
    quests = ordered.map((r) => {
      const id = String(r.template_id),
        template = QUEST_TEMPLATES.find((t) => t.id === id)!;
      if (r.completed_at !== null || !mode.questShapes.includes(template.unit)) return r;
      const delta = questIncrement(id, facts),
        old = integer(r.progress, 'quest progress');
      const progress = id === 'reachStreak' ? Math.max(old, delta) : old + delta;
      if (progress > old) questsProgressed++;
      const completed = progress >= integer(r.target, 'quest target');
      if (completed) {
        const paid = questGems(board.seed, rewardDay, id);
        gems += paid;
        facts.gems += paid;
        completedNow++;
      }
      return { ...r, progress, completed_at: completed ? derivedAt : null };
    });
    if (maxDay !== null) {
      const month = maxDay.slice(0, 7),
        prior = db.get('SELECT * FROM account_monthly_badge WHERE month_key=?', [month]);
      const target = badgeTargetForMonth(trailingMedianDailyXp(board.trend));
      badge = {
        month_key: month,
        target_quests: prior ? integer(prior.target_quests, 'badge target', 1) : target.quests,
        completed_quests:
          (prior ? integer(prior.completed_quests, 'badge completed') : 0) +
          (rewardDay.slice(0, 7) === month ? completedNow : 0),
        tier: prior?.tier ?? target.tier,
        archived_at: null,
      };
    }
  }
  const ceremony: CeremonyState = {
    session: {
      sessionId: state.sessionId,
      flavour: context.launch.economyFlavour,
      gradedItems: graded,
      mistakes: state.core.answers.filter((a) => a.wrong && !a.skipped).length,
      xp: award.awardedXp,
      outcome:
        completion.outcome === 'quit'
          ? 'abandoned'
          : completion.outcome === 'failed'
            ? 'failed'
            : 'passed',
      gated: state.core.hearts.kind === 'pips',
    },
    account: {
      streak,
      streakBeat: extended ? 'extended' : 'already-extended',
      streakGoal,
      streakGoalCheckpointCrossed:
        typeof goal === 'number' &&
        integer(account.streak, 'prior streak') < goal &&
        streak >= goal,
      streakSocietyBeat: societyBeat,
      perfectStreakBeat:
        rewardDay !== null && mode.extendsStreak
          ? perfectBeat(beforeDays, effective, rewardDay)
          : 'none',
      questsProgressed,
      achievementCrossings: crossings,
      bundle: {
        ...EMPTY_BUNDLE,
        gems,
        freezes: freezeGift,
        boost: boostGift,
        tierGrant:
          societyBeat === 'none'
            ? null
            : societyBeat === 'induction'
              ? 'Streak Society'
              : 'Streak Society reward',
      },
      dailyGoalReachedThisSession: chest,
      consecutiveGoalMetDays: consecutive,
    },
    course: {
      courseId: state.courseId,
      scoreEntries: scoreSlotEntries(score, previousScore.ceilingBeatShown),
      nodeCompletedThisSession: nodeCompleted,
      nodeIsComplete: node !== undefined && node.subLessonsDone === node.subLessonsTotal,
      nodeIsLegendary: node?.legendary ?? false,
      legendaryAvailable:
        node !== undefined && pathAfter.manifest.legendaryDenominator.includes(node.type),
      takeover: {
        consecutiveDeclines: integer(course.legendary_takeover_declines, 'legendary declines'),
      },
      unitCompleted: newUnits.length > 0,
      sectionCompleted,
      courseCompleted,
    },
    milestoneDays: extended ? STREAK_MILESTONE_DAYS : [],
  };
  const records: DbRow[] = [];
  if (rewardDay !== null) {
    const candidates = {
      longestStreak: counters.longest_streak!,
      dailyMostXp:
        integer(
          db.get(
            'SELECT COALESCE(SUM(xp_awarded),0) AS xp FROM committed_session WHERE reward_local_day=?',
            [rewardDay],
          )!.xp,
          'daily record XP',
        ) + award.awardedXp,
      perfectLessons: counters.perfect_lessons!,
    };
    for (const [kind, value] of Object.entries(candidates)) {
      const old = db.get('SELECT * FROM account_personal_record WHERE record_kind=?', [kind]);
      if (value > (old ? integer(old.value, 'record value') : 0))
        records.push({
          record_kind: kind,
          value,
          achieved_on_day: rewardDay,
          celebrated_at: old?.celebrated_at ?? null,
        });
    }
  }
  const result = runCeremony(ceremony);
  const binding = target === null ? null : pack.pack.path().forNode(target);
  const receipt: CeremonyReceipt = {
    schemaVersion: 1,
    state: ceremony,
    result,
    facts: {
      courseName: pathAfter.manifest.languageName,
      combo: maximumCombo(state),
      accuracy,
      xpExplanation: award.explanation,
      unitIndex: binding?.unitIndex ?? 0,
      unitName:
        binding === null
          ? ''
          : (allUnits(pathAfter).find((u) => u.index === binding.unitIndex)?.title ?? ''),
      sectionName: binding === null ? '' : (pathAfter.sections[binding.sectionIndex]?.title ?? ''),
      score: score.state.masteryScore,
    },
  };
  serialiseCeremonyReceipt(receipt);
  row = { ...row, earnedXp: award.awardedXp, earnedGems: result.committed!.gems };
  const plan = freeze({ sessionId: state.sessionId, courseId: state.courseId, award, receipt });
  plans.set(plan, {
    db,
    wordStore,
    wordPlan,
    fingerprint: fingerprint(db),
    writerFacts: { context: JSON.parse(canonicalJson(context)) as LearningContext, graded },
    accountCounters: counters,
    records,
    streakGoal,
    quests,
    badge,
    achievementCrossings: crossings,
    boosts: boosted.rows,
    societyEntered,
    checkpointReached: reachedCheckpoint,
    row,
    day,
    goals,
    goalMet,
    streak,
    score: score.state,
    plan,
  });
  return plan;
}
/** Called with the SAME transaction-scoped Db supplied to the planner. The runtime
 * owns the exclusive transaction; nested store boundaries use its scoped facade. */
export function writeLearningRewards(db: Db, plan: LearningRewardPlan): CeremonyReceipt {
  const p = plans.get(plan);
  if (!p || p.db !== db) return fail('unrecognized or transferred plan');
  {
    if (db.get('SELECT session_id FROM committed_session WHERE session_id=?', [plan.sessionId]))
      return fail('already committed');
    if (fingerprint(db) !== p.fingerprint) return fail('stale durable facts changed');
    const r = p.row,
      c = p.writerFacts.context,
      a = plan.award;
    const fields = {
      session_id: r.sessionId,
      committed_at: new Date(r.derivedCompletionUtcMs).toISOString(),
      active_ms: c.activeMs,
      xp_awarded: a.awardedXp,
      local_day: r.rewardLocalDay,
      flavour: c.launch.economyFlavour,
      started_at_utc_ms: r.startedAtUtcMs,
      start_tz_id: r.startZone.tzId,
      start_utc_offset_minutes: r.startZone.utcOffsetMinutes,
      start_tz_source: r.startZone.tzSource,
      started_local_day: r.startedLocalDay,
      completed_at_utc_ms: r.completedAtUtcMs,
      completion_tz_id: r.completionZone.tzId,
      completion_utc_offset_minutes: r.completionZone.utcOffsetMinutes,
      completion_tz_source: r.completionZone.tzSource,
      completed_local_day: r.completedLocalDay,
      derived_completion_utc_ms: r.derivedCompletionUtcMs,
      credited_local_day: r.creditedLocalDay,
      reward_local_day: r.rewardLocalDay,
      credited_by_grace: Number(r.creditedByGrace),
      day_keying_deferred: Number(r.dayKeyingDeferred),
      gems_awarded: r.earnedGems,
      base_xp: a.baseXp,
      multiplier_recorded: a.recordedMultiplier,
      multiplier_applied: a.multiplierApplied,
      ladder_mode: a.ladderMode,
      award_explanation: a.explanation,
      outcome: c.completion!.outcome,
      graded_attempts: p.writerFacts.graded,
    };
    db.run(
      `INSERT INTO committed_session(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields)
        .map(() => '?')
        .join(',')})`,
      Object.values(fields),
    );
    db.run('INSERT INTO course_session_commit_link VALUES(?,?,?,?,?,?)', [
      r.sessionId,
      plan.courseId,
      c.launch.targetNodeId,
      c.launch.economyFlavour,
      c.launch.origin.kind === 'hub' ? c.launch.origin.offerId : null,
      c.launch.origin.kind === 'hub' ? c.launch.origin.localDay : null,
    ]);
    // Only the owning store can apply this evidence. Its permanent source session
    // now exists, while no other counter/reward write has altered its read facts.
    p.wordStore.apply(p.wordPlan);
    new SqliteDayStore(db).save(p.day);
    if (r.rewardLocalDay !== null) {
      const goal = p.goals.get(r.rewardLocalDay);
      if (goal) {
        db.run(
          'INSERT INTO account_day(local_day,goal_xp) VALUES(?,?) ON CONFLICT(local_day) DO NOTHING',
          [
            r.rewardLocalDay,
            goal.goalXpAtGrant ?? db.get('SELECT daily_goal_xp FROM account')!.daily_goal_xp,
          ],
        );
        db.run(
          'UPDATE account_day SET earned_xp=?,goal_met=?,chest_granted_at=?,goal_xp_at_grant=? WHERE local_day=?',
          [
            goal.earnedXp,
            Number(goal.grantedAtUtc !== null),
            goal.grantedAtUtc,
            goal.goalXpAtGrant,
            r.rewardLocalDay,
          ],
        );
      }
      if (a.baseXp > 0)
        db.run(
          'INSERT INTO account_daily_xp(local_day,ladder_mode,xp_awarded,sessions_counted) VALUES(?,?,?,1) ON CONFLICT(local_day,ladder_mode) DO UPDATE SET xp_awarded=xp_awarded+excluded.xp_awarded,sessions_counted=sessions_counted+1',
          [r.rewardLocalDay, a.ladderMode, a.awardedXp],
        );
    }
    db.run(
      `UPDATE account SET ${Object.keys(p.accountCounters)
        .map((k) => `${k}=?`)
        .join(',')},gems=gems+?,streak=? WHERE id=1`,
      [...Object.values(p.accountCounters), r.earnedGems, p.streak],
    );
    db.run(
      'UPDATE account SET streak_goal_value=?,streak_goal_declined=?,streak_goal_presentations=?,streak_goal_last_picked=? WHERE id=1',
      [
        typeof p.streakGoal.goal === 'number' ? p.streakGoal.goal : null,
        Number(p.streakGoal.goal === 'DECLINED'),
        p.streakGoal.presentations,
        p.streakGoal.lastPicked,
      ],
    );
    for (const r of p.records)
      db.run(
        'INSERT INTO account_personal_record VALUES(?,?,?,?) ON CONFLICT(record_kind) DO UPDATE SET value=excluded.value,achieved_on_day=excluded.achieved_on_day',
        [r.record_kind, r.value, r.achieved_on_day, r.celebrated_at],
      );
    for (const q of p.quests)
      db.run(
        'INSERT INTO account_quest(local_day,quest_id,template_id,target,progress,completed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(local_day,quest_id) DO UPDATE SET progress=excluded.progress,completed_at=excluded.completed_at',
        [q.local_day, q.quest_id, q.template_id, q.target, q.progress, q.completed_at],
      );
    if (p.badge) {
      const b = p.badge;
      db.run(
        'UPDATE account_monthly_badge SET archived_at=COALESCE(archived_at,?) WHERE month_key<?',
        [fields.committed_at, b.month_key],
      );
      db.run(
        'INSERT INTO account_monthly_badge VALUES(?,?,?,?,?) ON CONFLICT(month_key) DO UPDATE SET completed_quests=excluded.completed_quests',
        [b.month_key, b.target_quests, b.completed_quests, b.tier, b.archived_at],
      );
    }
    for (const c of p.achievementCrossings)
      db.run('INSERT INTO account_achievement_award VALUES(?,?,?,?)', [
        c.achievementId,
        c.tier,
        fields.committed_at,
        r.sessionId,
      ]);
    for (const b of p.boosts)
      db.run(
        'INSERT INTO account_boost(grant_id,kind,multiplier,duration_minutes,duration_seconds,granted_at,activated_at_utc,activation_sequence_ms,tamper_high_water_utc,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET tamper_high_water_utc=excluded.tamper_high_water_utc,expires_at=excluded.expires_at',
        [
          b.grant_id,
          b.kind,
          b.multiplier,
          b.duration_minutes,
          b.duration_seconds,
          b.granted_at,
          b.activated_at_utc,
          b.activation_sequence_ms,
          b.tamper_high_water_utc,
          b.expires_at,
        ],
      );
    if (p.societyEntered !== null)
      db.run(
        'UPDATE account SET society_entered_on_day=COALESCE(society_entered_on_day,?) WHERE id=1',
        [p.societyEntered],
      );
    if (
      p.checkpointReached &&
      a.baseXp > 0 &&
      c.completion!.outcome === 'failed' &&
      r.rewardLocalDay !== null &&
      c.launch.targetNodeId !== null
    )
      db.run('INSERT INTO course_checkpoint_claim VALUES(?,?,?,?)', [
        plan.courseId,
        c.launch.targetNodeId,
        r.rewardLocalDay,
        r.sessionId,
      ]);
    db.run(
      'UPDATE course_progress SET xp=xp+?,score=?,exposure_fraction=?,score_unlocked=?,score_ceiling_beat_shown=? WHERE course_id=?',
      [
        a.awardedXp,
        p.score.masteryScore,
        p.score.exposureFraction,
        Number(p.score.unlocked),
        Number(p.score.ceilingBeatShown),
        plan.courseId,
      ],
    );
    new SqliteCeremonyStore(db, () => new Date(r.derivedCompletionUtcMs).toISOString()).insert(
      plan.receipt,
    );
    return plan.receipt;
  }
}
