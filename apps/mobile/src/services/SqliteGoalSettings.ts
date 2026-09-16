import type { Db, DbRow } from '@freelingo/schema';
import {
  GOAL_TIERS,
  QUEST_TEMPLATES,
  QUESTS_PER_DAY,
  QUEST_TREND_WINDOW_DAYS,
  questsForDay,
  rederiveQuestsOnGoalChange,
  type GoalTierKey,
  type QuestProgressRow,
} from '@freelingo/core/economy';
import { addCivilDays, toLocalDay, type LocalDay } from '@freelingo/core/day';
import { AppDataError } from './SqliteAppState';

function fail(field: string): never {
  throw new AppDataError('Invalid daily goal settings: ' + field + '.');
}
function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    return fail(field);
  return value;
}
function savedGoal(account: DbRow | undefined) {
  const tier = GOAL_TIERS.find((candidate) => candidate.key === account?.daily_goal_tier);
  if (!account || !tier || tier.xp !== account.daily_goal_xp) return fail('saved goal tier and XP');
  return tier;
}
/** Same trailing window as completion: include zero-XP gaps since the first observed
 * day, but never invent pre-account history. At most the configured seven rows are read. */
function trailingXp(db: Db, day: LocalDay): number[] {
  const earliest = db.get('SELECT MIN(local_day) AS first_day FROM account_day WHERE local_day<?', [
    day,
  ])?.first_day;
  if (earliest === null || earliest === undefined) return [];
  if (typeof earliest !== 'string') return fail('quest history day');
  const first = toLocalDay(earliest),
    start = addCivilDays(day, -QUEST_TREND_WINDOW_DAYS);
  const history = db.all(
    'SELECT local_day,earned_xp FROM account_day WHERE local_day>=? AND local_day<? ORDER BY local_day',
    [start, day],
  );
  const byDay = new Map(
    history.map((row) => {
      if (typeof row.local_day !== 'string') return fail('quest history day');
      return [toLocalDay(row.local_day), integer(row.earned_xp, 'quest history XP')] as const;
    }),
  );
  const trend: number[] = [];
  for (let d = start; d < day; d = addCivilDays(d, 1))
    if (d >= first) trend.push(byDay.get(d) ?? 0);
  return trend;
}
function currentQuests(
  rows: readonly DbRow[],
  day: LocalDay,
  seed: string,
  goalXp: number,
  trend: readonly number[],
): QuestProgressRow[] {
  const expected = questsForDay(day, seed, { goalXp, trailingDailyXp: trend });
  if (
    rows.length !== QUESTS_PER_DAY ||
    new Set(rows.map((r) => r.template_id)).size !== QUESTS_PER_DAY
  )
    return fail('quest population');
  return rows.map((row) => {
    const template = QUEST_TEMPLATES.find((t) => t.id === row.template_id);
    if (
      !template ||
      row.quest_id !== template.id ||
      !expected.some((q) => q.templateId === template.id)
    )
      return fail('quest identity');
    const target = integer(row.target, 'quest target', 1),
      progress = integer(row.progress, 'quest progress');
    const completed = row.completed_at;
    if (
      completed !== null &&
      (typeof completed !== 'string' ||
        !Number.isFinite(Date.parse(completed)) ||
        progress < target)
    )
      return fail('quest completion');
    return {
      templateId: template.id,
      unit: template.unit,
      target,
      copy: template.copy.replace('{{n}}', String(target)),
      progress,
      completedAtUtc: completed as string | null,
    };
  });
}
/** S132 / INV-ECO-01,05,10,21. The factory serializes this durable action with lesson
 * completion. It writes only account goal preference and existing unfinished quest targets.
 * Core changeDailyGoal keeps all earned day/chest history unchanged; no reward is generated.
 * Foreground publication and the UI refresh remain the enclosing factory's responsibility. */
export class SqliteGoalSettings {
  constructor(
    private readonly db: Db,
    private readonly currentDay: () => LocalDay,
  ) {}
  read(): GoalTierKey {
    return savedGoal(this.db.get('SELECT daily_goal_tier,daily_goal_xp FROM account WHERE id=1'))
      .key;
  }
  setGoal(key: GoalTierKey): void {
    const next = GOAL_TIERS.find((tier) => tier.key === key);
    if (!next) return fail('requested goal tier');
    this.db.withExclusiveTransaction(() => {
      const account = this.db.get(
        'SELECT daily_goal_tier,daily_goal_xp,selection_seed FROM account WHERE id=1',
      );
      const old = savedGoal(account);
      if (old.key === next.key) return;
      const day = toLocalDay(this.currentDay());
      const rows = this.db.all('SELECT * FROM account_quest WHERE local_day=? ORDER BY quest_id', [
        day,
      ]);
      let quests: readonly QuestProgressRow[] = [];
      if (rows.length) {
        const seed = String(integer(account!.selection_seed, 'selection seed')),
          trend = trailingXp(this.db, day);
        const current = currentQuests(rows, day, seed, old.xp, trend);
        quests = rederiveQuestsOnGoalChange(current, day, seed, {
          goalXp: next.xp,
          trailingDailyXp: trend,
        });
      }
      this.db.run('UPDATE account SET daily_goal_tier=?,daily_goal_xp=? WHERE id=1', [
        next.key,
        next.xp,
      ]);
      for (const quest of quests) {
        const previous = rows.find((row) => row.quest_id === quest.templateId)!;
        if (quest.completedAtUtc !== null || previous.target === quest.target) continue;
        this.db.run(
          'UPDATE account_quest SET target=? WHERE local_day=? AND quest_id=? AND completed_at IS NULL',
          [quest.target, day, quest.templateId],
        );
      }
    });
  }
}
