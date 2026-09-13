// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { questsForDay, GOAL_TIERS, type GoalTierKey } from '@freelingo/core/economy';
import { toLocalDay } from '@freelingo/core/day';
import { SqliteGoalSettings } from './SqliteGoalSettings';

const day = toLocalDay('2026-09-13');
const handles: Db[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});
function fixture() {
  const db = createNodeDb();
  handles.push(db);
  migrate(db);
  db.run('UPDATE account SET selection_seed=42,gems=17,lifetime_xp=70');
  return { db, settings: new SqliteGoalSettings(db, () => day) };
}
function seedQuests(db: Db, localDay = day) {
  const quests = questsForDay(localDay, '42', { goalXp: 20, trailingDailyXp: [] });
  for (const q of quests)
    db.run(
      'INSERT INTO account_quest(local_day,quest_id,template_id,target,progress,completed_at) VALUES(?,?,?,?,0,NULL)',
      [localDay, q.templateId, q.templateId, q.target],
    );
  return quests;
}
it('[INV-ECO-01][INV-ECO-21] stores exactly the four configured goal tiers and their XP values across adapter replacement', () => {
  const { db, settings } = fixture();
  expect(settings.read()).toBe('regular');
  for (const tier of GOAL_TIERS) {
    settings.setGoal(tier.key);
    expect(new SqliteGoalSettings(db, () => day).read()).toBe(tier.key);
    expect(db.get('SELECT daily_goal_tier,daily_goal_xp FROM account')).toEqual({
      daily_goal_tier: tier.key,
      daily_goal_xp: tier.xp,
    });
  }
  expect(db.all('SELECT * FROM account_quest')).toEqual([]);
});
it('[INV-ECO-05] goal changes preserve every earned goal/chest and award no XP, gems or completion', () => {
  const { db, settings } = fixture();
  db.run(
    "INSERT INTO account_day(local_day,goal_xp,earned_xp,goal_met,chest_granted_at,goal_xp_at_grant) VALUES('2026-09-13',20,25,1,'2026-09-13T10:00:00.000Z',20)",
  );
  const days = db.all('SELECT * FROM account_day');
  for (const tier of ['intense', 'casual', 'serious', 'regular'] as const) settings.setGoal(tier);
  expect(db.all('SELECT * FROM account_day')).toEqual(days);
  expect(db.get('SELECT lifetime_xp,gems FROM account')).toEqual({ lifetime_xp: 70, gems: 17 });
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(db.all('SELECT * FROM course_ceremony')).toEqual([]);
});
it('[INV-ECO-10] changing a cold-start goal rescales unfinished targets while preserving earned quests and actual progress', () => {
  const { db, settings } = fixture(),
    quests = seedQuests(db);
  const completed = quests[0]!;
  db.run('UPDATE account_quest SET progress=target,completed_at=? WHERE quest_id=?', [
    '2026-09-13T10:00:00.000Z',
    completed.templateId,
  ]);
  db.run('UPDATE account_quest SET progress=1 WHERE quest_id<>?', [completed.templateId]);
  const before = db.all('SELECT * FROM account_quest ORDER BY quest_id');
  settings.setGoal('intense');
  const after = db.all('SELECT * FROM account_quest ORDER BY quest_id');
  expect(after.find((x) => x.quest_id === completed.templateId)).toEqual(
    before.find((x) => x.quest_id === completed.templateId),
  );
  const pending = after.filter((x) => x.quest_id !== completed.templateId);
  expect(pending.every((x) => x.progress === 1 && x.completed_at === null)).toBe(true);
  expect(
    pending.some(
      (x) => Number(x.target) > Number(before.find((b) => b.quest_id === x.quest_id)!.target),
    ),
  ).toBe(true);
  settings.setGoal('casual');
  expect(db.get('SELECT lifetime_xp,gems FROM account')).toEqual({ lifetime_xp: 70, gems: 17 });
  expect(
    db.all('SELECT completed_at FROM account_quest WHERE quest_id<>?', [completed.templateId]),
  ).toEqual([{ completed_at: null }, { completed_at: null }]);
});
it('[INV-ECO-10] actual trailing history drives targets and earlier quest rows stay byte-identical', () => {
  const { db, settings } = fixture();
  seedQuests(db);
  seedQuests(db, toLocalDay('2026-09-12'));
  for (const d of ['2026-09-11', '2026-09-12'])
    db.run('INSERT INTO account_day(local_day,goal_xp,earned_xp) VALUES(?,20,100)', [d]);
  const earlier = db.all("SELECT * FROM account_quest WHERE local_day='2026-09-12'");
  settings.setGoal('intense');
  const high = db.all("SELECT * FROM account_quest WHERE local_day='2026-09-13' ORDER BY quest_id");
  settings.setGoal('casual');
  expect(
    db.all("SELECT * FROM account_quest WHERE local_day='2026-09-13' ORDER BY quest_id"),
  ).toEqual(high);
  expect(db.all("SELECT * FROM account_quest WHERE local_day='2026-09-12'")).toEqual(earlier);
});
it('[INV-PER-07][INV-ECO-10] a quest write failure rolls back the account goal and all target changes', () => {
  const { db, settings } = fixture();
  seedQuests(db);
  const before = db.all('SELECT * FROM account_quest ORDER BY quest_id');
  db.run(
    "CREATE TRIGGER reject_goal_quest BEFORE UPDATE ON account_quest BEGIN SELECT RAISE(ABORT,'disk write failed'); END",
  );
  expect(() => settings.setGoal('intense')).toThrow(/disk write failed/);
  expect(settings.read()).toBe('regular');
  expect(db.all('SELECT * FROM account_quest ORDER BY quest_id')).toEqual(before);
});
it('[INV-ECO-01][INV-ECO-10] invalid goals and partial quest history are rejected without changes', () => {
  const { db, settings } = fixture();
  for (const key of ['__proto__', '50', null] as unknown as GoalTierKey[])
    expect(() => settings.setGoal(key)).toThrow(/goal/i);
  const q = seedQuests(db);
  db.run('DELETE FROM account_quest WHERE quest_id=?', [q[0]!.templateId]);
  const before = db.all('SELECT * FROM account_quest');
  expect(() => settings.setGoal('intense')).toThrow(/quest/i);
  expect(settings.read()).toBe('regular');
  expect(db.all('SELECT * FROM account_quest')).toEqual(before);
});
it('[INV-ECO-01] mismatched saved goal tier/XP requires recovery, not an inferred corrected tier', () => {
  const { db, settings } = fixture();
  db.run('UPDATE account SET daily_goal_xp=50');
  expect(() => settings.read()).toThrow(/goal/i);
  expect(() => settings.setGoal('casual')).toThrow(/goal/i);
  expect(db.get('SELECT daily_goal_tier,daily_goal_xp FROM account')).toEqual({
    daily_goal_tier: 'regular',
    daily_goal_xp: 50,
  });
});
