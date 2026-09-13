/** Frozen presentation schema, 2026-09-13. SQL remains the reward authority;
 * decoding this value never reruns predicates or performs an economy write. */
import {
  CEREMONY_SLOTS,
  ONE_TIME_SLOTS,
  isCanonicalSubsequence,
  isEmptyBundle,
  type CeremonyState,
  type CeremonyResult,
  type RewardBundle,
  type XpBoost,
  type TierCrossing,
  type AchievementRow,
  type AchievementSlot,
  type ScoreSlotEntry,
  type StreakGoalState,
  type LedgerDelta,
} from '@freelingo/core/ceremony';
import type { CeremonyFacts } from '../loop/contracts';
export const CEREMONY_RECEIPT_SCHEMA_VERSION = 1 as const;
export interface CeremonyReceipt {
  readonly schemaVersion: typeof CEREMONY_RECEIPT_SCHEMA_VERSION;
  readonly state: CeremonyState;
  readonly result: CeremonyResult;
  readonly facts: CeremonyFacts;
}
export interface CeremonyRowBinding {
  readonly sessionId: string;
  readonly courseId: string;
  readonly cursor: number;
  readonly xpAwarded: number;
  readonly gemsAwarded: number;
}
export class CeremonyCodecError extends Error {
  constructor() {
    super('Invalid persisted ceremony receipt');
    this.name = 'CeremonyCodecError';
  }
}
type Validator<T> = (value: unknown) => value is T;
type Fields<T> = { readonly [K in keyof T]-?: Validator<T[K]> };
const text: Validator<string> = (v) => typeof v === 'string';
const label: Validator<string> = (v): v is string => text(v) && v.trim() !== '';
const boolean: Validator<boolean> = (v) => typeof v === 'boolean';
const finite: Validator<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
const counter: Validator<number> = (v): v is number =>
  finite(v) && Number.isSafeInteger(v) && v >= 0;
