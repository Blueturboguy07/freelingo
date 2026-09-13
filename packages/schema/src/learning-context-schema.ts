/** Frozen v6 SQL contract, 2026-09-13. Session-start inputs cannot drift on resume;
 * the completion intent survives a failed reward transaction without choosing a new day.
 * Daily pools persist even when intentionally empty. Startup stays in the two regions. */
export const LEARNING_CONTEXT_COURSE_TABLES = [
  'course_session_context',
  'course_session_slot',
  'course_review_pool_day',
  'course_review_pool_item',
  'course_hub_day',
  'course_hub_choice',
  'course_hub_completion',
  'course_daily_refresh_item',
  'course_selection',
] as const;
export const LEARNING_CONTEXT_ACCOUNT_TABLES = ['account_onboarding'] as const;
const flavours =
  "'lesson','nodePractice','legendary','placement','jumpHere','sectionTest','unitReview','dailyRefresh','recovery','endgameReview','story','radio','roleplay','hubMistakes','hubWords','hubListenUp','hubPronunciation','hubTargetPractice','hubUnitRewind','timedChallenge'";
const zoneSources = "'iana','fixed_offset','unknown'";
const launchColumns = [
  'session_id',
  'course_id',
  'session_kind',
  'node_ref',
  'started_at_utc_ms',
  'started_at_monotonic_ms',
  'start_tz_id',
  'start_utc_offset_minutes',
  'start_tz_source',
  'started_local_day',
  'economy_flavour',
  'practice_item_ratio',
  'long_form_entry',
  'boost_kind',
  'boost_multiplier',
  'boost_started_at_utc',
  'boost_expires_at_utc',
  'pack_content_hash',
  'origin',
  'origin_offer_id',
  'origin_local_day',
  'target_node_id',
];
const completionColumns = [
  'completed_at_utc_ms',
  'completed_at_monotonic_ms',
  'completion_tz_id',
  'completion_utc_offset_minutes',
  'completion_tz_source',
  'completion_outcome',
  'completion_intent_at_utc',
];
export const LEARNING_CONTEXT_SCHEMA_V6_DDL: readonly string[] = [
  `ALTER TABLE course_attempt ADD COLUMN exercise_id TEXT CHECK(exercise_id IS NULL OR length(trim(exercise_id))>0)`,
  `ALTER TABLE course_attempt ADD COLUMN pack_content_hash TEXT CHECK(pack_content_hash IS NULL OR length(trim(pack_content_hash))>0)`,
  `CREATE TABLE course_session_context (
    session_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(session_id))>0),
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    session_kind TEXT NOT NULL CHECK(length(trim(session_kind))>0),
    node_ref TEXT NOT NULL CHECK(length(trim(node_ref))>0),
    started_at_utc_ms INTEGER NOT NULL CHECK(typeof(started_at_utc_ms)='integer'),
    started_at_monotonic_ms REAL NOT NULL CHECK(started_at_monotonic_ms BETWEEN 0 AND 1.7976931348623157e308),
    start_tz_id TEXT NOT NULL CHECK(length(trim(start_tz_id))>0),
    start_utc_offset_minutes INTEGER NOT NULL CHECK(typeof(start_utc_offset_minutes)='integer'),
    start_tz_source TEXT NOT NULL CHECK(start_tz_source IN (${zoneSources})),
    started_local_day TEXT NOT NULL CHECK(length(trim(started_local_day))>0),
    economy_flavour TEXT NOT NULL CHECK(economy_flavour IN (${flavours})),
    practice_item_ratio REAL NOT NULL DEFAULT 1 CHECK(practice_item_ratio BETWEEN 0 AND 1),
    long_form_entry TEXT CHECK(long_form_entry IN ('first','hub_recommended','replay_plain','legendary')),
    boost_kind TEXT CHECK(boost_kind IN ('xpBoost','timerBoost','happyHour','earlyBird')),
    boost_multiplier INTEGER CHECK(boost_multiplier IS NULL OR (typeof(boost_multiplier)='integer' AND boost_multiplier>=1)),
    boost_started_at_utc TEXT,
    boost_expires_at_utc TEXT,
    pack_content_hash TEXT NOT NULL CHECK(length(trim(pack_content_hash))>0),
    origin TEXT NOT NULL CHECK(origin IN ('path','hub','placement')),
    origin_offer_id TEXT,
    origin_local_day TEXT,
    target_node_id TEXT,
    active_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(active_ms)='integer' AND active_ms>=0),
    completed_at_utc_ms INTEGER CHECK(completed_at_utc_ms IS NULL OR typeof(completed_at_utc_ms)='integer'),
    completed_at_monotonic_ms REAL CHECK(completed_at_monotonic_ms IS NULL OR completed_at_monotonic_ms BETWEEN 0 AND 1.7976931348623157e308),
    completion_tz_id TEXT,
    completion_utc_offset_minutes INTEGER CHECK(completion_utc_offset_minutes IS NULL OR typeof(completion_utc_offset_minutes)='integer'),
    completion_tz_source TEXT CHECK(completion_tz_source IN (${zoneSources})),
    completion_outcome TEXT CHECK(completion_outcome IN ('completed','replayed','failed','quit')),
    completion_intent_at_utc TEXT,
    UNIQUE(course_id,session_kind,node_ref), UNIQUE(session_id,course_id),
    CHECK((boost_kind IS NULL AND boost_multiplier IS NULL AND boost_started_at_utc IS NULL AND boost_expires_at_utc IS NULL)
      OR (boost_kind IS NOT NULL AND boost_multiplier IS NOT NULL AND boost_started_at_utc IS NOT NULL AND boost_expires_at_utc IS NOT NULL)),
    CHECK((${completionColumns.map((c) => `${c} IS NULL`).join(' AND ')})
      OR (${completionColumns.map((c) => `${c} IS NOT NULL`).join(' AND ')})),
    CHECK(origin!='hub' OR (origin_offer_id IS NOT NULL AND origin_local_day IS NOT NULL))
  )`,
  `CREATE TRIGGER course_session_context_launch_immutable BEFORE UPDATE ON course_session_context
    WHEN ${launchColumns.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT, 'session launch context is immutable'); END`,
  `CREATE TRIGGER course_session_context_completion_immutable BEFORE UPDATE ON course_session_context
    WHEN OLD.completion_intent_at_utc IS NOT NULL AND (${[...completionColumns, 'active_ms'].map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')})
    BEGIN SELECT RAISE(ABORT, 'completion intent is immutable'); END`,
  `CREATE TABLE course_session_slot (
    session_id TEXT NOT NULL,
    slot_id TEXT NOT NULL CHECK(length(trim(slot_id))>0),
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL CHECK(length(trim(exercise_id))>0),
    item_id TEXT NOT NULL CHECK(length(trim(item_id))>0),
    surface TEXT NOT NULL CHECK(length(trim(surface))>0),
    encounter_role TEXT NOT NULL CHECK(encounter_role IN ('recognition','production')),
    ruby_shown INTEGER NOT NULL CHECK(ruby_shown IN (0,1)),
    PRIMARY KEY(session_id,slot_id),
    FOREIGN KEY(session_id,course_id) REFERENCES course_session_context(session_id,course_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_review_pool_day (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL CHECK(length(trim(local_day))>0),
    opened_at_utc_ms INTEGER NOT NULL CHECK(typeof(opened_at_utc_ms)='integer'),
    PRIMARY KEY(course_id,local_day)
  )`,
  `CREATE TABLE course_review_pool_item (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
    spent_by TEXT CHECK(spent_by IN ('todaysReview','dailyRefresh')),
    PRIMARY KEY(course_id,local_day,item_id), UNIQUE(course_id,local_day,position),
    FOREIGN KEY(course_id,local_day) REFERENCES course_review_pool_day(course_id,local_day) ON DELETE CASCADE,
    FOREIGN KEY(course_id,item_id) REFERENCES course_item(course_id,item_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_hub_day (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL CHECK(length(trim(local_day))>0),
    cursor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cursor)='integer' AND cursor>=0),
    PRIMARY KEY(course_id,local_day)
  )`,
  `CREATE TABLE course_hub_choice (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL,
    choice_id TEXT NOT NULL CHECK(length(trim(choice_id))>0),
    position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
    PRIMARY KEY(course_id,local_day,choice_id), UNIQUE(course_id,local_day,position),
    FOREIGN KEY(course_id,local_day) REFERENCES course_hub_day(course_id,local_day) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_hub_completion (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL,
    offer_id TEXT NOT NULL CHECK(length(trim(offer_id))>0),
    completed_session_id TEXT NOT NULL CHECK(length(trim(completed_session_id))>0),
    PRIMARY KEY(course_id,local_day,offer_id),
    FOREIGN KEY(course_id,local_day) REFERENCES course_hub_day(course_id,local_day) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_daily_refresh_item (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    local_day TEXT NOT NULL CHECK(length(trim(local_day))>0),
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
    PRIMARY KEY(course_id,local_day,item_id), UNIQUE(course_id,local_day,position),
    FOREIGN KEY(course_id,item_id) REFERENCES course_item(course_id,item_id) ON DELETE CASCADE
  )`,
  `ALTER TABLE account ADD COLUMN selection_seed INTEGER CHECK(selection_seed IS NULL OR (typeof(selection_seed)='integer' AND selection_seed>=0))`,
  `CREATE TABLE account_onboarding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    step TEXT NOT NULL CHECK(step IN ('courses','pack-detail','restore','placement-choice','self-report','placement-test','placement-result','goal','notifications','entering','complete')),
    completed_at_utc TEXT,
    CHECK((step='complete' AND completed_at_utc IS NOT NULL) OR (step!='complete' AND completed_at_utc IS NULL))
  )`,
  `CREATE TABLE course_selection (
    course_id TEXT PRIMARY KEY NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
    is_selected INTEGER NOT NULL DEFAULT 0 CHECK(is_selected IN (0,1)),
    placement_choice TEXT CHECK(placement_choice IN ('scratch','test')),
    self_report_level TEXT CHECK(self_report_level IN ('new','words','basic','topics','detailed')),
    placement_section_index INTEGER CHECK(placement_section_index IS NULL OR (typeof(placement_section_index)='integer' AND placement_section_index>=0))
  )`,
  `CREATE UNIQUE INDEX one_active_course ON course_selection(is_active) WHERE is_active=1`,
  `CREATE UNIQUE INDEX one_selected_course ON course_selection(is_selected) WHERE is_selected=1`,
];
