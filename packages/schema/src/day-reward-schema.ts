/** v7 normalized day/reward carriers, frozen 2026-09-13. Historical missing facts
 * remain nullable. Authoritative rewards live in rows; ceremony JSON is presentation only. */
export const DAY_REWARD_ACCOUNT_TABLES = [
  'account_streak_break',
  'account_streak_break_day',
  'account_recovery_challenge',
  'account_month_settlement',
  'account_long_absence',
  'account_streak_repair_day',
  'account_freeze_grant',
  'account_achievement_award',
] as const;
export const DAY_REWARD_COURSE_TABLES = [
  'course_session_commit_link',
  'course_checkpoint_claim',
  'course_ceremony',
] as const;
const zoneSource = "'iana','fixed_offset','unknown'";
const nonnegative = (column: string) =>
  `INTEGER CHECK(${column} IS NULL OR (typeof(${column})='integer' AND ${column}>=0))`;
const flag = (column: string) => `INTEGER CHECK(${column} IN (0,1))`;
const accountColumns = [
  'last_processed_day TEXT',
  'last_processed_month TEXT',
  'clock_unreliable INTEGER NOT NULL DEFAULT 0 CHECK(clock_unreliable IN (0,1))',
  "freeze_cap INTEGER NOT NULL DEFAULT 2 CHECK(typeof(freeze_cap)='integer' AND freeze_cap>=0)",
  "last_completed_at_utc_ms INTEGER CHECK(last_completed_at_utc_ms IS NULL OR (typeof(last_completed_at_utc_ms)='integer'))",
  'last_tz_id TEXT',
  "last_utc_offset_minutes INTEGER CHECK(last_utc_offset_minutes IS NULL OR (typeof(last_utc_offset_minutes)='integer'))",
  `last_tz_source TEXT CHECK(last_tz_source IN (${zoneSource}))`,
  'streak_goal_value ' + nonnegative('streak_goal_value'),
  'streak_goal_declined INTEGER NOT NULL DEFAULT 0 CHECK(streak_goal_declined IN (0,1) AND (streak_goal_declined=0 OR streak_goal_value IS NULL))',
  "streak_goal_presentations INTEGER NOT NULL DEFAULT 0 CHECK(typeof(streak_goal_presentations)='integer' AND streak_goal_presentations>=0)",
  'streak_goal_last_picked ' + nonnegative('streak_goal_last_picked'),
];
const sessionColumns = [
  "started_at_utc_ms INTEGER CHECK(started_at_utc_ms IS NULL OR (typeof(started_at_utc_ms)='integer'))",
  'start_tz_id TEXT',
  "start_utc_offset_minutes INTEGER CHECK(start_utc_offset_minutes IS NULL OR (typeof(start_utc_offset_minutes)='integer'))",
  `start_tz_source TEXT CHECK(start_tz_source IN (${zoneSource}))`,
  'started_local_day TEXT',
  "completed_at_utc_ms INTEGER CHECK(completed_at_utc_ms IS NULL OR (typeof(completed_at_utc_ms)='integer'))",
  'completion_tz_id TEXT',
  "completion_utc_offset_minutes INTEGER CHECK(completion_utc_offset_minutes IS NULL OR (typeof(completion_utc_offset_minutes)='integer'))",
  `completion_tz_source TEXT CHECK(completion_tz_source IN (${zoneSource}))`,
  'completed_local_day TEXT',
  "derived_completion_utc_ms INTEGER CHECK(derived_completion_utc_ms IS NULL OR (typeof(derived_completion_utc_ms)='integer'))",
  'credited_local_day TEXT',
  'reward_local_day TEXT',
  'credited_by_grace ' + flag('credited_by_grace'),
  'day_keying_deferred ' + flag('day_keying_deferred'),
  'gems_awarded ' + nonnegative('gems_awarded'),
  'base_xp ' + nonnegative('base_xp'),
  "multiplier_recorded INTEGER CHECK(multiplier_recorded IS NULL OR (typeof(multiplier_recorded)='integer' AND multiplier_recorded>=1))",
  "multiplier_applied INTEGER CHECK(multiplier_applied IS NULL OR (typeof(multiplier_applied)='integer' AND multiplier_applied>=1))",
  'ladder_mode TEXT',
  'award_explanation TEXT',
  "outcome TEXT CHECK(outcome IN ('completed','replayed','failed','quit'))",
  'graded_attempts ' + nonnegative('graded_attempts'),
];
function immutableLedger(table: 'account_freeze_grant' | 'account_achievement_award'): string[] {
  return ['UPDATE', 'DELETE'].map(
    (
      event,
    ) => `CREATE TRIGGER ${table}_append_only_${event.toLowerCase()} BEFORE ${event} ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  );
}
export const DAY_REWARD_SCHEMA_V7_DDL: readonly string[] = [
  ...accountColumns.map((column) => `ALTER TABLE account ADD COLUMN ${column}`),
  ...sessionColumns.map((column) => `ALTER TABLE committed_session ADD COLUMN ${column}`),
  `ALTER TABLE account_day ADD COLUMN disposition TEXT CHECK(disposition IN ('completed','frozen','missed','unlived','recovered'))`,
  `ALTER TABLE account_day ADD COLUMN grace_credited INTEGER NOT NULL DEFAULT 0 CHECK(grace_credited IN (0,1))`,
  `ALTER TABLE account_day ADD COLUMN streak_satisfied INTEGER NOT NULL DEFAULT 0 CHECK(streak_satisfied IN (0,1))`,
  `ALTER TABLE account_day ADD COLUMN goal_xp_at_grant ${nonnegative('goal_xp_at_grant')}`,
  `CREATE TABLE account_streak_break (
    id INTEGER PRIMARY KEY CHECK(id=1), broken_on TEXT NOT NULL,
    previous_streak INTEGER NOT NULL CHECK(typeof(previous_streak)='integer' AND previous_streak>=0)
  )`,
  `CREATE TABLE account_streak_break_day (
    local_day TEXT PRIMARY KEY NOT NULL, break_id INTEGER NOT NULL REFERENCES account_streak_break(id) ON DELETE CASCADE CHECK(break_id=1)
  )`,
  `CREATE TABLE account_recovery_challenge (
    id INTEGER PRIMARY KEY CHECK(id=1), broken_on TEXT NOT NULL,
    previous_streak INTEGER NOT NULL CHECK(typeof(previous_streak)='integer' AND previous_streak>=0),
    expires_after_day TEXT NOT NULL,
    lessons_required INTEGER NOT NULL CHECK(typeof(lessons_required)='integer' AND lessons_required>0),
    lessons_done INTEGER NOT NULL CHECK(typeof(lessons_done)='integer' AND lessons_done BETWEEN 0 AND lessons_required),
    earned_on_day TEXT,
    CHECK((lessons_done<lessons_required AND earned_on_day IS NULL) OR (lessons_done=lessons_required AND earned_on_day IS NOT NULL))
  )`,
  `CREATE TABLE account_month_settlement (
    month TEXT PRIMARY KEY NOT NULL, settled_month TEXT, at_day TEXT NOT NULL
  )`,
  `CREATE TABLE account_long_absence (
    from_day TEXT NOT NULL, to_day TEXT NOT NULL,
    days INTEGER NOT NULL CHECK(typeof(days)='integer' AND days>0),
    freezes_consumed INTEGER NOT NULL CHECK(typeof(freezes_consumed)='integer' AND freezes_consumed>=0),
    PRIMARY KEY(from_day,to_day)
  )`,
  `CREATE TABLE account_streak_repair_day (
    month_key TEXT NOT NULL REFERENCES account_streak_repair(month_key) ON DELETE CASCADE,
    local_day TEXT NOT NULL, PRIMARY KEY(month_key,local_day)
  )`,
  `CREATE TABLE account_freeze_grant (
    grant_key TEXT PRIMARY KEY NOT NULL CHECK(length(trim(grant_key))>0),
    channel TEXT NOT NULL CHECK(channel IN ('streak_freeze_refill','milestone_grant','reward_chest')),
    subtype TEXT CHECK(subtype='one_time'), owned_from_day TEXT NOT NULL,
    requested INTEGER NOT NULL CHECK(typeof(requested)='integer' AND requested>=0),
    applied INTEGER NOT NULL CHECK(typeof(applied)='integer' AND applied BETWEEN 0 AND requested)
  )`,
  ...immutableLedger('account_freeze_grant'),
  `ALTER TABLE account_freeze ADD COLUMN grant_key TEXT REFERENCES account_freeze_grant(grant_key)`,
  `ALTER TABLE account_freeze ADD COLUMN consumed_on_day TEXT`,
  // Existing duplicate consumptions reject the migration and retain the backup/old rows.
  // They must be investigated, never silently deleted or assigned invented dates.
  `CREATE UNIQUE INDEX one_freeze_per_day ON account_freeze(consumed_for_day) WHERE consumed_for_day IS NOT NULL`,
  `CREATE TABLE account_achievement_award (
    achievement_id TEXT NOT NULL CHECK(length(trim(achievement_id))>0),
    tier_index INTEGER NOT NULL CHECK(typeof(tier_index)='integer' AND tier_index>=0),
    awarded_at_utc TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES committed_session(session_id),
    PRIMARY KEY(achievement_id,tier_index)
  )`,
  ...immutableLedger('account_achievement_award'),
  `ALTER TABLE course_progress ADD COLUMN legendary_takeover_declines INTEGER NOT NULL DEFAULT 0 CHECK(typeof(legendary_takeover_declines)='integer' AND legendary_takeover_declines>=0)`,
  `ALTER TABLE course_progress ADD COLUMN exposure_fraction REAL NOT NULL DEFAULT 0 CHECK(exposure_fraction BETWEEN 0 AND 1)`,
  `ALTER TABLE course_progress ADD COLUMN score_unlocked INTEGER CHECK(score_unlocked IN (0,1))`,
  `ALTER TABLE course_progress ADD COLUMN score_ceiling_beat_shown INTEGER CHECK(score_ceiling_beat_shown IN (0,1))`,
  `CREATE TABLE course_session_commit_link (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES committed_session(session_id),
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    node_id TEXT, economy_flavour TEXT NOT NULL, origin_offer_id TEXT, origin_local_day TEXT
  )`,
  `CREATE TABLE course_checkpoint_claim (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    node_id TEXT NOT NULL, local_day TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES committed_session(session_id),
    PRIMARY KEY(course_id,node_id,local_day)
  )`,
  `CREATE TABLE course_ceremony (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES committed_session(session_id),
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    presentation_json TEXT NOT NULL CHECK(json_valid(presentation_json)),
    cursor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cursor)='integer' AND cursor>=0),
    finished_at_utc TEXT
  )`,
  `CREATE TRIGGER course_ceremony_presentation_immutable BEFORE UPDATE ON course_ceremony
    WHEN NEW.session_id IS NOT OLD.session_id OR NEW.course_id IS NOT OLD.course_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.presentation_json IS NOT OLD.presentation_json OR NEW.cursor<OLD.cursor OR (OLD.finished_at_utc IS NOT NULL AND NEW.finished_at_utc IS NOT OLD.finished_at_utc)
    BEGIN SELECT RAISE(ABORT, 'ceremony presentation is immutable and cursor cannot rewind'); END`,
  // Strengthen v6's completion provenance without rewriting its committed fixture.
  `ALTER TABLE course_hub_completion RENAME TO course_hub_completion_v6`,
  `CREATE TABLE course_hub_completion (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL,
    offer_id TEXT NOT NULL CHECK(length(trim(offer_id))>0),
    completed_session_id TEXT NOT NULL REFERENCES committed_session(session_id),
    PRIMARY KEY(course_id,local_day,offer_id),
    FOREIGN KEY(course_id,local_day) REFERENCES course_hub_day(course_id,local_day) ON DELETE CASCADE
  )`,
  `INSERT INTO course_hub_completion SELECT * FROM course_hub_completion_v6`,
  `DROP TABLE course_hub_completion_v6`,
];