const positive: Validator<number> = (v): v is number => finite(v) && v > 0;
function member<const T extends readonly (string | number)[]>(values: T): Validator<T[number]> {
  return (v): v is T[number] => values.includes(v as T[number]);
}
function nullable<T>(check: Validator<T>): Validator<T | null> {
  return (v): v is T | null => v === null || check(v);
}
function record(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  );
}
function array<T>(check: Validator<T>): Validator<readonly T[]> {
  return (v): v is readonly T[] => Array.isArray(v) && v.every(check);
}
function shape<T>(fields: Fields<T>): Validator<T> {
  const checks = fields as Readonly<Record<string, Validator<unknown>>>;
  return (v): v is T =>
    record(v) &&
    Object.keys(v).every((k) => Object.hasOwn(checks, k)) &&
    Object.entries(checks).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]));
}
function finiteJson(v: unknown, ancestors = new Set<object>()): boolean {
  if (v === null || text(v) || boolean(v) || finite(v)) return true;
  if (!Array.isArray(v) && !record(v)) return false;
  if (ancestors.has(v)) return false;
  const keys = Reflect.ownKeys(v);
  if (keys.some((k) => typeof k !== 'string')) return false;
  if (Array.isArray(v)) {
    if (keys.length !== v.length + 1) return false;
    for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) return false;
  }
  ancestors.add(v);
  const good = keys.every((k) => {
    if (Array.isArray(v) && k === 'length') return true;
    const d = Object.getOwnPropertyDescriptor(v, k);
    return (
      d !== undefined &&
      d.enumerable === true &&
      Object.hasOwn(d, 'value') &&
      finiteJson(d.value, ancestors)
    );
  });
  ancestors.delete(v);
  return good;
}
const boost = shape<XpBoost>({ multiplier: positive, durationMinutes: positive });
const bundle = shape<RewardBundle>({
  gems: counter,
  freezes: counter,
  boost: nullable(boost),
  tierGrant: nullable(text),
});
const goal = shape<StreakGoalState>({
  goal: (v): v is StreakGoalState['goal'] => v === null || v === 'DECLINED' || counter(v),
  presentations: counter,
  lastPicked: nullable(counter),
});
const crossing = shape<TierCrossing>({
  achievementId: label,
  achievementName: label,
  tier: counter,
  gems: counter,
});
const scoreEntry = shape<ScoreSlotEntry>({
  slot: member(['S068_scoreUnlock', 'S069_scoreProgress', 'S070_scoreMaxed']),
  bandBeats: counter,
});
const account = shape<CeremonyState['account']>({
  streak: counter,
  streakBeat: member(['extended', 'already-extended']),
  streakGoal: goal,
  streakGoalCheckpointCrossed: boolean,
  streakSocietyBeat: member(['none', 'induction', 'reward']),
  perfectStreakBeat: member(['none', 'halfway', 'earned', 'reset']),
  questsProgressed: counter,
  achievementCrossings: array(crossing),
  bundle,
  dailyGoalReachedThisSession: boolean,
  consecutiveGoalMetDays: counter,
});
const course = shape<CeremonyState['course']>({
  courseId: label,
  scoreEntries: array(scoreEntry),
  nodeCompletedThisSession: boolean,
  nodeIsComplete: boolean,
  nodeIsLegendary: boolean,
  legendaryAvailable: boolean,
  takeover: shape({ consecutiveDeclines: counter }),
  unitCompleted: boolean,
  sectionCompleted: boolean,
  courseCompleted: boolean,
});
const session = shape<CeremonyState['session']>({
  sessionId: label,
  flavour: label,
  gradedItems: counter,
  mistakes: counter,
  xp: counter,
  outcome: member(['passed', 'failed', 'abandoned']),
  gated: boolean,
});
const state = shape<CeremonyState>({ account, course, session, milestoneDays: array(counter) });
const achievementRow = shape<AchievementRow>({
  achievementId: label,
  achievementName: label,
  tier: counter,
  extraTiers: counter,
});
const achievements = shape<AchievementSlot>({
  screens: array(
    shape<{ readonly rows: readonly AchievementRow[] }>({ rows: array(achievementRow) }),
  ),
  gems: counter,
});
const delta = shape<LedgerDelta>({ sessionId: label, xp: counter, gems: counter });
const evaluations: Validator<Readonly<Record<string, number>>> = (
  v,
): v is Readonly<Record<string, number>> => record(v) && Object.values(v).every((n) => n === 1);
const result = shape<CeremonyResult>({
  chain: array(member(CEREMONY_SLOTS)),
  committed: nullable(delta),
  bundle,
  achievements,
  collapsedGoalRow: nullable(text),
  predicateEvaluations: evaluations,
  skippedToToast: array(member(CEREMONY_SLOTS)),
});
const facts = shape<CeremonyFacts>({
  courseName: label,
  combo: counter,
  accuracy: nullable((v): v is number => finite(v) && v >= 0 && v <= 1),
  xpExplanation: text,
  unitIndex: counter,
  unitName: text,
  sectionName: text,
  score: counter,
});
const receipt = shape<CeremonyReceipt>({
  schemaVersion: member([CEREMONY_RECEIPT_SCHEMA_VERSION]),
  state,
  result,
  facts,
});
function valid(value: unknown): value is CeremonyReceipt {
  try {
    if (!finiteJson(value) || !receipt(value)) return false;
    const { state: s, result: r } = value;
    if (
      r.committed === null ||
      r.committed.sessionId !== s.session.sessionId ||
      r.committed.xp !== s.session.xp ||
      r.committed.gems !== r.bundle.gems
    )
      return false;
    if (
      !isCanonicalSubsequence(r.chain) ||
      !isCanonicalSubsequence(r.skippedToToast) ||
      r.chain.some((slot) => r.skippedToToast.includes(slot))
    )
      return false;
    if (s.course.scoreEntries.length > 1 || r.achievements.screens.length > 1) return false;
    for (const screen of r.achievements.screens)
      if (new Set(screen.rows.map((row) => row.achievementId)).size !== screen.rows.length)
        return false;
    if (
      r.skippedToToast.some((slot) => ONE_TIME_SLOTS.includes(slot) || slot === 'S087_returnToPath')
    )
      return false;
    const zero = s.session.outcome === 'abandoned' && s.session.xp === 0 && isEmptyBundle(r.bundle);
    const evaluated = Object.keys(r.predicateEvaluations);
    return zero
      ? r.chain.length === 0 && r.skippedToToast.length === 0 && evaluated.length === 0
      : r.chain.at(-1) === 'S087_returnToPath' &&
          evaluated.length === CEREMONY_SLOTS.length &&
          CEREMONY_SLOTS.every((slot) => r.predicateEvaluations[slot] === 1);
  } catch {
    return false;
  }
}
/** JSON includes only the frozen presentation, never animation preferences or mutable ledgers. */
export function serialiseCeremonyReceipt(value: CeremonyReceipt): string {
  if (!valid(value)) throw new CeremonyCodecError();
  return JSON.stringify(value);
}
export function parseCeremonyReceipt(raw: string, binding: CeremonyRowBinding): CeremonyReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CeremonyCodecError();
  }
  if (
    !valid(value) ||
    !counter(binding.cursor) ||
    binding.cursor > value.result.chain.length ||
    !counter(binding.xpAwarded) ||
    !counter(binding.gemsAwarded) ||
    value.state.session.sessionId !== binding.sessionId ||
    value.state.course.courseId !== binding.courseId ||
    value.result.committed!.xp !== binding.xpAwarded ||
    value.result.committed!.gems !== binding.gemsAwarded
  )
    throw new CeremonyCodecError();
  return value;
}
